import type { Project } from './model.ts';
import type { ProjectStore } from './store.ts';

/**
 * The projects this process serves.
 *
 * Membership is the only link between an agent and a project, so resolution
 * starts here: given an agent, the registry names the projects it belongs to,
 * and the orchestrator takes the environment set from one of them.
 */
export class ProjectRegistry {
  readonly #projects = new Map<string, Project>();

  constructor(projects: readonly Project[] = []) {
    for (const project of projects) this.#projects.set(project.id, project);
  }

  /** Add a project, replacing any same-id project already known. */
  add(project: Project): void {
    this.#projects.set(project.id, project);
  }

  /** Remove one routable projection while retaining its durable owner elsewhere. */
  remove(projectId: string): void {
    this.#projects.delete(projectId);
  }

  get(projectId: string): Project | undefined {
    return this.#projects.get(projectId);
  }

  list(): readonly Project[] {
    return [...this.#projects.values()];
  }

  /** Every project whose membership includes this agent, in registry order. */
  forAgent(agentId: string): readonly Project[] {
    return this.list().filter((project) =>
      project.memberships.some((membership) => membership.agentId === agentId),
    );
  }

  /**
   * Hydrate from a durable store, the way the pool reloads leases.
   *
   * Projects already in memory win, so a freshly registered project is never
   * shadowed by a stale stored copy.
   */
  async load(store: ProjectStore): Promise<readonly Project[]> {
    for (const stored of await store.list()) {
      if (!this.#projects.has(stored.id)) this.#projects.set(stored.id, stored);
    }
    return this.list();
  }
}
