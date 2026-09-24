import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { JsonRpcTransport } from '../engine/jsonrpc.ts';
import { EnrollmentWorkerPort } from './enrollment-port.ts';
import type { WorkerGateway, WorkerGatewayAcceptance } from './gateway.ts';
import { WORKER_DIAGNOSTICS } from './diagnostics.ts';

test('enrollment-port identification failures never log transport error text', async () => {
  const privateError = 'socket failed at /synthetic/private/path for private.example:7443';
  const transport: JsonRpcTransport = {
    request: async () => { throw new Error(privateError); },
    notify: () => undefined,
    onNotification: () => () => undefined,
    onServerRequest: () => () => undefined,
    respond: () => undefined,
    respondError: () => undefined,
    close: () => undefined,
  };
  let accepted: ((acceptance: WorkerGatewayAcceptance) => void) | undefined;
  const acceptance = {
    accepted: true,
    enrollment: { environmentInstanceId: 'private-host-label' },
    epoch: { connectionId: 'private-connection-id', epoch: 99 },
    transport,
    onChannelClosed: () => () => undefined,
    close: () => undefined,
  } as unknown as WorkerGatewayAcceptance;
  const gateway = {
    onAccept: (listener: (value: WorkerGatewayAcceptance) => void) => {
      accepted = listener;
      return () => undefined;
    },
    liveFor: () => acceptance,
  } as unknown as WorkerGateway;
  const logs: string[] = [];
  const port = new EnrollmentWorkerPort({ gateway, onLog: (line) => logs.push(line) });
  accepted?.(acceptance);

  assert.equal(await port.info('private-host-label'), undefined);
  assert.deepEqual(logs, [WORKER_DIAGNOSTICS.identificationFailed]);
  assert.doesNotMatch(logs.join('\n'), /private-host|private-connection|private\.example|synthetic\/private|socket failed/);
  await assert.rejects(
    () => port.adapters('private-host-label'),
    new RegExp(WORKER_DIAGNOSTICS.connectionUnavailable, 'i'),
  );
  await port.close();
});

test('connectWorkerEnrollment preserves downstream stream data arriving alongside worker/listening', async () => {
  const { WebSocketServer, createWebSocketStream } = await import('ws');
  const { connectWorkerEnrollment } = await import('./enrollment-connector.ts');
  const { WORKER_PROTOCOL_VERSION } = await import('./protocol.ts');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const wss = new WebSocketServer({ port: 0 });
  const port = (wss.address() as { port: number }).port;
  let receivedRpc = false;

  wss.on('connection', (ws) => {
    const stream = createWebSocketStream(ws);
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes('worker/hello')) {
        buffer = '';
        stream.write(JSON.stringify({
          type: 'worker/accepted',
          enrollmentId: 'enroll-pipelined',
          environmentInstanceId: 'inst-pipelined',
          epoch: 1,
          connectionId: 'conn-1',
        }) + '\n');
      } else if (buffer.includes('worker/ready')) {
        buffer = '';
        // Server writes worker/listening AND downstream JSON-RPC line together in one segment/stream write
        stream.write(
          JSON.stringify({ type: 'worker/listening', epoch: 1 }) + '\n' +
          JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'worker/info', params: null }) + '\n'
        );
      }
    });
  });

  const dir = mkdtempSync(join(tmpdir(), 'sprout-test-pipelined-'));
  const keyPath = join(dir, 'key.pem');
  try {
    const connection = await connectWorkerEnrollment({
      target: { enrollmentId: 'enroll-pipelined', host: '127.0.0.1', port, claimSecret: undefined, identityKeyPath: keyPath },
      protocolVersion: WORKER_PROTOCOL_VERSION,
      engineFacts: [],
    });

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 300);
      connection.stream.on('data', (chunk) => {
        if (chunk.toString().includes('worker/info')) receivedRpc = true;
        clearTimeout(timer);
        resolve();
      });
    });

    connection.close();
    wss.close();
    assert.equal(receivedRpc, true, 'the downstream JSON-RPC request must not be swallowed by the handshake reader');
  } finally {
    wss.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
