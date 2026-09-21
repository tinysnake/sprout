import type { ProjectEnvironmentAccess } from './access.ts';

/**
 * Durable storage for Project Environment access and workspace bindings (#93).
 *
 * A seam, not a SQLite detail (ADR-0002): the access service reads and writes
 * through this interface, so the same rules run over the in-memory adapter in
 * tests and the SQLite adapter in production. One access record per (Project,
 * Environment instance) is stored as one JSON document keyed by its stable id,
 * including its append-only binding history, because the history belongs to the
 * relationship as a whole and must never be rewritten piecemeal.
 *
 * There is deliberately no delete: ending access is a status (ADR-0008), and a
 * superseded workspace binding is retained for historical work, so the only
 * removal this seam supports is a caller dropping the store itself.
 */
export interface ProjectAccessStore {
  save(access: ProjectEnvironmentAccess): Promise<void>;
  get(projectId: string, environmentInstanceId: string): Promise<ProjectEnvironmentAccess | undefined>;
  listForProject(projectId: string): Promise<readonly ProjectEnvironmentAccess[]>;
  list(): Promise<readonly ProjectEnvironmentAccess[]>;
}

/** The stable key for one (Project, Environment instance) access record. */
export function accessIdentity(projectId: string, environmentInstanceId: string): string {
  return `${projectId}\u0000${environmentInstanceId}`;
}

export class InMemoryProjectAccessStore implements ProjectAccessStore {
  readonly #accesses = new Map<string, ProjectEnvironmentAccess>();

  async save(access: ProjectEnvironmentAccess): Promise<void> {
    this.#accesses.set(accessIdentity(access.projectId, access.environmentInstanceId), access);
  }

  async get(projectId: string, environmentInstanceId: string): Promise<ProjectEnvironmentAccess | undefined> {
    return this.#accesses.get(accessIdentity(projectId, environmentInstanceId));
  }

  async listForProject(projectId: string): Promise<readonly ProjectEnvironmentAccess[]> {
    return [...this.#accesses.values()]
      .filter((access) => access.projectId === projectId)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  async list(): Promise<readonly ProjectEnvironmentAccess[]> {
    return [...this.#accesses.values()].sort((a, b) => a.startedAt - b.startedAt);
  }
}
