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
