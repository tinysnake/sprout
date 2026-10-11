import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, lstat, realpath, readdir, stat, readFile, rename, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { join, relative, resolve, sep } from 'node:path';
import { sanitizeIdentifier } from '../environment/privacy.ts';
import { parseProjectMcpManifest } from './project-mcp-manifest.ts';
import type { WorkerWorkspace } from './workspace.ts';
import type {
  CancelWorkspaceFileOperationParams,
  InspectWorkspaceFileOperationParams,
  WorkspaceBindingIdentity,
  WorkspaceFileOperationParams,
  WorkspaceCommandProgress,
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
const MAX_MUTATION_FILE_BYTES = 1024 * 1024;
const MAX_MUTATION_TEXT_BYTES = 256 * 1024;
const MAX_PATCH_HUNKS = 32;
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024;
const MAX_COMMAND_CHUNK_BYTES = 1_024;
const MAX_COMMAND_DURATION_MS = 120_000;
const COMMAND_EXECUTABLES = new Set(['node', 'npm']);

interface BoundWorkspace extends WorkspaceBindingIdentity { readonly root: string }
interface WorkspaceCommandProcessControl {
  readonly signalGroup?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => boolean;
  readonly groupAlive?: (pid: number) => boolean;
  readonly gracePeriodMs?: number;
}
interface OperationState {
  readonly controller: AbortController;
  readonly fingerprint: string;
  readonly mutating: boolean;
  status: InspectWorkspaceFileOperationResult['status'];
  result?: RemoteWorkspaceOperationResult;
  cancelProcess?: () => void;
}
interface DurableMutationRecord {
  readonly operationId: string;
  readonly fingerprint: string;
  readonly status: InspectWorkspaceFileOperationResult['status'];
  readonly result?: RemoteWorkspaceOperationResult;
}

/** Worker-owned Project operation boundary with binding and generation fencing. */
export class WorkerWorkspaceFiles {
  readonly #workspace: WorkerWorkspace;
  readonly #environmentInstanceId: string;
  readonly #bindings = new Map<string, BoundWorkspace>();
  readonly #operations = new Map<string, OperationState>();
  readonly #journalDirectory: string;
  readonly #onProgress: ((progress: WorkspaceCommandProgress) => void) | undefined;
  readonly #processControl: WorkspaceCommandProcessControl;

  constructor(workspace: WorkerWorkspace, environmentInstanceId: string, onProgress?: (progress: WorkspaceCommandProgress) => void,
    processControl: WorkspaceCommandProcessControl = {}) {
    this.#workspace = workspace;
    this.#environmentInstanceId = environmentInstanceId;
    this.#journalDirectory = workspace.operationJournalDirectory();
    this.#onProgress = onProgress;
    this.#processControl = processControl;
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
      const parsed = parseProjectMcpManifest(config);
      if (parsed.status !== 'valid') return { status: 'unsupported', format: MCP_CONFIGURATION_FORMAT, servers: [] };
      const descriptors: { name: string; transport: 'stdio' | 'http' }[] = [];
      for (const server of parsed.servers) {
        const name = sanitizeIdentifier(server.name, { fallback: '', kind: 'generic', maxLength: 64 });
        if (!name) return { status: 'unsupported', format: MCP_CONFIGURATION_FORMAT, servers: [] };
        descriptors.push({ name, transport: server.transport });
      }
      return { status: 'valid', format: MCP_CONFIGURATION_FORMAT, servers: descriptors };
    } catch {
      return { status: 'invalid', format: MCP_CONFIGURATION_FORMAT, servers: [] };
    }
  }

  async prepareRunContext(input: import('./protocol.ts').RunContextParams): Promise<{ readonly prepared: true }> {
    this.#requireBinding(input);
    return this.#workspace.prepareRunContext(input);
  }

  async recycleRunContext(input: import('./protocol.ts').RunContextParams): Promise<void> {
    this.#requireBinding(input);
    return this.#workspace.recycleRunContext(input);
  }

  async inspectRunContext(input: import('./protocol.ts').RunContextParams): Promise<'present' | 'absent' | 'unknown'> {
    this.#requireBinding(input);
    return this.#workspace.inspectRunContext(input);
  }

  async execute(input: WorkspaceFileOperationParams): Promise<RemoteWorkspaceOperationResult> {
    const binding = this.#requireBinding({ ...input, ...(input.workspacePath !== undefined ? { path: input.workspacePath } : {}) });
    if (typeof input.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(input.operationId)) throw new Error('invalid operation identity');
    const inputPath = 'path' in input ? input.path ?? '' : '';
    const fingerprint = createHash('sha256').update(JSON.stringify([input.projectId, input.environmentInstanceId, input.bindingId, input.generation, input.connectionEpoch, input.workspaceId, input.kind, input.workspacePath ?? '', input.operation, inputPath, input.operation === 'search' ? input.query : '', input.operation === 'edit' ? [input.oldText, input.newText] : input.operation === 'patch' ? input.hunks : input.operation === 'command' ? [input.runId, input.executable, input.args, input.cwd ?? '', input.timeoutMs ?? 0] : []])).digest('hex');
    const mutating = input.operation === 'edit' || input.operation === 'patch' || input.operation === 'command';
    let prior = this.#operations.get(input.operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return failure(input, 'failed', 'operation-identity-conflict');
      if (prior.result) return prior.result;
      return failure(input, 'failed', 'outcome-unknown-inspect-required');
    }
    const state: OperationState = { controller: new AbortController(), fingerprint, mutating, status: 'running' };
    this.#operations.set(input.operationId, state);
    if (mutating) {
      try {
        const claim = await this.#claimMutation({ operationId: input.operationId, fingerprint, status: 'running' });
        if (!claim.claimed) {
          this.#operations.delete(input.operationId);
          if (claim.record.status === 'recovery-required') return failure(input, 'failed', 'outcome-unknown-inspect-required');
          if (claim.record.fingerprint !== fingerprint) return failure(input, 'failed', 'operation-identity-conflict');
          if (claim.record.result) return claim.record.result;
          return failure(input, 'failed', 'outcome-unknown-inspect-required');
        }
      } catch {
        if (this.#operations.get(input.operationId) === state) this.#operations.delete(input.operationId);
        return failure(input, 'failed', 'operation-journal-unavailable');
      }
    }
    try {
      const result = input.operation === 'read'
        ? await this.#read(binding, input, state.controller.signal)
        : input.operation === 'search'
          ? await this.#search(binding, input, state.controller.signal)
          : input.operation === 'edit'
            ? await this.#edit(binding, input)
            : input.operation === 'patch'
              ? await this.#patch(binding, input)
              : await this.#command(binding, input, state);
      state.result = result;
      state.status = result.status;
      if (mutating) {
        try { await this.#saveMutation({ operationId: input.operationId, fingerprint, status: result.status, result }); }
        catch {
          delete state.result;
          state.status = 'unknown';
          return failure(input, 'failed', 'outcome-unknown-inspect-required');
        }
      }
      return result;
    } catch (error) {
      const cancelled = state.controller.signal.aborted;
      const result = failure(input, cancelled ? 'cancelled' : 'failed', cancelled ? 'cancelled' : errorCode(error));
      state.result = result;
      state.status = result.status;
      if (mutating) {
        try { await this.#saveMutation({ operationId: input.operationId, fingerprint, status: result.status, result }); }
        catch { delete state.result; state.status = 'unknown'; return failure(input, 'failed', 'outcome-unknown-inspect-required'); }
      }
      return result;
    }
  }

  async inspect(input: InspectWorkspaceFileOperationParams): Promise<InspectWorkspaceFileOperationResult> {
    this.#requireBinding(input);
    const state = this.#operations.get(input.operationId);
    if (state) return { status: state.status, ...(state.result ? { result: state.result } : {}) };
    const durable = await this.#readMutation(input.operationId);
    if (!durable) return { status: 'not-found' };
    if (durable.status === 'running' || durable.status === 'cancel-requested' || durable.status === 'unknown') return { status: 'recovery-required' };
    return { status: durable.status, ...(durable.result ? { result: durable.result } : {}) };
  }

  async cancel(input: CancelWorkspaceFileOperationParams): Promise<CancelWorkspaceFileOperationResult> {
    this.#requireBinding(input);
    const state = this.#operations.get(input.operationId);
    if (!state) return { accepted: false, status: (await this.#readMutation(input.operationId))?.status ?? 'not-found' };
    if (state.status !== 'running') return { accepted: false, status: state.status };
    if (state.mutating && !state.cancelProcess) return { accepted: false, status: 'running' };
    if (state.mutating) {
      try { await this.#saveMutation({ operationId: input.operationId, fingerprint: state.fingerprint, status: 'cancel-requested' }); }
      catch { state.status = 'recovery-required'; return { accepted: false, status: 'recovery-required' }; }
    }
    state.status = 'cancel-requested';
    state.cancelProcess?.();
    state.controller.abort();
    return { accepted: true, status: 'cancel-requested' };
  }

  async #claimMutation(record: DurableMutationRecord): Promise<{ readonly claimed: boolean; readonly record: DurableMutationRecord }> {
    await mkdir(this.#journalDirectory, { recursive: true, mode: 0o700 });
    const path = this.#journalPath(record.operationId);
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
      finally { await handle.close(); }
      return { claimed: true, record };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return { claimed: false, record: (await this.#readMutation(record.operationId)) ?? { ...record, status: 'recovery-required' } };
    }
  }

  async #saveMutation(record: DurableMutationRecord): Promise<void> {
    await mkdir(this.#journalDirectory, { recursive: true, mode: 0o700 });
    const path = this.#journalPath(record.operationId);
    const existing = await this.#readMutation(record.operationId);
    if (existing && existing.fingerprint !== record.fingerprint) throw new Error('operation identity conflict');
    if (existing && ['completed','failed','cancelled','recovery-required'].includes(existing.status)) return;
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, path); }
    finally { await unlink(temporary).catch(() => undefined); }
  }

  async #readMutation(operationId: string): Promise<DurableMutationRecord | undefined> {
    const path = this.#journalPath(operationId);
    try {
      const entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 128 * 1024) throw new Error('invalid journal entry');
      const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      if (value.operationId !== operationId || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
          !['running','cancel-requested','completed','failed','cancelled','unknown','recovery-required'].includes(String(value.status))) throw new Error('invalid journal entry');
      const result = value.result as RemoteWorkspaceOperationResult | undefined;
      if (result !== undefined && (result.operationId !== operationId || !['edit','patch','command'].includes(result.operation) ||
          !['completed','failed','cancelled','recovery-required'].includes(result.status))) throw new Error('invalid journal outcome');
      return { operationId, fingerprint: value.fingerprint, status: value.status as DurableMutationRecord['status'], ...(result ? { result } : {}) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return { operationId, fingerprint: '', status: 'recovery-required' };
    }
  }

  #journalPath(operationId: string): string {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(operationId)) throw new Error('invalid operation identity');
    return join(this.#journalDirectory, `${createHash('sha256').update(operationId).digest('hex')}.json`);
  }

  async #edit(binding: BoundWorkspace, input: Extract<WorkspaceFileOperationParams, { operation: 'edit' }>): Promise<RemoteWorkspaceOperationResult> {
    const path = safeMutationRelative(input.path);
    if (typeof input.oldText !== 'string' || input.oldText.length === 0 || typeof input.newText !== 'string' ||
      Buffer.byteLength(input.oldText, 'utf8') > MAX_MUTATION_TEXT_BYTES || Buffer.byteLength(input.newText, 'utf8') > MAX_MUTATION_TEXT_BYTES) {
      return failure(input, 'failed', 'operation-limit');
    }
    const file = await containedFile(binding.root, path);
    const existing = await mutationFileText(file);
    const updated = replaceUnique(existing, input.oldText, input.newText);
    if (updated === undefined) return failure(input, 'failed', 'content-conflict');
    await writeMutationFile(file, updated, input.operationId);
    return { ...identity(input), operationId: input.operationId, operation: input.operation, status: 'completed', path, changedPaths: [path] };
  }

  async #patch(binding: BoundWorkspace, input: Extract<WorkspaceFileOperationParams, { operation: 'patch' }>): Promise<RemoteWorkspaceOperationResult> {
    const path = safeMutationRelative(input.path);
    if (!Array.isArray(input.hunks) || input.hunks.length < 1 || input.hunks.length > MAX_PATCH_HUNKS) return failure(input, 'failed', 'operation-limit');
    let inputBytes = 0;
    for (const hunk of input.hunks) {
      if (typeof hunk?.before !== 'string' || hunk.before.length === 0 || typeof hunk.after !== 'string') return failure(input, 'failed', 'invalid-patch');
      inputBytes += Buffer.byteLength(hunk.before, 'utf8') + Buffer.byteLength(hunk.after, 'utf8');
      if (inputBytes > MAX_MUTATION_TEXT_BYTES) return failure(input, 'failed', 'operation-limit');
    }
    const file = await containedFile(binding.root, path);
    let updated = await mutationFileText(file);
    for (const hunk of input.hunks) {
      const next = replaceUnique(updated, hunk.before, hunk.after);
      if (next === undefined) return failure(input, 'failed', 'content-conflict');
      updated = next;
    }
    await writeMutationFile(file, updated, input.operationId);
    return { ...identity(input), operationId: input.operationId, operation: input.operation, status: 'completed', path, changedPaths: [path] };
  }

  async #command(binding: BoundWorkspace, input: Extract<WorkspaceFileOperationParams, { operation: 'command' }>, state: OperationState): Promise<RemoteWorkspaceOperationResult> {
    if (process.platform === 'win32') return failure(input, 'failed', 'command-supervision-unsupported');
    if (!COMMAND_EXECUTABLES.has(input.executable) || input.executable.includes('/') || input.executable.includes('\\') ||
        !Array.isArray(input.args) || input.args.length > 64 || Array.from(input.args).some(arg => typeof arg !== 'string' || Buffer.byteLength(arg, 'utf8') > 4_096) ||
        Buffer.byteLength(JSON.stringify(input.args), 'utf8') > 16 * 1024) return failure(input, 'failed', 'command-not-allowed');
    const timeoutMs = input.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_COMMAND_DURATION_MS) return failure(input, 'failed', 'operation-limit');
    let cwd: string;
    try { cwd = await containedDirectory(binding.root, input.cwd === undefined || input.cwd === '.' ? '' : safeRelative(input.cwd, false)); }
    catch { return failure(input, 'failed', 'invalid-path'); }
    let runContext: string;
    try {
      if (!input.runId || input.runId.length > 512) throw new Error('run-context-unavailable');
      const { root: _root, ...contextBinding } = binding;
      runContext = await this.#workspace.runContextDirectory({ ...contextBinding, runId: input.runId });
    } catch { return failure(input, 'failed', 'run-context-unavailable'); }

    return new Promise(resolveResult => {
      const child = spawn(input.executable, [...input.args], {
        cwd,
        detached: true,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: runContext, TMPDIR: runContext, SPROUT_RUN_CONTEXT: runContext },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const outputChunks: { sequence: number; stream: 'stdout' | 'stderr'; text: string }[] = [];
      const stdout = new StringDecoder('utf8');
      const stderr = new StringDecoder('utf8');
      let outputBytes = 0;
      let sequence = 0;
      let truncated = false;
      let timedOut = false;
      let cancelRequested = false;
      let settled = false;
      let termination: Promise<boolean> | undefined;
      let spawnFailed = false;
      const append = (stream: 'stdout' | 'stderr', text: string): void => {
        const cleaned = sanitizeCommandOutput(text, binding.root, runContext);
        let chunk = '';
        let chunkBytes = 0;
        const flush = (): void => {
          if (!chunk) return;
          sequence++;
          const row = { sequence, stream, text: chunk } as const;
          outputChunks.push(row);
          try { this.#onProgress?.({ ...identity(input), operationId: input.operationId, ...row }); } catch { /* Progress observers cannot fail command execution. */ }
          chunk = '';
          chunkBytes = 0;
        };
        for (const character of cleaned) {
          const bytes = Buffer.byteLength(character, 'utf8');
          if (outputBytes + bytes > MAX_COMMAND_OUTPUT_BYTES) { truncated = true; break; }
          if (chunkBytes + bytes > MAX_COMMAND_CHUNK_BYTES) flush();
          chunk += character;
          chunkBytes += bytes;
          outputBytes += bytes;
        }
        flush();
      };
      const ensureStopped = (pid: number): Promise<boolean> => termination ??= stopProcessGroup(pid, this.#processControl);
      const requestTermination = (): void => {
        cancelRequested = true;
        if (child.pid !== undefined) void ensureStopped(child.pid);
      };
      state.cancelProcess = requestTermination;
      const timer = setTimeout(() => {
        timedOut = true;
        void this.#saveMutation({ operationId: input.operationId, fingerprint: state.fingerprint, status: 'cancel-requested' })
          .then(() => { state.status = 'cancel-requested'; requestTermination(); })
          .catch(() => { state.status = 'recovery-required'; requestTermination(); });
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => append('stdout', stdout.write(chunk)));
      child.stderr?.on('data', (chunk: Buffer) => append('stderr', stderr.write(chunk)));
      child.on('error', () => { spawnFailed = true; });
      child.on('close', (code, signal) => {
        void (async () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          append('stdout', stdout.end());
          append('stderr', stderr.end());
          const treeStopped = child.pid === undefined ? true : await ensureStopped(child.pid);
          delete state.cancelProcess;
          const output = outputChunks.map(chunk => chunk.text).join('');
          const base = { ...identity(input), operationId: input.operationId, operation: 'command' as const,
            output, outputChunks, exitCode: code, ...(truncated ? { truncated: true } : {}) };
          if (!treeStopped) {
            resolveResult({ ...base, status: 'recovery-required', failure: 'descendant-process-unknown' });
          } else if (timedOut) {
            resolveResult({ ...base, status: 'failed', failure: 'command-timeout' });
          } else if (cancelRequested) {
            resolveResult({ ...base, status: 'cancelled', failure: 'cancelled' });
          } else if (spawnFailed) {
            resolveResult({ ...base, status: 'failed', failure: 'command-start-failed' });
          } else {
            resolveResult({ ...base, status: code === 0 && signal === null ? 'completed' : 'failed',
              ...(code === 0 && signal === null ? {} : { failure: 'command-failed' }) });
          }
        })();
      });
    });
  }

  #requireBinding(input: WorkspaceBindingIdentity): BoundWorkspace {
    if (input.environmentInstanceId !== this.#environmentInstanceId) throw new Error('workspace target refused');
    const binding = this.#bindings.get(input.projectId);
    if (!binding || binding.bindingId !== input.bindingId || binding.generation !== input.generation ||
      binding.connectionEpoch !== input.connectionEpoch || binding.workspaceId !== input.workspaceId ||
      binding.kind !== input.kind || binding.path !== input.path) throw new Error('stale workspace binding');
    return binding;
  }

  async #read(binding: BoundWorkspace, input: Extract<WorkspaceFileOperationParams, { operation: 'read' }>, signal: AbortSignal): Promise<RemoteWorkspaceOperationResult> {
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

  async #search(binding: BoundWorkspace, input: Extract<WorkspaceFileOperationParams, { operation: 'search' }>, signal: AbortSignal): Promise<RemoteWorkspaceOperationResult> {
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

async function stopProcessGroup(pid: number, control: WorkspaceCommandProcessControl): Promise<boolean> {
  if (process.platform === 'win32') return false;
  const alive = control.groupAlive ?? defaultProcessGroupAlive;
  if (!alive(pid)) return true;
  const signal = control.signalGroup ?? defaultSignalProcessGroup;
  signal(pid, 'SIGTERM');
  if (await waitForProcessGroupExit(pid, alive, control.gracePeriodMs ?? 250)) return true;
  signal(pid, 'SIGKILL');
  return waitForProcessGroupExit(pid, alive, Math.max(control.gracePeriodMs ?? 250, 500));
}

async function waitForProcessGroupExit(pid: number, alive: (pid: number) => boolean, durationMs: number): Promise<boolean> {
  const deadline = Date.now() + durationMs;
  while (alive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}

function defaultProcessGroupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function defaultSignalProcessGroup(pid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean {
  try { process.kill(-pid, signal); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

function sanitizeCommandOutput(text: string, projectRoot: string, runContext: string): string {
  return text.replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split(projectRoot).join('<project>')
    .split(runContext).join('<run-context>');
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
  if (value.length > 1_024 || Buffer.byteLength(value, 'utf8') > 4_096) throw new Error('invalid-path');
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
function safeMutationRelative(value: string): string {
  const path = safeRelative(value, false);
  if (path.split('/')[0] === '.sprout') throw new Error('invalid-path');
  return path;
}

function replaceUnique(content: string, before: string, after: string): string | undefined {
  const index = content.indexOf(before);
  if (index < 0 || content.indexOf(before, index + before.length) >= 0) return undefined;
  return `${content.slice(0, index)}${after}${content.slice(index + before.length)}`;
}

async function mutationFileText(file: string): Promise<string> {
  const metadata = await stat(file);
  if (!metadata.isFile()) throw new Error('not-text');
  if (metadata.size > MAX_MUTATION_FILE_BYTES) throw new Error('file-too-large');
  const content = await readFile(file, 'utf8');
  if (content.includes('\\uFFFD')) throw new Error('not-text');
  return content;
}

async function writeMutationFile(file: string, content: string, operationId: string): Promise<void> {
  if (Buffer.byteLength(content, 'utf8') > MAX_MUTATION_FILE_BYTES) throw new Error('file-too-large');
  const metadata = await stat(file);
  if (metadata.size > MAX_MUTATION_FILE_BYTES) throw new Error('file-too-large');
  const temporary = `${file}.sprout-${createHash('sha256').update(operationId).digest('hex').slice(0, 16)}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let moved = false;
  try {
    handle = await open(temporary, 'wx', metadata.mode & 0o777);
    await handle.writeFile(content, 'utf8');
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    moved = true;
  } catch (error) {
    if (!moved) await unlink(temporary).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function identity(input: WorkspaceBindingIdentity) { return { projectId: input.projectId, environmentInstanceId: input.environmentInstanceId, bindingId: input.bindingId, generation: input.generation, connectionEpoch: input.connectionEpoch, workspaceId: input.workspaceId }; }
function failure(input: WorkspaceFileOperationParams, status: RemoteWorkspaceOperationResult['status'], reason: string): RemoteWorkspaceOperationResult {
  return { ...identity(input), operationId: input.operationId, operation: input.operation, status,
    ...('path' in input && input.path !== undefined ? { path: input.path } : {}),
    ...(input.operation === 'command' ? { output: '', outputChunks: [], exitCode: null } : {}), failure: reason };
}
function errorCode(error: unknown): string {
  if (error instanceof Error && ['invalid-path', 'not-text', 'file-too-large', 'content-conflict', 'invalid-patch', 'operation-limit', 'command-not-allowed', 'command-timeout', 'run-context-unavailable'].includes(error.message)) return error.message;
  const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  return code === 'ENOENT' ? 'not-found' : 'unsupported';
}
