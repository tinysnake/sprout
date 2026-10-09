import { createHash, randomUUID } from 'node:crypto';
import type { BindingGenerationFence } from '../environment/binding-generation-fence.ts';
import type { RemoteWorkspaceOperationResult, RemoteWorkspaceTools, RemoteProjectMcpTools, RemoteWorkspaceProgress } from '../engine/port.ts';
import { RemoteProjectMcpStartupError } from '../engine/port.ts';
import type { ProjectAccessService } from '../project/access-service.ts';
import { accessIsConsistent, sanitizeWorkspaceSelection } from '../project/access.ts';
import { sanitizeIdentifier, sanitizeOperatorText } from '../environment/privacy.ts';
import type { ProjectService } from '../project/authority-service.ts';
import { PROJECT_MCP_CONFIGURATION_FORMAT } from '../project/authority-model.ts';
import type { ProjectEnvironmentAccess, WorkspaceBinding } from '../project/access.ts';
import type { RuntimeEnvironment, WorkerGatewayView } from '../runtime.ts';
import type { EnvironmentPool } from '../environment/pool.ts';
import type { EnvironmentLease } from '../environment/pool.ts';
import { EMPTY_REMOTE_WORK_RECOVERY_EVIDENCE, type RemoteWorkRecoveryEvidence } from '../environment/recovery.ts';
import type { EnvironmentCatalog } from '../environment/catalog.ts';
import type { EnvironmentEnrollmentService } from '../environment/enrollment-service.ts';
import type { RemoteOperationIdentityStore, RemoteOperationIdentity, RemoteOperationState, RemoteMcpProcessIdentity, RemoteMcpOperationIdentity } from './remote-operation-store.ts';
import type { AttachWorkspaceBindingParams, ProjectMcpLeaseIdentity, WorkspaceFileOperationParams, InspectWorkspaceFileOperationParams, CancelWorkspaceFileOperationParams, InspectProjectMcpConfigurationResult, StartProjectMcpParams, CallProjectMcpToolParams, StopProjectMcpParams, StartProjectMcpResult, CallProjectMcpToolResult, RunContextParams } from '../worker/protocol.ts';

const MAX_SUPPORTED_READ_BYTES = 64 * 1024;
const MAX_SUPPORTED_SEARCH_RESULTS = 100;
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024;
const MUTATION_CAPABILITY = 'agent-run';

export type RemoteWorkspaceBlock = 'project-denied' | 'access-ended' | 'workspace-unbound' | 'worker-offline' | 'stale-epoch' | 'stale-generation' | 'unsupported' | 'capability-denied' | 'lease-required' | 'worker-refused';
export interface ProjectMcpLeaseScope extends ProjectMcpLeaseIdentity {
  readonly environmentInstanceId: string;
  readonly bindingFence?: BindingGenerationFence;
  /** The containing run lease or existing Task lease; MCP never acquires a second Task lease. */
  readonly leaseCapability: 'project-mcp' | 'agent-run';
}

export interface WorkspaceContainingLease extends ProjectMcpLeaseScope {
  /** The containing owner permits release only after every other surface has settled. */
  readonly canRelease: () => boolean;
}

export interface RemoteWorkspaceReadiness {
  readonly environmentInstanceId: string;
  readonly bindingId?: string;
  readonly generation?: number;
  readonly status: 'ready' | 'blocked';
  readonly reason?: RemoteWorkspaceBlock;
}

export interface ProjectMcpInspection {
  readonly environmentInstanceId: string;
  readonly bindingId?: string;
  readonly generation?: number;
  readonly status: 'not-selected' | 'blocked' | 'valid' | 'missing' | 'invalid' | 'unsupported';
  readonly reason?: RemoteWorkspaceBlock;
  readonly servers: InspectProjectMcpConfigurationResult['servers'];
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
  'inspectProjectMcpConfiguration' | 'startProjectMcp' | 'callProjectMcpTool' | 'stopProjectMcp' |
  'inspectWorkspaceFileOperation' | 'cancelWorkspaceFileOperation' | 'prepareRunContext' | 'recycleRunContext' | 'inspectRunContext'>;
type EnvironmentOperationsGateway = Pick<WorkerGatewayView, 'liveFor' | 'currentConnectionEpoch' | 'isCurrentConnection'>;
type EnvironmentOperationsCatalog = Pick<EnvironmentCatalog, 'entry'>;
type EnvironmentOperationsEnrollments = Pick<EnvironmentEnrollmentService, 'get'>;

export class EnvironmentOperations {
  readonly #projects: Pick<ProjectService, 'get'>;
  readonly #access: Pick<ProjectAccessService, 'get' | 'listForProject'>;
  readonly #environment: Pick<RuntimeEnvironment,
    'info' | 'connectionEpoch' | 'attachWorkspaceBinding' | 'executeWorkspaceFileOperation' |
    'inspectProjectMcpConfiguration' | 'startProjectMcp' | 'callProjectMcpTool' | 'stopProjectMcp' |
    'inspectWorkspaceFileOperation' | 'cancelWorkspaceFileOperation' | 'prepareRunContext' | 'recycleRunContext' | 'inspectRunContext'>;
  readonly #gateway: Pick<WorkerGatewayView, 'liveFor' | 'currentConnectionEpoch' | 'isCurrentConnection'>;
  readonly #catalog: EnvironmentOperationsCatalog;
  readonly #enrollments: EnvironmentOperationsEnrollments;
  readonly #store: RemoteOperationIdentityStore;
  readonly #onUncertainMcp: ((scope: ProjectMcpLeaseScope) => Promise<void>) | undefined;
  readonly #onUncertainOperation: ((leaseId: string) => Promise<void>) | undefined;
  readonly #clock: () => number;
  readonly #pool: Pick<EnvironmentPool, 'getLease' | 'requiresLeaseForBoundOperation' | 'acquireBoundOperationLeaseRevalidated' | 'extendLease' | 'keepLeaseUntilCleanup' | 'markRecovering' | 'releaseLease'> | undefined;
  readonly #leaseTtlMs: number;

  constructor(options: {
    readonly projects: Pick<ProjectService, 'get'>;
    readonly access: Pick<ProjectAccessService, 'get' | 'listForProject'>;
    readonly environment: EnvironmentOperationsPort;
    readonly gateway: EnvironmentOperationsGateway;
    readonly catalog: EnvironmentOperationsCatalog;
    readonly enrollments: EnvironmentOperationsEnrollments;
    readonly pool?: Pick<EnvironmentPool, 'getLease' | 'requiresLeaseForBoundOperation' | 'acquireBoundOperationLeaseRevalidated' | 'extendLease' | 'keepLeaseUntilCleanup' | 'markRecovering' | 'releaseLease'>;
    readonly store: RemoteOperationIdentityStore;
    readonly onUncertainMcp?: (scope: ProjectMcpLeaseScope) => Promise<void>;
    readonly onUncertainOperation?: (leaseId: string) => Promise<void>;
    readonly leaseTtlMs?: number;
    readonly clock?: () => number;
  }) {
    this.#projects = options.projects;
    this.#access = options.access;
    this.#environment = options.environment;
    this.#gateway = options.gateway;
    this.#catalog = options.catalog;
    this.#enrollments = options.enrollments;
    this.#pool = options.pool;
    this.#store = options.store;
    this.#onUncertainMcp = options.onUncertainMcp;
    this.#onUncertainOperation = options.onUncertainOperation;
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

  async inspectMcpConfiguration(projectId: string, environmentInstanceId: string): Promise<ProjectMcpInspection> {
    const project = await this.#projects.get(projectId);
    if (!project || project.status !== 'active') return { environmentInstanceId, status: 'blocked', reason: 'project-denied', servers: [] };
    const currentContent = project.content.versions.find(version => version.version === project.content.currentVersion);
    const configuration = currentContent?.mcpConfiguration;
    if (!configuration) return { environmentInstanceId, status: 'not-selected', servers: [] };
    const access = await this.#access.get(projectId, environmentInstanceId);
    if (!access) return { environmentInstanceId, status: 'blocked', reason: 'workspace-unbound', servers: [] };
    const binding = access.current;
    const reason = await this.#blockReason(projectId, undefined, access, binding);
    if (reason) return { environmentInstanceId, status: 'blocked', reason, servers: [] };
    if (!binding) return { environmentInstanceId, status: 'blocked', reason: 'workspace-unbound', servers: [] };
    const live = this.#gateway.liveFor(environmentInstanceId);
    const epoch = live?.epoch.epoch;
    if (!live || epoch === undefined) return { environmentInstanceId, status: 'blocked', reason: 'worker-offline', servers: [] };
    const identity: AttachWorkspaceBindingParams = {
      projectId, environmentInstanceId, bindingId: binding.bindingId, generation: binding.generation!,
      connectionEpoch: epoch, workspaceId: binding.workspaceId, kind: binding.kind,
      ...(binding.path !== undefined ? { path: binding.path } : {}),
    };
    try {
      const info = await this.#environment.info?.(environmentInstanceId);
      if (!info?.workspaceOperations?.operations.includes('inspect-mcp-configuration') || !this.#environment.inspectProjectMcpConfiguration) {
        return { environmentInstanceId, bindingId: binding.bindingId, generation: binding.generation!, status: 'blocked', reason: 'unsupported', servers: [] };
      }
      await this.#environment.attachWorkspaceBinding?.(environmentInstanceId, identity);
      await this.#assertCurrent(projectId, undefined, environmentInstanceId, identity);
      const result = await this.#environment.inspectProjectMcpConfiguration(environmentInstanceId, {
        ...identity, format: configuration.format,
      });
      await this.#assertCurrent(projectId, undefined, environmentInstanceId, identity);
      const sanitized = sanitizeMcpInspection(result);
      if (!sanitized) throw new Error('invalid MCP inspection result');
      return { environmentInstanceId, bindingId: binding.bindingId, generation: binding.generation!, ...sanitized };
    } catch {
      return { environmentInstanceId, bindingId: binding.bindingId, generation: binding.generation!, status: 'blocked', reason: 'worker-refused', servers: [] };
    }
  }

  async remoteWorkEvidenceForLease(leaseId: string): Promise<RemoteWorkRecoveryEvidence> {
    const lease = this.#pool?.getLease(leaseId);
    if (lease === undefined) return EMPTY_REMOTE_WORK_RECOVERY_EVIDENCE;
    const [workspace, mcpOperations, mcpProcesses] = await Promise.all([
      this.#store.listOpenOperations(lease.instanceId),
      this.#store.listOpenMcpOperations(lease.instanceId),
      this.#store.listOpenMcpProcesses(lease.instanceId),
    ]);
    const rows = workspace.filter(row => row.leaseId === leaseId);
    const mcpCalls = mcpOperations.filter(row => row.leaseId === leaseId);
    const processes = mcpProcesses.filter(row => row.leaseId === leaseId);
    return {
      journalAvailable: true,
      workspaceOperations: {
        running: rows.filter(row => row.state === 'running').length,
        unknown: rows.filter(row => row.state === 'unknown').length,
        cancelRequested: rows.filter(row => row.state === 'cancel-requested').length,
        recoveryRequired: rows.filter(row => row.state === 'recovery-required').length,
      },
      projectMcpOperations: {
        running: mcpCalls.filter(row => row.state === 'running').length,
        uncertain: mcpCalls.filter(row => row.state === 'uncertain').length,
      },
      projectMcpProcesses: {
        starting: processes.filter(row => row.state === 'starting').length,
        running: processes.filter(row => row.state === 'running').length,
        stopping: processes.filter(row => row.state === 'stopping').length,
        uncertain: processes.filter(row => row.state === 'uncertain').length,
      },
    };
  }

  async reconcileRemoteOperations(environmentInstanceId: string): Promise<void> {
    await this.reconcileProjectMcpProcesses(environmentInstanceId);
    await this.#reconcileProjectMcpOperations(environmentInstanceId);
    await this.#reconcileRemoteWorkspaceOperations(environmentInstanceId);
  }

  async #reconcileProjectMcpOperations(environmentInstanceId: string): Promise<void> {
    const rows = await this.#store.listOpenMcpOperations(environmentInstanceId);
    const live = this.#gateway.liveFor(environmentInstanceId);
    const activeLeases = new Map<string, ProjectMcpLeaseScope>();
    for (const row of rows) {
      const scope: ProjectMcpLeaseScope = {
        environmentInstanceId, leaseId: row.leaseId, holderKind: row.holderKind, holderId: row.holderId,
        runId: row.runId, ...(row.taskId !== undefined ? { taskId: row.taskId } : {}),
        leaseCapability: row.holderKind === 'task' ? 'agent-run' : 'project-mcp',
      };
      const lease = this.#pool?.getLease(row.leaseId);
      if (sameMcpLease(lease, scope) && lease?.state === 'active' && row.state === 'running' && live !== undefined &&
          row.connectionEpoch === live.epoch.epoch && row.enrollmentId === live.enrollment.id &&
          row.workerIdentityDigest === live.enrollment.worker.identityDigest) continue;
      if (!sameMcpLease(lease, scope) || (lease?.state !== 'active' && lease?.state !== 'recovering')) continue;
      if (lease.state === 'active') {
        this.#pool?.markRecovering(row.leaseId);
        activeLeases.set(row.leaseId, scope);
      }
      if (row.state === 'running') await this.#store.saveMcpOperation({ ...row, state: 'uncertain', updatedAt: this.#clock() });
    }
    for (const scope of activeLeases.values()) await this.#noteUncertainMcp(scope);
  }

  async #reconcileRemoteWorkspaceOperations(environmentInstanceId: string): Promise<void> {
    const rows = await this.#store.listOpenOperations(environmentInstanceId);
    const live = this.#gateway.liveFor(environmentInstanceId);
    const reconcilableRows = rows.filter(row => {
      if (row.leaseId === undefined) return true;
      const lease = this.#pool?.getLease(row.leaseId);
      return !(live !== undefined && lease?.state === 'active' && sameOperationLease(lease, row) &&
        row.connectionEpoch === live.epoch.epoch && row.enrollmentId === live.enrollment.id &&
        row.workerIdentityDigest === live.enrollment.worker.identityDigest);
    });
    const affectedLeases = new Set<string>();
    for (const row of reconcilableRows) {
      if (row.leaseId === undefined || row.holderKind === undefined || row.holderId === undefined || row.runId === undefined) continue;
      const lease = this.#pool?.getLease(row.leaseId);
      if (!sameOperationLease(lease, row)) continue;
      this.#pool?.markRecovering(row.leaseId);
      affectedLeases.add(row.leaseId);
    }
    for (const leaseId of affectedLeases) {
      try { await this.#onUncertainOperation?.(leaseId); } catch { /* The recovering pool row remains the admission fence. */ }
    }
    if (!live) return;
    for (const row of reconcilableRows) {
      if (row.leaseId === undefined || row.agentId === undefined || row.enrollmentId !== live.enrollment.id ||
          row.workerIdentityDigest !== live.enrollment.worker.identityDigest || row.kind === undefined) continue;
      const lease = this.#pool?.getLease(row.leaseId);
      if (!sameOperationLease(lease, row)) continue;
      const identity: AttachWorkspaceBindingParams = {
        projectId: row.projectId, environmentInstanceId: row.environmentInstanceId,
        bindingId: row.bindingId, generation: row.generation, connectionEpoch: live.epoch.epoch,
        workspaceId: row.workspaceId, kind: row.kind, ...(row.path !== undefined ? { path: row.path } : {}),
      };
      const originalIdentity: AttachWorkspaceBindingParams = { ...identity, connectionEpoch: row.connectionEpoch };
      try {
        await this.#assertCurrent(row.projectId, row.agentId, environmentInstanceId, identity,
          row.operation === 'read' || row.operation === 'search' ? 'read-only-investigation' : MUTATION_CAPABILITY);
        await this.#environment.attachWorkspaceBinding?.(environmentInstanceId, identity);
        if (!this.#environment.inspectWorkspaceFileOperation) continue;
        const inspected = await this.#environment.inspectWorkspaceFileOperation(environmentInstanceId, { ...identity, operationId: row.operationId });
        if (inspected.status === 'completed' || inspected.status === 'failed' || inspected.status === 'cancelled') {
          const validResult = inspected.result !== undefined && inspected.result.status === inspected.status &&
            isBoundedRemoteResult(inspected.result, originalIdentity, row.operationId, row.operation);
          if (!validResult) {
            await this.#store.save({ ...row, state: 'unknown', updatedAt: this.#clock() });
            continue;
          }
          await this.#store.save({ ...row, state: inspected.status, updatedAt: this.#clock() });
        } else if (row.state === 'running' || row.state === 'cancel-requested') {
          await this.#store.save({ ...row, state: 'unknown', updatedAt: this.#clock() });
        }
      } catch {
        // A lost Worker channel or stale authority is not evidence about the remote outcome.
      }
    }
  }

  async reconcileProjectMcpProcesses(environmentInstanceId: string): Promise<void> {
    const rows = await this.#store.listOpenMcpProcesses(environmentInstanceId);
    const live = this.#gateway.liveFor(environmentInstanceId);
    const liveEpoch = live?.epoch.epoch;
    for (const row of rows) {
      const lease = this.#pool?.getLease(row.leaseId);
      const leaseCapability = row.holderKind === 'task' ? 'agent-run' : 'project-mcp';
      const scope: ProjectMcpLeaseScope = {
        environmentInstanceId, leaseId: row.leaseId, holderKind: row.holderKind, holderId: row.holderId,
        runId: row.runId, ...(row.taskId !== undefined ? { taskId: row.taskId } : {}), leaseCapability,
      };
      if (!sameMcpLease(lease, scope) || (lease?.state !== 'active' && lease?.state !== 'recovering') ||
          row.enrollmentId === undefined || row.workerIdentityDigest === undefined ||
          live?.enrollment.id !== row.enrollmentId || live.enrollment.worker.identityDigest !== row.workerIdentityDigest) {
        await this.#store.saveMcpProcess({ ...row, state: 'uncertain', updatedAt: this.#clock() }).catch(() => undefined);
        if (lease?.state === 'active' && sameMcpLease(lease, scope)) await this.#noteUncertainMcp(scope);
        continue;
      }
      if ((row.state === 'starting' || row.state === 'running') && lease.state === 'active' && liveEpoch === row.connectionEpoch) continue;
      if (lease.state === 'active') await this.#noteUncertainMcp(scope);
      const identity: AttachWorkspaceBindingParams = {
        projectId: row.projectId, environmentInstanceId: row.environmentInstanceId, bindingId: row.bindingId,
        generation: row.generation, connectionEpoch: liveEpoch ?? row.connectionEpoch, workspaceId: row.workspaceId,
        kind: row.kind, ...(row.path !== undefined ? { path: row.path } : {}),
      };
      try {
        let stopIdentity = identity;
        if (liveEpoch !== row.connectionEpoch) {
          const access = await this.#access.get(row.projectId, environmentInstanceId);
          const binding = access?.current;
          if (!access || access.status !== 'active' || !binding || !validProjectBinding(access, binding)) throw new Error('MCP process binding is no longer current');
          const currentIdentity: AttachWorkspaceBindingParams = {
            projectId: row.projectId, environmentInstanceId, bindingId: binding.bindingId!, generation: binding.generation!,
            connectionEpoch: liveEpoch!, workspaceId: binding.workspaceId, kind: binding.kind,
            ...(binding.path !== undefined ? { path: binding.path } : {}),
          };
          if (!sameMcpBindingExceptEpoch(currentIdentity, identity)) throw new Error('MCP process binding changed');
          if (!this.#environment.attachWorkspaceBinding) throw new Error('MCP process binding cannot be attached');
          await this.#environment.attachWorkspaceBinding(environmentInstanceId, currentIdentity);
          stopIdentity = currentIdentity;
        }
        const stopped = await this.#environment.stopProjectMcp?.(environmentInstanceId, {
          ...stopIdentity, ...projectMcpLeaseIdentity(scope), processId: row.processId,
        });
        if (stopped?.processId === row.processId && (stopped.status === 'stopped' || (stopped.status === 'not-found' && liveEpoch === row.connectionEpoch))) {
          await this.#store.saveMcpProcess({ ...row, state: 'stopped', updatedAt: this.#clock() });
          continue;
        }
      } catch { /* Persist uncertainty below and keep the lease protected. */ }
      await this.#store.saveMcpProcess({ ...row, state: 'uncertain', updatedAt: this.#clock() }).catch(() => undefined);
    }
  }

  async attachProjectMcpTools(
    projectId: string,
    agentId: string,
    scope: ProjectMcpLeaseScope,
  ): Promise<RemoteProjectMcpTools> {
    const authority = await this.#assertProjectMcpAuthority(projectId, agentId, scope, false);
    if (!this.#environment.attachWorkspaceBinding || !this.#environment.startProjectMcp) throw new RemoteWorkspaceUnavailableError('unsupported');
    await this.#environment.attachWorkspaceBinding(scope.environmentInstanceId, authority.identity);
    const leaseIdentity = projectMcpLeaseIdentity(scope);
    const processId = randomUUID();
    const fingerprint = createHash('sha256').update(JSON.stringify([authority.identity, leaseIdentity, processId])).digest('hex');
    const live = this.#gateway.liveFor(scope.environmentInstanceId);
    let processRow: RemoteMcpProcessIdentity = {
      ...authority.identity, ...leaseIdentity, agentId, fingerprint, processId, state: 'starting',
      ...(live !== undefined ? { enrollmentId: live.enrollment.id, workerIdentityDigest: live.enrollment.worker.identityDigest } : {}),
      updatedAt: this.#clock(),
    };
    try { await this.#store.saveMcpProcess(processRow); }
    catch { throw new RemoteWorkspaceUnavailableError('worker-refused'); }
    const startInput: StartProjectMcpParams = {
      ...authority.identity, ...leaseIdentity, processId, format: authority.format,
    };
    let started: StartProjectMcpResult;
    try { started = await this.#environment.startProjectMcp(scope.environmentInstanceId, startInput); }
    catch {
      processRow = { ...processRow, state: 'uncertain', updatedAt: this.#clock() };
      await this.#store.saveMcpProcess(processRow).catch(() => undefined);
      await this.#noteUncertainMcp(scope);
      throw new RemoteWorkspaceUnavailableError('worker-refused');
    }
    const catalog = safeMcpToolCatalog(started);
    if (started.processId !== processId || !catalog) {
      const stopped = await this.#stopMcpProcess(authority.identity, scope, processRow, processId);
      if (stopped !== 'stopped') await this.#noteUncertainMcp(scope);
      throw new RemoteProjectMcpStartupError('worker-refused');
    }
    if (started.status !== 'ready' || catalog.tools.length === 0) {
      const stopped = await this.#stopMcpProcess(authority.identity, scope, processRow, processId);
      if (stopped !== 'stopped') await this.#noteUncertainMcp(scope);
      throw new RemoteProjectMcpStartupError(mcpStartupFailureReason(started, catalog.tools.length));
    }
    processRow = { ...processRow, state: 'running', updatedAt: this.#clock() };
    try { await this.#store.saveMcpProcess(processRow); }
    catch {
      const stopped = await this.#stopMcpProcess(authority.identity, scope, processRow, processId);
      if (stopped !== 'stopped') await this.#noteUncertainMcp(scope);
      throw new RemoteWorkspaceUnavailableError('worker-refused');
    }
    const toolOrigins = new Map(catalog.tools.map(row => [row.public.name, { workerId: row.workerId, schema: row.public.inputSchema }]));
    let processClosed = false;
    let closeInFlight: Promise<'stopped' | 'uncertain'> | undefined;
    const closeProcess = async (): Promise<'stopped' | 'uncertain'> => {
      if (processClosed) return 'stopped';
      if (closeInFlight) return closeInFlight;
      closeInFlight = (async () => {
        let certain = false;
        if (processRow) {
          try { await this.#store.saveMcpProcess({ ...processRow, state: 'stopping', updatedAt: this.#clock() }); }
          catch { /* Stop still proceeds; an unresolved durable row protects recovery. */ }
        }
        try {
          const currentLease = this.#pool?.getLease(scope.leaseId);
          if (!sameMcpLease(currentLease, scope)) throw new Error('MCP lease identity changed');
          const stopInput: StopProjectMcpParams = { ...authority.identity, ...leaseIdentity, processId: processId! };
          const stopped = await this.#environment.stopProjectMcp?.(scope.environmentInstanceId, stopInput);
          const stopEpoch = this.#gateway.liveFor(scope.environmentInstanceId)?.epoch.epoch;
          const sameWorkerEpoch = stopEpoch === authority.identity.connectionEpoch;
          certain = stopped !== undefined && stopped.processId === processId &&
            (stopped.status === 'stopped' || (stopped.status === 'not-found' && sameWorkerEpoch));
        } catch { certain = false; }
        if (certain) {
          try {
            if (processRow) await this.#store.saveMcpProcess({ ...processRow, state: 'stopped', updatedAt: this.#clock() });
            processClosed = true;
            return 'stopped';
          } catch { /* Process stopped, but the durable identity remains unresolved. */ }
        }
        if (processRow) await this.#store.saveMcpProcess({ ...processRow, state: 'uncertain', updatedAt: this.#clock() }).catch(() => undefined);
        await this.#noteUncertainMcp(scope);
        return 'uncertain';
      })();
      const outcome = await closeInFlight;
      closeInFlight = undefined;
      return outcome;
    };
    const mcpGrantIsCurrent = (): boolean => scope.bindingFence === undefined || scope.bindingFence.isCurrent();
    return {
      binding: {
        projectId, environmentInstanceId: scope.environmentInstanceId,
        bindingId: authority.identity.bindingId, generation: authority.identity.generation,
        connectionEpoch: authority.identity.connectionEpoch, workspaceId: authority.identity.workspaceId,
        kind: authority.identity.kind, ...(authority.identity.path !== undefined ? { path: authority.identity.path } : {}),
      },
      ...(scope.bindingFence !== undefined ? { bindingFence: scope.bindingFence } : {}),
      tools: catalog.tools.map(row => row.public),
      call: async (name, arguments_) => {
        if (processClosed || !processId || !processRow) return { status: 'failed', reason: 'worker-refused' };
        if (!mcpGrantIsCurrent()) return { status: 'failed', reason: 'worker-refused' };
        const origin = toolOrigins.get(name);
        if (!origin || !isRecord(arguments_)) return { status: 'failed', reason: 'unknown-tool' };
        if (!validMcpArguments(origin.schema, arguments_)) return { status: 'failed', reason: 'invalid-arguments' };
        let current: { readonly identity: AttachWorkspaceBindingParams; readonly format: typeof PROJECT_MCP_CONFIGURATION_FORMAT };
        try { current = await this.#assertProjectMcpAuthority(projectId, agentId, scope, false); }
        catch {
          await closeProcess();
          return { status: 'failed', reason: 'worker-refused' };
        }
        if (!sameMcpBinding(current.identity, authority.identity)) {
          await closeProcess();
          return { status: 'failed', reason: 'worker-refused' };
        }
        const operationId = randomUUID();
        const live = this.#gateway.liveFor(scope.environmentInstanceId);
        const operationIdentity: RemoteMcpOperationIdentity = {
          ...authority.identity, ...leaseIdentity, agentId, operationId, processId, toolId: origin.workerId,
          ...(live !== undefined ? { enrollmentId: live.enrollment.id, workerIdentityDigest: live.enrollment.worker.identityDigest } : {}),
          fingerprint: createHash('sha256').update(JSON.stringify([processRow.fingerprint, operationId, origin.workerId])).digest('hex'),
          state: 'running', updatedAt: this.#clock(),
        };
        try { await this.#store.saveMcpOperation(operationIdentity); }
        catch { return { status: 'failed', reason: 'worker-refused' }; }
        try {
          current = await this.#assertProjectMcpAuthority(projectId, agentId, scope, false);
          if (!sameMcpBinding(current.identity, authority.identity)) throw new Error('MCP workspace binding changed');
        } catch {
          await this.#store.saveMcpOperation({ ...operationIdentity, state: 'failed', updatedAt: this.#clock() }).catch(() => undefined);
          await closeProcess();
          return { status: 'failed', reason: 'worker-refused' };
        }
        const input: CallProjectMcpToolParams = {
          ...authority.identity, ...leaseIdentity, processId, operationId, toolId: origin.workerId, arguments: arguments_,
        };
        let rawResult: CallProjectMcpToolResult;
        try {
          if (!mcpGrantIsCurrent()) throw new Error('stale Project MCP tool generation');
          if (!this.#environment.callProjectMcpTool) throw new Error('unsupported');
          rawResult = await this.#environment.callProjectMcpTool(scope.environmentInstanceId, input);
        } catch {
          await this.#store.saveMcpOperation({ ...operationIdentity, state: 'uncertain', updatedAt: this.#clock() }).catch(() => undefined);
          await this.#noteUncertainMcp(scope);
          await closeProcess();
          return { status: 'failed', reason: 'worker-refused' };
        }
        if (rawResult.processId !== processId || rawResult.operationId !== operationId) {
          await this.#store.saveMcpOperation({ ...operationIdentity, state: 'uncertain', updatedAt: this.#clock() }).catch(() => undefined);
          await this.#noteUncertainMcp(scope);
          await closeProcess();
          return { status: 'failed', reason: 'worker-refused' };
        }
        const result = sanitizeMcpCallResult(rawResult, processId, operationId);
        if (result.status === 'unsupported' || result.reason === 'timeout') {
          await this.#store.saveMcpOperation({ ...operationIdentity, state: 'uncertain', updatedAt: this.#clock() }).catch(() => undefined);
          await this.#noteUncertainMcp(scope);
          await closeProcess();
          return result;
        }
        try {
          current = await this.#assertProjectMcpAuthority(projectId, agentId, scope, false);
          if (!sameMcpBinding(current.identity, authority.identity)) throw new Error('MCP workspace binding changed');
        } catch {
          await this.#store.saveMcpOperation({ ...operationIdentity, state: 'uncertain', updatedAt: this.#clock() }).catch(() => undefined);
          await this.#noteUncertainMcp(scope);
          await closeProcess();
          return { status: 'failed', reason: 'worker-refused' };
        }
        try {
          await this.#store.saveMcpOperation({ ...operationIdentity, state: result.status, updatedAt: this.#clock() });
        } catch {
          await this.#noteUncertainMcp(scope);
          await closeProcess();
          return { status: 'failed', reason: 'worker-refused' };
        }
        return result;
      },
      close: closeProcess,
    };
  }

  async attach(projectId: string, agentId: string, runId?: string, onLeaseAcquired?: (leaseId: string) => Promise<void>, containingLease?: WorkspaceContainingLease,
    options: { readonly environmentInstanceId?: string; readonly bindingFence?: BindingGenerationFence } = {}): Promise<RemoteWorkspaceTools> {
    const project = await this.#projects.get(projectId);
    if (!project || project.status !== 'active' || !hasAgent(project, agentId)) throw new RemoteWorkspaceUnavailableError('project-denied');
    const accesses = (await this.#access.listForProject(projectId)).filter(a => a.status === 'active' && a.current &&
      (options.environmentInstanceId === undefined || a.environmentInstanceId === options.environmentInstanceId) &&
      (containingLease === undefined || a.environmentInstanceId === containingLease.environmentInstanceId))
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
    const assertBindingFence = (): void => {
      if (options.bindingFence !== undefined && !options.bindingFence.isCurrent()) {
        throw new RemoteWorkspaceUnavailableError('stale-generation');
      }
    };
    const runContext: RunContextParams | undefined = runId === undefined ? undefined : { ...fixed, runId };
    let runContextState: 'absent' | 'prepared' | 'unknown' = 'absent';
    let contextPreparationUncertain = false;
    let mutationLease: EnvironmentLease | undefined = containingLease === undefined ? undefined : this.#pool?.getLease(containingLease.leaseId);
    if (containingLease !== undefined && (containingLease.runId !== runId ||
        !sameMcpLease(mutationLease, containingLease) || mutationLease?.state !== 'active')) {
      throw new RemoteWorkspaceUnavailableError('lease-required');
    }
    let leaseAcquisition: Promise<{ readonly acquired?: EnvironmentLease; readonly conflict?: { readonly holderId: string; readonly state: 'active' | 'recovering' }; readonly failure?: string }> | undefined;
    let pendingOperations = 0;
    let uncertainOutcome = false;
    let leaseCompromised = false;
    let settlementRequested = false;
    let settlementFinalizing = false;
    const activeOperationIds = new Set<string>();
    const uncertainOperationIds = new Set<string>();
    let stopLeaseKeepalive: (() => void) | undefined;

    const keepMutationLeaseAlive = (): void => {
      if (stopLeaseKeepalive !== undefined || mutationLease === undefined) return;
      stopLeaseKeepalive = this.#pool!.keepLeaseUntilCleanup(mutationLease.id, this.#leaseTtlMs, () => {
        uncertainOutcome = true;
        leaseCompromised = true;
        stopLeaseKeepalive = undefined;
      });
    };

    if (containingLease !== undefined && mutationLease !== undefined) keepMutationLeaseAlive();

    const acquireMutationLease = async (): Promise<{ readonly acquired?: EnvironmentLease; readonly conflict?: { readonly holderId: string; readonly state: 'active' | 'recovering' }; readonly failure?: string }> => {
      if (runId === undefined) return { failure: 'run-required' };
      if (this.#pool === undefined) return { failure: 'lease-pool-unavailable' };
      if (this.#pool.requiresLeaseForBoundOperation(access.environmentInstanceId, MUTATION_CAPABILITY) !== true) return { failure: 'lease-capability-unavailable' };
      const prior = mutationLease;
      if (containingLease !== undefined) {
        const lease = this.#pool.getLease(containingLease.leaseId);
        if (containingLease.runId !== runId || !sameMcpLease(lease, containingLease) || lease?.state !== 'active') {
          return { failure: 'containing-lease-unavailable' };
        }
        mutationLease = lease;
      }
      if (prior !== undefined || mutationLease !== undefined) {
        const active = mutationLease!;
        const extended = this.#pool.extendLease(active.id, this.#leaseTtlMs);
        if (extended === undefined) {
          uncertainOutcome = true;
          this.#pool.markRecovering(active.id);
          return {};
        }
        mutationLease = extended;
        keepMutationLeaseAlive();
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
      keepMutationLeaseAlive();
      return { acquired: result.lease };
    };

    const settleLeaseIfReady = async (): Promise<void> => {
      if (!settlementRequested || mutationLease === undefined || this.#pool === undefined || settlementFinalizing) return;
      if (runContextState === 'unknown' && contextPreparationUncertain && runContext !== undefined && this.#environment.inspectRunContext) {
        try {
          const inspected = await this.#environment.inspectRunContext(access.environmentInstanceId, runContext);
          if (inspected === 'present') runContextState = 'prepared';
          else if (inspected === 'absent') runContextState = 'absent';
          if (inspected !== 'unknown') {
            contextPreparationUncertain = false;
            uncertainOutcome = leaseCompromised || uncertainOperationIds.size > 0;
          }
        } catch { /* An unavailable cleanup proof leaves the context and lease protected. */ }
      }
      if (leaseCompromised || uncertainOutcome || uncertainOperationIds.size > 0 || pendingOperations > 0 || runContextState === 'unknown') {
        this.#pool.markRecovering(mutationLease.id);
        stopLeaseKeepalive?.();
        return;
      }
      settlementFinalizing = true;
      try {
        if (runContextState === 'prepared' && runContext !== undefined) {
          if (!this.#environment.recycleRunContext) throw new Error('Run context cleanup unavailable');
          await this.#environment.recycleRunContext(access.environmentInstanceId, runContext);
          runContextState = 'absent';
        }
        if (containingLease === undefined || containingLease.canRelease()) this.#pool.releaseLease(mutationLease.id);
        stopLeaseKeepalive?.();
      } catch {
        runContextState = 'unknown';
        uncertainOutcome = true;
        this.#pool.markRecovering(mutationLease.id);
        stopLeaseKeepalive?.();
      } finally {
        settlementFinalizing = false;
      }
    };

    const execute = async (operation: 'read' | 'search' | 'edit' | 'patch' | 'command', input: {
      readonly path?: string; readonly query?: string; readonly oldText?: string; readonly newText?: string;
      readonly hunks?: readonly { readonly before: string; readonly after: string }[];
      readonly executable?: string; readonly args?: readonly string[]; readonly cwd?: string; readonly timeoutMs?: number;
    }, requestedOperationId?: string, onProgress?: (progress: RemoteWorkspaceProgress) => void): Promise<RemoteWorkspaceOperationResult> => {
      try { assertBindingFence(); } catch {
        return operationResult(fixed, stableOperationId(runId, requestedOperationId), operation, 'failed', 'remote-operation-blocked');
      }
      const operationId = stableOperationId(runId, requestedOperationId);
      const normalized = normalizeOperationInput(operation, input);
      const fingerprint = createHash('sha256').update(JSON.stringify([fixed, operation, runId ?? '', normalized])).digest('hex');
      let row: RemoteOperationIdentity = { operationId, fingerprint, projectId, environmentInstanceId: access.environmentInstanceId,
        bindingId: binding.bindingId, generation: binding.generation!, connectionEpoch: epoch, workspaceId: binding.workspaceId,
        kind: binding.kind, ...(binding.path !== undefined ? { path: binding.path } : {}), agentId,
        enrollmentId: live.enrollment.id, workerIdentityDigest: live.enrollment.worker.identityDigest,
        ...(runId !== undefined ? { runId } : {}),
        ...(mutationLease !== undefined ? operationLeaseIdentity(mutationLease) : {}),
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
      if (mutating && (runId === undefined || requestedOperationId === undefined || requestedOperationId.length < 1 || requestedOperationId.length > 512)) {
        return operationResult(fixed, operationId, operation, 'failed', 'operation-identity-required');
      }
      if (mutating) {
        try {
          await this.#assertCurrent(projectId, agentId, access.environmentInstanceId, fixed, MUTATION_CAPABILITY);
        } catch {
          return operationResult(fixed, operationId, operation, 'failed', 'remote-operation-blocked');
        }
        const capability = this.#catalog.entry(access.environmentInstanceId)?.definition.capabilities.find(c => c.name === MUTATION_CAPABILITY);
        const info = await this.#environment.info?.(access.environmentInstanceId);
        const supported = info?.workspaceOperations?.version === 3 && info.workspaceOperations.operations.includes(operation);
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
        row = { ...row, ...operationLeaseIdentity(lease.acquired) };
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
      if (mutating) {
        if (runContext === undefined || runContextState === 'unknown') return operationResult(fixed, operationId, operation, 'failed', 'run-context-recovery-required');
        if (runContextState === 'absent') {
          try {
            await this.#assertCurrent(projectId, agentId, access.environmentInstanceId, fixed, MUTATION_CAPABILITY);
            if (!this.#environment.prepareRunContext) throw new Error('Run context preparation unavailable');
            await this.#environment.prepareRunContext(access.environmentInstanceId, runContext);
            runContextState = 'prepared';
          } catch {
            runContextState = 'unknown';
            contextPreparationUncertain = true;
            uncertainOutcome = true;
            await this.#saveState(row, 'failed');
            return operationResult(fixed, operationId, operation, 'failed', 'run-context-unknown-inspect-required');
          }
        }
      }
      const { path: workspacePath, ...bindingIdentity } = fixed;
      const common = { ...bindingIdentity, ...(workspacePath !== undefined ? { workspacePath } : {}), operationId };
      const request: WorkspaceFileOperationParams = operation === 'read'
        ? { ...common, operation, path: normalized.path! }
        : operation === 'search'
          ? { ...common, operation, query: normalized.query!, ...(normalized.path !== undefined ? { path: normalized.path } : {}) }
          : operation === 'edit'
            ? { ...common, operation, path: normalized.path!, oldText: normalized.oldText!, newText: normalized.newText! }
            : operation === 'patch'
              ? { ...common, operation, path: normalized.path!, hunks: normalized.hunks! }
              : { ...common, operation, runId: runId!, executable: normalized.executable!, args: normalized.args!, ...(normalized.cwd !== undefined ? { cwd: normalized.cwd } : {}), ...(normalized.timeoutMs !== undefined ? { timeoutMs: normalized.timeoutMs } : {}) };
      let result: RemoteWorkspaceOperationResult;
      let progressSequence = 0;
      let progressBytes = 0;
      pendingOperations++;
      if (mutating) activeOperationIds.add(operationId);
      try {
        if (!this.#environment.executeWorkspaceFileOperation) throw new Error('unsupported');
        result = await this.#environment.executeWorkspaceFileOperation(access.environmentInstanceId, request, progress => {
          if (operation !== 'command' || onProgress === undefined || !validProgress(progress, fixed, operationId, progressSequence + 1)) return;
          const bytes = Buffer.byteLength(progress.text, 'utf8');
          if (progressBytes + bytes > MAX_COMMAND_OUTPUT_BYTES) return;
          progressSequence = progress.sequence;
          progressBytes += bytes;
          onProgress(progress);
        });
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
        if (mutating) activeOperationIds.delete(operationId);
        void settleLeaseIfReady();
      }
      await this.#saveState(row, result.status === 'completed' ? 'completed' : result.status);
      if (mutating && result.status !== 'recovery-required') {
        uncertainOperationIds.delete(operationId);
        uncertainOutcome = leaseCompromised || uncertainOperationIds.size > 0;
      }
      if (mutating && result.status === 'recovery-required') {
        uncertainOutcome = true;
        uncertainOperationIds.add(operationId);
      }
      settleLeaseIfReady();
      return result;
    };
    const inspectOperation = async (operationId: string): Promise<{ readonly status: string; readonly operation?: RemoteWorkspaceOperationResult }> => {
      await this.#assertCurrent(projectId, agentId, access.environmentInstanceId, fixed);
      const row = await this.#store.get(operationId);
      if (!row || row.projectId !== projectId || row.bindingId !== binding.bindingId || row.generation !== binding.generation || row.connectionEpoch !== epoch) return { status: 'not-found' };
      if (!this.#environment.inspectWorkspaceFileOperation) return { status: row.state };
      const request: InspectWorkspaceFileOperationParams = { ...fixed, operationId };
      const result = await this.#environment.inspectWorkspaceFileOperation(access.environmentInstanceId, request);
      if (result.status === 'not-found') {
        if (row.state === 'running' || row.state === 'unknown' || row.state === 'cancel-requested') {
          await this.#saveState(row, 'unknown');
          uncertainOperationIds.add(operationId);
          uncertainOutcome = true;
          void settleLeaseIfReady();
          return { status: 'unknown' };
        }
        return { status: row.state };
      }
      const operationTerminal = isTerminalOperationState(result.status) || result.status === 'recovery-required';
      if (!operationTerminal) {
        if (row.operation === 'edit' || row.operation === 'patch' || row.operation === 'command') {
          uncertainOperationIds.add(operationId);
          uncertainOutcome = true;
        }
        void settleLeaseIfReady();
        return { status: result.status };
      }
      if ((row.operation === 'edit' || row.operation === 'patch' || row.operation === 'command') && operationTerminal && result.result === undefined) return { status: 'unknown' };
      if (result.result && (result.result.status !== result.status ||
          !isBoundedRemoteResult(result.result, fixed, operationId, row.operation))) return { status: 'unknown' };
      if (result.status === 'recovery-required') {
        await this.#saveState(row, 'recovery-required');
        uncertainOperationIds.add(operationId);
        uncertainOutcome = true;
        void settleLeaseIfReady();
        return { status: 'recovery-required' };
      }
      if (operationTerminal && result.status !== row.state) await this.#saveState(row, result.status);
      if (operationTerminal && result.result && (row.operation === 'edit' || row.operation === 'patch' || row.operation === 'command')) {
        uncertainOperationIds.delete(operationId);
        uncertainOutcome = leaseCompromised || uncertainOperationIds.size > 0;
      }
      void settleLeaseIfReady();
      const status = result.status;
      return { status, ...(result.result !== undefined ? { operation: result.result } : {}) };
    };

    const cancelOperation = async (operationId: string): Promise<{ readonly accepted: boolean; readonly status: string }> => {
      // Recovery controls remain pinned to this exact Environment and binding;
      // the fence blocks new work but must not prevent settling an old call.
      await this.#assertCurrent(projectId, agentId, access.environmentInstanceId, fixed);
      const row = await this.#store.get(operationId);
      if (!row || row.projectId !== projectId || row.bindingId !== binding.bindingId || row.generation !== binding.generation || row.connectionEpoch !== epoch || !['running','cancel-requested'].includes(row.state)) {
        return { accepted: false, status: row?.state ?? 'not-found' };
      }
      if (!this.#environment.cancelWorkspaceFileOperation) return { accepted: false, status: 'unsupported' };
      const request: CancelWorkspaceFileOperationParams = { ...fixed, operationId };
      const result = await this.#environment.cancelWorkspaceFileOperation(access.environmentInstanceId, request);
      if (result.accepted) await this.#saveState(row, 'cancel-requested');
      return { accepted: result.accepted, status: result.status };
    };

    const remoteOperations: ('read' | 'search' | 'edit' | 'patch' | 'command')[] = ['read', 'search'];
    const enrollment = await this.#enrollments.get(live.enrollment.id);
    const mutationCapability = this.#catalog.entry(access.environmentInstanceId)?.definition.capabilities.find(c => c.name === MUTATION_CAPABILITY);
    const operations = await this.#environment.info?.(access.environmentInstanceId);
    if (enrollment?.capabilityPermissions[MUTATION_CAPABILITY] === true && mutationCapability?.requiresLease === true &&
        operations?.workspaceOperations?.version === 3 && operations.workspaceOperations.operations.includes('edit') &&
        operations.workspaceOperations.operations.includes('patch')) remoteOperations.push('edit', 'patch');
    if (enrollment?.capabilityPermissions[MUTATION_CAPABILITY] === true && mutationCapability?.requiresLease === true &&
        operations?.workspaceOperations?.version === 3 && operations.workspaceOperations.operations.includes('command')) remoteOperations.push('command');
    return {
      binding: { projectId, environmentInstanceId: access.environmentInstanceId, bindingId: binding.bindingId,
        generation: binding.generation!, connectionEpoch: epoch, workspaceId: binding.workspaceId, kind: binding.kind,
        ...(binding.path !== undefined ? { path: binding.path } : {}) },
      ...(options.bindingFence !== undefined ? { bindingFence: options.bindingFence } : {}),
      operations: remoteOperations,
      read: (path, operationId) => execute('read', { path }, operationId),
      search: (query, path, operationId) => execute('search', { query, ...(path !== undefined ? { path } : {}) }, operationId),
      edit: (path, oldText, newText, operationId) => execute('edit', { path, oldText, newText }, operationId),
      patch: (path, hunks, operationId) => execute('patch', { path, hunks }, operationId),
      command: (executable, args, options, operationId, onProgress) => execute('command', {
        executable, args, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      }, operationId, onProgress),
      settle: async outcome => {
        settlementRequested = true;
        if (outcome === 'unknown' && mutationLease !== undefined) this.#pool?.markRecovering(mutationLease.id);
        if (outcome === 'unknown') stopLeaseKeepalive?.();
        if (outcome === 'unknown') {
          const operationIds = new Set([...activeOperationIds, ...uncertainOperationIds]);
          for (const operationId of operationIds) {
            const row = await this.#store.get(operationId);
            if (row?.operation === 'command') {
              try { await cancelOperation(operationId); } catch { /* Worker loss leaves the lease protected. */ }
            }
            try { await inspectOperation(operationId); } catch { /* Failed inspection leaves the lease protected. */ }
          }
        }
        await settleLeaseIfReady();
      },
      inspect: inspectOperation,
      cancel: cancelOperation,
    };
  }

  async #assertProjectMcpAuthority(
    projectId: string,
    agentId: string,
    scope: ProjectMcpLeaseScope,
    allowRecovering: boolean,
  ): Promise<{ readonly identity: AttachWorkspaceBindingParams; readonly format: typeof PROJECT_MCP_CONFIGURATION_FORMAT }> {
    const project = await this.#projects.get(projectId);
    const content = project?.content.versions.find(version => version.version === project.content.currentVersion);
    if (!project || project.status !== 'active' || !content?.mcpConfiguration || content.mcpConfiguration.format !== PROJECT_MCP_CONFIGURATION_FORMAT || !hasAgent(project, agentId)) {
      throw new RemoteWorkspaceUnavailableError('project-denied');
    }
    const lease = this.#pool?.getLease(scope.leaseId);
    if (!sameMcpLease(lease, scope) || (lease?.state !== 'active' && !(allowRecovering && lease?.state === 'recovering'))) {
      throw new RemoteWorkspaceUnavailableError('lease-required');
    }
    const access = await this.#access.get(projectId, scope.environmentInstanceId);
    const binding = access?.current;
    if (!access || access.status !== 'active' || !binding || !accessIsConsistent(access) || access.projectId !== projectId ||
        !validProjectBinding(access, binding)) {
      throw new RemoteWorkspaceUnavailableError('workspace-unbound');
    }
    const live = this.#gateway.liveFor(scope.environmentInstanceId);
    if (!live || live.enrollment.status !== 'approved') throw new RemoteWorkspaceUnavailableError('worker-offline');
    const enrollment = await this.#enrollments.get(live.enrollment.id);
    if (!enrollment || enrollment.environmentInstanceId !== scope.environmentInstanceId || enrollment.status !== 'approved') throw new RemoteWorkspaceUnavailableError('worker-offline');
    if (enrollment.capabilityPermissions['project-mcp'] !== true) throw new RemoteWorkspaceUnavailableError('capability-denied');
    const epoch = live.epoch.epoch;
    if (epoch !== this.#gateway.currentConnectionEpoch(enrollment.id) || !this.#gateway.isCurrentConnection(enrollment.id, live.epoch.connectionId) || this.#environment.connectionEpoch?.(scope.environmentInstanceId) !== epoch) {
      throw new RemoteWorkspaceUnavailableError('stale-epoch');
    }
    const capability = this.#catalog.entry(scope.environmentInstanceId)?.definition.capabilities.find(row => row.name === 'project-mcp');
    if (!capability || capability.requiresLease !== true) throw new RemoteWorkspaceUnavailableError('unsupported');
    const info = await this.#environment.info?.(scope.environmentInstanceId);
    const operations = info?.workspaceOperations?.operations;
    if (!info || info.environmentInstanceId !== scope.environmentInstanceId ||
        !operations?.includes('start-project-mcp') || !operations.includes('call-project-mcp-tool') || !operations.includes('stop-project-mcp')) {
      throw new RemoteWorkspaceUnavailableError('unsupported');
    }
    return {
      identity: {
        projectId, environmentInstanceId: scope.environmentInstanceId, bindingId: binding.bindingId,
        generation: binding.generation!, connectionEpoch: epoch, workspaceId: binding.workspaceId,
        kind: binding.kind, ...(binding.path !== undefined ? { path: binding.path } : {}),
      },
      format: PROJECT_MCP_CONFIGURATION_FORMAT,
    };
  }

  async #noteUncertainMcp(scope: ProjectMcpLeaseScope): Promise<void> {
    this.#pool?.markRecovering(scope.leaseId);
    try { await this.#onUncertainMcp?.(scope); } catch { /* The lease remains protected in the pool. */ }
  }

  async #stopUntrackedProcess(identity: AttachWorkspaceBindingParams, scope: ProjectMcpLeaseScope, processId: string): Promise<boolean> {
    try {
      const result = await this.#environment.stopProjectMcp?.(scope.environmentInstanceId, {
        ...identity, ...projectMcpLeaseIdentity(scope), processId,
      });
      const currentEpoch = this.#gateway.liveFor(scope.environmentInstanceId)?.epoch.epoch;
      return result?.processId === processId && (result.status === 'stopped' || (result.status === 'not-found' && currentEpoch === identity.connectionEpoch));
    } catch { return false; }
  }

  async #stopMcpProcess(
    identity: AttachWorkspaceBindingParams,
    scope: ProjectMcpLeaseScope,
    row: RemoteMcpProcessIdentity,
    processId: string,
  ): Promise<'stopped' | 'uncertain'> {
    await this.#store.saveMcpProcess({ ...row, state: 'stopping', updatedAt: this.#clock() }).catch(() => undefined);
    if (!await this.#stopUntrackedProcess(identity, scope, processId)) {
      await this.#store.saveMcpProcess({ ...row, state: 'uncertain', updatedAt: this.#clock() }).catch(() => undefined);
      return 'uncertain';
    }
    try {
      await this.#store.saveMcpProcess({ ...row, state: 'stopped', updatedAt: this.#clock() });
      return 'stopped';
    } catch { return 'uncertain'; }
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
    const supportsRead = operations?.version === 1 || operations?.version === 2 || operations?.version === 3;
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

  async #assertCurrent(projectId: string, agentId: string | undefined, environmentInstanceId: string, identity: AttachWorkspaceBindingParams, capability = 'read-only-investigation'): Promise<void> {
    const project = await this.#projects.get(projectId);
    if (!project || project.status !== 'active' || (agentId !== undefined && !hasAgent(project, agentId))) throw new RemoteWorkspaceUnavailableError('project-denied');
    const current = await this.#access.get(projectId, environmentInstanceId);
    if (!current || current.status !== 'active' || !current.current || current.current.bindingId !== identity.bindingId || current.current.generation !== identity.generation || current.current.workspaceId !== identity.workspaceId || current.current.kind !== identity.kind || current.current.path !== identity.path) throw new RemoteWorkspaceUnavailableError('access-ended');
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

function mcpStartupFailureReason(
  result: StartProjectMcpResult,
  toolCount: number,
): RemoteProjectMcpStartupError['reason'] {
  if (result.servers.some(server => server.status === 'missing-dependency') || result.reason === 'missing') return 'missing-dependency';
  if (result.servers.some(server => server.status === 'invalid') || result.reason === 'invalid') return 'invalid-configuration';
  if (result.servers.some(server => server.status === 'unsupported') || result.reason === 'unsupported') return 'unsupported-configuration';
  if (toolCount === 0) return 'no-tools';
  return 'worker-refused';
}

function sanitizeMcpInspection(result: InspectProjectMcpConfigurationResult): Pick<ProjectMcpInspection, 'status' | 'servers'> | undefined {
  if (!result || result.format !== 'claude-code-mcp-json-v1' ||
      !['valid', 'missing', 'invalid', 'unsupported'].includes(result.status) ||
      !Array.isArray(result.servers) || result.servers.length > 64) return undefined;
  const servers: { name: string; transport: 'stdio' }[] = [];
  for (const server of result.servers) {
    if (!server || Object.keys(server).some(key => key !== 'name' && key !== 'transport') || server.transport !== 'stdio' ||
        typeof server.name !== 'string' || sanitizeIdentifier(server.name, { fallback: '', kind: 'generic' }) !== server.name) return undefined;
    servers.push({ name: server.name, transport: 'stdio' });
  }
  if (result.status !== 'valid' && servers.length !== 0) return undefined;
  return { status: result.status, servers };
}

function safeMcpToolCatalog(result: StartProjectMcpResult): { readonly processId?: string; readonly tools: readonly { readonly public: import('../engine/port.ts').ProjectMcpToolDeclaration; readonly workerId: string }[] } | undefined {
  if (!result || !['ready', 'partial', 'blocked'].includes(result.status) || !Array.isArray(result.servers) || result.servers.length > 64 ||
      (result.processId !== undefined && (typeof result.processId !== 'string' || result.processId.length < 1 || result.processId.length > 128))) return undefined;
  const tools: { public: import('../engine/port.ts').ProjectMcpToolDeclaration; workerId: string }[] = [];
  const names = new Set<string>();
  for (const server of result.servers) {
    if (!server || typeof server.name !== 'string' || !['ready', 'missing-dependency', 'invalid', 'unsupported'].includes(server.status) ||
        !Array.isArray(server.tools) || server.tools.length > 128) return undefined;
    if (server.status !== 'ready' && server.tools.length > 0) return undefined;
    const safeServer = sanitizeIdentifier(server.name, { fallback: '', kind: 'generic', maxLength: 64 });
    if (!safeServer || !Array.isArray(server.tools)) return undefined;
    for (const tool of server.tools) {
      if (!tool || tool.server !== server.name || typeof tool.id !== 'string' || tool.id.length < 1 || tool.id.length > 128 ||
          typeof tool.name !== 'string' || sanitizeIdentifier(tool.name, { fallback: '', kind: 'generic', maxLength: 64 }) !== tool.name ||
          typeof tool.description !== 'string') return undefined;
      const inputSchema = isRecord(tool.inputSchema) ? sanitizeMcpSchema(tool.inputSchema, 0) : undefined;
      if (!inputSchema) return undefined;
      const safeTool = sanitizeIdentifier(tool.name, { fallback: '', kind: 'generic', maxLength: 64 });
      const name = sanitizeIdentifier(`mcp_${safeServer}_${safeTool}`, { fallback: '', kind: 'generic', maxLength: 128 });
      if (!name || names.has(name)) return undefined;
      names.add(name);
      tools.push({
        public: { name, description: sanitizeOperatorText(tool.description, { fallback: 'Project MCP tool.', maxLength: 1_000 }), inputSchema },
        workerId: tool.id,
      });
    }
  }
  if (tools.length > 128 || (tools.length > 0 && !result.processId)) return undefined;
  return { ...(result.processId !== undefined ? { processId: result.processId } : {}), tools };
}

function sanitizeMcpSchema(schema: Record<string, unknown>, depth: number): Readonly<Record<string, unknown>> | undefined {
  if (depth > 10 || Object.keys(schema).length > 32) return undefined;
  const allowed = new Set(['type', 'description', 'properties', 'required', 'items', 'enum', 'additionalProperties', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']);
  if (Object.keys(schema).some(key => !allowed.has(key)) || typeof schema.type !== 'string' ||
      !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type)) return undefined;
  const result: Record<string, unknown> = { type: schema.type };
  if (schema.description !== undefined) {
    if (typeof schema.description !== 'string') return undefined;
    result.description = sanitizeOperatorText(schema.description, { fallback: '', maxLength: 1_000 });
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length > 64 || schema.enum.some(item => item !== null && !['string', 'number', 'boolean'].includes(typeof item))) return undefined;
    const safeEnum = schema.enum.map(item => {
      if (typeof item !== 'string') return item;
      const safe = sanitizeOperatorText(item, { fallback: '', maxLength: 1_000 });
      return safe === item ? safe : undefined;
    });
    if (safeEnum.some(item => item === undefined)) return undefined;
    result.enum = safeEnum;
  }
  if (schema.type === 'object') {
    const properties = schema.properties ?? {};
    if (!isRecord(properties) || Object.keys(properties).length > 64) return undefined;
    const safeProperties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (sanitizeIdentifier(key, { fallback: '', kind: 'generic', maxLength: 64 }) !== key || !isRecord(value)) return undefined;
      const child = sanitizeMcpSchema(value, depth + 1);
      if (!child) return undefined;
      safeProperties[key] = child;
    }
    result.properties = safeProperties;
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || schema.required.length > 64 || schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(safeProperties, key))) return undefined;
      result.required = [...schema.required];
    }
    if (schema.additionalProperties !== undefined) {
      if (schema.additionalProperties !== false) return undefined;
      result.additionalProperties = false;
    }
  } else if (schema.type === 'array') {
    if (!isRecord(schema.items)) return undefined;
    const items = sanitizeMcpSchema(schema.items, depth + 1);
    if (!items) return undefined;
    result.items = items;
  }
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    const value = schema[key];
    if (value !== undefined) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) return undefined;
      result[key] = value;
    }
  }
  return JSON.stringify(result).length <= 16_384 ? result : undefined;
}

function validMcpArguments(schema: Readonly<Record<string, unknown>>, value: Readonly<Record<string, unknown>>): boolean {
  return validateMcpValue(schema, value, 0);
}
function validateMcpValue(schema: Readonly<Record<string, unknown>>, value: unknown, depth: number): boolean {
  if (depth > 10) return false;
  const type = schema.type;
  const enumValues = schema.enum;
  const enumOk = enumValues === undefined || (Array.isArray(enumValues) && enumValues.some(item => item === value));
  if (!enumOk) return false;
  if (type === 'object') {
    if (!isRecord(value)) return false;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some(key => typeof key !== 'string' || !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(properties, key))) return false;
    return Object.entries(value).every(([key, item]) => !Object.hasOwn(properties, key) ||
      (isRecord(properties[key]) && validateMcpValue(properties[key] as Record<string, unknown>, item, depth + 1)));
  }
  if (type === 'array') return Array.isArray(value) && value.length <= 10_000 &&
    (typeof schema.minItems !== 'number' || value.length >= schema.minItems) &&
    (typeof schema.maxItems !== 'number' || value.length <= schema.maxItems) && isRecord(schema.items) &&
    value.every(item => validateMcpValue(schema.items as Record<string, unknown>, item, depth + 1));
  if (type === 'string') return typeof value === 'string' && value.length <= 64 * 1024 &&
    (typeof schema.minLength !== 'number' || value.length >= schema.minLength) &&
    (typeof schema.maxLength !== 'number' || value.length <= schema.maxLength);
  if (type === 'integer') return Number.isSafeInteger(value) &&
    (typeof schema.minimum !== 'number' || (value as number) >= schema.minimum) &&
    (typeof schema.maximum !== 'number' || (value as number) <= schema.maximum);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value) &&
    (typeof schema.minimum !== 'number' || value >= schema.minimum) &&
    (typeof schema.maximum !== 'number' || value <= schema.maximum);
  if (type === 'boolean') return typeof value === 'boolean';
  return type === 'null' && value === null;
}

function sanitizeMcpCallResult(
  result: CallProjectMcpToolResult | undefined,
  processId: string,
  operationId: string,
): { readonly status: 'completed' | 'failed' | 'unsupported'; readonly text?: string; readonly reason?: string } {
  if (!result || result.processId !== processId || result.operationId !== operationId || !['completed', 'failed', 'unsupported'].includes(result.status) ||
      (result.reason !== undefined && !['unknown-tool', 'invalid-arguments', 'server-error', 'invalid-result', 'timeout', 'worker-refused'].includes(result.reason)) ||
      (result.text !== undefined && typeof result.text !== 'string')) return { status: 'failed', reason: 'worker-refused' };
  let safeText = result.text === undefined ? undefined : sanitizeOperatorText(result.text, { fallback: 'MCP tool returned no text.', maxLength: 32_000 });
  if (safeText !== undefined && Buffer.byteLength(safeText, 'utf8') > 32 * 1024) {
    let low = 0; let high = safeText.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(safeText.slice(0, middle), 'utf8') <= 32 * 1024) low = middle;
      else high = middle - 1;
    }
    safeText = safeText.slice(0, low);
  }
  return { status: result.status, ...(safeText !== undefined ? { text: safeText } : {}), ...(result.reason !== undefined ? { reason: result.reason } : {}) };
}

function validProjectBinding(access: ProjectEnvironmentAccess, binding: WorkspaceBinding): boolean {
  if (!Number.isSafeInteger(binding.generation) || binding.generation! < 1 || typeof binding.bindingId !== 'string' ||
      !binding.bindingId || typeof binding.workspaceId !== 'string' || !binding.workspaceId.trim()) return false;
  try {
    const selection = sanitizeWorkspaceSelection({ kind: binding.kind, ...(binding.path !== undefined ? { path: binding.path } : {}) });
    if (selection.kind !== binding.kind || selection.path !== binding.path) return false;
  } catch { return false; }
  const current = access.history.find(row => row.bindingId === binding.bindingId && row.unboundAt === undefined);
  return current !== undefined && current.generation === binding.generation && current.workspaceId === binding.workspaceId &&
    current.kind === binding.kind && current.path === binding.path;
}

function projectMcpLeaseIdentity(scope: ProjectMcpLeaseScope): ProjectMcpLeaseIdentity {
  return {
    leaseId: scope.leaseId, holderKind: scope.holderKind, holderId: scope.holderId, runId: scope.runId,
    ...(scope.taskId !== undefined ? { taskId: scope.taskId } : {}),
  };
}
function sameMcpLease(lease: EnvironmentLease | undefined, scope: ProjectMcpLeaseScope): boolean {
  if (!lease || lease.id !== scope.leaseId || lease.instanceId !== scope.environmentInstanceId || lease.capability !== scope.leaseCapability ||
      (lease.holderKind ?? 'run') !== scope.holderKind || lease.holderId !== scope.holderId) return false;
  if (scope.holderKind === 'run') return scope.taskId === undefined && lease.taskId === undefined && lease.runId === scope.runId;
  return scope.taskId !== undefined && scope.holderId === scope.taskId && lease.taskId === scope.taskId;
}
function sameOperationLease(lease: EnvironmentLease | undefined, row: RemoteOperationIdentity): boolean {
  if (!lease || row.leaseId !== lease.id || lease.instanceId !== row.environmentInstanceId ||
      row.holderKind === undefined || row.holderId !== lease.holderId ||
      (lease.holderKind ?? 'run') !== row.holderKind) return false;
  if (row.holderKind === 'task') return row.taskId !== undefined && lease.taskId === row.taskId &&
    (row.runId === undefined || lease.runId === row.runId);
  return lease.taskId === undefined && row.runId !== undefined && lease.runId === row.runId;
}

function sameMcpBindingExceptEpoch(a: AttachWorkspaceBindingParams, b: AttachWorkspaceBindingParams): boolean {
  return a.projectId === b.projectId && a.environmentInstanceId === b.environmentInstanceId && a.bindingId === b.bindingId &&
    a.generation === b.generation && a.workspaceId === b.workspaceId && a.kind === b.kind && a.path === b.path;
}
function sameMcpBinding(a: AttachWorkspaceBindingParams, b: AttachWorkspaceBindingParams): boolean {
  return a.projectId === b.projectId && a.environmentInstanceId === b.environmentInstanceId && a.bindingId === b.bindingId &&
    a.generation === b.generation && a.connectionEpoch === b.connectionEpoch && a.workspaceId === b.workspaceId && a.kind === b.kind && a.path === b.path;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function operationLeaseIdentity(lease: EnvironmentLease): Pick<RemoteOperationIdentity, 'runId' | 'leaseId' | 'holderKind' | 'holderId' | 'taskId'> {
  return {
    ...(lease.runId !== undefined ? { runId: lease.runId } : {}),
    leaseId: lease.id,
    holderKind: lease.holderKind ?? 'run',
    holderId: lease.holderId,
    ...(lease.taskId !== undefined ? { taskId: lease.taskId } : {}),
  };
}

function isTerminalOperationState(value: string): value is 'completed' | 'failed' | 'cancelled' {
  return value === 'completed' || value === 'failed' || value === 'cancelled';
}

function hasAgent(project: Awaited<ReturnType<ProjectService['get']>> & {}, agentId: string): boolean {
  if (!project) return false;
  const version = project.content.versions.find(v => v.version === project.content.currentVersion);
  return version?.memberships.some(m => m.memberId === agentId && m.memberKind === 'agent' && m.endedAt === undefined) ?? false;
}
function normalizeOperationInput(operation: 'read' | 'search' | 'edit' | 'patch' | 'command', input: {
  readonly path?: string; readonly query?: string; readonly oldText?: string; readonly newText?: string;
  readonly hunks?: readonly { readonly before: string; readonly after: string }[];
  readonly executable?: string; readonly args?: readonly string[]; readonly cwd?: string; readonly timeoutMs?: number;
}): { readonly path?: string; readonly query?: string; readonly oldText?: string; readonly newText?: string;
  readonly hunks?: readonly { readonly before: string; readonly after: string }[]; readonly executable?: string;
  readonly args?: readonly string[]; readonly cwd?: string; readonly timeoutMs?: number; readonly failure?: string } {
  const path = input.path === undefined ? undefined : normalizeRelativePath(input.path);
  if (input.path !== undefined && (path === undefined || path.split('/')[0] === '.sprout')) return { failure: 'invalid-path' };
  if (operation !== 'search' && operation !== 'command' && path === undefined) return { failure: 'invalid-path' };
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
  if (operation === 'command') {
    if (input.executable !== 'node' && input.executable !== 'npm') return { failure: 'command-not-allowed' };
    if (!Array.isArray(input.args) || input.args.length > 64 || Array.from(input.args).some(arg => typeof arg !== 'string' || Buffer.byteLength(arg, 'utf8') > 4_096) ||
        Buffer.byteLength(JSON.stringify(input.args), 'utf8') > 16 * 1024) return { failure: 'operation-limit' };
    const cwd = input.cwd === undefined || input.cwd === '.' ? undefined : normalizeRelativePath(input.cwd);
    if (input.cwd !== undefined && input.cwd !== '.' && cwd === undefined) return { failure: 'invalid-path' };
    if (cwd?.split('/')[0] === '.sprout') return { failure: 'invalid-path' };
    if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 120_000)) return { failure: 'operation-limit' };
    return { executable: input.executable, args: [...input.args], ...(cwd !== undefined ? { cwd } : {}), ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}) };
  }
  return { ...(path !== undefined ? { path } : {}), ...(input.query !== undefined ? { query: input.query } : {}),
    ...(input.oldText !== undefined ? { oldText: input.oldText } : {}), ...(input.newText !== undefined ? { newText: input.newText } : {}),
    ...(input.hunks !== undefined ? { hunks: input.hunks } : {}), ...(input.executable !== undefined ? { executable: input.executable } : {}),
    ...(input.args !== undefined ? { args: input.args } : {}), ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}) };
}

function normalizeRelativePath(value: string): string | undefined {
  if (value.length > 1_024 || Buffer.byteLength(value, 'utf8') > 4_096) return undefined;
  const normalized = value.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) return undefined;
  return normalized;
}

function isBoundedRemoteResult(result: RemoteWorkspaceOperationResult, identity: AttachWorkspaceBindingParams, operationId: string, operation: 'read' | 'search' | 'edit' | 'patch' | 'command'): boolean {
  if (!sameOrigin(result, identity, operationId, operation) ||
    !['completed', 'failed', 'cancelled', 'recovery-required'].includes(result.status) ||
    (result.truncated !== undefined && typeof result.truncated !== 'boolean')) return false;
  if (operation === 'command') {
    const chunks = result.outputChunks;
    if (result.content !== undefined || result.matches !== undefined || result.path !== undefined || result.changedPaths !== undefined ||
        typeof result.output !== 'string' || Buffer.byteLength(result.output, 'utf8') > MAX_COMMAND_OUTPUT_BYTES ||
        !Array.isArray(chunks) || chunks.length > 64 ||
        (result.exitCode !== null && result.exitCode !== undefined && !Number.isSafeInteger(result.exitCode))) return false;
    let total = 0;
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      if (!chunk || chunk.sequence !== index + 1 || (chunk.stream !== 'stdout' && chunk.stream !== 'stderr') || typeof chunk.text !== 'string' || Buffer.byteLength(chunk.text, 'utf8') > 1_024) return false;
      total += Buffer.byteLength(chunk.text, 'utf8');
    }
    return total <= MAX_COMMAND_OUTPUT_BYTES && chunks.map(chunk => chunk.text).join('') === result.output &&
      (result.failure === undefined || ['command-not-allowed','operation-limit','invalid-path','command-supervision-unsupported','command-timeout','command-start-failed','command-failed','cancelled','descendant-process-unknown','run-context-unavailable','operation-identity-conflict','operation-journal-unavailable','outcome-unknown-inspect-required'].includes(result.failure));
  }
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

function validProgress(progress: RemoteWorkspaceProgress, identity: AttachWorkspaceBindingParams, operationId: string, nextSequence: number): boolean {
  return progress.operationId === operationId && progress.projectId === identity.projectId &&
    progress.environmentInstanceId === identity.environmentInstanceId && progress.bindingId === identity.bindingId &&
    progress.generation === identity.generation && progress.connectionEpoch === identity.connectionEpoch &&
    progress.workspaceId === identity.workspaceId && progress.sequence === nextSequence &&
    (progress.stream === 'stdout' || progress.stream === 'stderr') && typeof progress.text === 'string' &&
    Buffer.byteLength(progress.text, 'utf8') <= 1_024;
}

function stableOperationId(runId: string | undefined, requested: string | undefined): string {
  if (runId === undefined || requested === undefined || requested.length < 1 || requested.length > 512) return randomUUID();
  return createHash('sha256').update(`${runId}\\u0000${requested}`).digest('hex');
}

function operationResult(identity: AttachWorkspaceBindingParams, operationId: string, operation: 'read' | 'search' | 'edit' | 'patch' | 'command', status: 'completed' | 'failed' | 'cancelled' | 'recovery-required', failure?: string,
  leaseConflict?: { readonly holderId: string; readonly state: 'active' | 'recovering' }): RemoteWorkspaceOperationResult {
  return { operationId, projectId: identity.projectId, environmentInstanceId: identity.environmentInstanceId,
    bindingId: identity.bindingId, generation: identity.generation, connectionEpoch: identity.connectionEpoch,
    workspaceId: identity.workspaceId, operation, status, ...(failure !== undefined ? { failure } : {}),
    ...(leaseConflict !== undefined ? { leaseConflict } : {}) };
}

function sameOrigin(result: RemoteWorkspaceOperationResult, identity: AttachWorkspaceBindingParams, operationId: string, operation: 'read' | 'search' | 'edit' | 'patch' | 'command'): boolean {
  return result.operationId === operationId && result.projectId === identity.projectId && result.environmentInstanceId === identity.environmentInstanceId &&
    result.bindingId === identity.bindingId && result.generation === identity.generation && result.connectionEpoch === identity.connectionEpoch &&
    result.workspaceId === identity.workspaceId && result.operation === operation;
}
