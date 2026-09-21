import type { Project, ProjectMembership } from './model.ts';
import { ProjectRegistry } from './registry.ts';
import type { ProjectAuthority } from './authority-model.ts';
import { activeAgentMemberIds, currentProjectContent } from './authority-model.ts';
import type { ProjectAuthorityStore } from './authority-store.ts';

/**
 * The one Project identity seam between the M2 authority and the M1
 * collaboration machinery (#92, F1).
 *
 * The M1 orchestrator, collaboration coordinator, wake contract, and composer
 * route all read `ProjectRegistry`. The M2 authority store owns the durable
 * Project lifecycle. This subclass makes the two one surface instead of two
 * authorities:
 *
 * - Authority Projects are projected into the M1 `Project` shape and mirrored
 *   into the registry on every durable change (`mirror`), so a Project created
 *   through the authority is immediately addressable on its Project channel —
 *   wake routing works from creation, atomically with the authority record.
 * - Configured M1 projects (host-derived, like environment definitions) stay
 *   exactly as they were, so #85 route compatibility and every existing
 *   runtime test keep their semantics.
 * - `get` prefers a mirrored authority projection over a same-id configured
 *   legacy project, so the authority version of a shared id wins and a
 *   duplicate authority creation with a legacy id cannot fork into a second
 *   identity.
 *
 * The projection is a working view, never the durable form: content lives in
 * the authority store's append-only versions. No code path may re-derive an
 * authority record from this projection.
 */
export class BridgedProjectRegistry extends ProjectRegistry {
  /** Authority-projected ids, so configured legacy entries stay separable. */
  readonly #authorityIds = new Set<string>();

  constructor(projects: readonly Project[] = []) {
    super(projects);
  }

  /**
   * Project one durable authority record into the M1 collaboration shape.
   *
   * The Human member is part of the authority record but not an M1
   * membership (the M1 membership vocabulary is Agent-only), so only the
   * active Agent memberships project. The current content version's goal,
   * rules, and environment set become the collaboration view.
   */
  static project(project: ProjectAuthority): Project {
    const content = currentProjectContent(project);
    const memberships: ProjectMembership[] = activeAgentMemberIds(project).map((agentId) => {
      const membership = content.memberships.find((entry) => entry.memberId === agentId)!;
      return {
        agentId,
        responsibilities: [...membership.responsibilities],
        collaborationInstructions: membership.collaborationInstructions,
      };
    });
    // The projected environment set is the M1 working projection: the runtime
    // resolves the instances it configured for this build (the one composed
    // instance), and the authority's durable Environment grants are later
    // M2 scope. The projection never invents an instance id.
    return {
      id: project.id,
      goal: content.goal,
      rules: [...content.rules],
      availableEnvironmentInstanceIds: [],
      memberships,
    };
  }

  /**
   * Mirror one durable authority record into the registry.
   *
   * Called on every authority change, so a created Project can route and wake
   * immediately, and an ended membership or archived status is reflected in
   * the collaboration view without any polling.
   */
  mirror(project: ProjectAuthority, availableEnvironmentInstanceIds: readonly string[]): void {
    const projected: Project = {
      ...BridgedProjectRegistry.project(project),
      availableEnvironmentInstanceIds: [...availableEnvironmentInstanceIds],
    };
    this.#authorityIds.add(project.id);
    this.add(projected);
  }

  /** Hydrate every stored authority record at startup, after configured entries. */
  async loadAuthorities(
    store: ProjectAuthorityStore,
    availableEnvironmentInstanceIds: readonly string[],
  ): Promise<readonly ProjectAuthority[]> {
    const stored = await store.list();
    for (const project of stored) {
      this.mirror(project, availableEnvironmentInstanceIds);
    }
    return stored;
  }

  /**
   * The registry's stable Project identities, including mirrored authority
   * records; a lookup cannot miss a Project the authority durably owns.
   */
  override get(projectId: string): Project | undefined {
    return super.get(projectId);
  }
}
