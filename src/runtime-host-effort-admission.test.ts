import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { HostCodexEngineAdapter, type HostCodexReadiness } from './engine/codex-host.ts';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import type { StartSessionRequest } from './engine/port.ts';
import {
  createRuntime,
  hostConfiguration,
  inMemoryStores,
  project,
  scriptedTurn,
} from './runtime-test-harness.ts';

const authorizedModel = 'provider/model-authorized';

async function freshRuntime(options: {
  readonly probeStatus?: HostCodexReadiness['status'];
  readonly supportedEfforts?: readonly string[];
  readonly requestedModel?: string;
  readonly requestedEffort?: string;
}) {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-host-codex-effort-admission-'));
  const credential = 'fresh-runtime-test-credential';
  const engine = new ScriptedEngineAdapter({ turns: [scriptedTurn('Host Codex run completed.')] });
  let readinessProbes = 0;
  let sessionStarts = 0;
  const profile = new HostCodexEngineAdapter({
    binaryPath: '/usr/bin/true',
    model: authorizedModel,
    runnerRoot: join(directory, 'runner'),
    codexHome: join(directory, 'codex-home'),
    probeProcess: async (input) => {
      readinessProbes += 1;
      return {
        profileId: input.profileId,
        engine: 'codex',
        status: options.probeStatus ?? 'ready',
        installation: 'ready',
        authentication: options.probeStatus === 'unknown' ? 'unknown' : 'ready',
        modelAvailability: options.probeStatus === 'unknown' ? 'unknown' : 'available',
        adapterControls: options.probeStatus === 'unknown' ? 'unknown' : 'ready',
        version: '0.159.3',
        ...(options.probeStatus !== 'unknown'
          ? { supportedEfforts: options.supportedEfforts ?? ['medium'] }
          : {}),
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

  const requestedModel = options.requestedModel ?? authorizedModel;
  const runtime = await createRuntime({
    configuration: hostConfiguration({
      executionMode: 'host-run',
      environmentSource: 'enrollment',
      databasePath: join(directory, 'state.db'),
      operatorCredential: credential,
      runtimeConfiguration: {
        agents: [{
          id: 'codex-scout',
          name: 'Codex Scout',
          engine: 'codex',
          capability: 'agent-run',
          model: requestedModel,
          effort: options.requestedEffort ?? 'medium',
          workOptions: [{
            id: 'authorized-codex-option',
            engine: 'codex',
            workModel: requestedModel,
            effort: options.requestedEffort ?? 'medium',
          }],
        }],
        project: {
          ...project(),
          memberships: [{ agentId: 'codex-scout', responsibilities: [], collaborationInstructions: '' }],
        },
      },
    }),
    projectRoot: directory,
    stores: inMemoryStores(),
    hostCodex: profile,
  });
  const { port } = await runtime.api.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential }),
  });
  assert.equal(login.status, 201);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
  const { csrfToken } = await login.json() as { readonly csrfToken: string };

  return {
    base,
    cookie,
    csrfToken,
    directory,
    profile,
    readinessProbes: () => readinessProbes,
    sessionStarts: () => sessionStarts,
    runtime,
  };
}

test('fresh Runtime admits the exact authorized Host Codex option without a compatibility read', async (t) => {
  const context = await freshRuntime({ supportedEfforts: ['medium'] });
  t.after(async () => {
    await context.runtime.close();
    rmSync(context.directory, { recursive: true, force: true });
  });

  assert.equal(context.readinessProbes(), 0);
  assert.equal(context.profile.supportsEffort('medium'), false, 'the real adapter starts with no inferred effort support');
  const response = await fetch(`${context.base}/api/runs`, {
    method: 'POST',
    headers: {
      cookie: context.cookie,
      'x-sprout-csrf': context.csrfToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      agentId: 'codex-scout',
      projectId: 'composition-project',
      prompt: 'Run with the explicitly authorized Codex option.',
    }),
  });
  assert.equal(response.status, 202);
  const { id } = await response.json() as { readonly id: string };
  const run = await context.runtime.orchestrator.waitFor(id);

  assert.equal(run.status, 'completed', run.failure ?? 'fresh Host Codex run was refused');
  assert.equal(run.workOption?.workModel, authorizedModel);
  assert.equal(context.readinessProbes(), 1, 'admission establishes readiness before checking dynamic efforts');
  assert.equal(context.sessionStarts(), 1);
});

test('fresh Host Codex admission still refuses an unready profile and does not start a session', async (t) => {
  const context = await freshRuntime({ probeStatus: 'unknown' });
  t.after(async () => {
    await context.runtime.close();
    rmSync(context.directory, { recursive: true, force: true });
  });

  const submitted = await context.runtime.orchestrator.submit({
    agentId: 'codex-scout', projectId: 'composition-project', prompt: 'Try an unready Codex profile.',
  });
  const run = await context.runtime.orchestrator.waitFor(submitted.id);

  assert.equal(run.status, 'failed');
  assert.equal(run.failureClass, 'admission');
  assert.equal(context.readinessProbes(), 1);
  assert.equal(context.sessionStarts(), 0);
});

test('fresh Host Codex admission still refuses an unsupported effort after readiness', async (t) => {
  const context = await freshRuntime({ supportedEfforts: ['high'], requestedEffort: 'medium' });
  t.after(async () => {
    await context.runtime.close();
    rmSync(context.directory, { recursive: true, force: true });
  });

  const submitted = await context.runtime.orchestrator.submit({
    agentId: 'codex-scout', projectId: 'composition-project', prompt: 'Try an unsupported effort.',
  });
  const run = await context.runtime.orchestrator.waitFor(submitted.id);

  assert.equal(run.status, 'failed');
  assert.equal(run.failureClass, 'admission');
  assert.equal(context.readinessProbes(), 1);
  assert.equal(context.sessionStarts(), 0);
});

test('fresh Host Codex admission refuses an option whose model is not exactly authorized', async (t) => {
  const context = await freshRuntime({ requestedModel: 'provider/model-not-authorized' });
  t.after(async () => {
    await context.runtime.close();
    rmSync(context.directory, { recursive: true, force: true });
  });

  const submitted = await context.runtime.orchestrator.submit({
    agentId: 'codex-scout', projectId: 'composition-project', prompt: 'Try an unauthorized model.',
  });
  const run = await context.runtime.orchestrator.waitFor(submitted.id);

  assert.equal(run.status, 'failed');
  assert.equal(run.failureClass, 'admission');
  assert.equal(context.readinessProbes(), 0, 'an unauthorized model never triggers readiness admission');
  assert.equal(context.sessionStarts(), 0);
});
