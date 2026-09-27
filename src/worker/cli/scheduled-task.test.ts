import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  escapePowershellString,
  inspectScheduledTask,
  installScheduledTask,
  renderScheduledTaskScript,
  resolveScheduledTaskAction,
  startScheduledTask,
  stopScheduledTask,
  uninstallScheduledTask,
  ScheduledTaskUninstallError,
  WORKER_TASK_RESTART_COUNT,
  WORKER_TASK_RESTART_INTERVAL_MINUTES,
} from './scheduled-task.ts';
import type { WorkerHostPaths } from './host-state.ts';

function dummyPaths(overrides: Partial<WorkerHostPaths> = {}): WorkerHostPaths {
  return {
    stateDirectory: 'C:\\Users\\testuser\\.sprout\\worker',
    configPath: 'C:\\Users\\testuser\\.sprout\\worker\\config.json',
    identityPath: 'C:\\Users\\testuser\\.sprout\\worker\\identity.pem',
    runtimePath: 'C:\\Users\\testuser\\.sprout\\worker\\runtime.json',
    logPath: 'C:\\Users\\testuser\\.sprout\\worker\\worker.log',
    launchAgentsDirectory: 'C:\\Users\\testuser\\Library\\LaunchAgents',
    executablePath: 'C:\\Users\\testuser\\sprout\\bin\\sprout',
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    ...overrides,
  };
}

test('escapePowershellString wraps in single quotes and escapes embedded single quotes', () => {
  assert.equal(escapePowershellString('simple'), "'simple'");
  assert.equal(escapePowershellString("user's name"), "'user''s name'");
  assert.equal(escapePowershellString("a'b'c"), "'a''b''c'");
  assert.equal(escapePowershellString(''), "''");
  assert.equal(
    escapePowershellString('C:\\path\\with\\$dollars\\and"quotes"'),
    "'C:\\path\\with\\$dollars\\and\"quotes\"'",
  );
});

test('resolveScheduledTaskAction resolves extensionless scripts to node executable', () => {
  const paths = dummyPaths({
    executablePath: 'C:\\sprout\\bin\\sprout',
    nodeExecutable: 'C:\\nodejs\\node.exe',
  });
  const action = resolveScheduledTaskAction(paths, ['worker', 'start', '--foreground'], 'C:\\Users\\testuser');
  assert.equal(action.execute, 'C:\\nodejs\\node.exe');
  assert.equal(action.argument, '"C:\\sprout\\bin\\sprout" worker start --foreground');
  assert.equal(action.workingDirectory, 'C:\\Users\\testuser');
});

test('resolveScheduledTaskAction preserves executable extensions and bare sprout command', () => {
  const exePaths = dummyPaths({ executablePath: 'C:\\sprout\\sprout.cmd' });
  const exeAction = resolveScheduledTaskAction(exePaths, ['worker', 'start', '--foreground'], 'C:\\Users\\testuser');
  assert.equal(exeAction.execute, 'C:\\sprout\\sprout.cmd');
  assert.equal(exeAction.argument, 'worker start --foreground');

  const barePaths = dummyPaths({ executablePath: 'sprout' });
  const bareAction = resolveScheduledTaskAction(barePaths, ['worker', 'start', '--foreground'], 'C:\\Users\\testuser');
  assert.equal(bareAction.execute, 'sprout');
  assert.equal(bareAction.argument, 'worker start --foreground');
});

test('renderScheduledTaskScript produces required logon trigger and restart settings', () => {
  const script = renderScheduledTaskScript({
    taskName: 'dev.sprout.worker.1234567890abcdef',
    action: {
      execute: 'C:\\nodejs\\node.exe',
      argument: '"C:\\sprout\\bin\\sprout" worker start --foreground',
      workingDirectory: 'C:\\Users\\testuser',
    },
    restartCount: WORKER_TASK_RESTART_COUNT,
    restartIntervalMinutes: WORKER_TASK_RESTART_INTERVAL_MINUTES,
  });

  assert.match(script, /New-ScheduledTaskAction -Execute 'C:\\nodejs\\node\.exe' -Argument '"C:\\sprout\\bin\\sprout" worker start --foreground' -WorkingDirectory 'C:\\Users\\testuser'/);
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn -User \$env:USERNAME/);
  assert.match(script, /New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval \(New-TimeSpan -Minutes 1\) -StartWhenAvailable -ExecutionTimeLimit \(\[TimeSpan\]::Zero\) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries/);
  assert.match(script, /Register-ScheduledTask -TaskName 'dev\.sprout\.worker\.1234567890abcdef' -Action \$action -Trigger \$trigger -Settings \$settings -Force \| Out-Null/);
});

test('installScheduledTask stops prior task, registers with powershell.exe, and returns result', () => {
  const paths = dummyPaths();
  const calls: { command: string; args: readonly string[] }[] = [];
  const run = (command: string, args: readonly string[]): string => {
    calls.push({ command, args });
    return '';
  };

  const result = installScheduledTask({
    paths,
    taskName: 'dev.sprout.worker.test',
    run,
    homeDir: 'C:\\Users\\testuser',
  });

  assert.equal(result.taskName, 'dev.sprout.worker.test');
  assert.equal(result.installed, true);
  assert.equal(calls.length, 2);

  assert.equal(calls[0]!.command, 'powershell.exe');
  assert.match(calls[0]!.args.join(' '), /Stop-ScheduledTask -TaskName 'dev\.sprout\.worker\.test'/);

  assert.equal(calls[1]!.command, 'powershell.exe');
  assert.match(calls[1]!.args.join(' '), /Register-ScheduledTask -TaskName 'dev\.sprout\.worker\.test'/);
  assert.match(calls[1]!.args.join(' '), /worker start --foreground/);
  assert.match(calls[1]!.args.join(' '), /-AtLogOn/);
  assert.match(calls[1]!.args.join(' '), /StartWhenAvailable/);
  assert.match(calls[1]!.args.join(' '), /ExecutionTimeLimit/);
});

test('startScheduledTask and stopScheduledTask invoke powershell.exe with correct cmdlets', () => {
  const calls: string[] = [];
  const run = (command: string, args: readonly string[]): string => {
    calls.push([command, ...args].join(' '));
    return '';
  };

  startScheduledTask({ taskName: 'dev.sprout.worker.test', run });
  assert.ok(calls.some((c) => c.includes("Start-ScheduledTask -TaskName 'dev.sprout.worker.test'")));

  calls.length = 0;
  stopScheduledTask({ taskName: 'dev.sprout.worker.test', run });
  assert.ok(calls.some((c) => c.includes("Stop-ScheduledTask -TaskName 'dev.sprout.worker.test'")));
});

test('inspectScheduledTask returns task details when task is found', () => {
  const run = (_command: string, _args: readonly string[]): string => {
    return JSON.stringify({
      TaskName: 'dev.sprout.worker.test',
      State: 'Ready',
      Enabled: true,
      LastTaskResult: 0,
    });
  };

  const inspection = inspectScheduledTask({ taskName: 'dev.sprout.worker.test', run });
  assert.deepEqual(inspection, {
    taskName: 'dev.sprout.worker.test',
    state: 'Ready',
    enabled: true,
    lastTaskResult: 0,
  });
});

test('inspectScheduledTask returns undefined when task is absent or command throws', () => {
  const throwingRun = (): string => {
    throw new Error('exit status 1');
  };
  assert.equal(inspectScheduledTask({ taskName: 'dev.sprout.worker.absent', run: throwingRun }), undefined);

  const emptyRun = (): string => '';
  assert.equal(inspectScheduledTask({ taskName: 'dev.sprout.worker.absent', run: emptyRun }), undefined);

  const malformedRun = (): string => 'not-json';
  assert.equal(inspectScheduledTask({ taskName: 'dev.sprout.worker.absent', run: malformedRun }), undefined);
});

test('uninstallScheduledTask removes task and reports true when present', () => {
  const calls: string[] = [];
  const run = (command: string, args: readonly string[]): string => {
    calls.push([command, ...args].join(' '));
    return 'REMOVED\n';
  };

  const result = uninstallScheduledTask({ taskName: 'dev.sprout.worker.test', run });
  assert.equal(result.removed, true);
  assert.ok(calls.some((c) => c.includes("Unregister-ScheduledTask -TaskName 'dev.sprout.worker.test'")));
});

test('uninstallScheduledTask reports false when task was not installed', () => {
  const run = (): string => 'NOT_INSTALLED\n';
  const result = uninstallScheduledTask({ taskName: 'dev.sprout.worker.test', run });
  assert.equal(result.removed, false);
});

test('uninstallScheduledTask fails closed when unregister command fails', () => {
  const throwingRun = (): string => {
    throw new Error('Access denied');
  };
  assert.throws(
    () => uninstallScheduledTask({ taskName: 'dev.sprout.worker.test', run: throwingRun }),
    (error) => error instanceof ScheduledTaskUninstallError && error.reason === 'unregister-failed',
  );

  const unexpectedOutputRun = (): string => 'UNEXPECTED_OUTPUT';
  assert.throws(
    () => uninstallScheduledTask({ taskName: 'dev.sprout.worker.test', run: unexpectedOutputRun }),
    (error) => error instanceof ScheduledTaskUninstallError && error.reason === 'unregister-failed',
  );
});
