import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

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
export const CURRENT_SCHEMA_VERSION = 1;

/** The minimum schema version this Sprout build can open or forward-migrate from. */
export const MIN_SUPPORTED_SCHEMA_VERSION = 0;

/** The maximum schema version this Sprout build can open. */
export const MAX_SUPPORTED_SCHEMA_VERSION = 1;

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
 * Replaces user home directories (e.g. `/Users/<user>`, `/home/<user>`, `C:\Users\<user>`)
 * with `~` and formats relative paths when inside the current working directory.
 */
export function sanitizePath(filePath: string): string {
  if (!filePath || filePath === ':memory:') {
    return filePath;
  }
  let normalized = filePath.replace(/\\/g, '/');
  const cwd = process.cwd().replace(/\\/g, '/');
  if (normalized.startsWith(cwd + '/')) {
    return normalized.slice(cwd.length + 1);
  }
  if (normalized === cwd) {
    return '.';
  }
  const home = (process.env.HOME || process.env.USERPROFILE || '').replace(/\\/g, '/');
  if (home && (normalized.startsWith(home + '/') || normalized === home)) {
    return normalized.replace(home, '~');
  }
  normalized = normalized.replace(/^(\/Users\/[^\/]+)/, '~');
  normalized = normalized.replace(/^(\/home\/[^\/]+)/, '~');
  normalized = normalized.replace(/^([A-Za-z]:\/Users\/[^\/]+)/, '~');
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
      `Please upgrade Sprout to a version supporting schema v${input.version}, or restore a compatible database.`;
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
      `Direct automatic migration is not available. Please upgrade using an intermediate Sprout release, or restore from backup.`;
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
  readonly causeError: unknown;

  constructor(input: {
    readonly databasePath: string;
    readonly safetyCopyPath: string;
    readonly fromVersion: number;
    readonly toVersion: number;
    readonly cause: unknown;
  }) {
    const sanitizedDb = sanitizePath(input.databasePath);
    const sanitizedCopy = sanitizePath(input.safetyCopyPath);
    const reason = input.cause instanceof Error ? input.cause.message : String(input.cause);
    const message = `Failed to create pre-migration safety copy for "${sanitizedDb}" at "${sanitizedCopy}": ${reason}`;
    const guidance =
      `Sprout refused to migrate the database from schema v${input.fromVersion} to v${input.toVersion} because creating the safety copy failed. ` +
      `The database has been preserved without modification. ` +
      `Please check host disk space and write permissions at "${sanitizedCopy}" before restarting Sprout.`;
    super(message, { guidance, databasePath: input.databasePath });
    this.name = 'MigrationSafetyCopyError';
    this.fromVersion = input.fromVersion;
    this.toVersion = input.toVersion;
    this.safetyCopyPath = input.safetyCopyPath;
    this.causeError = input.cause;
  }
}

/** Error thrown when forward migration fails during execution. */
export class SchemaMigrationError extends SchemaError {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly safetyCopyPath: string | undefined;
  readonly causeError: unknown;

  constructor(input: {
    readonly databasePath: string;
    readonly safetyCopyPath?: string | undefined;
    readonly fromVersion: number;
    readonly toVersion: number;
    readonly cause: unknown;
  }) {
    const sanitizedDb = sanitizePath(input.databasePath);
    const sanitizedCopy = input.safetyCopyPath ? sanitizePath(input.safetyCopyPath) : undefined;
    const reason = input.cause instanceof Error ? input.cause.message : String(input.cause);
    const message = `Schema migration from v${input.fromVersion} to v${input.toVersion} failed for "${sanitizedDb}": ${reason}`;
    const copyNotice = sanitizedCopy
      ? `A pre-migration safety copy is preserved at "${sanitizedCopy}". `
      : '';
    const guidance =
      `Schema migration from v${input.fromVersion} to v${input.toVersion} failed and was rolled back. ` +
      `The database was not modified. ${copyNotice}` +
      `Please check host diagnostics and resolve the issue before restarting Sprout.`;
    super(message, { guidance, databasePath: input.databasePath });
    this.name = 'SchemaMigrationError';
    this.fromVersion = input.fromVersion;
    this.toVersion = input.toVersion;
    this.safetyCopyPath = input.safetyCopyPath;
    this.causeError = input.cause;
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
 * Uses SQLite's `VACUUM INTO` to produce a complete, checkpointed, and clean snapshot.
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
  if (existsSync(safetyCopyPath)) {
    unlinkSync(safetyCopyPath);
  }
  sourceDb.exec(`VACUUM INTO '${safetyCopyPath.replace(/'/g, "''")}'`);
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

  const currentVersion = getSchemaVersion(db);
  const empty = isDatabaseEmpty(db);

  // 1. If empty, initialize directly at target version (no safety copy needed)
  if (empty) {
    setSchemaVersion(db, targetVersion);
    return;
  }

  // 2. Refuse schemas newer than supported range
  if (currentVersion > supportedRange.max || currentVersion > targetVersion) {
    throw new SchemaTooNewError({
      version: currentVersion,
      supportedRange,
      databasePath: options.filename,
    });
  }

  // 3. Refuse schemas older than supported range
  if (currentVersion < supportedRange.min) {
    throw new SchemaTooOldError({
      version: currentVersion,
      supportedRange,
      databasePath: options.filename,
    });
  }

  // 4. If already at target version, no migration needed
  if (currentVersion === targetVersion) {
    return;
  }

  // 5. Build forward migration chain
  const chain = findMigrationChain(currentVersion, targetVersion, migrations);
  if (!chain) {
    throw new SchemaTooOldError({
      version: currentVersion,
      supportedRange,
      databasePath: options.filename,
    });
  }

  // 6. Create pre-migration safety copy for non-empty store before changing anything
  if (options.filename !== ':memory:') {
    try {
      copyFn(db, options.filename, safetyCopyPath);
    } catch (error) {
      throw new MigrationSafetyCopyError({
        databasePath: options.filename,
        safetyCopyPath,
        fromVersion: currentVersion,
        toVersion: targetVersion,
        cause: error,
      });
    }
  }

  // 7. Execute forward migration chain transactionally
  for (const step of chain) {
    db.exec('BEGIN IMMEDIATE');
    try {
      step.migrate(db);
      setSchemaVersion(db, step.toVersion);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // preserve original error
      }
      throw new SchemaMigrationError({
        databasePath: options.filename,
        safetyCopyPath: options.filename !== ':memory:' ? safetyCopyPath : undefined,
        fromVersion: step.fromVersion,
        toVersion: step.toVersion,
        cause: error,
      });
    }
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
