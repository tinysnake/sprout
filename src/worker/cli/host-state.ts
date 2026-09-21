/**
 * Host-local Worker state for the macOS CLI (#117, ADR-0003/0012).
 *
 * The `sprout worker` command owns three kinds of host-local fact and nothing
 * else:
 *
 * - the **configuration** needed to reconnect (endpoint, enrollment id,
 *   environment instance, protocol version) — never a browser credential, an
 *   engine credential, a hostname inventory, or an absolute workspace path;
 * - the **identity key** generated on this host, stored owner-only, which never
 *   crosses the core boundary and never appears in argv, output, or a log; and
 * - the **runtime state** that lets `status` tell a stopped Worker from a
 *   connecting, connected, incompatible, or revoked one without reading a
 *   secret.
 *
 * Everything here is deliberately a filesystem seam: the paths, the restrictive
 * permissions, and the parse/validate rules live in one Module so the commands,
 * the `status` projection, and the tests cannot disagree about what "host-local
 * restrictive storage" means.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  writePrivateFile,
} from '../host-files.ts';

/** The LaunchAgent label prefix the Worker service uses on macOS. */
export const WORKER_SERVICE_LABEL_PREFIX = 'dev.sprout.worker';

/** The private key file name inside the state directory. */
export const WORKER_IDENTITY_FILE = 'identity.pem';

export { PRIVATE_FILE_MODE, PRIVATE_DIRECTORY_MODE };

/**
 * The connection facts the Worker persists to reconnect.
 *
 * This is deliberately the *minimum*: the endpoint it dials, the enrollment that
 * authorizes it, the environment instance it serves, and the Worker protocol
 * version. There is no field for a Human browser credential, an engine
 * credential, a hostname inventory, or an absolute workspace path, so none can
 * be persisted by accident.
 */
export interface WorkerHostConfig {
  readonly version: 1;
  readonly enrollmentId: string;
  readonly environmentInstanceId: string;
  readonly protocolVersion: string;
  readonly endpoint: { readonly host: string; readonly port: number };
  /** The private key file name, resolved relative to the state directory. */
  readonly identityFileName: string;
}

/** The connection states a Worker's `status` distinguishes. */
export type WorkerConnectionState =
  | 'stopped'
  | 'connecting'
  | 'connected'
  | 'pending-approval'
  | 'incompatible'
  | 'revoked';

/**
 * The live daemon's own record of what it is doing.
 *
 * It is written by `start` and read by `status`; it carries no secret and no
 * free-form endpoint text. The pid plus process identity is what lets `status`
 * ignore a stale file whose pid the OS has since reused.
 */
export interface WorkerRuntimeState {
  readonly pid: number;
  readonly state: WorkerConnectionState;
  /** The instant the state was last observed, in epoch milliseconds. */
  readonly at: number;
  /** An optional, already-sanitized explanation suitable for an operator. */
  readonly detail?: string;
  /** The Worker connection epoch, when the core has accepted one. */
  readonly epoch?: number;
}

/** Why the host-local Worker state could not be used. */
export class WorkerHostStateError extends Error {
  override readonly name = 'WorkerHostStateError';
  /** `not-enrolled` is distinct from `invalid` so the CLI can exit differently. */
  readonly reason: 'not-enrolled' | 'invalid';

  constructor(reason: 'not-enrolled' | 'invalid', message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface WorkerHostPaths {
  /** The owner-only directory holding config, identity, and runtime state. */
  readonly stateDirectory: string;
  readonly configPath: string;
  readonly identityPath: string;
  readonly runtimePath: string;
  readonly logPath: string;
  /** The directory LaunchAgents are written to. */
  readonly launchAgentsDirectory: string;
  /** The absolute path of the `sprout` executable this process was started by. */
  readonly executablePath: string;
  /** The Node executable that runs the TypeScript sources. */
  readonly nodeExecutable: string;
}

/**
 * Resolve every host-local path once.
 *
 * The defaults are the signed-in user's own directories, so a Worker runs in
 * their login context (ADR-0009). Tests and the independent probes override the
 * directory roots through the environment rather than through arguments, so no
 * command line ever has to carry a host path.
 */
export function workerHostPaths(environment: NodeJS.ProcessEnv = process.env): WorkerHostPaths {
  const home = environment['HOME'] ?? homedir();
  const stateDirectory = environment['SPROUT_WORKER_HOME'] ?? join(home, '.sprout', 'worker');
  const launchAgentsDirectory =
    environment['SPROUT_LAUNCH_AGENTS_DIR'] ?? join(home, 'Library', 'LaunchAgents');
  return {
    stateDirectory,
    configPath: join(stateDirectory, 'config.json'),
    identityPath: join(stateDirectory, WORKER_IDENTITY_FILE),
    runtimePath: join(stateDirectory, 'runtime.json'),
    logPath: join(stateDirectory, 'worker.log'),
    launchAgentsDirectory,
    executablePath: environment['SPROUT_CLI_PATH'] ?? defaultExecutablePath(),
    nodeExecutable: process.execPath,
  };
}

/**
 * The `sprout` entry point this process is running from.
 *
 * The CLI sets `SPROUT_CLI_PATH` when it dispatches so the rendered LaunchAgent
 * names the same executable the operator invoked; this fallback keeps a directly
 * imported Module honest without guessing a repository layout.
 */
function defaultExecutablePath(): string {
  return process.argv[1] ?? process.argv[0] ?? 'sprout';
}

/** The LaunchAgent label for one environment instance. */
export function workerServiceLabel(environmentInstanceId: string): string {
  return `${WORKER_SERVICE_LABEL_PREFIX}.${stableSlug(environmentInstanceId)}`;
}

/**
 * A filesystem-safe, collision-resistant slug.
 *
 * It is a one-way digest so a label never contains a host-identifying instance
 * name verbatim, and it is stable so install/uninstall/inspect agree.
 */
export function stableSlug(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const base = value.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 24);
  return `${base === '' ? 'env' : base}.${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** Ensure the owner-only state directory exists. */
export function ensureStateDirectory(paths: WorkerHostPaths): void {
  mkdirSync(paths.stateDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  // `mkdir` respects the mode only on creation; an existing directory is left as
  // the operator made it, so tighten it explicitly.
  chmodSync(paths.stateDirectory, PRIVATE_DIRECTORY_MODE);
}

/** Whether a file's mode grants no group or world access. */
export function isRestrictive(filePath: string): boolean {
  const mode = statSync(filePath).mode & 0o777;
  return (mode & 0o077) === 0;
}

export { writePrivateFile };

/** Remove a file if it exists, ignoring an already-absent one. */
export function removeFileIfPresent(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // A missing file is the desired end state.
  }
}

/** Read the identity private key, refusing a key that other users can read. */
export function readIdentityKey(paths: WorkerHostPaths): string {
  if (!existsSync(paths.identityPath)) {
    throw new WorkerHostStateError('invalid', 'the host-local Worker identity key is missing');
  }
  if (!isRestrictive(paths.identityPath)) {
    throw new WorkerHostStateError(
      'invalid',
      'the host-local Worker identity key is readable by other users; run reset and enroll again',
    );
  }
  return readFileSync(paths.identityPath, 'utf8');
}

/** Whether a host-local enrollment already exists. */
export function isEnrolled(paths: WorkerHostPaths): boolean {
  return existsSync(paths.configPath);
}

/**
 * Load the persisted configuration, validating that it is structurally sound.
 *
 * A corrupt document is a *local configuration failure* rather than a silent
 * re-enrollment, because rotating the identity would orphan the core-side
 * binding the operator already approved.
 */
export function readConfig(paths: WorkerHostPaths): WorkerHostConfig {
  if (!existsSync(paths.configPath)) {
    throw new WorkerHostStateError('not-enrolled', 'this host has no Sprout Worker enrollment');
  }
  if (!isRestrictive(paths.configPath)) {
    throw new WorkerHostStateError(
      'invalid',
      'the host-local Worker configuration is readable by other users; run reset and enroll again',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.configPath, 'utf8'));
  } catch {
    throw new WorkerHostStateError('invalid', 'the host-local Worker configuration is not valid JSON');
  }
  return validateConfig(parsed);
}

/** Validate a parsed configuration without echoing any of its values. */
export function validateConfig(parsed: unknown): WorkerHostConfig {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new WorkerHostStateError('invalid', 'the host-local Worker configuration is not an object');
  }
  const record = parsed as Record<string, unknown>;
  const endpoint = record['endpoint'];
  const host = typeof endpoint === 'object' && endpoint !== null ? (endpoint as Record<string, unknown>)['host'] : undefined;
  const port = typeof endpoint === 'object' && endpoint !== null ? (endpoint as Record<string, unknown>)['port'] : undefined;
  const enrollmentId = record['enrollmentId'];
  const environmentInstanceId = record['environmentInstanceId'];
  const protocolVersion = record['protocolVersion'];
  const identityFileName = record['identityFileName'];
  if (
    record['version'] !== 1 ||
    typeof enrollmentId !== 'string' ||
    enrollmentId === '' ||
    typeof environmentInstanceId !== 'string' ||
    environmentInstanceId === '' ||
    typeof protocolVersion !== 'string' ||
    typeof host !== 'string' ||
    host === '' ||
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    typeof identityFileName !== 'string' ||
    identityFileName === ''
  ) {
    throw new WorkerHostStateError('invalid', 'the host-local Worker configuration is incomplete');
  }
  return {
    version: 1,
    enrollmentId,
    environmentInstanceId,
    protocolVersion,
    endpoint: { host, port },
    identityFileName,
  };
}

/** Persist the configuration with owner-only permissions. */
export function writeConfig(paths: WorkerHostPaths, config: WorkerHostConfig): void {
  writePrivateFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`);
}

/** Write the live daemon's state record with owner-only permissions. */
export function writeRuntimeState(paths: WorkerHostPaths, state: WorkerRuntimeState): void {
  writePrivateFile(paths.runtimePath, `${JSON.stringify(state, null, 2)}\n`);
}

/** Read the live daemon's state record, returning `undefined` when absent. */
export function readRuntimeState(paths: WorkerHostPaths): WorkerRuntimeState | undefined {
  if (!existsSync(paths.runtimePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(paths.runtimePath, 'utf8')) as WorkerRuntimeState;
    if (typeof parsed?.pid !== 'number' || typeof parsed?.state !== 'string') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Remove the runtime state record. */
export function clearRuntimeState(paths: WorkerHostPaths): void {
  removeFileIfPresent(paths.runtimePath);
}

/**
 * Whether a pid names a live process.
 *
 * `EPERM` means the process exists but belongs to another user; the Worker only
 * ever cares about its own uid, so it is still treated as alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether a pid is this host's own Worker daemon.
 *
 * Checking the process command line is what keeps a stale pid file from being
 * trusted after the OS reused the number for an unrelated process. The check is
 * deliberately a positive match on both the `sprout` entry point and the
 * `worker start` subcommand; a stranger's process never matches.
 */
export function isWorkerDaemonProcess(pid: number, run: CommandRunner = defaultCommandRunner): boolean {
  try {
    const command = run('ps', ['-p', String(pid), '-o', 'command=']).trim();
    return command.includes('sprout') && command.includes('worker') && command.includes('start');
  } catch {
    // An unreadable command line is not evidence of a live Worker.
    return false;
  }
}

/** Run one host command and return its stdout, throwing on a non-zero exit. */
export type CommandRunner = (command: string, args: readonly string[]) => string;

function defaultCommandRunner(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Read a one-use claim secret from stdin without echoing it.
 *
 * The secret never becomes an argument and never enters shell history. On a TTY
 * the terminal echo is disabled for the duration and nothing is written back; on
 * a pipe the line is read directly. The value is bounded, so a stream that never
 * terminates cannot exhaust memory, and it is never written to the log.
 */
export async function readSecretFromStdin(
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => void },
  output: NodeJS.WritableStream,
  prompt: string,
): Promise<string> {
  output.write(prompt);
  if (input.isTTY === true && typeof input.setRawMode === 'function') {
    return readSecretRaw(input, output);
  }
  return readSecretLine(input);
}

const MAX_SECRET_LENGTH = 4_096;

function readSecretRaw(
  input: NodeJS.ReadableStream & { setRawMode?: (mode: boolean) => void },
  output: NodeJS.WritableStream,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let secret = '';
    input.setRawMode?.(true);
    input.resume();
    const finish = (error?: Error): void => {
      input.setRawMode?.(false);
      input.removeListener('data', onData);
      output.write('\n');
      if (error !== undefined) reject(error);
      else resolve(secret);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\n' || character === '\r') {
          finish();
          return;
        }
        if (character === '\u0003') {
          finish(new Error('enrollment cancelled'));
          return;
        }
        if (character === '\u007f' || character === '\b') {
          secret = secret.slice(0, -1);
          continue;
        }
        if (secret.length >= MAX_SECRET_LENGTH) continue;
        secret += character;
      }
    };
    input.on('data', onData);
    input.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

function readSecretLine(input: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString('utf8');
      const newline = buffer.search(/[\r\n]/);
      if (newline === -1) {
        if (buffer.length > MAX_SECRET_LENGTH) {
          cleanup();
          reject(new Error('the enrollment claim secret is unreasonably long'));
        }
        return;
      }
      const secret = buffer.slice(0, newline);
      cleanup();
      resolve(secret);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(buffer.trim());
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
    };
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
  });
}

/**
 * A host-local single-instance lock.
 *
 * Two Workers for the same environment must never both run: the core would see
 * two identities competing for one epoch, and a duplicate connection could
 * invalidate a healthy one. The lock is an owner-only pid file whose liveness is
 * re-confirmed against the process command line, so a stale file never blocks a
 * legitimate start and a reused pid never masquerades as this Worker.
 */
export class DuplicateWorkerProcessError extends Error {
  override readonly name = 'DuplicateWorkerProcessError';
  readonly pid: number;

  constructor(pid: number) {
    super(`another Sprout Worker for this environment is already running (pid ${pid})`);
    this.pid = pid;
  }
}

/** The pid file a running Worker holds for the lifetime of `start`. */
export function workerLockPath(paths: WorkerHostPaths): string {
  return join(paths.stateDirectory, 'worker.lock');
}

/**
 * Acquire the single-instance lock, or throw when a live Worker holds it.
 *
 * The check-then-write is guarded by opening the file exclusively (`wx`), so two
 * concurrent `start` processes cannot both acquire it even when they race. A
 * file that exists but whose recorded pid is dead (or is not this host's Worker)
 * is reclaimed.
 */
export function acquireWorkerLock(
  paths: WorkerHostPaths,
  pid: number,
  run: CommandRunner = defaultCommandRunner,
): { readonly release: () => void; readonly path: string } {
  ensureStateDirectory(paths);
  const lockPath = workerLockPath(paths);
  const existing = readLockPid(lockPath);
  if (existing !== undefined && existing !== pid && isProcessAlive(existing) && isWorkerDaemonProcess(existing, run)) {
    throw new DuplicateWorkerProcessError(existing);
  }
  // Replace any stale or absent lock with ours.
  removeFileIfPresent(lockPath);
  const descriptor = openSync(lockPath, 'wx', PRIVATE_FILE_MODE);
  try {
    writeFileSync(descriptor, `${pid}\n`, 'utf8');
  } finally {
    closeSync(descriptor);
  }
  return {
    path: lockPath,
    release: () => removeFileIfPresent(lockPath),
  };
}

function readLockPid(lockPath: string): number | undefined {
  if (!existsSync(lockPath)) return undefined;
  try {
    const parsed = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Remove every host-local Worker file, used by `reset`. */
export function removeHostState(paths: WorkerHostPaths): void {
  removeFileIfPresent(paths.identityPath);
  removeFileIfPresent(paths.configPath);
  removeFileIfPresent(paths.runtimePath);
  removeFileIfPresent(workerLockPath(paths));
  // The directory is removed only when it is empty, so an operator's unrelated
  // files under an overridden state root are never deleted by `reset`.
  try {
    rmdirSync(paths.stateDirectory);
  } catch {
    // Missing or non-empty is acceptable.
  }
}
