import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineAdapter, EngineSession, StartSessionRequest } from './engine/port.ts';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import { preflightRunAdmission, type TaskContextWorker } from './runtime.ts';
import { ADMISSION_CAPABILITY } from './environment/catalog.ts';
import { loadOrCreateWorkerIdentity, workerPublicKey } from './worker/enrollment-connector.ts';
import {
  agent,
  build,
  connectRuntimeWorker,
  createRuntime,
  enrollEligibleInstance,
  hostConfiguration,
  project,
  PROJECT_ID,
  scriptedEnvironment,
  scriptedTurn,
} from './runtime-test-harness.ts';

test('a Message delivered to the graph wakes its Agent, runs the scripted engine, and projects a reply', async () => {
  const { runtime } = await build({ turns: [scriptedTurn('composition reply')] });

  const delivered = await runtime.collaboration.deliver({
    scopeId: `channel-${PROJECT_ID}`,
    author: { id: 'operator', kind: 'human' },
    body: '@scout please answer',
    deliveryKey: 'composition-delivery-1',
    awaitReply: true,
  });

  assert.equal(delivered.duplicate, false);
  assert.equal(delivered.admittedRunIds.length, 1);

  const run = await runtime.orchestrator.waitFor(delivered.admittedRunIds[0]!);
  assert.equal(run.status, 'completed');
  assert.equal(run.result?.status === 'completed' ? run.result.text : undefined, 'composition reply');

  // The final text was projected back as an Agent-authored Message, proving the
  // run layer, the persistence seam, and the coordinator are genuinely wired.
  const messages = await runtime.collaboration.listMessages();
  const projected = messages.filter(
    (message) => message.author.kind === 'agent' && message.body === 'composition reply',
  );
  assert.equal(projected.length, 1);
  assert.equal(projected[0]?.author.id, 'scout');

  await runtime.close();
});

test('a Task run is admitted through the composed graph and its context port', async () => {
  const prepared: string[] = [];
  const contexts: TaskContextWorker = {
    async prepare(input) {
      prepared.push(input.taskId);
      return { bootstrapInstructions: 'from the composed environment port' };
    },
    async recycle() {
      return undefined;
    },
  };
  const { runtime } = await build({
    turns: [scriptedTurn('task reply')],
    environment: scriptedEnvironment({
      adapters: new Map([
        ['scripted', new ScriptedEngineAdapter({ turns: [scriptedTurn('task reply')] })],
      ]),
      contexts,
    }),
  });

  const task = await runtime.tasks.create({
    projectId: PROJECT_ID,
    title: 'Composition Task',
    goal: 'Advance through the composed graph.',
    assignedAgentId: 'scout',
  });
  const begun = await runtime.tasks.begin(task.id, { agentId: 'scout' });
  // `begin` acquires the Task lease and materializes context, then leaves the
  // Task idle and ready for its first run.
  assert.equal(begun.environmentLifecycleState, 'idle');
  assert.ok(prepared.includes(task.id));

  const advanced = await runtime.tasks.advance(task.id, { agentId: 'scout' });
  assert.equal(advanced.task.environmentLifecycleState, 'running');
  const runs = await runtime.tasks.getWithRuns(task.id);
  assert.ok(runs);
  assert.equal(runs.runs.length, 1);
  assert.equal(runs.runs[0]?.runId, advanced.runId);

  await runtime.close();
});

test('scripted engine sessions are started per run, never by construction', async () => {
  const adapter = new ScriptedEngineAdapter({ turns: [scriptedTurn('counted')] });
  const requests: StartSessionRequest[] = [];
  const recording: EngineAdapter = {
    id: adapter.id,
    capabilities: adapter.capabilities,
    startSession(request: StartSessionRequest): Promise<EngineSession> {
      requests.push(request);
      return adapter.startSession(request);
    },
  };

  const { runtime } = await build({
    environment: scriptedEnvironment({ adapters: new Map([['scripted', recording]]) }),
  });

  assert.equal(requests.length, 0);
  const submitted = await runtime.orchestrator.submit({ agentId: 'scout', prompt: 'go' });
  await runtime.orchestrator.waitFor(submitted.id);
  assert.equal(requests.length, 1);

  await runtime.close();
});

test('a Message run records its admitted work option and configuration version (#90)', async () => {
  const { runtime } = await build({ turns: [scriptedTurn('option reply')] });

  const delivered = await runtime.collaboration.deliver({
    scopeId: `channel-${PROJECT_ID}`,
    author: { id: 'operator', kind: 'human' },
    body: '@scout please answer',
    deliveryKey: 'option-delivery-1',
    awaitReply: true,
  });
  assert.equal(delivered.admittedRunIds.length, 1);

  const run = await runtime.orchestrator.waitFor(delivered.admittedRunIds[0]!);
  assert.equal(run.status, 'completed', run.failure ?? 'run failed');
  // The run names the option it was admitted under: the definition-era agent
  // projects its single engine as one option, at configuration version 1.
  assert.deepEqual(run.workOption, {
    id: 'primary',
    engine: 'scripted',
    workModel: '',
    effort: '',
  });
  assert.equal(run.configurationVersion, 1);

  // The attribution is durable: the same facts come back from the store.
  const stored = await runtime.stores.runs.get(run.id);
  assert.equal(stored?.workOption?.engine, 'scripted');
  assert.equal(stored?.configurationVersion, 1);

  await runtime.close();
});

test('the Agent service composes over the shared durable store and archives safely (#90)', async () => {
  const { runtime, stores } = await build({ listen: false });

  // Create a portable Agent identity through the composed service.
  const agent = await runtime.agentService.create({
    id: 'programmer',
    displayName: 'Programmer',
    instructions: 'Check pure functions.',
    workOptions: [
      { id: 'opt-1', engine: 'scripted', workModel: 'glm-5', effort: 'medium' },
    ],
  });
  assert.equal(agent.status, 'active');
  assert.equal(agent.configuration.currentVersion, 1);
  assert.equal((await stores.agentIdentities.get('programmer'))?.displayName, 'Programmer');

  // Reconfigure: the version history appends, never rewrites.
  const updated = await runtime.agentService.reconfigure('programmer', {
    workOptions: [{ id: 'opt-1', engine: 'scripted', workModel: 'glm-5', effort: 'high' }],
    reason: 'raise effort',
  });
  assert.equal(updated.configuration.currentVersion, 2);
  assert.equal(updated.configuration.versions.length, 2);

  // Archive with no active work succeeds; restore brings the identity back.
  const archived = await runtime.agentService.archive('programmer');
  assert.equal(archived.status, 'archived');
  assert.equal((await runtime.agentService.get('programmer'))?.configuration.versions.length, 2);
  const restored = await runtime.agentService.restore('programmer');
  assert.equal(restored.status, 'active');

  await runtime.close();
});

test('preflightRunAdmission unit: connected but unready instances yield terminal failure with sanitized informative reason', async () => {
  // 1. Specific rejection reason is preserved
  const specificResult = await preflightRunAdmission('scout', 'proj-1', {
    getProjectAvailableInstances: () => ['env-1'],
    isInstanceConnected: (id) => id === 'env-1',
    evaluateOptionAdmission: async () => ({
      ok: false,
      reason: 'Incompatible Node runtime: requires >= 22, observed 18.',
    }),
  });
  assert.deepEqual(specificResult, {
    kind: 'failed',
    reason: 'Incompatible Node runtime: requires >= 22, observed 18.',
  });

  // 2. Sensitive endpoints and credentials in rejection reason are sanitized
  const sanitizedResult = await preflightRunAdmission('scout', 'proj-1', {
    getProjectAvailableInstances: () => ['env-1'],
    isInstanceConnected: (id) => id === 'env-1',
    evaluateOptionAdmission: async () => ({
      ok: false,
      reason: 'Validation failed at http://192.168.1.50:41000/internal with token ghp_secret1234567890abcdef1234.',
    }),
  });
  assert.equal(sanitizedResult.kind, 'failed');
  if (sanitizedResult.kind === 'failed') {
    assert.doesNotMatch(sanitizedResult.reason, /192\.168\./);
    assert.doesNotMatch(sanitizedResult.reason, /ghp_secret/);
    assert.match(sanitizedResult.reason, /<redacted-url>/);
    assert.match(sanitizedResult.reason, /<redacted-credential>/);
  }

  // 3. Fallback generic reason when admission reason is absent
  const fallbackResult = await preflightRunAdmission('scout', 'proj-1', {
    getProjectAvailableInstances: () => ['env-1'],
    isInstanceConnected: (id) => id === 'env-1',
    evaluateOptionAdmission: async () => ({ ok: false }),
  });
  assert.deepEqual(fallbackResult, {
    kind: 'failed',
    reason: "No connected Environment can admit work for agent scout; check Worker readiness and the Project's Environment access.",
  });
});

test('preflightRunAdmission unit: zero connected instances returns unavailable to preserve reconnect retry path', async () => {
  // Disconnected instances
  const disconnected = await preflightRunAdmission('scout', 'proj-1', {
    getProjectAvailableInstances: () => ['env-offline-1', 'env-offline-2'],
    isInstanceConnected: () => false,
    evaluateOptionAdmission: async () => ({ ok: false, reason: 'must not be called' }),
  });
  assert.deepEqual(disconnected, { kind: 'unavailable' });

  // Empty available instances
  const empty = await preflightRunAdmission('scout', 'proj-1', {
    getProjectAvailableInstances: () => [],
    isInstanceConnected: () => true,
    evaluateOptionAdmission: async () => ({ ok: false, reason: 'must not be called' }),
  });
  assert.deepEqual(empty, { kind: 'unavailable' });
});

test('preflightRunAdmission unit: multi-instance project selects the ready connected instance', async () => {
  const result = await preflightRunAdmission('scout', 'proj-1', {
    getProjectAvailableInstances: () => ['env-offline', 'env-unready', 'env-ready'],
    isInstanceConnected: (id) => id !== 'env-offline',
    evaluateOptionAdmission: async (_agentId, instanceId) => {
      if (instanceId === 'env-unready') {
        return { ok: false, reason: 'Unready capability' };
      }
      return { ok: true, option: { id: 'opt-1', engine: 'scripted', workModel: 'm1', effort: 'medium' } };
    },
  });
  assert.deepEqual(result, {
    kind: 'ready',
    environmentInstanceId: 'env-ready',
  });
});

test('composed runtime preflight: connected but unready instances yield terminal failure with visible event and zero runs', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-preflight-unready-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const configuration = hostConfiguration({
    databasePath: join(directory, 'sprout.db'),
    environmentSource: 'enrollment',
    executionMode: 'environment-hosted',
    runtimeConfiguration: {
      agents: [
        {
          ...agent('scout'),
          engine: 'unsupported-engine',
        },
      ],
      project: {
        ...project(),
        availableEnvironmentInstanceIds: ['host-unready'],
      },
    },
  });

  const runtime = await createRuntime({ configuration, projectRoot: '/synthetic/project' });
  t.after(() => runtime.close());

  // Enroll and connect host-unready so workerGateway.liveFor('host-unready') is live.
  await enrollEligibleInstance(runtime, 'host-unready', join(directory, 'unready-key.pem'));

  const delivered = await runtime.collaboration.deliver({
    scopeId: `channel-${PROJECT_ID}`,
    author: { id: 'operator', kind: 'human' },
    body: '@scout please run',
    deliveryKey: 'preflight-unready-del',
    awaitReply: true,
  });

  assert.equal(delivered.admittedRunIds.length, 0);
  assert.equal(delivered.wakes[0]?.status, 'failed');
  assert.ok(delivered.wakes[0]?.detail);
  assert.match(delivered.wakes[0]?.detail ?? '', /has not been observed on this Environment/);
  assert.equal((await runtime.orchestrator.list()).length, 0);

  const events = (await runtime.collaboration.listEvents(PROJECT_ID)).filter(
    (e) => e.kind === 'wake-admission-failure',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.disposition, 'informational');
  assert.equal(events[0]?.detail, delivered.wakes[0]?.detail);
});

test('composed runtime preflight: zero connected instances preserves reconnect retry / failed run path without terminal failure', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-preflight-zero-conn-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const configuration = hostConfiguration({
    databasePath: join(directory, 'sprout.db'),
    environmentSource: 'enrollment',
    executionMode: 'environment-hosted',
    runtimeConfiguration: {
      agents: [agent('scout')],
      project: {
        ...project(),
        availableEnvironmentInstanceIds: ['host-disconnected'],
      },
    },
  });

  const runtime = await createRuntime({ configuration, projectRoot: '/synthetic/project' });
  t.after(() => runtime.close());

  // host-disconnected is NOT enrolled or connected: workerGateway.liveFor('host-disconnected') is undefined.
  const delivered = await runtime.collaboration.deliver({
    scopeId: `channel-${PROJECT_ID}`,
    author: { id: 'operator', kind: 'human' },
    body: '@scout please run',
    deliveryKey: 'preflight-zero-del',
    awaitReply: false,
  });

  assert.notEqual(delivered.wakes[0]?.status, 'failed', 'zero connected instances must NOT trigger terminal failure');
  const failureEvents = (await runtime.collaboration.listEvents(PROJECT_ID)).filter(
    (e) => e.kind === 'wake-admission-failure',
  );
  assert.equal(failureEvents.length, 0, 'no terminal wake-admission-failure event is published');
});

test('composed runtime preflight: multi-instance project pins submission to the ready instance', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-preflight-multi-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const configuration = hostConfiguration({
    databasePath: join(directory, 'sprout.db'),
    environmentSource: 'enrollment',
    executionMode: 'environment-hosted',
    runtimeConfiguration: {
      agents: [agent('scout')],
      project: {
        ...project(),
        availableEnvironmentInstanceIds: ['host-unready', 'host-ready'],
      },
    },
  });

  const runtime = await createRuntime({ configuration, projectRoot: '/synthetic/project' });
  t.after(() => runtime.close());

  // host-ready is connected and observed ready
  await enrollEligibleInstance(runtime, 'host-ready', join(directory, 'ready-key.pem'));

  // host-unready is connected via connectRuntimeWorker directly without ready observation,
  // so under strictAdmission: true, evaluateOptionAdmission rejects host-unready.
  const identity = loadOrCreateWorkerIdentity(join(directory, 'unready-key.pem'));
  const requested = await runtime.enrollments.requestEnrollment({
    environmentInstanceId: 'host-unready',
    displayName: 'host-unready',
    publicKey: workerPublicKey(identity.privateKey),
    platform: 'macos',
    capabilityRequests: [ADMISSION_CAPABILITY],
    engineFacts: [],
  });
  await runtime.enrollments.approve(requested.enrollment.id, {
    capabilityPermissions: { [ADMISSION_CAPABILITY]: true },
  });
  await connectRuntimeWorker(runtime, requested.enrollment.id, join(directory, 'unready-key.pem'));

  const delivered = await runtime.collaboration.deliver({
    scopeId: `channel-${PROJECT_ID}`,
    author: { id: 'operator', kind: 'human' },
    body: '@scout please run',
    deliveryKey: 'preflight-multi-del',
    awaitReply: false,
  });

  assert.equal(delivered.admittedRunIds.length, 1);
  const run = await runtime.orchestrator.get(delivered.admittedRunIds[0]!);
  assert.ok(run);
  assert.equal(run.environmentInstanceId, 'host-ready', 'run was pinned to the ready instance');
});
