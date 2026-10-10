import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventQueue } from './event-queue.ts';
import { EngineStartError, type EngineSession, type EngineTurn, type EngineTurnResult, type StartSessionRequest } from './port.ts';
import type { HostEngineReadiness, HostRunEngineAdapter } from './host-profile.ts';
import type { RemoteProjectMcpTools, RemoteWorkspaceOperationResult, RemoteWorkspaceTools } from './port.ts';
import { macOsTimezoneFiles } from './host-runtime-files.ts';
import { redactSensitiveText } from '../environment/privacy.ts';

export const CLAUDE_CODE_HOST_VERSION = '2.1.294';
/** Human-authorized value resolved from Claude Code's read-only user settings. */
export const CLAUDE_CODE_AUTHORIZED_MODEL = 'group/auto-mimo-v2-6-flash[1m]';
const AUTHORIZED_EFFORT = 'high';
const MCP_SERVER_NAME = 'sprout';
const DISALLOWED_BUILTINS = 'Bash,Read,Write,Edit,Glob,Grep,Agent,Task,Skill,ToolSearch,WebFetch,WebSearch';

export interface HostClaudeProbeFailure {
  readonly step: 'resolve CLI' | 'read user configuration' | 'verify authentication configuration' | 'verify authorized model' | 'verify effort' | 'build isolation profile' | 'launch CLI';
  readonly reason: 'not found' | 'permission denied' | 'invalid configuration' | 'unsupported version' | 'unsupported platform' | 'model mismatch' | 'effort mismatch' | 'authentication configuration missing' | 'configuration changed' | 'isolation controls unavailable' | 'probe error';
}

export interface HostClaudeReadiness extends HostEngineReadiness {
  readonly engine: 'claude';
  readonly supportedEfforts?: readonly string[];
  readonly resolvedModel?: string;
  readonly probeFailure?: HostClaudeProbeFailure;
}

export interface HostClaudeAdapterOptions {
  readonly binaryPath?: string;
  readonly settingsPath?: string;
  readonly runnerRoot?: string;
  readonly clock?: () => number;
  readonly probeProcess?: (input: HostClaudeProbeInput) => Promise<HostClaudeReadiness>;
  readonly spawnProcess?: (input: HostClaudeLaunchInput, args: readonly string[]) => ChildProcess;
}

export interface HostClaudeProbeInput {
  readonly profileId: string;
  readonly binaryPath: string;
  readonly settingsPath: string;
  readonly runnerRoot: string;
  readonly clock: () => number;
}

export interface HostClaudeLaunchInput extends HostClaudeProbeInput {
  readonly agentId: string;
  readonly agentRoot: string;
  readonly controlRoot: string;
  readonly settings: ClaudeUserSettings;
}

interface ClaudeUserSettings {
  readonly model: string;
  readonly effortLevel: string;
  readonly baseUrl: string;
  readonly hasAuthToken: boolean;
  readonly authorizationFingerprint: string;
}

export class HostClaudeEngineAdapter implements HostRunEngineAdapter {
  readonly id = 'claude';
  readonly capabilities = { streaming: 'turn', supportsInterrupt: true, standingInstructions: 'out-of-band' } as const;
  readonly profileId: string;
  readonly authorizedModel = CLAUDE_CODE_AUTHORIZED_MODEL;
  readonly #options: HostClaudeAdapterOptions;
  readonly #probe: HostClaudeProbeInput;
  readonly #clock: () => number;
  #authorizationFingerprint: string | undefined;
  #authorizedBinaryPath: string | undefined;
  #efforts = new Set<string>();
  #cachedReadiness: HostClaudeReadiness | undefined;
  #readinessAt = 0;

  constructor(options: HostClaudeAdapterOptions = {}) {
    this.#options = options;
    this.#clock = options.clock ?? Date.now;
    const runnerRoot = options.runnerRoot ?? join(homedir(), '.sprout', 'host-runner');
    this.profileId = hostClaudeProfileId(runnerRoot);
    this.#probe = {
      profileId: this.profileId,
      binaryPath: options.binaryPath ?? 'claude',
      settingsPath: options.settingsPath ?? join(homedir(), '.claude', 'settings.json'),
      runnerRoot,
      clock: this.#clock,
    };
  }

  supportsEffort(effort: string): boolean { return this.#efforts.has(effort); }

  async readiness(force = false): Promise<HostClaudeReadiness> {
    let settings: ClaudeUserSettings;
    try { settings = readClaudeUserSettings(this.#probe.settingsPath); }
    catch (error) { return this.#cacheFailure(failedReadiness(this.profileId, this.#clock(), failureFor(error))); }
    if (settings.model !== this.authorizedModel) return this.#cacheFailure(failedReadiness(this.profileId, this.#clock(), { step: 'verify authorized model', reason: 'model mismatch' }));
    if (settings.effortLevel !== AUTHORIZED_EFFORT) return this.#cacheFailure(failedReadiness(this.profileId, this.#clock(), { step: 'verify effort', reason: 'effort mismatch' }, undefined, settings.model));
    if (!settings.hasAuthToken || settings.baseUrl === '') return this.#cacheFailure(failedReadiness(this.profileId, this.#clock(), { step: 'verify authentication configuration', reason: 'authentication configuration missing' }));
    if (this.#authorizationFingerprint !== undefined && settings.authorizationFingerprint !== this.#authorizationFingerprint) {
      return this.#cacheFailure(failedReadiness(this.profileId, this.#clock(), { step: 'verify authentication configuration', reason: 'configuration changed' }));
    }
    if (!force && this.#cachedReadiness !== undefined && this.#clock() - this.#readinessAt < 30_000) return this.#cachedReadiness;
    let binaryPath: string;
    try { binaryPath = resolveExecutable(this.#probe.binaryPath); }
    catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      return this.#cacheFailure(unavailable(this.profileId, this.#clock(), code === 'EACCES' || code === 'EPERM' ? 'permission denied' : 'not found'));
    }
    const probe = { ...this.#probe, binaryPath };
    let result: HostClaudeReadiness;
    try { result = await (this.#options.probeProcess ?? probeHostClaude)(probe); }
    catch (error) { result = failedReadiness(this.profileId, this.#clock(), failureFor(error)); }
    if (result.status === 'ready') {
      try {
        const confirmed = readClaudeUserSettings(this.#probe.settingsPath);
        if (confirmed.authorizationFingerprint !== settings.authorizationFingerprint) {
          result = failedReadiness(this.profileId, this.#clock(), { step: 'verify authentication configuration', reason: 'configuration changed' });
        } else {
          this.#authorizationFingerprint = settings.authorizationFingerprint;
          this.#authorizedBinaryPath = binaryPath;
        }
      } catch (error) { result = failedReadiness(this.profileId, this.#clock(), failureFor(error)); }
    }
    if (result.status !== 'ready') this.#authorizedBinaryPath = undefined;
    this.#efforts = result.status === 'ready' ? new Set(result.supportedEfforts ?? []) : new Set();
    this.#cachedReadiness = result;
    this.#readinessAt = this.#clock();
    return result;
  }

  #cacheFailure(result: HostClaudeReadiness): HostClaudeReadiness {
    this.#efforts.clear();
    this.#authorizedBinaryPath = undefined;
    this.#cachedReadiness = result;
    this.#readinessAt = this.#clock();
    return result;
  }

  async startSession(request: StartSessionRequest): Promise<EngineSession> {
    const readiness = await this.readiness(true);
    if (readiness.status !== 'ready') throw new EngineStartError('Host Claude readiness is not established');
    if (request.model !== this.authorizedModel) throw new EngineStartError('Host Claude profile does not authorize the requested model');
    const effort = request.effort ?? AUTHORIZED_EFFORT;
    if (!this.supportsEffort(effort)) throw new EngineStartError('Host Claude profile does not support the requested effort');

    let settings: ClaudeUserSettings;
    try { settings = readClaudeUserSettings(this.#probe.settingsPath); }
    catch { throw new EngineStartError('Host Claude user configuration is unavailable'); }
    if (settings.model !== this.authorizedModel || settings.effortLevel !== effort || !settings.hasAuthToken || settings.baseUrl === '' ||
        settings.authorizationFingerprint !== this.#authorizationFingerprint) {
      throw new EngineStartError('Host Claude user configuration no longer matches the authorized profile');
    }
    const agentDigest = createHash('sha256').update(request.agentId).digest('hex').slice(0, 24);
    const agentRoot = join(this.#probe.runnerRoot, this.profileId, agentDigest);
    const controlRoot = join(tmpdir(), `sc-${createHash('sha256').update(`${this.profileId}:${request.agentId}:${randomUUID()}`).digest('hex').slice(0, 14)}`);
    const binaryPath = this.#authorizedBinaryPath;
    if (binaryPath === undefined) throw new EngineStartError('Host Claude CLI is unavailable');
    try {
      mkdirSync(agentRoot, { recursive: true, mode: 0o700 });
      mkdirSync(join(agentRoot, 'claude-config'), { recursive: true, mode: 0o700 });
      mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
      const input: HostClaudeLaunchInput = { ...this.#probe, binaryPath, agentId: request.agentId, agentRoot, controlRoot, settings };
      return await HostClaudeSession.create(input, request, this.#options.spawnProcess ?? spawnHostClaude);
    } catch (error) {
      if (error instanceof EngineStartError) throw error;
      throw new EngineStartError('Host Claude session could not be prepared');
    }
  }
}

export function hostClaudeProfileId(runnerRoot: string): string {
  const path = join(runnerRoot, 'host-claude-profile-id');
  try {
    mkdirSync(runnerRoot, { recursive: true, mode: 0o700 });
    try { const existing = readFileSync(path, 'utf8').trim(); if (isUuid(existing)) return existing; } catch { /* Create a local profile identity when absent. */ }
    const created = randomUUID();
    try { writeFileSync(path, `${created}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raced = readFileSync(path, 'utf8').trim();
      if (isUuid(raced)) return raced;
      throw error;
    }
    return created;
  } catch { throw new Error('Host Claude profile identity is unavailable'); }
}

async function probeHostClaude(input: HostClaudeProbeInput): Promise<HostClaudeReadiness> {
  const at = input.clock();
  if (process.platform !== 'darwin') return unavailable(input.profileId, at, 'unsupported platform');
  let binaryPath: string;
  try { binaryPath = resolveExecutable(input.binaryPath); }
  catch (error) { return unavailable(input.profileId, at, error instanceof Error && error.message === 'permission denied' ? 'permission denied' : 'not found'); }
  if (!existsSync('/usr/bin/sandbox-exec')) return unavailable(input.profileId, at, 'isolation controls unavailable');
  const version = readCliVersion(binaryPath);
  if (version !== CLAUDE_CODE_HOST_VERSION) return {
    ...unavailable(input.profileId, at, 'unsupported version'),
    installation: version === undefined ? 'unknown' : 'unsupported',
    ...(version !== undefined ? { version } : {}),
  };

  let settings: ClaudeUserSettings;
  try { settings = readClaudeUserSettings(input.settingsPath); }
  catch (error) { return failedReadiness(input.profileId, at, failureFor(error), version); }
  if (!settings.hasAuthToken || settings.baseUrl === '') return failedReadiness(input.profileId, at,
    { step: 'verify authentication configuration', reason: 'authentication configuration missing' }, version);
  if (settings.model !== CLAUDE_CODE_AUTHORIZED_MODEL) return failedReadiness(input.profileId, at,
    { step: 'verify authorized model', reason: 'model mismatch' }, version, settings.model);
  if (settings.effortLevel !== AUTHORIZED_EFFORT) return failedReadiness(input.profileId, at,
    { step: 'verify effort', reason: 'effort mismatch' }, version, settings.model);

  const probeRoot = join(input.runnerRoot, input.profileId, 'readiness');
  const controlRoot = join(tmpdir(), `sc-${createHash('sha256').update(`${input.profileId}:readiness`).digest('hex').slice(0, 14)}`);
  try {
    mkdirSync(probeRoot, { recursive: true, mode: 0o700 });
    mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
    const launchInput: HostClaudeLaunchInput = { ...input, binaryPath, agentId: 'readiness', agentRoot: probeRoot, controlRoot, settings };
    const profile = hostClaudeIsolationProfile(launchInput);
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, binaryPath, '--version'], {
      encoding: 'utf8', timeout: 5_000, cwd: probeRoot,
      env: claudeProcessEnvironment(launchInput), stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.error !== undefined || result.status !== 0 || result.stdout.trim() !== `${CLAUDE_CODE_HOST_VERSION} (Claude Code)`) {
      const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
      return failedReadiness(input.profileId, at, {
        step: 'launch CLI', reason: code === 'EACCES' || code === 'EPERM' ? 'permission denied' : 'probe error',
      }, version, settings.model);
    }
  } catch (error) {
    return failedReadiness(input.profileId, at, failureFor(error, 'build isolation profile'), version, settings.model);
  }
  return {
    profileId: input.profileId, engine: 'claude', status: 'ready', installation: 'ready', authentication: 'ready',
    modelAvailability: 'available', adapterControls: 'ready', version, resolvedModel: settings.model,
    supportedEfforts: [AUTHORIZED_EFFORT], observedAt: at,
  };
}

function readClaudeUserSettings(path: string): ClaudeUserSettings {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new ClaudeProbeError(failureFor(error, 'read user configuration')); }
  if (!isRecord(value) || !isRecord(value.env)) throw new ClaudeProbeError({ step: 'read user configuration', reason: 'invalid configuration' });
  const model = typeof value.model === 'string' ? value.model : '';
  const effortLevel = typeof value.effortLevel === 'string' ? value.effortLevel : '';
  const baseUrl = typeof value.env.ANTHROPIC_BASE_URL === 'string' ? value.env.ANTHROPIC_BASE_URL : '';
  const authToken = typeof value.env.ANTHROPIC_AUTH_TOKEN === 'string' && value.env.ANTHROPIC_AUTH_TOKEN.length > 0
    ? value.env.ANTHROPIC_AUTH_TOKEN
    : typeof value.env.ANTHROPIC_API_KEY === 'string' && value.env.ANTHROPIC_API_KEY.length > 0
      ? value.env.ANTHROPIC_API_KEY : '';
  const hasAuthToken = authToken !== '';
  const authorizationFingerprint = createHash('sha256').update(JSON.stringify({ model, effortLevel, baseUrl, authToken })).digest('hex');
  if (model === '' || effortLevel === '') throw new ClaudeProbeError({ step: 'read user configuration', reason: 'invalid configuration' });
  return { model, effortLevel, baseUrl, hasAuthToken, authorizationFingerprint };
}

function failureFor(error: unknown, step: HostClaudeProbeFailure['step'] = 'read user configuration'): HostClaudeProbeFailure {
  if (error instanceof ClaudeProbeError) return error.failure;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return { step, reason: code === 'ENOENT' ? 'not found' : code === 'EACCES' || code === 'EPERM' ? 'permission denied' : 'probe error' };
}

class ClaudeProbeError extends Error {
  readonly failure: HostClaudeProbeFailure;
  constructor(failure: HostClaudeProbeFailure) { super(failure.reason); this.failure = failure; }
}

function unavailable(profileId: string, observedAt: number, reason: HostClaudeProbeFailure['reason']): HostClaudeReadiness {
  const step: HostClaudeProbeFailure['step'] = reason === 'unsupported platform' || reason === 'not found' || reason === 'unsupported version' || reason === 'permission denied'
    ? 'resolve CLI' : 'build isolation profile';
  return {
    profileId, engine: 'claude', status: 'unavailable',
    installation: reason === 'not found' ? 'missing' : reason === 'unsupported platform' || reason === 'unsupported version' ? 'unsupported' : 'unknown',
    authentication: 'unknown', modelAvailability: 'unknown', adapterControls: 'unavailable', observedAt,
    probeFailure: { step, reason },
  };
}

function failedReadiness(profileId: string, observedAt: number, failure: HostClaudeProbeFailure, version?: string, resolvedModel?: string): HostClaudeReadiness {
  return {
    profileId, engine: 'claude', status: 'unavailable', installation: version === undefined ? 'unknown' : 'ready',
    authentication: failure.step === 'verify authentication configuration' ? 'not-ready' : 'unknown',
    modelAvailability: failure.step === 'verify authorized model' ? 'unavailable' : 'unknown',
    adapterControls: failure.step === 'build isolation profile' || failure.step === 'launch CLI' ? 'unavailable' : 'unknown',
    observedAt, probeFailure: failure,
    ...(version !== undefined ? { version } : {}),
    ...(resolvedModel === CLAUDE_CODE_AUTHORIZED_MODEL ? { resolvedModel } : {}),
  };
}

function readCliVersion(binaryPath: string): string | undefined {
  try {
    const result = spawnSync(binaryPath, ['--version'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const match = result.status === 0 ? /^(\d+\.\d+\.\d+) \(Claude Code\)$/.exec(result.stdout.trim()) : null;
    return match?.[1];
  } catch { return undefined; }
}

function resolveExecutable(binary: string): string {
  if (binary.includes('/')) return realpathSync(binary);
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue;
    const candidate = join(directory, binary);
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); }
    catch { /* Continue through the configured search path. */ }
  }
  throw new ClaudeProbeError({ step: 'resolve CLI', reason: 'not found' });
}

function hostClaudeIsolationProfile(input: HostClaudeLaunchInput): string {
  const cli = realpathSync(input.binaryPath);
  const packageRoot = dirname(cli);
  const nodeRoot = dirname(realpathSync(process.execPath));
  const settingsPath = realpathSync(input.settingsPath);
  const runnerRoot = realpathSync(input.agentRoot);
  const controlRoot = realpathSync(input.controlRoot);
  const authHelper = fileURLToPath(new URL('./claude-auth-helper.mjs', import.meta.url));
  const runtimeRoots = new Set([nodeRoot, dirname(nodeRoot), packageRoot, dirname(packageRoot),
    ...(existsSync('/opt/homebrew') ? ['/opt/homebrew'] : []), '/System', '/usr', '/bin', '/sbin', '/dev', '/private/etc']);
  const quote = (path: string): string => JSON.stringify(path);
  return [
    '(version 1)', '(allow default)', '(deny file-read*)', '(deny file-write*)', '(allow file-read-metadata)',
    '(allow file-read* (literal "/") (literal "/opt") (literal "/opt/homebrew") (literal "/opt/homebrew/opt") (literal "/opt/homebrew/Cellar") (literal "/private") (literal "/private/var") (literal "/var") (literal "/etc") (literal "/tmp"))',
    ...[...runtimeRoots].map(path => `(allow file-read* (subpath ${quote(path)}))`),
    ...macOsTimezoneFiles().map(path => `(allow file-read-data (literal ${quote(path)}))`),
    `(allow file-read* (subpath ${quote(runnerRoot)}))`, `(allow file-write* (subpath ${quote(runnerRoot)}))`,
    `(allow file-read* (subpath ${quote(controlRoot)}))`, `(allow file-write* (subpath ${quote(controlRoot)}))`,
    `(allow file-read* (literal ${quote(settingsPath)}))`, `(deny file-write* (literal ${quote(settingsPath)}))`,
    `(allow file-read* (literal ${quote(authHelper)}))`, '(allow file-write* (literal "/dev/null"))',
  ].join('\n');
}

function claudeProcessEnvironment(input: HostClaudeLaunchInput): NodeJS.ProcessEnv {
  const nodeDirectory = dirname(realpathSync(process.execPath));
  const cliDirectory = dirname(realpathSync(input.binaryPath));
  return {
    HOME: input.agentRoot,
    PATH: [...new Set([nodeDirectory, cliDirectory, '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(delimiter),
    TMPDIR: input.controlRoot,
    CLAUDE_CODE_TMPDIR: input.controlRoot,
    CLAUDE_CONFIG_DIR: join(input.agentRoot, 'claude-config'),
    ANTHROPIC_BASE_URL: input.settings.baseUrl,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

function spawnHostClaude(input: HostClaudeLaunchInput, args: readonly string[]): ChildProcess {
  const profile = hostClaudeIsolationProfile(input);
  return spawn('/usr/bin/sandbox-exec', ['-p', profile, realpathSync(input.binaryPath), ...args], {
    cwd: input.agentRoot, env: claudeProcessEnvironment(input), stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
}

class HostClaudeSession implements EngineSession {
  readonly sessionId: string;
  readonly #input: HostClaudeLaunchInput;
  readonly #request: StartSessionRequest;
  readonly #spawnProcess: (input: HostClaudeLaunchInput, args: readonly string[]) => ChildProcess;
  readonly #socketPath: string;
  readonly #mcpConfigPath: string;
  readonly #allowedTools: readonly ClaudeTool[];
  readonly #server: ReturnType<typeof createServer>;
  #nativeSessionId: string | undefined;
  #child: ChildProcess | undefined;
  #activeQueue: EventQueue | undefined;
  #activeFinish: ((result: EngineTurnResult) => void) | undefined;
  #closed = false;
  #turnStartedAt = 0;
  #turnText = '';
  #turnUsage: Record<string, number> | undefined;
  #initObserved = false;
  #protocolFailure = false;
  #resultObserved = false;
  #resumeRefused = false;

  private constructor(input: HostClaudeLaunchInput, request: StartSessionRequest, spawnProcess: (input: HostClaudeLaunchInput, args: readonly string[]) => ChildProcess,
    socketPath: string, mcpConfigPath: string, tools: readonly ClaudeTool[], server: ReturnType<typeof createServer>) {
    this.#input = input; this.#request = request; this.#spawnProcess = spawnProcess; this.#socketPath = socketPath;
    this.#mcpConfigPath = mcpConfigPath; this.#allowedTools = tools; this.#server = server;
    this.sessionId = request.resumeSessionKey ?? `sprout-${randomUUID()}`;
    this.#nativeSessionId = request.resumeSessionKey;
  }

  static async create(input: HostClaudeLaunchInput, request: StartSessionRequest,
    spawnProcess: (input: HostClaudeLaunchInput, args: readonly string[]) => ChildProcess): Promise<HostClaudeSession> {
    const tools = createClaudeTools(request.remoteWorkspace, request.remoteProjectMcp);
    const socketPath = join(input.controlRoot, 'm.sock');
    const mcpConfigPath = join(input.controlRoot, 'mcp.json');
    const server = createServer(socket => handleMcpSocket(socket, tools));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(socketPath, resolve);
    });
    try {
      writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: '/usr/bin/nc', args: ['-U', socketPath] } } }), { mode: 0o600 });
      return new HostClaudeSession(input, request, spawnProcess, socketPath, mcpConfigPath, tools, server);
    } catch (error) {
      server.close();
      try { const { unlinkSync } = await import('node:fs'); unlinkSync(socketPath); } catch { /* Cleanup after failed startup. */ }
      throw error;
    }
  }

  get engineSessionKey(): string | undefined { return this.#nativeSessionId; }

  run(prompt: string): EngineTurn {
    if (this.#closed || this.#activeFinish !== undefined) throw new Error('Host Claude session is not available');
    const queue = new EventQueue();
    this.#activeQueue = queue;
    const startedAt = Date.now();
    this.#turnStartedAt = startedAt;
    this.#interrupted = false;
    this.#turnText = '';
    this.#turnUsage = undefined;
    this.#initObserved = false;
    this.#protocolFailure = false;
    this.#resultObserved = false;
    this.#resumeRefused = false;
    let settled = false;
    const completion = new Promise<EngineTurnResult>(resolve => { this.#activeFinish = result => {
      if (settled) return; settled = true; this.#activeFinish = undefined; this.#activeQueue = undefined; queue.end(); resolve(result);
    }; });
    const args = this.#args();
    let child: ChildProcess;
    try { child = this.#spawnProcess(this.#input, args); }
    catch { this.#finish({ status: 'failed', message: 'Claude Code process could not start' }); return { events: queue, completion }; }
    this.#child = child;
    child.stdin?.end(prompt);
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        this.#consumeLine(line);
      }
    });
    child.stderr?.on('data', chunk => {
      const text = chunk.toString('utf8');
      if (this.#request.resumeSessionKey !== undefined && /no conversation found|unknown session|session not found/i.test(text)) this.#resumeRefused = true;
    });
    child.on('error', () => this.#finish({ status: 'failed', message: 'Claude Code process could not start' }));
    child.on('close', (code, signal) => {
      if (buffer.trim() !== '') this.#consumeLine(buffer);
      if (this.#activeFinish === undefined) return;
      if (this.#resumeRefused && this.#request.resumeSessionKey !== undefined) {
        this.#finish({ status: 'failed', message: 'Claude Code refused the requested native session', resumeRefused: true });
      } else if (this.#interrupted) {
        this.#finish({ status: 'interrupted' });
      } else if (this.#protocolFailure || !this.#initObserved || !this.#resultObserved) {
        this.#finish({ status: 'failed', message: 'Claude Code session controls could not be verified' });
      } else if (code === 0 && signal === null) {
        const usage = this.#tokenUsage();
        this.#finish({ status: 'completed', text: this.#turnText, ...(usage !== undefined ? { tokenUsage: usage } : {}),
          engineTurnDurationMs: Math.max(0, Date.now() - this.#turnStartedAt), source: 'claude-code', sourceVersion: CLAUDE_CODE_HOST_VERSION });
      } else {
        this.#finish({ status: 'failed', message: 'Claude Code turn failed' });
      }
    });
    return { events: queue, completion };
  }

  #interrupted = false;

  async interrupt(): Promise<boolean> {
    const child = this.#child;
    if (child?.pid === undefined || child.exitCode !== null || child.signalCode !== null) return false;
    this.#interrupted = true;
    try { process.kill(-child.pid, 'SIGINT'); return true; }
    catch { return false; }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const child = this.#child;
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      if (!await waitForChildClose(child, 1_000)) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        await waitForChildClose(child, 1_000);
      }
    }
    this.#server.close();
    try { const { unlinkSync } = await import('node:fs'); unlinkSync(this.#socketPath); } catch { /* Socket may already be removed. */ }
    try { const { rmSync } = await import('node:fs'); rmSync(this.#input.controlRoot, { recursive: true, force: true }); } catch { /* Cleanup is best effort; the directory is private and session-scoped. */ }
  }

  #args(): string[] {
    const allowedTools = this.#allowedTools.map(tool => `mcp__${MCP_SERVER_NAME}__${tool.name}`);
    const args = [
      '--bare', '-p', '--output-format', 'stream-json', '--verbose', '--tools', '',
      '--disallowedTools', DISALLOWED_BUILTINS, '--disable-slash-commands', '--no-chrome',
      '--setting-sources', '', '--settings', this.#settingsFile(), '--strict-mcp-config', '--mcp-config', this.#mcpConfigPath,
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      ...(allowedTools.length > 0 ? ['--allowedTools', allowedTools.join(',')] : []),
      ...(this.#request.instructions !== undefined ? ['--append-system-prompt', this.#request.instructions] : []),
      ...(this.#nativeSessionId !== undefined ? ['--resume', this.#nativeSessionId] : []),
    ];
    return args;
  }

  #settingsFile(): string {
    const helper = fileURLToPath(new URL('./claude-auth-helper.mjs', import.meta.url));
    const pinPath = join(this.#input.controlRoot, 'auth-pin.json');
    writeFileSync(pinPath, JSON.stringify({
      model: this.#input.settings.model,
      effortLevel: this.#input.settings.effortLevel,
      baseUrl: this.#input.settings.baseUrl,
      authorizationFingerprint: this.#input.settings.authorizationFingerprint,
    }), { mode: 0o600 });
    const command = [realpathSync(process.execPath), helper, this.#input.settingsPath, pinPath].map(shellQuote).join(' ');
    const path = join(this.#input.controlRoot, 'settings.json');
    writeFileSync(path, JSON.stringify({ model: this.#input.settings.model, apiKeyHelper: command, effortLevel: this.#input.settings.effortLevel }), { mode: 0o600 });
    return path;
  }

  #consumeLine(line: string): void {
    let event: unknown;
    try { event = JSON.parse(line); } catch { this.#protocolFailure = true; return; }
    if (!isRecord(event) || typeof event.type !== 'string') return;
    if (event.type === 'system' && event.subtype === 'init') {
      const sessionId = typeof event.session_id === 'string' ? event.session_id : undefined;
      const accepted = Array.isArray(event.tools) ? event.tools.filter((tool): tool is string => typeof tool === 'string') : [];
      const expected = this.#allowedTools.map(tool => `mcp__${MCP_SERVER_NAME}__${tool.name}`);
      const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers.filter(isRecord) : [];
      const serverReady = servers.length === 1 && servers[0]?.name === MCP_SERVER_NAME && servers[0]?.status === 'connected';
      if (sessionId === undefined || !serverReady || !sameStringSet(accepted, expected)) { this.#protocolFailure = true; return; }
      if (this.#request.resumeSessionKey !== undefined && sessionId !== this.#request.resumeSessionKey) { this.#protocolFailure = true; return; }
      this.#initObserved = true;
      this.#nativeSessionId = sessionId;
      this.#activeQueue?.push({ type: 'notice', text: 'Claude Code session controls are ready.' });
      return;
    }
    if (event.type === 'assistant' && isRecord(event.message) && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (!isRecord(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          const text = sanitizeClaudeEventText(block.text);
          this.#turnText += text;
          this.#activeQueue?.push({ type: 'message', text, final: false });
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          if (!this.#allowedTools.some(tool => `mcp__${MCP_SERVER_NAME}__${tool.name}` === block.name)) { this.#protocolFailure = true; continue; }
          this.#activeQueue?.push({ type: 'tool-call', name: block.name, detail: 'Authorized Environment operation.' });
        }
      }
      return;
    }
    if (event.type === 'user' && isRecord(event.message) && Array.isArray(event.message.content)) {
      for (const block of event.message.content) if (isRecord(block) && block.type === 'tool_result') {
        const text = Array.isArray(block.content) ? block.content.filter(isRecord).filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n') : '';
        const sanitized = sanitizeClaudeEventText(text);
        if (sanitized !== '') this.#activeQueue?.push({ type: 'tool-output', text: sanitized });
      }
      return;
    }
    if (event.type === 'result') {
      this.#resultObserved = true;
      if (typeof event.result === 'string') this.#turnText = sanitizeClaudeEventText(event.result);
      if (isRecord(event.usage)) this.#turnUsage = Object.fromEntries(Object.entries(event.usage).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])));
      if (event.subtype !== 'success' || event.is_error === true) this.#protocolFailure = true;
    }
  }

  #tokenUsage(): { promptTokens: number; completionTokens: number; totalTokens: number } | undefined {
    if (this.#turnUsage === undefined) return undefined;
    const promptTokens = this.#turnUsage['input_tokens'];
    const completionTokens = this.#turnUsage['output_tokens'];
    if (promptTokens === undefined || completionTokens === undefined) return undefined;
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
  }

  #finish(result: EngineTurnResult): void {
    this.#child = undefined;
    const finish = this.#activeFinish;
    if (finish === undefined) return;
    const finalText = result.status === 'completed' ? result.text : result.status === 'failed' ? result.message : 'Claude Code run was interrupted.';
    this.#activeQueue?.push({ type: 'message', text: finalText, final: true });
    finish(result);
  }
}

function sanitizeClaudeEventText(value: string): string {
  const redacted = redactSensitiveText(value);
  const trailingLineBreaks = value.match(/[\r\n]+$/)?.[0] ?? '';
  return `${redacted}${trailingLineBreaks}`;
}

interface ClaudeTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly call: (arguments_: Readonly<Record<string, unknown>>) => Promise<string>;
}

function createClaudeTools(workspace?: RemoteWorkspaceTools, projectMcp?: RemoteProjectMcpTools): ClaudeTool[] {
  const tools: ClaudeTool[] = [];
  const addWorkspace = (name: 'read' | 'search' | 'edit' | 'patch' | 'command', description: string,
    schema: Readonly<Record<string, unknown>>, validate: (args: Record<string, unknown>) => boolean,
    call: (args: Record<string, unknown>, operationId: string) => Promise<RemoteWorkspaceOperationResult>) => {
    if (workspace === undefined || !workspace.operations?.includes(name) || !workspaceMethodAvailable(workspace, name)) return;
    tools.push({ name: `workspace_${name}`, description, inputSchema: schema, call: async args => {
      if (!validate(args) || workspace.bindingFence && !workspace.bindingFence.isCurrent()) return 'The selected remote capability is no longer available.';
      return JSON.stringify(await call(args, randomUUID()));
    } });
  };
  const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
  const string = { type: 'string' };
  addWorkspace('read', 'Read a file in the authorized remote Project workspace.', object({ path: string }, ['path']), args => typeof args.path === 'string' && Object.keys(args).every(key => key === 'path'), (args, operationId) => workspace!.read(args.path as string, operationId));
  addWorkspace('search', 'Search the authorized remote Project workspace.', object({ query: string, path: string }, ['query']), args => typeof args.query === 'string' && (args.path === undefined || typeof args.path === 'string') && Object.keys(args).every(key => key === 'query' || key === 'path'), (args, operationId) => workspace!.search(args.query as string, args.path as string | undefined, operationId));
  addWorkspace('edit', 'Replace exact text in the authorized remote Project workspace.', object({ path: string, oldText: string, newText: string }, ['path', 'oldText', 'newText']), args => ['path', 'oldText', 'newText'].every(key => typeof args[key] === 'string') && Object.keys(args).every(key => ['path', 'oldText', 'newText'].includes(key)), (args, operationId) => workspace!.edit!(args.path as string, args.oldText as string, args.newText as string, operationId));
  addWorkspace('patch', 'Apply bounded text changes in the authorized remote Project workspace.', object({ path: string, hunks: { type: 'array', items: object({ before: string, after: string }, ['before', 'after']) } }, ['path', 'hunks']), args => typeof args.path === 'string' && Array.isArray(args.hunks) && args.hunks.every(isRecord) && Object.keys(args).every(key => key === 'path' || key === 'hunks'), (args, operationId) => workspace!.patch!(args.path as string, args.hunks as { before: string; after: string }[], operationId));
  addWorkspace('command', 'Run an allowlisted command in the authorized remote Project workspace.', object({ executable: string, args: { type: 'array', items: string }, cwd: string, timeoutMs: { type: 'integer', minimum: 1 } }, ['executable', 'args']), args => typeof args.executable === 'string' && Array.isArray(args.args) && args.args.every(value => typeof value === 'string') && (args.cwd === undefined || typeof args.cwd === 'string') && (args.timeoutMs === undefined || Number.isSafeInteger(args.timeoutMs)) && Object.keys(args).every(key => ['executable', 'args', 'cwd', 'timeoutMs'].includes(key)), (args, operationId) => workspace!.command!(args.executable as string, args.args as string[], { ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}), ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}) }, operationId));

  for (const declaration of projectMcp?.tools ?? []) {
    const name = `project_${createHash('sha256').update(declaration.name).digest('hex').slice(0, 12)}`;
    tools.push({ name, description: declaration.description, inputSchema: declaration.inputSchema, call: async args => {
      if (projectMcp?.bindingFence && !projectMcp.bindingFence.isCurrent()) return 'The selected remote capability is no longer available.';
      try { return JSON.stringify(await projectMcp!.call(declaration.name, args)); }
      catch { return 'The selected remote capability is no longer available.'; }
    } });
  }
  return tools;
}

function handleMcpSocket(socket: Socket, tools: readonly ClaudeTool[]): void {
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      void handleMcpLine(socket, line, tools);
    }
  });
  socket.on('error', () => undefined);
}

async function handleMcpLine(socket: Socket, line: string, tools: readonly ClaudeTool[]): Promise<void> {
  let request: unknown;
  try { request = JSON.parse(line); } catch { return; }
  if (!isRecord(request) || request.id === undefined || typeof request.method !== 'string') return;
  let result: unknown;
  if (request.method === 'initialize') result = { protocolVersion: isRecord(request.params) && typeof request.params.protocolVersion === 'string' ? request.params.protocolVersion : '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'sprout', version: CLAUDE_CODE_HOST_VERSION } };
  else if (request.method === 'tools/list') result = { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  else if (request.method === 'tools/call' && isRecord(request.params) && typeof request.params.name === 'string' && isRecord(request.params.arguments)) {
    const tool = tools.find(candidate => candidate.name === request.params!.name);
    try {
      const text = tool === undefined ? 'The selected remote capability is no longer available.' : await tool.call(request.params.arguments);
      result = { content: [{ type: 'text', text }], ...(tool === undefined ? { isError: true } : {}) };
    } catch {
      result = { content: [{ type: 'text', text: 'The selected remote capability failed or is no longer available.' }], isError: true };
    }
  } else {
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unsupported' } })}\n`); return;
  }
  socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
}

function workspaceMethodAvailable(workspace: RemoteWorkspaceTools, operation: 'read' | 'search' | 'edit' | 'patch' | 'command'): boolean {
  switch (operation) {
    case 'read': return typeof workspace.read === 'function';
    case 'search': return typeof workspace.search === 'function';
    case 'edit': return typeof workspace.edit === 'function';
    case 'patch': return typeof workspace.patch === 'function';
    case 'command': return typeof workspace.command === 'function';
  }
}

function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(closed);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once('close', () => finish(true));
  });
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && right.every(value => left.includes(value));
}
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export function createProductionHostClaudeAdapter(paths: { readonly runnerRoot?: string } = {}): HostClaudeEngineAdapter {
  return new HostClaudeEngineAdapter(paths);
}

export function hostClaudeIsolationProfileForTest(input: HostClaudeLaunchInput): string { return hostClaudeIsolationProfile(input); }

export function hostClaudeLaunchFlagsForTest(): readonly string[] {
  return ['--bare', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--permission-mode', 'dontAsk', '--permission-prompts', 'none'];
}
