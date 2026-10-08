import { createHash } from 'node:crypto';
import { open, lstat, realpath, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { sanitizeIdentifier } from '../environment/privacy.ts';
import type { WorkerWorkspace } from './workspace.ts';
import type {
  CancelWorkspaceFileOperationParams,
  InspectWorkspaceFileOperationParams,
  WorkspaceBindingIdentity,
  WorkspaceFileOperationParams,
  CancelWorkspaceFileOperationResult,
  InspectWorkspaceFileOperationResult,
  InspectProjectMcpConfigurationParams,
  InspectProjectMcpConfigurationResult,
} from './protocol.ts';
import type { RemoteWorkspaceOperationResult } from '../engine/port.ts';

const MAX_READ_BYTES = 64 * 1024;
const MAX_SEARCH_FILES = 2_000;
const MAX_SEARCH_BYTES = 8 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 100;
const MAX_LINE_CHARS = 300;
const MAX_MCP_CONFIGURATION_BYTES = 64 * 1024;
const MCP_CONFIGURATION_FORMAT = 'claude-code-mcp-json-v1' as const;

interface BoundWorkspace extends WorkspaceBindingIdentity { readonly root: string }
interface OperationState {
  readonly controller: AbortController;
  readonly fingerprint: string;
  status: InspectWorkspaceFileOperationResult['status'];
  result?: RemoteWorkspaceOperationResult;
}

/** Worker-owned read-only Project file boundary with generation fencing. */
export class WorkerWorkspaceFiles {
  readonly #workspace: WorkerWorkspace;
  readonly #environmentInstanceId: string;
  readonly #bindings = new Map<string, BoundWorkspace>();
  readonly #operations = new Map<string, OperationState>();

  constructor(workspace: WorkerWorkspace, environmentInstanceId: string) {
    this.#workspace = workspace;
    this.#environmentInstanceId = environmentInstanceId;
  }

  async attach(input: WorkspaceBindingIdentity): Promise<void> {
    if (input.environmentInstanceId !== this.#environmentInstanceId || !validIdentity(input)) throw new Error('workspace binding refused');
    const expectedId = input.kind === 'default'
      ? token(input.projectId)
      : token(`${input.projectId}\u0000relative\u0000${input.path}`);
    if (input.workspaceId !== expectedId) throw new Error('workspace binding identity refused');
    const root = await this.#workspace.projectWorkingDirectory(input.workspaceId, input.path, input.kind);
    const previous = this.#bindings.get(input.projectId);
    if (previous && (input.generation < previous.generation || input.connectionEpoch < previous.connectionEpoch)) {
      throw new Error('stale workspace binding');
    }
    if (previous && input.generation === previous.generation &&
      (input.bindingId !== previous.bindingId || input.workspaceId !== previous.workspaceId ||
        input.kind !== previous.kind || input.path !== previous.path)) {
      throw new Error('conflicting workspace binding');
    }
    this.#bindings.set(input.projectId, { ...input, root });
  }

  inspectMcpConfiguration(input: InspectProjectMcpConfigurationParams): Promise<InspectProjectMcpConfigurationResult> {
    const binding = this.#requireBinding(input);
    if (input.format !== MCP_CONFIGURATION_FORMAT) {
      return Promise.resolve({ status: 'unsupported', format: MCP_CONFIGURATION_FORMAT, servers: [] });
    }
    return this.#inspectMcpConfiguration(binding);
  }

  async #inspectMcpConfiguration(
    binding: BoundWorkspace,
  ): Promise<InspectProjectMcpConfigurationResult> {
    const relativePath = '.mcp.json';
    let file: string;
    try { file = await containedFile(binding.root, relativePath); }
    catch (error) {
      if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { status: 'missing', format: MCP_CONFIGURATION_FORMAT, servers: [] };
      }
      return { status: 'invalid', format: MCP_CONFIGURATION_FORMAT, servers: [] };
    }
    try {
      const handle = await open(file, 'r');
      let text: string;
      try {
        const buffer = Buffer.alloc(MAX_MCP_CONFIGURATION_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_MCP_CONFIGURATION_BYTES) return { status: 'unsupported', format: MCP_CONFIGURATION_FORMAT, servers: [] };
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally { await handle.close(); }
      if (text.includes(String.fromCharCode(0xfffd))) return { status: 'invalid', format: MCP_CONFIGURATION_FORMAT, servers: [] };
      const config: unknown = JSON.parse(text);
      if (!isRecord(config) || Object.keys(config).some(key => key !== 'mcpServers') || !isRecord(config.mcpServers)) {
        return { status: 'unsupported', format: MCP_CONFIGURATION_FORMAT, servers: [] };
      }
      const servers = Object.entries(config.mcpServers);
      if (servers.length > 64) return { status: 'unsupported', format: MCP_CONFIGURATION_FORMAT, servers: [] };
      const descriptors: { name: string; transport: 'stdio' }[] = [];
      for (const [rawName, rawConfig] of servers) {
        const name = sanitizeIdentifier(rawName, { fallback: '', kind: 'generic', maxLength: 64 });
        if (!name || !validStdioDeclaration(rawConfig)) return { status: 'unsupported', format: MCP_CONFIGURATION_FORMAT, servers: [] };
        descriptors.push({ name, transport: 'stdio' });
      }
      return { status: 'valid', format: MCP_CONFIGURATION_FORMAT, servers: descriptors };
    } catch {
      return { status: 'invalid', format: MCP_CONFIGURATION_FORMAT, servers: [] };
    }
  }

  async execute(input: WorkspaceFileOperationParams): Promise<RemoteWorkspaceOperationResult> {
    const binding = this.#requireBinding({ ...input, ...(input.workspacePath !== undefined ? { path: input.workspacePath } : {}) });
    if (typeof input.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(input.operationId)) throw new Error('invalid operation identity');
    const fingerprint = JSON.stringify([input.projectId, input.environmentInstanceId, input.bindingId, input.generation, input.connectionEpoch, input.workspaceId, input.kind, input.workspacePath ?? '', input.operation, input.path ?? '', input.query ?? '']);
    const prior = this.#operations.get(input.operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('operation identity conflict');
      if (prior.result) return prior.result;
      return failure(input, 'cancelled', 'cancelled');
    }
    const state: OperationState = { controller: new AbortController(), fingerprint, status: 'running' };
    this.#operations.set(input.operationId, state);
    try {
      const result = input.operation === 'read'
        ? await this.#read(binding, input, state.controller.signal)
        : input.operation === 'search'
          ? await this.#search(binding, input, state.controller.signal)
          : failure(input, 'failed', 'unsupported');
      state.result = result;
      state.status = result.status;
      return result;
    } catch (error) {
      const cancelled = state.controller.signal.aborted;
      const result = failure(input, cancelled ? 'cancelled' : 'failed', cancelled ? 'cancelled' : errorCode(error));
      state.result = result;
      state.status = result.status;
      return result;
    }
  }

  inspect(input: InspectWorkspaceFileOperationParams): InspectWorkspaceFileOperationResult {
    this.#requireBinding(input);
    const state = this.#operations.get(input.operationId);
    if (!state) return { status: 'not-found' };
    return { status: state.status, ...(state.result ? { result: state.result } : {}) };
  }

  cancel(input: CancelWorkspaceFileOperationParams): CancelWorkspaceFileOperationResult {
    this.#requireBinding(input);
    const state = this.#operations.get(input.operationId);
    if (!state) return { accepted: false, status: 'not-found' };
    if (state.status !== 'running') return { accepted: false, status: state.status };
    state.controller.abort();
    return { accepted: true, status: 'running' };
  }

  #requireBinding(input: WorkspaceBindingIdentity): BoundWorkspace {
    if (input.environmentInstanceId !== this.#environmentInstanceId) throw new Error('workspace target refused');
    const binding = this.#bindings.get(input.projectId);
    if (!binding || binding.bindingId !== input.bindingId || binding.generation !== input.generation ||
      binding.connectionEpoch !== input.connectionEpoch || binding.workspaceId !== input.workspaceId ||
      binding.kind !== input.kind || binding.path !== input.path) throw new Error('stale workspace binding');
    return binding;
  }

  async #read(binding: BoundWorkspace, input: WorkspaceFileOperationParams, signal: AbortSignal): Promise<RemoteWorkspaceOperationResult> {
    const path = safeRelative(input.path, false);
    const file = await containedFile(binding.root, path);
    if (signal.aborted) return failure(input, 'cancelled', 'cancelled');
    const metadata = await stat(file);
    if (!metadata.isFile()) return failure(input, 'failed', 'not-text');
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(MAX_READ_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const truncated = bytesRead > MAX_READ_BYTES || metadata.size > MAX_READ_BYTES;
      const text = buffer.subarray(0, Math.min(bytesRead, MAX_READ_BYTES)).toString('utf8');
      if (text.includes('\uFFFD')) return failure(input, 'failed', 'not-text');
      return { ...identity(input), operationId: input.operationId, operation: 'read', status: 'completed', path, content: text, ...(truncated ? { truncated: true } : {}) };
    } finally { await handle.close(); }
  }

  async #search(binding: BoundWorkspace, input: WorkspaceFileOperationParams, signal: AbortSignal): Promise<RemoteWorkspaceOperationResult> {
    const query = input.query;
    if (typeof query !== 'string' || query.length < 1 || query.length > 256) return failure(input, 'failed', 'invalid-path');
    const base = input.path === undefined ? binding.root : await containedDirectory(binding.root, safeRelative(input.path, true));
    const matches: { path: string; line: number; text: string }[] = [];
    let visitedFiles = 0;
    let scannedBytes = 0;
    let truncated = false;
    const walk = async (directory: string): Promise<void> => {
      if (signal.aborted || matches.length >= MAX_SEARCH_RESULTS || visitedFiles >= MAX_SEARCH_FILES || scannedBytes >= MAX_SEARCH_BYTES) { truncated = true; return; }
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (signal.aborted || matches.length >= MAX_SEARCH_RESULTS || visitedFiles >= MAX_SEARCH_FILES || scannedBytes >= MAX_SEARCH_BYTES) { truncated = true; return; }
        const target = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { await walk(target); continue; }
        if (!entry.isFile()) continue;
        visitedFiles++;
        const resolved = await containedFile(binding.root, target);
        const info = await stat(resolved);
        if (!info.isFile()) continue;
        const remaining = MAX_SEARCH_BYTES - scannedBytes;
        const limit = Math.min(info.size, remaining, 512 * 1024);
        const handle = await open(resolved, 'r');
        let content: string;
        try {
          const buffer = Buffer.alloc(limit + (info.size > limit ? 1 : 0));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          scannedBytes += bytesRead;
          content = buffer.subarray(0, Math.min(bytesRead, limit)).toString('utf8');
          if (bytesRead > limit || info.size > limit || content.includes('\uFFFD')) { truncated = true; continue; }
        } finally { await handle.close(); }
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length && matches.length < MAX_SEARCH_RESULTS; index++) {
          const line = lines[index]!;
          if (line.includes(query)) matches.push({ path: relative(binding.root, resolved).split(sep).join('/'), line: index + 1, text: line.slice(0, MAX_LINE_CHARS) });
        }
      }
    };
    await walk(base);
    if (signal.aborted) return failure(input, 'cancelled', 'cancelled');
    return { ...identity(input), operationId: input.operationId, operation: 'search', status: 'completed', matches, ...(truncated ? { truncated: true } : {}) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validStdioDeclaration(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).some(key => !['type', 'command', 'args', 'env'].includes(key))) return false;
  if (value.type !== undefined && value.type !== 'stdio') return false;
  if (typeof value.command !== 'string' || value.command.trim() === '' || value.command.length > 512) return false;
  if (value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 100 || value.args.some(arg => typeof arg !== 'string' || arg.length > 4_096))) return false;
  if (value.env !== undefined && (!isRecord(value.env) || Object.keys(value.env).length > 64 || Object.entries(value.env).some(([key, entry]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof entry !== 'string' || entry.length > 4_096))) return false;
  return true;
}

function validIdentity(input: WorkspaceBindingIdentity): boolean {
  return typeof input.projectId === 'string' && input.projectId.length > 0 &&
    typeof input.bindingId === 'string' && input.bindingId.length > 0 &&
    Number.isSafeInteger(input.generation) && input.generation > 0 &&
    Number.isSafeInteger(input.connectionEpoch) && input.connectionEpoch > 0 &&
    typeof input.workspaceId === 'string' && input.workspaceId.length > 0 &&
    (input.kind === 'default' ? input.path === undefined : input.kind === 'relative' && typeof input.path === 'string');
}
function token(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 24); }
function safeRelative(value: string | undefined, allowRoot: boolean): string {
  if (value === undefined) { if (allowRoot) return ''; throw new Error('invalid-path'); }
  const normalized = value.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid-path');
  return normalized;
}
async function containedDirectory(root: string, path: string): Promise<string> {
  const target = path === '' ? root : resolve(root, path);
  const physical = await realpath(target);
  if (!inside(root, physical) || !(await stat(physical)).isDirectory()) throw new Error('invalid-path');
  return physical;
}
async function containedFile(root: string, path: string): Promise<string> {
  const target = resolve(root, path);
  const physical = await realpath(target);
  if (!inside(root, physical)) throw new Error('invalid-path');
  const entry = await lstat(physical);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('not-text');
  return physical;
}
function inside(root: string, path: string): boolean { return path === root || path.startsWith(`${root}${sep}`); }
function identity(input: WorkspaceBindingIdentity) { return { projectId: input.projectId, environmentInstanceId: input.environmentInstanceId, bindingId: input.bindingId, generation: input.generation, connectionEpoch: input.connectionEpoch, workspaceId: input.workspaceId }; }
function failure(input: WorkspaceFileOperationParams, status: RemoteWorkspaceOperationResult['status'], reason: string): RemoteWorkspaceOperationResult {
  return { ...identity(input), operationId: input.operationId, operation: input.operation, status, ...(input.path !== undefined ? { path: input.path } : {}), failure: reason };
}
function errorCode(error: unknown): string {
  if (error instanceof Error && ['invalid-path', 'not-text'].includes(error.message)) return error.message;
  const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  return code === 'ENOENT' ? 'not-found' : 'unsupported';
}
