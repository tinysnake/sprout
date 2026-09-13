import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import { EndpointCarrier, serveWorkerEndpoint, WORKER_READY_PREFIX } from './carrier.ts';

/**
 * These tests cross the real carrier: a separate worker process, reached over a
 * loopback TCP endpoint. That is deliberately the same path a container uses in
 * shape, so a passing test here is evidence the core has no in-process shortcut.
 */
test('the core reaches a worker as a separate process over a network endpoint', async (t) => {
  const connection = await EndpointCarrier.start({
    command: process.execPath,
    args: [
      '--input-type=module',
      '-e',
      workerScript(),
    ],
    label: 'test-worker',
    readyTimeoutMs: 20_000,
  });
  t.after(() => connection.close());

  assert.equal(connection.info.environmentInstanceId, 'test-instance');
  assert.deepEqual([...connection.adapters.keys()], ['scripted']);
  assert.notEqual(connection.info.pid, process.pid, 'the worker is a different process');
});

test('a run completes through a real worker process', async (t) => {
  const connection = await EndpointCarrier.start({
    command: process.execPath,
    args: ['--input-type=module', '-e', workerScript()],
    label: 'test-worker',
    readyTimeoutMs: 20_000,
  });
  t.after(() => connection.close());

  const adapter = connection.adapters.get('scripted');
  assert.ok(adapter);
  const session = await adapter.startSession({ agentId: 'agent-scout', workingDirectory: '/tmp' });
  const turn = session.run('say hi');
  const types: string[] = [];
  for await (const event of turn.events) types.push(event.type);
  const result = await turn.completion;

  assert.deepEqual(types, ['tool-call', 'message']);
  assert.deepEqual(result, { status: 'completed', text: 'done' });
});

test('a worker that never becomes ready produces a start error, not a hang', async (t) => {
  const started = Date.now();
  await assert.rejects(
    EndpointCarrier.start({
      command: process.execPath,
      args: ['--input-type=module', '-e', 'process.exit(3)'],
      label: 'dead-worker',
      readyTimeoutMs: 10_000,
    }),
    /exited before it was ready/,
  );
  assert.ok(Date.now() - started < 9_000, 'the failure is reported promptly');
  t.diagnostic('unreachable worker reported as a start error');
});

test('a worker endpoint publishes its address so the core can find it', async (t) => {
  const endpoint = await serveWorkerEndpoint({
    serve: () => undefined,
  });
  t.after(() => endpoint.close());

  assert.match(WORKER_READY_PREFIX, /SPROUT_WORKER_READY/);
  assert.equal(endpoint.ready.host, '127.0.0.1');
  assert.ok(endpoint.ready.port > 0);
});

/**
 * A worker process definition used by these tests.
 *
 * It hosts the scripted adapter rather than Codex so the test needs no model
 * call, while still exercising the real process, socket, and protocol.
 */
function workerScript(): string {
  const workerServer = new URL('./server.ts', import.meta.url).pathname;
  const scripted = new URL('../engine/scripted.ts', import.meta.url).pathname;
  const carrier = new URL('./carrier.ts', import.meta.url).pathname;
  const scriptedClass = ScriptedEngineAdapter.name;
  return `
    import { ScriptedEngineAdapter } from ${JSON.stringify(scripted)};
    import { EnvironmentWorker } from ${JSON.stringify(workerServer)};
    import { serveWorkerEndpoint, WORKER_READY_PREFIX } from ${JSON.stringify(carrier)};
    const engines = new Map([['scripted', new ${scriptedClass}({ turns: [
      { events: [
        { type: 'tool-call', name: 'shell', detail: 'echo hi' },
        { type: 'message', text: 'done', final: true },
      ], result: { status: 'completed', text: 'done' } },
    ] })]]);
    const endpoint = await serveWorkerEndpoint({
      serve: (socket) => { new EnvironmentWorker({
        environmentInstanceId: 'test-instance', engines, input: socket, output: socket,
      }); socket.on('error', () => undefined); },
    });
    process.stdout.write(WORKER_READY_PREFIX + JSON.stringify({ host: endpoint.ready.host, port: endpoint.ready.port }) + '\\n');
  `;
}
