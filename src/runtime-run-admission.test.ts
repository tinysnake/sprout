import test from 'node:test';
import assert from 'node:assert/strict';
import type { EngineAdapter, EngineSession, StartSessionRequest } from './engine/port.ts';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import type { TaskContextWorker } from './runtime.ts';
import {
  build,
  PROJECT_ID,
  scriptedEnvironment,
  scriptedTurn,
} from './runtime-test-harness.ts';

test('a Message delivered to the graph wakes its Agent, runs the scripted engine, and projects a reply', async () => {
  const { runtime } = await build({ turns: [scriptedTurn('composition reply')] });

  const delivered = await runtime.collaboration.deliver({
    projectId: PROJECT_ID,
    channel: 'project',
    author: { id: 'human', kind: 'human' },
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
    projectId: PROJECT_ID,
    channel: 'project',
    author: { id: 'human', kind: 'human' },
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
