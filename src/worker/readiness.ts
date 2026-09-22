import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { LineJsonRpcTransport } from '../engine/jsonrpc.ts';

import type { EngineConfiguration } from './engine-selection.ts';
import type {
  WorkerEngineReadinessFact,
  WorkerReadinessProbeResult,
} from './protocol.ts';

const execFileAsync = promisify(execFile);

/** A deliberately small command seam used by tests and by the host Worker. */
export interface ReadinessCommandRunner {
  run(
    binary: string,
    args: readonly string[],
    options?: { readonly env?: NodeJS.ProcessEnv },
  ): Promise<{ readonly stdout: string; readonly exitCode: number }>;
  /** Structured Codex `account/read` over app-server, with refresh omitted. */
  accountRead?(
    binary: string,
    options?: { readonly env?: NodeJS.ProcessEnv },
  ): Promise<{ readonly stdout: string; readonly exitCode: number }>;
}

const defaultCommandRunner: ReadinessCommandRunner = {
  async run(binary, args, options) {
    try {
      const result = await execFileAsync(binary, [...args], {
        ...(options?.env !== undefined ? { env: options.env } : {}),
        maxBuffer: 256 * 1024,
        windowsHide: true,
      });
      return { stdout: String(result.stdout), exitCode: 0 };
    } catch (error) {
      const failure = error as { readonly stdout?: unknown; readonly status?: unknown; readonly code?: unknown };
      return {
        stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
        exitCode: typeof failure.status === 'number'
          ? failure.status
          : failure.code === 'ENOENT' ? 127 : 1,
      };
    }
  },
  async accountRead(binary, options) {
    const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      ...(options?.env !== undefined ? { env: options.env } : {}),
      windowsHide: true,
    });
    if (!child.stdin || !child.stdout) return { stdout: '', exitCode: 1 };
    const transport = new LineJsonRpcTransport({
      input: child.stdout,
      output: child.stdin,
    });
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('readiness account probe timed out')), 10_000);
      timer.unref();
    });
    try {
      const account = await Promise.race([ (async () => {
        await transport.request('initialize', { clientInfo: { name: 'sprout-readiness', version: '0' } });
        transport.notify('initialized', {});
        // This is the exact pinned non-refresh contract from #114. Do not add a
        // refreshToken field: Codex defaults the omitted bool to false.
        return transport.request('account/read', {});
      })(), timeout ]);
      return { stdout: JSON.stringify(account), exitCode: 0 };
    } catch {
      return { stdout: '', exitCode: 1 };
    } finally {
      transport.close();
      child.kill('SIGTERM');
    }
  },
};

function commandOptions(env: NodeJS.ProcessEnv | undefined): { readonly env?: NodeJS.ProcessEnv } {
  return env === undefined ? {} : { env };
}

export interface ReadinessProbeOptions {
  readonly clock?: () => number;
  readonly commandRunner?: ReadinessCommandRunner;
  readonly env?: NodeJS.ProcessEnv;
  readonly piProvider?: string;
}

/** Versions whose non-inference contracts were pinned and verified by #114. */
export const SUPPORTED_READINESS_VERSIONS = {
  codex: '0.154.0',
  pi: '0.86.1',
} as const;

/**
 * The only command arguments allowed for Pi authentication readiness.
 * Keeping this builder public makes the prohibited credential-printing modes
 * structurally testable instead of relying on a review of a string literal.
 */
export function piAuthCheckArgs(provider: string): readonly string[] {
  if (provider.includes('--credentials') || provider.includes('print-api-key') || provider.includes('print-bearer-token')) {
    throw new Error('credential-printing Pi readiness arguments are prohibited');
  }
  return ['auth', 'check', '--json', '--no-refresh', '--provider', provider];
}

function pinnedVersionFromOutput(engine: 'codex' | 'pi', output: string): string | undefined {
  // Do not extract a pin from arbitrary diagnostics: a failed/malformed version
  // command is not evidence that this executable implements the pinned schema.
  const text = output.trim();
  const match = engine === 'codex'
    ? /^codex-cli\s+v?(\d+\.\d+\.\d+)$/.exec(text)
    : /^(?:pi\s+)?v?(\d+\.\d+\.\d+)$/.exec(text);
  return match?.[1];
}

function safePiAuthType(value: unknown): 'oauth' | 'api_key' | undefined {
  // Pi's documented authType is already the privacy-reduced fact.  In
  // particular, oauth is not a provider name and must never be rewritten into
  // one (for example, "chatgpt").
  return value === 'oauth' || value === 'api_key' ? value : undefined;
}

function piAuthResponse(
  value: unknown,
  provider: string,
): { readonly status: 'ready' | 'not_ready' | 'invalid'; readonly authType?: 'oauth' | 'api_key' } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, ['status', 'provider', 'reason', 'authType'])) return undefined;
  if (record.status !== 'ready' && record.status !== 'not_ready' && record.status !== 'invalid') return undefined;
  // Provider is validated at the Worker boundary but deliberately discarded:
  // it is a routing input, not a persisted readiness identity fact.
  if (record.provider !== provider) return undefined;
  if (record.reason !== undefined && !PI_AUTH_REASONS.has(record.reason)) return undefined;
  const authType = record.authType === undefined ? undefined : safePiAuthType(record.authType);
  if (record.authType !== undefined && authType === undefined) return undefined;
  // The pinned ready shape includes a supported auth type. A missing one cannot
  // be promoted to authenticated; logged-out responses legitimately omit it.
  if (record.status === 'ready' && authType === undefined) return undefined;
  return { status: record.status, ...(authType !== undefined ? { authType } : {}) };
}

function codexAccountResponse(
  value: unknown,
): { readonly authenticated: boolean; readonly authMode?: 'chatgpt' | 'api_key' | 'workload_identity' } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, ['account', 'requiresOpenaiAuth'])) return undefined;
  // `requiresOpenaiAuth` is part of the pinned account/read response schema.
  if (typeof record.requiresOpenaiAuth !== 'boolean' || !Object.hasOwn(record, 'account')) return undefined;
  if (record.account === null) return { authenticated: false };
  if (typeof record.account !== 'object' || Array.isArray(record.account)) return undefined;
  const account = record.account as Record<string, unknown>;
  switch (account.type) {
    case 'apiKey':
      return hasOnlyKeys(account, ['type'])
        ? { authenticated: true, authMode: 'api_key' }
        : undefined;
    case 'chatgpt':
      if (
        !hasOnlyKeys(account, ['type', 'email', 'planType']) ||
        !Object.hasOwn(account, 'email') ||
        !Object.hasOwn(account, 'planType') ||
        (account.email !== null && typeof account.email !== 'string') ||
        !CODEX_PLAN_TYPES.has(account.planType)
      ) return undefined;
      return { authenticated: true, authMode: 'chatgpt' };
    case 'amazonBedrock':
      return hasOnlyKeys(account, ['type', 'usesCodexManagedCredentials']) &&
        typeof account.usesCodexManagedCredentials === 'boolean'
        ? { authenticated: true, authMode: 'workload_identity' }
        : undefined;
    default:
      return undefined;
  }
}

const PI_AUTH_REASONS = new Set<unknown>([
  'provider_not_found',
  'credentials_not_configured',
  'credential_not_available',
  'invalid_state',
]);

const CODEX_PLAN_TYPES = new Set<unknown>([
  'free', 'go', 'plus', 'pro', 'prolite', 'team',
  'self_serve_business_prolite', 'self_serve_business_usage_based',
  'business', 'ent26', 'enterprise_cbp_automation',
  'enterprise_cbp_usage_based', 'enterprise', 'edu', 'edu_plus', 'edu_pro',
  'unknown',
]);

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.every((key) => allowed.includes(key));
}

function prohibitedCredentialText(value: string): boolean {
  return /^Logged in using an API key(?: - .*)?$/.test(value.trim()) ||
    /[A-Za-z0-9_-]{8}\*{3}[A-Za-z0-9_-]{5}/.test(value) ||
    /Logged in using an API key - \*\*\*/.test(value);
}

function unknownFact(
  engine: string,
  version: string | undefined,
  at: number,
  source: NonNullable<WorkerEngineReadinessFact['source']>,
  exitCode: number,
): WorkerEngineReadinessFact {
  return {
    engine,
    ...(version !== undefined ? { version } : {}),
    installed: exitCode !== 127,
    readiness: 'unknown',
    // Account entitlement is intentionally unavailable for both engines. It is
    // never promoted from a local catalog or authentication observation.
    modelAvailability: 'unknown',
    models: [],
    probedAt: at,
    probeExitCode: exitCode,
    source,
  };
}

async function probePi(
  configuration: Extract<EngineConfiguration, { readonly engine: 'pi' }>,
  options: Required<Pick<ReadinessProbeOptions, 'clock' | 'commandRunner'>> & ReadinessProbeOptions,
): Promise<WorkerEngineReadinessFact> {
  const at = options.clock();
  const versionResult = await options.commandRunner.run(configuration.binaryPath, ['--version'], commandOptions(options.env));
  const version = pinnedVersionFromOutput('pi', versionResult.stdout);
  if (versionResult.exitCode !== 0 || version !== SUPPORTED_READINESS_VERSIONS.pi) {
    return unknownFact('pi', version, at, 'pi-auth-check', versionResult.exitCode);
  }
  const auth = await options.commandRunner.run(
    configuration.binaryPath,
    piAuthCheckArgs(options.piProvider ?? 'openai-codex'),
    commandOptions(options.env),
  );
  // A non-JSON or argument error is an unknown probe result, never a login
  // success and never a retry without --no-refresh.
  let parsed: ReturnType<typeof piAuthResponse>;
  try {
    parsed = piAuthResponse(JSON.parse(auth.stdout.trim()), options.piProvider ?? 'openai-codex');
  } catch {
    parsed = undefined;
  }
  if (prohibitedCredentialText(auth.stdout) || parsed === undefined || auth.exitCode === 2) {
    return unknownFact('pi', version, at, 'pi-auth-check', auth.exitCode || 1);
  }
  const ready = parsed.status === 'ready' && auth.exitCode === 0;
  const notReady = parsed.status === 'not_ready' && auth.exitCode === 1;
  if (!ready && !notReady) return unknownFact('pi', version, at, 'pi-auth-check', auth.exitCode || 1);
  const authType = ready ? parsed.authType : undefined;
  return {
    engine: 'pi',
    ...(version !== undefined ? { version } : {}),
    installed: true,
    readiness: ready ? 'ready' : 'login-required',
    modelAvailability: 'unknown',
    models: [],
    authenticated: ready,
    ...(authType !== undefined ? { authType } : {}),
    probedAt: at,
    probeExitCode: auth.exitCode,
    source: 'pi-auth-check',
  };
}

async function probeCodex(
  configuration: Extract<EngineConfiguration, { readonly engine: 'codex' }>,
  options: Required<Pick<ReadinessProbeOptions, 'clock' | 'commandRunner'>> & ReadinessProbeOptions,
): Promise<WorkerEngineReadinessFact> {
  const at = options.clock();
  const versionResult = await options.commandRunner.run(configuration.binaryPath, ['--version'], commandOptions(options.env));
  const version = pinnedVersionFromOutput('codex', versionResult.stdout);
  if (versionResult.exitCode !== 0 || version !== SUPPORTED_READINESS_VERSIONS.codex) {
    return unknownFact('codex', version, at, 'codex-account-read', versionResult.exitCode);
  }
  const account = await (options.commandRunner.accountRead ?? defaultCommandRunner.accountRead!)
    (configuration.binaryPath, commandOptions(options.env));
  if (prohibitedCredentialText(account.stdout)) {
    return unknownFact('codex', version, at, 'codex-account-read', account.exitCode || 1);
  }
  let parsed: ReturnType<typeof codexAccountResponse>;
  try {
    parsed = codexAccountResponse(JSON.parse(account.stdout.trim()));
  } catch {
    parsed = undefined;
  }
  if (account.exitCode !== 0 || parsed === undefined) {
    return unknownFact('codex', version, at, 'codex-account-read', account.exitCode || 1);
  }
  const ready = parsed.authenticated;
  return {
    engine: 'codex',
    ...(version !== undefined ? { version } : {}),
    installed: true,
    readiness: ready ? 'ready' : 'login-required',
    modelAvailability: 'unknown',
    models: [],
    authenticated: ready,
    ...(parsed.authMode !== undefined ? { authMode: parsed.authMode } : {}),
    probedAt: at,
    probeExitCode: account.exitCode,
    source: 'codex-account-read',
  };
}

/** Execute non-inference probes on the Worker host for the configured engines. */
export async function probeEnvironmentReadiness(
  configurations: readonly EngineConfiguration[],
  options: ReadinessProbeOptions = {},
): Promise<WorkerReadinessProbeResult> {
  const clock = options.clock ?? Date.now;
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const started = clock();
  const engines: WorkerEngineReadinessFact[] = [];
  for (const configuration of configurations) {
    try {
      engines.push(configuration.engine === 'codex'
        ? await probeCodex(configuration, { ...options, clock, commandRunner })
        : configuration.engine === 'pi'
          ? await probePi(configuration, { ...options, clock, commandRunner })
          : unknownFact(configuration.engine, undefined, clock(), 'unknown', 1));
    } catch {
      engines.push(unknownFact(configuration.engine, undefined, clock(), 'unknown', 1));
    }
  }
  const at = clock();
  const version = engines.map((engine) => engine.version).filter((value): value is string => value !== undefined).join(', ');
  const enginesOk = engines.length > 0 && engines.every((engine) => engine.installed && engine.readiness === 'ready');
  const probe = {
    at,
    latencyMs: Math.max(0, at - started),
    protocolOk: true,
    enginesOk,
    source: 'worker' as const,
    version: version || 'unknown',
    summary: enginesOk
      ? 'Worker non-inference readiness probe completed.'
      : 'Worker non-inference readiness probe completed with unknown or unavailable facts.',
  };
  return {
    readiness: {
      protocolVersion: '2',
      observedAt: at,
      engines,
      probe,
    },
    probe,
  };
}
