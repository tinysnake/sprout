import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CLAUDE_CODE_AUTHORIZED_MODEL, HostClaudeEngineAdapter, type HostClaudeReadiness } from './engine/claude-host.ts';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import type { StartSessionRequest } from './engine/port.ts';
import { createRuntime, hostConfiguration, inMemoryStores, project, scriptedTurn } from './runtime-test-harness.ts';

async function freshRuntime(options: {
  readonly readinessStatus?: HostClaudeReadiness['status'];
  readonly supportedEfforts?: readonly string[];
  readonly requestedModel?: string;
  readonly requestedEffort?: string;
}) {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-host-claude-admission-'));
  const credential = 'synthetic-operator-credential';
  const settingsPath = join(directory, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({
    model: CLAUDE_CODE_AUTHORIZED_MODEL,
    effortLevel: 'high',
    env: { ANTHROPIC_BASE_URL: 'https://example.invalid', ANTHROPIC_AUTH_TOKEN: 'synthetic-auth-material' },
  }));
  const engine = new ScriptedEngineAdapter({ turns: [scriptedTurn('Host Claude run completed.')] });
  let readinessProbes = 0;
  let sessionStarts = 0;
  const profile = new HostClaudeEngineAdapter({
    binaryPath: '/usr/bin/true', settingsPath, runnerRoot: join(directory, 'runner'),
    probeProcess: async input => {
      readinessProbes += 1;
      return {
        profileId: input.profileId, engine: 'claude', status: options.readinessStatus ?? 'ready',
        installation: 'ready', authentication: options.readinessStatus === 'unknown' ? 'unknown' : 'ready',
        modelAvailability: options.readinessStatus === 'unknown' ? 'unknown' : 'available',
        adapterControls: options.readinessStatus === 'unknown' ? 'unknown' : 'ready',
        version: '2.1.294', resolvedModel: CLAUDE_CODE_AUTHORIZED_MODEL,
        ...(options.readinessStatus !== 'unknown' ? { supportedEfforts: options.supportedEfforts ?? ['high'] } : {}),
        observedAt: 1,
      };
    },
  });
  Object.defineProperty(profile, 'startSession', {
    value: async (_request: StartSessionRequest) => {
      sessionStarts += 1;
      return engine.startSession(_request);
    },
  });

  const requestedModel = options.requestedModel ?? CLAUDE_CODE_AUTHORIZED_MODEL;
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      executionMode: 'host-run', environmentSource: 'enrollment', databasePath: join(directory, 'state.db'),
      operatorCredential: credential,
      runtimeConfiguration: {
        agents: [{
          id: 'claude-scout', name: 'Claude Scout', engine: 'claude', capability: 'agent-run',
          model: requestedModel, effort: options.requestedEffort ?? 'high',
          workOptions: [{ id: 'authorized-claude-option', engine: 'claude', workModel: requestedModel, effort: options.requestedEffort ?? 'high' }],
        }],
        project: { ...project(), memberships: [{ agentId: 'claude-scout', responsibilities: [], collaborationInstructions: '' }] },
      },
    }),
    projectRoot: directory, stores: inMemoryStores(), hostClaude: profile,
  });
  const { port } = await runtime.api.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/auth/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential }),
  });
  assert.equal(login.status, 201);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
  const { csrfToken } = await login.json() as { readonly csrfToken: string };
  return { base, cookie, csrfToken, directory, profile, readinessProbes: () => readinessProbes, sessionStarts: () => sessionStarts, runtime };
}

function cleanup(context: Awaited<ReturnType<typeof freshRuntime>>, t: { after(callback: () => Promise<void>): void }): void {
  t.after(async () => { await context.runtime.close(); rmSync(context.directory, { recursive: true, force: true }); });
}

test('fresh Runtime admits Claude only after readiness populates its configured effort, with no Environment lease', async t => {
  const context = await freshRuntime({ supportedEfforts: ['high'] });
  cleanup(context, t);
  assert.equal(context.profile.supportsEffort('high'), false, 'dynamic capability is initially unknown');
  const response = await fetch(`${context.base}/api/runs`, {
    method: 'POST',
    headers: { cookie: context.cookie, 'x-sprout-csrf': context.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: 'claude-scout', projectId: 'composition-project', prompt: 'Reply without remote work.' }),
  });
  assert.equal(response.status, 202);
  const { id } = await response.json() as { readonly id: string };
  const run = await context.runtime.orchestrator.waitFor(id);
  assert.equal(run.status, 'completed', run.failure ?? 'fresh Host Claude run was refused');
  assert.equal(run.workOption?.workModel, CLAUDE_CODE_AUTHORIZED_MODEL);
  assert.equal(context.readinessProbes(), 1);
  assert.equal(context.sessionStarts(), 1);
  assert.equal(context.runtime.pool.leases().length, 0, 'ordinary conversation remains detached from Environment resources');
});

test('fresh Host Claude admission refuses an unready profile before session start', async t => {
  const context = await freshRuntime({ readinessStatus: 'unknown' });
  cleanup(context, t);
  const submitted = await context.runtime.orchestrator.submit({ agentId: 'claude-scout', projectId: 'composition-project', prompt: 'Try an unready profile.' });
  const run = await context.runtime.orchestrator.waitFor(submitted.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.failureClass, 'admission');
  assert.equal(context.readinessProbes(), 1);
  assert.equal(context.sessionStarts(), 0);
});

test('fresh Host Claude admission refuses an unsupported effort after readiness', async t => {
  const context = await freshRuntime({ supportedEfforts: ['high'], requestedEffort: 'medium' });
  cleanup(context, t);
  const submitted = await context.runtime.orchestrator.submit({ agentId: 'claude-scout', projectId: 'composition-project', prompt: 'Try an unsupported effort.' });
  const run = await context.runtime.orchestrator.waitFor(submitted.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.failureClass, 'admission');
  assert.equal(context.readinessProbes(), 1, 'readiness precedes the dynamic effort check');
  assert.equal(context.sessionStarts(), 0);
});

test('fresh Host Claude admission refuses a model that differs from the configured authorization', async t => {
  const context = await freshRuntime({ requestedModel: 'provider/model-not-authorized' });
  cleanup(context, t);
  const submitted = await context.runtime.orchestrator.submit({ agentId: 'claude-scout', projectId: 'composition-project', prompt: 'Try an unauthorized model.' });
  const run = await context.runtime.orchestrator.waitFor(submitted.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.failureClass, 'admission');
  assert.equal(context.readinessProbes(), 0, 'an unauthorized model is refused without probing or substituting');
  assert.equal(context.sessionStarts(), 0);
});
