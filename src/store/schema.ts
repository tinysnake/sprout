import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  BROWSER_SESSION_ABSOLUTE_LIFETIME_MS,
  BROWSER_SESSION_IDLE_LIFETIME_MS,
} from '../auth/session-policy.ts';
import { sanitizeEnvironmentCatalogRecord } from '../environment/catalog-privacy.ts';

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
export const CURRENT_SCHEMA_VERSION = 31;

/** The minimum schema version this Sprout build can open or forward-migrate from. */
export const MIN_SUPPORTED_SCHEMA_VERSION = 0;

/** The maximum schema version this Sprout build can open. */
export const MAX_SUPPORTED_SCHEMA_VERSION = 31;

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

/** Only fixed, non-sensitive validation guidance may cross the migration error boundary. */
class UsageMigrationValidationError extends Error {}

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
    readonly validationGuidance?: string | undefined;
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
      (input.validationGuidance ? `${input.validationGuidance} ` : '') +
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
  {
    fromVersion: 10,
    toVersion: 11,
    name: 'environment_catalog',
    migrate: (db) => {
      // The durable Environment catalog (E2, #116, ADR-0012): each enrolled
      // Environment instance is one JSON document keyed by its instance id,
      // holding the portable definition and instance record. The record is pure
      // identity — no private key, credential, host address, or absolute path
      // has a column here — and it survives SQLite reopen independently of
      // current connectivity, so an offline, incompatible, archived, revoked, or
      // recovering instance remains an inspectable catalog entry.
      db.exec(`
        CREATE TABLE IF NOT EXISTS environment_catalog (
          instance_id TEXT PRIMARY KEY,
          enrollment_id TEXT NOT NULL,
          document TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    fromVersion: 11,
    toVersion: 12,
    name: 'sanitize_environment_catalog_records',
    migrate: (db) => {
      // v11 documented portable catalog records but did not enforce that
      // boundary in its store adapter. Rewrite every historical document from
      // selected safe fields inside the same transactional migration, removing
      // host paths, credentials, keys, network details, and raw diagnostics.
      const table = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'environment_catalog'",
      ).get();
      if (table === undefined) return;
      const rows = db.prepare(
        'SELECT instance_id, enrollment_id, document, updated_at FROM environment_catalog ORDER BY instance_id',
      ).all() as unknown as readonly {
        readonly instance_id: string;
        readonly enrollment_id: string;
        readonly document: string;
        readonly updated_at: number;
      }[];
      // Rebuild instead of updating primary keys in place. This makes the
      // migration total even when several private legacy keys sanitize to the
      // same candidate. `collisionSafeCatalogId` deterministically disambiguates
      // that candidate without retaining any source identity.
      db.exec(`
        DROP TABLE IF EXISTS environment_catalog_v12;
        CREATE TABLE environment_catalog_v12 (
          instance_id TEXT PRIMARY KEY,
          enrollment_id TEXT NOT NULL,
          document TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      const insert = db.prepare(
        `INSERT INTO environment_catalog_v12
          (instance_id, enrollment_id, document, updated_at) VALUES (?, ?, ?, ?)`,
      );
      const used = new Set<string>();
      for (const row of rows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.document);
        } catch {
          parsed = {};
        }
        const document = parsed !== null && typeof parsed === 'object'
          ? parsed as { readonly definition?: unknown; readonly instance?: unknown }
          : {};
        const safe = sanitizeEnvironmentCatalogRecord({
          instanceId: row.instance_id,
          enrollmentId: row.enrollment_id,
          definition: document.definition,
          instance: document.instance,
          updatedAt: row.updated_at,
        });
        const instanceId = collisionSafeCatalogId(safe.instanceId, row, used);
        used.add(instanceId);
        insert.run(
          instanceId,
          safe.enrollmentId,
          JSON.stringify({
            definition: safe.definition,
            instance: { ...safe.instance, id: instanceId },
          }),
          safe.updatedAt,
        );
      }
      db.exec(`
        DROP TABLE environment_catalog;
        ALTER TABLE environment_catalog_v12 RENAME TO environment_catalog;
      `);
    },
  },
  {
    fromVersion: 12,
    toVersion: 13,
    name: 'durable_worker_connection_epochs',
    migrate: (db) => {
      // Readiness is durable, so its authority generation cannot restart at 1
      // on every process. This high-water table allocates a strictly increasing
      // epoch for each authenticated enrollment connection across reopen.
      db.exec(`
        CREATE TABLE IF NOT EXISTS worker_connection_epochs (
          enrollment_id TEXT PRIMARY KEY,
          high_water INTEGER NOT NULL CHECK (high_water > 0)
        );
      `);
      const readinessTables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('environment_enrollments', 'environment_readiness')
      `).all() as unknown as readonly { readonly name: string }[];
      if (readinessTables.length !== 2) return;
      // A v12 readiness document may already name an authority epoch. Seed
      // every enrollment's allocator from that durable evidence before any
      // post-upgrade connection can call `next()`: otherwise its first epoch
      // could reuse (for example) epoch 1 and make stale facts authoritative.
      //
      // Readiness is keyed by Environment instance while epochs are keyed by
      // enrollment, so join through the durable enrollment mapping. If legacy
      // data has several enrollment rows for one instance, conservatively seed
      // each of them. The UPSERT also retains a greater existing high-water if
      // this migration is ever applied to a partially prepared store.
      const rows = db.prepare(`
        SELECT e.id AS enrollment_id, r.document AS readiness_document
        FROM environment_enrollments AS e
        INNER JOIN environment_readiness AS r
          ON r.environment_instance_id = e.environment_instance_id
        ORDER BY e.id
      `).all() as unknown as readonly {
        readonly enrollment_id: string;
        readonly readiness_document: string;
      }[];
      const seed = db.prepare(`
        INSERT INTO worker_connection_epochs (enrollment_id, high_water)
        VALUES (?, ?)
        ON CONFLICT(enrollment_id) DO UPDATE SET
          high_water = MAX(worker_connection_epochs.high_water, excluded.high_water)
      `);
      for (const row of rows) {
        let readiness: unknown;
        try {
          readiness = JSON.parse(row.readiness_document);
        } catch {
          continue;
        }
        const epoch = readiness !== null && typeof readiness === 'object'
          ? (readiness as { readonly connectionEpoch?: unknown }).connectionEpoch
          : undefined;
        if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch <= 0) continue;
        seed.run(row.enrollment_id, epoch);
      }
    },
  },
  {
    fromVersion: 13,
    toVersion: 14,
    name: 'one_enrollment_authority_per_environment_instance',
    migrate: (db) => {
      // New enrollment creation reserves one durable authority row per
      // Environment instance. Historical sibling records are retained for
      // inspection; choosing the stable lowest id only controls future creation
      // and never deletes or rewrites those records.
      db.exec(`
        CREATE TABLE IF NOT EXISTS environment_instance_enrollment_authority (
          environment_instance_id TEXT PRIMARY KEY,
          enrollment_id TEXT NOT NULL
        );
      `);
      const table = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'environment_enrollments'",
      ).get();
      if (table === undefined) return;
      db.exec(`
        INSERT OR IGNORE INTO environment_instance_enrollment_authority
          (environment_instance_id, enrollment_id)
        SELECT environment_instance_id, MIN(id)
        FROM environment_enrollments
        GROUP BY environment_instance_id;
      `);
    },
  },
  {
    fromVersion: 14,
    toVersion: 15,
    name: 'environment_observations_and_committed_receipts',
    migrate: (db) => {
      // Readiness observations now have one coherent atomic storage representation
      // with committed receipts (#126). Additive migration preserves existing
      // environment_readiness and environment_probes history; legacy rows remain
      // explicitly historical without synthesized authority or target evidence.
      db.exec(`
        CREATE TABLE IF NOT EXISTS environment_observations (
          observation_id TEXT PRIMARY KEY,
          environment_instance_id TEXT NOT NULL,
          enrollment_id TEXT,
          connection_epoch INTEGER,
          sequence INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          readiness_document TEXT NOT NULL,
          probe_document TEXT NOT NULL,
          document TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS environment_observations_instance_seq_idx
          ON environment_observations (environment_instance_id, sequence);
      `);
      const readinessTable = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'environment_readiness'",
      ).get();
      if (readinessTable !== undefined) {
        const columns = db.prepare('PRAGMA table_info(environment_readiness)').all() as unknown as readonly { readonly name: string }[];
        if (!columns.some((col) => col.name === 'current_observation_id')) {
          db.exec('ALTER TABLE environment_readiness ADD COLUMN current_observation_id TEXT;');
        }
      }
    },
  },
  {
    fromVersion: 15,
    toVersion: 16,
    name: 'readiness_issued_attempt_order',
    migrate: (db) => {
      // Reserving before collection is durable even if the Worker never replies.
      // Existing observations remain historical; no Worker time becomes an order key.
      db.exec(`CREATE TABLE IF NOT EXISTS environment_readiness_attempts (
        observation_id TEXT PRIMARY KEY, environment_instance_id TEXT NOT NULL,
        sequence INTEGER NOT NULL, bootstrap_key TEXT UNIQUE, document TEXT NOT NULL
      );`);
    },
  },
  {
    fromVersion: 16,
    toVersion: 17,
    name: 'worker_recovery_receipts_and_run_projection',
    migrate: (db) => {
      // ADR-0009: safety-copy and migrate nonempty v16 databases before any
      // adapter may add recovery columns. Never synthesize proof for old runs.
      const runs = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'").get();
      if (runs !== undefined) {
        const columns = db.prepare('PRAGMA table_info(agent_runs)').all() as unknown as readonly { name: string }[];
        if (!columns.some((column) => column.name === 'recovery_settlement')) {
          db.exec('ALTER TABLE agent_runs ADD COLUMN recovery_settlement TEXT');
        }
        if (!columns.some((column) => column.name === 'recovered_events')) {
          db.exec('ALTER TABLE agent_runs ADD COLUMN recovered_events TEXT');
        }
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS worker_recovery_receipts (
          enrollment_id TEXT NOT NULL, turn_id TEXT NOT NULL, run_id TEXT,
          sequence INTEGER NOT NULL, settlement INTEGER NOT NULL,
          event_count INTEGER NOT NULL, settlement_payload TEXT, settlement_status TEXT,
          acknowledged INTEGER NOT NULL DEFAULT 0, settlement_acked INTEGER NOT NULL DEFAULT 0,
          compacted INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (enrollment_id, turn_id)
        );
        CREATE TABLE IF NOT EXISTS worker_recovery_events (
          enrollment_id TEXT NOT NULL, turn_id TEXT NOT NULL,
          sequence INTEGER NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (enrollment_id, turn_id, sequence)
        );
        CREATE TABLE IF NOT EXISTS worker_recovery_contexts (
          enrollment_id TEXT NOT NULL, task_id TEXT NOT NULL,
          state TEXT NOT NULL, PRIMARY KEY (enrollment_id, task_id)
        );
      `);
    },
  },
  {
    fromVersion: 17,
    toVersion: 18,
    name: 'conversation_scopes_and_working_groups',
    migrate: (db) => {
      // Conversation scopes are durable Project channels, Project-scoped direct
      // conversations, and Working groups (#95, ADR-0008). Each is one JSON
      // document keyed by its stable id: the append-only content versions and
      // membership history belong to the scope as a whole, disbanding and ended
      // membership are statuses and recorded facts, and there is no delete. The
      // document holds only sanitized display name, goal, rules, member and
      // actor ids, reasons, and timestamps — no credential, hostname, address,
      // or absolute path has a column here.
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_scopes (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          document TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS conversation_scopes_project
          ON conversation_scopes(project_id);
      `);
    },
  },
  {
    fromVersion: 18,
    toVersion: 19,
    name: 'scoped_messages_and_project_events',
    migrate: (db) => {
      // Messages now live in exactly one conversation scope (#96), and Project
      // events are durable system-produced facts with a required routing
      // disposition (ADR-0007). Wake requests and observations key on the
      // causal *input* — a Message id or a Project event id — so `message_id`
      // becomes `input_id`.
      //
      // Backfill: a legacy Project-channel Message's scope is the invariant
      // Project channel (`channel-<project>`), which is exact. A legacy direct
      // Message predates scope identity (its pair is not recoverable from the
      // recipients alone), so it keeps an empty scope id: readable history
      // that can never receive a new Message, because delivery resolves its
      // scope first. No credential, hostname, address, or path has a column.
      const messages = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'collaboration_messages'")
        .get();
      if (messages !== undefined) {
        const columns = db.prepare('PRAGMA table_info(collaboration_messages)').all() as unknown as readonly { name: string }[];
        if (!columns.some((column) => column.name === 'scope_id')) {
          db.exec("ALTER TABLE collaboration_messages ADD COLUMN scope_id TEXT NOT NULL DEFAULT '';");
        }
        db.exec(
          "UPDATE collaboration_messages SET scope_id = 'channel-' || project_id " +
            "WHERE channel = 'project' AND scope_id = '';",
        );
      }
      for (const table of ['collaboration_wake_requests', 'collaboration_observations']) {
        const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
        if (exists === undefined) continue;
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as readonly { name: string }[];
        if (columns.some((column) => column.name === 'message_id')) {
          db.exec(`ALTER TABLE ${table} RENAME COLUMN message_id TO input_id;`);
        }
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_events (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          summary TEXT NOT NULL,
          detail TEXT,
          producer_id TEXT NOT NULL,
          producer_kind TEXT NOT NULL,
          disposition TEXT NOT NULL,
          responsible_agents TEXT NOT NULL,
          delivery_key TEXT NOT NULL UNIQUE,
          origin_scope_ids TEXT NOT NULL DEFAULT '[]',
          origin_message_id TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS project_events_project
          ON project_events(project_id);
      `);
    },
  },
  {
    fromVersion: 19,
    toVersion: 20,
    name: 'routing_windows_batches_attempts',
    migrate: (db) => {
      // Wake-model-assisted routing (#97): durable collection windows with
      // cursor/deadline, frozen chronological batches with their bounded
      // context snapshot and manifest, append-only attempts, and per-input
      // outcomes. A model-assisted WakeRequest also names its batch, so the
      // wake table gains a nullable batch_id. No credential, hostname,
      // address, or path has a column; context and excerpts hold only
      // Project-shared conversation content already durable in this database.
      const wakeTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'collaboration_wake_requests'")
        .get();
      if (wakeTable !== undefined) {
        const columns = db
          .prepare('PRAGMA table_info(collaboration_wake_requests)')
          .all() as unknown as readonly { name: string }[];
        if (!columns.some((column) => column.name === 'batch_id')) {
          db.exec('ALTER TABLE collaboration_wake_requests ADD COLUMN batch_id TEXT;');
        }
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS collaboration_routing_windows (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          opened_at INTEGER NOT NULL,
          deadline_at INTEGER NOT NULL,
          interval_ms INTEGER NOT NULL,
          status TEXT NOT NULL,
          cursor TEXT,
          input_count INTEGER NOT NULL DEFAULT 0,
          closed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS collaboration_routing_windows_project
          ON collaboration_routing_windows(project_id, status);
        CREATE TABLE IF NOT EXISTS collaboration_window_inputs (
          window_id TEXT NOT NULL,
          input_id TEXT NOT NULL,
          joined_at INTEGER NOT NULL,
          PRIMARY KEY (window_id, input_id)
        );
        CREATE TABLE IF NOT EXISTS collaboration_routing_batches (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          window_id TEXT NOT NULL,
          split_index INTEGER NOT NULL,
          split_count INTEGER NOT NULL,
          cutoff_at INTEGER NOT NULL,
          status TEXT NOT NULL,
          bounds TEXT NOT NULL,
          manifest TEXT NOT NULL,
          context TEXT NOT NULL,
          error TEXT,
          created_at INTEGER NOT NULL,
          settled_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS collaboration_routing_batches_project
          ON collaboration_routing_batches(project_id);
        CREATE TABLE IF NOT EXISTS collaboration_routing_batch_inputs (
          batch_id TEXT NOT NULL,
          input_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          excerpt TEXT NOT NULL,
          truncated INTEGER NOT NULL,
          excerpt_chars INTEGER NOT NULL,
          content_chars INTEGER NOT NULL,
          PRIMARY KEY (batch_id, input_id)
        );
        CREATE TABLE IF NOT EXISTS collaboration_routing_attempts (
          id TEXT PRIMARY KEY,
          batch_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          model_id TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          finished_at INTEGER NOT NULL,
          status TEXT NOT NULL,
          error_kind TEXT,
          error_detail TEXT
        );
        CREATE INDEX IF NOT EXISTS collaboration_routing_attempts_batch
          ON collaboration_routing_attempts(batch_id);
        CREATE TABLE IF NOT EXISTS collaboration_routing_outcomes (
          batch_id TEXT NOT NULL,
          input_id TEXT NOT NULL,
          status TEXT NOT NULL,
          assignments TEXT NOT NULL,
          rationale TEXT,
          detail TEXT,
          settled_at INTEGER NOT NULL,
          PRIMARY KEY (batch_id, input_id)
        );
        CREATE INDEX IF NOT EXISTS collaboration_routing_outcomes_input
          ON collaboration_routing_outcomes(input_id);
      `);
    },
  },
  {
    fromVersion: 20,
    toVersion: 21,
    name: 'routing_attempt_recovery',
    migrate: (db) => {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'collaboration_routing_attempts'").get() === undefined) return;
      const columns = db.prepare('PRAGMA table_info(collaboration_routing_attempts)').all() as unknown as readonly { name: string }[];
      if (!columns.some((column) => column.name === 'judgement')) {
        db.exec('ALTER TABLE collaboration_routing_attempts ADD COLUMN judgement TEXT;');
      }
      // v20 did not constrain attempt numbers. Repeated restarts could record
      // several calls with the same number. Preserve every historical call and
      // its status, assigning chronological ordinals only in affected batches.
      // Recovery counts rows, so no duplicate can create an unearned retry.
      db.exec(`
        WITH ranked AS (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY batch_id ORDER BY started_at, rowid
          ) AS ordinal
          FROM collaboration_routing_attempts
          WHERE batch_id IN (
            SELECT batch_id FROM collaboration_routing_attempts
            GROUP BY batch_id, attempt_number HAVING COUNT(*) > 1
          )
        )
        UPDATE collaboration_routing_attempts
          SET attempt_number = (SELECT ordinal FROM ranked WHERE ranked.id = collaboration_routing_attempts.id)
          WHERE id IN (SELECT id FROM ranked);
      `);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS collaboration_routing_attempt_number
        ON collaboration_routing_attempts(batch_id, attempt_number);`);
    },
  },
  {
    fromVersion: 21,
    toVersion: 22,
    name: 'task_proposals_and_content_versions',
    migrate(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_proposals (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          document TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1)
        );
        CREATE INDEX IF NOT EXISTS task_proposals_project ON task_proposals(project_id);
      `);
    },
  },
  {
    fromVersion: 22,
    toVersion: 23,
    name: 'task_proposal_working_group_provenance',
    migrate(db) {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_proposals'").get();
      if (table === undefined) return;
      const columns = db.prepare('PRAGMA table_info(task_proposals)').all() as unknown as readonly { name: string }[];
      if (!columns.some(column => column.name === 'working_group_id')) {
        db.exec('ALTER TABLE task_proposals ADD COLUMN working_group_id TEXT;');
      }
      if (!columns.some(column => column.name === 'source_message_id')) {
        db.exec('ALTER TABLE task_proposals ADD COLUMN source_message_id TEXT;');
      }
    },
  },
  {
    fromVersion: 23,
    toVersion: 24,
    name: 'operational_diagnostics',
    migrate: (db) => db.exec(`CREATE TABLE IF NOT EXISTS operational_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS operational_events_subject ON operational_events(subject, kind, sequence);`),
  },
  {
    fromVersion: 24,
    toVersion: 25,
    name: 'usage_activities_and_observations',
    migrate: (db) => {
      // Usage activities represent work-model runs and wake-model routing attempts.
      // Observations are append-only facts with detailed token dimensions, Sprout
      // wall duration, independent billed cost and API-equivalent estimates,
      // valuation provenance, and supersession history (ADR-0010, #105).
      db.exec(`
        CREATE TABLE IF NOT EXISTS usage_activities (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          run_id TEXT,
          attempt_id TEXT,
          batch_id TEXT,
          project_id TEXT,
          task_id TEXT,
          agent_id TEXT,
          environment_instance_id TEXT,
          engine TEXT NOT NULL,
          model TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          settled_at INTEGER,
          wall_duration_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS usage_activities_kind_idx ON usage_activities (kind);
        CREATE INDEX IF NOT EXISTS usage_activities_run_id_idx ON usage_activities (run_id);
        CREATE INDEX IF NOT EXISTS usage_activities_attempt_id_idx ON usage_activities (attempt_id);
        CREATE INDEX IF NOT EXISTS usage_activities_project_id_idx ON usage_activities (project_id);
        CREATE INDEX IF NOT EXISTS usage_activities_task_id_idx ON usage_activities (task_id);
        CREATE INDEX IF NOT EXISTS usage_activities_agent_id_idx ON usage_activities (agent_id);
        CREATE INDEX IF NOT EXISTS usage_activities_model_idx ON usage_activities (model);
        CREATE INDEX IF NOT EXISTS usage_activities_settled_at_idx ON usage_activities (settled_at);

        CREATE TABLE IF NOT EXISTS usage_observations (
          id TEXT PRIMARY KEY,
          activity_id TEXT NOT NULL,
          observed_at INTEGER NOT NULL,
          source TEXT NOT NULL,
          source_version TEXT NOT NULL,
          completeness TEXT NOT NULL,
          input_tokens INTEGER,
          uncached_input_tokens INTEGER,
          cached_input_tokens INTEGER,
          cache_write_input_tokens INTEGER,
          output_tokens INTEGER,
          reasoning_output_tokens INTEGER,
          total_tokens INTEGER,
          wall_duration_ms INTEGER NOT NULL,
          engine_turn_duration_ms INTEGER,
          billed_cost_status TEXT NOT NULL,
          billed_usd_micros INTEGER,
          billed_reason TEXT,
          cost_estimate_status TEXT NOT NULL,
          cost_estimate_usd_micros INTEGER,
          valuation_provenance TEXT,
          price_source TEXT,
          price_source_version TEXT,
          price_dimensions TEXT,
          valued_at INTEGER,
          cost_estimate_reason TEXT,
          billing_basis TEXT NOT NULL,
          supersedes_observation_id TEXT,
          superseded_at INTEGER,
          supersession_reason TEXT,
          is_effective INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS usage_observations_activity_idx ON usage_observations (activity_id);
        CREATE INDEX IF NOT EXISTS usage_observations_effective_idx ON usage_observations (activity_id, is_effective);
      `);
    },
  },
  {
    fromVersion: 25,
    toVersion: 26,
    name: 'usage_activity_attribution_constraints',
    migrate: (db) => {
      // Reject rather than silently rewrite durable attribution or append-only
      // monetary history. A reviewed repair must preserve correction provenance.
      const invalidActivity = db.prepare(`SELECT 1 FROM usage_activities WHERE NOT (
        (kind = 'agent_run' AND typeof(run_id) = 'text' AND length(run_id) > 0
          AND typeof(agent_id) = 'text' AND length(agent_id) > 0 AND attempt_id IS NULL AND batch_id IS NULL)
        OR
        (kind = 'routing_attempt' AND run_id IS NULL AND typeof(attempt_id) = 'text' AND length(attempt_id) > 0
          AND typeof(batch_id) = 'text' AND length(batch_id) > 0
          AND typeof(project_id) = 'text' AND length(project_id) > 0
          AND task_id IS NULL AND agent_id IS NULL AND environment_instance_id IS NULL)
      ) LIMIT 1`).get();
      if (invalidActivity !== undefined) {
        throw new UsageMigrationValidationError('Invalid legacy usage activity attribution. Arrange a reviewed data repair of usage_activities before retrying; do not discard durable history.');
      }
      const invalidCost = db.prepare(`SELECT 1 FROM usage_observations WHERE
        (cost_estimate_status = 'available' AND (
          cost_estimate_usd_micros IS NULL OR typeof(cost_estimate_usd_micros) != 'integer'
          OR cost_estimate_usd_micros < 0 OR cost_estimate_usd_micros > 9007199254740991
          OR valuation_provenance IS NULL
          OR valuation_provenance NOT IN ('provider_estimated', 'harness_calculated', 'locally_estimated')
        )) OR (billed_cost_status = 'available' AND (
          billed_usd_micros IS NULL OR typeof(billed_usd_micros) != 'integer'
          OR billed_usd_micros < 0 OR billed_usd_micros > 9007199254740991
        )) LIMIT 1`).get();
      if (invalidCost !== undefined) {
        throw new UsageMigrationValidationError('Invalid legacy usage observation cost facts. Arrange a reviewed data repair of usage_observations preserving source and correction history before retrying.');
      }
      db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS usage_activities_run_id_unique
        ON usage_activities (run_id) WHERE run_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS usage_activities_attempt_id_unique
        ON usage_activities (attempt_id) WHERE attempt_id IS NOT NULL;

      CREATE TRIGGER IF NOT EXISTS usage_activity_attribution_insert
      BEFORE INSERT ON usage_activities
      WHEN NOT (
        (NEW.kind = 'agent_run' AND typeof(NEW.run_id) = 'text' AND length(NEW.run_id) > 0
          AND typeof(NEW.agent_id) = 'text' AND length(NEW.agent_id) > 0
          AND NEW.attempt_id IS NULL AND NEW.batch_id IS NULL)
        OR
        (NEW.kind = 'routing_attempt' AND NEW.run_id IS NULL
          AND typeof(NEW.attempt_id) = 'text' AND length(NEW.attempt_id) > 0
          AND typeof(NEW.batch_id) = 'text' AND length(NEW.batch_id) > 0
          AND typeof(NEW.project_id) = 'text' AND length(NEW.project_id) > 0
          AND NEW.task_id IS NULL AND NEW.agent_id IS NULL AND NEW.environment_instance_id IS NULL)
      )
      BEGIN SELECT RAISE(ABORT, 'invalid usage activity attribution'); END;

      CREATE TRIGGER IF NOT EXISTS usage_activity_attribution_update
      BEFORE UPDATE ON usage_activities
      WHEN NOT (
        (NEW.kind = 'agent_run' AND typeof(NEW.run_id) = 'text' AND length(NEW.run_id) > 0
          AND typeof(NEW.agent_id) = 'text' AND length(NEW.agent_id) > 0
          AND NEW.attempt_id IS NULL AND NEW.batch_id IS NULL)
        OR
        (NEW.kind = 'routing_attempt' AND NEW.run_id IS NULL
          AND typeof(NEW.attempt_id) = 'text' AND length(NEW.attempt_id) > 0
          AND typeof(NEW.batch_id) = 'text' AND length(NEW.batch_id) > 0
          AND typeof(NEW.project_id) = 'text' AND length(NEW.project_id) > 0
          AND NEW.task_id IS NULL AND NEW.agent_id IS NULL AND NEW.environment_instance_id IS NULL)
      )
      BEGIN SELECT RAISE(ABORT, 'invalid usage activity attribution'); END;

      CREATE TRIGGER IF NOT EXISTS usage_activity_identity_immutable
      BEFORE UPDATE ON usage_activities
      WHEN OLD.id IS NOT NEW.id OR OLD.kind IS NOT NEW.kind OR OLD.run_id IS NOT NEW.run_id
        OR OLD.attempt_id IS NOT NEW.attempt_id OR OLD.batch_id IS NOT NEW.batch_id
        OR OLD.project_id IS NOT NEW.project_id OR OLD.task_id IS NOT NEW.task_id
        OR OLD.agent_id IS NOT NEW.agent_id OR OLD.environment_instance_id IS NOT NEW.environment_instance_id
        OR OLD.engine IS NOT NEW.engine OR OLD.model IS NOT NEW.model OR OLD.created_at IS NOT NEW.created_at
      BEGIN SELECT RAISE(ABORT, 'usage activity identity is immutable'); END;

      CREATE TRIGGER IF NOT EXISTS usage_observation_cost_insert
      BEFORE INSERT ON usage_observations
      WHEN (NEW.cost_estimate_status = 'available' AND (
        NEW.cost_estimate_usd_micros IS NULL OR typeof(NEW.cost_estimate_usd_micros) != 'integer' OR
        NEW.cost_estimate_usd_micros < 0 OR NEW.cost_estimate_usd_micros > 9007199254740991 OR
        NEW.valuation_provenance IS NULL OR
        NEW.valuation_provenance NOT IN ('provider_estimated', 'harness_calculated', 'locally_estimated')
      )) OR (NEW.billed_cost_status = 'available' AND (
        NEW.billed_usd_micros IS NULL OR typeof(NEW.billed_usd_micros) != 'integer' OR
        NEW.billed_usd_micros < 0 OR NEW.billed_usd_micros > 9007199254740991
      ))
      BEGIN SELECT RAISE(ABORT, 'invalid usage observation cost facts'); END;

      CREATE TRIGGER IF NOT EXISTS usage_observation_cost_update
      BEFORE UPDATE ON usage_observations
      WHEN (NEW.cost_estimate_status = 'available' AND (
        NEW.cost_estimate_usd_micros IS NULL OR typeof(NEW.cost_estimate_usd_micros) != 'integer' OR
        NEW.cost_estimate_usd_micros < 0 OR NEW.cost_estimate_usd_micros > 9007199254740991 OR
        NEW.valuation_provenance IS NULL OR
        NEW.valuation_provenance NOT IN ('provider_estimated', 'harness_calculated', 'locally_estimated')
      )) OR (NEW.billed_cost_status = 'available' AND (
        NEW.billed_usd_micros IS NULL OR typeof(NEW.billed_usd_micros) != 'integer' OR
        NEW.billed_usd_micros < 0 OR NEW.billed_usd_micros > 9007199254740991
      ))
      BEGIN SELECT RAISE(ABORT, 'invalid usage observation cost facts'); END;
      `);
    },
  },
  {
    fromVersion: 26,
    toVersion: 27,
    name: 'collaboration_attention_resolutions',
    migrate(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS collaboration_attention_resolutions (
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        human_id TEXT NOT NULL,
        resolved_at INTEGER NOT NULL,
        source_version INTEGER NOT NULL,
        PRIMARY KEY (source_kind, source_id)
      );`);
    },
  },
  {
    fromVersion: 27,
    toVersion: 28,
    name: 'collaboration_read_markers',
    migrate(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS collaboration_read_markers (
        scope_id TEXT NOT NULL,
        human_id TEXT NOT NULL,
        message_id TEXT NOT NULL CHECK (length(message_id) > 0),
        PRIMARY KEY (scope_id, human_id)
      );`);
    },
  },
  {
    fromVersion: 28,
    toVersion: 29,
    name: 'task_group_message_intent',
    migrate(db) {
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'collaboration_messages'").get();
      if (exists === undefined) return;
      const columns = db.prepare('PRAGMA table_info(collaboration_messages)').all() as unknown as readonly { name: string }[];
      if (!columns.some((column) => column.name === 'message_kind')) {
        db.exec("ALTER TABLE collaboration_messages ADD COLUMN message_kind TEXT NOT NULL DEFAULT 'status';");
      }
    },
  },
  {
    fromVersion: 29,
    toVersion: 30,
    name: 'project_event_conversation_origins',
    migrate(db) {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_events'").get();
      if (table === undefined) return;
      const columns = db.prepare('PRAGMA table_info(project_events)').all() as unknown as readonly { name: string }[];
      if (!columns.some((column) => column.name === 'origin_scope_ids')) {
        db.exec("ALTER TABLE project_events ADD COLUMN origin_scope_ids TEXT NOT NULL DEFAULT '[]';");
      }
      if (!columns.some((column) => column.name === 'origin_message_id')) {
        db.exec('ALTER TABLE project_events ADD COLUMN origin_message_id TEXT;');
      }
    },
  },
  {
    fromVersion: 30,
    toVersion: 31,
    name: 'record_execution_placement_and_scope',
    migrate(db) {
      const exists = (name: string): boolean => db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(name) !== undefined;
      const columns = (table: string): Set<string> => new Set((db.prepare(
        `PRAGMA table_info(${table})`,
      ).all() as unknown as readonly { name: string }[]).map((column) => column.name));

      if (exists('agent_runs')) {
        const names = columns('agent_runs');
        if (!names.has('execution_placement')) db.exec('ALTER TABLE agent_runs ADD COLUMN execution_placement TEXT;');
        if (!names.has('session_key_scope')) db.exec('ALTER TABLE agent_runs ADD COLUMN session_key_scope TEXT;');
        db.exec(`UPDATE agent_runs SET execution_placement = CASE
          WHEN environment_instance_id IS NULL OR environment_instance_id = ''
            THEN json_object('mode', 'environment-hosted')
          ELSE json_object('mode', 'environment-hosted', 'engineHost', json_object(
            'kind', 'environment', 'id', environment_instance_id,
            'profile', json_object('platform', 'unknown', 'boundary', 'unknown')))
          END WHERE execution_placement IS NULL;`);
      }

      if (exists('tasks')) {
        const names = columns('tasks');
        if (!names.has('execution_placement')) db.exec('ALTER TABLE tasks ADD COLUMN execution_placement TEXT;');
        if (names.has('environment_instance_id')) {
          db.exec(`UPDATE tasks SET execution_placement = json_object(
            'mode', 'environment-hosted', 'engineHost', json_object(
              'kind', 'environment', 'id', environment_instance_id,
              'profile', json_object('platform', 'unknown', 'boundary', 'unknown')))
            WHERE environment_instance_id IS NOT NULL AND execution_placement IS NULL;`);
        }
      }

      if (exists('agent_session_keys')) {
        const names = columns('agent_session_keys');
        // The path-bearing legacy table is converted by SqliteSessionKeyStore,
        // where each row can be hashed before the raw directory is discarded.
        if (names.has('working_directory_id')) {
          const legacySlots = !names.has('execution_mode');
          if (!names.has('execution_mode')) db.exec("ALTER TABLE agent_session_keys ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'environment-hosted';");
          if (!names.has('engine_host_kind')) db.exec("ALTER TABLE agent_session_keys ADD COLUMN engine_host_kind TEXT NOT NULL DEFAULT 'environment';");
          if (!names.has('engine_host_id')) db.exec('ALTER TABLE agent_session_keys ADD COLUMN engine_host_id TEXT;');
          if (!names.has('engine_host_platform')) db.exec("ALTER TABLE agent_session_keys ADD COLUMN engine_host_platform TEXT NOT NULL DEFAULT 'unknown';");
          if (!names.has('engine_host_boundary')) db.exec("ALTER TABLE agent_session_keys ADD COLUMN engine_host_boundary TEXT NOT NULL DEFAULT 'unknown';");
          if (!names.has('scope_kind')) db.exec("ALTER TABLE agent_session_keys ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'conversation';");
          if (!names.has('scope_id')) db.exec("ALTER TABLE agent_session_keys ADD COLUMN scope_id TEXT NOT NULL DEFAULT 'legacy-unscoped';");
          db.exec('UPDATE agent_session_keys SET engine_host_id = environment_instance_id WHERE engine_host_id IS NULL;');
          if (legacySlots) db.exec(`UPDATE agent_session_keys SET slot = json_array(
            agent_id, engine, environment_instance_id, execution_mode, engine_host_kind,
            engine_host_id, engine_host_platform, engine_host_boundary, working_directory_id,
            scope_kind, scope_id)`);
        }
      }
    },
  },
];

/** Resolve even an adversarial candidate collision without exposing legacy keys. */
function collisionSafeCatalogId(
  candidate: string,
  row: {
    readonly instance_id: string;
    readonly enrollment_id: string;
    readonly document: string;
    readonly updated_at: number;
  },
  used: ReadonlySet<string>,
): string {
  if (!used.has(candidate)) return candidate;
  const source = `${row.instance_id}\0${row.enrollment_id}\0${row.document}\0${row.updated_at}`;
  for (let attempt = 0; ; attempt += 1) {
    const digest = createHash('sha256')
      .update(`sprout-catalog-collision\0${attempt}\0${source}`)
      .digest('hex');
    const resolved = `unknown-instance-${digest}`;
    if (!used.has(resolved)) return resolved;
  }
}

/** A completed schema transition that must be recorded with the schema commit. */
export interface SchemaTransition {
  readonly kind: 'initialized' | 'migrated';
  readonly fromVersion: number;
  readonly toVersion: number;
}

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
  /** Synchronous durable fact writer, invoked inside the schema transaction. */
  readonly recordSchemaTransition?: ((db: DatabaseSync, transition: SchemaTransition) => void) | undefined;
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

  // 2. Initialize empty stores transactionally so schema version and its
  // transition fact cannot be separated by a restart.
  if (empty) {
    db.exec('BEGIN IMMEDIATE');
    try {
      setSchemaVersion(db, targetVersion);
      options.recordSchemaTransition?.(db, { kind: 'initialized', fromVersion: currentVersion, toVersion: targetVersion });
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // preserve original error
      }
      throw error;
    }
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
    options.recordSchemaTransition?.(db, { kind: 'migrated', fromVersion: currentVersion, toVersion: targetVersion });
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
      fromVersion: currentVersion,
      toVersion: targetVersion,
      validationGuidance: error instanceof UsageMigrationValidationError ? error.message : undefined,
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
