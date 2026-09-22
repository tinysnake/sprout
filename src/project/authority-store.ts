import type { ProjectAuthority } from './authority-model.ts';

/**
 * Durable storage for Project authority records (#92).
 *
 * A seam, not a SQLite detail (ADR-0002): the Project authority service reads
 * and writes through this interface, so the same rules run over the in-memory
 * adapter in tests and the SQLite adapter in production. The record is stored
 * as one JSON document keyed by the Project's stable id — including its
 * append-only content history — the same way an Agent identity is, because the
 * versions belong to the Project as a whole and must never be rewritten
 * piecemeal.
 *
 * There is deliberately no delete: archiving is a status (ADR-0008), so the
 * only removal this seam supports is a caller dropping the store itself.
 */
export interface ProjectAuthorityStore {
  save(project: ProjectAuthority): Promise<void>;
  get(projectId: string): Promise<ProjectAuthority | undefined>;
  list(): Promise<readonly ProjectAuthority[]>;
}

export class InMemoryProjectAuthorityStore implements ProjectAuthorityStore {
  readonly #projects = new Map<string, ProjectAuthority>();

  async save(project: ProjectAuthority): Promise<void> {
    this.#projects.set(project.id, project);
  }

  async get(projectId: string): Promise<ProjectAuthority | undefined> {
    return this.#projects.get(projectId);
  }

  async list(): Promise<readonly ProjectAuthority[]> {
    return [...this.#projects.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
}
