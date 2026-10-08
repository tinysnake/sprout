import type { DatabaseSync } from 'node:sqlite';
import type { ProjectMcpLeaseIdentity, WorkspaceBindingIdentity } from '../worker/protocol.ts';

export type RemoteOperationState = 'running' | 'completed' | 'failed' | 'cancelled';
export interface RemoteOperationIdentity {
  readonly operationId: string;
  readonly fingerprint: string;
  readonly projectId: string;
  readonly environmentInstanceId: string;
  readonly bindingId: string;
  readonly generation: number;
  readonly connectionEpoch: number;
  readonly workspaceId: string;
  readonly operation: 'read' | 'search';
  readonly state: RemoteOperationState;
  readonly updatedAt: number;
}

export type RemoteMcpProcessState = 'starting' | 'running' | 'stopping' | 'stopped' | 'uncertain';
export type RemoteMcpOperationState = 'running' | 'completed' | 'failed' | 'uncertain';

interface RemoteMcpIdentityScope extends WorkspaceBindingIdentity, ProjectMcpLeaseIdentity {
  readonly fingerprint: string;
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

export interface RemoteOperationIdentityStore {
  save(row: RemoteOperationIdentity): Promise<void>;
  get(operationId: string): Promise<RemoteOperationIdentity | undefined>;
  saveMcpProcess(row: RemoteMcpProcessIdentity): Promise<void>;
  getMcpProcess(processId: string): Promise<RemoteMcpProcessIdentity | undefined>;
  listOpenMcpProcesses(environmentInstanceId: string): Promise<readonly RemoteMcpProcessIdentity[]>;
  saveMcpOperation(row: RemoteMcpOperationIdentity): Promise<void>;
  getMcpOperation(operationId: string): Promise<RemoteMcpOperationIdentity | undefined>;
}

export class MemoryRemoteOperationIdentityStore implements RemoteOperationIdentityStore {
  readonly #rows = new Map<string, RemoteOperationIdentity>();
  readonly #mcpProcesses = new Map<string, RemoteMcpProcessIdentity>();
  readonly #mcpOperations = new Map<string, RemoteMcpOperationIdentity>();

  async save(row: RemoteOperationIdentity): Promise<void> {
    const prior = this.#rows.get(row.operationId);
    if (prior && prior.fingerprint !== row.fingerprint) throw new Error('remote operation identity conflict');
    this.#rows.set(row.operationId, { ...row });
  }
  async get(id: string): Promise<RemoteOperationIdentity | undefined> {
    const row = this.#rows.get(id);
    return row ? { ...row } : undefined;
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
    this.#mcpOperations.set(row.operationId, { ...row });
  }
  async getMcpOperation(id: string): Promise<RemoteMcpOperationIdentity | undefined> {
    const row = this.#mcpOperations.get(id);
    return row ? { ...row } : undefined;
  }
}

export class SqliteRemoteOperationIdentityStore implements RemoteOperationIdentityStore {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS remote_workspace_operations (
      operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, project_id TEXT NOT NULL,
      environment_instance_id TEXT NOT NULL, binding_id TEXT NOT NULL, generation INTEGER NOT NULL,
      connection_epoch INTEGER NOT NULL, workspace_id TEXT NOT NULL, operation TEXT NOT NULL,
      state TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS remote_project_mcp_processes (
      process_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, project_id TEXT NOT NULL,
      environment_instance_id TEXT NOT NULL, binding_id TEXT NOT NULL, generation INTEGER NOT NULL,
      connection_epoch INTEGER NOT NULL, workspace_id TEXT NOT NULL, workspace_kind TEXT NOT NULL, workspace_path TEXT,
      lease_id TEXT NOT NULL, holder_kind TEXT NOT NULL, holder_id TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT,
      state TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS remote_project_mcp_operations (
      operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, process_id TEXT NOT NULL,
      tool_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_instance_id TEXT NOT NULL,
      binding_id TEXT NOT NULL, generation INTEGER NOT NULL, connection_epoch INTEGER NOT NULL,
      workspace_id TEXT NOT NULL, workspace_kind TEXT NOT NULL, workspace_path TEXT, lease_id TEXT NOT NULL, holder_kind TEXT NOT NULL,
      holder_id TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT, state TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );`);
  }

  async save(row: RemoteOperationIdentity): Promise<void> {
    const result = this.#db.prepare(`INSERT INTO remote_workspace_operations
      (operation_id,fingerprint,project_id,environment_instance_id,binding_id,generation,connection_epoch,workspace_id,operation,state,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at
      WHERE fingerprint=excluded.fingerprint`).run(row.operationId,row.fingerprint,row.projectId,row.environmentInstanceId,row.bindingId,row.generation,row.connectionEpoch,row.workspaceId,row.operation,row.state,row.updatedAt);
    if (Number(result.changes) === 0) throw new Error('remote operation identity conflict');
  }
  async get(id: string): Promise<RemoteOperationIdentity | undefined> {
    const row = this.#db.prepare(`SELECT * FROM remote_workspace_operations WHERE operation_id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row || !['read','search'].includes(String(row.operation)) || !['running','completed','failed','cancelled'].includes(String(row.state))) return undefined;
    return { operationId: String(row.operation_id), fingerprint: String(row.fingerprint), projectId: String(row.project_id),
      environmentInstanceId: String(row.environment_instance_id), bindingId: String(row.binding_id), generation: Number(row.generation),
      connectionEpoch: Number(row.connection_epoch), workspaceId: String(row.workspace_id), operation: row.operation as 'read'|'search',
      state: row.state as RemoteOperationState, updatedAt: Number(row.updated_at) };
  }
  async saveMcpProcess(row: RemoteMcpProcessIdentity): Promise<void> {
    const result = this.#db.prepare(`INSERT INTO remote_project_mcp_processes
      (process_id,fingerprint,project_id,environment_instance_id,binding_id,generation,connection_epoch,workspace_id,workspace_kind,workspace_path,lease_id,holder_kind,holder_id,run_id,task_id,state,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(process_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at
      WHERE fingerprint=excluded.fingerprint`).run(row.processId,row.fingerprint,row.projectId,row.environmentInstanceId,row.bindingId,row.generation,row.connectionEpoch,row.workspaceId,row.kind,row.path ?? null,row.leaseId,row.holderKind,row.holderId,row.runId,row.taskId ?? null,row.state,row.updatedAt);
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
    const result = this.#db.prepare(`INSERT INTO remote_project_mcp_operations
      (operation_id,fingerprint,process_id,tool_id,project_id,environment_instance_id,binding_id,generation,connection_epoch,workspace_id,workspace_kind,workspace_path,lease_id,holder_kind,holder_id,run_id,task_id,state,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at
      WHERE fingerprint=excluded.fingerprint`).run(row.operationId,row.fingerprint,row.processId,row.toolId,row.projectId,row.environmentInstanceId,row.bindingId,row.generation,row.connectionEpoch,row.workspaceId,row.kind,row.path ?? null,row.leaseId,row.holderKind,row.holderId,row.runId,row.taskId ?? null,row.state,row.updatedAt);
    if (Number(result.changes) === 0) throw new Error('MCP operation identity conflict');
  }
  async getMcpOperation(id: string): Promise<RemoteMcpOperationIdentity | undefined> {
    const row = this.#db.prepare(`SELECT * FROM remote_project_mcp_operations WHERE operation_id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? operationFromRow(row) : undefined;
  }
}

function processFromRow(row: Record<string, unknown>): RemoteMcpProcessIdentity | undefined {
  if (!validMcpScopeRow(row) || !['starting','running','stopping','stopped','uncertain'].includes(String(row.state))) return undefined;
  return { ...mcpScopeFromRow(row), processId: String(row.process_id), state: row.state as RemoteMcpProcessState };
}
function operationFromRow(row: Record<string, unknown>): RemoteMcpOperationIdentity | undefined {
  if (!validMcpScopeRow(row) || !['running','completed','failed','uncertain'].includes(String(row.state))) return undefined;
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
    holderId: String(row.holder_id), runId: String(row.run_id), ...(typeof row.task_id === 'string' ? { taskId: row.task_id } : {}),
    updatedAt: Number(row.updated_at),
  };
}
