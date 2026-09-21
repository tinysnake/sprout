import type { EnvironmentDefinition, EnvironmentInstance } from './model.ts';

/**
 * Durable storage for the Environment catalog (E2, #116, ADR-0012).
 *
 * An enrolled Environment instance becomes a durable definition and instance
 * record here, independent of current connectivity: the catalog entry survives
 * SQLite reopen while the Worker is offline, incompatible, archival, revoked, or
 * recovering. The record holds only the portable instance identity and the
 * definition it is built from — no private key, credential, hostname, address,
 * or absolute path has a field to be stored in.
 *
 * The store is a seam, not a SQLite detail (ADR-0002): the catalog projection
 * reads and writes through it, so the same rules run over the in-memory adapter
 * in tests and the SQLite adapter in production.
 */
export interface EnvironmentCatalogRecord {
  readonly instanceId: string;
  readonly enrollmentId: string;
  readonly definition: EnvironmentDefinition;
  readonly instance: EnvironmentInstance;
  readonly updatedAt: number;
}

export interface EnvironmentCatalogStore {
  save(record: EnvironmentCatalogRecord): Promise<void>;
  get(instanceId: string): Promise<EnvironmentCatalogRecord | undefined>;
  list(): Promise<readonly EnvironmentCatalogRecord[]>;
}

export class InMemoryEnvironmentCatalogStore implements EnvironmentCatalogStore {
  readonly #records = new Map<string, EnvironmentCatalogRecord>();

  async save(record: EnvironmentCatalogRecord): Promise<void> {
    this.#records.set(record.instanceId, record);
  }

  async get(instanceId: string): Promise<EnvironmentCatalogRecord | undefined> {
    return this.#records.get(instanceId);
  }

  async list(): Promise<readonly EnvironmentCatalogRecord[]> {
    return [...this.#records.values()].sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  }
}
