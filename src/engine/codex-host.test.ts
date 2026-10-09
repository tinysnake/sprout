import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { CodexProcess } from './codex.ts';
import {
  CODEX_HOST_VERSION,
  HostCodexEngineAdapter,
  createProductionHostCodexAdapter,
  hostCodexControlsDisabledForTest,
  hostCodexIsolationProfileForTest,
  hostCodexProcessEnvironment,
  type HostCodexLaunchInput,
  type HostCodexReadiness,
} from './codex-host.ts';

function ready(input: { readonly profileId: string; readonly model: string }): HostCodexReadiness {
  return {
    profileId: input.profileId, engine: 'codex', status: 'ready', installation: 'ready', authentication: 'ready',
    modelAvailability: 'available', adapterControls: 'ready', version: CODEX_HOST_VERSION,
    supportedEfforts: ['medium', 'high'], observedAt: 1_000,
  };
}

function fakeCodexProcess(): CodexProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buffer = '';
  stdin.on('data', chunk => {
    buffer += chunk.toString();
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const request = JSON.parse(line) as { readonly id?: number; readonly method?: string };
      if (request.id === undefined) { newline = buffer.indexOf('\n'); continue; }
      const result = request.method === 'thread/start'
        ? { thread: { id: 'host-codex-thread' } }
        : request.method === 'turn/start'
          ? { turn: { id: 'host-codex-turn' } }
          : {};
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
      if (request.method === 'turn/start') {
        setImmediate(() => {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: {
            turnId: 'host-codex-turn', tokenUsage: { last: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } },
          } })}\n`);
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: {
            item: { type: 'agentMessage', text: 'Host Codex reply.' },
          } })}\n`);
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: {
            turn: { id: 'host-codex-turn', status: 'completed', error: null },
          } })}\n`);
        });
      }
      newline = buffer.indexOf('\n');
    }
  });
  return {
    stdin, stdout, stderr,
    kill: () => { stdout.end(); stdin.end(); },
    onExit: () => undefined,
    onSpawnError: () => undefined,
  };
}

function fixture(root: string, overrides: Partial<ConstructorParameters<typeof HostCodexEngineAdapter>[0]> = {}) {
  const codexHome = join(root, 'codex-home');
  const runnerRoot = join(root, 'host-runner');
  mkdirSync(codexHome, { recursive: true });
  const launchInputs: HostCodexLaunchInput[] = [];
  const launches: { readonly args: readonly string[]; readonly env?: NodeJS.ProcessEnv }[] = [];
  const adapter = new HostCodexEngineAdapter({
    binaryPath: '/usr/bin/true', model: 'provider/model-authorized', runnerRoot, codexHome,
    probeProcess: async input => ready(input),
    spawnProcess: (input, args, env) => {
      launchInputs.push(input);
      launches.push({ args, ...(env !== undefined ? { env } : {}) });
      return fakeCodexProcess();
    },
    ...overrides,
  });
  return { adapter, codexHome, runnerRoot, launchInputs, launches };
}

test('Host Codex readiness refuses a profile when any local tool control remains enabled or unreported', () => {
  const features = ['shell_tool', 'apps', 'plugins', 'browser_use', 'browser_use_external', 'computer_use', 'code_mode', 'code_mode_host']
    .map(name => ({ name, enabled: false }));
  assert.equal(hostCodexControlsDisabledForTest({ data: features }), true);
  assert.equal(hostCodexControlsDisabledForTest({ data: features.map(feature => feature.name === 'shell_tool' ? { ...feature, enabled: true } : feature) }), false);
  assert.equal(hostCodexControlsDisabledForTest({ data: features.filter(feature => feature.name !== 'browser_use') }), false);
});

test('Host Codex requires the exact configured model and supported effort before starting its pinned app-server', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-host-codex-profile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = fixture(root);
  const readiness = await context.adapter.readiness(true);
  assert.equal(readiness.status, 'ready');
  assert.equal(readiness.version, CODEX_HOST_VERSION);
  assert.equal(context.adapter.supportsEffort('medium'), true);
  assert.equal(context.adapter.supportsEffort('xhigh'), false);

  await assert.rejects(context.adapter.startSession({ agentId: 'agent-a', workingDirectory: 'opaque',
    model: 'provider/model-other', effort: 'medium' }), /does not authorize/);
  await assert.rejects(context.adapter.startSession({ agentId: 'agent-a', workingDirectory: 'opaque',
    model: 'provider/model-authorized', effort: 'xhigh' }), /does not support/);
  assert.equal(context.launches.length, 0, 'unauthorized model and effort requests never launch Codex');

  const session = await context.adapter.startSession({ agentId: 'agent-a', workingDirectory: 'opaque',
    model: 'provider/model-authorized', effort: 'medium' });
  assert.equal(session.sessionId, 'host-codex-thread');
  assert.equal(context.launchInputs[0]?.codexHome, realpathSync(context.codexHome));
  const args = context.launches[0]?.args ?? [];
  assert.deepEqual(args.slice(0, 3), ['app-server', '--listen', 'stdio://']);
  for (const disabled of ['shell_tool', 'apps', 'plugins', 'browser_use', 'browser_use_external', 'computer_use', 'code_mode', 'code_mode_host']) {
    assert.ok(args.some((argument, index) => argument === '--disable' && args[index + 1] === disabled), `${disabled} is disabled`);
  }
  assert.ok(args.includes('mcp_servers={}'));
  assert.ok(args.includes('web_search="disabled"'));
  assert.equal(args.some(argument => argument.includes('danger-full-access')), false);
  const turn = session.run('Reply from the explicitly authorized Host profile.');
  const events = [];
  for await (const event of turn.events) events.push(event);
  const result = await turn.completion;
  assert.deepEqual(events, [{ type: 'message', text: 'Host Codex reply.', final: true }]);
  assert.equal(result.status, 'completed');
  if (result.status === 'completed') {
    assert.equal(result.text, 'Host Codex reply.');
    assert.equal(result.sourceVersion, `codex-cli ${CODEX_HOST_VERSION}`);
    assert.deepEqual(result.tokenUsage, { promptTokens: 12, completionTokens: 5, totalTokens: 17 });
    assert.deepEqual(result.detailedTokens, { inputTokens: 12, outputTokens: 5, totalTokens: 17 });
    assert.equal(result.billingBasis, 'unknown');
    assert.equal('costEstimate' in result, false, 'Codex usage does not invent billed cost');
  }
  await session.close();
});

test('Host Codex process receives only its runner and credential-home environment', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-host-codex-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = fixture(root);
  const agentRoot = join(context.runnerRoot, context.adapter.profileId, 'agent-env-test');
  mkdirSync(agentRoot, { recursive: true });
  const input: HostCodexLaunchInput = {
    profileId: context.adapter.profileId, binaryPath: '/usr/bin/true', model: context.adapter.authorizedModel,
    runnerRoot: context.runnerRoot, codexHome: realpathSync(context.codexHome), agentId: 'agent-env-test', agentRoot,
    clock: Date.now,
  };
  const environment = hostCodexProcessEnvironment(input);
  assert.equal(environment.HOME, agentRoot);
  assert.equal(environment.CODEX_HOME, input.codexHome);
  assert.equal(environment.TMPDIR, agentRoot);
  assert.ok(environment.PATH?.includes(realpathSync(process.execPath).replace(/\\/g, '/').split('/').slice(0, -1).join('/')));
  assert.equal(Object.hasOwn(environment, 'OPENAI_API_KEY'), false);
  assert.equal(Object.hasOwn(environment, 'GH_TOKEN'), false);
});

test('Host Codex isolation allows only its private runner and Codex home to write', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-host-codex-sandbox-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = fixture(root);
  const agentRoot = join(context.runnerRoot, context.adapter.profileId, 'agent-test');
  mkdirSync(join(agentRoot, 'bin'), { recursive: true });
  const profile = hostCodexIsolationProfileForTest({
    profileId: context.adapter.profileId, binaryPath: '/usr/bin/true', model: context.adapter.authorizedModel,
    runnerRoot: context.runnerRoot, codexHome: context.codexHome, agentId: 'agent-test', agentRoot, clock: Date.now,
  });
  assert.match(profile, /\(deny file-read\*\)/);
  assert.match(profile, /\(deny file-write\*\)/);
  assert.ok(profile.includes(`(allow file-write* (subpath "${realpathSync(agentRoot)}"))`));
  assert.ok(profile.includes(`(allow file-write* (subpath "${realpathSync(context.codexHome)}"))`));
  assert.doesNotMatch(profile, /\(deny network\*\)/, 'provider requests need network access');
});

test('Host Codex macOS isolation denies host sentinel access outside its private runner', { skip: process.platform !== 'darwin' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-host-codex-isolation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = fixture(root);
  const agentRoot = join(context.runnerRoot, context.adapter.profileId, 'agent-isolation-test');
  mkdirSync(agentRoot, { recursive: true });
  const sentinel = join(root, 'host-sentinel.txt');
  writeFileSync(sentinel, 'HOST_SENTINEL');
  const profile = hostCodexIsolationProfileForTest({
    profileId: context.adapter.profileId, binaryPath: '/usr/bin/true', model: context.adapter.authorizedModel,
    runnerRoot: context.runnerRoot, codexHome: context.codexHome, agentId: 'agent-isolation-test', agentRoot, clock: Date.now,
  });
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    let hostReadDenied = false;
    let hostWriteDenied = false;
    let authWriteDenied = false;
    try { fs.readFileSync(process.argv[1]); } catch (error) { hostReadDenied = ['EPERM', 'EACCES'].includes(error.code); }
    try { fs.writeFileSync(process.argv[1], 'CHANGED'); } catch (error) { hostWriteDenied = ['EPERM', 'EACCES'].includes(error.code); }
    try { fs.writeFileSync(path.join(process.argv[3], 'auth.json'), 'AUTH'); } catch (error) { authWriteDenied = ['EPERM', 'EACCES'].includes(error.code); }
    fs.writeFileSync(path.join(process.argv[2], 'runner-check.txt'), 'RUNNER_OK');
    fs.writeFileSync(path.join(process.argv[3], 'cache.json'), 'CACHE_OK');
    process.stdout.write(JSON.stringify({ hostReadDenied, hostWriteDenied, authWriteDenied, runnerWritable: true, codexCacheWritable: true }));
  `;
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', script, sentinel, agentRoot, context.codexHome], {
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  const stderr = result.stderr.replaceAll(root, '<tmp>').slice(0, 500);
  assert.equal(result.status, 0, `sandbox exited by signal ${result.signal ?? 'none'}: ${stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), {
    hostReadDenied: true, hostWriteDenied: true, authWriteDenied: true, runnerWritable: true, codexCacheWritable: true,
  });
  assert.equal(readFileSync(sentinel, 'utf8'), 'HOST_SENTINEL');
});

test('production Host Codex requires an explicit model setting', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-host-codex-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const codexHome = join(root, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  assert.equal(createProductionHostCodexAdapter({ SPROUT_HOST_CODEX_BIN: '/usr/bin/true' }, { runnerRoot: join(root, 'runner') }), undefined);
  const adapter = createProductionHostCodexAdapter({
    SPROUT_HOST_CODEX_BIN: '/usr/bin/true', SPROUT_HOST_CODEX_MODEL: 'provider/model-explicit', CODEX_HOME: codexHome,
  }, { runnerRoot: join(root, 'runner') });
  assert.equal(adapter?.authorizedModel, 'provider/model-explicit');
});
