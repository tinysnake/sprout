import { DatabaseSync } from 'node:sqlite';

import type { AgentRun, AgentRunStatus, RunHandOff, TokenUsage } from './model.ts';
import type { AgentRunEvent } from '../engine/port.ts';
import type { RunReplaySnapshot, RunStore } from './store.ts';
import {
  sessionKeyId,
  type SessionKeyStore,
  type SessionKeyIdentity,
  type StoredSessionKey,
} from './session-key-store.ts';
import { migrateOrInitializeDatabase } from '../store/schema.ts';

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
  readonly project_id: string | null;
  readonly task_id: string | null;
  readonly status: string;
  readonly events: string;
  readonly lease_id: string | null;
  readonly failure: string | null;
  readonly result: string | null;
  readonly created_at: number;
  readonly completed_at: number | null;
  readonly hand_off: string | null;
  readonly token_usage: string | null;
  readonly replay_sequence: number | null;
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
        project_id TEXT,
        status TEXT NOT NULL,
        events TEXT NOT NULL,
        lease_id TEXT,
        failure TEXT,
        result TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        hand_off TEXT,
        task_id TEXT,
        token_usage TEXT,
        replay_sequence INTEGER
      );
    `);
    // Added after the table shipped; a database from before this column still
    // has its runs, they simply carry no recorded hand-off.
    this.#addColumnIfMissing('agent_runs', 'project_id', 'TEXT');
    this.#addColumnIfMissing('agent_runs', 'hand_off', 'TEXT');
    this.#addColumnIfMissing('agent_runs', 'task_id', 'TEXT');
    this.#addColumnIfMissing('agent_runs', 'token_usage', 'TEXT');
    this.#addColumnIfMissing('agent_runs', 'replay_sequence', 'INTEGER');
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
           (id, agent_id, prompt, environment_instance_id, project_id, task_id, status, events, lease_id, failure, result, created_at, completed_at, hand_off, token_usage, replay_sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           events = excluded.events,
           lease_id = excluded.lease_id,
           failure = excluded.failure,
           result = excluded.result,
           completed_at = excluded.completed_at,
           hand_off = excluded.hand_off,
           task_id = excluded.task_id,
           token_usage = excluded.token_usage,
           replay_sequence = excluded.replay_sequence`,
      )
      .run(
        run.id,
        run.agentId,
        run.prompt,
        run.environmentInstanceId,
        run.projectId ?? null,
        run.taskId ?? null,
        run.status,
        JSON.stringify(run.events),
        run.leaseId ?? null,
        run.failure ?? null,
        run.result ? JSON.stringify(run.result) : null,
        run.createdAt,
        run.completedAt ?? null,
        run.handOff ? JSON.stringify(run.handOff) : null,
        run.tokenUsage ? JSON.stringify(run.tokenUsage) : null,
        replaySequence,
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
        working_directory TEXT NOT NULL,
        session_key TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async get(identity: SessionKeyIdentity): Promise<StoredSessionKey | undefined> {
    const row = this.#db
      .prepare('SELECT * FROM agent_session_keys WHERE slot = ?')
      .get(sessionKeyId(identity)) as unknown | undefined;
    return row ? toStoredSessionKey(row as SessionKeyRow) : undefined;
  }

  async save(record: StoredSessionKey): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO agent_session_keys
           (slot, agent_id, engine, environment_instance_id, working_directory, session_key, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slot) DO UPDATE SET
           session_key = excluded.session_key,
           updated_at = excluded.updated_at`,
      )
      .run(
        sessionKeyId(record),
        record.agentId,
        record.engine,
        record.environmentInstanceId,
        record.workingDirectory,
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
  return {
    id: row.id,
    agentId: row.agent_id,
    prompt: row.prompt,
    environmentInstanceId: row.environment_instance_id,
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    ...(row.task_id !== null ? { taskId: row.task_id } : {}),
    status: row.status as AgentRunStatus,
    events: JSON.parse(row.events) as AgentRunEvent[],
    ...(handOff !== undefined ? { handOff } : {}),
    ...(row.lease_id !== null ? { leaseId: row.lease_id } : {}),
    ...(row.failure !== null ? { failure: row.failure } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(tokenUsage !== undefined ? { tokenUsage } : {}),
    createdAt: row.created_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
}

interface SessionKeyRow {
  readonly slot: string;
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
    workingDirectory: row.working_directory,
    key: row.session_key,
    updatedAt: row.updated_at,
  };
}
