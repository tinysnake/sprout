import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, basename, join } from 'node:path';

import { CodexEngineAdapter, type CodexProcess } from './codex.ts';
import { JsonRpcError, JsonRpcTransportError, LineJsonRpcTransport } from './jsonrpc.ts';
import type { CodexDynamicToolSpec } from './codex-tools.ts';
import type { EngineSession, StartSessionRequest } from './port.ts';
import type { HostEngineReadiness, HostRunEngineAdapter } from './host-profile.ts';
import { macOsTimezoneFiles } from './host-runtime-files.ts';

export const CODEX_HOST_VERSION = '0.159.3';
/** #248's host-authority-exclusion prerequisite is unresolved; production adoption stays closed. */
export const HOST_CODEX_PRODUCTION_ADOPTION_ENABLED = false;
export const HOST_CODEX_PRODUCTION_BLOCK_REASON =
  'Production Host-run Codex is blocked while the #248 host-authority-exclusion prerequisite remains unresolved.';
const MODEL_PAGE_SIZE = 200;
const DYNAMIC_TOOL_PROBE: CodexDynamicToolSpec = {
  type: 'function',
  name: 'sprout_probe_tool',
  description: 'Non-inference Host-run capability check.',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};
const CODEX_SERVER_ARGS = [
  '--disable', 'shell_tool',
  '--disable', 'apps',
  '--disable', 'plugins',
  '--disable', 'browser_use',
  '--disable', 'browser_use_external',
  '--disable', 'computer_use',
  '--disable', 'code_mode',
  '--disable', 'code_mode_host',
  '-c', 'mcp_servers={}',
  '-c', 'web_search="disabled"',
] as const;

const CODEX_DISABLED_FEATURES = [
  'shell_tool', 'apps', 'plugins', 'browser_use', 'browser_use_external', 'computer_use', 'code_mode', 'code_mode_host',
] as const;

export interface HostCodexReadiness extends HostEngineReadiness {
  readonly engine: 'codex';
  readonly supportedEfforts?: readonly string[];
  readonly probeFailure?: HostCodexProbeFailure;
}

export interface HostCodexProbeFailure {
  readonly step: 'prepare readiness directory' | 'build isolation profile' | 'launch app-server' | 'initialize' | 'account/read' | 'model/list' | 'experimentalFeature/list' | 'thread/start' | 'probe';
  readonly reason: 'timed out' | 'transport closed' | 'permission denied' | 'not found' | 'JSON-RPC error' | 'probe error';
}

const HOST_CODEX_PROBE_STEPS: readonly HostCodexProbeFailure['step'][] = [
  'prepare readiness directory', 'build isolation profile', 'launch app-server', 'initialize',
  'account/read', 'model/list', 'experimentalFeature/list', 'thread/start', 'probe',
];

class HostCodexProbeError extends Error {
  readonly failure: HostCodexProbeFailure;
  constructor(failure: HostCodexProbeFailure) {
    super(failure.reason);
    this.failure = failure;
  }
}

function hostCodexProbeFailure(error: unknown, fallbackStep: HostCodexProbeFailure['step'] = 'probe'): HostCodexProbeFailure {
  if (error instanceof HostCodexProbeError) return error.failure;
  const candidateStep = typeof error === 'object' && error !== null && 'method' in error && typeof error.method === 'string'
    ? error.method : fallbackStep;
  const step = HOST_CODEX_PROBE_STEPS.includes(candidateStep as HostCodexProbeFailure['step'])
    ? candidateStep as HostCodexProbeFailure['step'] : fallbackStep;
  const message = error instanceof Error ? error.message : '';
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  const reason: HostCodexProbeFailure['reason'] = message === 'Codex profile probe timed out' || message.startsWith('Codex profile probe timed out:')
    ? 'timed out'
    : error instanceof JsonRpcTransportError || message === 'transport closed'
      ? 'transport closed'
      : error instanceof JsonRpcError
        ? 'JSON-RPC error'
        : code === 'EACCES' || code === 'EPERM'
          ? 'permission denied'
          : code === 'ENOENT'
            ? 'not found'
            : 'probe error';
  return { step, reason };
}

function withProbeStep<T>(step: HostCodexProbeFailure['step'], operation: () => T): T {
  try { return operation(); } catch (error) { throw new HostCodexProbeError(hostCodexProbeFailure(error, step)); }
}

async function probeRequest<T>(transport: LineJsonRpcTransport, method: HostCodexProbeFailure['step'], params: unknown): Promise<T> {
  try { return await withTimeout(transport.request<T>(method, params), 15_000); }
  catch (error) { throw new HostCodexProbeError(hostCodexProbeFailure(error, method)); }
}

export interface HostCodexAdapterOptions {
  readonly binaryPath: string;
  readonly model: string;
  readonly runnerRoot?: string;
  readonly codexHome?: string;
  readonly clock?: () => number;
  readonly probeProcess?: (input: HostCodexProbeInput) => Promise<HostCodexReadiness>;
  readonly spawnProcess?: (input: HostCodexLaunchInput, args: readonly string[], env?: NodeJS.ProcessEnv) => CodexProcess;
  /** Optional local observer for the opaque provider turn identity. */
  readonly onTurnStarted?: (turnId: string) => void;
}

export interface HostCodexProbeInput {
  readonly profileId: string;
  readonly binaryPath: string;
  readonly model: string;
  readonly runnerRoot: string;
  readonly codexHome: string;
  readonly clock: () => number;
}

export interface HostCodexLaunchInput extends HostCodexProbeInput {
  readonly agentId: string;
  readonly agentRoot: string;
}

/** Codex Host profile pinned to the app-server pair verified for #248/#249. */
export class HostCodexEngineAdapter implements HostRunEngineAdapter {
  readonly id = 'codex';
  readonly capabilities = {
    streaming: 'incremental',
    supportsInterrupt: true,
    standingInstructions: 'out-of-band',
  } as const;
  readonly profileId: string;
  readonly authorizedModel: string;
  readonly #options: HostCodexAdapterOptions;
  readonly #probe: HostCodexProbeInput;
  readonly #clock: () => number;
  #efforts = new Set<string>();
  #cachedReadiness: HostCodexReadiness | undefined;
  #readinessAt = 0;

  constructor(options: HostCodexAdapterOptions) {
    if (options.model.length === 0) throw new Error('Host-run Codex requires an explicit authorized model');
    this.#options = options;
    this.authorizedModel = options.model;
    this.#clock = options.clock ?? Date.now;
    const runnerRoot = options.runnerRoot ?? join(homedir(), '.sprout', 'host-runner');
    const binaryPath = resolveExecutable(options.binaryPath);
    const codexHome = realpathIfPresent(options.codexHome ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex'));
    this.profileId = hostCodexProfileId(runnerRoot);
    this.#probe = { profileId: this.profileId, binaryPath, model: options.model, runnerRoot, codexHome, clock: this.#clock };
  }

  supportsEffort(effort: string): boolean {
    return this.#efforts.has(effort);
  }

  async readiness(force = false): Promise<HostCodexReadiness> {
    if (!force && this.#cachedReadiness !== undefined && this.#clock() - this.#readinessAt < 30_000) {
      return this.#cachedReadiness;
    }
    let result: HostCodexReadiness;
    try {
      result = await (this.#options.probeProcess ?? probeHostCodex)(this.#probe);
    } catch (error) {
      result = unknownReadiness(this.profileId, this.#clock(), hostCodexProbeFailure(error));
    }
    if (result.status === 'ready') {
      this.#efforts = new Set(result.supportedEfforts ?? []);
    } else {
      this.#efforts.clear();
    }
    this.#cachedReadiness = result;
    this.#readinessAt = this.#clock();
    return result;
  }

  async startSession(request: StartSessionRequest): Promise<EngineSession> {
    if (request.model !== this.authorizedModel) {
      throw new Error('Host Codex profile does not authorize the requested model');
    }
    const readiness = await this.readiness(true);
    if (readiness.status !== 'ready') throw new Error('Host Codex readiness is not established');
    const effort = request.effort ?? 'medium';
    if (!this.supportsEffort(effort)) throw new Error('Host Codex profile does not support the requested effort');

    const agentDigest = createHash('sha256').update(request.agentId).digest('hex').slice(0, 32);
    const agentRoot = join(this.#probe.runnerRoot, this.profileId, agentDigest);
    try {
      mkdirSync(agentRoot, { recursive: true, mode: 0o700 });
      const adapter = new CodexEngineAdapter({
        binaryPath: this.#probe.binaryPath,
        args: CODEX_SERVER_ARGS,
        sandbox: 'read-only',
        sourceVersion: `codex-cli ${CODEX_HOST_VERSION}`,
        ...(this.#options.onTurnStarted !== undefined ? { onTurnStarted: this.#options.onTurnStarted } : {}),
        spawnProcess: (_binaryPath, args, env) => (this.#options.spawnProcess ?? spawnHostCodex)({
          ...this.#probe,
          agentId: request.agentId,
          agentRoot,
        }, args, env),
      });
      return await adapter.startSession({
        ...request,
        model: this.authorizedModel,
        effort,
        workingDirectory: agentRoot,
      });
    } catch {
      throw new Error('Host Codex session could not be prepared');
    }
  }
}

export function hostCodexProfileId(runnerRoot: string): string {
  const path = join(runnerRoot, 'host-codex-profile-id');
  try {
    mkdirSync(runnerRoot, { recursive: true, mode: 0o700 });
    try {
      const existing = readFileSync(path, 'utf8').trim();
      if (isUuid(existing)) return existing;
    } catch { /* Create a new opaque local identity when none exists. */ }
    const created = randomUUID();
    try { writeFileSync(path, `${created}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raced = readFileSync(path, 'utf8').trim();
      if (isUuid(raced)) return raced;
      throw error;
    }
    return created;
  } catch {
    throw new Error('host Codex profile identity is unavailable');
  }
}

async function probeHostCodex(input: HostCodexProbeInput): Promise<HostCodexReadiness> {
  const at = input.clock();
  if (process.platform !== 'darwin') return unavailableReadiness(input.profileId, at, 'unsupported');
  if (!existsSync(input.binaryPath)) return unavailableReadiness(input.profileId, at, 'missing');
  if (!existsSync('/usr/bin/sandbox-exec')) return unavailableReadiness(input.profileId, at, 'controls');
  const version = readCliVersion(input.binaryPath);
  if (version !== CODEX_HOST_VERSION) return {
    ...unavailableReadiness(input.profileId, at, 'unsupported'),
    ...(version !== undefined ? { version } : {}),
  };
  if (!existsSync(input.codexHome)) {
    return { ...unavailableReadiness(input.profileId, at, 'unknown'), authentication: 'not-ready', version: CODEX_HOST_VERSION };
  }
  let step: HostCodexProbeFailure['step'] = 'prepare readiness directory';
  let processHandle: CodexProcess | undefined;
  let transport: LineJsonRpcTransport | undefined;
  try {
    const agentRoot = join(input.runnerRoot, input.profileId, 'readiness');
    withProbeStep(step, () => mkdirSync(agentRoot, { recursive: true, mode: 0o700 }));
    const launchInput: HostCodexLaunchInput = { ...input, agentId: 'host-readiness', agentRoot };
    step = 'build isolation profile';
    const profile = withProbeStep(step, () => codexIsolationProfile({ ...launchInput, network: true }));
    step = 'launch app-server';
    processHandle = withProbeStep(step, () => spawnHostCodex(launchInput, ['app-server', '--listen', 'stdio://', ...CODEX_SERVER_ARGS], undefined, agentRoot, profile));
    transport = new LineJsonRpcTransport({ input: processHandle.stdout, output: processHandle.stdin });
    step = 'initialize';
    const initialize = await probeRequest<Record<string, unknown>>(transport, 'initialize', {
      clientInfo: { name: 'sprout-host-profile-probe', version: '0' }, capabilities: { experimentalApi: true },
    });
    transport.notify('initialized', {});
    const [account, models, features] = await Promise.all([
      probeRequest<unknown>(transport, 'account/read', {}),
      probeRequest<unknown>(transport, 'model/list', { limit: MODEL_PAGE_SIZE, includeHidden: false }),
      probeRequest<unknown>(transport, 'experimentalFeature/list', { limit: MODEL_PAGE_SIZE }),
    ]);
    const model = exactModel(models, input.model);
    let controlsReady = model !== undefined && hasAccount(account) && initialize.userAgent !== undefined && hostCodexControlsDisabled(features);
    let probeFailure: HostCodexProbeFailure | undefined;
    if (controlsReady) {
      try {
        await probeRequest(transport, 'thread/start', {
          ephemeral: true, cwd: agentRoot, model: input.model, approvalPolicy: 'never', sandbox: 'read-only',
          dynamicTools: [DYNAMIC_TOOL_PROBE],
        });
      } catch (error) {
        controlsReady = false;
        probeFailure = hostCodexProbeFailure(error, 'thread/start');
      }
    }
    const authenticated = hasAccount(account);
    const modelAvailable = model !== undefined;
    const adapterControls = controlsReady;
    const ready = authenticated && modelAvailable && adapterControls;
    return {
      profileId: input.profileId, engine: 'codex', status: ready ? 'ready' : 'unavailable',
      installation: 'ready', authentication: authenticated ? 'ready' : 'not-ready',
      modelAvailability: modelAvailable ? 'available' : 'unavailable',
      adapterControls: adapterControls ? 'ready' : 'unavailable', version: CODEX_HOST_VERSION, observedAt: at,
      ...(model !== undefined ? { supportedEfforts: model.efforts } : {}),
      ...(probeFailure !== undefined ? { probeFailure } : {}),
    };
  } catch (error) {
    return { ...unavailableReadiness(input.profileId, at, 'unknown'), version: CODEX_HOST_VERSION, probeFailure: hostCodexProbeFailure(error, step) };
  } finally {
    transport?.close();
    processHandle?.kill('SIGTERM');
  }
}

interface AvailableModel {
  readonly model: string;
  readonly efforts: readonly string[];
}

function exactModel(value: unknown, requested: string): AvailableModel | undefined {
  if (!isRecord(value) || !Array.isArray(value.data)) return undefined;
  for (const entry of value.data) {
    if (!isRecord(entry) || entry.model !== requested) continue;
    const efforts = Array.isArray(entry.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts.flatMap(item => isRecord(item) && typeof item.reasoningEffort === 'string' ? [item.reasoningEffort] : [])
      : [];
    if (efforts.length === 0) return undefined;
    return { model: requested, efforts };
  }
  return undefined;
}

function hostCodexControlsDisabled(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.data)) return false;
  const enabled = new Map(value.data.filter(isRecord).map(feature => [feature.name, feature.enabled]));
  return CODEX_DISABLED_FEATURES.every(name => enabled.get(name) === false);
}

function hasAccount(value: unknown): boolean {
  return isRecord(value) && isRecord(value.account);
}

function codexIsolationProfile(input: HostCodexLaunchInput & { readonly network: boolean }): string {
  const binary = realpathSync(input.binaryPath);
  const codexHome = realpathSync(input.codexHome);
  const agentRoot = realpathSync(input.agentRoot);
  const binaryDirectory = dirname(binary);
  const binaryRuntimeRoot = basename(binaryDirectory) === 'bin' ? dirname(binaryDirectory) : binaryDirectory;
  const processRuntimeRoot = dirname(dirname(realpathSync(process.execPath)));
  const runtimeRoots = new Set([
    binaryRuntimeRoot, dirname(realpathSync(process.execPath)), processRuntimeRoot,
    ...(existsSync('/opt/homebrew') ? ['/opt/homebrew'] : []),
    '/System', '/usr', '/bin', '/sbin', '/dev',
  ]);
  const config = join(codexHome, 'config.toml');
  const auth = join(codexHome, 'auth.json');
  const quote = (path: string): string => JSON.stringify(realpathSync(path));
  const files = [config, auth].filter(existsSync);
  const protectedFiles = [config, auth];
  const rules = [
    '(version 1)', '(allow default)', '(deny file-read*)', '(deny file-write*)', '(allow file-read-metadata)',
    '(allow file-read* (literal "/") (literal "/opt") (literal "/opt/homebrew") (literal "/opt/homebrew/opt") (literal "/opt/homebrew/Cellar") (literal "/private") (literal "/private/var") (literal "/var") (literal "/etc") (literal "/tmp"))',
    ...['/System', '/usr', '/bin', '/sbin', '/dev', '/private/etc', '/etc', ...runtimeRoots]
      .map(path => `(allow file-read* (subpath ${JSON.stringify(path)}))`),
    ...macOsTimezoneFiles().map(path => `(allow file-read-data (literal ${JSON.stringify(path)}))`),
    `(allow file-read* (subpath ${quote(agentRoot)}))`,
    `(allow file-write* (subpath ${quote(agentRoot)}))`,
    `(allow file-read* (subpath ${quote(codexHome)}))`,
    ...files.map(path => `(allow file-read* (literal ${quote(path)}))`),
    `(allow file-write* (subpath ${quote(codexHome)}))`,
    ...protectedFiles.map(path => `(deny file-write* (literal ${JSON.stringify(path)}))`),
    ...files.map(path => `(deny file-write* (literal ${quote(path)}))`),
    ...(!input.network ? ['(deny network*)'] : []),
  ];
  return rules.join('\n');
}

export function hostCodexProcessEnvironment(input: HostCodexLaunchInput, cwd = input.agentRoot): NodeJS.ProcessEnv {
  const pathEntries = new Set([
    dirname(realpathSync(process.execPath)), dirname(realpathSync(input.binaryPath)),
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ]);
  return {
    PATH: [...pathEntries].join(delimiter),
    HOME: input.agentRoot,
    CODEX_HOME: input.codexHome,
    TMPDIR: cwd,
  };
}

function spawnHostCodex(
  input: HostCodexLaunchInput,
  args: readonly string[],
  _env?: NodeJS.ProcessEnv,
  cwd = input.agentRoot,
  profile = codexIsolationProfile({ ...input, agentRoot: cwd, network: true }),
): CodexProcess {
  const child: ChildProcess = spawn('/usr/bin/sandbox-exec', ['-p', profile, realpathSync(input.binaryPath), ...args], {
    cwd,
    env: hostCodexProcessEnvironment(input, cwd),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error('Codex app-server did not expose stdio');
  child.stderr.on('data', () => undefined);
  return {
    stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
    kill: signal => {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, signal ?? 'SIGTERM'); } catch { child.kill(signal); }
      }
    },
    onExit: handler => { child.on('exit', handler); },
    onSpawnError: handler => { child.on('error', handler); },
  };
}

function readCliVersion(binaryPath: string): string | undefined {
  try {
    const result = spawnSync(binaryPath, ['--version'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const match = result.status === 0 ? /^codex-cli (\d+\.\d+\.\d+)$/.exec(result.stdout.trim()) : null;
    return match?.[1];
  } catch { return undefined; }
}

function resolveExecutable(binary: string): string {
  if (binary.includes('/')) return realpathSync(binary);
  for (const directory of (process.env['PATH'] ?? '').split(delimiter)) {
    if (directory === '') continue;
    const candidate = join(directory, binary);
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); } catch { /* try the next PATH entry */ }
  }
  throw new Error('Codex executable is unavailable');
}

function realpathIfPresent(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

function unavailableReadiness(profileId: string, observedAt: number, cause: 'missing' | 'unsupported' | 'controls' | 'unknown'): HostCodexReadiness {
  return {
    profileId, engine: 'codex', status: cause === 'unknown' ? 'unknown' : 'unavailable',
    installation: cause === 'missing' ? 'missing' : cause === 'unsupported' ? 'unsupported' : 'ready',
    authentication: 'unknown', modelAvailability: 'unknown',
    adapterControls: cause === 'controls' ? 'unavailable' : 'unknown', observedAt,
  };
}

function unknownReadiness(profileId: string, observedAt: number, probeFailure?: HostCodexProbeFailure): HostCodexReadiness {
  return { profileId, engine: 'codex', status: 'unknown', installation: 'unknown', authentication: 'unknown',
    modelAvailability: 'unknown', adapterControls: 'unknown', observedAt,
    ...(probeFailure !== undefined ? { probeFailure } : {}),
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Codex profile probe timed out')), timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

export function createProductionHostCodexAdapter(
  environment: NodeJS.ProcessEnv = process.env,
  paths: { readonly runnerRoot?: string } = {},
): HostCodexEngineAdapter | undefined {
  if (!HOST_CODEX_PRODUCTION_ADOPTION_ENABLED) return undefined;
  const model = environment['SPROUT_HOST_CODEX_MODEL'];
  if (model === undefined || model === '') return undefined;
  try {
    return new HostCodexEngineAdapter({
      binaryPath: environment['SPROUT_HOST_CODEX_BIN'] ?? 'codex',
      model,
      ...(paths.runnerRoot !== undefined ? { runnerRoot: paths.runnerRoot } : {}),
      ...(environment['CODEX_HOME'] !== undefined ? { codexHome: environment['CODEX_HOME'] } : {}),
    });
  } catch { return undefined; }
}

export function isHostCodexEffortSupported(host: HostCodexEngineAdapter, effort: string): boolean {
  return host.supportsEffort(effort);
}

export function hostCodexControlsDisabledForTest(value: unknown): boolean {
  return hostCodexControlsDisabled(value);
}

export function hostCodexLaunchFlags(): readonly string[] {
  return CODEX_SERVER_ARGS;
}

export function hostCodexIsolationProfileForTest(input: HostCodexLaunchInput): string {
  return codexIsolationProfile({ ...input, network: true });
}
