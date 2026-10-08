import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { macOsTimezoneFiles } from './host-runtime-files.ts';
import { HostPiEngineAdapter, hostEngineProfileId, isolationProfile, type HostPiLaunchInput, type HostPiReadiness } from './pi-host.ts';
import type { RemoteWorkspaceTools } from './port.ts';
import { sanitizeStreamError, sanitizedProbeErrorFields, sanitizedPromptErrorFields } from './pi-error-facts.ts';

function readiness(profileId: string, status: HostPiReadiness['status'] = 'ready'): HostPiReadiness {
  return {
    profileId,
    engine: 'pi',
    status,
    installation: status === 'ready' ? 'ready' : 'unknown',
    authentication: status === 'ready' ? 'ready' : 'unknown',
    modelAvailability: status === 'ready' ? 'available' : 'unknown',
    adapterControls: status === 'ready' ? 'ready' : 'unknown',
    ...(status === 'ready' ? { version: '1.0.4' } : {}),
    observedAt: 1_000,
  };
}

function fakeChild(input: HostPiLaunchInput): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr, pid: undefined, exitCode: null, signalCode: null });
  stdin.on('data', chunk => {
    const line = chunk.toString().trim();
    let command: { op?: string } | undefined;
    try { command = JSON.parse(line) as { op?: string }; } catch { return; }
    if (command?.op !== 'prompt') return;
    queueMicrotask(() => {
      stdout.write(`${JSON.stringify({ kind: 'pi-event', event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Pi says hello.' } } })}\n`);
      stdout.write(`${JSON.stringify({ kind: 'pi-event', event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Pi says hello.' }], usage: { input: 12, output: 5, totalTokens: 17 }, stopReason: 'stop' } } })}\n`);
      stdout.write(`${JSON.stringify({ kind: 'pi-event', event: { type: 'agent_settled' } })}\n`);
    });
  });
  queueMicrotask(() => stdout.write(`${JSON.stringify({ kind: 'ready', sessionId: input.sessionId })}\n`));
  return child;
}

test('Host Pi streams the exact selected model response and versioned provider usage', async () => {
  let launches = 0;
  let observedInput: HostPiLaunchInput | undefined;
  const adapter = new HostPiEngineAdapter({
    profileId: 'profile-local-a',
    provider: 'provider-a',
    model: 'provider-a/model-a',
    probeProcess: async input => readiness(input.profileId),
    spawnProcess: input => {
      launches += 1;
      observedInput = input;
      return fakeChild(input);
    },
  });
  const session = await adapter.startSession({
    agentId: 'agent-a', runId: 'run-a', workingDirectory: 'host-profile:profile-local-a',
    model: 'provider-a/model-a', effort: 'medium', instructions: 'Project contract',
  });
  const turn = session.run('Hello Pi');
  const events = [];
  for await (const event of turn.events) events.push(event);
  const result = await turn.completion;

  assert.equal(launches, 1);
  assert.equal(observedInput?.provider, 'provider-a');
  assert.equal(observedInput?.model, 'provider-a/model-a');
  assert.deepEqual(events, [{ type: 'message', text: 'Pi says hello.', final: false }]);
  assert.equal(result.status, 'completed');
  if (result.status === 'completed') {
    assert.equal(result.text, 'Pi says hello.');
    assert.equal(result.sourceVersion, '1.0.4');
    assert.deepEqual(result.tokenUsage, { promptTokens: 12, completionTokens: 5, totalTokens: 17 });
  }
  await session.close();
});

test('Host Pi records sanitized turn facts and forwards them to the workspace observer', async () => {
  const observedFacts: Record<string, unknown>[] = [];
  const child = (input: HostPiLaunchInput): ChildProcess => {
    const fake = fakeChild(input);
    const stdout = fake.stdout as PassThrough;
    const stdin = fake.stdin as PassThrough;
    // Replace the default prompt output: boundary facts precede the terminal
    // settle so the test observes them deterministically once the turn ends.
    // (fakeChild already emits the ready line.)
    stdin.removeAllListeners('data');
    stdin.on('data', chunk => {
      const raw = chunk.toString().trim();
      let command: { op?: string } | undefined;
      try { command = JSON.parse(raw) as { op?: string }; } catch { return; }
      if (command?.op !== 'prompt') return;
      queueMicrotask(() => {
        stdout.write(`${JSON.stringify({ kind: 'turn-facts', facts: { promptResolved: true, fetchAttempts: 1, streamCalls: 1 } })}\n`);
        stdout.write(`${JSON.stringify({ kind: 'provider-request-facts', facts: { toolCount: 2, toolNames: ['remote_read', 'remote_search'], toolChoice: 'auto', remoteReadPresent: true } })}\n`);
        stdout.write(`${JSON.stringify({ kind: 'pi-event', event: { type: 'agent_settled' } })}\n`);
      });
    });
    return fake;
  };
  const adapter = new HostPiEngineAdapter({
    profileId: 'profile-local-facts',
    provider: 'provider-a',
    model: 'provider-a/model-a',
    probeProcess: async input => readiness(input.profileId),
    spawnProcess: child,
  });
  const remoteWorkspace: RemoteWorkspaceTools & {
    observeProviderRequestFacts(facts: Record<string, unknown>): void;
  } = {
    binding: { projectId: 'project-a', environmentInstanceId: 'env-a', bindingId: 'binding-a', generation: 1, connectionEpoch: 1, workspaceId: 'workspace-a' },
    read: async () => { throw new Error('not exercised'); },
    search: async () => { throw new Error('not exercised'); },
    inspect: async () => ({ status: 'failed' }),
    cancel: async () => ({ accepted: false, status: 'failed' }),
    observeProviderRequestFacts(facts: Record<string, unknown>) { observedFacts.push(facts); },
  };
  const session = await adapter.startSession({
    agentId: 'agent-a', runId: 'run-facts', workingDirectory: 'opaque',
    model: 'provider-a/model-a', effort: 'medium',
    remoteWorkspace,
  });
  const turn = session.run('Hello Pi');
  for await (const event of turn.events) void event;
  const result = await turn.completion;
  assert.equal(result.status, 'completed');
  const turnFacts = (session as unknown as { turnFacts(): readonly Record<string, unknown>[] }).turnFacts();
  assert.deepEqual(turnFacts, [
    { promptResolved: true, fetchAttempts: 1, streamCalls: 1 },
    { toolCount: 2, toolNames: ['remote_read', 'remote_search'], toolChoice: 'auto', remoteReadPresent: true },
  ]);
  assert.deepEqual(observedFacts, turnFacts);
  await session.close();
});

test('Host Pi refuses a different model, unsupported effort, or unready profile before launch', async () => {
  let launches = 0;
  const adapter = new HostPiEngineAdapter({
    profileId: 'profile-local-b', provider: 'provider-a', model: 'provider-a/model-a',
    probeProcess: async input => readiness(input.profileId, 'unavailable'),
    spawnProcess: input => { launches += 1; return fakeChild(input); },
  });
  const base = { agentId: 'agent-a', runId: 'run-a', workingDirectory: 'opaque' };
  await assert.rejects(adapter.startSession({ ...base, model: 'provider-a/model-b', effort: 'medium' }), /does not authorize/);
  await assert.rejects(adapter.startSession({ ...base, model: 'provider-a/model-a', effort: 'turbo' }), /does not support/);
  await assert.rejects(adapter.startSession({ ...base, model: 'provider-a/model-a', effort: 'medium' }), /readiness is not established/);
  assert.equal(launches, 0);
});

test('the Host Pi sandbox profile compiles with default-deny file rules', { skip: process.platform !== 'darwin' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-host-sandbox-test-'));
  try {
    const packageRoot = join(root, 'sdk', 'node_modules', '@earendil-works', 'pi-coding-agent');
    const providerRoot = join(root, 'provider');
    const agentRoot = join(root, 'runner');
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(providerRoot, { recursive: true });
    mkdirSync(agentRoot, { recursive: true });
    for (const file of ['provider.ts', 'catalog.ts', 'constants.ts', 'gateway.ts', 'package.json']) {
      writeFileSync(join(providerRoot, file), 'synthetic');
    }
    const profile = isolationProfile({
      profileId: 'profile-test', provider: 'provider-test', model: 'provider-test/model-test',
      packageRoot, providerRoot, authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json'),
      modelsStorePath: join(root, 'models-store.json'), runnerRoot: root, clock: Date.now, agentRoot, network: false,
    });
    assert.equal(profile.includes('(allow default)'), true);
    assert.ok(profile.includes('(allow file-read* (literal "/")'));
    assert.match(profile, /\(deny file-read\*\)/);
    assert.match(profile, /\(deny file-write\*\)/);
    assert.match(profile, /\(deny network\*\)/);
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/true'], { timeout: 10_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0);
    const timezoneFiles = macOsTimezoneFiles();
    const timezoneFile = timezoneFiles[0];
    assert.ok(timezoneFile, 'installed OS ICU data is present');
    const outside = join(root, 'host-sentinel.txt');
    writeFileSync(outside, 'HOST_SENTINEL');
    const check = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', `
      const fs = require('node:fs');
      const data = fs.readFileSync(process.argv[1]);
      let runtimeWriteDenied = false, hostReadDenied = false;
      try { const fd = fs.openSync(process.argv[1], 'r+'); fs.closeSync(fd); }
      catch (error) { runtimeWriteDenied = ['EPERM', 'EACCES'].includes(error.code); }
      try { fs.readFileSync(process.argv[2]); }
      catch (error) { hostReadDenied = ['EPERM', 'EACCES'].includes(error.code); }
      console.log(JSON.stringify({ readable: data.length > 0, runtimeWriteDenied, hostReadDenied }));
    `, timezoneFile, outside], { timeout: 10_000, encoding: 'utf8' });
    assert.equal(check.status, 0, 'runtime data can be read under the real profile');
    assert.deepEqual(JSON.parse(check.stdout), { readable: true, runtimeWriteDenied: true, hostReadDenied: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the runner pins the provider source hashes reviewed by the isolation prototype', () => {
  const artifact = readFileSync(new URL('../../docs/research/pi-host-isolation-prototype.md', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('./pi-host-runner.mjs', import.meta.url), 'utf8');
  const hashes = [...artifact.matchAll(/^- `pi-magpie\/([^`]+)`: `([0-9a-f]{64})`$/gm)];
  assert.equal(hashes.length, 4);
  for (const [, file, hash] of hashes) assert.ok(runner.includes(`'${file}': '${hash}'`), `${file} stays pinned to its reviewed hash`);
});

test('Engine host profile identifiers are stable opaque local ids with private file permissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-host-profile-test-'));
  try {
    const first = hostEngineProfileId(root);
    const second = hostEngineProfileId(root);
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f-]{36}$/i);
    assert.equal(statSync(join(root, 'host-pi-profile-id')).mode & 0o077, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi probe catches and Host Pi turn facts omit unclassified thrown error codes', () => {
  const sensitiveCodes = [
    'https://api.example.invalid/v1?token=demo',
    '/home/example/.config/provider/key',
    'worker-id-7f5d3a',
    'sk_test_0123456789abcdef',
  ];
  for (const code of sensitiveCodes) {
    const error = Object.assign(new Error('synthetic provider failure'), { code });
    const remoteProbeStdout = JSON.stringify({
      outcome: 'blocked', reason: 'bounded-probe-failed', stage: 'model-turn',
      ...sanitizedProbeErrorFields(error),
    });
    const hostTurnProbeStdout = JSON.stringify({
      outcome: 'blocked', reason: 'bounded-baseline-failed',
      ...sanitizedProbeErrorFields(error),
    });
    const turnFacts = [{ ...sanitizedPromptErrorFields(error), streamRejections: [sanitizeStreamError(error)] }];
    for (const output of [remoteProbeStdout, hostTurnProbeStdout, JSON.stringify(turnFacts)]) {
      assert.equal(output.includes(code), false, `unclassified error code stays out of diagnostics: ${code}`);
    }
  }
  assert.deepEqual(sanitizedProbeErrorFields(Object.assign(new Error(), { code: 'ENOENT' })), {
    errorType: 'Error', errorCode: 'missing',
  });
});

void (undefined as ChildProcess | undefined);
