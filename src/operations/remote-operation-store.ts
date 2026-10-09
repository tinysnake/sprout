import type { DatabaseSync } from 'node:sqlite';
import type { ProjectMcpLeaseIdentity, WorkspaceBindingIdentity } from '../worker/protocol.ts';

export type RemoteOperationState = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'cancel-requested' | 'recovery-required';
export interface RemoteOperationIdentity {
  readonly operationId: string;
  readonly fingerprint: string;
  readonly projectId: string;
  readonly environmentInstanceId: string;
  readonly bindingId: string;
  readonly generation: number;
  readonly connectionEpoch: number;
  readonly workspaceId: string;
  readonly kind?: 'default' | 'relative';
  readonly path?: string;
  readonly agentId?: string;
  readonly enrollmentId?: string;
  readonly workerIdentityDigest?: string;
  readonly runId?: string;
  readonly leaseId?: string;
  readonly holderKind?: 'run' | 'task';
  readonly holderId?: string;
  readonly taskId?: string;
  readonly operation: 'read' | 'search' | 'edit' | 'patch' | 'command';
  readonly state: RemoteOperationState;
  readonly updatedAt: number;
}

export type RemoteMcpProcessState = 'starting' | 'running' | 'stopping' | 'stopped' | 'uncertain';
export type RemoteMcpOperationState = 'running' | 'completed' | 'failed' | 'uncertain' | 'resolved-uncertain';

interface RemoteMcpIdentityScope extends WorkspaceBindingIdentity, ProjectMcpLeaseIdentity {
  readonly agentId?: string;
  readonly fingerprint: string;
  readonly enrollmentId?: string;
  readonly workerIdentityDigest?: string;
  readonly updatedAt: number;
}
export interface RemoteMcpProcessIdentity extends RemoteMcpIdentityScope {
  readonly processId: string;
  readonly state: RemoteMcpProcessState;
}
export interface RemoteMcpOperationIdentity extends RemoteMcpIdentityScope {
  readonly operationId: string;
  readonly processId: string;
  readonly toolId: string;
  readonly state: RemoteMcpOperationState;
}

export type RemoteOperationClaim = 'claimed' | 'same-identity' | 'conflicting-identity';
export interface RemoteOperationIdentityStore {
  /** Atomically reserve a durable operation ID before any Worker dispatch. */
  claim(row: RemoteOperationIdentity): Promise<RemoteOperationClaim>;
  save(row: RemoteOperationIdentity): Promise<void>;
  get(operationId: string): Promise<RemoteOperationIdentity | undefined>;
  listOpenOperations(environmentInstanceId: string): Promise<readonly RemoteOperationIdentity[]>;
  saveMcpProcess(row: RemoteMcpProcessIdentity): Promise<void>;
  getMcpProcess(processId: string): Promise<RemoteMcpProcessIdentity | undefined>;
  listOpenMcpProcesses(environmentInstanceId: string): Promise<readonly RemoteMcpProcessIdentity[]>;
  saveMcpOperation(row: RemoteMcpOperationIdentity): Promise<void>;
  getMcpOperation(operationId: string): Promise<RemoteMcpOperationIdentity | undefined>;
  resolveUncertainMcpOperationsForLease(leaseId: string, updatedAt: number): Promise<void>;
  listOpenMcpOperations(environmentInstanceId: string): Promise<readonly RemoteMcpOperationIdentity[]>;
}

export class MemoryRemoteOperationIdentityStore implements RemoteOperationIdentityStore {
  readonly #rows = new Map<string, RemoteOperationIdentity>();
  readonly #mcpProcesses = new Map<string, RemoteMcpProcessIdentity>();
  readonly #mcpOperations = new Map<string, RemoteMcpOperationIdentity>();

  async claim(row: RemoteOperationIdentity): Promise<RemoteOperationClaim> {
    const prior = this.#rows.get(row.operationId);
    if (prior) return prior.fingerprint === row.fingerprint ? 'same-identity' : 'conflicting-identity';
    this.#rows.set(row.operationId, { ...row });
    return 'claimed';
  }
  async save(row: RemoteOperationIdentity): Promise<void> {
    const prior = this.#rows.get(row.operationId);
    if (prior && prior.fingerprint !== row.fingerprint) throw new Error('remote operation identity conflict');
    if (prior && isTerminal(prior.state)) return;
    this.#rows.set(row.operationId, { ...row });
  }
  async get(id: string): Promise<RemoteOperationIdentity | undefined> { const row = this.#rows.get(id); return row ? { ...row } : undefined; }
  async listOpenOperations(environmentInstanceId: string): Promise<readonly RemoteOperationIdentity[]> {
    return [...this.#rows.values()].filter(row => row.environmentInstanceId === environmentInstanceId && isOpen(row.state)).map(row => ({ ...row }));
  }
  async saveMcpProcess(row: RemoteMcpProcessIdentity): Promise<void> {
    const prior = this.#mcpProcesses.get(row.processId);
    if (prior && prior.fingerprint !== row.fingerprint) throw new Error('MCP process identity conflict');
    this.#mcpProcesses.set(row.processId, { ...row });
  }
  async getMcpProcess(id: string): Promise<RemoteMcpProcessIdentity | undefined> {
    const row = this.#mcpProcesses.get(id);
    return row ? { ...row } : undefined;
  }
  async listOpenMcpProcesses(environmentInstanceId: string): Promise<readonly RemoteMcpProcessIdentity[]> {
    return [...this.#mcpProcesses.values()].filter(row => row.environmentInstanceId === environmentInstanceId && row.state !== 'stopped').map(row => ({ ...row }));
  }
  async saveMcpOperation(row: RemoteMcpOperationIdentity): Promise<void> {
    const prior = this.#mcpOperations.get(row.operationId);
    if (prior && prior.fingerprint !== row.fingerprint) throw new Error('MCP operation identity conflict');
    if (prior?.state === 'resolved-uncertain') return;
    this.#mcpOperations.set(row.operationId, { ...row });
  }
  async getMcpOperation(id: string): Promise<RemoteMcpOperationIdentity | undefined> {
    const row = this.#mcpOperations.get(id);
    return row ? { ...row } : undefined;
  }
  async resolveUncertainMcpOperationsForLease(leaseId: string, updatedAt: number): Promise<void> {
    for (const [id, row] of this.#mcpOperations) {
      if (row.leaseId === leaseId && row.state === 'uncertain') {
        this.#mcpOperations.set(id, { ...row, state: 'resolved-uncertain', updatedAt });
      }
    }
  }
  async listOpenMcpOperations(environmentInstanceId: string): Promise<readonly RemoteMcpOperationIdentity[]> {
    return [...this.#mcpOperations.values()].filter(row => row.environmentInstanceId === environmentInstanceId && (row.state === 'running' || row.state === 'uncertain')).map(row => ({ ...row }));
  }
}

function isTerminal(state: RemoteOperationState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}
export class SqliteRemoteOperationIdentityStore implements RemoteOperationIdentityStore {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS remote_workspace_operations (
      operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, project_id TEXT NOT NULL,
      environment_instance_id TEXT NOT NULL, binding_id TEXT NOT NULL, generation INTEGER NOT NULL,
      connection_epoch INTEGER NOT NULL, workspace_id TEXT NOT NULL, run_id TEXT, lease_id TEXT,
      holder_kind TEXT, holder_id TEXT, task_id TEXT, agent_id TEXT, enrollment_id TEXT,
      worker_identity_digest TEXT, workspace_kind TEXT, workspace_path TEXT, operation TEXT NOT NULL,
      state TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS remote_project_mcp_processes (
      process_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, project_id TEXT NOT NULL,
      environment_instance_id TEXT NOT NULL, binding_id TEXT NOT NULL, generation INTEGER NOT NULL,
      connection_epoch INTEGER NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT, workspace_kind TEXT NOT NULL, workspace_path TEXT,
      lease_id TEXT NOT NULL, holder_kind TEXT NOT NULL, holder_id TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT,
      enrollment_id TEXT, worker_identity_digest TEXT, state TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS remote_project_mcp_operations (
      operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, process_id TEXT NOT NULL,
      tool_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_instance_id TEXT NOT NULL,
      binding_id TEXT NOT NULL, generation INTEGER NOT NULL, connection_epoch INTEGER NOT NULL,
      workspace_id TEXT NOT NULL, agent_id TEXT, workspace_kind TEXT NOT NULL, workspace_path TEXT, lease_id TEXT NOT NULL, holder_kind TEXT NOT NULL,
      holder_id TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT, enrollment_id TEXT,
      worker_identity_digest TEXT, state TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );`);
    const addMissingColumns = (table: string, additions: readonly (readonly [string, string])[]): void => {
      const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name));
      for (const [column, definition] of additions) {
        if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    };
    addMissingColumns('remote_workspace_operations', [['run_id', 'TEXT'], ['lease_id', 'TEXT'], ['holder_kind', 'TEXT'], ['holder_id', 'TEXT'],
      ['task_id', 'TEXT'], ['agent_id', 'TEXT'], ['enrollment_id', 'TEXT'], ['worker_identity_digest', 'TEXT'],
      ['workspace_kind', 'TEXT'], ['workspace_path', 'TEXT']]);
    addMissingColumns('remote_project_mcp_processes', [['agent_id', 'TEXT'], ['enrollment_id', 'TEXT'], ['worker_identity_digest', 'TEXT']]);
    addMissingColumns('remote_project_mcp_operations', [['agent_id', 'TEXT'], ['enrollment_id', 'TEXT'], ['worker_identity_digest', 'TEXT']]);
  }
  async claim(row: RemoteOperationIdentity): Promise<RemoteOperationClaim> {
    const inserted = this.#db.prepare(`INSERT INTO remote_workspace_operations
      (operation_id,fingerprint,project_id,environment_instance_id,binding_id,generation,connection_epoch,workspace_id,run_id,lease_id,holder_kind,holder_id,task_id,agent_id,enrollment_id,worker_identity_digest,workspace_kind,workspace_path,operation,state,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO NOTHING`)
      .run(row.operationId,row.fingerprint,row.projectId,row.environmentInstanceId,row.bindingId,row.generation,row.connectionEpoch,row.workspaceId,row.runId ?? null,row.leaseId ?? null,row.holderKind ?? null,row.holderId ?? null,row.taskId ?? null,row.agentId ?? null,row.enrollmentId ?? null,row.workerIdentityDigest ?? null,row.kind ?? null,row.path ?? null,row.operation,row.state,row.updatedAt);
    if (Number(inserted.changes) === 1) return 'claimed';
    const prior = await this.get(row.operationId);
    if (!prior) throw new Error('remote operation identity claim could not be inspected');
    return prior.fingerprint === row.fingerprint ? 'same-identity' : 'conflicting-identity';
  }
  async save(row: RemoteOperationIdentity): Promise<void> {
    const prior = await this.get(row.operationId);
    if (prior && prior.fingerprint !== row.fingerprint) throw new Error('remote operation identity conflict');
    this.#db.prepare(`INSERT INTO remote_workspace_operations
      (operation_id,fingerprint,project_id,environment_instance_id,binding_id,generation,connection_epoch,workspace_id,run_id,lease_id,holder_kind,holder_id,task_id,agent_id,enrollment_id,worker_identity_digest,workspace_kind,workspace_path,operation,state,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at
      WHERE fingerprint=excluded.fingerprint AND (remote_workspace_operations.state IN ('running','unknown','cancel-requested','recovery-required'))`)
      .run(row.operationId,row.fingerprint,row.projectId,row.environmentInstanceId,row.bindingId,row.generation,row.connectionEpoch,row.workspaceId,row.runId ?? null,row.leaseId ?? null,row.holderKind ?? null,row.holderId ?? null,row.taskId ?? null,row.agentId ?? null,row.enrollmentId ?? null,row.workerIdentityDigest ?? null,row.kind ?? null,row.path ?? null,row.operation,row.state,row.updatedAt);
  }
  async get(id: string): Promise<RemoteOperationIdentity | undefined> {
    const row = this.#db.prepare(`SELECT * FROM remote_workspace_operations WHERE operation_id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? remoteOperationFromRow(row) : undefined;
  }
  async listOpenOperations(environmentInstanceId: string): Promise<readonly RemoteOperationIdentity[]> {
    const rows = this.#db.prepare(`SELECT * FROM remote_workspace_operations WHERE environment_instance_id = ?
      AND state IN ('running','unknown','cancel-requested','recovery-required') ORDER BY updated_at, operation_id`).all(environmentInstanceId) as Record<string, unknown>[];
    return rows.map(remoteOperationFromRow).filter((row): row is RemoteOperationIdentity => row !== undefined);
  }
  async saveMcpProcess(row: RemoteMcpProcessIdentity): Promise<void> {
    const result = this.#db.prepare(`INSERT INTO remote_project_mcp_processes
      (process_id,fingerprint,project_id,environment_instance_id,binding_id,generation,connection_epoch,workspace_id,agent_id,workspace_kind,workspace_path,lease_id,holder_kind,holder_id,run_id,task_id,enrollment_id,worker_identity_digest,state,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(process_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at
      WHERE fingerprint=excluded.fingerprint`).run(row.processId,row.fingerprint,row.projectId,row.environmentInstanceId,row.bindingId,row.generation,row.connectionEpoch,row.workspaceId,row.agentId ?? null,row.kind,row.path ?? null,row.leaseId,row.holderKind,row.holderId,row.runId,row.taskId ?? null,row.enrollmentId ?? null,row.workerIdentityDigest ?? null,row.state,row.updatedAt);
    if (Number(result.changes) === 0) throw new Error('MCP process identity conflict');
  }
  async getMcpProcess(id: string): Promise<RemoteMcpProcessIdentity | undefined> {
    const row = this.#db.prepare(`SELECT * FROM remote_project_mcp_processes WHERE process_id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? processFromRow(row) : undefined;
  }
  async listOpenMcpProcesses(environmentInstanceId: string): Promise<readonly RemoteMcpProcessIdentity[]> {
    const rows = this.#db.prepare(`SELECT * FROM remote_project_mcp_processes WHERE environment_instance_id = ? AND state != 'stopped' ORDER BY updated_at`).all(environmentInstanceId) as Record<string, unknown>[];
    return rows.map(processFromRow).filter((row): row is RemoteMcpProcessIdentity => row !== undefined);
  }
  async saveMcpOperation(row: RemoteMcpOperationIdentity): Promise<void> {
    const prior = await this.getMcpOperation(row.operationId);
    if (prior && prior.fingerprint !== row.fingerprint) throw new Error('MCP operation identity conflict');
    if (prior?.state === 'resolved-uncertain') return;
    const result = this.#db.prepare(`INSERT INTO remote_project_mcp_operations
      (operation_id,fingerprint,process_id,tool_id,project_id,environment_instance_id,binding_id,generation,connection_epoch,workspace_id,agent_id,workspace_kind,workspace_path,lease_id,holder_kind,holder_id,run_id,task_id,enrollment_id,worker_identity_digest,state,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at
      WHERE fingerprint=excluded.fingerprint AND remote_project_mcp_operations.state != 'resolved-uncertain'`).run(row.operationId,row.fingerprint,row.processId,row.toolId,row.projectId,row.environmentInstanceId,row.bindingId,row.generation,row.connectionEpoch,row.workspaceId,row.agentId ?? null,row.kind,row.path ?? null,row.leaseId,row.holderKind,row.holderId,row.runId,row.taskId ?? null,row.enrollmentId ?? null,row.workerIdentityDigest ?? null,row.state,row.updatedAt);
    if (Number(result.changes) === 0) throw new Error('MCP operation identity conflict');
  }
  async getMcpOperation(id: string): Promise<RemoteMcpOperationIdentity | undefined> {
    const row = this.#db.prepare(`SELECT * FROM remote_project_mcp_operations WHERE operation_id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? operationFromRow(row) : undefined;
  }
  async resolveUncertainMcpOperationsForLease(leaseId: string, updatedAt: number): Promise<void> {
    this.#db.prepare(`UPDATE remote_project_mcp_operations SET state = 'resolved-uncertain', updated_at = ? WHERE lease_id = ? AND state = 'uncertain'`)
      .run(updatedAt, leaseId);
  }
  async listOpenMcpOperations(environmentInstanceId: string): Promise<readonly RemoteMcpOperationIdentity[]> {
    const rows = this.#db.prepare(`SELECT * FROM remote_project_mcp_operations WHERE environment_instance_id = ?
      AND state IN ('running','uncertain') ORDER BY updated_at, operation_id`).all(environmentInstanceId) as Record<string, unknown>[];
    return rows.map(operationFromRow).filter((row): row is RemoteMcpOperationIdentity => row !== undefined);
  }
}

function isOpen(state: RemoteOperationState): boolean {
  return state === 'running' || state === 'unknown' || state === 'cancel-requested' || state === 'recovery-required';
}
function remoteOperationFromRow(row: Record<string, unknown>): RemoteOperationIdentity | undefined {
  if (!['read','search','edit','patch','command'].includes(String(row.operation)) ||
      !['running','completed','failed','cancelled','unknown','cancel-requested','recovery-required'].includes(String(row.state)) ||
      typeof row.fingerprint !== 'string' || typeof row.project_id !== 'string' || typeof row.environment_instance_id !== 'string' ||
      typeof row.binding_id !== 'string' || !Number.isSafeInteger(Number(row.generation)) || !Number.isSafeInteger(Number(row.connection_epoch)) ||
      typeof row.workspace_id !== 'string' || !Number.isSafeInteger(Number(row.updated_at))) return undefined;
  return { operationId: String(row.operation_id), fingerprint: row.fingerprint, projectId: row.project_id,
    environmentInstanceId: row.environment_instance_id, bindingId: row.binding_id, generation: Number(row.generation),
    connectionEpoch: Number(row.connection_epoch), workspaceId: row.workspace_id,
    ...(typeof row.workspace_kind === 'string' && (row.workspace_kind === 'default' || row.workspace_kind === 'relative') ? { kind: row.workspace_kind } : {}),
    ...(typeof row.workspace_path === 'string' ? { path: row.workspace_path } : {}),
    ...(typeof row.agent_id === 'string' ? { agentId: row.agent_id } : {}),
    ...(typeof row.enrollment_id === 'string' ? { enrollmentId: row.enrollment_id } : {}),
    ...(typeof row.worker_identity_digest === 'string' ? { workerIdentityDigest: row.worker_identity_digest } : {}),
    ...(typeof row.run_id === 'string' ? { runId: row.run_id } : {}),
    ...(typeof row.lease_id === 'string' ? { leaseId: row.lease_id } : {}),
    ...(row.holder_kind === 'run' || row.holder_kind === 'task' ? { holderKind: row.holder_kind } : {}),
    ...(typeof row.holder_id === 'string' ? { holderId: row.holder_id } : {}),
    ...(typeof row.task_id === 'string' ? { taskId: row.task_id } : {}),
    operation: row.operation as RemoteOperationIdentity['operation'], state: row.state as RemoteOperationState, updatedAt: Number(row.updated_at) };
}
function processFromRow(row: Record<string, unknown>): RemoteMcpProcessIdentity | undefined {
  if (!validMcpScopeRow(row) || !['starting','running','stopping','stopped','uncertain'].includes(String(row.state))) return undefined;
  return { ...mcpScopeFromRow(row), processId: String(row.process_id), state: row.state as RemoteMcpProcessState };
}
function operationFromRow(row: Record<string, unknown>): RemoteMcpOperationIdentity | undefined {
  if (!validMcpScopeRow(row) || !['running','completed','failed','uncertain','resolved-uncertain'].includes(String(row.state))) return undefined;
  return { ...mcpScopeFromRow(row), operationId: String(row.operation_id), processId: String(row.process_id),
    toolId: String(row.tool_id), state: row.state as RemoteMcpOperationState };
}
function validMcpScopeRow(row: Record<string, unknown>): boolean {
  return typeof row.fingerprint === 'string' && typeof row.project_id === 'string' && typeof row.environment_instance_id === 'string' &&
    typeof row.binding_id === 'string' && Number.isSafeInteger(Number(row.generation)) && Number(row.generation) > 0 &&
    Number.isSafeInteger(Number(row.connection_epoch)) && Number(row.connection_epoch) > 0 && typeof row.workspace_id === 'string' &&
    (row.workspace_kind === 'default' || row.workspace_kind === 'relative') && (row.workspace_path === null || typeof row.workspace_path === 'string') &&
    typeof row.lease_id === 'string' && (row.holder_kind === 'run' || row.holder_kind === 'task') && typeof row.holder_id === 'string' &&
    typeof row.run_id === 'string' && (row.task_id === null || typeof row.task_id === 'string') && Number.isSafeInteger(Number(row.updated_at));
}
function mcpScopeFromRow(row: Record<string, unknown>): RemoteMcpIdentityScope {
  return {
    fingerprint: String(row.fingerprint), projectId: String(row.project_id), environmentInstanceId: String(row.environment_instance_id),
    bindingId: String(row.binding_id), generation: Number(row.generation), connectionEpoch: Number(row.connection_epoch),
    workspaceId: String(row.workspace_id), kind: row.workspace_kind as 'default' | 'relative',
    ...(typeof row.workspace_path === 'string' ? { path: row.workspace_path } : {}), leaseId: String(row.lease_id), holderKind: row.holder_kind as 'run' | 'task',
    holderId: String(row.holder_id), runId: String(row.run_id), ...(typeof row.task_id === 'string' ? { taskId: String(row.task_id) } : {}),
    ...(typeof row.agent_id === 'string' ? { agentId: row.agent_id } : {}),
    ...(typeof row.enrollment_id === 'string' ? { enrollmentId: row.enrollment_id } : {}),
    ...(typeof row.worker_identity_digest === 'string' ? { workerIdentityDigest: row.worker_identity_digest } : {}),
    updatedAt: Number(row.updated_at),
  };
}
