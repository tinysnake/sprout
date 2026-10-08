import type { DatabaseSync } from 'node:sqlite';

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
export interface RemoteOperationIdentityStore {
  save(row: RemoteOperationIdentity): Promise<void>;
  get(operationId: string): Promise<RemoteOperationIdentity | undefined>;
}

export class MemoryRemoteOperationIdentityStore implements RemoteOperationIdentityStore {
  readonly #rows = new Map<string, RemoteOperationIdentity>();
  async save(row: RemoteOperationIdentity): Promise<void> { this.#rows.set(row.operationId, { ...row }); }
  async get(id: string): Promise<RemoteOperationIdentity | undefined> { const row = this.#rows.get(id); return row ? { ...row } : undefined; }
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
    );`);
  }
  async save(row: RemoteOperationIdentity): Promise<void> {
    this.#db.prepare(`INSERT INTO remote_workspace_operations
      (operation_id,fingerprint,project_id,environment_instance_id,binding_id,generation,connection_epoch,workspace_id,operation,state,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at
      WHERE fingerprint=excluded.fingerprint`).run(row.operationId,row.fingerprint,row.projectId,row.environmentInstanceId,row.bindingId,row.generation,row.connectionEpoch,row.workspaceId,row.operation,row.state,row.updatedAt);
  }
  async get(id: string): Promise<RemoteOperationIdentity | undefined> {
    const row = this.#db.prepare(`SELECT * FROM remote_workspace_operations WHERE operation_id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row || !['read','search'].includes(String(row.operation)) || !['running','completed','failed','cancelled'].includes(String(row.state))) return undefined;
    return { operationId: String(row.operation_id), fingerprint: String(row.fingerprint), projectId: String(row.project_id),
      environmentInstanceId: String(row.environment_instance_id), bindingId: String(row.binding_id), generation: Number(row.generation),
      connectionEpoch: Number(row.connection_epoch), workspaceId: String(row.workspace_id), operation: row.operation as 'read'|'search',
      state: row.state as RemoteOperationState, updatedAt: Number(row.updated_at) };
  }
}
