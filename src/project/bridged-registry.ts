import type { Project, ProjectMembership } from './model.ts';
import { ProjectRegistry } from './registry.ts';
import type { ProjectAuthority } from './authority-model.ts';
import { activeAgentMemberIds, currentProjectContent } from './authority-model.ts';
import type { ProjectAuthorityStore } from './authority-store.ts';
import type { ProjectAuthorityBridgePort } from './authority-service.ts';

/**
 * The one Project identity seam between the M2 authority and the M1
 * collaboration machinery (#92, F1).
 *
 * The M1 orchestrator, collaboration coordinator, wake contract, and composer
 * route all read `ProjectRegistry`. The M2 authority store owns the durable
 * Project lifecycle. This subclass makes the two one surface instead of two
 * authorities:
 *
 * - Active authority Projects are projected into the M1 `Project` shape. The
 *   projection is prepared before persistence and published afterwards, so a
 *   Project created through the authority is immediately addressable on its
 *   Project channel without a bridge failure leaving a durable partial record.
 *   Archive removes that projection; restore prepares it again.
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
export class BridgedProjectRegistry extends ProjectRegistry implements ProjectAuthorityBridgePort {
  constructor(projects: readonly Project[] = []) {
    super(projects);
  }

  /**
   * Project one durable authority record into the M1 collaboration shape.
   *
   * The Human member is part of the authority record but not an M1
   * membership (the M1 membership vocabulary is Agent-only), so only the
   * active Agent memberships project. The current content version's goal,
   * and rules become the collaboration view. Environment access remains empty
   * until a durable authority relationship exists; host composition is never
   * treated as a grant.
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
    // Environment access is an authority relationship, not a host default.
    // Until a durable grant exists, this Project is valid but cannot execute.
    return {
      id: project.id,
      goal: content.goal,
      rules: [...content.rules],
      availableEnvironmentInstanceIds: [],
      memberships,
    };
  }

  /**
   * Validate and fully prepare a projection without exposing it.
   *
   * ProjectService invokes this before persistence and invokes the returned
   * infallible commit only after persistence succeeds. Archived Projects commit
   * as removal, so legacy GET/routing/wake readers cannot retain stale access.
   */
  prepare(project: ProjectAuthority): () => void {
    if (project.status === 'archived') {
      return () => this.remove(project.id);
    }
    const projected = BridgedProjectRegistry.project(project);
    return () => this.add(projected);
  }

  /**
   * Mirror one durable authority record into the registry.
   *
   * Compatibility helper for direct hydration/tests. Runtime writes use the
   * prepared bridge protocol through ProjectService.
   */
  mirror(project: ProjectAuthority, _availableEnvironmentInstanceIds: readonly string[] = []): void {
    this.prepare(project)();
  }

  /** Hydrate every stored authority record at startup, after configured entries. */
  async loadAuthorities(
    store: ProjectAuthorityStore,
    _availableEnvironmentInstanceIds: readonly string[] = [],
  ): Promise<readonly ProjectAuthority[]> {
    const stored = await store.list();
    for (const project of stored) {
      this.mirror(project);
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
