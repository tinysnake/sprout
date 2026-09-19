import { DatabaseSync } from 'node:sqlite';

import { SqliteRunStore, SqliteSessionKeyStore } from '../run/sqlite-store.ts';
import { SqliteLeaseStore } from '../environment/sqlite-store.ts';
import { SqliteProjectStore } from '../project/sqlite-store.ts';
import { SqliteCollaborationStore } from '../collaboration/sqlite-store.ts';
import { SqliteTaskStore } from '../task/sqlite-store.ts';
import { createTransactionCoordinator, type TransactionCoordinator } from './transaction.ts';
import {
  getSchemaVersion,
  migrateOrInitializeDatabase,
  type MigrationStep,
  type SchemaVersionRange,
} from './schema.ts';

export {
  CURRENT_SCHEMA_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
  MAX_SUPPORTED_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_RANGE,
  type SchemaVersionRange,
  type MigrationStep,
  SchemaError,
  UnsupportedSchemaVersionError,
  SchemaTooNewError,
  SchemaTooOldError,
  MigrationSafetyCopyError,
  SchemaMigrationError,
  getSchemaVersion,
  setSchemaVersion,
  isDatabaseEmpty,
  sanitizePath,
  migrateOrInitializeDatabase,
  assertSchemaCompatibility,
} from './schema.ts';

/**
 * The shared SQLite persistence handle for Sprout (ADR-0002, ADR-0009).
 *
 * This module owns connection lifecycle, schema version validation/migration,
 * and the composition of domain adapters mounted on the one database handle.
 *
 * - Every database declares a schema version (`PRAGMA user_version`) and normal
 *   startup accepts only the documented supported range.
 * - Non-empty stores receive a consistent pre-migration safety copy before any
 *   forward migration runs; copy failure blocks migration.
 * - Supported forward migrations are transactional (`BEGIN IMMEDIATE` … `COMMIT`).
 * - Failed, newer, and too-old schemas refuse normal serving with sanitized
 *   host-local guidance.
 *
 * Domain stores own the SQL for their respective tables:
 * - run domain: `agent_runs`, `agent_session_keys` (`run/sqlite-store.ts`)
 * - environment domain: `environment_leases` (`environment/sqlite-store.ts`)
 * - project domain: `projects` (`project/sqlite-store.ts`)
 * - Task domain: `tasks`, `task_run_links` (`task/sqlite-store.ts`)
 * - collaboration domain: `collaboration_messages`,
 *   `collaboration_wake_requests`, `collaboration_observations`
 *   (`collaboration/sqlite-store.ts`)
 */

export interface SqliteStoreOptions {
  /** A file path, or `:memory:` for tests. */
  readonly filename: string;
  /** Optional custom safety copy path. */
  readonly safetyCopyPath?: string | undefined;
  /** Optional target schema version (defaults to CURRENT_SCHEMA_VERSION). */
  readonly targetSchemaVersion?: number | undefined;
  /** Optional supported schema range (defaults to SUPPORTED_SCHEMA_RANGE). */
  readonly supportedSchemaRange?: SchemaVersionRange | undefined;
  /** Optional custom safety copy creator (for tests). */
  readonly createSafetyCopy?:
    | ((sourceDb: DatabaseSync, sourceFilename: string, safetyCopyPath: string) => void)
    | undefined;
  /** Optional forward migration definitions (for tests). */
  readonly migrations?: readonly MigrationStep[] | undefined;
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
  readonly schemaVersion: number;

  constructor(options: SqliteStoreOptions) {
    this.db = new DatabaseSync(options.filename);
    try {
      migrateOrInitializeDatabase(this.db, {
        filename: options.filename,
        safetyCopyPath: options.safetyCopyPath,
        targetVersion: options.targetSchemaVersion,
        supportedRange: options.supportedSchemaRange,
        createSafetyCopy: options.createSafetyCopy,
        migrations: options.migrations,
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.schemaVersion = getSchemaVersion(this.db);
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
