import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkerCli, WORKER_EXIT } from './worker-cli.ts';
import {
  createWorkerOwnerToken,
  ensureStateDirectory,
  workerHostPaths,
  workerServiceLabel,
  writeConfig,
  writePrivateFile,
  writeRuntimeState,
  type CommandRunner,
  type WorkerHostConfig,
  type WorkerProcessIdentity,
} from './host-state.ts';
import { generateWorkerIdentity } from '../../environment/worker-proof.ts';
import { WORKER_PROTOCOL_VERSION } from '../protocol.ts';

function windowsHarness(overrides: {
  readonly platform?: NodeJS.Platform;
  readonly run?: CommandRunner;
  readonly processProbe?: (pid: number) => {
    readonly state: 'alive' | 'dead' | 'unknown';
    readonly process: WorkerProcessIdentity;
  };
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-win-'));
  const paths = workerHostPaths({
    HOME: root,
    USERPROFILE: root,
    SPROUT_WORKER_HOME: join(root, 'state'),
    SPROUT_CLI_PATH: 'C:\\sprout\\bin\\sprout',
  });
  const out: string[] = [];
  const err: string[] = [];

  const calls: { command: string; args: readonly string[] }[] = [];
  const defaultRun: CommandRunner = (command, args) => {
    calls.push({ command, args });
    const full = [command, ...args].join(' ');
    if (full.includes('Unregister-ScheduledTask')) {
      return 'REMOVED\n';
    }
    if (full.includes('Get-ScheduledTask')) {
      return JSON.stringify({
        TaskName: 'dev.sprout.worker.synthetic',
        State: 'Ready',
        Enabled: true,
        LastTaskResult: 0,
      });
    }
    return '';
  };

  const token = createWorkerOwnerToken();
  const currentIdentity: WorkerProcessIdentity = {
    pid: process.pid,
    startIdentity: 'test-process-start',
    ownerToken: token,
  };

  const cli = createWorkerCli({
    paths: () => paths,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    platform: overrides.platform ?? 'win32',
    run: overrides.run ?? defaultRun,
    uid: 1000,
    currentProcess: (ownerToken) => ({ ...currentIdentity, ownerToken }),
    processProbe: overrides.processProbe ?? ((pid) => ({ state: 'alive', process: { ...currentIdentity, pid } })),
  });

  const seedConfig = (instanceId = 'env-synthetic'): WorkerHostConfig => {
    ensureStateDirectory(paths);
    const config: WorkerHostConfig = {
      version: 1,
      enrollmentId: 'enroll-synthetic',
      environmentInstanceId: instanceId,
      protocolVersion: WORKER_PROTOCOL_VERSION,
      endpoint: { host: '127.0.0.1', port: 5174 },
      identityFileName: 'identity.pem',
    };
    writeConfig(paths, config);
    writePrivateFile(paths.identityPath, generateWorkerIdentity().privateKey);
    return config;
  };

  return {
    paths,
    out,
    err,
    calls,
    cli,
    cliCurrentToken: token,
    seedConfig,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('sprout worker install-service on win32 registers Scheduled Task with foreground reconnect loop', async () => {
  const h = windowsHarness();
  try {
    const config = h.seedConfig();
    const label = workerServiceLabel(config.environmentInstanceId);

    const status = await h.cli.run(['install-service']);
    assert.equal(status, WORKER_EXIT.ok);
    assert.match(h.out.join('\n'), new RegExp(`Installed Scheduled Task ${label}`));

    // Assert that powershell.exe was invoked
    const regCall = h.calls.find((c) => c.args.some((a) => a.includes('Register-ScheduledTask')));
    assert.ok(regCall, 'powershell.exe must be invoked to register the scheduled task');
    assert.equal(regCall.command, 'powershell.exe');

    const script = regCall.args.join(' ');
    assert.match(script, new RegExp(`-TaskName '${label}'`));
    assert.match(script, /-AtLogOn -User \$env:USERNAME/);
    assert.match(script, /RestartCount 3/);
    assert.match(script, /RestartInterval \(New-TimeSpan -Minutes 1\)/);
    assert.match(script, /StartWhenAvailable/);
    assert.match(script, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
    assert.match(script, /AllowStartIfOnBatteries/);
    assert.match(script, /DontStopIfGoingOnBatteries/);
    // Supervised process must be foreground reconnect loop
    assert.match(script, /worker start --foreground/);

    // Verify task is started immediately after registration
    const startCall = h.calls.find((c) => c.args.some((a) => a.includes('Start-ScheduledTask')));
    assert.ok(startCall, 'Start-ScheduledTask must be called to start immediately');
    assert.match(startCall.args.join(' '), new RegExp(`Start-ScheduledTask -TaskName '${label}'`));
  } finally {
    h.cleanup();
  }
});

test('sprout worker install-service fails closed when registration throws', async () => {
  const h = windowsHarness({
    run: (_command, args) => {
      if (args.some((a) => a.includes('Register-ScheduledTask'))) {
        throw new Error('Access denied');
      }
      return '';
    },
  });
  try {
    h.seedConfig();
    const status = await h.cli.run(['install-service']);
    assert.equal(status, WORKER_EXIT.serviceFailure);
    assert.match(h.err.join('\n'), /the Scheduled Task could not be installed/);
  } finally {
    h.cleanup();
  }
});

test('sprout worker install-service refuses arguments', async () => {
  const h = windowsHarness();
  try {
    const status = await h.cli.run(['install-service', '--unexpected']);
    assert.equal(status, WORKER_EXIT.usage);
    assert.match(h.err.join('\n'), /takes no arguments/);
  } finally {
    h.cleanup();
  }
});

test('sprout worker install-service fails when not enrolled', async () => {
  const h = windowsHarness();
  try {
    const status = await h.cli.run(['install-service']);
    assert.equal(status, WORKER_EXIT.notEnrolled);
    assert.match(h.err.join('\n'), /not enrolled/);
  } finally {
    h.cleanup();
  }
});

test('sprout worker uninstall-service removes task cleanly and reports honestly', async () => {
  const h = windowsHarness();
  try {
    const config = h.seedConfig();
    const label = workerServiceLabel(config.environmentInstanceId);

    const status = await h.cli.run(['uninstall-service']);
    assert.equal(status, WORKER_EXIT.ok);
    assert.match(h.out.join('\n'), new RegExp(`Removed Scheduled Task ${label}`));

    const unregCall = h.calls.find((c) => c.args.some((a) => a.includes('Unregister-ScheduledTask')));
    assert.ok(unregCall, 'powershell.exe must be invoked to unregister');
    assert.match(unregCall.args.join(' '), new RegExp(`Unregister-ScheduledTask -TaskName '${label}'`));
  } finally {
    h.cleanup();
  }
});

test('sprout worker uninstall-service reports honestly when task was not installed', async () => {
  const h = windowsHarness({
    run: () => 'NOT_INSTALLED\n',
  });
  try {
    const config = h.seedConfig();
    const label = workerServiceLabel(config.environmentInstanceId);

    const status = await h.cli.run(['uninstall-service']);
    assert.equal(status, WORKER_EXIT.ok);
    assert.match(h.out.join('\n'), new RegExp(`Scheduled Task ${label} was not installed`));
  } finally {
    h.cleanup();
  }
});

test('sprout worker uninstall-service fails closed when removal fails', async () => {
  const h = windowsHarness({
    run: () => {
      throw new Error('Access is denied');
    },
  });
  try {
    h.seedConfig();
    const status = await h.cli.run(['uninstall-service']);
    assert.equal(status, WORKER_EXIT.serviceFailure);
    assert.match(h.err.join('\n'), /the Scheduled Task could not be removed/);
  } finally {
    h.cleanup();
  }
});

test('sprout worker uninstall-service fails closed when output has non-terminating error alongside REMOVED (F2)', async () => {
  const h = windowsHarness({
    run: () => 'Unregister-ScheduledTask : Access is denied\nREMOVED\n',
  });
  try {
    h.seedConfig();
    const status = await h.cli.run(['uninstall-service']);
    assert.equal(status, WORKER_EXIT.serviceFailure);
    assert.match(h.err.join('\n'), /the Scheduled Task could not be removed/);
  } finally {
    h.cleanup();
  }
});

test('sprout worker uninstall-service refuses arguments', async () => {
  const h = windowsHarness();
  try {
    const status = await h.cli.run(['uninstall-service', '--extra']);
    assert.equal(status, WORKER_EXIT.usage);
    assert.match(h.err.join('\n'), /takes no arguments/);
  } finally {
    h.cleanup();
  }
});

test('sprout worker uninstall-service fails when not enrolled', async () => {
  const h = windowsHarness();
  try {
    const status = await h.cli.run(['uninstall-service']);
    assert.equal(status, WORKER_EXIT.notEnrolled);
    assert.match(h.err.join('\n'), /no host-local enrollment/);
  } finally {
    h.cleanup();
  }
});

test('sprout worker status projects service state truthfully on Windows', async () => {
  const h = windowsHarness({
    run: (_command, args) => {
      const script = args.join(' ');
      if (script.includes('Get-ScheduledTask')) {
        return JSON.stringify({
          TaskName: 'dev.sprout.worker.synthetic',
          State: 'Ready',
          Enabled: true,
          LastTaskResult: 0,
        });
      }
      return '';
    },
  });
  try {
    h.seedConfig();
    const status = await h.cli.run(['status']);
    assert.equal(status, WORKER_EXIT.ok);
    assert.match(h.out.join('\n'), /service: installed and loaded/);
    assert.match(h.out.join('\n'), /state: stopped/);
  } finally {
    h.cleanup();
  }
});

test('sprout worker status reports installed but not loaded when task is disabled', async () => {
  const h = windowsHarness({
    run: (_command, args) => {
      const script = args.join(' ');
      if (script.includes('Get-ScheduledTask')) {
        return JSON.stringify({
          TaskName: 'dev.sprout.worker.synthetic',
          State: 'Disabled',
          Enabled: false,
          LastTaskResult: 0,
        });
      }
      return '';
    },
  });
  try {
    h.seedConfig();
    const status = await h.cli.run(['status']);
    assert.equal(status, WORKER_EXIT.ok);
    assert.match(h.out.join('\n'), /service: installed but not loaded/);
  } finally {
    h.cleanup();
  }
});

test('sprout worker status reports not-installed when task is confirmed absent', async () => {
  const h = windowsHarness({
    run: () => 'NOT_INSTALLED\n',
  });
  try {
    h.seedConfig();
    const status = await h.cli.run(['status']);
    assert.equal(status, WORKER_EXIT.ok);
    assert.match(h.out.join('\n'), /service: not-installed/);
  } finally {
    h.cleanup();
  }
});

test('sprout worker status reports service: failed and exits serviceFailure when task inspection fails', async () => {
  const h = windowsHarness({
    run: () => {
      throw new Error('PowerShell CIM failure: Access denied');
    },
  });
  try {
    h.seedConfig();
    const status = await h.cli.run(['status']);
    assert.equal(status, WORKER_EXIT.serviceFailure);
    assert.match(h.out.join('\n'), /service: failed/);
    assert.match(h.out.join('\n'), /detail: the Scheduled Task could not be inspected/);
    assert.doesNotMatch(h.out.join('\n'), /service: not-installed/);
  } finally {
    h.cleanup();
  }
});

test('sprout worker status fails closed when process ownership evidence is unavailable (F1)', async () => {
  const h = windowsHarness({
    processProbe: () => ({ state: 'unknown' as const, process: undefined as unknown as WorkerProcessIdentity }),
  });
  try {
    h.seedConfig();
    writeRuntimeState(h.paths, {
      pid: process.pid,
      process: { pid: process.pid, startIdentity: 'test-process-start', ownerToken: h.cliCurrentToken },
      state: 'connected',
      epoch: 1,
      at: 1_000,
    });
    const status = await h.cli.run(['status']);
    assert.equal(status, WORKER_EXIT.failure);
    assert.match(h.out.join('\n'), /state: local-configuration-failure/);
    assert.match(h.out.join('\n'), /the Worker process ownership evidence is unavailable; start and reset are fenced/);
    assert.doesNotMatch(h.out.join('\n'), /state: connected/);
  } finally {
    h.cleanup();
  }
});

test('sprout worker status does not project reused PID as connected or reconnecting (F1)', async () => {
  const h = windowsHarness({
    processProbe: (pid) => ({
      state: 'alive' as const,
      process: { pid, startIdentity: 'foreign-start-identity', ownerToken: 'foreign-token'.repeat(3).slice(0, 43) },
    }),
  });
  try {
    h.seedConfig();
    writeRuntimeState(h.paths, {
      pid: process.pid,
      process: { pid: process.pid, startIdentity: 'test-process-start', ownerToken: h.cliCurrentToken },
      state: 'connected',
      epoch: 1,
      at: 1_000,
    });
    const status = await h.cli.run(['status']);
    assert.equal(status, WORKER_EXIT.ok);
    assert.match(h.out.join('\n'), /state: stopped/);
    assert.doesNotMatch(h.out.join('\n'), /state: connected/);
  } finally {
    h.cleanup();
  }
});

test('sprout worker status projects reconnecting runtime state truthfully on Windows', async () => {
  const h = windowsHarness({
    run: (_command, args) => {
      const script = args.join(' ');
      if (script.includes('Get-ScheduledTask')) {
        return JSON.stringify({
          TaskName: 'dev.sprout.worker.synthetic',
          State: 'Running',
          Enabled: true,
          LastTaskResult: 0,
        });
      }
      return '';
    },
  });
  try {
    h.seedConfig();
    writeRuntimeState(h.paths, {
      pid: process.pid,
      process: { pid: process.pid, startIdentity: 'test-process-start', ownerToken: h.cliCurrentToken },
      state: 'reconnecting',
      at: 1_000,
    });
    const status = await h.cli.run(['status']);
    assert.equal(status, WORKER_EXIT.ok);
    assert.match(h.out.join('\n'), /state: reconnecting/);
    assert.match(h.out.join('\n'), /service: installed and loaded/);
  } finally {
    h.cleanup();
  }
});

test('sprout worker reset uninstalls Scheduled Task on win32', async () => {
  const h = windowsHarness();
  try {
    const config = h.seedConfig();
    const label = workerServiceLabel(config.environmentInstanceId);

    const status = await h.cli.run(['reset', '--yes']);
    assert.equal(status, WORKER_EXIT.ok);
    assert.equal(existsSync(h.paths.configPath), false);
    assert.equal(existsSync(h.paths.identityPath), false);

    const unregCall = h.calls.find((c) => c.args.some((a) => a.includes('Unregister-ScheduledTask')));
    assert.ok(unregCall, 'reset must unregister the scheduled task');
    assert.match(unregCall.args.join(' '), new RegExp(`Unregister-ScheduledTask -TaskName '${label}'`));
  } finally {
    h.cleanup();
  }
});

test('sprout worker reset fails closed on win32 if task removal fails', async () => {
  const h = windowsHarness({
    run: (_command, args) => {
      if (args.some((a) => a.includes('Unregister-ScheduledTask'))) {
        throw new Error('Access denied');
      }
      return '';
    },
  });
  try {
    h.seedConfig();
    const status = await h.cli.run(['reset', '--yes']);
    assert.equal(status, WORKER_EXIT.serviceFailure);
    assert.match(h.err.join('\n'), /the Scheduled Task could not be removed; host-local state was left untouched/);
    assert.equal(existsSync(h.paths.configPath), true, 'config must be preserved when service cannot be uninstalled');
  } finally {
    h.cleanup();
  }
});

test('service registration is refused on non-darwin and non-win32 platforms with precise message', async () => {
  const h = windowsHarness({ platform: 'linux' });
  try {
    h.seedConfig();
    const installStatus = await h.cli.run(['install-service']);
    assert.equal(installStatus, WORKER_EXIT.serviceFailure);
    assert.match(h.err.join('\n'), /service registration is only supported on macOS \(LaunchAgent\) and Windows \(Scheduled Task\)/);

    h.err.length = 0;
    const uninstallStatus = await h.cli.run(['uninstall-service']);
    assert.equal(uninstallStatus, WORKER_EXIT.serviceFailure);
    assert.match(h.err.join('\n'), /service registration is only supported on macOS \(LaunchAgent\) and Windows \(Scheduled Task\)/);
  } finally {
    h.cleanup();
  }
});
