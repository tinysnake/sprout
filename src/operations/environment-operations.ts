import { createHash, randomUUID } from 'node:crypto';
import type { RemoteWorkspaceOperationResult, RemoteWorkspaceTools } from '../engine/port.ts';
import type { ProjectAccessService } from '../project/access-service.ts';
import { accessIsConsistent, sanitizeWorkspaceSelection } from '../project/access.ts';
import type { ProjectService } from '../project/authority-service.ts';
import type { ProjectEnvironmentAccess, WorkspaceBinding } from '../project/access.ts';
import type { RuntimeEnvironment, WorkerGatewayView } from '../runtime.ts';
import type { EnvironmentCatalog } from '../environment/catalog.ts';
import type { EnvironmentEnrollmentService } from '../environment/enrollment-service.ts';
import type { RemoteOperationIdentityStore, RemoteOperationIdentity, RemoteOperationState } from './remote-operation-store.ts';
import type { AttachWorkspaceBindingParams, WorkspaceFileOperationParams, InspectWorkspaceFileOperationParams, CancelWorkspaceFileOperationParams } from '../worker/protocol.ts';

const MAX_SUPPORTED_READ_BYTES = 64 * 1024;
const MAX_SUPPORTED_SEARCH_RESULTS = 100;

export type RemoteWorkspaceBlock = 'project-denied' | 'access-ended' | 'workspace-unbound' | 'worker-offline' | 'stale-epoch' | 'unsupported' | 'capability-denied' | 'lease-required' | 'worker-refused';
export interface RemoteWorkspaceReadiness {
  readonly environmentInstanceId: string;
  readonly bindingId?: string;
  readonly generation?: number;
  readonly status: 'ready' | 'blocked';
  readonly reason?: RemoteWorkspaceBlock;
}

export class RemoteWorkspaceUnavailableError extends Error {
  readonly reason: RemoteWorkspaceBlock;
  constructor(reason: RemoteWorkspaceBlock) {
    super(`Remote Project workspace is blocked (${reason})`);
    this.name = 'RemoteWorkspaceUnavailableError';
    this.reason = reason;
  }
}

interface BindingCandidate {
  readonly access: ProjectEnvironmentAccess;
  readonly binding: WorkspaceBinding;
}

/**
 * Shared Runtime/Worker operation authority for Host-run Project files.
 * Engine adapters receive only typed callbacks; this module selects the target,
 * checks current Project and enrollment authority, and fences every call.
 */
type EnvironmentOperationsPort = Pick<RuntimeEnvironment,
  'info' | 'connectionEpoch' | 'attachWorkspaceBinding' | 'executeWorkspaceFileOperation' |
  'inspectWorkspaceFileOperation' | 'cancelWorkspaceFileOperation'>;
type EnvironmentOperationsGateway = Pick<WorkerGatewayView, 'liveFor' | 'currentConnectionEpoch' | 'isCurrentConnection'>;
type EnvironmentOperationsCatalog = Pick<EnvironmentCatalog, 'entry'>;
type EnvironmentOperationsEnrollments = Pick<EnvironmentEnrollmentService, 'get'>;

export class EnvironmentOperations {
  readonly #projects: Pick<ProjectService, 'get'>;
  readonly #access: Pick<ProjectAccessService, 'get' | 'listForProject'>;
  readonly #environment: Pick<RuntimeEnvironment,
    'info' | 'connectionEpoch' | 'attachWorkspaceBinding' | 'executeWorkspaceFileOperation' |
    'inspectWorkspaceFileOperation' | 'cancelWorkspaceFileOperation'>;
  readonly #gateway: Pick<WorkerGatewayView, 'liveFor' | 'currentConnectionEpoch' | 'isCurrentConnection'>;
  readonly #catalog: EnvironmentOperationsCatalog;
  readonly #enrollments: EnvironmentOperationsEnrollments;
  readonly #store: RemoteOperationIdentityStore;
  readonly #clock: () => number;

  constructor(options: {
    readonly projects: Pick<ProjectService, 'get'>;
    readonly access: Pick<ProjectAccessService, 'get' | 'listForProject'>;
    readonly environment: EnvironmentOperationsPort;
    readonly gateway: EnvironmentOperationsGateway;
    readonly catalog: EnvironmentOperationsCatalog;
    readonly enrollments: EnvironmentOperationsEnrollments;
    readonly store: RemoteOperationIdentityStore;
    readonly clock?: () => number;
  }) {
    this.#projects = options.projects;
    this.#access = options.access;
    this.#environment = options.environment;
    this.#gateway = options.gateway;
    this.#catalog = options.catalog;
    this.#enrollments = options.enrollments;
    this.#store = options.store;
    this.#clock = options.clock ?? Date.now;
  }

  async readiness(projectId: string, agentId: string): Promise<readonly RemoteWorkspaceReadiness[]> {
    const project = await this.#projects.get(projectId);
    if (!project || project.status !== 'active' || !hasAgent(project, agentId)) return [];
    const rows = await this.#access.listForProject(projectId);
    const result: RemoteWorkspaceReadiness[] = [];
    for (const access of rows) {
      const binding = access.current;
      const reason = await this.#blockReason(projectId, agentId, access, binding);
      result.push({ environmentInstanceId: access.environmentInstanceId,
        ...(binding ? { bindingId: binding.bindingId, ...(binding.generation !== undefined ? { generation: binding.generation } : {}) } : {}),
        status: reason ? 'blocked' : 'ready', ...(reason ? { reason } : {}) });
    }
    return result;
  }

  async attach(projectId: string, agentId: string): Promise<RemoteWorkspaceTools> {
    const project = await this.#projects.get(projectId);
    if (!project || project.status !== 'active' || !hasAgent(project, agentId)) throw new RemoteWorkspaceUnavailableError('project-denied');
    const accesses = (await this.#access.listForProject(projectId)).filter(a => a.status === 'active' && a.current)
      .sort((a, b) => a.environmentInstanceId.localeCompare(b.environmentInstanceId));
    let selected: BindingCandidate | undefined;
    let last: RemoteWorkspaceBlock = 'workspace-unbound';
    for (const access of accesses) {
      const binding = access.current;
      if (!binding) continue;
      const reason = await this.#blockReason(projectId, agentId, access, binding);
      if (reason) { last = reason; continue; }
      selected = { access, binding };
      break;
    }
    if (!selected) throw new RemoteWorkspaceUnavailableError(last);
    const { access, binding } = selected;
    const live = this.#gateway.liveFor(access.environmentInstanceId);
    const epoch = live?.epoch.epoch;
    if (!live || epoch === undefined || epoch !== this.#gateway.currentConnectionEpoch(live.enrollment.id) || !this.#gateway.isCurrentConnection(live.enrollment.id, live.epoch.connectionId)) {
      throw new RemoteWorkspaceUnavailableError('stale-epoch');
    }
    const identity: AttachWorkspaceBindingParams = {
      projectId,
      environmentInstanceId: access.environmentInstanceId,
      bindingId: binding.bindingId,
      generation: binding.generation!,
      connectionEpoch: epoch,
      workspaceId: binding.workspaceId,
      kind: binding.kind,
      ...(binding.path !== undefined ? { path: binding.path } : {}),
    };
    try {
      if (!this.#environment.attachWorkspaceBinding) throw new Error('unsupported');
      await this.#environment.attachWorkspaceBinding(access.environmentInstanceId, identity);
    } catch {
      throw new RemoteWorkspaceUnavailableError('worker-refused');
    }
    const fixed = { ...identity };
    const execute = async (operation: 'read' | 'search', path: string | undefined, query: string | undefined): Promise<RemoteWorkspaceOperationResult> => {
      await this.#assertCurrent(projectId, agentId, access.environmentInstanceId, fixed);
      const operationId = randomUUID();
      const fingerprint = createHash('sha256').update(JSON.stringify([fixed, operation, path ?? '', query ?? ''])).digest('hex');
      const row: RemoteOperationIdentity = { operationId, fingerprint, projectId, environmentInstanceId: access.environmentInstanceId,
        bindingId: binding.bindingId, generation: binding.generation!, connectionEpoch: epoch, workspaceId: binding.workspaceId,
        operation, state: 'running', updatedAt: this.#clock() };
      await this.#store.save(row);
      const request: WorkspaceFileOperationParams = { ...fixed, operationId, operation,
        ...(path !== undefined ? { path } : {}), ...(query !== undefined ? { query } : {}) };
      let result: RemoteWorkspaceOperationResult;
      try {
        if (!this.#environment.executeWorkspaceFileOperation) throw new Error('unsupported');
        result = await this.#environment.executeWorkspaceFileOperation(access.environmentInstanceId, request);
        await this.#assertCurrent(projectId, agentId, access.environmentInstanceId, fixed);
        if (!sameOrigin(result, fixed, operationId, operation)) throw new Error('remote operation identity mismatch');
      } catch {
        await this.#saveState(row, 'failed');
        return { operationId, projectId, environmentInstanceId: access.environmentInstanceId, bindingId: binding.bindingId,
          generation: binding.generation!, connectionEpoch: epoch, workspaceId: binding.workspaceId, operation, status: 'failed', failure: 'worker-unavailable' };
      }
      await this.#saveState(row, result.status === 'completed' ? 'completed' : result.status);
      return result;
    };
    return {
      binding: { projectId, environmentInstanceId: access.environmentInstanceId, bindingId: binding.bindingId,
        generation: binding.generation!, connectionEpoch: epoch, workspaceId: binding.workspaceId },
      read: path => execute('read', path, undefined),
      search: (query, path) => execute('search', path, query),
      inspect: async operationId => {
        await this.#assertCurrent(projectId, agentId, access.environmentInstanceId, fixed);
        const row = await this.#store.get(operationId);
        if (!row || row.projectId !== projectId || row.bindingId !== binding.bindingId || row.generation !== binding.generation || row.connectionEpoch !== epoch) return { status: 'not-found' };
        if (!this.#environment.inspectWorkspaceFileOperation) return { status: row.state };
        const request: InspectWorkspaceFileOperationParams = { ...fixed, operationId };
        const result = await this.#environment.inspectWorkspaceFileOperation(access.environmentInstanceId, request);
        return { status: result.status };
      },
      cancel: async operationId => {
        await this.#assertCurrent(projectId, agentId, access.environmentInstanceId, fixed);
        const row = await this.#store.get(operationId);
        if (!row || row.projectId !== projectId || row.bindingId !== binding.bindingId || row.generation !== binding.generation || row.connectionEpoch !== epoch || row.state !== 'running') return { accepted: false, status: row?.state ?? 'not-found' };
        if (!this.#environment.cancelWorkspaceFileOperation) return { accepted: false, status: 'unsupported' };
        const request: CancelWorkspaceFileOperationParams = { ...fixed, operationId };
        const result = await this.#environment.cancelWorkspaceFileOperation(access.environmentInstanceId, request);
        if (result.accepted) await this.#saveState(row, 'cancelled');
        return { accepted: result.accepted, status: result.status };
      },
    };
  }

  async #blockReason(projectId: string, agentId: string, access: ProjectEnvironmentAccess, binding: WorkspaceBinding | undefined): Promise<RemoteWorkspaceBlock | undefined> {
    const project = await this.#projects.get(projectId);
    if (!project || project.status !== 'active' || !hasAgent(project, agentId)) return 'project-denied';
    if (access.projectId !== projectId || access.environmentInstanceId === '' || !accessIsConsistent(access)) return 'workspace-unbound';
    if (access.status !== 'active') return 'access-ended';
    if (!binding || !Number.isSafeInteger(binding.generation) || binding.generation! < 1 ||
      typeof binding.workspaceId !== 'string' || binding.workspaceId.trim().length === 0) return 'workspace-unbound';
    try {
      const selection = sanitizeWorkspaceSelection({ kind: binding.kind, ...(binding.path !== undefined ? { path: binding.path } : {}) });
      if (selection.kind !== binding.kind || selection.path !== binding.path) return 'workspace-unbound';
    } catch {
      return 'workspace-unbound';
    }
    const current = access.history.find(row => row.bindingId === binding.bindingId && row.unboundAt === undefined);
    if (!current || current.generation !== binding.generation || current.workspaceId !== binding.workspaceId ||
      current.kind !== binding.kind || current.path !== binding.path) return 'workspace-unbound';
    const live = this.#gateway.liveFor(access.environmentInstanceId);
    if (!live || live.enrollment.status !== 'approved') return 'worker-offline';
    const enrollment = await this.#enrollments.get(live.enrollment.id);
    if (!enrollment || enrollment.environmentInstanceId !== access.environmentInstanceId || enrollment.status !== 'approved') return 'worker-offline';
    if (enrollment.capabilityPermissions['read-only-investigation'] !== true) return 'capability-denied';
    const epoch = live.epoch.epoch;
    if (epoch !== this.#gateway.currentConnectionEpoch(enrollment.id) || !this.#gateway.isCurrentConnection(enrollment.id, live.epoch.connectionId) || this.#environment.connectionEpoch?.(access.environmentInstanceId) !== epoch) return 'stale-epoch';
    const info = await this.#environment.info?.(access.environmentInstanceId);
    const operations = info?.workspaceOperations;
    if (!info || info.environmentInstanceId !== access.environmentInstanceId || operations?.version !== 1 ||
      !operations.operations.includes('read') || !operations.operations.includes('search') ||
      !Number.isSafeInteger(operations.maxReadBytes) || operations.maxReadBytes < 1 || operations.maxReadBytes > MAX_SUPPORTED_READ_BYTES ||
      !Number.isSafeInteger(operations.maxSearchResults) || operations.maxSearchResults < 1 || operations.maxSearchResults > MAX_SUPPORTED_SEARCH_RESULTS) return 'unsupported';
    const capability = this.#catalog.entry(access.environmentInstanceId)?.definition.capabilities.find(c => c.name === 'read-only-investigation');
    if (!capability) return 'unsupported';
    // Only this explicit catalog grant authorizes the read/search allowlist lease-free.
    // If the capability ever requires a lease, this Message activation has no lease authority.
    if (capability.requiresLease !== false) return 'lease-required';
    return undefined;
  }

  async #assertCurrent(projectId: string, agentId: string, environmentInstanceId: string, identity: AttachWorkspaceBindingParams): Promise<void> {
    const project = await this.#projects.get(projectId);
    if (!project || project.status !== 'active' || !hasAgent(project, agentId)) throw new RemoteWorkspaceUnavailableError('project-denied');
    const current = await this.#access.get(projectId, environmentInstanceId);
    if (!current || current.status !== 'active' || current.current?.bindingId !== identity.bindingId || current.current.generation !== identity.generation || current.current.workspaceId !== identity.workspaceId || current.current.kind !== identity.kind || current.current.path !== identity.path) throw new RemoteWorkspaceUnavailableError('access-ended');
    const live = this.#gateway.liveFor(environmentInstanceId);
    if (!live) throw new RemoteWorkspaceUnavailableError('worker-offline');
    const enrollment = await this.#enrollments.get(live.enrollment.id);
    if (!enrollment || enrollment.environmentInstanceId !== environmentInstanceId || enrollment.status !== 'approved') throw new RemoteWorkspaceUnavailableError('worker-offline');
    if (enrollment.capabilityPermissions['read-only-investigation'] !== true) throw new RemoteWorkspaceUnavailableError('capability-denied');
    if (live.epoch.epoch !== identity.connectionEpoch ||
      this.#gateway.currentConnectionEpoch(enrollment.id) !== identity.connectionEpoch ||
      !this.#gateway.isCurrentConnection(enrollment.id, live.epoch.connectionId) ||
      this.#environment.connectionEpoch?.(environmentInstanceId) !== identity.connectionEpoch) throw new RemoteWorkspaceUnavailableError('stale-epoch');
  }

  async #saveState(row: RemoteOperationIdentity, state: RemoteOperationState): Promise<void> {
    await this.#store.save({ ...row, state, updatedAt: this.#clock() });
  }
}

function hasAgent(project: Awaited<ReturnType<ProjectService['get']>> & {}, agentId: string): boolean {
  if (!project) return false;
  const version = project.content.versions.find(v => v.version === project.content.currentVersion);
  return version?.memberships.some(m => m.memberId === agentId && m.memberKind === 'agent' && m.endedAt === undefined) ?? false;
}
function sameOrigin(result: RemoteWorkspaceOperationResult, identity: AttachWorkspaceBindingParams, operationId: string, operation: 'read' | 'search'): boolean {
  return result.operationId === operationId && result.projectId === identity.projectId && result.environmentInstanceId === identity.environmentInstanceId &&
    result.bindingId === identity.bindingId && result.generation === identity.generation && result.connectionEpoch === identity.connectionEpoch &&
    result.workspaceId === identity.workspaceId && result.operation === operation;
}
