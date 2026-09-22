/**
 * macOS signed-in-user LaunchAgent lifecycle for the Sprout Worker (#117,
 * ADR-0003/0009).
 *
 * The Worker runs in the signed-in user's context after sign-in, restarts after
 * an unexpected exit with bounded behaviour, and can be inspected and removed
 * cleanly. On macOS that is a per-user `LaunchAgent` managed by `launchctl` in
 * the `gui/<uid>` domain — never a root LaunchDaemon, because a system service
 * cannot uniformly see the interactive user's engine login, keychain, or
 * workspace (see `docs/research/macos-windows-environment-enrollment.md`).
 *
 * This Module owns only the launchd-specific facts: the property list, the
 * `launchctl` verbs, and the bounded restart policy. It never names an
 * enrollment secret and never reads the identity key: the plist names the
 * `sprout worker start` subcommand, and `start` reads its own host-local config.
 *
 * The design follows the LaunchAgent pattern used by the Cumora reference
 * (`server/src/agents/computer/daemon.ts` at
 * `a0309618b9102fc79221f8580afdd2f2372ab5df`, MIT): a per-user plist under
 * `~/Library/LaunchAgents`, `RunAtLoad`, a restart policy, stdout/stderr log
 * paths, and `launchctl` load/unload. Sprout deviations are deliberate: the
 * plist is written owner-only, `KeepAlive` is a bounded `SuccessfulExit=false`
 * policy rather than an unconditional `true`, and no `@latest` self-update is
 * embedded, because Sprout has no package-update contract here.
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { execFileSync } from 'node:child_process';

import {
  WORKER_SERVICE_LABEL_PREFIX,
  workerServiceLabel,
  writePrivateFile,
  type CommandRunner,
  type WorkerHostPaths,
} from './host-state.ts';

/** How long launchd waits between an unexpected exit and a restart. */
export const WORKER_RESTART_THROTTLE_SECONDS = 10;

/** The exact `launchctl` verbs this Module uses, so tests can assert them. */
export type LaunchctlVerb = 'bootstrap' | 'bootout' | 'kickstart' | 'print';

export interface LaunchAgentRenderOptions {
  readonly label: string;
  /** The `sprout` executable to run. */
  readonly executablePath: string;
  /** The arguments after the executable, always `worker start`. */
  readonly arguments: readonly string[];
  readonly logPath: string;
  /** Extra environment variable names to forward; values are never rendered. */
  readonly environment: Readonly<Record<string, string>>;
}

/**
 * Render the LaunchAgent property list.
 *
 * `KeepAlive` is `{SuccessfulExit: false}`: launchd restarts the Worker after a
 * crash or a non-zero exit, but a deliberate `exit 0` (for example after
 * `uninstall-service` requests a stop) is left stopped. `ThrottleInterval`
 * bounds the restart rate. `RunAtLoad` starts it at sign-in.
 *
 * XML escaping is explicit rather than assumed: a path or label that contains
 * `&`, `<`, or `>` must not produce an invalid or injected plist.
 */
export function renderLaunchAgent(options: LaunchAgentRenderOptions): string {
  const args = [options.executablePath, ...options.arguments];
  const environment = Object.entries(options.environment)
    .map(
      ([name, value]) =>
        `    <key>${escapeXml(name)}</key>\n    <string>${escapeXml(value)}</string>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>${WORKER_RESTART_THROTTLE_SECONDS}</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(options.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(options.logPath)}</string>
  <key>WorkingDirectory</key>
  <string>${escapeXml(options.environment['HOME'] ?? '/')}</string>
${
  environment === ''
    ? ''
    : `  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
`
}</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The target domain for the signed-in user's LaunchAgent. */
export function launchAgentDomain(uid: number): string {
  return `gui/${uid}`;
}

/** The absolute plist path for one environment instance. */
export function launchAgentPlistPath(paths: WorkerHostPaths, environmentInstanceId: string): string {
  return join(paths.launchAgentsDirectory, `${workerServiceLabel(environmentInstanceId)}.plist`);
}

export interface ServiceInstallResult {
  readonly label: string;
  readonly plistPath: string;
  readonly installed: boolean;
}

/**
 * Install (or reinstall) the LaunchAgent in the signed-in user's domain.
 *
 * Reinstalling first boots the previous job out, so a changed executable path or
 * environment takes effect rather than being shadowed by the already-loaded job.
 * A missing `launchctl` is reported rather than hidden; a non-macOS host is
 * refused by the caller before this is reached.
 */
export function installLaunchAgent(
  options: {
    readonly paths: WorkerHostPaths;
    readonly label: string;
    readonly plistPath: string;
    readonly plistContent: string;
    readonly uid: number;
    readonly run?: CommandRunner;
  },
): ServiceInstallResult {
  const run = options.run ?? defaultRun;
  mkdirSync(options.paths.launchAgentsDirectory, { recursive: true });
  // Owner-only: the plist names a host-local executable and log paths, and it is
  // a per-user job that no other account should read or replace.
  writePrivateFile(options.plistPath, options.plistContent);

  const domain = launchAgentDomain(options.uid);
  const service = `${domain}/${options.label}`;
  // Boot out a previously loaded job so the new plist is what launchd reads.
  try {
    run('launchctl', ['bootout', service]);
  } catch (error) {
    // A launchctl diagnostic is not proof of absence.  In particular, do not
    // treat an errno or a translated message as one: query the domain below.
    if (!serviceIsAbsent(run, options.uid, options.label)) throw error;
  }
  if (!serviceIsAbsent(run, options.uid, options.label)) {
    throw new Error(`launchctl bootout for ${service} did not unload the service`);
  }
  run('launchctl', ['bootstrap', domain, options.plistPath]);
  return { label: options.label, plistPath: options.plistPath, installed: true };
}

/**
 * Why an uninstall stopped before the plist was safe to remove.
 */
export type LaunchAgentUninstallFailureReason = 'bootout-failed' | 'delete-failed';

/** Thrown by `uninstallLaunchAgent` when the job could not be cleanly unloaded or removed. */
export class LaunchAgentUninstallError extends Error {
  override readonly name = 'LaunchAgentUninstallError';
  readonly reason: LaunchAgentUninstallFailureReason;

  constructor(reason: LaunchAgentUninstallFailureReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Remove the LaunchAgent from the signed-in user's domain and disk.
 *
 * This is deliberately fail-closed: a `bootout` error other than "the job is
 * not loaded" leaves the loaded job in place and is reported, and the plist is
 * only removed after the job is confirmed gone (or was never loaded). A loaded
 * service that keeps restarting must never be left behind while the caller
 * reports success — `reset` in particular refuses to destroy the identity a
 * loaded service would still use.
 */
export function uninstallLaunchAgent(options: {
  readonly label: string;
  readonly plistPath: string;
  readonly uid: number;
  readonly run?: CommandRunner;
}): { readonly removed: boolean } {
  const run = options.run ?? defaultRun;
  const service = `${launchAgentDomain(options.uid)}/${options.label}`;
  try {
    run('launchctl', ['bootout', service]);
  } catch (error) {
    if (!serviceIsAbsent(run, options.uid, options.label)) {
      throw new LaunchAgentUninstallError(
        'bootout-failed',
        'launchctl could not prove that the exact Worker service was unloaded; the service is left in place',
      );
    }
  }
  if (!serviceIsAbsent(run, options.uid, options.label)) {
    throw new LaunchAgentUninstallError(
      'bootout-failed',
      `launchctl bootout for ${service} did not prove that the service is unloaded`,
    );
  }
  const existed = existsSync(options.plistPath);
  if (existed) {
    try {
      unlinkSync(options.plistPath);
    } catch (error) {
      throw new LaunchAgentUninstallError(
        'delete-failed',
        'the LaunchAgent property list could not be removed; the service is left in place',
      );
    }
  }
  return { removed: existed };
}

/**
 * Explicit absence proof for a job in a usable launchd domain.
 *
 * `bootout` errors have platform- and locale-specific wording, so they are
 * never classified.  A successful domain query whose service listing lacks the
 * exact label is the only absence proof accepted by destructive callers.
 */
export function serviceIsAbsent(run: CommandRunner, uid: number, label: string): boolean {
  const listing = run('launchctl', ['print', launchAgentDomain(uid)]);
  return !new RegExp(`(?:^|[^A-Za-z0-9_.-])${escapeRegExp(label)}(?:$|[^A-Za-z0-9_.-])`, 'm').test(listing);
}

/** Return every managed label launchd currently reports for this user. */
export function loadedWorkerServiceLabels(run: CommandRunner, uid: number): readonly string[] {
  const listing = run('launchctl', ['print', launchAgentDomain(uid)]);
  const matches = listing.match(new RegExp(`${escapeRegExp(WORKER_SERVICE_LABEL_PREFIX)}\\.[0-9a-f]{16}`, 'g')) ?? [];
  return [...new Set(matches)];
}

/** Return labels recoverable from owner-owned plist metadata without trusting config. */
export function storedWorkerServiceLabels(directory: string): readonly string[] {
  try {
    return readdirSync(directory)
      .map((entry) => entry.match(new RegExp(`^(${escapeRegExp(WORKER_SERVICE_LABEL_PREFIX)}\\.[0-9a-f]{16})\\.plist$`))?.[1])
      .filter((label): label is string => label !== undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


/**
 * Restart the loaded LaunchAgent in place.
 *
 * `kickstart -k` is the supported way to restart a job without unloading it, so
 * `restart` applies a re-read of host-local config without racing a second
 * foreground daemon.
 */
export function restartLaunchAgent(options: {
  readonly label: string;
  readonly uid: number;
  readonly run?: CommandRunner;
}): void {
  const run = options.run ?? defaultRun;
  run('launchctl', ['kickstart', '-k', `${launchAgentDomain(options.uid)}/${options.label}`]);
}

/**
 * Read `launchctl print` output for one job, or `undefined` when not loaded.
 */
export function inspectLaunchAgent(options: {
  readonly label: string;
  readonly uid: number;
  readonly run?: CommandRunner;
}): string | undefined {
  const run = options.run ?? defaultRun;
  try {
    return run('launchctl', ['print', `${launchAgentDomain(options.uid)}/${options.label}`]);
  } catch {
    return undefined;
  }
}

function defaultRun(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
