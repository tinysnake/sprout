/**
 * Project Environment access and Project workspace vocabulary (#93, ADR-0008).
 *
 * ADR-0008 makes adding an Environment instance to a Project the Human grant of
 * Project access, and the Project workspace the persistent working area of one
 * Project on one Environment instance. This Module owns that vocabulary and its
 * one validation rule set:
 *
 * - The **selection** a Human supplies is either the Worker-managed default or
 *   a relative location beneath the host-configured Worker workspace root. Both
 *   are portable: neither is an absolute host path.
 * - The **validated workspace** the Worker returns carries an opaque identity
 *   and, for a relative selection, a Worker-root-relative path. The absolute
 *   location stays on the host and never has a field here.
 * - The **binding** is the durable record of which validated workspace a Project
 *   used on one Environment. Bindings are append-only: a change appends a new
 *   current binding and unbinds the previous one. Nothing is ever moved,
 *   copied, or deleted.
 *
 * This Module is deliberately free of `node:*`: it is portable state shared by
 * the core authority, the Web wire contract, and the browser adapter.
 */


/** Which workspace a Human selected: the Worker default or a relative location. */
export type WorkspaceSelectionKind = 'default' | 'relative';

/** A portable workspace selection, before the Worker validates or prepares it. */
export interface WorkspaceSelection {
  readonly kind: WorkspaceSelectionKind;
  /** The relative location; present if and only if `kind` is `relative`. */
  readonly path?: string;
}

/**
 * The portable workspace facts the Worker returns after validating or
 * preparing a selection. The absolute location is deliberately absent.
 */
export interface ValidatedWorkspace {
  /** An opaque, host-derived identity. Never a path. */
  readonly workspaceId: string;
  readonly kind: WorkspaceSelectionKind;
  /** Worker-root-relative location, when the selection named one. */
  readonly path?: string;
}

/**
 * One durable Project workspace binding.
 *
 * `bindingId` identifies the binding itself so historical work can name the
 * binding it used even after a change; the opaque `workspaceId` identifies the
 * workspace the Worker validated. Neither is a host path.
 */
export interface WorkspaceBinding {
  readonly bindingId: string;
  readonly workspaceId: string;
  readonly kind: WorkspaceSelectionKind;
  /** Worker-root-relative location, when the workspace named one. */
  readonly path?: string;
  readonly boundAt: number;
  /** When this binding was superseded or its access ended, if it was. */
  readonly unboundAt?: number;
  /** The sanitized operator reason recorded when this binding was unbound. */
  readonly unboundReason?: string;
}

/**
 * One Project's access to one Environment instance, with its workspace history.
 *
 * Access ending is a status, never a delete: the record, its bindings, and its
 * history are retained. Each Project has at most one current binding per
 * Environment, which is the invariant `current` plus `history` expresses: at
 * most one binding has no `unboundAt`.
 */
export interface ProjectEnvironmentAccess {
  readonly projectId: string;
  readonly environmentInstanceId: string;
  readonly status: 'active' | 'ended';
  readonly startedAt: number;
  readonly updatedAt: number;
  /** When the access ended, if it did. */
  readonly endedAt?: number;
  /** The sanitized operator reason recorded when the access ended. */
  readonly endedReason?: string;
  /** The one current binding, present only while the access is active. */
  readonly current?: WorkspaceBinding;
  /** Every superseded binding, oldest first, including the current one. */
  readonly history: readonly WorkspaceBinding[];
}

export type ProjectAccessErrorCode =
  | 'unknown-project'
  | 'unknown-environment-access'
  | 'duplicate-environment-access'
  | 'invalid-workspace-selection'
  | 'workspace-validation-failed'
  | 'environment-not-approved'
  | 'access-ended'
  | 'archived-project-is-read-only'
  | 'active-work-depends-on-binding';

export class ProjectAccessError extends Error {
  readonly code: ProjectAccessErrorCode;

  constructor(code: ProjectAccessErrorCode, message: string) {
    super(message);
    this.name = 'ProjectAccessError';
    this.code = code;
  }
}

/** The fallback reason for an access end that sanitized to nothing usable. */
export const DEFAULT_END_ACCESS_REASON =
  'The Human ended this Project Environment access; its workspace bindings and history are preserved.';

/** The fallback reason for a workspace change that sanitized to nothing usable. */
export const DEFAULT_CHANGE_WORKSPACE_REASON =
  'The Project workspace was changed; the previous binding is retained for historical work.';

const MAX_PATH_LENGTH = 1_024;

/**
 * Validate and normalize a Worker-root-relative workspace location.
 *
 * A selection that is absolute, escapes its root, or cannot be normalized is
 * refused rather than reduced: the Worker is the authority on the real
 * filesystem, but the core must never persist something that looks like a host
 * path. Returns `undefined` for anything unsafe.
 */
export function sanitizeWorkspacePath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/\\/g, '/');
  if (normalized === '') return undefined;
  if (normalized.startsWith('/')) return undefined;
  if (/^[A-Za-z]:/.test(normalized)) return undefined;
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return undefined;
  }
  if (normalized.length > MAX_PATH_LENGTH) return undefined;
  return normalized;
}

/**
 * Validate a Human workspace selection.
 *
 * The default carries no location; a relative selection must normalize to a
 * safe Worker-root-relative path. Anything else is a refused selection, never a
 * silently corrected one.
 */
export function sanitizeWorkspaceSelection(selection: WorkspaceSelection): WorkspaceSelection {
  if (selection.kind === 'default') {
    return { kind: 'default' };
  }
  if (selection.kind !== 'relative') {
    throw new ProjectAccessError('invalid-workspace-selection', 'a workspace selection must be default or relative');
  }
  const path = sanitizeWorkspacePath(selection.path);
  if (path === undefined) {
    throw new ProjectAccessError(
      'invalid-workspace-selection',
      'a relative workspace selection must be a normalized path below the Worker workspace root',
    );
  }
  return { kind: 'relative', path };
}

/** The one current binding of an access record, when it has one. */
export function currentBinding(access: ProjectEnvironmentAccess): WorkspaceBinding | undefined {
  return access.current;
}

/** The one binding without an `unboundAt`, when the record is consistent. */
export function openBinding(access: ProjectEnvironmentAccess): WorkspaceBinding | undefined {
  return access.history.find((binding) => binding.unboundAt === undefined);
}

/** Whether one active access record's invariant holds. */
export function accessIsConsistent(access: ProjectEnvironmentAccess): boolean {
  const open = access.history.filter((binding) => binding.unboundAt === undefined);
  if (access.status === 'ended') return open.length === 0 && access.current === undefined;
  if (
    open.length !== 1 ||
    access.current === undefined ||
    access.current.unboundAt !== undefined
  ) {
    return false;
  }
  // The current binding must be the very binding history retains, so a caller
  // cannot observe a "current" workspace that historical work cannot name.
  return open[0]?.bindingId === access.current.bindingId;
}
