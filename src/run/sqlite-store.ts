import { DatabaseSync } from 'node:sqlite';

import type { AgentRun, AgentRunStatus } from './model.ts';
import type { AgentRunEvent } from '../engine/port.ts';
import type { RunStore } from './store.ts';

/**
 * SQLite-backed run storage (ADR-0002).
 *
 * This is the only module that knows SQL. The orchestrator depends on the
 * `RunStore` interface, so swapping this for the in-memory store, or for a
 * server database later, does not touch run orchestration.
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
  readonly status: string;
  readonly events: string;
  readonly lease_id: string | null;
  readonly failure: string | null;
  readonly result: string | null;
  readonly created_at: number;
  readonly completed_at: number | null;
}

export class SqliteRunStore implements RunStore {
  readonly #db: DatabaseSync;

  constructor(options: SqliteRunStoreOptions) {
    this.#db = new DatabaseSync(options.filename);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        environment_instance_id TEXT NOT NULL,
        status TEXT NOT NULL,
        events TEXT NOT NULL,
        lease_id TEXT,
        failure TEXT,
        result TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
    `);
  }

  async save(run: AgentRun): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO agent_runs
           (id, agent_id, prompt, environment_instance_id, status, events, lease_id, failure, result, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           events = excluded.events,
           lease_id = excluded.lease_id,
           failure = excluded.failure,
           result = excluded.result,
           completed_at = excluded.completed_at`,
      )
      .run(
        run.id,
        run.agentId,
        run.prompt,
        run.environmentInstanceId,
        run.status,
        JSON.stringify(run.events),
        run.leaseId ?? null,
        run.failure ?? null,
        run.result ? JSON.stringify(run.result) : null,
        run.createdAt,
        run.completedAt ?? null,
      );
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

  close(): void {
    this.#db.close();
  }
}

function toRun(row: RunRow): AgentRun {
  const result = row.result !== null ? (JSON.parse(row.result) as AgentRun['result']) : undefined;
  return {
    id: row.id,
    agentId: row.agent_id,
    prompt: row.prompt,
    environmentInstanceId: row.environment_instance_id,
    status: row.status as AgentRunStatus,
    events: JSON.parse(row.events) as AgentRunEvent[],
    ...(row.lease_id !== null ? { leaseId: row.lease_id } : {}),
    ...(row.failure !== null ? { failure: row.failure } : {}),
    ...(result !== undefined ? { result } : {}),
    createdAt: row.created_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
}
