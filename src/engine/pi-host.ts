import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, existsSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { EventQueue } from './event-queue.ts';
import { mapPiEvent, newPiTurnState } from './pi-protocol.ts';
import {
  EngineResumeRefusedError,
  EngineStartError,
  type EngineAdapter,
  type EngineSession,
  type EngineTurn,
  type EngineTurnResult,
  type StartSessionRequest,
  type RemoteWorkspaceTools,
  type RemoteWorkspaceOperationResult,
} from './port.ts';

const PI_VERSION = '1.0.4';
const EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const FAILURE_STAGES = new Set([
  'request', 'sdk-import', 'sdk-version', 'provider-source', 'provider-identity',
  'session-controls', 'runtime-open', 'model-readiness', 'resume', 'session-create', 'turn',
]);
const FAILURE_CODES = new Set(['invalid', 'other', 'missing', 'unsupported', 'not-ready', 'resume-refused', 'control-violation']);

export interface HostPiReadiness {
  readonly profileId: string;
  readonly engine: 'pi';
  readonly status: 'ready' | 'unavailable' | 'unknown';
  readonly installation: 'ready' | 'missing' | 'unsupported' | 'unknown';
  readonly authentication: 'ready' | 'not-ready' | 'unknown';
  readonly modelAvailability: 'available' | 'unavailable' | 'unknown';
  readonly adapterControls: 'ready' | 'unavailable' | 'unknown';
  readonly version?: string;
  readonly observedAt: number;
}

export interface HostPiAdapterOptions {
  readonly profileId?: string;
  readonly provider: string;
  readonly model: string;
  readonly packageRoot?: string;
  readonly providerRoot?: string;
  readonly authPath?: string;
  readonly modelsPath?: string;
  readonly modelsStorePath?: string;
  readonly runnerRoot?: string;
  readonly clock?: () => number;
  readonly probeProcess?: (input: HostPiProbeInput) => Promise<HostPiReadiness>;
  readonly spawnProcess?: (input: HostPiLaunchInput) => ChildProcess;
}

export interface HostPiProbeInput {
  readonly profileId: string;
  readonly provider: string;
  readonly model: string;
  readonly packageRoot: string;
  readonly providerRoot: string;
  readonly authPath: string;
  readonly modelsPath: string;
  readonly modelsStorePath: string;
  readonly runnerRoot: string;
  readonly clock: () => number;
}

export interface HostPiLaunchInput extends HostPiProbeInput {
  readonly agentId: string;
  readonly agentRoot: string;
  readonly sessionDirectory: string;
  readonly sessionId: string;
  readonly resumeSessionKey?: string;
  readonly effort: string;
  readonly instructions?: string;
  readonly remoteWorkspace?: RemoteWorkspaceTools;
}

export function hostEngineProfileId(runnerRoot: string): string {
  const path = join(runnerRoot, 'host-pi-profile-id');
  try {
    mkdirSync(runnerRoot, { recursive: true, mode: 0o700 });
    try {
      const existing = readFileSync(path, 'utf8').trim();
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) return existing;
    } catch { /* Create a new opaque local identity when none exists. */ }
    const created = randomUUID();
    try { writeFileSync(path, `${created}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raced = readFileSync(path, 'utf8').trim();
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raced)) return raced;
      throw error;
    }
    return created;
  } catch {
    throw new Error('host Pi profile identity is unavailable');
  }
}

/**
 * Pi on the Sprout host, with a profile-local model grant and the accepted macOS
 * file isolation policy. Readiness is measured in a sandboxed non-inference child.
 */
export class HostPiEngineAdapter implements EngineAdapter {
  readonly id = 'pi';
  readonly capabilities = {
    streaming: 'incremental',
    supportsInterrupt: true,
    standingInstructions: 'out-of-band',
  } as const;
  readonly profileId: string;
  readonly authorizedModel: string;
  readonly provider: string;
  readonly #options: HostPiAdapterOptions;
  readonly #profile: HostPiProbeInput;
  readonly #clock: () => number;
  #cachedReadiness: HostPiReadiness | undefined;
  #readinessAt = 0;

  constructor(options: HostPiAdapterOptions) {
    if (!options.provider || !options.model) throw new Error('host-run Pi requires an explicit host provider and model');
    this.#options = options;
    this.provider = options.provider;
    this.authorizedModel = options.model;
    this.#clock = options.clock ?? Date.now;
    const runnerRoot = options.runnerRoot ?? join(homedir(), '.sprout', 'host-runner');
    this.profileId = options.profileId ?? hostEngineProfileId(runnerRoot);
    const authDir = join(homedir(), '.pi', 'agent');
    const packageRoot = options.packageRoot ?? join(authDir, 'install', 'releases', PI_VERSION, 'node_modules', '@earendil-works', 'pi-coding-agent');
    const providerRoot = options.providerRoot ?? join(process.cwd(), '..', 'pi-extensions', 'pi-magpie');
    this.#profile = {
      profileId: this.profileId,
      provider: options.provider,
      model: options.model,
      packageRoot,
      providerRoot,
      authPath: options.authPath ?? join(authDir, 'auth.json'),
      modelsPath: options.modelsPath ?? join(authDir, 'models.json'),
      modelsStorePath: options.modelsStorePath ?? join(authDir, 'models-store.json'),
      runnerRoot,
      clock: this.#clock,
    };
  }

  /** Non-inference engine-host observation; never consults Environment readiness. */
  async readiness(force = false): Promise<HostPiReadiness> {
    if (!force && this.#cachedReadiness !== undefined && this.#clock() - this.#readinessAt < 30_000) {
      return this.#cachedReadiness;
    }
    let result: HostPiReadiness;
    try {
      result = await (this.#options.probeProcess ?? probeHostPi)(this.#profile);
    } catch {
      result = unknownReadiness(this.profileId, this.#clock());
    }
    this.#cachedReadiness = result;
    this.#readinessAt = this.#clock();
    return result;
  }

  async startSession(request: StartSessionRequest): Promise<EngineSession> {
    if (request.model !== this.authorizedModel) throw new EngineStartError('host profile does not authorize the requested Pi model');
    if (!EFFORTS.has(request.effort ?? 'medium')) throw new EngineStartError('host profile does not support the requested Pi effort');
    const readiness = await this.readiness(true);
    if (readiness.status !== 'ready') throw new EngineStartError('host Pi readiness is not established for this host profile');

    const agentDigest = createHash('sha256').update(request.agentId).digest('hex').slice(0, 32);
    let agentRoot: string;
    let sessionDirectory: string;
    let child: ChildProcess;
    try {
      agentRoot = join(this.#profile.runnerRoot, this.profileId, agentDigest);
      sessionDirectory = join(agentRoot, 'sessions');
      mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
      const sessionId = request.resumeSessionKey ?? `sprout-${randomUUID()}`;
      const input: HostPiLaunchInput = {
        ...this.#profile,
        agentId: request.agentId,
        agentRoot,
        sessionDirectory,
        sessionId,
        ...(request.resumeSessionKey !== undefined ? { resumeSessionKey: request.resumeSessionKey } : {}),
        effort: request.effort ?? 'medium',
        ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
        ...(request.remoteWorkspace !== undefined ? { remoteWorkspace: request.remoteWorkspace } : {}),
      };
      child = (this.#options.spawnProcess ?? spawnHostPi)(input);
      return await waitForReady(child, input, this.#options.clock ?? Date.now);
    } catch (error) {
      if (error instanceof EngineStartError) throw error;
      throw new EngineStartError('host Pi runner could not be prepared');
    }
  }
}

class HostPiSession implements EngineSession {
  readonly sessionId: string;
  readonly engineSessionKey: string;
  readonly #child: ChildProcess;
  readonly #clock: () => number;
  readonly #remoteWorkspace: RemoteWorkspaceTools | undefined;
  readonly #turnFacts: Record<string, unknown>[] = [];
  #turnState = newPiTurnState();
  #queue: EventQueue | undefined;
  #finish: ((result: EngineTurnResult) => void) | undefined;
  #closed = false;
  #buffer = '';

  constructor(child: ChildProcess, sessionId: string, clock: () => number, remoteWorkspace?: RemoteWorkspaceTools) {
    this.#child = child;
    this.sessionId = sessionId;
    this.engineSessionKey = sessionId;
    this.#clock = clock;
    this.#remoteWorkspace = remoteWorkspace;
    child.stdout?.on('data', chunk => this.#onData(chunk.toString()));
    child.stderr?.on('data', () => undefined);
    child.on('exit', () => {
      if (this.#finish !== undefined) this.#finish({ status: 'failed', message: 'Pi host runner ended unexpectedly' });
    });
    child.on('error', () => {
      if (this.#finish !== undefined) this.#finish({ status: 'failed', message: 'Pi host runner could not start' });
    });
  }

  /** Sanitized provider-boundary facts observed for this session's turns. */
  turnFacts(): readonly Record<string, unknown>[] {
    return this.#turnFacts;
  }

  run(prompt: string): EngineTurn {
    if (this.#closed || this.#finish !== undefined) throw new Error('Pi host session is not available');
    const queue = new EventQueue();
    this.#queue = queue;
    this.#turnState = newPiTurnState(PI_VERSION);
    const startedAt = this.#clock();
    let settled = false;
    let resolveCompletion: (result: EngineTurnResult) => void = () => undefined;
    const completion = new Promise<EngineTurnResult>(resolve => { resolveCompletion = resolve; });
    const finish = (result: EngineTurnResult) => {
      if (settled) return;
      settled = true;
      this.#finish = undefined;
      const duration = Math.max(0, this.#clock() - startedAt);
      const measured = withEngineDuration(result, duration);
      if (measured.status === 'failed') queue.fail(new Error(measured.message));
      else queue.end();
      resolveCompletion(measured);
    };
    this.#finish = finish;
    this.#child.stdin?.write(`${JSON.stringify({ op: 'prompt', prompt })}\n`);
    return { events: queue, completion };
  }

  async interrupt(): Promise<boolean> {
    if (this.#closed || this.#child.exitCode !== null) return false;
    this.#child.stdin?.write('{"op":"abort"}\n');
    this.#finish?.({ status: 'interrupted' });
    return true;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#finish?.({ status: 'interrupted' });
    killProcessGroup(this.#child);
  }

  async #remoteCall(callId: string, operation: unknown, args: unknown): Promise<void> {
    const tools = this.#remoteWorkspace;
    const input = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {};
    let result: RemoteWorkspaceOperationResult | { readonly status: string; readonly operation?: RemoteWorkspaceOperationResult };
    try {
      const operationId = typeof input.operationId === 'string' ? input.operationId : undefined;
      if (!tools) throw new Error('remote workspace is unavailable');
      if (operation === 'inspect' && typeof operationId === 'string') result = await tools.inspect(operationId);
      else if (operation === 'read' && typeof input.path === 'string') result = await tools.read(input.path, operationId);
      else if (operation === 'search' && typeof input.query === 'string') result = await tools.search(input.query, typeof input.path === 'string' ? input.path : undefined, operationId);
      else if (operation === 'edit' && typeof input.path === 'string' && typeof input.oldText === 'string' && typeof input.newText === 'string' && tools.edit) result = await tools.edit(input.path, input.oldText, input.newText, operationId);
      else if (operation === 'patch' && typeof input.path === 'string' && Array.isArray(input.hunks) && tools.patch) result = await tools.patch(input.path, input.hunks as { before: string; after: string }[], operationId);
      else throw new Error('invalid remote operation');
    } catch {
      if (operation === 'inspect') result = { status: 'unknown' };
      else result = { operationId: 'unavailable', projectId: tools?.binding.projectId ?? '', environmentInstanceId: tools?.binding.environmentInstanceId ?? '',
        bindingId: tools?.binding.bindingId ?? '', generation: tools?.binding.generation ?? 0, connectionEpoch: tools?.binding.connectionEpoch ?? 0,
        workspaceId: tools?.binding.workspaceId ?? '', operation: operation === 'search' ? 'search' : operation === 'edit' ? 'edit' : operation === 'patch' ? 'patch' : 'read', status: 'failed', failure: 'remote-operation-blocked' };
    }
    this.#child.stdin?.write(`${JSON.stringify({ op: 'remote-result', callId, result })}\n`);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as { kind?: unknown; event?: unknown; stage?: unknown; code?: unknown; callId?: unknown; operation?: unknown; args?: unknown; facts?: unknown };
          if (message.kind === 'pi-event') {
            const outcome = mapPiEvent(message.event, this.#turnState);
            for (const event of outcome.events) this.#queue?.push(event);
            if (outcome.finish) this.#finish?.(outcome.finish);
          } else if ((message.kind === 'turn-facts' || message.kind === 'provider-request-facts') &&
              typeof message.facts === 'object' && message.facts !== null) {
            const facts = message.facts as Record<string, unknown>;
            this.#turnFacts.push(facts);
            const observe = (this.#remoteWorkspace as (RemoteWorkspaceTools & {
              observeProviderRequestFacts?: (facts: Record<string, unknown>) => void;
            }) | undefined)?.observeProviderRequestFacts;
            observe?.(facts);
          } else if (message.kind === 'remote-call' && typeof message.callId === 'string') {
            void this.#remoteCall(message.callId, message.operation, message.args);
          } else if (message.kind === 'failure') {
            const stage = FAILURE_STAGES.has(String(message.stage)) ? String(message.stage) : 'runner';
            const code = FAILURE_CODES.has(String(message.code)) ? String(message.code) : 'other';
            this.#finish?.({ status: 'failed', message: `Pi host run failed (${stage}:${code})` });
          }
        } catch {
          // Ignore non-protocol lines; child diagnostics are never forwarded.
        }
      }
      newline = this.#buffer.indexOf('\n');
    }
  }
}

function withEngineDuration(result: EngineTurnResult, duration: number): EngineTurnResult {
  return { ...result, engineTurnDurationMs: result.engineTurnDurationMs ?? duration };
}

async function waitForReady(child: ChildProcess, input: HostPiLaunchInput, clock: () => number): Promise<EngineSession> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessGroup(child);
      reject(new EngineStartError('host Pi session did not become ready'));
    }, 20_000);
    const settleFailure = (message: string, resumeRefused = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessGroup(child);
      reject(resumeRefused
        ? new EngineResumeRefusedError(input.resumeSessionKey ?? '', message)
        : new EngineStartError(message));
    };
    child.stdout?.on('data', chunk => {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline !== -1 && !settled) {
        const raw = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!raw) continue;
        let message: Record<string, unknown>;
        try { message = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
        if (message.kind === 'ready' && message.sessionId === input.sessionId) {
          settled = true;
          clearTimeout(timer);
          resolve(new HostPiSession(child, input.sessionId, clock, input.remoteWorkspace));
        } else if (message.kind === 'failure') {
          const stage = FAILURE_STAGES.has(String(message.stage)) ? String(message.stage) : 'runner';
          const code = FAILURE_CODES.has(String(message.code)) ? String(message.code) : 'other';
          settleFailure(`host Pi session refused (${stage}:${code})`, message.code === 'resume-refused');
        }
      }
    });
    child.on('exit', () => settleFailure('host Pi session ended before readiness'));
    child.on('error', () => settleFailure('host Pi runner could not start'));
    child.stderr?.on('data', () => undefined);
    void input;
  });
}

async function probeHostPi(input: HostPiProbeInput): Promise<HostPiReadiness> {
  const at = input.clock();
  if (process.platform !== 'darwin') {
    return {
      profileId: input.profileId,
      engine: 'pi',
      status: 'unavailable',
      installation: 'unsupported',
      authentication: 'unknown',
      modelAvailability: 'unknown',
      adapterControls: 'unavailable',
      observedAt: at,
    };
  }
  if (!existsSync(input.packageRoot)) {
    return { profileId: input.profileId, engine: 'pi', status: 'unavailable', installation: 'missing',
      authentication: 'unknown', modelAvailability: 'unknown', adapterControls: 'unknown', observedAt: at };
  }
  if (!existsSync('/usr/bin/sandbox-exec') || !existsSync(input.providerRoot)) {
    return { profileId: input.profileId, engine: 'pi', status: 'unavailable', installation: 'ready',
      authentication: 'unknown', modelAvailability: 'unknown', adapterControls: 'unavailable', version: PI_VERSION, observedAt: at };
  }
  try {
    mkdirSync(input.runnerRoot, { recursive: true, mode: 0o700 });
    const agentRoot = join(input.runnerRoot, input.profileId, 'readiness');
    mkdirSync(agentRoot, { recursive: true, mode: 0o700 });
    const sentinelRoot = mkdtempSync(join(tmpdir(), 'sprout-host-pi-probe-'));
    const sentinelPath = join(sentinelRoot, 'sentinel.txt');
    writeFileSync(sentinelPath, 'SYNTHETIC_HOST_SENTINEL', { mode: 0o600 });
    try {
      const config = {
        op: 'probe',
        ...input,
        agentRoot,
        sentinelPath,
      };
      const profile = isolationProfile({ ...input, agentRoot, network: false });
      const result = await runProbeChild(config, profile);
      if (result.kind === 'failure') return readinessFromProbeFailure(result, input.profileId, at);
      if (result.kind !== 'probe' || typeof result.facts !== 'object' || result.facts === null) {
        return unknownReadiness(input.profileId, at);
      }
      const facts = result.facts as Record<string, unknown>;
      const installed = facts.installed === true;
      const authenticated = facts.authenticated === true;
      const modelAvailable = facts.modelAvailable === true && facts.modelIdentityExact === true;
      const controlsReady = facts.controlsReady === true;
      const status = installed && authenticated && modelAvailable && controlsReady ? 'ready' : 'unavailable';
      return {
        profileId: input.profileId,
        engine: 'pi',
        status,
        installation: installed ? 'ready' : 'unsupported',
        authentication: facts.authenticated === true ? 'ready' : 'not-ready',
        modelAvailability: modelAvailable ? 'available' : 'unavailable',
        adapterControls: controlsReady ? 'ready' : 'unavailable',
        ...(installed ? { version: PI_VERSION } : {}),
        observedAt: typeof facts.probedAt === 'number' ? facts.probedAt : at,
      };
    } finally {
      rmSync(sentinelRoot, { recursive: true, force: true });
    }
  } catch {
    return unknownReadiness(input.profileId, at);
  }
}

function readinessFromProbeFailure(
  result: Record<string, unknown>,
  profileId: string,
  observedAt: number,
): HostPiReadiness {
  const stage = FAILURE_STAGES.has(String(result.stage)) ? String(result.stage) : 'request';
  const code = FAILURE_CODES.has(String(result.code)) ? String(result.code) : 'other';
  if (stage === 'sdk-version' || code === 'unsupported' && stage === 'sdk-import') {
    return { profileId, engine: 'pi', status: 'unavailable', installation: 'unsupported', authentication: 'unknown',
      modelAvailability: 'unknown', adapterControls: 'unknown', observedAt };
  }
  if (stage === 'provider-source' || stage === 'provider-identity' || stage === 'session-controls' || code === 'control-violation') {
    return { profileId, engine: 'pi', status: 'unavailable', installation: 'ready', authentication: 'unknown',
      modelAvailability: 'unknown', adapterControls: 'unavailable', version: PI_VERSION, observedAt };
  }
  if (stage === 'model-readiness' || code === 'not-ready') {
    return { profileId, engine: 'pi', status: 'unavailable', installation: 'ready', authentication: 'not-ready',
      modelAvailability: 'unknown', adapterControls: 'unknown', version: PI_VERSION, observedAt };
  }
  return unknownReadiness(profileId, observedAt);
}

function unknownReadiness(profileId: string, observedAt: number): HostPiReadiness {
  return {
    profileId,
    engine: 'pi',
    status: 'unknown',
    installation: 'unknown',
    authentication: 'unknown',
    modelAvailability: 'unknown',
    adapterControls: 'unknown',
    observedAt,
  };
}

async function runProbeChild(config: Record<string, unknown>, profile: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, fileURLToPath(new URL('./pi-host-runner.mjs', import.meta.url))], {
      cwd: String(config.agentRoot),
      env: { PATH: '/usr/bin:/bin', HOME: String(config.agentRoot), PI_CODING_AGENT_DIR: String(config.agentRoot), PI_TELEMETRY: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer | string) => { if (output.length < 16_384) output += chunk.toString(); });
    child.stderr?.on('data', () => undefined);
    const timer = setTimeout(() => {
      killProcessGroup(child);
      reject(new Error('host-pi-probe-timeout'));
    }, 25_000);
    child.on('error', () => { clearTimeout(timer); reject(new Error('host-pi-probe-start-failed')); });
    child.on('exit', () => {
      clearTimeout(timer);
      const first = output.split('\n').find(Boolean);
      if (!first) { reject(new Error('host-pi-probe-empty')); return; }
      try { resolve(JSON.parse(first) as Record<string, unknown>); }
      catch { reject(new Error('host-pi-probe-invalid')); }
    });
    child.stdin?.end(`${JSON.stringify(config)}\n`);
  });
}

export function isolationProfile(input: HostPiProbeInput & { readonly agentRoot: string; readonly network: boolean }): string {
  const packageRoot = realpathSync(input.packageRoot);
  const providerRoot = realpathSync(input.providerRoot);
  const agentRoot = realpathSync(input.agentRoot);
  const runtimeRoots = new Set([
    dirname(realpathSync(process.execPath)),
    dirname(dirname(packageRoot)),
    dirname(dirname(dirname(packageRoot))),
    ...(existsSync('/opt/homebrew') ? ['/opt/homebrew'] : []),
  ]);
  const quote = (path: string) => JSON.stringify(realpathSync(path));
  const files = [
    join(providerRoot, 'provider.ts'),
    join(providerRoot, 'catalog.ts'),
    join(providerRoot, 'constants.ts'),
    join(providerRoot, 'gateway.ts'),
    join(providerRoot, 'package.json'),
    fileURLToPath(new URL('./pi-host-runner.mjs', import.meta.url)),
    fileURLToPath(new URL('./pi-runner-events.ts', import.meta.url)),
    fileURLToPath(new URL('./pi-error-facts.ts', import.meta.url)),
    // The runner's TypeScript module needs the repository package scope read
    // (module format resolution) inside the sandbox; nothing else in the
    // repository is readable.
    fileURLToPath(new URL('../../package.json', import.meta.url)),
    input.authPath,
    input.modelsPath,
    input.modelsStorePath,
  ].filter(existsSync);
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-read*)',
    '(deny file-write*)',
    '(allow file-read-metadata)',
    '(allow file-read* (literal "/") (literal "/opt") (literal "/opt/homebrew") (literal "/opt/homebrew/opt") (literal "/opt/homebrew/Cellar") (literal "/private") (literal "/private/var") (literal "/var") (literal "/etc") (literal "/tmp"))',
    ...['/System', '/usr', '/bin', '/sbin', '/dev', '/private/etc', ...runtimeRoots].map(path => `(allow file-read* (subpath ${quote(path)}))`),
    `(allow file-read* (subpath ${quote(agentRoot)}))`,
    ...files.map(path => `(allow file-read* (literal ${quote(path)}))`),
    `(allow file-write* (subpath ${quote(agentRoot)}))`,
    ...(!input.network ? ['(deny network*)'] : []),
  ].join('\n');
}

function spawnHostPi(input: HostPiLaunchInput): ChildProcess {
  const profile = isolationProfile({ ...input, agentRoot: input.agentRoot, network: true });
  const child = spawn('/usr/bin/sandbox-exec', [
    '-p', profile,
    process.execPath,
    fileURLToPath(new URL('./pi-host-runner.mjs', import.meta.url)),
  ], {
    cwd: input.agentRoot,
    env: { PATH: '/usr/bin:/bin', HOME: input.agentRoot, PI_CODING_AGENT_DIR: input.agentRoot, PI_TELEMETRY: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdin?.write(`${JSON.stringify({ op: 'open', ...input })}\n`);
  return child;
}

function killProcessGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch { child.kill('SIGKILL'); }
}

export function createProductionHostPiAdapter(
  environment: NodeJS.ProcessEnv = process.env,
  paths: { readonly providerRoot?: string; readonly packageRoot?: string; readonly runnerRoot?: string } = {},
): HostPiEngineAdapter | undefined {
  const provider = environment['SPROUT_HOST_PI_PROVIDER'] ?? environment['PI_PROVIDER'];
  const model = environment['SPROUT_HOST_PI_MODEL'] ?? environment['PI_MODEL'];
  if (provider === undefined || model === undefined || provider === '' || model === '') return undefined;
  try {
    return new HostPiEngineAdapter({
      provider, model,
      ...(paths.providerRoot !== undefined ? { providerRoot: paths.providerRoot } : {}),
      ...(paths.packageRoot !== undefined ? { packageRoot: paths.packageRoot } : {}),
      ...(paths.runnerRoot !== undefined ? { runnerRoot: paths.runnerRoot } : {}),
    });
  } catch {
    return undefined;
  }
}

export function isHostPiEffortSupported(effort: string): boolean {
  return EFFORTS.has(effort);
}
