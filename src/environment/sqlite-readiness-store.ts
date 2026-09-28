import { DatabaseSync } from 'node:sqlite';

import type { ProbeResultFact, ReadinessReceipt } from './readiness.ts';
import type {
  EnvironmentReadinessStore,
  ObservedReadiness,
  ReadinessHistoricalQuery,
  ReadinessObservation,
  ReadinessWriteAuthority,
  StoredReadinessObservation,
  ModelAuthorizationEvidence,
} from './readiness-store.ts';
import { readReadinessObservation } from './readiness-observation.ts';
import { attemptMatches, sameObservationContent, withModelAuthorizations, type ReadinessAttempt } from './readiness-store.ts';
import { migrateOrInitializeDatabase } from '../store/schema.ts';

/**
 * SQLite adapter for observed Environment readiness facts (#87).
 *
 * The latest observation is one JSON document per environment instance, because
 * it is a current value that supersedes an older value. Probe results are append
 * rows, because ADR-0009 makes readiness observations append-only: a newer probe
 * supersedes a value without erasing the observations that came before it.
 */
export class SqliteEnvironmentReadinessStore implements EnvironmentReadinessStore {
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
      CREATE TABLE IF NOT EXISTS environment_readiness (
        environment_instance_id TEXT PRIMARY KEY,
        current_observation_id TEXT,
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
      CREATE TABLE IF NOT EXISTS environment_readiness_attempts (
        observation_id TEXT PRIMARY KEY, environment_instance_id TEXT NOT NULL,
        sequence INTEGER NOT NULL, bootstrap_key TEXT UNIQUE, document TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS environment_model_authorization_evidence (
        evidence_id TEXT PRIMARY KEY,
        environment_instance_id TEXT NOT NULL,
        document TEXT NOT NULL
      );
    `);
    const columns = this.#db
      .prepare('PRAGMA table_info(environment_readiness)')
      .all() as unknown as readonly { readonly name: string }[];
    if (!columns.some((col) => col.name === 'current_observation_id')) {
      this.#db.exec('ALTER TABLE environment_readiness ADD COLUMN current_observation_id TEXT;');
    }
  }

  async issueAttempt(instance: string, authority: ReadinessWriteAuthority, bootstrap = false, requiredModels: readonly string[] = [], requirements?: import('./readiness.ts').ReadinessRequirementScope): Promise<ReadinessAttempt | false> {
    if (!authority.isCurrent() || authority.environmentInstanceId !== instance) return false;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const key = bootstrap ? JSON.stringify([instance, authority.enrollmentId, authority.connectionId, requirements ?? requiredModels]) : null;
      if (key !== null) {
        const existing = this.#db.prepare('SELECT document FROM environment_readiness_attempts WHERE bootstrap_key = ?')
          .get(key) as { document: string } | undefined;
        if (existing) { this.#db.exec('COMMIT'); return JSON.parse(existing.document) as ReadinessAttempt; }
      }
      if (!authority.isCurrent()) { this.#db.exec('ROLLBACK'); return false; }
      const row = this.#db.prepare(`SELECT MAX(sequence) AS n FROM (
        SELECT sequence FROM environment_readiness_attempts WHERE environment_instance_id = ?
        UNION ALL SELECT sequence FROM environment_probes WHERE environment_instance_id = ?)`)
        .get(instance, instance) as { n: number | null };
      const attempt: ReadinessAttempt = { observationId: `obs-${crypto.randomUUID()}`, sequence: (row.n ?? 0) + 1,
        environmentInstanceId: instance, enrollmentId: authority.enrollmentId, connectionEpoch: authority.connectionEpoch,
        connectionId: authority.connectionId, lifecycleGeneration: authority.lifecycleGeneration, requiredModels: [...requiredModels],
        ...(requirements !== undefined ? { requirements: structuredClone(requirements) } : {}) };
      this.#db.prepare('INSERT INTO environment_readiness_attempts VALUES (?, ?, ?, ?, ?)')
        .run(attempt.observationId, instance, attempt.sequence, key, JSON.stringify(attempt));
      this.#db.exec('COMMIT');
      return attempt;
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }

  async getAttempt(instance: string, id: string): Promise<ReadinessAttempt | undefined> {
    const row = this.#db.prepare('SELECT document FROM environment_readiness_attempts WHERE environment_instance_id = ? AND observation_id = ?')
      .get(instance, id) as { document: string } | undefined;
    return row ? JSON.parse(row.document) as ReadinessAttempt : undefined;
  }

  async commitObservation(
    environmentInstanceId: string,
    observation: ReadinessObservation,
    authority: ReadinessWriteAuthority,
  ): Promise<ReadinessReceipt | false> {
    const pair = readReadinessObservation(environmentInstanceId, observation, authority);
    if (pair === undefined) return false;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const next = this.#db
        .prepare(
          'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM environment_probes WHERE environment_instance_id = ?',
        )
        .get(environmentInstanceId) as { readonly sequence: number };
      const issued = pair.attempt === undefined ? undefined : this.#db.prepare(
        'SELECT document FROM environment_readiness_attempts WHERE observation_id = ? AND environment_instance_id = ?',
      ).get(pair.observationId, environmentInstanceId) as { document: string } | undefined;
      const reserved = issued === undefined ? undefined : JSON.parse(issued.document) as ReadinessAttempt;
      if (!pair.attempt || !reserved ||
          !attemptMatches(reserved, authority, environmentInstanceId) ||
          reserved.sequence !== pair.attempt.sequence ||
          JSON.stringify(reserved.requirements) !== JSON.stringify(pair.requirements) ||
          JSON.stringify(reserved.requiredModels) !== JSON.stringify(pair.attempt.requiredModels) ||
          JSON.stringify(reserved.requirements) !== JSON.stringify(pair.attempt.requirements)) {
        this.#db.exec('ROLLBACK'); return false;
      }
      const previous = this.#db.prepare('SELECT document FROM environment_observations WHERE observation_id = ?')
        .get(pair.observationId) as { document: string } | undefined;
      if (previous) {
        this.#db.exec('COMMIT');
        const stored = JSON.parse(previous.document) as StoredReadinessObservation;
        return stored.workerObservedAt === pair.workerObservedAt &&
          sameObservationContent(stored.readiness, pair.readiness) &&
          JSON.stringify(stored.probe) === JSON.stringify(pair.probe) ? stored.receipt : false;
      }
      const current = this.#db.prepare(`SELECT o.sequence FROM environment_readiness r
        JOIN environment_observations o ON o.observation_id = r.current_observation_id
        WHERE r.environment_instance_id = ?`).get(environmentInstanceId) as { sequence: number } | undefined;
      if (pair.attempt && current && current.sequence > pair.attempt.sequence) {
        this.#db.exec('ROLLBACK'); return false;
      }
      const latestIssued = this.#db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM environment_readiness_attempts WHERE environment_instance_id = ?')
        .get(environmentInstanceId) as { sequence: number };
      const sequence = pair.attempt?.sequence ?? Math.max(next.sequence, latestIssued.sequence) + 1;
      const committedAt = Date.now();

      const effectiveReadiness = pair.readiness;
      const prevDocRow = this.#db
        .prepare('SELECT document FROM environment_readiness WHERE environment_instance_id = ?')
        .get(environmentInstanceId) as { document: string } | undefined;
      const prevReadiness = prevDocRow ? JSON.parse(prevDocRow.document) as ObservedReadiness : undefined;
      const authorizations = prevReadiness?.engines.flatMap((e) => e.modelAuthorizations ?? []).filter((a) =>
        a.requirementRevision === undefined || a.requirementRevision ===
          (pair.requirements?.revisionsByEngine?.[a.engine] ?? pair.requirements?.revision)) ?? [];

      const receipt: ReadinessReceipt = {
        observationId: pair.observationId,
        environmentInstanceId,
        enrollmentId: effectiveReadiness.enrollmentId!,
        connectionEpoch: effectiveReadiness.connectionEpoch!,
        sequence,
        committedAt,
        probe: pair.probe,
        authorityScope: pair.authorityScope,
        readiness: effectiveReadiness,
        at: pair.probe.at,
        latencyMs: pair.probe.latencyMs,
        protocolOk: pair.probe.protocolOk,
        enginesOk: pair.probe.enginesOk,
        summary: pair.probe.summary,
        ...(pair.probe.source !== undefined ? { source: pair.probe.source } : {}),
        ...(pair.probe.version !== undefined ? { version: pair.probe.version } : {}),
        ...(pair.requirements !== undefined ? { requirements: pair.requirements } : {}),
      };

      const storedObservation: StoredReadinessObservation = {
        ...(pair.workerObservedAt !== undefined ? { workerObservedAt: pair.workerObservedAt } : {}),
        observationId: pair.observationId,
        environmentInstanceId,
        enrollmentId: effectiveReadiness.enrollmentId,
        connectionEpoch: effectiveReadiness.connectionEpoch,
        sequence,
        committedAt,
        readiness: effectiveReadiness,
        probe: pair.probe,
        receipt,
        authorityScope: pair.authorityScope,
        ...(pair.requirements !== undefined ? { requirements: pair.requirements } : {}),
      };

      this.#db
        .prepare(
          `INSERT INTO environment_observations
             (observation_id, environment_instance_id, enrollment_id, connection_epoch, sequence, created_at, readiness_document, probe_document, document)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          pair.observationId,
          environmentInstanceId,
          effectiveReadiness.enrollmentId ?? null,
          effectiveReadiness.connectionEpoch ?? null,
          sequence,
          committedAt,
          JSON.stringify(effectiveReadiness),
          JSON.stringify(pair.probe),
          JSON.stringify(storedObservation),
        );

      this.#db
        .prepare(
          `INSERT INTO environment_probes (environment_instance_id, at, sequence, document)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          environmentInstanceId,
          pair.probe.at,
          sequence,
          JSON.stringify(pair.probe),
        );

      this.#db
        .prepare(
          `INSERT INTO environment_readiness (environment_instance_id, current_observation_id, document, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(environment_instance_id) DO UPDATE SET
             current_observation_id = excluded.current_observation_id,
             document = excluded.document,
             updated_at = excluded.updated_at`,
        )
        .run(environmentInstanceId, pair.observationId,
          JSON.stringify(withModelAuthorizations(effectiveReadiness, authorizations)), committedAt);

      this.#db.exec('COMMIT');
      return structuredClone(receipt);
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async recordModelAuthorizations(
    instance: string,
    authorizations: readonly import('./readiness.ts').ModelAuthorizationFact[],
    context?: {
      readonly enrollmentId?: string;
      readonly connectionEpoch?: number;
      readonly lifecycleGeneration?: number;
      readonly isCurrent?: () => boolean;
      readonly connectionId?: string;
      readonly requirements?: import('./readiness.ts').ReadinessRequirementScope;
      readonly actor?: string;
    },
  ): Promise<void> {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      // No await between this fence and the transaction commit. A lifecycle
      // bump that wins first must not leave a later entitlement evidence row.
      if (context?.isCurrent?.() === false) {
        this.#db.exec('ROLLBACK');
        return;
      }
      const row = this.#db
        .prepare('SELECT document, current_observation_id FROM environment_readiness WHERE environment_instance_id = ?')
        .get(instance) as { document: string; current_observation_id: string | null } | undefined;
      const existing = row ? (JSON.parse(row.document) as ObservedReadiness) : undefined;
      if (!existing && authorizations.length === 0) {
        this.#db.exec('COMMIT');
        return;
      }
      const updated = withModelAuthorizations(existing, authorizations, context);
      const committedAt = Date.now();
      const evidence: ModelAuthorizationEvidence = {
        evidenceId: `auth-${crypto.randomUUID()}`, environmentInstanceId: instance, recordedAt: committedAt,
        ...(context?.enrollmentId !== undefined ? { enrollmentId: context.enrollmentId } : {}),
        ...(context?.requirements !== undefined ? { requirements: context.requirements } : {}),
        authorizations: structuredClone(authorizations),
      };
      this.#db.prepare('INSERT INTO environment_model_authorization_evidence VALUES (?, ?, ?)')
        .run(evidence.evidenceId, instance, JSON.stringify(evidence));

      this.#db
        .prepare(
          `INSERT INTO environment_readiness (environment_instance_id, current_observation_id, document, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(environment_instance_id) DO UPDATE SET
             current_observation_id = excluded.current_observation_id,
             document = excluded.document,
             updated_at = excluded.updated_at`,
        )
        .run(instance, row?.current_observation_id ?? null, JSON.stringify(updated), committedAt);

      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async listModelAuthorizationEvidence(instance: string): Promise<readonly ModelAuthorizationEvidence[]> {
    const rows = this.#db.prepare('SELECT document FROM environment_model_authorization_evidence WHERE environment_instance_id = ? ORDER BY rowid')
      .all(instance) as unknown as readonly { readonly document: string }[];
    return rows.map((row) => JSON.parse(row.document) as ModelAuthorizationEvidence);
  }

  async getCurrentObservation(
    environmentInstanceId: string,
  ): Promise<StoredReadinessObservation | undefined> {
    const row = this.#db
      .prepare(
        `SELECT o.document
         FROM environment_readiness r
         JOIN environment_observations o ON o.observation_id = r.current_observation_id
         WHERE r.environment_instance_id = ?`,
      )
      .get(environmentInstanceId) as { readonly document: string } | undefined;
    return row ? (JSON.parse(row.document) as StoredReadinessObservation) : undefined;
  }

  async getObservation(
    environmentInstanceId: string,
    observationId: string,
  ): Promise<StoredReadinessObservation | undefined> {
    const row = this.#db
      .prepare(
        `SELECT document FROM environment_observations
         WHERE environment_instance_id = ? AND observation_id = ?`,
      )
      .get(environmentInstanceId, observationId) as { readonly document: string } | undefined;
    return row ? (JSON.parse(row.document) as StoredReadinessObservation) : undefined;
  }

  async getReceipt(
    environmentInstanceId: string,
    observationId: string,
  ): Promise<ReadinessReceipt | undefined> {
    const obs = await this.getObservation(environmentInstanceId, observationId);
    return obs?.receipt;
  }

  async listObservations(
    environmentInstanceId: string,
    query?: ReadinessHistoricalQuery,
  ): Promise<readonly StoredReadinessObservation[]> {
    let sql = 'SELECT document FROM environment_observations WHERE environment_instance_id = ?';
    const params: (string | number)[] = [environmentInstanceId];
    if (query?.enrollmentId !== undefined) {
      sql += ' AND enrollment_id = ?';
      params.push(query.enrollmentId);
    }
    if (query?.connectionEpoch !== undefined) {
      sql += ' AND connection_epoch = ?';
      params.push(query.connectionEpoch);
    }
    sql += ' ORDER BY sequence ASC';
    if (query?.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(query.limit);
    }
    const rows = this.#db.prepare(sql).all(...params) as unknown as readonly { readonly document: string }[];
    return rows.map((r) => JSON.parse(r.document) as StoredReadinessObservation);
  }

  async getReadiness(environmentInstanceId: string): Promise<ObservedReadiness | undefined> {
    const row = this.#db
      .prepare('SELECT document FROM environment_readiness WHERE environment_instance_id = ?')
      .get(environmentInstanceId) as { readonly document: string } | undefined;
    return row ? (JSON.parse(row.document) as ObservedReadiness) : undefined;
  }

  async listProbes(environmentInstanceId: string): Promise<readonly ProbeResultFact[]> {
    const rows = this.#db
      .prepare(
        `SELECT document FROM environment_probes
          WHERE environment_instance_id = ?
          ORDER BY sequence ASC`,
      )
      .all(environmentInstanceId) as unknown as readonly { readonly document: string }[];
    return rows.map((row) => JSON.parse(row.document) as ProbeResultFact);
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}
