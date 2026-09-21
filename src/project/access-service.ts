import {
  DEFAULT_CHANGE_WORKSPACE_REASON,
  DEFAULT_END_ACCESS_REASON,
  ProjectAccessError,
  accessIsConsistent,
  sanitizeWorkspacePath,
  sanitizeWorkspaceSelection,
  type ProjectEnvironmentAccess,
  type ValidatedWorkspace,
  type WorkspaceBinding,
  type WorkspaceSelection,
} from './access.ts';
import type { ProjectAccessStore } from './access-store.ts';
import type { ProjectService } from './authority-service.ts';
import { sanitizeIdentifier, sanitizeOperatorText } from '../environment/privacy.ts';
/**
 * The caller-facing Project Environment access and Project workspace capability
 * (#93, ADR-0008).
 *
 * Adding an Environment instance to a Project is the Human grant of access, and
 * the same action selects the Project workspace. This Module owns the rule set:
 *
 * - **Validate before record.** A Human selection (the Worker-managed default or
 *   a relative location beneath the Worker workspace root) is validated or
 *   prepared by the Environment Worker *first*; only then does the durable access
 *   and binding record exist. A failure leaves the Project unchanged.
 * - **One current workspace per Environment.** Every granted access has at most
 *   one current binding; a change appends a new binding and marks the previous
 *   one unbound. History is append-only and never rewritten.
 * - **Safety-gated change and end.** A workspace change or an access end is
 *   refused while the Project and Environment have active runs, unfinished Task
 *   leases, or recovery depending on the binding.
 * - **No host path.** The Worker returns an opaque identity and, for a relative
 *   selection, a Worker-root-relative location. Sprout never receives, stores,
 *   moves, copies, or deletes the absolute location of a workspace, old or new.
 *
 * The active-work facts arrive through a narrow read-only port, so the run and
 * Task domains remain the one owners of work state.
 */

/**
 * The narrow port that validates or prepares one workspace selection.
 *
 * Implemented by the Environment Worker: the core sends portable facts and the
 * Worker answers with portable facts. The absolute location stays on the host.
 */
export interface WorkspaceValidatorPort {
  validate(input: {
    readonly projectId: string;
    readonly environmentInstanceId: string;
    readonly selection: WorkspaceSelection;
  }): Promise<ValidatedWorkspace>;
}

/**
 * The narrow read-only port that proves an Environment may receive Project
 * access. Implemented from the durable enrollment authority (#87): only a
 * Human-approved Worker identity is accessible, never a bare instance id.
 */
export interface ProjectEnvironmentAuthorityPort {
  environmentIsAccessible(environmentInstanceId: string): Promise<boolean> | boolean;
}

/**
 * The narrow read-only port that proves no active work depends on one
 * (Project, Environment) binding. Implemented from the run, Task, lease, and
 * recovery state.
 */
export interface ProjectBindingWorkSafetyPort {
  hasActiveWorkOnEnvironment(
    projectId: string,
    environmentInstanceId: string,
  ): Promise<boolean> | boolean;
}

/**
 * A prepared access projection.
 *
 * The service validates and fully prepares the projection without making it
 * visible, persists, then invokes the returned synchronous commit. A prepared
 * commit cannot fail, so a persistence failure never leaves a durable partial
 * change (the #92 bridge pattern).
 */
export interface ProjectAccessBridgePort {
  prepareAccess(
    projectId: string,
    accesses: readonly ProjectEnvironmentAccess[],
  ): (() => void) | Promise<() => void>;
}

export interface ProjectAccessServiceOptions {
  readonly store: ProjectAccessStore;
  /** The one Project authority, so access names a real, editable Project. */
  readonly projects: ProjectService;
  readonly worker: WorkspaceValidatorPort;
  readonly environments?: ProjectEnvironmentAuthorityPort;
  readonly workSafety?: ProjectBindingWorkSafetyPort;
  readonly bridge?: ProjectAccessBridgePort;
  readonly clock?: () => number;
  /** Stable binding id generator, injectable so tests control identity. */
  readonly createBindingId?: () => string;
}

export interface GrantAccessInput {
  readonly projectId: string;
  readonly environmentInstanceId: string;
  readonly selection: WorkspaceSelection;
  /** The sanitized operator reason recorded on the new binding. */
  readonly reason?: string;
}

export interface ChangeWorkspaceInput {
  readonly projectId: string;
  readonly environmentInstanceId: string;
  readonly selection: WorkspaceSelection;
  readonly reason?: string;
}

export interface EndAccessInput {
  readonly projectId: string;
  readonly environmentInstanceId: string;
  readonly reason?: string;
}

export class ProjectAccessService {
  readonly #store: ProjectAccessStore;
  readonly #projects: ProjectService;
  readonly #worker: WorkspaceValidatorPort;
  readonly #environments: ProjectEnvironmentAuthorityPort | undefined;
  readonly #workSafety: ProjectBindingWorkSafetyPort | undefined;
  readonly #bridge: ProjectAccessBridgePort | undefined;
  readonly #clock: () => number;
  readonly #createBindingId: () => string;

  constructor(options: ProjectAccessServiceOptions) {
    this.#store = options.store;
    this.#projects = options.projects;
    this.#worker = options.worker;
    this.#environments = options.environments;
    this.#workSafety = options.workSafety;
    this.#bridge = options.bridge;
    this.#clock = options.clock ?? Date.now;
    this.#createBindingId =
      options.createBindingId ?? (() => `binding-${Math.random().toString(36).slice(2, 12)}`);
  }

  async get(
    projectId: string,
    environmentInstanceId: string,
  ): Promise<ProjectEnvironmentAccess | undefined> {
    return this.#store.get(projectId, environmentInstanceId);
  }

  async listForProject(projectId: string): Promise<readonly ProjectEnvironmentAccess[]> {
    return this.#store.listForProject(projectId);
  }

  async list(): Promise<readonly ProjectEnvironmentAccess[]> {
    return this.#store.list();
  }

  /**
   * Grant one Project access to one enrolled Environment and record its current
   * Project workspace binding.
   *
   * The Worker validates or prepares the workspace before anything is durable;
   * only a successful validation records access. Re-granting after an ended
   * access reactivates the record with a fresh binding while retaining history.
   */
  async grant(input: GrantAccessInput): Promise<ProjectEnvironmentAccess> {
    const project = await this.#requireEditableProject(input.projectId);
    const selection = sanitizeWorkspaceSelection(input.selection);
    await this.#requireAccessibleEnvironment(input.environmentInstanceId);
    const existing = await this.#store.get(input.projectId, input.environmentInstanceId);
    if (existing !== undefined && existing.status === 'active') {
      throw new ProjectAccessError(
        'duplicate-environment-access',
        `project ${project.id} already has active access to ${input.environmentInstanceId}`,
      );
    }
    const validated = await this.#validate(project.id, input.environmentInstanceId, selection);
    const now = this.#clock();
    const binding = this.#newBinding(validated, now);
    const history = [...(existing?.history ?? []), binding];
    const reactivated: ProjectEnvironmentAccess = {
      projectId: project.id,
      environmentInstanceId: input.environmentInstanceId,
      status: 'active',
      // A reactivation keeps the original relationship start when there was one.
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      current: binding,
      history,
    };
    await this.#persist(reactivated);
    return reactivated;
  }

  /**
   * Change one active access's current Project workspace.
   *
   * Refused while active work depends on the binding. The Worker validates or
   * prepares the replacement before the binding changes; the previous binding is
   * marked unbound and retained, and the old directory is never moved, copied,
   * merged, or deleted.
   */
  async changeWorkspace(input: ChangeWorkspaceInput): Promise<ProjectEnvironmentAccess> {
    await this.#requireEditableProject(input.projectId);
    const access = await this.#requireActiveAccess(input.projectId, input.environmentInstanceId);
    const selection = sanitizeWorkspaceSelection(input.selection);
    await this.#requireNoActiveWork(input.projectId, input.environmentInstanceId);
    const validated = await this.#validate(input.projectId, input.environmentInstanceId, selection);
    const now = this.#clock();
    const reason = sanitizeOperatorText(input.reason, {
      fallback: DEFAULT_CHANGE_WORKSPACE_REASON,
      maxLength: 320,
    });
    const binding = this.#newBinding(validated, now);
    // Match the open binding by its invariant, never by object identity: a
    // durable store (SQLite) returns the current binding and its history entry
    // as distinct parsed objects, so reference equality would silently fail to
    // unbind the previous workspace and leave two open bindings.
    const history = access.history.map((entry) =>
      entry.unboundAt === undefined ? { ...entry, unboundAt: now, unboundReason: reason } : entry,
    );
    history.push(binding);
    const next: ProjectEnvironmentAccess = {
      ...access,
      updatedAt: now,
      current: binding,
      history,
    };
    await this.#persist(next);
    return next;
  }

  /**
   * End one active access non-destructively.
   *
   * Refused while active work depends on the binding. The relationship and its
   * whole binding history are retained; the current binding is marked unbound.
   * Sprout never deletes or exposes the old workspace's absolute location.
   */
  async end(input: EndAccessInput): Promise<ProjectEnvironmentAccess> {
    await this.#requireEditableProject(input.projectId);
    const access = await this.#requireActiveAccess(input.projectId, input.environmentInstanceId);
    await this.#requireNoActiveWork(input.projectId, input.environmentInstanceId);
    const now = this.#clock();
    const reason = sanitizeOperatorText(input.reason, {
      fallback: DEFAULT_END_ACCESS_REASON,
      maxLength: 320,
    });
    // As in `changeWorkspace`, unbind by the one-open-binding invariant rather
    // than by object identity, so ending access is correct over a durable store.
    const history = access.history.map((entry) =>
      entry.unboundAt === undefined ? { ...entry, unboundAt: now, unboundReason: reason } : entry,
    );
    const { current: _endedCurrent, ...rest } = access;
    const next: ProjectEnvironmentAccess = {
      ...rest,
      status: 'ended',
      endedAt: now,
      endedReason: reason,
      updatedAt: now,
      history,
    };
    await this.#persist(next);
    return next;
  }

  async #validate(
    projectId: string,
    environmentInstanceId: string,
    selection: WorkspaceSelection,
  ): Promise<ValidatedWorkspace> {
    let validated: ValidatedWorkspace;
    try {
      validated = await this.#worker.validate({ projectId, environmentInstanceId, selection });
    } catch (error) {
      throw new ProjectAccessError(
        'workspace-validation-failed',
        `the Environment Worker could not validate the selected Project workspace: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const workspaceId = sanitizeIdentifier(validated.workspaceId, {
      fallback: '',
      maxLength: 200,
      kind: 'digest',
    });
    if (workspaceId === '') {
      throw new ProjectAccessError(
        'workspace-validation-failed',
        'the Environment Worker returned no usable opaque workspace identity',
      );
    }
    const kind = validated.kind === 'relative' ? 'relative' : 'default';
    // A relative selection must come back with a safe relative location; the
    // Worker is authoritative, but the core never persists anything that looks
    // like an absolute host path.
    const path = kind === 'relative' ? sanitizeWorkspacePath(validated.path) : undefined;
    if (kind === 'relative' && path === undefined) {
      throw new ProjectAccessError(
        'workspace-validation-failed',
        'the Environment Worker returned an unsafe relative workspace location',
      );
    }
    return {
      workspaceId,
      kind,
      ...(path !== undefined ? { path } : {}),
    };
  }

  #newBinding(validated: ValidatedWorkspace, at: number): WorkspaceBinding {
    return {
      bindingId: this.#createBindingId(),
      workspaceId: validated.workspaceId,
      kind: validated.kind,
      ...(validated.path !== undefined ? { path: validated.path } : {}),
      boundAt: at,
    };
  }

  async #requireEditableProject(projectId: string): Promise<{ readonly id: string }> {
    const project = await this.#projects.get(projectId);
    if (project === undefined) {
      throw new ProjectAccessError('unknown-project', `unknown project: ${projectId}`);
    }
    if (project.status === 'archived') {
      throw new ProjectAccessError(
        'archived-project-is-read-only',
        `project ${projectId} is archived and read-only; restore it first`,
      );
    }
    return project;
  }

  async #requireAccessibleEnvironment(environmentInstanceId: string): Promise<void> {
    if (
      this.#environments === undefined ||
      !(await this.#environments.environmentIsAccessible(environmentInstanceId))
    ) {
      throw new ProjectAccessError(
        'environment-not-approved',
        `no approved Environment enrollment exists for ${environmentInstanceId}; enroll and approve it first`,
      );
    }
  }

  async #requireActiveAccess(
    projectId: string,
    environmentInstanceId: string,
  ): Promise<ProjectEnvironmentAccess> {
    const access = await this.#store.get(projectId, environmentInstanceId);
    if (access === undefined) {
      throw new ProjectAccessError(
        'unknown-environment-access',
        `project ${projectId} has no access to ${environmentInstanceId}`,
      );
    }
    if (access.status === 'ended') {
      throw new ProjectAccessError(
        'access-ended',
        `project ${projectId} access to ${environmentInstanceId} has ended`,
      );
    }
    return access;
  }

  async #requireNoActiveWork(projectId: string, environmentInstanceId: string): Promise<void> {
    if (
      this.#workSafety !== undefined &&
      (await this.#workSafety.hasActiveWorkOnEnvironment(projectId, environmentInstanceId))
    ) {
      throw new ProjectAccessError(
        'active-work-depends-on-binding',
        `project ${projectId} has active work on ${environmentInstanceId}; settle it before changing the workspace or ending access`,
      );
    }
  }

  async #persist(access: ProjectEnvironmentAccess): Promise<void> {
    // The invariant must hold before anything is durable: exactly one open
    // binding while active, none while ended.
    if (!accessIsConsistent(access)) {
      throw new ProjectAccessError(
        'workspace-validation-failed',
        `project ${access.projectId} access record would violate the one-current-binding invariant`,
      );
    }
    const all = (await this.#store.listForProject(access.projectId)).filter(
      (entry) => entry.environmentInstanceId !== access.environmentInstanceId,
    );
    const commit = await this.#bridge?.prepareAccess(access.projectId, [...all, access]);
    await this.#store.save(access);
    commit?.();
  }
}

export { ProjectAccessError } from './access.ts';
export { ProjectAuthorityError } from './authority-model.ts';
