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

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { execFileSync } from 'node:child_process';

import {
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
  } catch {
    // Not loaded yet (or already gone) is the desired pre-state.
  }
  try {
    run('launchctl', ['bootstrap', domain, options.plistPath]);
  } catch (error) {
    // A second `bootstrap` for an already-loaded job is a benign race; anything
    // else is a real failure the operator must see.
    if (!isAlreadyBootstrapped(error)) throw error;
  }
  return { label: options.label, plistPath: options.plistPath, installed: true };
}

/** Remove the LaunchAgent from the signed-in user's domain and disk. */
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
  } catch {
    // An already-unloaded job still needs its plist removed.
  }
  const existed = existsSync(options.plistPath);
  rmSync(options.plistPath, { force: true });
  return { removed: existed };
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

function isAlreadyBootstrapped(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already (bootstrapped|loaded)|service already loaded|Bootstrap failed: 5/i.test(message);
}

function defaultRun(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
