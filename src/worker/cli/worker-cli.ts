/**
 * The `sprout worker` macOS CLI (#117, ADR-0003/0012).
 *
 * Six executable subcommands give one macOS Environment host a real, repeatable
 * bootstrap and user-session lifecycle:
 *
 * - `enroll <endpoint> <enrollment-id>` reads the one-use claim secret from
 *   non-echoing stdin (never argv, never shell history), generates the Worker key
 *   on this host, proves possession to the Sprout instance, and persists the
 *   minimum reconnection facts.
 * - `start` establishes the E1 outbound connection and serves the existing
 *   neutral Worker JSON-RPC until the channel ends.
 * - `status` distinguishes not-enrolled, stopped, connecting, connected,
 *   incompatible, revoked, and local-configuration failure without printing a
 *   secret.
 * - `reset` requires explicit Human confirmation, removes host-local identity and
 *   configuration, and leaves the old identity unable to reconnect.
 * - `install-service` renders and installs a signed-in-user LaunchAgent that
 *   starts after sign-in and restarts after an unexpected exit.
 * - `uninstall-service` cleanly boots the LaunchAgent out and removes its plist.
 *
 * Every command is dependency-injected through `createWorkerCli`, so the tests
 * drive the real control flow with a controlled connectors, command runner, and
 * streams rather than reaching into the process. The default `main` wires the
 * real ones.
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { parseWorkerConfiguration } from '../../host-config.ts';
import { EnvironmentWorker } from '../server.ts';
import { WORKER_PROTOCOL_VERSION } from '../protocol.ts';
import { createEnvironmentWorkerEngines, hostEngineFacts } from '../engine-selection.ts';
import {
  connectWorkerEnrollment,
  WorkerEnrollmentPendingError,
  WorkerEnrollmentRefusedError,
  type WorkerEnrollmentConnection,
} from '../enrollment-connector.ts';
import {
  acquireWorkerLock,
  acquireWorkerResetLock,
  createWorkerOwnerToken,
  currentWorkerProcess,
  DuplicateWorkerProcessError,
  ensureStateDirectory,
  isEnrolled,
  isProcessAlive,
  probeWorkerProcess,
  readConfig,
  readIdentityKey,
  readRuntimeState,
  removeFileIfPresent,
  removeHostState,
  stableSlug,
  workerServiceLabel,
  writeConfig,
  writeRuntimeState,
  workerHostPaths,
  WorkerHostStateError,
  type WorkerHostConfig,
  type WorkerHostPaths,
  type WorkerRuntimeState,
  type WorkerConnectionState,
  type WorkerProcessIdentity,
  type WorkerProcessProbe,
} from './host-state.ts';
import {
  installLaunchAgent,
  launchAgentPlistPath,
  inspectLaunchAgent,
  renderLaunchAgent,
  restartLaunchAgent,
  uninstallLaunchAgent,
} from './launch-agent.ts';

/** Documented process exit statuses for every `sprout worker` subcommand. */
export const WORKER_EXIT = {
  /** The command completed. */
  ok: 0,
  /** A local configuration failure or unexpected error. */
  failure: 1,
  /** The command line was not understood. */
  usage: 2,
  /** No host-local enrollment exists. */
  notEnrolled: 3,
  /** The Sprout instance refused the enrollment or connection. */
  refused: 4,
  /** The identity is proven but a Human has not approved it yet. */
  awaitingApproval: 5,
  /** The LaunchAgent could not be installed, removed, or inspected. */
  serviceFailure: 6,
  /** Another Worker for this environment is already running. */
  alreadyRunning: 7,
} as const;

/**
 * The `status` projection.
 *
 * `local-configuration-failure` is distinct from `not-enrolled` so an operator
 * can tell "set me up" from "your files are unreadable", and `revoked` and
 * `incompatible` are distinct from a plain `stopped` so a refused Worker is
 * never mistaken for an idle one.
 */
export type WorkerStatusState =
  | 'not-enrolled'
  | 'stopped'
  | 'connecting'
  | 'connected'
  | 'pending-approval'
  | 'incompatible'
  | 'revoked'
  | 'local-configuration-failure';

export interface WorkerStatus {
  readonly state: WorkerStatusState;
  /** Whether a LaunchAgent plist is present for this environment. */
  readonly serviceInstalled: boolean;
  /** The Worker protocol version the host-local configuration declares. */
  readonly protocolVersion?: string;
  /** A bounded, sanitized explanation. Never a secret or a network address. */
  readonly detail?: string;
}

/** The one-use claim secret reader, so tests can supply one without a TTY. */
export type ClaimSecretReader = (prompt: string) => Promise<string>;

/** The connector seam, so tests can substitute a controlled outbound Worker. */
export type EnrollmentConnector = (input: {
  readonly host: string;
  readonly port: number;
  readonly enrollmentId: string;
  readonly claimSecret: string | undefined;
  readonly identityKeyPath: string;
  readonly engineFacts: readonly {
    readonly engine: string;
    readonly installed: boolean;
    readonly authenticated: boolean;
    readonly models: readonly string[];
  }[];
  readonly log: (line: string) => void;
}) => Promise<WorkerEnrollmentConnection>;

export interface WorkerCliDependencies {
  /** Resolve host-local paths; defaults to the real user directories. */
  readonly paths?: () => WorkerHostPaths;
  /** Read the one-use secret from non-echoing stdin. */
  readonly readClaimSecret?: ClaimSecretReader;
  /** Confirm a destructive action; defaults to a TTY prompt plus `--yes`. */
  readonly confirm?: (question: string) => Promise<boolean>;
  /** The outbound enrollment connector. */
  readonly connect?: EnrollmentConnector;
  /** Run one host command (used by the LaunchAgent seam). */
  readonly run?: (command: string, args: readonly string[]) => string;
  /** The signed-in user id whose `gui/<uid>` domain the LaunchAgent uses. */
  readonly uid?: number;
  /** The host platform; service commands are macOS-only. */
  readonly platform?: NodeJS.Platform;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly now?: () => number;
  /** Probe exact host-local process bindings; tests may provide synthetic facts. */
  readonly processProbe?: WorkerProcessProbe;
  /** Establish this invocation's binding; test-only callers may supply a synthetic OS seam. */
  readonly currentProcess?: (ownerToken: string) => WorkerProcessIdentity;
  /**
   * Serve the accepted channel. Defaults to the real `EnvironmentWorker`; tests
   * inject a recorder so `start` can be driven without a live core.
   */
  readonly serve?: (input: {
    connection: WorkerEnrollmentConnection;
    environmentInstanceId: string;
    engineIds: readonly string[];
  }) => Promise<void>;
}

/**
 * Whether the host-local identity is present, owner-only, and matches the
 * persisted configuration.
 *
 * A "connected" status must be backable by a real proof, so `status` treats a
 * missing or over-permissive key as a local configuration failure rather than a
 * healthy enrollment.
 */
export function isLocalConfigurationValid(paths: WorkerHostPaths): boolean {
  try {
    const config = readConfig(paths);
    readIdentityKey({ ...paths, identityPath: join(paths.stateDirectory, config.identityFileName) });
    return true;
  } catch {
    return false;
  }
}

/**
 * The terminal refusal states `start` persists when the core refuses or pends
 * the connection.
 */
type TerminalRefusalState = 'pending-approval' | 'incompatible' | 'revoked';

function isTerminalRefusalState(state: WorkerConnectionState): state is TerminalRefusalState {
  return state === 'pending-approval' || state === 'incompatible' || state === 'revoked';
}

/**
 * Project the host-local state and the live daemon record into one status.
 *
 * The projection rules, in order:
 *
 * 1. A live runtime whose ownership evidence is unavailable is always a
 *    `local-configuration-failure`, even when configuration is absent or the
 *    last recorded label is `stopped`. This is the same fail-closed fact that
 *    fences start/reset and must not be hidden by a lower-priority state.
 * 2. An unenrolled host is `not-enrolled`; an unreadable configuration or an
 *    invalid identity key is a `local-configuration-failure`.
 * 3. A runtime record whose full host-local process binding is verified is
 *    trusted as the live state (`connecting`, `connected`, or a terminal refusal).
 * 4. A runtime record whose process is gone — or whose pid was reused by a non-owner
 *    process — preserves a last recorded terminal refusal fact so a refused
 *    Worker is never reported as a healthy `stopped`; it clears `connecting`
 *    and `connected` to `stopped`, because those facts only exist while a
 *    process is actually serving.
 * 5. No runtime record at all is `stopped`.
 *
 * The identity check compares an owner token and OS start marker, so a reused
 * pid can never make a dead, foreign, or other-environment Worker look connected.
 */
export function projectStatus(input: {
  readonly paths: WorkerHostPaths;
  readonly enrolled: boolean;
  readonly config: WorkerHostConfig | undefined;
  readonly configError: 'not-enrolled' | 'invalid' | undefined;
  readonly runtime: WorkerRuntimeState | undefined;
  readonly processAlive: (pid: number) => boolean;
  readonly processMatchesRuntime?: (process: WorkerProcessIdentity) => boolean | 'unknown';
  readonly serviceInstalled: boolean;
}): WorkerStatus {
  const runtime = input.runtime;
  const identityCheck = input.processMatchesRuntime ?? ((_process: WorkerProcessIdentity) => true);
  const processAlive = runtime !== undefined && input.processAlive(runtime.pid);
  const identityResult = processAlive && runtime !== undefined ? identityCheck(runtime.process) : false;
  if (runtime !== undefined && processAlive && identityResult === 'unknown') {
    return {
      state: 'local-configuration-failure',
      serviceInstalled: input.serviceInstalled,
      ...(input.config !== undefined ? { protocolVersion: input.config.protocolVersion } : {}),
      detail: 'the Worker process ownership evidence is unavailable; start and reset are fenced',
    };
  }
  if (!input.enrolled) {
    return { state: 'not-enrolled', serviceInstalled: input.serviceInstalled };
  }
  if (input.configError === 'invalid' || input.config === undefined) {
    return {
      state: 'local-configuration-failure',
      serviceInstalled: input.serviceInstalled,
      detail: 'the host-local Worker configuration is missing or unreadable',
    };
  }
  const base = {
    serviceInstalled: input.serviceInstalled,
    protocolVersion: input.config.protocolVersion,
  };
  const trusted = runtime !== undefined && processAlive && identityResult === true;
  if (runtime === undefined || !trusted) {
    if (runtime !== undefined && isTerminalRefusalState(runtime.state)) {
      // Preserve the durable refusal/pending fact even after the process
      // exited: revoked or incompatible must never degrade to a healthy stop.
      return {
        state: runtime.state,
        ...base,
        ...(runtime.detail !== undefined ? { detail: runtime.detail } : {}),
      };
    }
    return { state: 'stopped', ...base };
  }
  switch (runtime.state) {
    case 'connecting':
    case 'connected':
    case 'pending-approval':
    case 'incompatible':
    case 'revoked':
    case 'stopped':
      return {
        state: runtime.state === 'stopped' ? 'stopped' : runtime.state,
        ...base,
        ...(runtime.detail !== undefined ? { detail: runtime.detail } : {}),
      };
  }
}

/**
 * Parse the public Sprout endpoint argument.
 *
 * Only `host:port` (optionally with `ws`/`wss`/`http`/`https` scheme) is
 * accepted. The endpoint never carries a secret, so it is safe in argv; the
 * one-use claim secret deliberately has no argument form.
 */
export function parseEndpoint(value: string): { readonly host: string; readonly port: number } {
  const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  const scheme = schemeMatch?.[1]?.toLowerCase();
  if (scheme !== undefined && !['ws', 'wss', 'http', 'https'].includes(scheme)) {
    throw new WorkerHostStateError('invalid', 'the endpoint scheme must be ws, wss, http, or https');
  }
  const authority = schemeMatch === null ? value : value.slice(schemeMatch[0].length);
  // Enforce an authority grammar before URL parsing. URL would otherwise
  // accept and silently discard userinfo, paths, queries, and fragments — all
  // of which can carry credentials or private network facts in process argv.
  if (/[\s/?#@]/.test(authority)) {
    throw new WorkerHostStateError(
      'invalid',
      'the endpoint must contain only a public host and explicit port; URL components are not allowed',
    );
  }
  const authorityMatch = authority.match(/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d+)$/i);
  if (authorityMatch === null) {
    throw new WorkerHostStateError('invalid', 'the endpoint must include only a host and an explicit port');
  }
  const withScheme = `${scheme ?? 'ws'}://${authority}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new WorkerHostStateError('invalid', 'the endpoint is not a valid host:port');
  }
  if (url.hostname === '' || url.port === '') {
    throw new WorkerHostStateError('invalid', 'the endpoint must include a host and an explicit port');
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new WorkerHostStateError('invalid', 'the endpoint port must be a number between 1 and 65535');
  }
  return { host: url.hostname, port };
}

/** The engine facts the Worker declares to the core on enrollment. */
function engineFacts(engineIds: readonly string[]): readonly {
  readonly engine: string;
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly models: readonly string[];
}[] {
  return engineIds.map((engine) => ({ engine, installed: true, authenticated: false, models: [] }));
}

export interface WorkerCli {
  run(argv: readonly string[], environment?: NodeJS.ProcessEnv): Promise<number>;
}

/**
 * Build the CLI over its dependencies.
 *
 * The returned `run` never throws for an expected outcome: it returns the
 * documented exit status and writes a sanitized line to stdout/stderr.
 */
export function createWorkerCli(dependencies: WorkerCliDependencies = {}): WorkerCli {
  const pathsOf = dependencies.paths ?? (() => workerHostPaths());
  const out = dependencies.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = dependencies.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const platform = dependencies.platform ?? process.platform;
  const uid = dependencies.uid ?? process.getuid?.() ?? 0;
  const now = dependencies.now ?? (() => Date.now());
  const runCommand = dependencies.run;
  const processProbe = dependencies.processProbe ?? probeWorkerProcess;
  const currentProcess = dependencies.currentProcess ?? currentWorkerProcess;

  const connect: EnrollmentConnector =
    dependencies.connect ??
    (async (input) =>
      connectWorkerEnrollment({
        target: {
          enrollmentId: input.enrollmentId,
          host: input.host,
          port: input.port,
          claimSecret: input.claimSecret,
          identityKeyPath: input.identityKeyPath,
        },
        protocolVersion: WORKER_PROTOCOL_VERSION,
        engineFacts: input.engineFacts,
        log: input.log,
      }));

  const readClaimSecret: ClaimSecretReader =
    dependencies.readClaimSecret ??
    (async (prompt) => {
      const { readSecretFromStdin } = await import('./host-state.ts');
      return readSecretFromStdin(
        process.stdin,
        process.stderr,
        prompt,
      );
    });

  const confirm =
    dependencies.confirm ??
    (async (question: string) => {
      if (!process.stdin.isTTY) return false;
      const { readSecretFromStdin } = await import('./host-state.ts');
      const answer = await readSecretFromStdin(process.stdin, process.stderr, question);
      return answer.trim().toLowerCase() === 'reset';
    });

  async function run(argv: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<number> {
    const paths = pathsOf();
    const command = argv[0];
    const rest = argv.slice(1);
    switch (command) {
      case 'enroll':
        return enroll(paths, rest, environment);
      case 'start':
        return start(paths, rest, environment);
      case 'status':
        return status(paths, rest);
      case 'reset':
        return reset(paths, rest);
      case 'install-service':
        return installService(paths, rest);
      case 'uninstall-service':
        return uninstallService(paths, rest);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        out(usage());
        return command === undefined ? WORKER_EXIT.usage : WORKER_EXIT.ok;
      default:
        err(`sprout worker: unknown subcommand "${command}"`);
        err(usage());
        return WORKER_EXIT.usage;
    }
  }

  function usage(): string {
    return [
      'Usage: sprout worker <command>',
      '',
      'Commands:',
      '  enroll <endpoint> <enrollment-id>   Claim a pending enrollment (secret on stdin)',
      '  start                               Run the outbound Worker in the foreground',
      '  status                              Report host-local Worker state',
      '  reset                               Remove host-local identity and configuration',
      '  install-service                     Install the signed-in-user LaunchAgent',
      '  uninstall-service                   Remove the signed-in-user LaunchAgent',
    ].join('\n');
  }

  function resolveEngineIds(environment: NodeJS.ProcessEnv): readonly string[] {
    const configuration = parseWorkerConfiguration(environment, { workingDirectory: process.cwd() });
    return [...createEnvironmentWorkerEngines(hostEngineFacts(configuration)).keys()];
  }

  async function enroll(
    paths: WorkerHostPaths,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ): Promise<number> {
    if (args.length !== 2) {
      err('sprout worker enroll: expected exactly <endpoint> and <enrollment-id>');
      err('the one-use claim secret is read from stdin and is never an argument');
      return WORKER_EXIT.usage;
    }
    const endpointArg = args[0] ?? '';
    const enrollmentId = args[1] ?? '';
    let endpoint: { host: string; port: number };
    try {
      endpoint = parseEndpoint(endpointArg);
    } catch (error) {
      err(`sprout worker enroll: ${diagnosticOf(error, 'the endpoint is invalid')}`);
      return WORKER_EXIT.usage;
    }
    if (enrollmentId === '') {
      err('sprout worker enroll: the enrollment id must not be empty');
      return WORKER_EXIT.usage;
    }

    ensureStateDirectory(paths);
    const existedBefore = existsSync(paths.configPath) || existsSync(paths.identityPath);

    let secret: string;
    try {
      secret = (await readClaimSecret('Sprout enrollment claim secret (input is hidden): ')).trim();
    } catch (error) {
      err(`sprout worker enroll: ${diagnosticOf(error, 'enrollment input could not be read')}`);
      return WORKER_EXIT.failure;
    }
    if (secret === '') {
      err('sprout worker enroll: no claim secret was provided on stdin');
      return WORKER_EXIT.usage;
    }

    const engineIds = safeEngineIds(environment);
    const identityKeyPath = join(paths.stateDirectory, 'identity.pem');
    try {
      const connection = await connect({
        ...endpoint,
        enrollmentId,
        claimSecret: secret,
        identityKeyPath,
        engineFacts: engineFacts(engineIds),
        log: () => err('[sprout-worker] host-local Worker operation completed'),
      });
      writeConfig(paths, {
        version: 1,
        enrollmentId,
        environmentInstanceId: connection.environmentInstanceId,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        endpoint,
        identityFileName: 'identity.pem',
      });
      connection.close();
      out(`Enrolled. Environment instance ready for Human approval. Epoch ${connection.epoch}.`);
      return WORKER_EXIT.ok;
    } catch (error) {
      if (error instanceof WorkerEnrollmentPendingError) {
        // The identity is bound; the config lets a later `start` reconnect once
        // the Human approves. This is success-with-a-wait, not a failure.
        writeConfig(paths, {
          version: 1,
          enrollmentId,
          environmentInstanceId: error.environmentInstanceId ?? stableSlug('pending'),
          protocolVersion: WORKER_PROTOCOL_VERSION,
          endpoint,
          identityFileName: 'identity.pem',
        });
        out('Identity proven. Waiting for Human approval in Sprout Web; run `sprout worker start` afterwards.');
        return WORKER_EXIT.awaitingApproval;
      }
      // A refused or failed enrollment leaves no usable configuration. Remove a
      // freshly generated identity so a retry starts clean, but never delete a
      // pre-existing identity/key the operator may still be using.
      if (!existedBefore) {
        removeFileIfPresent(paths.identityPath);
        removeFileIfPresent(paths.configPath);
      }
      err(`sprout worker enroll: ${diagnosticOf(error, 'enrollment could not be completed')}`);
      return error instanceof WorkerEnrollmentRefusedError ? WORKER_EXIT.refused : WORKER_EXIT.failure;
    }
  }

  function safeEngineIds(environment: NodeJS.ProcessEnv): readonly string[] {
    try {
      return resolveEngineIds(environment);
    } catch {
      return [];
    }
  }

  async function start(
    paths: WorkerHostPaths,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ): Promise<number> {
    if (args.length !== 0) {
      err('sprout worker start: takes no arguments');
      return WORKER_EXIT.usage;
    }
    let config: WorkerHostConfig;
    try {
      config = readConfig(paths);
    } catch (error) {
      if (error instanceof WorkerHostStateError && error.reason === 'not-enrolled') {
        err('sprout worker start: this host is not enrolled; run `sprout worker enroll` first');
        return WORKER_EXIT.notEnrolled;
      }
      err(`sprout worker start: ${diagnosticOf(error, 'host-local configuration could not be read')}`);
      return WORKER_EXIT.failure;
    }
    const identityPath = join(paths.stateDirectory, config.identityFileName);
    try {
      readIdentityKey({ ...paths, identityPath });
    } catch (error) {
      err(`sprout worker start: ${diagnosticOf(error, 'the host-local Worker identity key is invalid or unavailable')}`);
      return WORKER_EXIT.failure;
    }

    // The token is private process environment state, not argv or persisted
    // portable configuration. It is installed before probing the OS so every
    // runtime and lock record binds this exact process incarnation.
    const previousOwnerToken = process.env['SPROUT_WORKER_OWNER_TOKEN'];
    const ownerToken = process.env['SPROUT_WORKER_OWNER_TOKEN'] ?? createWorkerOwnerToken();
    process.env['SPROUT_WORKER_OWNER_TOKEN'] = ownerToken;
    try {
      let processIdentity: WorkerProcessIdentity;
      try {
        processIdentity = currentProcess(ownerToken);
      } catch (error) {
        err(`sprout worker start: ${diagnosticOf(error, 'host-local process identity could not be established')}`);
        return WORKER_EXIT.failure;
      }

      let lock: { release: () => void };
      try {
        lock = acquireWorkerLock(paths, processIdentity, processProbe);
      } catch (error) {
        if (error instanceof DuplicateWorkerProcessError) {
          err(`sprout worker start: ${error.message}`);
          return WORKER_EXIT.alreadyRunning;
        }
        err(`sprout worker start: ${diagnosticOf(error, 'host-local Worker lock could not be acquired')}`);
        return WORKER_EXIT.failure;
      }

      const engineIds = safeEngineIds(environment);
      recordState(paths, { pid: process.pid, process: processIdentity, state: 'connecting', at: now() });

      let connection: WorkerEnrollmentConnection;
      try {
        connection = await connect({
          host: config.endpoint.host,
          port: config.endpoint.port,
          enrollmentId: config.enrollmentId,
          claimSecret: undefined,
          identityKeyPath: identityPath,
          engineFacts: engineFacts(engineIds),
          log: () => err('[sprout-worker] host-local Worker operation completed'),
        });
      } catch (error) {
        if (error instanceof WorkerEnrollmentPendingError) {
          recordState(paths, {
            pid: process.pid, process: processIdentity, state: 'pending-approval', at: now(),
            detail: 'the Worker identity is proven and awaiting Human approval',
          });
          err('sprout worker start: identity proven; waiting for Human approval in Sprout Web');
          lock.release();
          return WORKER_EXIT.awaitingApproval;
        }
        if (error instanceof WorkerEnrollmentRefusedError) {
          recordState(paths, {
            pid: process.pid, process: processIdentity, state: error.code === 'incompatible' ? 'incompatible' : 'revoked', at: now(), detail: error.code === 'incompatible' ? 'the Worker protocol is incompatible' : 'the Worker identity or enrollment was refused',
          });
          err(`sprout worker start: ${diagnosticOf(error, 'the Worker connection was refused')}`);
          lock.release();
          return WORKER_EXIT.refused;
        }
        recordState(paths, { pid: process.pid, process: processIdentity, state: 'stopped', at: now(), detail: 'the Worker connection could not be established' });
        err(`sprout worker start: ${diagnosticOf(error, 'the Worker connection could not be established')}`);
        lock.release();
        return WORKER_EXIT.failure;
      }

      recordState(paths, { pid: process.pid, process: processIdentity, state: 'connected', at: now(), epoch: connection.epoch });
      out(`Connected to Sprout as enrollment ${connection.enrollmentId} (epoch ${connection.epoch}).`);

      const release = (finalState: WorkerConnectionState): void => {
        recordState(paths, { pid: process.pid, process: processIdentity, state: finalState, at: now() });
        lock.release();
      };

      try {
        if (dependencies.serve !== undefined) {
          await dependencies.serve({ connection, environmentInstanceId: config.environmentInstanceId, engineIds });
        } else {
          await serveForeground(connection, config.environmentInstanceId, engineIds, environment);
        }
      } finally {
        release('stopped');
      }
      return WORKER_EXIT.ok;
    } finally {
      if (previousOwnerToken === undefined) delete process.env['SPROUT_WORKER_OWNER_TOKEN'];
      else process.env['SPROUT_WORKER_OWNER_TOKEN'] = previousOwnerToken;
    }
  }

  async function serveForeground(
    connection: WorkerEnrollmentConnection,
    environmentInstanceId: string,
    engineIds: readonly string[],
    environment: NodeJS.ProcessEnv,
  ): Promise<void> {
    const configuration = parseWorkerConfiguration(environment, { workingDirectory: process.cwd() });
    const engines = createEnvironmentWorkerEngines(hostEngineFacts(configuration));
    // Prefer the same environment-variable allowlisted facts the core forwards,
    // but fall back to a minimal honest readiness projection when the CLI runs
    // engine selection in-process.
    void engineIds;
    const worker = new EnvironmentWorker({
      environmentInstanceId,
      engines,
      input: connection.stream,
      output: connection.stream,
      onLog: () => err('[sprout-worker] host-local Worker operation completed'),
      workspaceRoot: configuration.workspaceRoot,
      readiness: () => ({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        engines: [...engines.keys()].map((engine) => ({
          engine,
          installed: true,
          readiness: 'unknown',
          modelAvailability: 'unknown',
          models: [],
        })),
      }),
    });
    await new Promise<void>((resolve) => {
      connection.stream.on('close', () => {
        void worker.shutdown().then(resolve, resolve);
      });
      connection.stream.on('error', () => resolve());
      const stop = (): void => {
        void worker.shutdown().then(resolve, resolve);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  }

  async function status(paths: WorkerHostPaths, args: readonly string[]): Promise<number> {
    if (args.length !== 0) {
      err('sprout worker status: takes no arguments');
      return WORKER_EXIT.usage;
    }
    const enrolled = isEnrolled(paths);
    let config: WorkerHostConfig | undefined;
    let configError: 'not-enrolled' | 'invalid' | undefined;
    if (!enrolled) {
      configError = 'not-enrolled';
    } else {
      try {
        config = readConfig(paths);
      } catch (error) {
        configError = error instanceof WorkerHostStateError ? error.reason : 'invalid';
      }
    }
    const serviceInstalled =
      config !== undefined && existsSync(launchAgentPlistPath(paths, config.environmentInstanceId));
    // "Cleanly inspected": report whether launchd actually has the job loaded,
    // not merely whether a plist is on disk.
    const serviceLoaded =
      serviceInstalled &&
      config !== undefined &&
      platform === 'darwin' &&
      inspectLaunchAgent({
        label: workerServiceLabel(config.environmentInstanceId),
        uid,
        ...(runCommand !== undefined ? { run: runCommand } : {}),
      }) !== undefined;
    // A runtime record that is present but malformed is a local configuration
    // failure, not a healthy stopped state.
    let runtime: WorkerRuntimeState | undefined;
    let runtimeInvalid = false;
    try {
      runtime = readRuntimeState(paths);
    } catch {
      runtime = undefined;
      runtimeInvalid = true;
    }
    const localConfigurationValid = runtimeInvalid ? false : isLocalConfigurationValid(paths);
    let projected: WorkerStatus;
    if (runtimeInvalid) {
      projected = {
        state: 'local-configuration-failure',
        serviceInstalled,
        ...(config !== undefined ? { protocolVersion: config.protocolVersion } : {}),
        detail: 'the host-local runtime state record is unreadable or malformed',
      };
    } else if (enrolled && config !== undefined && !localConfigurationValid) {
      projected = {
        state: 'local-configuration-failure',
        serviceInstalled,
        ...(config !== undefined ? { protocolVersion: config.protocolVersion } : {}),
        detail: 'the host-local Worker identity key is missing or readable by other users',
      };
    } else {
      projected = projectStatus({
        paths,
        enrolled,
        config,
        configError,
        runtime,
        processAlive: (pid) => isProcessAlive(pid),
        processMatchesRuntime: (identity) => {
          try {
            const observed = processProbe(identity.pid);
            if (observed.state === 'unknown') return 'unknown';
            return observed.state === 'alive' &&
              observed.process.pid === identity.pid &&
              observed.process.startIdentity === identity.startIdentity &&
              observed.process.ownerToken === identity.ownerToken;
          } catch {
            return 'unknown';
          }
        },
        serviceInstalled,
      });
    }
    out(`state: ${projected.state}`);
    if (projected.protocolVersion !== undefined) out(`protocol: ${projected.protocolVersion}`);
    out(`service: ${serviceInstalled ? (serviceLoaded ? 'installed and loaded' : 'installed but not loaded') : 'not-installed'}`);
    if (projected.detail !== undefined) out(`detail: ${projected.detail}`);
    switch (projected.state) {
      case 'not-enrolled':
        return WORKER_EXIT.notEnrolled;
      case 'local-configuration-failure':
        return WORKER_EXIT.failure;
      default:
        return WORKER_EXIT.ok;
    }
  }

  async function reset(paths: WorkerHostPaths, args: readonly string[]): Promise<number> {
    const confirmed = args.includes('--yes') || (await confirm('Type "reset" to remove host-local Worker identity and configuration: '));
    const unknown = args.filter((arg) => arg !== '--yes');
    if (unknown.length > 0) {
      err(`sprout worker reset: unknown argument "${unknown[0]}"`);
      return WORKER_EXIT.usage;
    }
    if (!confirmed) {
      err('sprout worker reset: confirmation was not given; nothing was removed');
      return WORKER_EXIT.usage;
    }

    // Reset itself owns the same exclusive fence as start. Acquiring it is the
    // liveness check and closes the old check-then-remove race: no new start can
    // acquire the Worker lock until this reset has either failed or completed.
    const previousOwnerToken = process.env['SPROUT_WORKER_OWNER_TOKEN'];
    const ownerToken = process.env['SPROUT_WORKER_OWNER_TOKEN'] ?? createWorkerOwnerToken();
    process.env['SPROUT_WORKER_OWNER_TOKEN'] = ownerToken;
    let resetLock: { release: () => void };
    try {
      resetLock = acquireWorkerResetLock(paths, currentProcess(ownerToken), processProbe);
    } catch (error) {
      if (error instanceof DuplicateWorkerProcessError) {
        err(`sprout worker reset: a Worker or reset still owns this host-local state${error.pid === undefined ? '' : ` (pid ${error.pid})`}; nothing was removed`);
        return WORKER_EXIT.failure;
      }
      err(`sprout worker reset: could not establish exclusive ownership; nothing was removed (${diagnosticOf(error, 'host-local ownership evidence is unavailable')})`);
      return WORKER_EXIT.failure;
    }

    try {
      // Stop the supervised service before the identity disappears, and refuse
      // the reset when the service cannot be proven unloaded: a loaded
      // LaunchAgent would restart against a half-removed state.
      if (platform === 'darwin') {
        const command = runCommand ?? realCommandRunner();
        let config: WorkerHostConfig;
        try {
          // The persisted environment binding is the only authority for reset.
          // Without it there is no safe way to prove a same-user Worker label
          // belongs to this state root, so reset refuses rather than enumerates.
          config = readConfig(paths);
        } catch (error) {
          err(`sprout worker reset: the current environment label could not be proven; host-local state was left untouched (${diagnosticOf(error, 'local configuration is unavailable')})`);
          return WORKER_EXIT.serviceFailure;
        }
        const label = workerServiceLabel(config.environmentInstanceId);
        try {
          uninstallLaunchAgent({ label, plistPath: launchAgentPlistPath(paths, config.environmentInstanceId), uid, run: command });
        } catch (error) {
          err(`sprout worker reset: the LaunchAgent could not be removed; host-local state was left untouched (${diagnosticOf(error, 'the exact environment service could not be unloaded')})`);
          return WORKER_EXIT.serviceFailure;
        }
      }
      try {
        // Leave the maintenance fence in place until every other record is
        // gone; its ownership-checked release happens in finally below.
        removeHostState(paths, { preserveLock: true });
      } catch (error) {
        err(`sprout worker reset: host-local state could not be fully removed (${diagnosticOf(error, 'host-local state could not be fully removed')})`);
        return WORKER_EXIT.failure;
      }
      out('Host-local Worker identity and configuration removed. The old identity can no longer reconnect.');
      return WORKER_EXIT.ok;
    } finally {
      resetLock.release();
      if (previousOwnerToken === undefined) delete process.env['SPROUT_WORKER_OWNER_TOKEN'];
      else process.env['SPROUT_WORKER_OWNER_TOKEN'] = previousOwnerToken;
    }
  }

  async function installService(paths: WorkerHostPaths, args: readonly string[]): Promise<number> {
    if (args.length !== 0) {
      err('sprout worker install-service: takes no arguments');
      return WORKER_EXIT.usage;
    }
    if (platform !== 'darwin') {
      err('sprout worker install-service: the LaunchAgent lifecycle is only supported on macOS');
      return WORKER_EXIT.serviceFailure;
    }
    let config: WorkerHostConfig;
    try {
      config = readConfig(paths);
    } catch (error) {
      if (error instanceof WorkerHostStateError && error.reason === 'not-enrolled') {
        err('sprout worker install-service: this host is not enrolled; run `sprout worker enroll` first');
        return WORKER_EXIT.notEnrolled;
      }
      err(`sprout worker install-service: ${diagnosticOf(error, 'host-local configuration could not be read')}`);
      return WORKER_EXIT.failure;
    }
    const label = workerServiceLabel(config.environmentInstanceId);
    const plistPath = launchAgentPlistPath(paths, config.environmentInstanceId);
    const plist = renderLaunchAgent({
      label,
      executablePath: paths.executablePath,
      arguments: ['worker', 'start'],
      logPath: paths.logPath,
      environment: plistEnvironment(),
    });
    try {
      installLaunchAgent({
        paths,
        label,
        plistPath,
        plistContent: plist,
        uid,
        ...(runCommand !== undefined ? { run: runCommand } : {}),
      });
      // Start the job now (as well as at sign-in) so installation is observable
      // immediately rather than only after the next login.
      try {
        restartLaunchAgent({ label, uid, ...(runCommand !== undefined ? { run: runCommand } : {}) });
      } catch {
        // A fresh `bootstrap` may already have started it; not being able to
        // kickstart is not an install failure.
      }
      out(`Installed LaunchAgent ${label}. It starts at sign-in and restarts after an unexpected exit.`);
      return WORKER_EXIT.ok;
    } catch (error) {
      err(`sprout worker install-service: ${diagnosticOf(error, 'the LaunchAgent could not be installed')}`);
      return WORKER_EXIT.serviceFailure;
    }
  }

  async function uninstallService(paths: WorkerHostPaths, args: readonly string[]): Promise<number> {
    if (args.length !== 0) {
      err('sprout worker uninstall-service: takes no arguments');
      return WORKER_EXIT.usage;
    }
    if (platform !== 'darwin') {
      err('sprout worker uninstall-service: the LaunchAgent lifecycle is only supported on macOS');
      return WORKER_EXIT.serviceFailure;
    }
    let config: WorkerHostConfig | undefined;
    try {
      config = readConfig(paths);
    } catch {
      config = undefined;
    }
    if (config === undefined) {
      // Without a config the label cannot be derived; remove any plist whose
      // label prefix matches this host's state directory slug as a best effort.
      err('sprout worker uninstall-service: no host-local enrollment; nothing to uninstall');
      return WORKER_EXIT.notEnrolled;
    }
    const label = workerServiceLabel(config.environmentInstanceId);
    try {
      const result = uninstallLaunchAgent({
        label,
        plistPath: launchAgentPlistPath(paths, config.environmentInstanceId),
        uid,
        ...(runCommand !== undefined ? { run: runCommand } : {}),
      });
      out(result.removed ? `Removed LaunchAgent ${label}.` : `LaunchAgent ${label} was not installed.`);
      return WORKER_EXIT.ok;
    } catch (error) {
      err(`sprout worker uninstall-service: ${diagnosticOf(error, 'the LaunchAgent could not be removed')}`);
      return WORKER_EXIT.serviceFailure;
    }
  }

  function plistEnvironment(): Readonly<Record<string, string>> {
    const environment: Record<string, string> = {};
    if (process.env['HOME'] !== undefined) environment['HOME'] = process.env['HOME'];
    if (process.env['PATH'] !== undefined) environment['PATH'] = process.env['PATH'];
    if (process.env['SPROUT_WORKER_HOME'] !== undefined) {
      environment['SPROUT_WORKER_HOME'] = process.env['SPROUT_WORKER_HOME'];
    }
    return environment;
  }

  function recordState(paths: WorkerHostPaths, state: WorkerRuntimeState): void {
    ensureStateDirectory(paths);
    writeRuntimeState(paths, state);
  }

  /** The real host command runner, used only when no test seam was injected. */
  function realCommandRunner(): (command: string, args: readonly string[]) => string {
    return (command, args) =>
      execFileSync(command, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  return { run };
}

function diagnosticOf(_error: unknown, fallback: string): string {
  // Filesystem, launchd, transport, endpoint, and key errors can contain
  // paths, host names, command output, or secret-adjacent material. The CLI
  // boundary therefore emits only caller-supplied, sanitized categories.
  return fallback;
}

/** The default process entry point: parse argv and exit with the returned code. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const cli = createWorkerCli();
  return cli.run(argv);
}
