import { createHash, randomUUID } from 'node:crypto';
import type { RemoteWorkspaceOperationResult, RemoteWorkspaceTools, RemoteWorkspaceProgress } from '../engine/port.ts';
import type { ProjectAccessService } from '../project/access-service.ts';
import { accessIsConsistent, sanitizeWorkspaceSelection } from '../project/access.ts';
import type { ProjectService } from '../project/authority-service.ts';
import type { ProjectEnvironmentAccess, WorkspaceBinding } from '../project/access.ts';
import type { RuntimeEnvironment, WorkerGatewayView } from '../runtime.ts';
import type { EnvironmentPool } from '../environment/pool.ts';
import type { EnvironmentLease } from '../environment/pool.ts';
import type { EnvironmentCatalog } from '../environment/catalog.ts';
import type { EnvironmentEnrollmentService } from '../environment/enrollment-service.ts';
import type { RemoteOperationIdentityStore, RemoteOperationIdentity, RemoteOperationState } from './remote-operation-store.ts';
import type { AttachWorkspaceBindingParams, WorkspaceFileOperationParams, InspectWorkspaceFileOperationParams, CancelWorkspaceFileOperationParams } from '../worker/protocol.ts';

const MAX_SUPPORTED_READ_BYTES = 64 * 1024;
const MAX_SUPPORTED_SEARCH_RESULTS = 100;
const MUTATION_CAPABILITY = 'agent-run';

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
  readonly #pool: Pick<EnvironmentPool, 'requiresLeaseForBoundOperation' | 'acquireBoundOperationLeaseRevalidated' | 'extendLease' | 'markRecovering' | 'releaseLease'> | undefined;
  readonly #leaseTtlMs: number;

  constructor(options: {
    readonly projects: Pick<ProjectService, 'get'>;
    readonly access: Pick<ProjectAccessService, 'get' | 'listForProject'>;
    readonly environment: EnvironmentOperationsPort;
    readonly gateway: EnvironmentOperationsGateway;
    readonly catalog: EnvironmentOperationsCatalog;
    readonly enrollments: EnvironmentOperationsEnrollments;
    readonly store: RemoteOperationIdentityStore;
    readonly pool?: Pick<EnvironmentPool, 'requiresLeaseForBoundOperation' | 'acquireBoundOperationLeaseRevalidated' | 'extendLease' | 'markRecovering' | 'releaseLease'>;
    readonly leaseTtlMs?: number;
    readonly clock?: () => number;
  }) {
    this.#projects = options.projects;
    this.#access = options.access;
    this.#environment = options.environment;
    this.#gateway = options.gateway;
    this.#catalog = options.catalog;
    this.#enrollments = options.enrollments;
    this.#store = options.store;
    this.#pool = options.pool;
    this.#leaseTtlMs = options.leaseTtlMs ?? 900_000;
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

  async bindingReadiness(projectId: string): Promise<readonly RemoteWorkspaceReadiness[]> {
    const project = await this.#projects.get(projectId);
    if (!project || project.status !== 'active') return [];
    const rows = await this.#access.listForProject(projectId);
    const result: RemoteWorkspaceReadiness[] = [];
    for (const access of rows) {
      const binding = access.current;
      const reason = await this.#blockReason(projectId, undefined, access, binding);
      result.push({ environmentInstanceId: access.environmentInstanceId,
        ...(binding ? { bindingId: binding.bindingId, ...(binding.generation !== undefined ? { generation: binding.generation } : {}) } : {}),
        status: reason ? 'blocked' : 'ready', ...(reason ? { reason } : {}) });
    }
    return result;
  }

  async attach(projectId: string, agentId: string, runId?: string, onLeaseAcquired?: (leaseId: string) => Promise<void>): Promise<RemoteWorkspaceTools> {
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
    let mutationLease: EnvironmentLease | undefined;
    let leaseAcquisition: Promise<{ readonly acquired?: EnvironmentLease; readonly conflict?: { readonly holderId: string; readonly state: 'active' | 'recovering' }; readonly failure?: string }> | undefined;
    let pendingOperations = 0;
    let uncertainOutcome = false;
    let leaseCompromised = false;
    const uncertainOperationIds = new Set<string>();
    let leaseKeepalive: ReturnType<typeof setInterval> | undefined;

    const acquireMutationLease = async (): Promise<{ readonly acquired?: EnvironmentLease; readonly conflict?: { readonly holderId: string; readonly state: 'active' | 'recovering' }; readonly failure?: string }> => {
      if (runId === undefined) return { failure: 'run-required' };
      if (this.#pool === undefined) return { failure: 'lease-pool-unavailable' };
      if (this.#pool.requiresLeaseForBoundOperation(access.environmentInstanceId, MUTATION_CAPABILITY) !== true) return { failure: 'lease-capability-unavailable' };
      const prior = mutationLease;
      if (prior !== undefined) {
        const extended = this.#pool.extendLease(prior.id, this.#leaseTtlMs);
        if (extended === undefined) {
          uncertainOutcome = true;
          this.#pool.markRecovering(prior.id);
          return {};
        }
        mutationLease = extended;
        return { acquired: extended };
      }
      const result = await this.#pool.acquireBoundOperationLeaseRevalidated({
        instanceId: access.environmentInstanceId, capability: MUTATION_CAPABILITY,
        holderId: agentId, runId, ttlMs: this.#leaseTtlMs,
      });
      if (!result.ok) {
        return result.reason === 'conflict'
          ? { conflict: { holderId: result.heldBy ?? 'unknown-holder', state: result.state === 'recovering' ? 'recovering' : 'active' } }
          : { failure: `lease-${result.reason}` };
      }
      mutationLease = result.lease;
      try { await onLeaseAcquired?.(result.lease.id); }
      catch {
        this.#pool.markRecovering(result.lease.id);
        uncertainOutcome = true;
        return { failure: 'lease-reference-persistence-failed' };
      }
      const interval = Math.max(1_000, Math.floor(this.#leaseTtlMs / 3));
      leaseKeepalive = setInterval(() => {
        const active = mutationLease;
        if (!active) return;
        const extended = this.#pool?.extendLease(active.id, this.#leaseTtlMs);
        if (!extended) {
          uncertainOutcome = true;
          leaseCompromised = true;
          this.#pool?.markRecovering(active.id);
        } else mutationLease = extended;
      }, interval);
      leaseKeepalive.unref?.();
      return { acquired: result.lease };
    };

    const execute = async (operation: 'read' | 'search' | 'edit' | 'patch' | 'command', input: {
      readonly path?: string; readonly query?: string; readonly oldText?: string; readonly newText?: string;
      readonly hunks?: readonly { readonly before: string; readonly after: string }[];
      readonly executable?: string; readonly args?: readonly string[]; readonly cwd?: string; readonly timeoutMs?: number;
    }, requestedOperationId?: string, onProgress?: (progress: RemoteWorkspaceProgress) => void): Promise<RemoteWorkspaceOperationResult> => {
      const operationId = stableOperationId(runId, requestedOperationId);
      const normalized = normalizeOperationInput(operation, input);
      const fingerprint = createHash('sha256').update(JSON.stringify([fixed, operation, normalized])).digest('hex');
      const row: RemoteOperationIdentity = { operationId, fingerprint, projectId, environmentInstanceId: access.environmentInstanceId,
        bindingId: binding.bindingId, generation: binding.generation!, connectionEpoch: epoch, workspaceId: binding.workspaceId,
        operation, state: normalized.failure ? 'failed' : 'running', updatedAt: this.#clock() };
      const claimIdentity = async (): Promise<RemoteWorkspaceOperationResult | undefined> => {
        const claim = await this.#store.claim(row);
        if (claim === 'claimed') return undefined;
        return operationResult(fixed, operationId, operation, 'failed',
          claim === 'same-identity' ? 'operation-outcome-inspection-required' : 'operation-identity-conflict');
      };
      const prior = await this.#store.get(operationId);
      if (prior) {
        const failure = prior.fingerprint === fingerprint ? 'operation-outcome-inspection-required' : 'operation-identity-conflict';
        return operationResult(fixed, operationId, operation, 'failed', failure);
      }
      if (normalized.failure) {
        const duplicate = await claimIdentity();
        if (duplicate) return duplicate;
        await this.#store.save(row);
        return operationResult(fixed, operationId, operation, 'failed', normalized.failure);
      }
      const mutating = operation === 'edit' || operation === 'patch' || operation === 'command';
      if (mutating) {
        try {
          await this.#assertCurrent(projectId, agentId, access.environmentInstanceId, fixed, MUTATION_CAPABILITY);
        } catch {
          return operationResult(fixed, operationId, operation, 'failed', 'remote-operation-blocked');
        }
        const capability = this.#catalog.entry(access.environmentInstanceId)?.definition.capabilities.find(c => c.name === MUTATION_CAPABILITY);
        const info = await this.#environment.info?.(access.environmentInstanceId);
        const supported = operation === 'command'
          ? info?.workspaceOperations?.version === 3 && info.workspaceOperations.operations.includes('command')
          : info?.workspaceOperations?.version === 2 || info?.workspaceOperations?.version === 3
            ? info.workspaceOperations.operations.includes(operation)
            : false;
        if (!capability || capability.requiresLease !== true || !supported || runId === undefined || this.#pool === undefined) {
          return operationResult(fixed, operationId, operation, 'failed', 'lease-required');
        }
        if (leaseAcquisition === undefined) {
          leaseAcquisition = acquireMutationLease();
          void leaseAcquisition.finally(() => { leaseAcquisition = undefined; });
        }
        const lease = await leaseAcquisition;
        if (!lease.acquired) {
          return operationResult(fixed, operationId, operation, 'failed', lease.conflict ? 'lease-conflict' : (lease.failure ?? 'lease-unavailable'), lease.conflict);
        }
        try {
          await this.#assertCurrent(projectId, agentId, access.environmentInstanceId, fixed, MUTATION_CAPABILITY);
        } catch {
          uncertainOutcome = true;
          return operationResult(fixed, operationId, operation, 'failed', 'remote-operation-blocked');
        }
      } else {
        await this.#assertCurrent(projectId, agentId, access.environmentInstanceId, fixed);
      }

      const duplicate = await claimIdentity();
      if (duplicate) return duplicate;
      const { path: workspacePath, ...bindingIdentity } = fixed;
      const common = { ...bindingIdentity, ...(workspacePath !== undefined ? { workspacePath } : {}), operationId };
      const request: WorkspaceFileOperationParams = operation === 'read'
        ? { ...common, operation, path: normalized.path! }
        : operation === 'search'
          ? { ...common, operation, query: normalized.query!, ...(normalized.path !== undefined ? { path: normalized.path } : {}) }
          : operation === 'edit'
            ? { ...common, operation, path: normalized.path!, oldText: normalized.oldText!, newText: normalized.newText! }
            : { ...common, operation, path: normalized.path!, hunks: normalized.hunks! };
      let result: RemoteWorkspaceOperationResult;
      pendingOperations++;
      try {
        if (!this.#environment.executeWorkspaceFileOperation) throw new Error('unsupported');
        result = await this.#environment.executeWorkspaceFileOperation(access.environmentInstanceId, request);
        await this.#assertCurrent(projectId, agentId, access.environmentInstanceId, fixed, mutating ? MUTATION_CAPABILITY : 'read-only-investigation');
        if (!isBoundedRemoteResult(result, fixed, operationId, operation)) throw new Error('remote operation identity or bounds invalid');
      } catch {
        const state: RemoteOperationState = mutating ? 'unknown' : 'failed';
        if (mutating) {
          uncertainOutcome = true;
          uncertainOperationIds.add(operationId);
        }
        await this.#saveState(row, state);
        return operationResult(fixed, operationId, operation, 'failed', mutating ? 'outcome-unknown-inspect-required' : 'worker-unavailable');
      } finally {
        pendingOperations--;
      }
      await this.#saveState(row, result.status === 'completed' ? 'completed' : result.status);
      return result;
    };
    const remoteOperations: ('read' | 'search' | 'edit' | 'patch')[] = ['read', 'search'];
    const enrollment = await this.#enrollments.get(live.enrollment.id);
    const mutationCapability = this.#catalog.entry(access.environmentInstanceId)?.definition.capabilities.find(c => c.name === MUTATION_CAPABILITY);
    const operations = await this.#environment.info?.(access.environmentInstanceId);
    if (enrollment?.capabilityPermissions[MUTATION_CAPABILITY] === true && mutationCapability?.requiresLease === true &&
        operations?.workspaceOperations?.version === 2 && operations.workspaceOperations.operations.includes('edit') &&
        operations.workspaceOperations.operations.includes('patch')) remoteOperations.push('edit', 'patch');
    return {
      binding: { projectId, environmentInstanceId: access.environmentInstanceId, bindingId: binding.bindingId,
        generation: binding.generation!, connectionEpoch: epoch, workspaceId: binding.workspaceId },
      operations: remoteOperations,
      read: (path, operationId) => execute('read', { path }, operationId),
      search: (query, path, operationId) => execute('search', { query, ...(path !== undefined ? { path } : {}) }, operationId),
      edit: (path, oldText, newText, operationId) => execute('edit', { path, oldText, newText }, operationId),
      patch: (path, hunks, operationId) => execute('patch', { path, hunks }, operationId),
      settle: async outcome => {
        if (leaseKeepalive !== undefined) clearInterval(leaseKeepalive);
        if (mutationLease === undefined || this.#pool === undefined) return;
        if (outcome === 'unknown' || uncertainOutcome || pendingOperations > 0) this.#pool.markRecovering(mutationLease.id);
        else this.#pool.releaseLease(mutationLease.id);
      },
      inspect: async operationId => {
        await this.#assertCurrent(projectId, agentId, access.environmentInstanceId, fixed);
        const row = await this.#store.get(operationId);
        if (!row || row.projectId !== projectId || row.bindingId !== binding.bindingId || row.generation !== binding.generation || row.connectionEpoch !== epoch) return { status: 'not-found' };
        if (!this.#environment.inspectWorkspaceFileOperation) return { status: row.state };
        const request: InspectWorkspaceFileOperationParams = { ...fixed, operationId };
        const result = await this.#environment.inspectWorkspaceFileOperation(access.environmentInstanceId, request);
        if (result.status === 'not-found' && (row.state === 'running' || row.state === 'unknown' || row.state === 'cancel-requested')) {
          await this.#saveState(row, 'unknown');
          return { status: 'unknown' };
        }
        if ((row.operation === 'edit' || row.operation === 'patch') && isTerminalOperationState(result.status) && result.result === undefined) return { status: 'unknown' };
        if (result.result && (row.operation === 'command' ||
            result.result.status !== result.status ||
            !isBoundedRemoteResult(result.result, fixed, operationId, row.operation as 'read' | 'search' | 'edit' | 'patch'))) return { status: 'unknown' };
        if (isTerminalOperationState(result.status) && result.status !== row.state) await this.#saveState(row, result.status);
        if (isTerminalOperationState(result.status) && result.result && (row.operation === 'edit' || row.operation === 'patch')) {
          uncertainOperationIds.delete(operationId);
          uncertainOutcome = leaseCompromised || uncertainOperationIds.size > 0;
        }
        return { status: result.status, ...(result.result !== undefined ? { operation: result.result } : {}) };
      },
      cancel: async operationId => {
        await this.#assertCurrent(projectId, agentId, access.environmentInstanceId, fixed);
        const row = await this.#store.get(operationId);
        if (!row || row.projectId !== projectId || row.bindingId !== binding.bindingId || row.generation !== binding.generation || row.connectionEpoch !== epoch || row.state !== 'running') return { accepted: false, status: row?.state ?? 'not-found' };
        if (!this.#environment.cancelWorkspaceFileOperation) return { accepted: false, status: 'unsupported' };
        const request: CancelWorkspaceFileOperationParams = { ...fixed, operationId };
        const result = await this.#environment.cancelWorkspaceFileOperation(access.environmentInstanceId, request);
        if (result.accepted) await this.#saveState(row, 'cancel-requested');
        return { accepted: result.accepted, status: result.status };
      },
    };
  }

  async #blockReason(projectId: string, agentId: string | undefined, access: ProjectEnvironmentAccess, binding: WorkspaceBinding | undefined): Promise<RemoteWorkspaceBlock | undefined> {
    const project = await this.#projects.get(projectId);
    if (!project || project.status !== 'active' || (agentId !== undefined && !hasAgent(project, agentId))) return 'project-denied';
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
    const supportsRead = operations?.version === 1 || operations?.version === 2;
  if (!info || info.environmentInstanceId !== access.environmentInstanceId || !supportsRead ||
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

  async #assertCurrent(projectId: string, agentId: string, environmentInstanceId: string, identity: AttachWorkspaceBindingParams, capability = 'read-only-investigation'): Promise<void> {
    const project = await this.#projects.get(projectId);
    if (!project || project.status !== 'active' || !hasAgent(project, agentId)) throw new RemoteWorkspaceUnavailableError('project-denied');
    const current = await this.#access.get(projectId, environmentInstanceId);
    if (!current || current.status !== 'active' || current.current?.bindingId !== identity.bindingId || current.current.generation !== identity.generation || current.current.workspaceId !== identity.workspaceId || current.current.kind !== identity.kind || current.current.path !== identity.path) throw new RemoteWorkspaceUnavailableError('access-ended');
    const live = this.#gateway.liveFor(environmentInstanceId);
    if (!live) throw new RemoteWorkspaceUnavailableError('worker-offline');
    const enrollment = await this.#enrollments.get(live.enrollment.id);
    if (!enrollment || enrollment.environmentInstanceId !== environmentInstanceId || enrollment.status !== 'approved') throw new RemoteWorkspaceUnavailableError('worker-offline');
    if (enrollment.capabilityPermissions[capability] !== true) throw new RemoteWorkspaceUnavailableError('capability-denied');
    if (live.epoch.epoch !== identity.connectionEpoch ||
      this.#gateway.currentConnectionEpoch(enrollment.id) !== identity.connectionEpoch ||
      !this.#gateway.isCurrentConnection(enrollment.id, live.epoch.connectionId) ||
      this.#environment.connectionEpoch?.(environmentInstanceId) !== identity.connectionEpoch) throw new RemoteWorkspaceUnavailableError('stale-epoch');
  }

  async #saveState(row: RemoteOperationIdentity, state: RemoteOperationState): Promise<void> {
    await this.#store.save({ ...row, state, updatedAt: this.#clock() });
  }
}

function isTerminalOperationState(value: string): value is 'completed' | 'failed' | 'cancelled' {
  return value === 'completed' || value === 'failed' || value === 'cancelled';
}

function hasAgent(project: Awaited<ReturnType<ProjectService['get']>> & {}, agentId: string): boolean {
  if (!project) return false;
  const version = project.content.versions.find(v => v.version === project.content.currentVersion);
  return version?.memberships.some(m => m.memberId === agentId && m.memberKind === 'agent' && m.endedAt === undefined) ?? false;
}
function normalizeOperationInput(operation: 'read' | 'search' | 'edit' | 'patch', input: {
  readonly path?: string; readonly query?: string; readonly oldText?: string; readonly newText?: string;
  readonly hunks?: readonly { readonly before: string; readonly after: string }[];
}): { readonly path?: string; readonly query?: string; readonly oldText?: string; readonly newText?: string;
  readonly hunks?: readonly { readonly before: string; readonly after: string }[]; readonly failure?: string } {
  const path = input.path === undefined ? undefined : normalizeRelativePath(input.path);
  if (input.path !== undefined && (path === undefined || path.split('/')[0] === '.sprout')) return { failure: 'invalid-path' };
  if (operation !== 'search' && path === undefined) return { failure: 'invalid-path' };
  if (operation === 'search' && (typeof input.query !== 'string' || input.query.length < 1 || input.query.length > 256)) return { failure: 'invalid-path' };
  if (operation === 'edit' && (typeof input.oldText !== 'string' || input.oldText.length === 0 || typeof input.newText !== 'string' ||
      Buffer.byteLength(input.oldText, 'utf8') > 256 * 1024 || Buffer.byteLength(input.newText, 'utf8') > 256 * 1024)) return { failure: 'operation-limit' };
  if (operation === 'patch') {
    if (!Array.isArray(input.hunks) || input.hunks.length < 1 || input.hunks.length > 32) return { failure: 'operation-limit' };
    let bytes = 0;
    for (const hunk of input.hunks) {
      if (typeof hunk?.before !== 'string' || hunk.before.length === 0 || typeof hunk.after !== 'string') return { failure: 'invalid-patch' };
      bytes += Buffer.byteLength(hunk.before, 'utf8') + Buffer.byteLength(hunk.after, 'utf8');
      if (bytes > 256 * 1024) return { failure: 'operation-limit' };
    }
  }
  return { ...(path !== undefined ? { path } : {}), ...(input.query !== undefined ? { query: input.query } : {}),
    ...(input.oldText !== undefined ? { oldText: input.oldText } : {}), ...(input.newText !== undefined ? { newText: input.newText } : {}),
    ...(input.hunks !== undefined ? { hunks: input.hunks } : {}) };
}

function normalizeRelativePath(value: string): string | undefined {
  if (value.length > 1_024 || Buffer.byteLength(value, 'utf8') > 4_096) return undefined;
  const normalized = value.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) return undefined;
  return normalized;
}

function isBoundedRemoteResult(result: RemoteWorkspaceOperationResult, identity: AttachWorkspaceBindingParams, operationId: string, operation: 'read' | 'search' | 'edit' | 'patch'): boolean {
  if (!sameOrigin(result, identity, operationId, operation) ||
    !['completed', 'failed', 'cancelled'].includes(result.status) ||
    (result.truncated !== undefined && typeof result.truncated !== 'boolean')) return false;
  if (result.status !== 'completed') {
    return result.content === undefined && result.matches === undefined &&
      (result.path === undefined || normalizeRelativePath(result.path) === result.path) &&
      (result.failure === undefined || (typeof result.failure === 'string' && result.failure.length <= 64));
  }
  if (result.failure !== undefined) return false;
  if (operation === 'edit' || operation === 'patch') {
    return result.content === undefined && result.matches === undefined && typeof result.path === 'string' &&
      normalizeRelativePath(result.path) === result.path && result.changedPaths?.length === 1 && result.changedPaths[0] === result.path;
  }
  if (operation === 'read') {
    return typeof result.path === 'string' && normalizeRelativePath(result.path) === result.path &&
      typeof result.content === 'string' && Buffer.byteLength(result.content, 'utf8') <= MAX_SUPPORTED_READ_BYTES && result.matches === undefined;
  }
  if (result.content !== undefined || !Array.isArray(result.matches) || result.matches.length > MAX_SUPPORTED_SEARCH_RESULTS) return false;
  if (result.path !== undefined && normalizeRelativePath(result.path) !== result.path) return false;
  return result.matches.every(match => match !== null && typeof match === 'object' &&
    typeof match.path === 'string' && normalizeRelativePath(match.path) === match.path &&
    Number.isSafeInteger(match.line) && match.line > 0 && typeof match.text === 'string' && match.text.length <= 300 &&
    Buffer.byteLength(match.text, 'utf8') <= 1_200);
}

function stableOperationId(runId: string | undefined, requested: string | undefined): string {
  if (runId === undefined || requested === undefined || requested.length < 1 || requested.length > 512) return randomUUID();
  return createHash('sha256').update(`${runId}\\u0000${requested}`).digest('hex');
}

function operationResult(identity: AttachWorkspaceBindingParams, operationId: string, operation: 'read' | 'search' | 'edit' | 'patch', status: 'completed' | 'failed' | 'cancelled', failure?: string,
  leaseConflict?: { readonly holderId: string; readonly state: 'active' | 'recovering' }): RemoteWorkspaceOperationResult {
  return { operationId, projectId: identity.projectId, environmentInstanceId: identity.environmentInstanceId,
    bindingId: identity.bindingId, generation: identity.generation, connectionEpoch: identity.connectionEpoch,
    workspaceId: identity.workspaceId, operation, status, ...(failure !== undefined ? { failure } : {}),
    ...(leaseConflict !== undefined ? { leaseConflict } : {}) };
}

function sameOrigin(result: RemoteWorkspaceOperationResult, identity: AttachWorkspaceBindingParams, operationId: string, operation: 'read' | 'search' | 'edit' | 'patch'): boolean {
  return result.operationId === operationId && result.projectId === identity.projectId && result.environmentInstanceId === identity.environmentInstanceId &&
    result.bindingId === identity.bindingId && result.generation === identity.generation && result.connectionEpoch === identity.connectionEpoch &&
    result.workspaceId === identity.workspaceId && result.operation === operation;
}
