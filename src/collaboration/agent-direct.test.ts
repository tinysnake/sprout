import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { AgentRegistry } from '../agent/registry.ts';
import { ProjectRegistry } from '../project/registry.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { InMemoryRunStore } from '../run/store.ts';
import { RunOrchestrator } from '../run/orchestrator.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import { LineJsonRpcTransport } from '../engine/jsonrpc.ts';
import { EnvironmentWorker } from '../worker/server.ts';
import { WorkerClient } from '../worker/client.ts';
import { CollaborationCoordinator } from './coordinator.ts';
import { InMemoryCollaborationStore } from './store.ts';
import { buildCollaborationScopes } from './scope-harness.ts';
import { createAgentDirectMessageSender } from './agent-direct.ts';

async function build(t: import('node:test').TestContext, eligible = true, stopDuringOpen: false | 'openDirect' | 'scopeState' = false) {
  const projects = new ProjectRegistry([{ id: 'project', goal: '', rules: [], availableEnvironmentInstanceIds: ['instance', 'second'], memberships: ['scout', 'forge'].map(agentId => ({ agentId, responsibilities: [], collaborationInstructions: '' })) }]);
  const scopes = buildCollaborationScopes({ projects });
  const store = new InMemoryCollaborationStore();
  const engine = new ScriptedEngineAdapter({ turns: [{ events: [], result: { status: 'completed', text: '@scout @all reply' } }] });
  let delivery: unknown;
  const scriptedStart = engine.startSession.bind(engine);
  engine.startSession = async request => {
    const session = await scriptedStart(request);
    const originalRun = session.run.bind(session);
    session.run = prompt => {
      if (request.agentId !== 'scout') return originalRun(prompt);
      const completion = (async () => {
        assert.equal(typeof request.sendDirectMessage, 'function');
        const command = { recipientId: 'forge', body: 'help', deliveryKey: 'one', awaitReply: true };
        if (stopDuringOpen) {
          await assert.rejects(request.sendDirectMessage!(command), /no longer active/);
          return { status: 'completed' as const, text: 'refused' };
        }
        const url = request.sessionEnvironment?.SPROUT_AGENT_MESSAGE_URL;
        const token = request.sessionEnvironment?.SPROUT_AGENT_MESSAGE_TOKEN;
        assert.ok(url); assert.ok(token);
        assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403);
        const send = async (input: unknown) => {
          const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(input) });
          assert.equal(response.status, 200);
          return response.json() as Promise<import('../engine/port.ts').AgentDirectMessageResult>;
        };
        const forged = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ ...command, authorId: 'forge' }) });
        assert.equal(forged.status, 400);
        delivery = await send(command);
        const duplicate = await send(command);
        assert.equal(duplicate.duplicate, true);
        return { status: 'completed' as const, text: 'sent' };
      })();
      return { events: (async function* () {})(), completion };
    };
    return session;
  };
  const input = new PassThrough(); const output = new PassThrough();
  const worker = new EnvironmentWorker({ environmentInstanceId: 'instance', engines: new Map([['scripted', engine]]), input, output });
  const transport = new LineJsonRpcTransport({ input: output, output: input });
  const connected = await WorkerClient.connect(transport);
  let coordinator: CollaborationCoordinator;
  const runs: RunOrchestrator = new RunOrchestrator({
    agents: new AgentRegistry(['scout', 'forge'].map(id => ({ id, name: id, engine: 'scripted', capability: 'investigate', workingDirectory: '/srv/work' }))),
    projects, store: new InMemoryRunStore(), engines: stopDuringOpen ? new Map([['scripted', engine]]) : connected.adapters,
    pool: new EnvironmentPool({ definitions: [{ id: 'definition', platform: 'macos', capabilities: [{ name: 'investigate', requiresLease: true }] }], instances: eligible ? [{ id: 'instance', definitionId: 'definition' }, { id: 'second', definitionId: 'definition' }] : [] }),
    directMessages: (run, assertActive) => createAgentDirectMessageSender({ run, assertActive, runs, scopes: scopes.scopes, collaboration: coordinator }),
  });
  let stop: Promise<unknown> | undefined;
  if (stopDuringOpen) {
    const requestStop = async () => {
      const active = (await runs.list()).find(run => run.agentId === 'scout' && run.status === 'running');
      assert.ok(active);
      stop = runs.stop(active.id);
    };
    if (stopDuringOpen === 'openDirect') {
      const original = scopes.scopes.openDirect.bind(scopes.scopes);
      scopes.scopes.openDirect = async input => { await requestStop(); return original(input); };
    } else {
      const original = scopes.scopes.scopeState.bind(scopes.scopes);
      scopes.scopes.scopeState = async (scopeId, actorId) => { await requestStop(); return original(scopeId, actorId); };
    }
  }
  coordinator = new CollaborationCoordinator({ scopes: scopes.scopes, store, runs });
  t.after(async () => { await worker.shutdown(); transport.close(); });
  return { runs, stop: () => stop, transport: worker.transport, coordinator, scopes, engine, delivery: () => delivery as { authorId: string; wakes: { reason: string; status: string }[]; admittedRunIds: string[] }, sender: createAgentDirectMessageSender };
}

test('protected two-Agent explicit DM resolves its author, deduplicates, and never routes projected replies', async t => {
  const h = await build(t);
  const run = await h.runs.submit({ agentId: 'scout', projectId: 'project', prompt: 'start', environmentPreference: { kind: 'instance', id: 'second' } });
  const settled = await h.runs.waitFor(run.id);
  assert.equal(settled.status, 'completed', JSON.stringify(settled.result));
  await assert.rejects(h.transport.request('agent/direct-message', { sessionId: 'unknown', input: { recipientId: 'forge', body: 'forged', deliveryKey: 'unknown' } }), /unavailable/);
  // Exercise a live Worker session capability: its callback is bound by Core.
  const request = h.engine.requests[0]!;
  assert.equal(typeof request.sendDirectMessage, 'function');
  // Closed sessions must revoke their capability.
  await assert.rejects(request.sendDirectMessage!({ recipientId: 'forge', body: 'late', deliveryKey: 'late' }));
  assert.equal(h.delivery().authorId, 'scout');
  assert.equal(h.delivery().wakes[0]?.reason, 'direct-recipient');
  assert.equal(h.delivery().admittedRunIds.length, 1);
  assert.equal(h.engine.requests.length, 2);
  await h.coordinator.reconcile();
  await h.coordinator.reconcile();
  assert.equal(h.engine.requests.length, 2, 'projection and reconciliation never wake scout again');
  const messages = await h.coordinator.listMessages();
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map(m => m.author.id), ['scout', 'forge']);
  assert.equal(messages[1]?.inReplyTo, messages[0]?.id);
  assert.equal(messages[1]?.scopeId, messages[0]?.scopeId);
});

test('server-bound sender rejects author selection and reports unavailable recipient admission', async t => {
  const h = await build(t, false);
  const sender = h.sender({ run: { agentId: 'scout', projectId: 'project' }, runs: h.runs, scopes: h.scopes.scopes, collaboration: h.coordinator });
  await assert.rejects(h.sender({ run: { agentId: 'scout' }, runs: h.runs, scopes: h.scopes.scopes, collaboration: h.coordinator })({ recipientId: 'forge', body: 'no Project', deliveryKey: 'missing-project' }), /Project-bound/);
  await assert.rejects(sender({ recipientId: 'forge', body: 'forged', deliveryKey: 'forged', authorId: 'forge' } as never), /author|unsupported/);
  const result = await sender({ recipientId: 'forge', body: 'help', deliveryKey: 'one', awaitReply: true });
  assert.equal(result.authorId, 'scout');
  assert.equal(result.runs[0]?.status, 'failed');
  assert.match(result.runs[0]?.failure ?? '', /environment/i);
  assert.equal(h.engine.requests.length, 0, 'no engine work without an eligible environment');
});

for (const lookup of ['openDirect', 'scopeState'] as const) {
  test(`Stop during ${lookup} refuses in-flight send without persisting or admitting`, async t => {
    const h = await build(t, true, lookup);
    const run = await h.runs.submit({ agentId: 'scout', projectId: 'project', prompt: 'start', environmentPreference: { kind: 'instance', id: 'second' } });
    const settled = await h.runs.waitFor(run.id);
    await h.stop();
    assert.deepEqual(await h.coordinator.listMessages(), [], 'no Message persisted');
    assert.equal(h.engine.requests.length, 1, 'no recipient admitted');
    assert.equal((await h.runs.list()).length, 1, 'no recipient Run created');
    assert.equal(settled.result?.status, 'completed', 'engine observed truthful refusal');
  });
}
