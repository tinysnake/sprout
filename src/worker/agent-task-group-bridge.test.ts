import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import { AgentTaskGroupPostError } from '../collaboration/agent-task-group.ts';
import { LineJsonRpcTransport } from '../engine/jsonrpc.ts';
import { EnvironmentWorker } from './server.ts';
import { WorkerClient } from './client.ts';

const input = { body: 'A report is ready for @forge.', deliveryKey: 'worker-group-post-1', kind: 'handoff' as const };

test('Worker Task-group bridge uses session-only credentials and forwards the Core capability', async t => {
  const received: typeof input[] = [];
  let workerPost: ((value: typeof input) => Promise<unknown>) | undefined;
  let sessionToken = '';
  let sessionUrl = '';
  let standingInstructions = '';
  let requestError: unknown;
  const engine = new ScriptedEngineAdapter({
    turns: [{ events: [], result: { status: 'completed', text: 'posted' } }],
  });
  const startSession = engine.startSession.bind(engine);
  engine.startSession = async request => {
    sessionToken = request.sessionEnvironment?.SPROUT_TASK_GROUP_POST_TOKEN ?? '';
    sessionUrl = request.sessionEnvironment?.SPROUT_TASK_GROUP_POST_URL ?? '';
    standingInstructions = request.instructions ?? '';
    workerPost = request.postTaskGroupMessage;
    assert.ok(sessionToken);
    assert.ok(sessionUrl);
    assert.match(standingInstructions, /Task-group post command/);
    assert.equal(standingInstructions.includes(sessionToken), false);

    const session = await startSession(request);
    const run = session.run.bind(session);
    session.run = prompt => {
      const turn = run(prompt);
      return {
        events: turn.events,
        completion: (async () => {
          try {
            assert.equal((await fetch(sessionUrl, { method: 'POST', body: JSON.stringify(input) })).status, 403);
            const response = await fetch(sessionUrl, {
              method: 'POST',
              headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
              body: JSON.stringify(input),
            });
            assert.equal(response.status, 200);
            const result = await response.json() as { readonly messageId: string; readonly authorId: string };
            assert.equal(result.messageId, 'message-1');
            assert.equal(result.authorId, 'scout');
            const frozenResponse = await fetch(sessionUrl, {
              method: 'POST',
              headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
              body: JSON.stringify({ ...input, deliveryKey: 'worker-frozen' }),
            });
            assert.equal(frozenResponse.status, 409);
            const refusal = await frozenResponse.json() as { readonly code: string; readonly reason: string };
            assert.equal(refusal.code, 'scope-read-only');
            assert.equal(refusal.reason, 'task-group-frozen');
          } catch (error) {
            requestError = error;
            throw error;
          }
          return turn.completion;
        })(),
      };
    };
    return session;
  };

  const inputStream = new PassThrough();
  const outputStream = new PassThrough();
  const worker = new EnvironmentWorker({
    environmentInstanceId: 'instance',
    engines: new Map([['scripted', engine]]),
    input: inputStream,
    output: outputStream,
  });
  const transport = new LineJsonRpcTransport({ input: outputStream, output: inputStream });
  t.after(async () => { await worker.shutdown(); transport.close(); });
  const connected = await WorkerClient.connect(transport);
  const session = await connected.adapters.get('scripted')!.startSession({
    agentId: 'scout',
    workingDirectory: '/tmp',
    postTaskGroupMessage: async value => {
      received.push(value as typeof input);
      if (value.deliveryKey === 'worker-frozen') {
        throw new AgentTaskGroupPostError(409, 'scope-read-only', 'Task group is frozen', 'task-group-frozen');
      }
      return {
        messageId: 'message-1',
        scopeId: 'task-group-1',
        authorId: 'scout',
        duplicate: false,
        admittedRunIds: [],
        runs: [],
        wakes: [],
      };
    },
  });
  const turn = session.run('post');
  for await (const _event of turn.events) { /* consume the turn */ }
  const completion = await turn.completion;
  assert.equal(completion.status, 'completed', requestError instanceof Error ? requestError.message : JSON.stringify(completion));
  assert.deepEqual(received, [input, { ...input, deliveryKey: 'worker-frozen' }]);
  await session.close();
  await assert.rejects(workerPost!(input), /expired|unavailable/);
});
