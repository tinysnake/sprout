import type { EnvironmentRecoveryRecord, ForceReleaseRecord } from './recovery.ts';

/**
 * Durable storage for Environment recovery records and Force Release outcomes (#88).
 *
 * A seam, not a SQLite detail (ADR-0002): the recovery service reads and writes
 * through this interface so the same rules run over the in-memory adapter in
 * tests and the SQLite adapter in production.
 *
 * Recovery records are one JSON document per record, like enrollments: their
 * append-only decisions and derived unresolved facts belong to the record as a
 * whole. Force Release outcomes are their own append-only rows because ADR-0009
 * makes them permanent operational events that must survive even after the
 * Environment returns to Green.
 */
export interface RecoveryStore {
  save(record: EnvironmentRecoveryRecord): Promise<void>;
  get(recordId: string): Promise<EnvironmentRecoveryRecord | undefined>;
  /** The open (non-resolved) record protecting one lease, if any. */
  forLease(leaseId: string): Promise<EnvironmentRecoveryRecord | undefined>;
  /** Every record, newest first, including resolved history. */
  list(): Promise<readonly EnvironmentRecoveryRecord[]>;
  /** Append one permanent Force Release outcome; prior outcomes are preserved. */
  appendForceRelease(record: ForceReleaseRecord): Promise<void>;
  /** Every Force Release outcome for one Environment, newest first. */
  listForceReleases(environmentInstanceId: string): Promise<readonly ForceReleaseRecord[]>;
}

export class InMemoryRecoveryStore implements RecoveryStore {
  readonly #records = new Map<string, EnvironmentRecoveryRecord>();
  readonly #forceReleases: ForceReleaseRecord[] = [];

  async save(record: EnvironmentRecoveryRecord): Promise<void> {
    this.#records.set(record.id, record);
  }

  async get(recordId: string): Promise<EnvironmentRecoveryRecord | undefined> {
    return this.#records.get(recordId);
  }

  async forLease(leaseId: string): Promise<EnvironmentRecoveryRecord | undefined> {
    for (const record of this.#records.values()) {
      if (record.leaseId === leaseId && record.phase !== 'resolved') return record;
    }
    return undefined;
  }

  async list(): Promise<readonly EnvironmentRecoveryRecord[]> {
    return [...this.#records.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  async appendForceRelease(record: ForceReleaseRecord): Promise<void> {
    this.#forceReleases.push(record);
  }

  async listForceReleases(environmentInstanceId: string): Promise<readonly ForceReleaseRecord[]> {
    return this.#forceReleases
      .filter((record) => record.environmentInstanceId === environmentInstanceId)
      .sort((a, b) => b.at - a.at);
  }
}
