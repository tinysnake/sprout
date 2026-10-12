/** DISPOSABLE #228 feasibility gate. No model turn, credentials, or production imports. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeOriginFixture, launchOrigin } from './prototype-origin-fixture.mjs';

const OAR = '0.35.0';
const CODEX = '0.159.3';
const ARCHIVE_SHA = 'a6c7329f743cdf0ffea6e619aa3b708e2b9180087fc3ad3dbaba9b509fc58cc8';
const FIXTURE_SHA = '9d050f9f0943a0b3f4244f25ca0fe1cdacd4f49a5ff8be9b2c2d72de9814ab23';
const sha = value => createHash('sha256').update(value).digest('hex');
const deadline = setTimeout(() => process.exit(2), 45_000);
let fixture;
let origin;
let stage = 'pins';
try {
  // Authority is declared before any possible session open. No arbitrary endpoint,
  // account, model, or local executor may be substituted for missing controls.
  const authority = Object.freeze({
    work: 'shared-isolated-fixture', hostWork: false, modelSelectedEndpoint: false,
    modelLeaseClaims: false, admission: 'refuse-unless-binding-and-tool-controls-exist',
  });
  assert.equal(process.platform, 'darwin');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24);
  assert.ok(process.env.OAR_PROBE_ROOT && process.env.OAR_PROBE_ARCHIVE);
  const root = realpathSync(process.env.OAR_PROBE_ROOT);
  assert.equal(sha(readFileSync(process.env.OAR_PROBE_ARCHIVE)), ARCHIVE_SHA);
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, OAR);
  const fixtureFile = join(dirname(fileURLToPath(import.meta.url)), 'prototype-origin-fixture.mjs');
  assert.equal(sha(readFileSync(fixtureFile)), FIXTURE_SHA);
  const modules = [
    'dist/runtimes/codex/open.js', 'dist/runtimes/codex/session.js',
    'dist/runtimes/codex/app-server-client.js', 'dist/contracts/session-options.d.ts',
  ];
  const moduleHashes = {};
  for (const module of modules) {
    const archived = spawnSync('/usr/bin/tar', ['-xOf', process.env.OAR_PROBE_ARCHIVE, `package/${module}`], { timeout: 10_000, maxBuffer: 1_000_000 });
    assert.equal(archived.status, 0);
    assert.deepEqual(readFileSync(join(root, module)), archived.stdout);
    moduleHashes[module] = sha(archived.stdout);
  }
  const codexBinary = process.env.CODEX_PROBE_BINARY || 'codex';
  const version = spawnSync(codexBinary, ['--version'], { timeout: 10_000, encoding: 'utf8' });
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), `codex-cli ${CODEX}`);
  const executor = spawnSync(codexBinary, ['exec-server', '--help'], { timeout: 10_000, encoding: 'utf8' });
  assert.equal(executor.status, 0);
  assert.ok(executor.stdout.includes('standalone exec-server'));

  fixture = makeOriginFixture();
  // Execute the actual pinned OAR request builder, not a replacement protocol
  // parser or a fake app-server. Its output is scripted evidence, not wire proof.
  stage = 'oar-request-builder';
  const { codexThreadOpen } = await import(pathToFileURL(join(root, modules[0])).href);
  const open = codexThreadOpen({ cwd: fixture.host });
  const resume = codexThreadOpen({ cwd: fixture.host, resume: 'synthetic-native-key' });
  const attached = codexThreadOpen({ cwd: fixture.host, mcpServers: [{ name: 'fixture', command: 'synthetic-never-launched' }] });
  const resumedAttachment = codexThreadOpen({ cwd: fixture.host, resume: 'synthetic-native-key', mcpServers: [{ name: 'fixture', command: 'synthetic-never-launched' }] });
  assert.equal(open.method, 'thread/start');
  assert.equal(resume.method, 'thread/resume');
  assert.equal(open.params.approvalPolicy, 'never');
  assert.equal(Object.hasOwn(open.params, 'environments'), false);
  assert.equal(Object.hasOwn(resume.params, 'environments'), false);
  assert.equal(Object.hasOwn(open.params, 'dynamicTools'), false);
  assert.equal(attached.params.config.mcp_servers.fixture.enabled, true);
  assert.equal(resumedAttachment.params.config.mcp_servers.fixture.enabled, true);
  const options = readFileSync(join(root, modules[3]), 'utf8');
  const optionNames = [...options.split('export interface SessionOptions {')[1].matchAll(/^    readonly (\w+)\??:/gm)].map(match => match[1]);
  assert.deepEqual(optionNames, ['cwd', 'model', 'effort', 'resume', 'env', 'systemPrompt', 'appendSystemPrompt', 'mcpServers']);

  // Reuse the exact #227 fixture. These deterministic operations only check the
  // fixture prerequisites; they are never relabelled as Codex execution.
  stage = 'shared-origin';
  origin = launchOrigin(fixture, [dirname(dirname(realpathSync(process.execPath))), '/opt/homebrew']);
  origin.child.stdin.on('error', () => {});
  const read = await origin.call('read', { path: 'origin.txt' });
  const write = await origin.call('write', { path: 'effect.txt', content: 'OAR_CODEX_SCRIPTED_EFFECT' });
  const sentinelPath = join(fixture.outside, 'sentinel.txt');
  const deniedRead = await origin.call('read', { path: sentinelPath });
  const deniedWrite = await origin.call('write', { path: sentinelPath, content: 'FORBIDDEN' });
  const os = await origin.call('os-negative', { path: sentinelPath });
  const command = await origin.call('command', { command: 'synthetic-never-executed' });
  assert.equal(read.value, 'REMOTE_ORIGIN');
  assert.equal(write.ok, true);
  assert.equal(deniedRead.ok, false);
  assert.equal(deniedWrite.ok, false);
  assert.equal(os.readDenied, true);
  assert.equal(os.writeDenied, true);
  assert.equal(command.reason, 'unsupported-operation');
  await origin.stop();
  let stoppedCallFailed = false;
  try { await origin.call('read', { path: 'origin.txt' }); } catch { stoppedCallFailed = true; }
  assert.equal(stoppedCallFailed, true);
  const effects = {
    hostOriginUnchanged: readFileSync(join(fixture.host, 'origin.txt'), 'utf8') === 'HOST_ORIGIN',
    hostEffectUnchanged: readFileSync(join(fixture.host, 'effect.txt'), 'utf8') === 'HOST_UNCHANGED',
    hostSentinelUnchanged: readFileSync(sentinelPath, 'utf8') === 'HOST_SENTINEL_UNCHANGED',
    workScriptedEffect: readFileSync(join(fixture.remote, 'effect.txt'), 'utf8') === 'OAR_CODEX_SCRIPTED_EFFECT',
  };
  assert.ok(Object.values(effects).every(Boolean));
  console.log(JSON.stringify({
    versions: { oar: OAR, oarSource: '8adde16fe2d12ae54af7d4dff86c3f224380a5c7', codex: CODEX, executor: `${CODEX} (same binary; help only)`, node: process.versions.node, platform: process.platform },
    pins: { archiveSha256: ARCHIVE_SHA, fixtureSha256: FIXTURE_SHA, moduleHashes },
    authority,
    routeOrder: ['native-executor', 'restricted-external-tools'],
    scripted: {
      actualOarRequestBuilder: true, optionNames,
      openSelectsExecutor: false, resumeSelectsExecutor: false,
      dynamicToolsRegistered: false, mcpConfiguredOnOpenAndResume: true,
      originRead: true, originWrite: true, pathReadDenied: true, pathWriteDenied: true,
      originOsReadDenied: true, originOsWriteDenied: true,
      fixtureCommandUnavailable: true, stoppedOriginCallFailed: true, effects,
    },
    protocolOnly: { sessionOpened: false, executorStarted: false },
    modelIssued: { attempted: false, toolCalls: 0 },
    admission: { refusedBeforeSession: true, reason: 'missing-typed-executor-binding-and-restricted-tool-dispatch', authInspected: false },
  }, null, 2));
} catch {
  // Do not leak failed assertion values, native output, paths, or environment.
  console.error(`prototype-prerequisite-or-assertion-failed:${stage}`);
  process.exitCode = 1;
} finally {
  if (origin) await origin.stop();
  if (fixture) fixture.cleanup();
  clearTimeout(deadline);
}
