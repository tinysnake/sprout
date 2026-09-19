import { DatabaseSync } from 'node:sqlite';

import { SqliteRunStore, SqliteSessionKeyStore } from '../run/sqlite-store.ts';
import { SqliteLeaseStore } from '../environment/sqlite-store.ts';
import { SqliteProjectStore } from '../project/sqlite-store.ts';
import { SqliteCollaborationStore } from '../collaboration/sqlite-store.ts';
import { SqliteTaskStore } from '../task/sqlite-store.ts';
import { createTransactionCoordinator, type TransactionCoordinator } from './transaction.ts';

/**
 * The shared SQLite persistence handle for Sprout (ADR-0002).
 *
 * This module owns exactly two things: the one `DatabaseSync` connection's
 * lifecycle and the composition of the domain adapters mounted on it. It knows
 * no table, column, or SQL of its own — every domain store owns the SQL for the
 * tables it persists, beside its own store interface:
 *
 * - run domain: `agent_runs`, `agent_session_keys` (`run/sqlite-store.ts`)
 * - environment domain: `environment_leases` (`environment/sqlite-store.ts`)
 * - project domain: `projects` (`project/sqlite-store.ts`)
 * - Task domain: `tasks`, `task_run_links` (`task/sqlite-store.ts`)
 * - collaboration domain: `collaboration_messages`,
 *   `collaboration_wake_requests`, `collaboration_observations`
 *   (`collaboration/sqlite-store.ts`)
 *
 * Mounting every adapter on one handle is what lets a domain's multi-table
 * transaction commit against the same durable state a restart reconciles. The
 * Task lifecycle commits its Task row together with its Task-held lease in one
 * boundary: the environment adapter owns the lease statements, the Task adapter
 * owns the Task statements, and this handle binds them through one shared
 * `TransactionCoordinator` over the one connection. No adapter begins or ends a
 * transaction over another domain's table.
 *
 * The class name and its `runs`/`leases`/`projects`/`sessionKeys`/
 * `collaboration`/`tasks` surface are unchanged from M1; this file only moves the
 * composition out of the run domain so `run/` no longer looks like the
 * persistence owner.
 */

export interface SqliteStoreOptions {
  /** A file path, or `:memory:` for tests. */
  readonly filename: string;
}

export class SqliteStore {
  readonly db: DatabaseSync;
  readonly transactions: TransactionCoordinator;
  readonly runs: SqliteRunStore;
  readonly leases: SqliteLeaseStore;
  readonly projects: SqliteProjectStore;
  readonly sessionKeys: SqliteSessionKeyStore;
  readonly collaboration: SqliteCollaborationStore;
  readonly tasks: SqliteTaskStore;

  constructor(options: SqliteStoreOptions) {
    this.db = new DatabaseSync(options.filename);
    // The one connection's transaction lifecycle: a cross-domain boundary (the
    // Task begin/end lease binding) runs through this, so neither the Task nor
    // the environment adapter owns `BEGIN`/`COMMIT` on the other's table.
    this.transactions = createTransactionCoordinator(this.db);
    this.runs = new SqliteRunStore({ db: this.db });
    this.leases = new SqliteLeaseStore({ db: this.db });
    this.projects = new SqliteProjectStore({ db: this.db });
    this.sessionKeys = new SqliteSessionKeyStore({ db: this.db });
    this.collaboration = new SqliteCollaborationStore({ db: this.db });
    // The Task adapter is given the environment domain's lease-binding port, so
    // its begin/end boundaries call lease SQL the environment owns rather than
    // issuing `environment_leases` statements itself.
    this.tasks = new SqliteTaskStore({ db: this.db, leases: this.leases, transactions: this.transactions });
  }

  close(): void {
    this.db.close();
  }
}
