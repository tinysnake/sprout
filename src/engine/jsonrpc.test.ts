import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { LineJsonRpcTransport } from './jsonrpc.ts';

/**
 * Connects a transport to a fake server over in-memory streams and registers the
 * teardown that lets the test process exit: an open readline handle would
 * otherwise keep the event loop alive and hang the runner.
 */
function connected(t: { after(fn: () => void): void }) {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const transport = new LineJsonRpcTransport({ input: serverToClient, output: clientToServer });
  t.after(() => {
    clientToServer.destroy();
    serverToClient.destroy();
  });
  return {
    transport,
    clientToServer,
    serverToClient,
    nextMessage: lineReader(clientToServer),
  };
}

/**
 * Reads successive JSON messages from a stream.
 *
 * A stream chunk may carry several lines at once, so this queues parsed lines
 * rather than resolving per `data` event; otherwise a second read would wait for
 * bytes that already arrived.
 */
function lineReader(stream: PassThrough): () => Promise<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = [];
  const waiters: ((value: Record<string, unknown>) => void)[] = [];
  let buffer = '';

  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() !== '') {
        const message = JSON.parse(line) as Record<string, unknown>;
        const waiter = waiters.shift();
        if (waiter) waiter(message);
        else queue.push(message);
      }
      newline = buffer.indexOf('\n');
    }
  });

  return () =>
    new Promise((resolve) => {
      const queued = queue.shift();
      if (queued) resolve(queued);
      else waiters.push(resolve);
    });
}

test('a request is written as line-framed JSON-RPC and its result is correlated', async (t) => {
  const { transport, serverToClient, nextMessage } = connected(t);

  const pending = transport.request<{ thread: { id: string } }>('thread/start', { cwd: '/tmp' });
  const sent = await nextMessage();
  assert.equal(sent.method, 'thread/start');
  assert.deepEqual(sent.params, { cwd: '/tmp' });
  assert.equal(sent.jsonrpc, '2.0');

  serverToClient.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { thread: { id: 't1' } } })}\n`,
  );
  assert.deepEqual(await pending, { thread: { id: 't1' } });
});

test('concurrent requests resolve independently', async (t) => {
  const { transport, nextMessage, serverToClient } = connected(t);

  const first = transport.request<string>('a');
  const second = transport.request<string>('b');
  const sentA = await nextMessage();
  const sentB = await nextMessage();

  serverToClient.write(`${JSON.stringify({ id: sentB.id, result: 'second' })}\n`);
  serverToClient.write(`${JSON.stringify({ id: sentA.id, result: 'first' })}\n`);

  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
});

test('a JSON-RPC error rejects only its own call', async (t) => {
  const { transport, nextMessage, serverToClient } = connected(t);

  const failing = transport.request('turn/start');
  const sent = await nextMessage();
  serverToClient.write(
    `${JSON.stringify({ id: sent.id, error: { code: -32_601, message: 'no such thread' } })}\n`,
  );

  await assert.rejects(failing, /turn\/start: no such thread/);
});

test('notifications are delivered to subscribers in order', async (t) => {
  const { transport, serverToClient } = connected(t);
  const seen: string[] = [];
  transport.onNotification((notification) => seen.push(notification.method));

  serverToClient.write(`${JSON.stringify({ method: 'turn/started', params: { threadId: 't' } })}\n`);
  serverToClient.write(`${JSON.stringify({ method: 'item/started', params: {} })}\n`);
  serverToClient.write(`${JSON.stringify({ method: 'turn/completed', params: {} })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(seen, ['turn/started', 'item/started', 'turn/completed']);
});

test('a server-initiated request is surfaced and can be answered', async (t) => {
  const { transport, serverToClient, nextMessage } = connected(t);
  const received: string[] = [];
  transport.onServerRequest((request) => {
    received.push(request.method);
    transport.respond(request.id, { decision: 'approved' });
  });

  serverToClient.write(`${JSON.stringify({ id: 99, method: 'execCommandApproval', params: {} })}\n`);
  const answer = await nextMessage();

  assert.deepEqual(received, ['execCommandApproval']);
  assert.equal(answer.id, 99);
  assert.deepEqual(answer.result, { decision: 'approved' });
});

test('a malformed line does not break the transport', async (t) => {
  const { transport, nextMessage, serverToClient } = connected(t);

  const pending = transport.request<string>('ping');
  const sent = await nextMessage();
  serverToClient.write('not json at all\n');
  serverToClient.write('\n');
  serverToClient.write(`${JSON.stringify({ id: sent.id, result: 'pong' })}\n`);

  assert.equal(await pending, 'pong');
});

test('closing the transport fails pending calls instead of hanging', async (t) => {
  const { transport } = connected(t);
  const pending = transport.request('never/answers');
  transport.close();
  await assert.rejects(pending, /transport closed/);
});

test('the stream ending fails pending calls', async (t) => {
  const { transport, serverToClient } = connected(t);
  const pending = transport.request('never/answers');
  serverToClient.end();
  await assert.rejects(pending, /transport closed/);
});
