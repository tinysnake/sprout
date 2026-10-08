import type { DatabaseSync } from 'node:sqlite';

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
  readonly operation: 'read' | 'search' | 'edit' | 'patch' | 'command';
  readonly state: RemoteOperationState;
  readonly updatedAt: number;
}
export type RemoteOperationClaim = 'claimed' | 'same-identity' | 'conflicting-identity';
export interface RemoteOperationIdentityStore {
  /** Atomically reserve a durable operation ID before any Worker dispatch. */
  claim(row: RemoteOperationIdentity): Promise<RemoteOperationClaim>;
  save(row: RemoteOperationIdentity): Promise<void>;
  get(operationId: string): Promise<RemoteOperationIdentity | undefined>;
}

export class MemoryRemoteOperationIdentityStore implements RemoteOperationIdentityStore {
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
      connection_epoch INTEGER NOT NULL, workspace_id TEXT NOT NULL, operation TEXT NOT NULL,
      state TEXT NOT NULL, updated_at INTEGER NOT NULL
    );`);
  }
  async claim(row: RemoteOperationIdentity): Promise<RemoteOperationClaim> {
    const inserted = this.#db.prepare(`INSERT INTO remote_workspace_operations
      (operation_id,fingerprint,project_id,environment_instance_id,binding_id,generation,connection_epoch,workspace_id,operation,state,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO NOTHING`)
      .run(row.operationId,row.fingerprint,row.projectId,row.environmentInstanceId,row.bindingId,row.generation,row.connectionEpoch,row.workspaceId,row.operation,row.state,row.updatedAt);
    if (Number(inserted.changes) === 1) return 'claimed';
    const prior = await this.get(row.operationId);
    if (!prior) throw new Error('remote operation identity claim could not be inspected');
    return prior.fingerprint === row.fingerprint ? 'same-identity' : 'conflicting-identity';
  }
  async save(row: RemoteOperationIdentity): Promise<void> {
    const prior = await this.get(row.operationId);
    if (prior && prior.fingerprint !== row.fingerprint) throw new Error('remote operation identity conflict');
    this.#db.prepare(`INSERT INTO remote_workspace_operations
      (operation_id,fingerprint,project_id,environment_instance_id,binding_id,generation,connection_epoch,workspace_id,operation,state,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at
      WHERE fingerprint=excluded.fingerprint AND (remote_workspace_operations.state IN ('running','unknown','cancel-requested','recovery-required'))`)
      .run(row.operationId,row.fingerprint,row.projectId,row.environmentInstanceId,row.bindingId,row.generation,row.connectionEpoch,row.workspaceId,row.operation,row.state,row.updatedAt);
  }
  async get(id: string): Promise<RemoteOperationIdentity | undefined> {
    const row = this.#db.prepare(`SELECT * FROM remote_workspace_operations WHERE operation_id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row || !['read','search','edit','patch','command'].includes(String(row.operation)) || !['running','completed','failed','cancelled','unknown','cancel-requested','recovery-required'].includes(String(row.state))) return undefined;
    return { operationId: String(row.operation_id), fingerprint: String(row.fingerprint), projectId: String(row.project_id),
      environmentInstanceId: String(row.environment_instance_id), bindingId: String(row.binding_id), generation: Number(row.generation),
      connectionEpoch: Number(row.connection_epoch), workspaceId: String(row.workspace_id), operation: row.operation as RemoteOperationIdentity['operation'],
      state: row.state as RemoteOperationState, updatedAt: Number(row.updated_at) };
  }
}
