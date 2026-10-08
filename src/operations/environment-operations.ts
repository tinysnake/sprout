import { createHash, randomUUID } from 'node:crypto';
import type { RemoteWorkspaceOperationResult, RemoteWorkspaceTools, RemoteProjectMcpTools } from '../engine/port.ts';
import { RemoteProjectMcpStartupError } from '../engine/port.ts';
import type { ProjectAccessService } from '../project/access-service.ts';
import { accessIsConsistent, sanitizeWorkspaceSelection } from '../project/access.ts';
import { sanitizeIdentifier, sanitizeOperatorText } from '../environment/privacy.ts';
import type { ProjectService } from '../project/authority-service.ts';
import { PROJECT_MCP_CONFIGURATION_FORMAT } from '../project/authority-model.ts';
import type { ProjectEnvironmentAccess, WorkspaceBinding } from '../project/access.ts';
import type { RuntimeEnvironment, WorkerGatewayView } from '../runtime.ts';
import type { EnvironmentCatalog } from '../environment/catalog.ts';
import type { EnvironmentEnrollmentService } from '../environment/enrollment-service.ts';
import type { EnvironmentPool, EnvironmentLease } from '../environment/pool.ts';
import type { RemoteOperationIdentityStore, RemoteOperationIdentity, RemoteOperationState, RemoteMcpProcessIdentity, RemoteMcpOperationIdentity } from './remote-operation-store.ts';
import type { AttachWorkspaceBindingParams, ProjectMcpLeaseIdentity, WorkspaceFileOperationParams, InspectWorkspaceFileOperationParams, CancelWorkspaceFileOperationParams, InspectProjectMcpConfigurationResult, StartProjectMcpParams, CallProjectMcpToolParams, StopProjectMcpParams, StartProjectMcpResult, CallProjectMcpToolResult } from '../worker/protocol.ts';

const MAX_SUPPORTED_READ_BYTES = 64 * 1024;
const MAX_SUPPORTED_SEARCH_RESULTS = 100;

export type RemoteWorkspaceBlock = 'project-denied' | 'access-ended' | 'workspace-unbound' | 'worker-offline' | 'stale-epoch' | 'unsupported' | 'capability-denied' | 'lease-required' | 'worker-refused';
export interface ProjectMcpLeaseScope extends ProjectMcpLeaseIdentity {
  readonly environmentInstanceId: string;
  /** The containing run lease or existing Task lease; MCP never acquires a second Task lease. */
  readonly leaseCapability: 'project-mcp' | 'agent-run';
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
  'inspectWorkspaceFileOperation' | 'cancelWorkspaceFileOperation'>;
type EnvironmentOperationsGateway = Pick<WorkerGatewayView, 'liveFor' | 'currentConnectionEpoch' | 'isCurrentConnection'>;
type EnvironmentOperationsCatalog = Pick<EnvironmentCatalog, 'entry'>;
type EnvironmentOperationsEnrollments = Pick<EnvironmentEnrollmentService, 'get'>;

export class EnvironmentOperations {
  readonly #projects: Pick<ProjectService, 'get'>;
  readonly #access: Pick<ProjectAccessService, 'get' | 'listForProject'>;
  readonly #environment: Pick<RuntimeEnvironment,
    'info' | 'connectionEpoch' | 'attachWorkspaceBinding' | 'executeWorkspaceFileOperation' |
    'inspectProjectMcpConfiguration' | 'startProjectMcp' | 'callProjectMcpTool' | 'stopProjectMcp' |
    'inspectWorkspaceFileOperation' | 'cancelWorkspaceFileOperation'>;
  readonly #pool: Pick<EnvironmentPool, 'getLease' | 'markRecovering'>;
  readonly #gateway: Pick<WorkerGatewayView, 'liveFor' | 'currentConnectionEpoch' | 'isCurrentConnection'>;
  readonly #catalog: EnvironmentOperationsCatalog;
  readonly #enrollments: EnvironmentOperationsEnrollments;
  readonly #store: RemoteOperationIdentityStore;
  readonly #onUncertainMcp: ((scope: ProjectMcpLeaseScope) => Promise<void>) | undefined;
  readonly #clock: () => number;

  constructor(options: {
    readonly projects: Pick<ProjectService, 'get'>;
    readonly access: Pick<ProjectAccessService, 'get' | 'listForProject'>;
    readonly environment: EnvironmentOperationsPort;
    readonly gateway: EnvironmentOperationsGateway;
    readonly catalog: EnvironmentOperationsCatalog;
    readonly enrollments: EnvironmentOperationsEnrollments;
    readonly pool: Pick<EnvironmentPool, 'getLease' | 'markRecovering'>;
    readonly store: RemoteOperationIdentityStore;
    readonly onUncertainMcp?: (scope: ProjectMcpLeaseScope) => Promise<void>;
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

  async reconcileProjectMcpProcesses(environmentInstanceId: string): Promise<void> {
    const rows = await this.#store.listOpenMcpProcesses(environmentInstanceId);
    const liveEpoch = this.#gateway.liveFor(environmentInstanceId)?.epoch.epoch;
    for (const row of rows) {
      const lease = this.#pool.getLease(row.leaseId);
      const leaseCapability = row.holderKind === 'task' ? 'agent-run' : 'project-mcp';
      const scope: ProjectMcpLeaseScope = {
        environmentInstanceId, leaseId: row.leaseId, holderKind: row.holderKind, holderId: row.holderId,
        runId: row.runId, ...(row.taskId !== undefined ? { taskId: row.taskId } : {}), leaseCapability,
      };
      if ((row.state === 'starting' || row.state === 'running') && lease?.state === 'active' && sameMcpLease(lease, scope) && liveEpoch === row.connectionEpoch) continue;
      if (lease?.state === 'active' && sameMcpLease(lease, scope)) await this.#noteUncertainMcp(scope);
      const identity: AttachWorkspaceBindingParams = {
        projectId: row.projectId, environmentInstanceId: row.environmentInstanceId, bindingId: row.bindingId,
        generation: row.generation, connectionEpoch: row.connectionEpoch, workspaceId: row.workspaceId,
        kind: row.kind, ...(row.path !== undefined ? { path: row.path } : {}),
      };
      try {
        const stopped = await this.#environment.stopProjectMcp?.(environmentInstanceId, {
          ...identity, ...projectMcpLeaseIdentity(scope), processId: row.processId,
        });
        if (stopped?.processId === row.processId && (stopped.status === 'stopped' || (stopped.status === 'not-found' && liveEpoch === row.connectionEpoch))) {
          await this.#store.saveMcpProcess({ ...row, state: 'stopped', updatedAt: this.#clock() });
          continue;
        }
      } catch { /* Persist uncertainty below and keep the lease protected. */ }
      await this.#store.saveMcpProcess({ ...row, state: 'uncertain', updatedAt: this.#clock() }).catch(() => undefined);
      if (lease !== undefined && sameMcpLease(lease, scope)) await this.#noteUncertainMcp(scope);
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
    let processRow: RemoteMcpProcessIdentity = {
      ...authority.identity, ...leaseIdentity, fingerprint, processId, state: 'starting', updatedAt: this.#clock(),
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
          const currentLease = this.#pool.getLease(scope.leaseId);
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
    return {
      binding: {
        projectId, environmentInstanceId: scope.environmentInstanceId,
        bindingId: authority.identity.bindingId, generation: authority.identity.generation,
        connectionEpoch: authority.identity.connectionEpoch, workspaceId: authority.identity.workspaceId,
      },
      tools: catalog.tools.map(row => row.public),
      call: async (name, arguments_) => {
        if (processClosed || !processId || !processRow) return { status: 'failed', reason: 'worker-refused' };
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
        const operationIdentity: RemoteMcpOperationIdentity = {
          ...authority.identity, ...leaseIdentity, operationId, processId, toolId: origin.workerId,
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
      const normalized = normalizeOperationInput(operation, path, query);
      const operationId = randomUUID();
      const fingerprint = createHash('sha256').update(JSON.stringify([fixed, operation, normalized.path ?? '', normalized.query ?? '', normalized.failure ?? ''])).digest('hex');
      const row: RemoteOperationIdentity = { operationId, fingerprint, projectId, environmentInstanceId: access.environmentInstanceId,
        bindingId: binding.bindingId, generation: binding.generation!, connectionEpoch: epoch, workspaceId: binding.workspaceId,
        operation, state: normalized.failure ? 'failed' : 'running', updatedAt: this.#clock() };
      await this.#store.save(row);
      if (normalized.failure) return { operationId, projectId, environmentInstanceId: access.environmentInstanceId, bindingId: binding.bindingId,
        generation: binding.generation!, connectionEpoch: epoch, workspaceId: binding.workspaceId, operation, status: 'failed', failure: normalized.failure };
      const { path: workspacePath, ...bindingIdentity } = fixed;
      const request: WorkspaceFileOperationParams = {
        ...bindingIdentity,
        ...(workspacePath !== undefined ? { workspacePath } : {}),
        operationId,
        operation,
        ...(normalized.path !== undefined ? { path: normalized.path } : {}),
        ...(normalized.query !== undefined ? { query: normalized.query } : {}),
      };
      let result: RemoteWorkspaceOperationResult;
      try {
        if (!this.#environment.executeWorkspaceFileOperation) throw new Error('unsupported');
        result = await this.#environment.executeWorkspaceFileOperation(access.environmentInstanceId, request);
        await this.#assertCurrent(projectId, agentId, access.environmentInstanceId, fixed);
        if (!isBoundedRemoteResult(result, fixed, operationId, operation)) throw new Error('remote operation identity or bounds invalid');
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
    const lease = this.#pool.getLease(scope.leaseId);
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
    this.#pool.markRecovering(scope.leaseId);
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

  async #assertCurrent(projectId: string, agentId: string | undefined, environmentInstanceId: string, identity: AttachWorkspaceBindingParams): Promise<void> {
    const project = await this.#projects.get(projectId);
    if (!project || project.status !== 'active' || (agentId !== undefined && !hasAgent(project, agentId))) throw new RemoteWorkspaceUnavailableError('project-denied');
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
function sameMcpBinding(a: AttachWorkspaceBindingParams, b: AttachWorkspaceBindingParams): boolean {
  return a.projectId === b.projectId && a.environmentInstanceId === b.environmentInstanceId && a.bindingId === b.bindingId &&
    a.generation === b.generation && a.connectionEpoch === b.connectionEpoch && a.workspaceId === b.workspaceId && a.kind === b.kind && a.path === b.path;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function hasAgent(project: Awaited<ReturnType<ProjectService['get']>> & {}, agentId: string): boolean {
  if (!project) return false;
  const version = project.content.versions.find(v => v.version === project.content.currentVersion);
  return version?.memberships.some(m => m.memberId === agentId && m.memberKind === 'agent' && m.endedAt === undefined) ?? false;
}
function normalizeOperationInput(operation: 'read' | 'search', path: string | undefined, query: string | undefined): { readonly path?: string; readonly query?: string; readonly failure?: string } {
  const normalizedPath = path === undefined ? undefined : normalizeRelativePath(path);
  if (path !== undefined && normalizedPath === undefined) return { failure: 'invalid-path' };
  if (operation === 'read' && normalizedPath === undefined) return { failure: 'invalid-path' };
  if (operation === 'search' && (typeof query !== 'string' || query.length < 1 || query.length > 256)) return { failure: 'invalid-path' };
  return { ...(normalizedPath !== undefined ? { path: normalizedPath } : {}), ...(query !== undefined ? { query } : {}) };
}

function normalizeRelativePath(value: string): string | undefined {
  if (value.length > 1_024 || Buffer.byteLength(value, 'utf8') > 4_096) return undefined;
  const normalized = value.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) return undefined;
  return normalized;
}

function isBoundedRemoteResult(result: RemoteWorkspaceOperationResult, identity: AttachWorkspaceBindingParams, operationId: string, operation: 'read' | 'search'): boolean {
  if (!sameOrigin(result, identity, operationId, operation) ||
    !['completed', 'failed', 'cancelled'].includes(result.status) ||
    (result.truncated !== undefined && typeof result.truncated !== 'boolean')) return false;
  if (result.status !== 'completed') {
    return result.content === undefined && result.matches === undefined &&
      (result.path === undefined || normalizeRelativePath(result.path) === result.path) &&
      (result.failure === undefined || (typeof result.failure === 'string' && result.failure.length <= 64));
  }
  if (result.failure !== undefined) return false;
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

function sameOrigin(result: RemoteWorkspaceOperationResult, identity: AttachWorkspaceBindingParams, operationId: string, operation: 'read' | 'search'): boolean {
  return result.operationId === operationId && result.projectId === identity.projectId && result.environmentInstanceId === identity.environmentInstanceId &&
    result.bindingId === identity.bindingId && result.generation === identity.generation && result.connectionEpoch === identity.connectionEpoch &&
    result.workspaceId === identity.workspaceId && result.operation === operation;
}
