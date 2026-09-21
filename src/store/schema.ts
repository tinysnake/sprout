import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  BROWSER_SESSION_ABSOLUTE_LIFETIME_MS,
  BROWSER_SESSION_IDLE_LIFETIME_MS,
} from '../auth/session-policy.ts';

/**
 * Sprout database schema versioning, safety copy, and forward migration (#83, ADR-0009).
 *
 * Every Sprout database declares an integer schema version via SQLite's
 * `PRAGMA user_version`. Normal startup accepts only a documented supported range.
 *
 * Before applying forward migrations to a non-empty store, Sprout creates a
 * consistent safety copy of the database file. Failure to create the safety copy
 * prevents migration, and any migration failure rolls back transactionally while
 * preserving the original database and safety copy.
 *
 * Failed, newer, and too-old schemas refuse normal serving with sanitized
 * host-local guidance that contains no credentials, host identities, private
 * infrastructure, or absolute user home paths.
 */

/** The current schema version of Sprout durable storage. */
export const CURRENT_SCHEMA_VERSION = 10;

/** The minimum schema version this Sprout build can open or forward-migrate from. */
export const MIN_SUPPORTED_SCHEMA_VERSION = 0;

/** The maximum schema version this Sprout build can open. */
export const MAX_SUPPORTED_SCHEMA_VERSION = 10;

/** The documented supported schema range. */
export interface SchemaVersionRange {
  readonly min: number;
  readonly max: number;
  readonly current: number;
}

export const SUPPORTED_SCHEMA_RANGE: SchemaVersionRange = {
  min: MIN_SUPPORTED_SCHEMA_VERSION,
  max: MAX_SUPPORTED_SCHEMA_VERSION,
  current: CURRENT_SCHEMA_VERSION,
};


/**
 * Sanitize a file path for safe display in error messages and host guidance.
 *
 * Replaces every absolute path with a bounded category placeholder. A schema
 * refusal may reach an operator log, so retaining even a sanitized-looking path
 * suffix could still disclose an identity, host layout, or network share.
 * Relative paths inside the current working directory remain useful and safe.
 */
export function sanitizePath(filePath: string): string {
  if (!filePath || filePath === ':memory:') {
    return filePath;
  }
  let normalized = filePath.replace(/\\/g, '/');

  const isAbsoluteUnix = normalized.startsWith('/');
  const isAbsoluteWin = /^[A-Za-z]:\//.test(normalized);
  const isUnc = normalized.startsWith('//');

  const cwd = process.cwd().replace(/\\/g, '/');
  if (normalized.startsWith(cwd + '/')) {
    return normalized.slice(cwd.length + 1);
  }
  if (normalized === cwd) {
    return '.';
  }

  const home = (process.env.HOME || process.env.USERPROFILE || '').replace(/\\/g, '/');
  if (home && (normalized.startsWith(home + '/') || normalized === home)) {
    return '<home-path>';
  }

  // UNC network shares
  if (isUnc) {
    return '<network-share-path>';
  }

  // User home directories. Keep the category but never the account name or
  // any suffix, which may identify the host or its owner.
  if (/^\/(Users|home)\//.test(normalized) || /^[A-Za-z]:\/Users\//i.test(normalized)) {
    return '<home-path>';
  }

  // Temporary directories can contain generated identifiers and user-scoped
  // subdirectories, so they are also a category rather than a partial path.
  if (
    /^(\/private)?\/(tmp|var\/folders)(\/|$)/.test(normalized) ||
    /^[A-Za-z]:\/(Windows\/)?Temp(\/|$)/i.test(normalized)
  ) {
    return '<temporary-path>';
  }

  // Arbitrary local absolute paths
  if (isAbsoluteWin || isAbsoluteUnix) {
    return '<absolute-path>';
  }

  return normalized;
}

/** Base class for all schema compatibility, safety copy, and migration errors. */
export abstract class SchemaError extends Error {
  readonly guidance: string;
  readonly sanitizedDatabasePath: string;

  constructor(message: string, input: { readonly guidance: string; readonly databasePath: string }) {
    super(message);
    this.name = 'SchemaError';
    this.guidance = input.guidance;
    this.sanitizedDatabasePath = sanitizePath(input.databasePath);
  }
}

/** Error thrown when a database has a schema version outside the supported range. */
export class UnsupportedSchemaVersionError extends SchemaError {
  readonly version: number;
  readonly supportedRange: SchemaVersionRange;

  constructor(input: {
    readonly version: number;
    readonly supportedRange: SchemaVersionRange;
    readonly databasePath: string;
    readonly guidance: string;
    readonly message: string;
  }) {
    super(input.message, input);
    this.name = 'UnsupportedSchemaVersionError';
    this.version = input.version;
    this.supportedRange = input.supportedRange;
  }
}

/** Error thrown when a database schema version is newer than the supported range. */
export class SchemaTooNewError extends UnsupportedSchemaVersionError {
  constructor(input: {
    readonly version: number;
    readonly supportedRange: SchemaVersionRange;
    readonly databasePath: string;
  }) {
    const sanitized = sanitizePath(input.databasePath);
    const message = `Sprout database schema version (v${input.version}) at "${sanitized}" is newer than supported range (v${input.supportedRange.min}..v${input.supportedRange.max}).`;
    const guidance =
      `The database schema version (v${input.version}) was created by a newer release of Sprout and cannot be opened by this build ` +
      `(supported range: v${input.supportedRange.min}..v${input.supportedRange.max}). ` +
      `Please ensure the service is stopped, upgrade Sprout to a release supporting schema v${input.version}, or restore a compatible database from backup.`;
    super({
      version: input.version,
      supportedRange: input.supportedRange,
      databasePath: input.databasePath,
      message,
      guidance,
    });
    this.name = 'SchemaTooNewError';
  }
}

/** Error thrown when a database schema version is older than the supported range. */
export class SchemaTooOldError extends UnsupportedSchemaVersionError {
  constructor(input: {
    readonly version: number;
    readonly supportedRange: SchemaVersionRange;
    readonly databasePath: string;
  }) {
    const sanitized = sanitizePath(input.databasePath);
    const message = `Sprout database schema version (v${input.version}) at "${sanitized}" is older than supported range (v${input.supportedRange.min}..v${input.supportedRange.max}).`;
    const guidance =
      `The database schema version (v${input.version}) is older than the minimum version supported by this build ` +
      `(supported range: v${input.supportedRange.min}..v${input.supportedRange.max}). ` +
      `Direct automatic migration is not available. Please ensure the service is stopped, upgrade sequentially using an intermediate Sprout release, or restore a compatible database from backup.`;
    super({
      version: input.version,
      supportedRange: input.supportedRange,
      databasePath: input.databasePath,
      message,
      guidance,
    });
    this.name = 'SchemaTooOldError';
  }
}

/** Error thrown when creating the pre-migration safety copy fails. */
export class MigrationSafetyCopyError extends SchemaError {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly safetyCopyPath: string;

  constructor(input: {
    readonly databasePath: string;
    readonly safetyCopyPath: string;
    readonly fromVersion: number;
    readonly toVersion: number;
  }) {
    const sanitizedDb = sanitizePath(input.databasePath);
    const sanitizedCopy = sanitizePath(input.safetyCopyPath);
    const message = `Failed to create pre-migration safety copy for database "${sanitizedDb}" at "${sanitizedCopy}".`;
    const guidance =
      `Sprout refused to migrate the database from schema v${input.fromVersion} to v${input.toVersion} because creating the safety copy failed. ` +
      `The database has been preserved without modification. ` +
      `Please ensure the service is stopped, verify host disk space and write permissions for "${sanitizedCopy}", and resolve storage issues before restarting Sprout.`;
    super(message, { guidance, databasePath: input.databasePath });
    this.name = 'MigrationSafetyCopyError';
    this.fromVersion = input.fromVersion;
    this.toVersion = input.toVersion;
    this.safetyCopyPath = sanitizedCopy;
  }
}

/** Error thrown when forward migration fails during execution. */
export class SchemaMigrationError extends SchemaError {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly safetyCopyPath: string | undefined;

  constructor(input: {
    readonly databasePath: string;
    readonly safetyCopyPath?: string | undefined;
    readonly fromVersion: number;
    readonly toVersion: number;
  }) {
    const sanitizedDb = sanitizePath(input.databasePath);
    const sanitizedCopy = input.safetyCopyPath ? sanitizePath(input.safetyCopyPath) : undefined;
    const message = `Schema migration from v${input.fromVersion} to v${input.toVersion} failed for database "${sanitizedDb}".`;
    const copyNotice = sanitizedCopy
      ? ` A pre-migration safety copy is preserved at "${sanitizedCopy}".`
      : '';
    const guidance =
      `Schema migration from v${input.fromVersion} to v${input.toVersion} failed and was rolled back. ` +
      `The database was not modified.${copyNotice} ` +
      `Please ensure the service is stopped, inspect host diagnostics, verify database integrity, and resolve the issue or restore from the pre-migration safety copy before restarting Sprout.`;
    super(message, { guidance, databasePath: input.databasePath });
    this.name = 'SchemaMigrationError';
    this.fromVersion = input.fromVersion;
    this.toVersion = input.toVersion;
    this.safetyCopyPath = sanitizedCopy;
  }
}

/** Get the schema version of an open SQLite database using `PRAGMA user_version`. */
export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { readonly user_version: number } | undefined;
  return row?.user_version ?? 0;
}

/** Set the schema version of an open SQLite database using `PRAGMA user_version`. */
export function setSchemaVersion(db: DatabaseSync, version: number): void {
  db.exec(`PRAGMA user_version = ${Math.floor(version)}`);
}

/** Check if a database has any non-system tables. */
export function isDatabaseEmpty(db: DatabaseSync): boolean {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as unknown as readonly { readonly name: string }[];
  return tables.length === 0;
}

/** Default safety copy path next to the database file. */
export function defaultSafetyCopyPath(databasePath: string): string {
  if (databasePath === ':memory:') return ':memory:';
  return `${databasePath}.safety-copy`;
}

/**
 * Create a consistent pre-migration safety copy of the database file.
 *
 * Uses SQLite's `VACUUM INTO` into a temporary file first, then atomically replaces
 * any existing safety copy only after the snapshot creation succeeds. If snapshot
 * creation fails, any previous valid safety copy is preserved.
 */
export function createDatabaseSafetyCopy(
  sourceDb: DatabaseSync,
  sourceFilename: string,
  safetyCopyPath: string,
): void {
  if (sourceFilename === ':memory:' || safetyCopyPath === ':memory:') {
    return;
  }
  const dir = dirname(safetyCopyPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tempCopyPath = `${safetyCopyPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    if (existsSync(tempCopyPath)) {
      unlinkSync(tempCopyPath);
    }
    sourceDb.exec(`VACUUM INTO '${tempCopyPath.replace(/'/g, "''")}'`);
    renameSync(tempCopyPath, safetyCopyPath);
  } catch (error) {
    if (existsSync(tempCopyPath)) {
      try {
        unlinkSync(tempCopyPath);
      } catch {
        // ignore temp cleanup failure
      }
    }
    throw error;
  }
}

/** Definition of a forward schema migration step. */
export interface MigrationStep {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly name?: string;
  readonly migrate: (db: DatabaseSync) => void;
}

/** Default baseline forward migrations for Sprout. */
export const DEFAULT_MIGRATIONS: readonly MigrationStep[] = [
  {
    fromVersion: 0,
    toVersion: 1,
    name: 'm1_baseline_schema',
    migrate: () => {
      // Transitioning an unversioned legacy M1 database (v0) to explicitly versioned baseline (v1).
      // The domain adapters will ensure their tables exist when mounted.
    },
  },
  {
    fromVersion: 1,
    toVersion: 2,
    name: 'operator_identity_and_browser_sessions',
    migrate: (db) => {
      // The one Operator credential and browser-session digests are a durable
      // M2 authority boundary. Raw credentials, bearer tokens, and CSRF values
      // are never stored in SQLite.
      db.exec(`
        CREATE TABLE IF NOT EXISTS operator_identity (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          credential_hash TEXT NOT NULL,
          credential_salt TEXT NOT NULL,
          version INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS browser_sessions (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          csrf_hash TEXT NOT NULL,
          credential_version INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS browser_sessions_active_idx
          ON browser_sessions (revoked_at, credential_version);
      `);
    },
  },
  {
    fromVersion: 2,
    toVersion: 3,
    name: 'bounded_browser_session_lifetime',
    migrate: (db) => {
      // Version 2 sessions were unbounded. Preserve their original timestamps
      // but assign finite deadlines before this transaction exposes version 3.
      db.exec(`
        ALTER TABLE browser_sessions ADD COLUMN absolute_expires_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE browser_sessions ADD COLUMN idle_expires_at INTEGER NOT NULL DEFAULT 0;
        UPDATE browser_sessions
        SET absolute_expires_at = created_at + ${BROWSER_SESSION_ABSOLUTE_LIFETIME_MS},
            idle_expires_at = MIN(last_seen_at + ${BROWSER_SESSION_IDLE_LIFETIME_MS}, created_at + ${BROWSER_SESSION_ABSOLUTE_LIFETIME_MS});
      `);
    },
  },
  {
    fromVersion: 3,
    toVersion: 4,
    name: 'durable_run_replay_order',
    migrate: (db) => {
      const table = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'",
      ).get();
      if (table === undefined) return;
      const columns = db.prepare('PRAGMA table_info(agent_runs)').all() as unknown as readonly { name: string }[];
      if (!columns.some((column) => column.name === 'replay_sequence')) {
        db.exec('ALTER TABLE agent_runs ADD COLUMN replay_sequence INTEGER');
      }
      const rows = db.prepare(
        'SELECT id FROM agent_runs WHERE replay_sequence IS NULL ORDER BY created_at ASC, id ASC',
      ).all() as unknown as readonly { id: string }[];
      const update = db.prepare('UPDATE agent_runs SET replay_sequence = ? WHERE id = ?');
      let sequence = (db.prepare(
        'SELECT COALESCE(MAX(replay_sequence), 0) AS sequence FROM agent_runs',
      ).get() as { sequence: number }).sequence;
      for (const row of rows) update.run(++sequence, row.id);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_replay_sequence_idx
          ON agent_runs (replay_sequence)
      `);
    },
  },
  {
    fromVersion: 4,
    toVersion: 5,
    name: 'environment_enrollment_and_readiness',
    migrate: (db) => {
      // Environment enrollment is a durable Human authority decision and the
      // observed readiness facts are durable Worker observations. Enrollment
      // documents carry only an opaque identity digest and neutral facts, so no
      // private key, engine credential, hostname, address, or absolute path has
      // a column here. Probe results are append-only rows, as ADR-0009 requires.
      db.exec(`
        CREATE TABLE IF NOT EXISTS environment_enrollments (
          id TEXT PRIMARY KEY,
          environment_instance_id TEXT NOT NULL,
          document TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS environment_enrollments_instance_idx
          ON environment_enrollments (environment_instance_id);
        CREATE TABLE IF NOT EXISTS environment_readiness (
          environment_instance_id TEXT PRIMARY KEY,
          document TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS environment_probes (
          environment_instance_id TEXT NOT NULL,
          at INTEGER NOT NULL,
          sequence INTEGER NOT NULL,
          document TEXT NOT NULL,
          PRIMARY KEY (environment_instance_id, sequence)
        );
      `);
    },
  },
  {
    fromVersion: 5,
    toVersion: 6,
    name: 'environment_recovery_and_force_release',
    migrate: (db) => {
      // Recovery records protect a lease whose work became uncertain, and Force
      // Release outcomes are permanent operational events (ADR-0009). Both store
      // neutral evidence facts and sanitized operator text in a JSON document,
      // so no credential, hostname, address, or absolute path has a column here.
      db.exec(`
        CREATE TABLE IF NOT EXISTS environment_recovery (
          id TEXT PRIMARY KEY,
          environment_instance_id TEXT NOT NULL,
          lease_id TEXT NOT NULL,
          phase TEXT NOT NULL,
          document TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS environment_recovery_lease_idx
          ON environment_recovery (lease_id);
        CREATE INDEX IF NOT EXISTS environment_recovery_instance_idx
          ON environment_recovery (environment_instance_id);
        CREATE TABLE IF NOT EXISTS environment_force_releases (
          id TEXT PRIMARY KEY,
          environment_instance_id TEXT NOT NULL,
          lease_id TEXT NOT NULL,
          at INTEGER NOT NULL,
          document TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS environment_force_releases_instance_idx
          ON environment_force_releases (environment_instance_id, at);
      `);
    },
  },
  {
    fromVersion: 6,
    toVersion: 7,
    name: 'agent_identities_and_work_options',
    migrate: (db) => {
      // A portable Agent is one JSON document keyed by its stable id, holding
      // its display name, optional standing instructions, and ordered work
      // options plus the append-only configuration history every run's
      // attribution depends on (ADR-0008). All fields are sanitized at the
      // write boundary, so no credential, hostname, address, or absolute path
      // has a column here. Archiving is a status inside the document; there is
      // no delete.
      db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          document TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    fromVersion: 7,
    toVersion: 8,
    name: 'project_authority_and_memberships',
    migrate: (db) => {
      // A durable Project is one JSON document keyed by its stable id (like an
      // Agent identity), holding its template snapshot attribution, the
      // append-only content versions (goal, rules, wake policy, routing
      // interval, memberships with responsibilities and collaboration
      // instructions), and its archive/restore status (#92, ADR-0008). All
      // fields are sanitized at the write boundary, so no credential,
      // provider or account identity, hostname, address, or absolute path has
      // a column here. Archiving and ending a membership are statuses and
      // recorded facts inside the document; there is no delete.
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_authorities (
          id TEXT PRIMARY KEY,
          document TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    fromVersion: 8,
    toVersion: 9,
    name: 'project_environment_access_and_workspaces',
    migrate: (db) => {
      // A Project Environment access relationship is one JSON document keyed by
      // the (Project, Environment instance) pair, holding the granted workspace
      // bindings as append-only history (#93, ADR-0008). The document holds only
      // the Worker's opaque workspace identity and, for a relative selection, a
      // Worker-root-relative location — never an absolute host path. Ending
      // access is a status and a superseded binding is a recorded fact inside
      // the document; there is no delete.
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_environment_access (
          project_id TEXT NOT NULL,
          environment_instance_id TEXT NOT NULL,
          document TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (project_id, environment_instance_id)
        );
      `);
    },
  },
  {
    fromVersion: 9,
    toVersion: 10,
    name: 'durable_run_workspace_binding',
    migrate: (db) => {
      // A Project workspace binding is a historical run fact (#93). This must
      // be added through the versioned transaction and safety-copy protocol,
      // never by a domain-store constructor after the database is serving.
      const table = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'",
      ).get();
      if (table === undefined) return;
      const columns = db.prepare('PRAGMA table_info(agent_runs)').all() as unknown as readonly { name: string }[];
      if (!columns.some((column) => column.name === 'workspace_binding')) {
        db.exec('ALTER TABLE agent_runs ADD COLUMN workspace_binding TEXT');
      }
    },
  },
];

/** Options for database migration and initialization. */
export interface MigrateDatabaseOptions {
  readonly filename: string;
  readonly targetVersion?: number | undefined;
  readonly supportedRange?: SchemaVersionRange | undefined;
  readonly safetyCopyPath?: string | undefined;
  readonly createSafetyCopy?:
    | ((sourceDb: DatabaseSync, sourceFilename: string, safetyCopyPath: string) => void)
    | undefined;
  readonly migrations?: readonly MigrationStep[] | undefined;
}

/**
 * Find a sequential migration chain from `fromVersion` to `toVersion`.
 */
function findMigrationChain(
  fromVersion: number,
  toVersion: number,
  migrations: readonly MigrationStep[],
): readonly MigrationStep[] | undefined {
  const chain: MigrationStep[] = [];
  let current = fromVersion;
  while (current < toVersion) {
    const step = migrations.find((m) => m.fromVersion === current);
    if (!step || step.toVersion <= current) {
      return undefined;
    }
    chain.push(step);
    current = step.toVersion;
  }
  return current === toVersion ? chain : undefined;
}

/**
 * Validate schema compatibility, create safety copies on non-empty stores,
 * and execute forward migrations transactionally.
 */
export function migrateOrInitializeDatabase(
  db: DatabaseSync,
  options: MigrateDatabaseOptions,
): void {
  const targetVersion = options.targetVersion ?? CURRENT_SCHEMA_VERSION;
  const supportedRange = options.supportedRange ?? SUPPORTED_SCHEMA_RANGE;
  const migrations = options.migrations ?? DEFAULT_MIGRATIONS;
  const copyFn = options.createSafetyCopy ?? createDatabaseSafetyCopy;
  const safetyCopyPath = options.safetyCopyPath ?? defaultSafetyCopyPath(options.filename);

  // 1. Validate targetVersion against supportedRange before touching database
  if (targetVersion > supportedRange.max) {
    throw new SchemaTooNewError({
      version: targetVersion,
      supportedRange,
      databasePath: options.filename,
    });
  }
  if (targetVersion < supportedRange.min) {
    throw new SchemaTooOldError({
      version: targetVersion,
      supportedRange,
      databasePath: options.filename,
    });
  }

  const currentVersion = getSchemaVersion(db);
  const empty = isDatabaseEmpty(db);

  // 2. If empty, initialize directly at target version (no safety copy needed)
  if (empty) {
    setSchemaVersion(db, targetVersion);
    return;
  }

  // 3. Refuse schemas newer than supported range or target
  if (currentVersion > supportedRange.max || currentVersion > targetVersion) {
    throw new SchemaTooNewError({
      version: currentVersion,
      supportedRange,
      databasePath: options.filename,
    });
  }

  // 4. Refuse schemas older than supported range
  if (currentVersion < supportedRange.min) {
    throw new SchemaTooOldError({
      version: currentVersion,
      supportedRange,
      databasePath: options.filename,
    });
  }

  // 5. If already at target version, no migration needed
  if (currentVersion === targetVersion) {
    return;
  }

  // 6. Build forward migration chain
  const chain = findMigrationChain(currentVersion, targetVersion, migrations);
  if (!chain) {
    throw new SchemaTooOldError({
      version: currentVersion,
      supportedRange,
      databasePath: options.filename,
    });
  }

  // 7. Create pre-migration safety copy for non-empty store before changing anything
  if (options.filename !== ':memory:') {
    try {
      copyFn(db, options.filename, safetyCopyPath);
    } catch {
      throw new MigrationSafetyCopyError({
        databasePath: options.filename,
        safetyCopyPath,
        fromVersion: currentVersion,
        toVersion: targetVersion,
      });
    }
  }

  // 8. Execute entire forward migration chain inside a single transactional boundary
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const step of chain) {
      step.migrate(db);
      setSchemaVersion(db, step.toVersion);
    }
    db.exec('COMMIT');
  } catch {
    try {
      db.exec('ROLLBACK');
    } catch {
      // preserve original error
    }
    throw new SchemaMigrationError({
      databasePath: options.filename,
      safetyCopyPath: options.filename !== ':memory:' ? safetyCopyPath : undefined,
      fromVersion: currentVersion,
      toVersion: targetVersion,
    });
  }
}

/**
 * Check that an open database's schema version is within the supported range.
 */
export function assertSchemaCompatibility(
  db: DatabaseSync,
  supportedRange: SchemaVersionRange = SUPPORTED_SCHEMA_RANGE,
  databasePath: string = 'database.db',
): void {
  const version = getSchemaVersion(db);
  if (isDatabaseEmpty(db)) {
    return;
  }
  if (version > supportedRange.max) {
    throw new SchemaTooNewError({
      version,
      supportedRange,
      databasePath,
    });
  }
  if (version < supportedRange.min) {
    throw new SchemaTooOldError({
      version,
      supportedRange,
      databasePath,
    });
  }
}
