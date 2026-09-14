import type { Project } from './model.ts';

/**
 * Durable storage for projects.
 *
 * A seam, not a detail of SQLite (ADR-0002): the orchestrator reads projects
 * through the registry, and this interface is what lets the registry be backed
 * by the in-memory implementation in tests or by SQLite in the runtime.
 */
export interface ProjectStore {
  save(project: Project): Promise<void>;
  get(projectId: string): Promise<Project | undefined>;
  list(): Promise<readonly Project[]>;
}

export class InMemoryProjectStore implements ProjectStore {
  readonly #projects = new Map<string, Project>();
  /** Every state this store was ever asked to persist, in order. */
  readonly writes: Project[] = [];

  async save(project: Project): Promise<void> {
    this.#projects.set(project.id, project);
    this.writes.push(project);
  }

  async get(projectId: string): Promise<Project | undefined> {
    return this.#projects.get(projectId);
  }

  async list(): Promise<readonly Project[]> {
    return [...this.#projects.values()];
  }
}
