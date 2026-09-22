import type { Project, ProjectWorkspace } from './model.ts';
import { ProjectRegistry } from './registry.ts';
import type { ProjectAuthority } from './authority-model.ts';
import { activeAgentMemberIds, currentProjectContent } from './authority-model.ts';
import type { ProjectAuthorityStore } from './authority-store.ts';
import type { ProjectAuthorityBridgePort } from './authority-service.ts';
import type { ProjectEnvironmentAccess } from './access.ts';
import { sanitizeWorkspacePath } from './access.ts';
import type { ProjectAccessStore } from './access-store.ts';
import type { ProjectAccessBridgePort } from './access-service.ts';

/**
 * The one Project identity seam between the M2 authority and the M1
 * collaboration machinery (#92, F1; #93).
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
 * - A granted Project Environment access (#93) projects into the same shape:
 *   the active Environment instance ids become the Project's available
 *   environments, and each current workspace binding becomes a relative
 *   `ProjectWorkspace` location. The Worker-managed default contributes no
 *   location, so the Worker resolves its own default workspace.
 * - Configured M1 projects (host-derived, like environment definitions) stay
 *   exactly as they were, so #85 route compatibility and every existing
 *   runtime test keep their semantics.
 * - `get` prefers a mirrored authority projection over a same-id configured
 *   legacy project, so the authority version of a shared id wins and a
 *   duplicate authority creation with a legacy id cannot fork into a second
 *   identity.
 *
 * The projection is a working view, never the durable form: content lives in
 * the authority store's append-only versions, and access lives in the access
 * store's append-only bindings. No code path may re-derive a durable record
 * from this projection.
 */
export class BridgedProjectRegistry extends ProjectRegistry implements ProjectAuthorityBridgePort, ProjectAccessBridgePort {
  /** The durable authority records the projection is rebuilt from. */
  readonly #authorities = new Map<string, ProjectAuthority>();
  /** The active Environment access per Project, used to derive the projection. */
  readonly #access = new Map<string, readonly ProjectEnvironmentAccess[]>();

  constructor(projects: readonly Project[] = []) {
    super(projects);
  }

  /**
   * Project one durable authority record into the M1 collaboration shape.
   *
   * The Human member is part of the authority record but not an M1
   * membership (the M1 membership vocabulary is Agent-only), so only the
   * active Agent memberships project.
   *
   * Environment access is an authority relationship, not a host default.
   * Only an active access record contributes an available instance; only a
   * current binding contributes a workspace location. A Project with no
   * granted access stays valid but cannot execute.
   */
  static project(
    project: ProjectAuthority,
    accesses: readonly ProjectEnvironmentAccess[] = [],
  ): Project {
    const content = currentProjectContent(project);
    const memberships = activeAgentMemberIds(project).map((agentId) => {
      const membership = content.memberships.find((entry) => entry.memberId === agentId)!;
      return {
        agentId,
        responsibilities: [...membership.responsibilities],
        collaborationInstructions: membership.collaborationInstructions,
      };
    });
    const active = accesses.filter((access) => access.status === 'active');
    const availableEnvironmentInstanceIds = active.map((access) => access.environmentInstanceId);
    // Every active access contributes a workspace entry, so the Project resolves
    // to its workspace on that instance. A relative binding names the
    // Worker-root-relative location; a Worker-managed default binding carries no
    // `path`, and the Worker resolves (and creates) its own default directory for
    // the Project — never falling back to an unrelated instance working directory.
    //
    // The projection re-derives the location through the same validator the
    // domain records with, so a corrupt or legacy durable access cannot project
    // an absolute host path into the internal runtime surface (ADR-0008/0009).
    // The HTTP view applies the same rule; this boundary must not depend on it.
    // An unsafe location is dropped, never repaired or exposed: the Worker then
    // resolves its own default directory for the Project.
    const workspaces: ProjectWorkspace[] = active.map((access) => {
      const binding = access.current;
      const path =
        binding?.kind === 'relative' && binding.path !== undefined
          ? sanitizeWorkspacePath(binding.path)
          : undefined;
      return path !== undefined
        ? { environmentInstanceId: access.environmentInstanceId, path }
        : { environmentInstanceId: access.environmentInstanceId };
    });
    return {
      id: project.id,
      goal: content.goal,
      rules: [...content.rules],
      availableEnvironmentInstanceIds,
      ...(workspaces.length > 0 ? { workspaces } : {}),
      memberships,
    };
  }

  #publish(project: ProjectAuthority): void {
    if (project.status === 'archived') {
      this.remove(project.id);
      return;
    }
    this.add(BridgedProjectRegistry.project(project, this.#access.get(project.id) ?? []));
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
      return () => {
        this.#authorities.delete(project.id);
        this.remove(project.id);
      };
    }
    return () => {
      this.#authorities.set(project.id, project);
      this.#publish(project);
    };
  }

  /**
   * Merge one Project/Environment access and republish its projection.
   *
   * ProjectAccessService invokes this before persistence and invokes the
   * returned commit only after persistence succeeds, so a failed write never
   * leaves a projection the runtime could execute against.
   */
  prepareAccess(access: ProjectEnvironmentAccess): () => void;
  /** Compatibility helper for direct hydration/tests; production merges one row. */
  prepareAccess(projectId: string, accesses: readonly ProjectEnvironmentAccess[]): () => void;
  prepareAccess(
    accessOrProjectId: ProjectEnvironmentAccess | string,
    legacyAccesses?: readonly ProjectEnvironmentAccess[],
  ): () => void {
    const accesses = typeof accessOrProjectId === 'string'
      ? legacyAccesses ?? []
      : [accessOrProjectId];
    return () => {
      // Merge at synchronous commit time rather than replacing a snapshot read
      // before persistence. Commits for separate Environments can then arrive
      // in either order without dropping the other durable access projection.
      const projectId = typeof accessOrProjectId === 'string'
        ? accessOrProjectId
        : accessOrProjectId.projectId;
      let merged = this.#access.get(projectId) ?? [];
      for (const access of accesses) {
        merged = [...merged.filter((entry) => entry.environmentInstanceId !== access.environmentInstanceId), access];
      }
      this.#access.set(projectId, merged);
      const authority = this.#authorities.get(projectId);
      if (authority !== undefined) this.#publish(authority);
    };
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

  /**
   * Hydrate every stored authority record and access relationship at startup,
   * after configured entries.
   *
   * Access is loaded before publication so the first projection a restart
   * publishes already carries the granted environments, rather than briefly
   * exposing a Project that cannot execute.
   */
  async loadAuthorities(
    store: ProjectAuthorityStore,
    _availableEnvironmentInstanceIds: readonly string[] = [],
    accessStore?: ProjectAccessStore,
  ): Promise<readonly ProjectAuthority[]> {
    if (accessStore !== undefined) {
      for (const access of await accessStore.list()) {
        const existing = this.#access.get(access.projectId) ?? [];
        this.#access.set(
          access.projectId,
          [...existing.filter((entry) => entry.environmentInstanceId !== access.environmentInstanceId), access],
        );
      }
    }
    const stored = await store.list();
    for (const project of stored) {
      this.prepare(project)();
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
