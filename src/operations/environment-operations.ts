import { createHash, randomUUID } from 'node:crypto';
import type { RemoteWorkspaceOperationResult, RemoteWorkspaceTools, RemoteProjectMcpTools } from '../engine/port.ts';
import type { ProjectAccessService } from '../project/access-service.ts';
import { accessIsConsistent, sanitizeWorkspaceSelection } from '../project/access.ts';
import { sanitizeIdentifier } from '../environment/privacy.ts';
import type { ProjectService } from '../project/authority-service.ts';
import { PROJECT_MCP_CONFIGURATION_FORMAT } from '../project/authority-model.ts';
import type { ProjectEnvironmentAccess, WorkspaceBinding } from '../project/access.ts';
import type { RuntimeEnvironment, WorkerGatewayView } from '../runtime.ts';
import type { EnvironmentCatalog } from '../environment/catalog.ts';
import type { EnvironmentEnrollmentService } from '../environment/enrollment-service.ts';
import type { EnvironmentPool, EnvironmentLease } from '../environment/pool.ts';
import type { RemoteOperationIdentityStore, RemoteOperationIdentity, RemoteOperationState } from './remote-operation-store.ts';
import type { AttachWorkspaceBindingParams, InspectProjectMcpConfigurationParams, InspectProjectMcpConfigurationResult, StartProjectMcpParams, CallProjectMcpToolParams, StopProjectMcpParams, StartProjectMcpResult, CallProjectMcpToolResult, StopProjectMcpResult } from '../worker/protocol.ts';

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

  async attachProjectMcpTools(
    projectId: string,
    agentId: string,
    scope: { readonly environmentInstanceId: string; readonly leaseId: string; readonly runId: string },
  ): Promise<RemoteProjectMcpTools> {
    const authority = await this.#assertProjectMcpAuthority(projectId, agentId, scope, false);
    await this.#environment.attachWorkspaceBinding?.(scope.environmentInstanceId, authority.identity);
    const startInput: StartProjectMcpParams = {
      ...authority.identity,
      format: authority.format,
      leaseId: scope.leaseId,
      holderKind: 'run',
      holderId: scope.runId,
      runId: scope.runId,
    };
    const started = await this.#environment.startProjectMcp?.(scope.environmentInstanceId, startInput);
    if (!started) throw new RemoteWorkspaceUnavailableError('unsupported');
    const catalog = safeMcpToolCatalog(started);
    if (started.status === 'blocked' || !catalog) throw new RemoteWorkspaceUnavailableError('worker-refused');
    const toolOrigins = new Map(catalog.tools.map(row => [row.public.name, row.workerId]));
    let closed = false;
    return {
      binding: {
        projectId, environmentInstanceId: scope.environmentInstanceId,
        bindingId: authority.identity.bindingId, generation: authority.identity.generation,
        connectionEpoch: authority.identity.connectionEpoch, workspaceId: authority.identity.workspaceId,
      },
      tools: catalog.tools.map(row => row.public),
      call: async (name, arguments_) => {
        if (closed) return { status: 'failed', reason: 'worker-refused' };
        const workerToolId = toolOrigins.get(name);
        if (!workerToolId || !isRecord(arguments_)) return { status: 'failed', reason: 'unknown-tool' };
        const current = await this.#assertProjectMcpAuthority(projectId, agentId, scope, false);
        if (!sameMcpBinding(current.identity, authority.identity)) return { status: 'failed', reason: 'worker-refused' };
        const input: CallProjectMcpToolParams = {
          ...authority.identity,
          leaseId: scope.leaseId, holderKind: 'run', holderId: scope.runId, runId: scope.runId,
          processId: started.processId!, toolId: workerToolId, arguments: arguments_,
        };
        const result = await this.#environment.callProjectMcpTool?.(scope.environmentInstanceId, input);
        return sanitizeMcpCallResult(result);
      },
      close: async () => {
        if (closed) return 'stopped';
        closed = true;
        if (!started.processId) return 'stopped';
        try {
          const currentLease = this.#pool.getLease(scope.leaseId);
          if (!sameMcpLease(currentLease, scope)) throw new Error('MCP lease identity changed');
          const stopInput: StopProjectMcpParams = {
            ...authority.identity,
            leaseId: scope.leaseId, holderKind: 'run', holderId: scope.runId, runId: scope.runId,
            processId: started.processId,
          };
          const stopped = await this.#environment.stopProjectMcp?.(scope.environmentInstanceId, stopInput);
          if (stopped?.status === 'stopped' || stopped?.status === 'not-found') return 'stopped';
        } catch { /* The lease remains protected below. */ }
        this.#pool.markRecovering(scope.leaseId);
        return 'uncertain';
      },
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
    scope: { readonly environmentInstanceId: string; readonly leaseId: string; readonly runId: string },
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
    if (!access || access.status !== 'active' || !binding || !accessIsConsistent(access) || access.projectId !== projectId) {
      throw new RemoteWorkspaceUnavailableError('workspace-unbound');
    }
    const candidate = await this.#blockReason(projectId, undefined, access, binding);
    if (candidate === 'capability-denied') {
      // MCP has its own explicit capability grant; it does not inherit read-only-investigation.
    } else if (candidate !== undefined && candidate !== 'lease-required') {
      throw new RemoteWorkspaceUnavailableError(candidate);
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
