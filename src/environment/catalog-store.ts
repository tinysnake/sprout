import type { EnvironmentDefinition, EnvironmentInstance } from './model.ts';
import { sanitizeEnvironmentCatalogRecord } from './catalog-privacy.ts';

/**
 * Durable storage for the Environment catalog (E2, #116, ADR-0012).
 *
 * An enrolled Environment instance becomes a durable definition and instance
 * record here, independent of current connectivity: the catalog entry survives
 * SQLite reopen while the Worker is offline, incompatible, archival, revoked, or
 * recovering. The record holds only the portable instance identity and the
 * definition it is built from. Store adapters select and sanitize those portable
 * facts, discarding private keys, credentials, host/network details, absolute
 * paths, and raw diagnostic fields even when a caller supplies them.
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
    const safe = sanitizeEnvironmentCatalogRecord(record);
    this.#records.set(safe.instanceId, safe);
  }

  async get(instanceId: string): Promise<EnvironmentCatalogRecord | undefined> {
    const record = this.#records.get(instanceId);
    return record === undefined ? undefined : sanitizeEnvironmentCatalogRecord(record);
  }

  async list(): Promise<readonly EnvironmentCatalogRecord[]> {
    return [...this.#records.values()]
      .map(sanitizeEnvironmentCatalogRecord)
      .sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  }
}
