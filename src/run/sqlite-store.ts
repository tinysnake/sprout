import { DatabaseSync } from 'node:sqlite';

import type { AgentRun, AgentRunStatus, RunFailureClass, RunHandOff, TokenUsage } from './model.ts';
import type { AgentRunEvent } from '../engine/port.ts';
import type { AgentWorkOption } from '../agent/model.ts';
import type { RunReplaySnapshot, RunStore } from './store.ts';
import {
  sessionKeyId,
  workingDirectoryId,
  type SessionKeyStore,
  type SessionKeyIdentity,
  type SessionKeyWrite,
  type StoredSessionKey,
} from './session-key-store.ts';
import { migrateOrInitializeDatabase } from '../store/schema.ts';
import type {
  ProjectRetryGate,
  QueueRunReconnectRetry,
  RunReconnectRetry,
  RunReconnectRetryState,
  RunReconnectRetryStore,
  RunReconnectTrigger,
} from './reconnect-retry-store.ts';

/**
 * SQLite-backed storage for the run domain (ADR-0002).
 *
 * This module owns the run domain's SQL and nothing else: `SqliteRunStore`
 * persists agent runs and `SqliteSessionKeyStore` persists engine session keys,
 * both beside the store interfaces they implement. The classes are mounted on a
 * shared persistence handle (`src/store/db.ts`) so their rows commit against the
 * same durable state the environment, project, Task, and collaboration domains
 * use; the handle owns only connection lifecycle and the composition of those
 * adapters.
 *
 * The orchestrator depends on the `RunStore` and `SessionKeyStore` interfaces, so
 * swapping this for an in-memory store or server database does not touch domain
 * orchestration.
 *
 * Events are stored as one JSON document per run rather than a child table: the
 * run's progress record is always read as a whole, and a run is small enough
 * that a document keeps the write path to a single statement.
 */

export interface SqliteRunStoreOptions {
  /** A file path, or `:memory:` for tests. */
  readonly filename: string;
}

interface RunRow {
  readonly id: string;
  readonly agent_id: string;
  readonly prompt: string;
  readonly environment_instance_id: string;
  readonly execution_mode: string;
  readonly engine_host_profile_id: string | null;
  readonly project_id: string | null;
  readonly task_id: string | null;
  readonly status: string;
  readonly events: string;
  readonly lease_id: string | null;
  readonly failure: string | null;
  readonly failure_class: string | null;
  readonly result: string | null;
  readonly created_at: number;
  readonly completed_at: number | null;
  readonly hand_off: string | null;
  readonly token_usage: string | null;
  readonly replay_sequence: number | null;
  readonly work_option: string | null;
  readonly configuration_version: number | null;
  readonly workspace_binding: string | null;
  readonly recovery_settlement: string | null;
  readonly recovered_events: string | null;
  readonly retry_of_run_id: string | null;
}

export class SqliteRunStore implements RunStore {
  readonly #db: DatabaseSync;
  readonly #ownsDb: boolean;

  constructor(options: SqliteRunStoreOptions | { db: DatabaseSync }) {
    if ('db' in options) {
      this.#db = options.db;
      this.#ownsDb = false;
    } else {
      this.#db = new DatabaseSync(options.filename);
      this.#ownsDb = true;
      try {
        migrateOrInitializeDatabase(this.#db, { filename: options.filename });
      } catch (error) {
        this.#db.close();
        throw error;
      }
    }
    this.#init();
  }

  #init(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        environment_instance_id TEXT NOT NULL,
        execution_mode TEXT NOT NULL DEFAULT 'environment-hosted',
        engine_host_profile_id TEXT,
        project_id TEXT,
        status TEXT NOT NULL,
        events TEXT NOT NULL,
        lease_id TEXT,
        failure TEXT,
        failure_class TEXT CHECK(failure_class IN ('admission', 'environment', 'restart', 'execution')),
        result TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        hand_off TEXT,
        task_id TEXT,
        token_usage TEXT,
        replay_sequence INTEGER,
        work_option TEXT,
        configuration_version INTEGER,
        workspace_binding TEXT,
        recovery_settlement TEXT,
        recovered_events TEXT,
        retry_of_run_id TEXT
      );
    `);
    // Added after the table shipped; a database from before this column still
    // has its runs, they simply carry no recorded hand-off.
    this.#addColumnIfMissing('agent_runs', 'project_id', 'TEXT');
    this.#addColumnIfMissing('agent_runs', 'execution_mode', "TEXT NOT NULL DEFAULT 'environment-hosted'");
    this.#addColumnIfMissing('agent_runs', 'engine_host_profile_id', 'TEXT');
    this.#db.exec("UPDATE agent_runs SET engine_host_profile_id = environment_instance_id WHERE engine_host_profile_id IS NULL AND execution_mode = 'environment-hosted'");
    this.#addColumnIfMissing('agent_runs', 'hand_off', 'TEXT');
    this.#addColumnIfMissing('agent_runs', 'failure_class', "TEXT CHECK(failure_class IN ('admission', 'environment', 'restart', 'execution'))");
    this.#addColumnIfMissing('agent_runs', 'task_id', 'TEXT');
    this.#addColumnIfMissing('agent_runs', 'token_usage', 'TEXT');
    this.#addColumnIfMissing('agent_runs', 'replay_sequence', 'INTEGER');
    // Work-option admission facts (#90). A database from before these columns
    // still has its runs; they simply carry no recorded option (pre-#90
    // attribution), which the view layer presents as unspecified.
    this.#addColumnIfMissing('agent_runs', 'work_option', 'TEXT');
    this.#addColumnIfMissing('agent_runs', 'configuration_version', 'INTEGER');
    this.#addColumnIfMissing('agent_runs', 'recovery_settlement', 'TEXT');
    this.#addColumnIfMissing('agent_runs', 'recovered_events', 'TEXT');
    // The bounded reconnect retry link (#181). A database from before this
    // column still has its runs; they simply are nobody's retry.
    this.#addColumnIfMissing('agent_runs', 'retry_of_run_id', 'TEXT');
    this.#backfillReplaySequences();
    this.#db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_replay_sequence_idx
        ON agent_runs (replay_sequence)
    `);
  }

  #addColumnIfMissing(table: string, column: string, type: string): void {
    const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all() as unknown as readonly {
      name: string;
    }[];
    if (!columns.some((existing) => existing.name === column)) {
      this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  #backfillReplaySequences(): void {
    let sequence = (this.#db.prepare(
      'SELECT COALESCE(MAX(replay_sequence), 0) AS sequence FROM agent_runs',
    ).get() as { sequence: number }).sequence;
    const missing = this.#db.prepare(
      'SELECT id FROM agent_runs WHERE replay_sequence IS NULL ORDER BY created_at ASC, id ASC',
    ).all() as unknown as readonly { id: string }[];
    const update = this.#db.prepare('UPDATE agent_runs SET replay_sequence = ? WHERE id = ?');
    for (const row of missing) update.run(++sequence, row.id);
  }

  async save(run: AgentRun): Promise<number> {
    const replaySequence = (this.#db.prepare(
      'SELECT COALESCE(MAX(replay_sequence), 0) + 1 AS sequence FROM agent_runs',
    ).get() as { sequence: number }).sequence;
    this.#db
      .prepare(
        `INSERT INTO agent_runs
           (id, agent_id, prompt, environment_instance_id, execution_mode, engine_host_profile_id, project_id, task_id, status, events, lease_id, failure, failure_class, result, created_at, completed_at, hand_off, token_usage, replay_sequence, work_option, configuration_version, workspace_binding, recovery_settlement, recovered_events, retry_of_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           events = excluded.events,
           lease_id = excluded.lease_id,
           failure = excluded.failure,
           failure_class = excluded.failure_class,
           result = excluded.result,
           completed_at = excluded.completed_at,
           hand_off = excluded.hand_off,
           task_id = excluded.task_id,
           token_usage = excluded.token_usage,
           replay_sequence = excluded.replay_sequence,
           work_option = excluded.work_option,
           configuration_version = excluded.configuration_version,
           workspace_binding = excluded.workspace_binding,
           recovery_settlement = excluded.recovery_settlement,
           recovered_events = excluded.recovered_events,
           retry_of_run_id = excluded.retry_of_run_id`,
      )
      .run(
        run.id,
        run.agentId,
        run.prompt,
        run.environmentInstanceId,
        run.executionMode ?? 'environment-hosted',
        run.engineHostProfileId ?? (run.executionMode === 'host-run' ? null : run.environmentInstanceId),
        run.projectId ?? null,
        run.taskId ?? null,
        run.status,
        JSON.stringify(run.events),
        run.leaseId ?? null,
        run.failure ?? null,
        run.failureClass ?? null,
        run.result ? JSON.stringify(run.result) : null,
        run.createdAt,
        run.completedAt ?? null,
        run.handOff ? JSON.stringify(run.handOff) : null,
        run.tokenUsage ? JSON.stringify(run.tokenUsage) : null,
        replaySequence,
        run.workOption ? JSON.stringify(run.workOption) : null,
        run.configurationVersion ?? null,
        run.workspaceBinding ? JSON.stringify(run.workspaceBinding) : null,
        run.recoverySettlement ? JSON.stringify(run.recoverySettlement) : null,
        run.recoveredEvents ? JSON.stringify(run.recoveredEvents) : null,
        run.retryOfRunId ?? null,
      );
    return replaySequence;
  }

  async get(runId: string): Promise<AgentRun | undefined> {
    const row = this.#db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) as
      | unknown
      | undefined;
    return row ? toRun(row as RunRow) : undefined;
  }

  async list(): Promise<readonly AgentRun[]> {
    const rows = this.#db
      .prepare('SELECT * FROM agent_runs ORDER BY created_at DESC')
      .all() as unknown as RunRow[];
    return rows.map(toRun);
  }

  async replaySnapshots(): Promise<readonly RunReplaySnapshot[]> {
    const rows = this.#db
      .prepare('SELECT * FROM agent_runs ORDER BY replay_sequence ASC')
      .all() as unknown as RunRow[];
    return rows.map((row) => ({ sequence: row.replay_sequence!, run: toRun(row) }));
  }

  close(): void {
    if (this.#ownsDb) {
      this.#db.close();
    }
  }
}

/**
 * SQLite-backed storage for engine session keys (ADR-0002).
 *
 * The table's primary key is the identity tuple, so a re-run for the same agent
 * in the same environment and working directory replaces its own key rather than
 * accumulating rows. The key itself is an opaque string: Sprout never parses it.
 */
export class SqliteSessionKeyStore implements SessionKeyStore {
  readonly #db: DatabaseSync;
  readonly #ownsDb: boolean;

  constructor(options: { filename: string } | { db: DatabaseSync }) {
    if ('db' in options) {
      this.#db = options.db;
      this.#ownsDb = false;
    } else {
      this.#db = new DatabaseSync(options.filename);
      this.#ownsDb = true;
      try {
        migrateOrInitializeDatabase(this.#db, { filename: options.filename });
      } catch (error) {
        this.#db.close();
        throw error;
      }
    }
    this.#init();
  }

  #init(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS agent_session_keys (
        slot TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        engine TEXT NOT NULL,
        environment_instance_id TEXT NOT NULL,
        execution_mode TEXT NOT NULL DEFAULT 'environment-hosted',
        engine_host_profile_id TEXT NOT NULL DEFAULT '',
        working_directory_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const columns = this.#db.prepare('PRAGMA table_info(agent_session_keys)').all() as unknown as readonly {
      readonly name: string;
    }[];
    const names = new Set(columns.map((column) => column.name));
    if (names.has('working_directory') && !names.has('working_directory_id')) {
      this.#migrateLegacySessionKeys();
      return;
    }
    if (!names.has('execution_mode')) {
      this.#db.exec("ALTER TABLE agent_session_keys ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'environment-hosted'");
    }
    if (!names.has('engine_host_profile_id')) {
      this.#db.exec("ALTER TABLE agent_session_keys ADD COLUMN engine_host_profile_id TEXT NOT NULL DEFAULT ''");
    }
    const legacySlots = this.#db.prepare("SELECT slot, agent_id, engine, environment_instance_id, working_directory_id FROM agent_session_keys WHERE engine_host_profile_id = ''").all() as unknown as readonly SessionKeyRow[];
    const rekey = this.#db.prepare('UPDATE agent_session_keys SET slot = ?, engine_host_profile_id = ? WHERE slot = ?');
    for (const row of legacySlots) {
      const profileId = row.environment_instance_id;
      const slot = JSON.stringify(['environment-hosted', profileId, row.agent_id, row.engine, row.environment_instance_id, row.working_directory_id]);
      rekey.run(slot, profileId, row.slot);
    }
  }

  #migrateLegacySessionKeys(): void {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.#db.prepare('SELECT * FROM agent_session_keys').all() as unknown as readonly LegacySessionKeyRow[];
      this.#db.exec(`
        ALTER TABLE agent_session_keys RENAME TO agent_session_keys_path_legacy;
        CREATE TABLE agent_session_keys (
          slot TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          engine TEXT NOT NULL,
          environment_instance_id TEXT NOT NULL,
          execution_mode TEXT NOT NULL DEFAULT 'environment-hosted',
          engine_host_profile_id TEXT NOT NULL,
          working_directory_id TEXT NOT NULL,
          session_key TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      const insert = this.#db.prepare(`
        INSERT INTO agent_session_keys
          (slot, agent_id, engine, environment_instance_id, execution_mode, engine_host_profile_id, working_directory_id, session_key, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        const identity: SessionKeyIdentity = {
          agentId: row.agent_id,
          engine: row.engine,
          environmentInstanceId: row.environment_instance_id,
          executionMode: 'environment-hosted',
          engineHostProfileId: row.environment_instance_id,
          workingDirectory: row.working_directory,
        };
        const directoryId = workingDirectoryId(row.working_directory);
        insert.run(
          sessionKeyId(identity),
          row.agent_id,
          row.engine,
          row.environment_instance_id,
          'environment-hosted',
          row.environment_instance_id,
          directoryId,
          row.session_key,
          row.updated_at,
        );
      }
      this.#db.exec('DROP TABLE agent_session_keys_path_legacy; COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async get(identity: SessionKeyIdentity): Promise<StoredSessionKey | undefined> {
    const row = this.#db
      .prepare('SELECT * FROM agent_session_keys WHERE slot = ?')
      .get(sessionKeyId(identity)) as unknown | undefined;
    return row ? toStoredSessionKey(row as SessionKeyRow) : undefined;
  }

  async save(record: SessionKeyWrite): Promise<void> {
    const directoryId = workingDirectoryId(record.workingDirectory);
    this.#db
      .prepare(
        `INSERT INTO agent_session_keys
           (slot, agent_id, engine, environment_instance_id, execution_mode, engine_host_profile_id, working_directory_id, session_key, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slot) DO UPDATE SET
           session_key = excluded.session_key,
           updated_at = excluded.updated_at`,
      )
      .run(
        sessionKeyId(record),
        record.agentId,
        record.engine,
        record.environmentInstanceId,
        record.executionMode ?? 'environment-hosted',
        record.engineHostProfileId ?? record.environmentInstanceId,
        directoryId,
        record.key,
        record.updatedAt,
      );
  }

  async delete(identity: SessionKeyIdentity): Promise<void> {
    this.#db.prepare('DELETE FROM agent_session_keys WHERE slot = ?').run(sessionKeyId(identity));
  }

  async list(): Promise<readonly StoredSessionKey[]> {
    const rows = this.#db
      .prepare('SELECT * FROM agent_session_keys ORDER BY updated_at DESC')
      .all() as unknown as SessionKeyRow[];
    return rows.map(toStoredSessionKey);
  }

  close(): void {
    if (this.#ownsDb) {
      this.#db.close();
    }
  }
}

function toRun(row: RunRow): AgentRun {
  const result = row.result !== null ? (JSON.parse(row.result) as AgentRun['result']) : undefined;
  const handOff =
    row.hand_off !== null ? (JSON.parse(row.hand_off) as RunHandOff) : undefined;
  const tokenUsage =
    row.token_usage !== null ? (JSON.parse(row.token_usage) as TokenUsage) : undefined;
  const workOption =
    row.work_option !== null ? (JSON.parse(row.work_option) as AgentWorkOption) : undefined;
  const workspaceBinding =
    row.workspace_binding !== null && row.workspace_binding !== undefined
      ? (JSON.parse(row.workspace_binding) as AgentRun['workspaceBinding'])
      : undefined;
  const recoverySettlement = row.recovery_settlement
    ? JSON.parse(row.recovery_settlement) as AgentRun['recoverySettlement'] : undefined;
  const recoveredEvents = row.recovered_events
    ? JSON.parse(row.recovered_events) as AgentRun['recoveredEvents'] : undefined;
  return {
    id: row.id,
    agentId: row.agent_id,
    prompt: row.prompt,
    environmentInstanceId: row.environment_instance_id,
    ...(row.execution_mode === 'host-run' ? { executionMode: 'host-run' as const } : {}),
    ...(row.engine_host_profile_id !== null && row.execution_mode === 'host-run'
      ? { engineHostProfileId: row.engine_host_profile_id } : {}),
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    ...(row.task_id !== null ? { taskId: row.task_id } : {}),
    status: row.status as AgentRunStatus,
    events: JSON.parse(row.events) as AgentRunEvent[],
    ...(handOff !== undefined ? { handOff } : {}),
    ...(row.lease_id !== null ? { leaseId: row.lease_id } : {}),
    ...(row.failure !== null ? { failure: row.failure } : {}),
    ...(row.failure_class === 'admission' || row.failure_class === 'environment' || row.failure_class === 'restart' || row.failure_class === 'execution'
      ? { failureClass: row.failure_class as RunFailureClass } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(tokenUsage !== undefined ? { tokenUsage } : {}),
    ...(workOption !== undefined ? { workOption } : {}),
    ...(workspaceBinding !== undefined ? { workspaceBinding } : {}),
    ...(recoverySettlement !== undefined ? { recoverySettlement } : {}),
    ...(recoveredEvents !== undefined ? { recoveredEvents } : {}),
    ...(row.retry_of_run_id !== null ? { retryOfRunId: row.retry_of_run_id } : {}),
    ...(row.configuration_version !== null ? { configurationVersion: row.configuration_version } : {}),
    createdAt: row.created_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
}

interface SessionKeyRow {
  readonly slot: string;
  readonly agent_id: string;
  readonly engine: string;
  readonly environment_instance_id: string;
  readonly execution_mode: string;
  readonly engine_host_profile_id: string;
  readonly working_directory_id: string;
  readonly session_key: string;
  readonly updated_at: number;
}

interface LegacySessionKeyRow {
  readonly agent_id: string;
  readonly engine: string;
  readonly environment_instance_id: string;
  readonly working_directory: string;
  readonly session_key: string;
  readonly updated_at: number;
}

function toStoredSessionKey(row: SessionKeyRow): StoredSessionKey {
  return {
    agentId: row.agent_id,
    engine: row.engine,
    environmentInstanceId: row.environment_instance_id,
    executionMode: row.execution_mode === 'host-run' ? 'host-run' : 'environment-hosted',
    engineHostProfileId: row.engine_host_profile_id,
    workingDirectoryId: row.working_directory_id,
    key: row.session_key,
    updatedAt: row.updated_at,
  };
}

interface RetryGateRow {
  readonly project_id: string;
  readonly armed: number;
  readonly armed_at: number | null;
  readonly updated_at: number;
}

interface RetryTriggerRow {
  readonly id: string;
  readonly project_id: string;
  readonly at: number;
  readonly eligibility_settled: number;
}

interface RetryRow {
  readonly original_run_id: string;
  readonly trigger_id: string;
  readonly project_id: string;
  readonly state: string;
  readonly retry_run_id: string | null;
  readonly queued_at: number;
  readonly dispatched_at: number | null;
  readonly settled_at: number | null;
}

/**
 * SQLite-backed storage for the bounded reconnect-retry state machine (#181).
 *
 * The tables are created when the run domain's tables are mounted, beside
 * `agent_runs`, because they are retry bookkeeping about runs rather than a
 * schema-versioned product surface: a database from before this seam opens
 * with empty gates, triggers, and rows — nobody was ever retried — and a
 * historical database gains the three empty tables on open, exactly like
 * `agent_session_keys`.
 *
 * All three record kinds are small and hot-read on every pass, so they are
 * narrow typed columns rather than JSON documents; there is no prompt, event
 * payload, host fact, or credential in any of them.
 */
export class SqliteRunReconnectRetryStore implements RunReconnectRetryStore {
  readonly #db: DatabaseSync;
  readonly #ownsDb: boolean;

  constructor(options: { filename: string } | { db: DatabaseSync }) {
    if ('db' in options) {
      this.#db = options.db;
      this.#ownsDb = false;
    } else {
      this.#db = new DatabaseSync(options.filename);
      this.#ownsDb = true;
      try {
        migrateOrInitializeDatabase(this.#db, { filename: options.filename });
      } catch (error) {
        this.#db.close();
        throw error;
      }
    }
    this.#init();
  }

  #init(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS run_reconnect_gates (
        project_id TEXT PRIMARY KEY,
        armed INTEGER NOT NULL,
        armed_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_reconnect_triggers (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        eligibility_settled INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS run_reconnect_triggers_project_idx
        ON run_reconnect_triggers (project_id);
      CREATE TABLE IF NOT EXISTS run_reconnect_retries (
        original_run_id TEXT PRIMARY KEY,
        trigger_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        state TEXT NOT NULL,
        retry_run_id TEXT,
        queued_at INTEGER NOT NULL,
        dispatched_at INTEGER,
        settled_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS run_reconnect_retries_retry_idx
        ON run_reconnect_retries (retry_run_id);
    `);
  }

  async getGate(projectId: string): Promise<ProjectRetryGate | undefined> {
    const row = this.#db
      .prepare('SELECT * FROM run_reconnect_gates WHERE project_id = ?')
      .get(projectId) as unknown as RetryGateRow | undefined;
    return row === undefined ? undefined : toGate(row);
  }

  async armGate(projectId: string, now: number): Promise<void> {
    const existing = this.#db
      .prepare('SELECT armed FROM run_reconnect_gates WHERE project_id = ?')
      .get(projectId) as unknown as { armed: number } | undefined;
    if (existing?.armed === 1) return;
    this.#db
      .prepare(
        `INSERT INTO run_reconnect_gates (project_id, armed, armed_at, updated_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           armed = 1,
           armed_at = excluded.armed_at,
           updated_at = excluded.updated_at`,
      )
      .run(projectId, now, now);
  }

  async createTriggerIfArmed(
    trigger: RunReconnectTrigger,
    eligible?: readonly QueueRunReconnectRetry[],
  ): Promise<RunReconnectTrigger | undefined> {
    // SQLite's transaction rolls back the whole wave if the process dies at
    // any statement: neither a second trigger nor a partial eligible set can
    // survive the insert/disarm crash window.
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const gate = this.#db
        .prepare('SELECT armed FROM run_reconnect_gates WHERE project_id = ?')
        .get(trigger.projectId) as unknown as { armed: number } | undefined;
      if (gate?.armed !== 1) {
        this.#db.exec('COMMIT');
        return undefined;
      }
      this.#db.prepare(
        'INSERT INTO run_reconnect_triggers (id, project_id, at, eligibility_settled) VALUES (?, ?, ?, ?)',
      ).run(trigger.id, trigger.projectId, trigger.at, eligible === undefined ? 0 : 1);
      for (const row of eligible ?? []) {
        this.#db.prepare(`INSERT INTO run_reconnect_retries
          (original_run_id, trigger_id, project_id, state, queued_at)
          VALUES (?, ?, ?, 'queued', ?)
          ON CONFLICT(original_run_id) DO NOTHING`)
          .run(row.originalRunId, trigger.id, trigger.projectId, row.now);
      }
      this.#db.prepare('UPDATE run_reconnect_gates SET armed = 0, updated_at = ? WHERE project_id = ?')
        .run(trigger.at, trigger.projectId);
      this.#db.exec('COMMIT');
      return trigger;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async settleTrigger(triggerId: string): Promise<void> {
    this.#db
      .prepare('UPDATE run_reconnect_triggers SET eligibility_settled = 1 WHERE id = ?')
      .run(triggerId);
  }

  async listUnsettledTriggers(): Promise<readonly RunReconnectTrigger[]> {
    const rows = this.#db
      .prepare('SELECT * FROM run_reconnect_triggers WHERE eligibility_settled = 0 ORDER BY at ASC, id ASC')
      .all() as unknown as RetryTriggerRow[];
    return rows.map(toTrigger);
  }

  async queueRetry(row: QueueRunReconnectRetry): Promise<boolean> {
    const result = this.#db
      .prepare(
        `INSERT INTO run_reconnect_retries
           (original_run_id, trigger_id, project_id, state, queued_at)
         VALUES (?, ?, ?, 'queued', ?)
         ON CONFLICT(original_run_id) DO NOTHING`,
      )
      .run(row.originalRunId, row.triggerId, row.projectId, row.now);
    return result.changes === 1;
  }

  async getRetry(originalRunId: string): Promise<RunReconnectRetry | undefined> {
    const row = this.#db
      .prepare('SELECT * FROM run_reconnect_retries WHERE original_run_id = ?')
      .get(originalRunId) as unknown as RetryRow | undefined;
    return row === undefined ? undefined : toRetry(row);
  }

  async markDispatched(
    originalRunId: string,
    retryRunId: string,
    now: number,
  ): Promise<boolean> {
    const result = this.#db
      .prepare(
        `UPDATE run_reconnect_retries
           SET state = 'dispatched', retry_run_id = ?, dispatched_at = ?
         WHERE original_run_id = ? AND state = 'queued'`,
      )
      .run(retryRunId, now, originalRunId);
    return result.changes === 1;
  }

  async markSettled(originalRunId: string, now: number): Promise<void> {
    this.#db
      .prepare(
        `UPDATE run_reconnect_retries
           SET state = 'settled', settled_at = ?
         WHERE original_run_id = ? AND state = 'dispatched'`,
      )
      .run(now, originalRunId);
  }

  async listRetries(): Promise<readonly RunReconnectRetry[]> {
    const rows = this.#db
      .prepare('SELECT * FROM run_reconnect_retries ORDER BY queued_at ASC, original_run_id ASC')
      .all() as unknown as RetryRow[];
    return rows.map(toRetry);
  }

  close(): void {
    if (this.#ownsDb) {
      this.#db.close();
    }
  }
}

function toGate(row: RetryGateRow): ProjectRetryGate {
  return {
    projectId: row.project_id,
    armed: row.armed === 1,
    ...(row.armed_at !== null ? { armedAt: row.armed_at } : {}),
    updatedAt: row.updated_at,
  };
}

function toTrigger(row: RetryTriggerRow): RunReconnectTrigger {
  return {
    id: row.id,
    projectId: row.project_id,
    at: row.at,
    eligibilitySettled: row.eligibility_settled === 1,
  };
}

function toRetry(row: RetryRow): RunReconnectRetry {
  return {
    originalRunId: row.original_run_id,
    triggerId: row.trigger_id,
    projectId: row.project_id,
    state: row.state as RunReconnectRetryState,
    ...(row.retry_run_id !== null ? { retryRunId: row.retry_run_id } : {}),
    queuedAt: row.queued_at,
    ...(row.dispatched_at !== null ? { dispatchedAt: row.dispatched_at } : {}),
    ...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
  };
}
