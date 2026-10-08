import { randomUUID, createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, join, sep } from 'node:path';
import { redactSensitiveText, sanitizeIdentifier, sanitizeOperatorText } from '../environment/privacy.ts';
import type {
  AttachWorkspaceBindingParams,
  CallProjectMcpToolParams,
  CallProjectMcpToolResult,
  ProjectMcpLeaseIdentity,
  ProjectMcpToolDeclaration,
  StartProjectMcpParams,
  StartProjectMcpResult,
  StopProjectMcpParams,
  StopProjectMcpResult,
  WorkspaceBindingIdentity,
} from './protocol.ts';
import type { WorkerWorkspace } from './workspace.ts';

const MANIFEST = '.mcp.json';
const FORMAT = 'claude-code-mcp-json-v1';
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SERVER_COUNT = 16;
const MAX_TOOL_COUNT = 64;
const MAX_TOTAL_TOOLS = 128;
const MAX_SCHEMA_BYTES = 24 * 1024;
const MAX_RESULT_CHARS = 32 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const PROTOCOL_VERSION = '2025-06-18';

type JsonRecord = Record<string, unknown>;
interface Binding extends WorkspaceBindingIdentity { readonly root: string }
interface LeaseScope extends ProjectMcpLeaseIdentity {}
interface ToolOrigin {
  readonly declaration: ProjectMcpToolDeclaration;
  readonly rawName: string;
  readonly schema: JsonRecord;
}
export interface ProjectMcpClient {
  discoverTools(): Promise<readonly { readonly name: string; readonly description: string; readonly inputSchema: unknown }[]>;
  callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<JsonRecord>;
  close(): Promise<boolean>;
}
export type ProjectMcpClientLauncher = (
  server: { readonly name: string; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> },
  cwd: string,
  onCreated: (client: ProjectMcpClient) => void,
) => Promise<ProjectMcpClient>;
interface McpServerProcess {
  readonly name: string;
  readonly client: ProjectMcpClient;
  readonly tools: Map<string, ToolOrigin>;
  readonly secretValues: readonly string[];
}
interface ProjectMcpProcess {
  readonly id: string;
  readonly binding: Binding;
  readonly lease: LeaseScope;
  readonly servers: readonly McpServerProcess[];
  readonly catalog: StartProjectMcpResult;
  readonly operations: Map<string, { readonly fingerprint: string; readonly result: CallProjectMcpToolResult }>;
}
interface ManifestServer { readonly name: string; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> }

/** Worker-local stdio supervision for the selected Project MCP manifest. */
export class WorkerProjectMcp {
  readonly #workspace: WorkerWorkspace;
  readonly #environmentInstanceId: string;
  readonly #bindings = new Map<string, Binding>();
  readonly #processes = new Map<string, ProjectMcpProcess>();
  readonly #launchClient: ProjectMcpClientLauncher;

  constructor(workspace: WorkerWorkspace, environmentInstanceId: string, launchClient: ProjectMcpClientLauncher = StdioMcpClient.launch) {
    this.#workspace = workspace;
    this.#environmentInstanceId = environmentInstanceId;
    this.#launchClient = launchClient;
  }

  async attach(input: AttachWorkspaceBindingParams): Promise<void> {
    if (!validBinding(input, this.#environmentInstanceId)) throw new Error('workspace binding refused');
    const expected = input.kind === 'default' ? digest(input.projectId) : digest(`${input.projectId}\u0000relative\u0000${input.path}`);
    if (input.workspaceId !== expected) throw new Error('workspace binding identity refused');
    const prior = this.#bindings.get(input.projectId);
    if (prior && (input.generation < prior.generation || input.connectionEpoch < prior.connectionEpoch)) throw new Error('stale workspace binding');
    if (prior && input.generation === prior.generation && !sameBinding(prior, input)) throw new Error('conflicting workspace binding');
    if (prior && !sameBinding(prior, input)) {
      for (const process of [...this.#processes.values()].filter(row => row.binding.projectId === input.projectId)) {
        const result = await this.stop({ ...process.binding, ...process.lease, processId: process.id });
        if (result.status === 'uncertain') throw new Error('prior MCP process termination is uncertain');
      }
    }
    const root = await this.#workspace.projectWorkingDirectory(input.workspaceId, input.path, input.kind);
    this.#bindings.set(input.projectId, { ...input, root });
  }

  async start(input: StartProjectMcpParams): Promise<StartProjectMcpResult> {
    const binding = this.#requireBinding(input);
    const lease = validLease(input);
    const processId = input.processId;
    if (!/^[0-9a-f-]{36}$/i.test(processId)) return { processId, status: 'blocked', reason: 'worker-refused', servers: [] };
    if (!lease || input.format !== FORMAT) return { processId, status: 'blocked', reason: 'unsupported', servers: [] };
    const existing = this.#processes.get(processId);
    if (existing) {
      if (!sameBinding(existing.binding, binding) || !sameLease(existing.lease, lease)) throw new Error('MCP process identity conflict');
      return existing.catalog;
    }
    const manifest = await readManifest(binding.root);
    if (manifest.status !== 'valid') return { processId, status: 'blocked', reason: manifest.status, servers: [] };
    if (manifest.servers.length === 0) return { processId, status: 'ready', servers: [] };

    const servers: McpServerProcess[] = [];
    const publicServers: StartProjectMcpResult['servers'][number][] = [];
    let totalTools = 0;
    for (const declaration of manifest.servers) {
      let client: ProjectMcpClient | undefined;
      let trackedServer: McpServerProcess | undefined;
      const secretValues = Object.values(declaration.env).filter(value => value.length > 0);
      const trackClient = (created: ProjectMcpClient): void => {
        if (trackedServer) return;
        trackedServer = { name: declaration.name, client: created, tools: new Map(), secretValues };
        servers.push(trackedServer);
      };
      try {
        client = await this.#launchClient(declaration, binding.root, trackClient);
        trackClient(client);
        const serverProcess = trackedServer;
        if (!serverProcess) throw new Error('MCP child process identity was not registered');
        const advertised = await client.discoverTools();
        if (totalTools + advertised.length > MAX_TOTAL_TOOLS) {
          await client.close();
          publicServers.push({ name: sanitizeIdentifier(declaration.name, { fallback: 'unknown-server', kind: 'generic', maxLength: 64 }), status: 'unsupported', tools: [] });
          continue;
        }
        const declarations: ProjectMcpToolDeclaration[] = [];
        let rejectedDeclaration = false;
        for (const tool of advertised) {
          const safeTool = sanitizeIdentifier(tool.name, { fallback: '', kind: 'generic', maxLength: 64 });
          const safeServer = sanitizeIdentifier(declaration.name, { fallback: '', kind: 'generic', maxLength: 64 });
          const id = randomUUID();
          const safeName = sanitizeIdentifier(`${safeServer}_${safeTool}`, { fallback: '', kind: 'generic', maxLength: 120 });
          const description = redactMcpText(sanitizeOperatorText(tool.description, { fallback: 'No description was provided.', maxLength: 1_000 }), secretValues);
          const schema = sanitizeInputSchema(tool.inputSchema, 0, secretValues);
          if (!safeTool || !safeServer || !safeName || !schema) { rejectedDeclaration = true; continue; }
          const descriptor: ProjectMcpToolDeclaration = { id, server: safeServer, name: safeTool, description, inputSchema: schema };
          serverProcess.tools.set(id, { declaration: descriptor, rawName: tool.name, schema });
          declarations.push(descriptor);
        }
        totalTools += declarations.length;
        publicServers.push({ name: sanitizeIdentifier(declaration.name, { fallback: 'unknown-server', kind: 'generic', maxLength: 64 }), status: rejectedDeclaration ? 'unsupported' : 'ready', tools: declarations });
      } catch (error) {
        if (client) await client.close();
        publicServers.push({
          name: sanitizeIdentifier(declaration.name, { fallback: 'unknown-server', kind: 'generic', maxLength: 64 }),
          status: error instanceof SpawnMissingError ? 'missing-dependency' : 'unsupported',
          tools: [],
        });
      }
    }
    const ready = publicServers.filter(server => server.status === 'ready').length;
    const available = publicServers.some(server => server.status === 'ready' || server.tools.length > 0);
    const catalog: StartProjectMcpResult = {
      processId,
      status: ready === publicServers.length ? 'ready' : available ? 'partial' : 'blocked',
      ...(!available ? { reason: publicServers.some(server => server.status === 'missing-dependency') ? 'missing' as const : 'unsupported' as const } : {}),
      servers: publicServers,
    };
    this.#processes.set(processId, { id: processId, binding, lease, servers, catalog, operations: new Map() });
    return catalog;
  }

  async call(input: CallProjectMcpToolParams): Promise<CallProjectMcpToolResult> {
    const binding = this.#requireBinding(input);
    const process = this.#processes.get(input.processId);
    const lease = validLease(input);
    const result = (status: CallProjectMcpToolResult['status'], reason?: CallProjectMcpToolResult['reason'], text?: string): CallProjectMcpToolResult => ({
      processId: input.processId, operationId: input.operationId, status,
      ...(reason !== undefined ? { reason } : {}), ...(text !== undefined ? { text } : {}),
    });
    if (!/^[0-9a-f-]{36}$/i.test(input.operationId) || !process || !lease || !sameBinding(process.binding, binding) || !sameLease(process.lease, lease)) {
      return result('failed', 'worker-refused');
    }
    const origin = process.servers.flatMap(server => [...server.tools.values()].map(tool => ({ server, tool })))
      .find(entry => entry.tool.declaration.id === input.toolId);
    if (!origin) return result('failed', 'unknown-tool');
    if (!validateArguments(origin.tool.schema, input.arguments)) return result('failed', 'invalid-arguments');
    const fingerprint = createHash('sha256').update(JSON.stringify([input.toolId, input.arguments])).digest('hex');
    const prior = process.operations.get(input.operationId);
    if (prior) return prior.fingerprint === fingerprint ? prior.result : result('failed', 'worker-refused');
    if (process.operations.size >= 256) return result('failed', 'worker-refused');
    const remember = (value: CallProjectMcpToolResult): CallProjectMcpToolResult => {
      process.operations.set(input.operationId, { fingerprint, result: value });
      return value;
    };
    try {
      const response = await origin.server.client.callTool(origin.tool.rawName, input.arguments);
      if (!response || !Array.isArray(response.content) || response.content.length > 128) return remember(result('unsupported', 'invalid-result'));
      let remaining = MAX_RESULT_CHARS;
      const chunks: string[] = [];
      for (const item of response.content) {
        if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') return remember(result('unsupported', 'invalid-result'));
        if (remaining <= 0) break;
        const sanitized = redactMcpText(item.text, origin.server.secretValues).slice(0, remaining);
        chunks.push(sanitized);
        remaining -= sanitized.length;
      }
      const text = chunks.join('\n');
      return remember(response.isError === true ? result('failed', 'server-error', text) : result('completed', undefined, text));
    } catch (error) {
      return remember(result('failed', error instanceof McpTimeoutError ? 'timeout' : 'server-error'));
    }
  }

  async stop(input: StopProjectMcpParams): Promise<StopProjectMcpResult> {
    const response = (status: StopProjectMcpResult['status']): StopProjectMcpResult => ({ processId: input.processId, status });
    const process = this.#processes.get(input.processId);
    if (!process) return response('not-found');
    const binding = this.#requireBinding(input);
    const lease = validLease(input);
    if (!lease || !sameBinding(process.binding, binding) || !sameLease(process.lease, lease)) throw new Error('MCP process authority refused');
    let stopped = true;
    for (const server of process.servers) stopped = await server.client.close() && stopped;
    if (stopped) this.#processes.delete(process.id);
    return response(stopped ? 'stopped' : 'uncertain');
  }

  async shutdown(): Promise<boolean> {
    let stopped = true;
    for (const process of [...this.#processes.values()]) {
      let processStopped = true;
      for (const server of process.servers) processStopped = await server.client.close() && processStopped;
      stopped = processStopped && stopped;
      if (processStopped) this.#processes.delete(process.id);
    }
    return stopped;
  }

  #requireBinding(input: WorkspaceBindingIdentity): Binding {
    if (!validBinding(input, this.#environmentInstanceId)) throw new Error('workspace binding refused');
    const binding = this.#bindings.get(input.projectId);
    if (!binding || !sameBinding(binding, input)) throw new Error('stale workspace binding');
    return binding;
  }
}

class StdioMcpClient implements ProjectMcpClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, { resolve(value: JsonRecord): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  #buffer = '';
  #nextId = 0;
  #closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.#onData(String(chunk)));
    child.stdout.on('error', () => this.#failPending(new Error('MCP stdout closed')));
    child.stderr.on('data', () => undefined);
    child.on('error', error => this.#failPending((error as NodeJS.ErrnoException).code === 'ENOENT' ? new SpawnMissingError() : new Error('MCP process failed')));
    child.on('close', () => { this.#closed = true; this.#failPending(new Error('MCP process exited')); });
  }

  static async launch(server: ManifestServer, cwd: string, onCreated: (client: ProjectMcpClient) => void): Promise<StdioMcpClient> {
    const child = spawn(server.command, [...server.args], {
      cwd,
      env: mcpChildEnvironment(server.env),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    const client = new StdioMcpClient(child);
    onCreated(client);
    try {
      const initialized = await client.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'Sprout Worker', version: '1' },
      });
      if (initialized.protocolVersion !== PROTOCOL_VERSION || !isRecord(initialized.capabilities) || !isRecord(initialized.capabilities.tools)) {
        throw new Error('unsupported MCP initialization');
      }
      client.notify('notifications/initialized');
      return client;
    } catch (error) {
      await client.close();
      if (error instanceof SpawnMissingError) throw error;
      throw error;
    }
  }

  async discoverTools(): Promise<readonly { readonly name: string; readonly description: string; readonly inputSchema: unknown }[]> {
    const tools: { name: string; description: string; inputSchema: unknown }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.request('tools/list', cursor === undefined ? {} : { cursor });
      if (!Array.isArray(result.tools) || result.tools.length > MAX_TOOL_COUNT ||
          result.tools.some(tool => !isRecord(tool) || typeof tool.name !== 'string' || tool.name.length > 128)) {
        throw new Error('invalid MCP tool catalog');
      }
      for (const tool of result.tools as JsonRecord[]) {
        tools.push({ name: tool.name as string, description: typeof tool.description === 'string' ? tool.description : '', inputSchema: tool.inputSchema });
        if (tools.length > MAX_TOOL_COUNT) throw new Error('too many MCP tools');
      }
      if (result.nextCursor === undefined) return tools;
      if (typeof result.nextCursor !== 'string' || result.nextCursor.length > 512) throw new Error('invalid MCP cursor');
      cursor = result.nextCursor;
    }
    throw new Error('too many MCP pages');
  }

  async callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<JsonRecord> {
    return this.request('tools/call', { name, arguments: args });
  }

  notify(method: string): void {
    if (!this.#closed) this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  request(method: string, params: JsonRecord): Promise<JsonRecord> {
    if (this.#closed || this.#child.stdin.destroyed) return Promise.reject(new Error('MCP process is closed'));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new McpTimeoutError());
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(new Error('MCP request could not be sent'));
      });
    });
  }

  async close(): Promise<boolean> {
    if (this.#closed) return this.#child.exitCode !== null || this.#child.signalCode !== null;
    this.#child.stdin.end();
    if (await waitForExit(this.#child, 500)) { this.#closed = true; return true; }
    signalProcess(this.#child, 'SIGTERM');
    if (await waitForExit(this.#child, 1_000)) { this.#closed = true; return true; }
    signalProcess(this.#child, 'SIGKILL');
    if (await waitForExit(this.#child, 1_000)) { this.#closed = true; return true; }
    return false;
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    if (this.#buffer.length > 1024 * 1024) { this.#failPending(new Error('MCP frame too large')); this.#buffer = ''; return; }
    while (true) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      let message: unknown;
      try { message = JSON.parse(line); } catch { this.#failPending(new Error('invalid MCP frame')); continue; }
      if (!isRecord(message)) continue;
      if (typeof message.id === 'number') {
        const pending = this.#pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.#pending.delete(message.id);
        if (isRecord(message.result)) pending.resolve(message.result);
        else pending.reject(new Error('MCP request failed'));
      } else if (message.method !== undefined && message.id !== undefined) {
        this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unsupported request' } })}\n`);
      }
    }
  }

  #failPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }
}

class SpawnMissingError extends Error {}
class McpTimeoutError extends Error {}

async function readManifest(root: string): Promise<{ readonly status: 'valid'; readonly servers: readonly ManifestServer[] } | { readonly status: 'missing' | 'invalid' | 'unsupported' }> {
  try {
    const path = join(root, MANIFEST);
    const physicalRoot = await realpath(root);
    const physicalFile = await realpath(path);
    if (physicalFile !== physicalRoot && !physicalFile.startsWith(`${physicalRoot}${sep}`)) return { status: 'invalid' };
    if (!(await lstat(physicalFile)).isFile()) return { status: 'invalid' };
    const handle = await open(physicalFile, 'r');
    try {
      const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_MANIFEST_BYTES) return { status: 'unsupported' };
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      if (text.includes('\uFFFD')) return { status: 'invalid' };
      const raw: unknown = JSON.parse(text);
      if (!isRecord(raw) || Object.keys(raw).some(key => key !== 'mcpServers') || !isRecord(raw.mcpServers)) return { status: 'unsupported' };
      const entries = Object.entries(raw.mcpServers);
      if (entries.length > MAX_SERVER_COUNT) return { status: 'unsupported' };
      const servers: ManifestServer[] = [];
      for (const [name, value] of entries) {
        if (!isRecord(value) || Object.keys(value).some(key => !['type', 'command', 'args', 'env'].includes(key)) ||
            (value.type !== undefined && value.type !== 'stdio') || typeof value.command !== 'string' || value.command.trim() === '' || value.command.length > 512 ||
            value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 100 || value.args.some(arg => typeof arg !== 'string' || arg.length > 4096)) ||
            value.env !== undefined && !validEnvironment(value.env)) return { status: 'unsupported' };
        const safeName = sanitizeIdentifier(name, { fallback: '', kind: 'generic', maxLength: 64 });
        if (!safeName || servers.some(row => sanitizeIdentifier(row.name, { fallback: '', kind: 'generic' }) === safeName)) return { status: 'unsupported' };
        servers.push({ name, command: value.command, args: (value.args as string[] | undefined) ?? [], env: (value.env as Record<string, string> | undefined) ?? {} });
      }
      return { status: 'valid', servers };
    } finally { await handle.close(); }
  } catch (error) {
    return { status: typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid' };
  }
}

function sanitizeInputSchema(value: unknown, depth = 0, secretValues: readonly string[] = []): JsonRecord | undefined {
  if (!isRecord(value) || depth > 10 || Object.keys(value).length > 32) return undefined;
  const allowed = new Set(['type', 'description', 'properties', 'required', 'items', 'enum', 'additionalProperties', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']);
  if (Object.keys(value).some(key => !allowed.has(key))) return undefined;
  const type = value.type;
  if (typeof type !== 'string' || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type)) return undefined;
  const result: JsonRecord = { type };
  if (typeof value.description === 'string') result.description = redactMcpText(sanitizeOperatorText(value.description, { fallback: '', maxLength: 1_000 }), secretValues);
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length > 64 || value.enum.some(item => item !== null && !['string', 'number', 'boolean'].includes(typeof item)) ||
        value.enum.some(item => typeof item === 'string' && secretValues.some(secret => secret.length > 0 && item.includes(secret)))) return undefined;
    result.enum = value.enum;
  }
  if (type === 'object') {
    const properties = value.properties === undefined ? {} : value.properties;
    if (!isRecord(properties) || Object.keys(properties).length > 64) return undefined;
    const safeProperties: JsonRecord = {};
    for (const [key, schema] of Object.entries(properties)) {
      const safeKey = sanitizeIdentifier(key, { fallback: '', kind: 'generic', maxLength: 64 });
      const safeSchema = sanitizeInputSchema(schema, depth + 1, secretValues);
      if (!safeKey || safeKey !== key || !safeSchema) return undefined;
      safeProperties[safeKey] = safeSchema;
    }
    result.properties = safeProperties;
    if (value.required !== undefined) {
      if (!Array.isArray(value.required) || value.required.length > 64 || value.required.some(key => typeof key !== 'string' || !Object.hasOwn(safeProperties, key))) return undefined;
      result.required = value.required;
    }
    if (value.additionalProperties !== undefined) {
      if (value.additionalProperties !== false) return undefined;
      result.additionalProperties = false;
    }
  } else if (type === 'array') {
    const items = sanitizeInputSchema(value.items, depth + 1, secretValues);
    if (!items) return undefined;
    result.items = items;
  }
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    const n = value[key];
    if (n !== undefined) {
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1_000_000) return undefined;
      result[key] = n;
    }
  }
  if (JSON.stringify(result).length > MAX_SCHEMA_BYTES) return undefined;
  return result;
}

function validateArguments(schema: JsonRecord, value: Readonly<Record<string, unknown>>): boolean {
  return validateValue(schema, value, 0);
}

function validateValue(schema: JsonRecord, value: unknown, depth: number): boolean {
  if (depth > 10) return false;
  const type = schema.type;
  const minimum = typeof schema.minimum === 'number' ? schema.minimum : undefined;
  const maximum = typeof schema.maximum === 'number' ? schema.maximum : undefined;
  const minLength = typeof schema.minLength === 'number' ? schema.minLength : undefined;
  const maxLength = typeof schema.maxLength === 'number' ? schema.maxLength : undefined;
  const minItems = typeof schema.minItems === 'number' ? schema.minItems : undefined;
  const maxItems = typeof schema.maxItems === 'number' ? schema.maxItems : undefined;
  if (type === 'object') {
    if (!isRecord(value)) return false;
    const properties = schema.properties as JsonRecord;
    const required = schema.required as string[] | undefined;
    if (required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(properties, key))) return false;
    return Object.entries(value).every(([key, item]) => !Object.hasOwn(properties, key) || validateValue(properties[key] as JsonRecord, item, depth + 1));
  }
  if (type === 'array') return Array.isArray(value) && value.length <= 10_000 &&
    (minItems === undefined || value.length >= minItems) &&
    (maxItems === undefined || value.length <= maxItems) &&
    enumMatches(schema.enum, value) && value.every(item => validateValue(schema.items as JsonRecord, item, depth + 1));
  if (type === 'string') return typeof value === 'string' && value.length <= 64 * 1024 &&
    (minLength === undefined || value.length >= minLength) &&
    (maxLength === undefined || value.length <= maxLength) && enumMatches(schema.enum, value);
  if (type === 'integer') return Number.isSafeInteger(value) &&
    (minimum === undefined || (value as number) >= minimum) &&
    (maximum === undefined || (value as number) <= maximum) && enumMatches(schema.enum, value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value) &&
    (minimum === undefined || value >= minimum) &&
    (maximum === undefined || value <= maximum) && enumMatches(schema.enum, value);
  if (type === 'boolean') return typeof value === 'boolean' && enumMatches(schema.enum, value);
  return type === 'null' && value === null && enumMatches(schema.enum, value);
}

function enumMatches(enumValues: unknown, value: unknown): boolean { return enumValues === undefined || (Array.isArray(enumValues) && enumValues.some(item => item === value)); }
function validEnvironment(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.keys(value).length <= 64 && Object.entries(value).every(([key, item]) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) && typeof item === 'string' && item.length <= 4096);
}
function mcpChildEnvironment(overrides: Readonly<Record<string, string>>): Record<string, string> {
  const inheritedKeys = ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'];
  const environment: Record<string, string> = {};
  for (const key of inheritedKeys) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...overrides };
}
function redactMcpText(text: string, secretValues: readonly string[]): string {
  let result = text;
  for (const secret of [...secretValues].filter(value => value.length > 0).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join('<redacted-project-mcp-secret>');
  }
  return redactSensitiveText(result);
}
function validLease(input: ProjectMcpLeaseIdentity): LeaseScope | undefined {
  if (!input.leaseId || input.leaseId.length > 128 || !input.runId || input.runId.length > 128 || !input.holderId || input.holderId.length > 128) return undefined;
  if (input.holderKind === 'run') return input.taskId === undefined ? input : undefined;
  if (input.holderKind === 'task') return input.taskId !== undefined && input.holderId === input.taskId ? input : undefined;
  return undefined;
}
function sameLease(a: LeaseScope, b: LeaseScope): boolean { return a.leaseId === b.leaseId && a.holderKind === b.holderKind && a.holderId === b.holderId && a.runId === b.runId && a.taskId === b.taskId; }
function validBinding(input: WorkspaceBindingIdentity, environmentInstanceId: string): boolean {
  return input.environmentInstanceId === environmentInstanceId && typeof input.projectId === 'string' && input.projectId.length > 0 &&
    typeof input.bindingId === 'string' && input.bindingId.length > 0 && Number.isSafeInteger(input.generation) && input.generation > 0 &&
    Number.isSafeInteger(input.connectionEpoch) && input.connectionEpoch > 0 && typeof input.workspaceId === 'string' && input.workspaceId.length > 0 &&
    (input.kind === 'default' ? input.path === undefined : input.kind === 'relative' && typeof input.path === 'string' && !isAbsolute(input.path) && !input.path.split(/[\\/]/).some(part => part === '..' || part === '.'));
}
function sameBinding(a: WorkspaceBindingIdentity, b: WorkspaceBindingIdentity): boolean {
  return a.projectId === b.projectId && a.environmentInstanceId === b.environmentInstanceId && a.bindingId === b.bindingId && a.generation === b.generation &&
    a.connectionEpoch === b.connectionEpoch && a.workspaceId === b.workspaceId && a.kind === b.kind && a.path === b.path;
}
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}
function isRecord(value: unknown): value is JsonRecord { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function signalProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, signal); return; } catch { /* Fall through to the child handle. */ }
  }
  try { child.kill(signal); } catch { /* Termination remains uncertain until close is observed. */ }
}
function waitForExit(child: ChildProcessWithoutNullStreams, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolvePromise => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('close', onClose);
      resolvePromise(value);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), ms);
    timer.unref();
    child.once('close', onClose);
  });
}

