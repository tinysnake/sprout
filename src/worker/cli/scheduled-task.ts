/**
 * Windows signed-in-user Scheduled Task lifecycle for the Sprout Worker (#164,
 * ADR-0003/0009).
 *
 * On win32, the Worker runs in the signed-in user's context after sign-in,
 * restarts after an unexpected exit with bounded behaviour, and can be inspected
 * and removed cleanly. On Windows that is a per-user Scheduled Task configured
 * with a logon trigger (`-AtLogOn` for the signed-in user), restart settings
 * (`RestartCount`/`RestartInterval`), `StartWhenAvailable`, and no execution
 * time limit (`PT0S`).
 *
 * This Module owns only the Scheduled Task specifics: command rendering,
 * PowerShell task registration, inspection, and removal. It never names an
 * enrollment secret or identity key in the task action or arguments: the task
 * runs `worker start --foreground`, and `start` reads its own host-local config.
 */

import { execFileSync } from 'node:child_process';
import { extname } from 'node:path';

import type { CommandRunner, WorkerHostPaths } from './host-state.ts';

/** Default restart count before Task Scheduler suspends restarting. */
export const WORKER_TASK_RESTART_COUNT = 3;

/** Restart throttle interval in minutes (Task Scheduler floor is 1 minute). */
export const WORKER_TASK_RESTART_INTERVAL_MINUTES = 1;

/** Escape a string for safe embedding inside a PowerShell single-quoted string literal. */
export function escapePowershellString(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

export interface ScheduledTaskAction {
  readonly execute: string;
  readonly argument: string;
  readonly workingDirectory: string;
}

/**
 * Resolve the action command and arguments for the Scheduled Task.
 *
 * If the CLI executable is already an executable file (`.exe`, `.cmd`, `.bat`) or
 * the bare `sprout` command, it is executed directly with the provided arguments.
 * Otherwise, the node executable runs the entry point script so that extensionless
 * files or scripts survive Task Scheduler dispatch.
 */
export function resolveScheduledTaskAction(
  paths: WorkerHostPaths,
  args: readonly string[] = ['worker', 'start', '--foreground'],
  homeDir?: string,
): ScheduledTaskAction {
  const workingDirectory =
    homeDir ?? process.env['USERPROFILE'] ?? process.env['HOME'] ?? paths.stateDirectory;
  const ext = extname(paths.executablePath).toLowerCase();
  if (ext === '.exe' || ext === '.cmd' || ext === '.bat' || paths.executablePath === 'sprout') {
    return {
      execute: paths.executablePath,
      argument: args.join(' '),
      workingDirectory,
    };
  }
  const quotedScript = paths.executablePath.startsWith('"')
    ? paths.executablePath
    : `"${paths.executablePath}"`;
  return {
    execute: paths.nodeExecutable,
    argument: `${quotedScript} ${args.join(' ')}`,
    workingDirectory,
  };
}

export interface ScheduledTaskRenderOptions {
  readonly taskName: string;
  readonly action: ScheduledTaskAction;
  readonly restartCount?: number;
  readonly restartIntervalMinutes?: number;
}

/**
 * Render the PowerShell script that registers the logon-triggered Scheduled Task.
 */
export function renderScheduledTaskScript(options: ScheduledTaskRenderOptions): string {
  const restartCount = options.restartCount ?? WORKER_TASK_RESTART_COUNT;
  const restartIntervalMinutes =
    options.restartIntervalMinutes ?? WORKER_TASK_RESTART_INTERVAL_MINUTES;
  return [
    `$action = New-ScheduledTaskAction -Execute ${escapePowershellString(options.action.execute)} -Argument ${escapePowershellString(options.action.argument)} -WorkingDirectory ${escapePowershellString(options.action.workingDirectory)}`,
    '$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME',
    `$settings = New-ScheduledTaskSettingsSet -RestartCount ${restartCount} -RestartInterval (New-TimeSpan -Minutes ${restartIntervalMinutes}) -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`,
    `Register-ScheduledTask -TaskName ${escapePowershellString(options.taskName)} -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
  ].join('\n');
}

export interface ScheduledTaskInstallOptions {
  readonly paths: WorkerHostPaths;
  readonly taskName: string;
  readonly arguments?: readonly string[];
  readonly run?: CommandRunner;
  readonly homeDir?: string;
  readonly restartCount?: number;
  readonly restartIntervalMinutes?: number;
}

export interface ScheduledTaskInstallResult {
  readonly taskName: string;
  readonly installed: boolean;
}

/**
 * Register (or update) the logon-triggered Scheduled Task for the signed-in user.
 */
export function installScheduledTask(
  options: ScheduledTaskInstallOptions,
): ScheduledTaskInstallResult {
  const run = options.run ?? defaultRun;
  const action = resolveScheduledTaskAction(
    options.paths,
    options.arguments ?? ['worker', 'start', '--foreground'],
    options.homeDir,
  );
  const script = renderScheduledTaskScript({
    taskName: options.taskName,
    action,
    ...(options.restartCount !== undefined ? { restartCount: options.restartCount } : {}),
    ...(options.restartIntervalMinutes !== undefined
      ? { restartIntervalMinutes: options.restartIntervalMinutes }
      : {}),
  });

  try {
    run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Stop-ScheduledTask -TaskName ${escapePowershellString(options.taskName)} -ErrorAction SilentlyContinue`,
    ]);
  } catch {
    // If not running or not yet registered, stopping is a no-op.
  }

  run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ]);

  return { taskName: options.taskName, installed: true };
}

export type ScheduledTaskUninstallFailureReason = 'unregister-failed';

export class ScheduledTaskUninstallError extends Error {
  override readonly name = 'ScheduledTaskUninstallError';
  readonly reason: ScheduledTaskUninstallFailureReason;

  constructor(reason: ScheduledTaskUninstallFailureReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Remove the Scheduled Task from Windows Task Scheduler.
 */
export function uninstallScheduledTask(options: {
  readonly taskName: string;
  readonly run?: CommandRunner;
}): { readonly removed: boolean } {
  const run = options.run ?? defaultRun;
  const script = [
    `$t = Get-ScheduledTask -TaskName ${escapePowershellString(options.taskName)} -ErrorAction SilentlyContinue`,
    "if (!$t) { Write-Output 'NOT_INSTALLED'; exit 0 }",
    `Stop-ScheduledTask -TaskName ${escapePowershellString(options.taskName)} -ErrorAction SilentlyContinue`,
    `Unregister-ScheduledTask -TaskName ${escapePowershellString(options.taskName)} -Confirm:$false`,
    "Write-Output 'REMOVED'",
  ].join('; ');

  let output: string;
  try {
    output = run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ]).trim();
  } catch (error) {
    throw new ScheduledTaskUninstallError(
      'unregister-failed',
      `the Scheduled Task could not be removed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.includes('NOT_INSTALLED')) {
    return { removed: false };
  }
  if (lines.includes('REMOVED')) {
    return { removed: true };
  }
  throw new ScheduledTaskUninstallError(
    'unregister-failed',
    `unexpected output while removing Scheduled Task: ${output}`,
  );
}

export interface ScheduledTaskInspection {
  readonly taskName: string;
  readonly state: 'Ready' | 'Running' | 'Disabled' | 'Unknown';
  readonly enabled: boolean;
  readonly lastTaskResult?: number;
}

/**
 * Inspect the registered Scheduled Task, returning undefined when not registered.
 */
export function inspectScheduledTask(options: {
  readonly taskName: string;
  readonly run?: CommandRunner;
}): ScheduledTaskInspection | undefined {
  const run = options.run ?? defaultRun;
  const script = `$t = Get-ScheduledTask -TaskName ${escapePowershellString(options.taskName)} -ErrorAction SilentlyContinue; if (!$t) { exit 1 }; $i = Get-ScheduledTaskInfo -TaskName ${escapePowershellString(options.taskName)} -ErrorAction SilentlyContinue; [PSCustomObject]@{ TaskName = $t.TaskName; State = $t.State.ToString(); Enabled = ($t.Settings.Enabled -and ($t.State -ne 'Disabled')); LastTaskResult = if ($i) { $i.LastTaskResult } else { $null } } | ConvertTo-Json -Compress`;

  try {
    const raw = run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ]).trim();
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as {
      TaskName?: string;
      State?: string;
      Enabled?: boolean;
      LastTaskResult?: number | null;
    };
    if (typeof parsed.TaskName !== 'string') return undefined;
    const state =
      parsed.State === 'Ready' || parsed.State === 'Running' || parsed.State === 'Disabled'
        ? parsed.State
        : 'Unknown';
    return {
      taskName: parsed.TaskName,
      state,
      enabled: parsed.Enabled ?? state !== 'Disabled',
      ...(parsed.LastTaskResult !== null && parsed.LastTaskResult !== undefined
        ? { lastTaskResult: parsed.LastTaskResult }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Start the registered Scheduled Task immediately.
 */
export function startScheduledTask(options: {
  readonly taskName: string;
  readonly run?: CommandRunner;
}): void {
  const run = options.run ?? defaultRun;
  run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Start-ScheduledTask -TaskName ${escapePowershellString(options.taskName)}`,
  ]);
}

/**
 * Stop the registered Scheduled Task if running.
 */
export function stopScheduledTask(options: {
  readonly taskName: string;
  readonly run?: CommandRunner;
}): void {
  const run = options.run ?? defaultRun;
  run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Stop-ScheduledTask -TaskName ${escapePowershellString(options.taskName)} -ErrorAction SilentlyContinue`,
  ]);
}

function defaultRun(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
