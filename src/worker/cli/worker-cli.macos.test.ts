import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderLaunchAgent } from './launch-agent.ts';
import { workerServiceLabel } from './host-state.ts';

/**
 * macOS process-level integration for the `sprout worker` executable and the
 * LaunchAgent rendering (#117).
 *
 * These run only on Darwin: they execute the packaged `bin/sprout` entry point
 * as a real process (so its exit statuses and executable permissions are real,
 * not in-process), and they validate the rendered plist with Apple's own
 * `plutil` so the LaunchAgent is proven to be a well-formed property list rather
 * than merely well-shaped text.
 *
 * They deliberately do not bootstrap a job into the caller's `gui/<uid>` domain:
 * loading a persistent login agent from a test would mutate the operator's
 * session. The `launchctl` verb sequence is asserted at the unit seam instead.
 */

const onMac = process.platform === 'darwin';
const repositoryRoot = new URL('../../..', import.meta.url).pathname;
const sproutExecutable = join(repositoryRoot, 'bin', 'sprout');

test('the packaged sprout executable exists, is executable, and reports a usage exit', { skip: !onMac }, () => {
  const result = spawnSync(sproutExecutable, ['worker', 'help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sprout worker <command>/);
  assert.match(result.stdout, /enroll/);
  assert.match(result.stdout, /install-service/);
});

test('sprout worker status on an unconfigured host exits not-enrolled', { skip: !onMac }, () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-exec-'));
  try {
    const result = spawnSync(sproutExecutable, ['worker', 'status'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: root,
        SPROUT_WORKER_HOME: join(root, 'state'),
        SPROUT_LAUNCH_AGENTS_DIR: join(root, 'LaunchAgents'),
      },
    });
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /state: not-enrolled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sprout worker enroll refuses to take the secret from argv', { skip: !onMac }, () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-exec-argv-'));
  try {
    const result = spawnSync(
      sproutExecutable,
      ['worker', 'enroll', '127.0.0.1:5174', 'enroll-e3', 'claim-secret-on-argv'],
      { encoding: 'utf8', env: { ...process.env, HOME: root, SPROUT_WORKER_HOME: join(root, 'state') } },
    );
    assert.equal(result.status, 2, 'a third argument is a usage error');
    assert.match(result.stderr, /one-use claim secret is read from stdin/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the rendered LaunchAgent is a valid property list according to plutil', { skip: !onMac }, () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-plist-'));
  try {
    const plistPath = join(root, `${workerServiceLabel('env-synthetic')}.plist`);
    writeFileSync(
      plistPath,
      renderLaunchAgent({
        label: workerServiceLabel('env-synthetic'),
        executablePath: sproutExecutable,
        arguments: ['worker', 'start'],
        logPath: join(root, 'worker.log'),
        environment: { HOME: root, PATH: '/usr/bin:/bin' },
      }),
      'utf8',
    );
    // `plutil -lint` is Apple's own parser; a clean run proves the plist is
    // structurally valid macOS property-list syntax.
    const root_ = execFileSync('/usr/bin/plutil', ['-lint', plistPath], { encoding: 'utf8' });
    assert.match(root_, /OK/);
    // `plutil -convert json -o -` proves the exact typed shape launchd reads.
    const json = JSON.parse(
      execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' }),
    ) as Record<string, unknown>;
    assert.equal(json['RunAtLoad'], true);
    assert.deepEqual(json['KeepAlive'], { SuccessfulExit: false });
    assert.equal(json['ThrottleInterval'], 10);
    assert.deepEqual(json['ProgramArguments'], [sproutExecutable, 'worker', 'start']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
