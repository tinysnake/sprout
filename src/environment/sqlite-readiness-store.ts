import { DatabaseSync } from 'node:sqlite';

import type { ProbeResultFact, ReadinessReceipt } from './readiness.ts';
import type {
  EnvironmentReadinessStore,
  ObservedReadiness,
  ReadinessHistoricalQuery,
  ReadinessObservation,
  ReadinessWriteAuthority,
  StoredReadinessObservation,
} from './readiness-store.ts';
import { readReadinessObservation } from './readiness-observation.ts';
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
    `);
    const columns = this.#db
      .prepare('PRAGMA table_info(environment_readiness)')
      .all() as unknown as readonly { readonly name: string }[];
    if (!columns.some((col) => col.name === 'current_observation_id')) {
      this.#db.exec('ALTER TABLE environment_readiness ADD COLUMN current_observation_id TEXT;');
    }
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
      const sequence = next.sequence + 1;
      const committedAt = Date.now();

      const receipt: ReadinessReceipt = {
        observationId: pair.observationId,
        environmentInstanceId,
        enrollmentId: pair.readiness.enrollmentId!,
        connectionEpoch: pair.readiness.connectionEpoch!,
        sequence,
        committedAt,
        probe: pair.probe,
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
        observationId: pair.observationId,
        environmentInstanceId,
        enrollmentId: pair.readiness.enrollmentId,
        connectionEpoch: pair.readiness.connectionEpoch,
        sequence,
        committedAt,
        readiness: pair.readiness,
        probe: pair.probe,
        receipt,
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
          pair.readiness.enrollmentId ?? null,
          pair.readiness.connectionEpoch ?? null,
          sequence,
          committedAt,
          JSON.stringify(pair.readiness),
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
        .run(environmentInstanceId, pair.observationId, JSON.stringify(pair.readiness), committedAt);

      this.#db.exec('COMMIT');
      return structuredClone(receipt);
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
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
