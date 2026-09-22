import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isLoopbackAddress, decideWorkerTransport, workerConnectionUrl } from './worker-transport.ts';

test('loopback addresses are recognised in IPv4, IPv6, mapped, and named forms', () => {
  for (const address of ['127.0.0.1', '127.5.6.7', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1', '::1%lo0']) {
    assert.equal(isLoopbackAddress(address), true, `${address} should be loopback`);
  }
  for (const address of ['10.0.0.5', '192.168.1.2', '8.8.8.8', '2001:db8::1', 'example.internal', undefined, '']) {
    assert.equal(isLoopbackAddress(address), false, `${address} should not be loopback`);
  }
});

test('loopback plaintext WS is allowed and non-loopback plaintext is refused before any command', () => {
  assert.deepEqual(decideWorkerTransport({ secure: false, remoteAddress: '127.0.0.1' }), {
    allowed: true,
    kind: 'ws',
  });
  const refused = decideWorkerTransport({ secure: false, remoteAddress: '10.1.2.3' });
  assert.equal(refused.allowed, false);
  if (!refused.allowed) assert.match(refused.reason, /WSS/);
});

test('any TLS transport is allowed regardless of peer address', () => {
  assert.deepEqual(decideWorkerTransport({ secure: true, remoteAddress: '10.1.2.3' }), {
    allowed: true,
    kind: 'wss',
  });
  assert.deepEqual(decideWorkerTransport({ secure: true, remoteAddress: '127.0.0.1' }), {
    allowed: true,
    kind: 'wss',
  });
});

test('the Worker dials ws on loopback and wss off-loopback, and cannot be downgraded', () => {
  assert.equal(
    workerConnectionUrl({ host: '127.0.0.1', port: 5174, path: '/api/worker/connect' }),
    'ws://127.0.0.1:5174/api/worker/connect',
  );
  assert.equal(
    workerConnectionUrl({ host: 'host.internal', port: 5174, path: '/api/worker/connect' }),
    'wss://host.internal:5174/api/worker/connect',
  );
  // An explicit plaintext request to a non-loopback host is overridden, not obeyed.
  assert.equal(
    workerConnectionUrl({ host: 'host.internal', port: 5174, path: '/p', scheme: 'ws' }),
    'wss://host.internal:5174/p',
  );
  // An IPv6 literal is bracketed.
  assert.equal(
    workerConnectionUrl({ host: '2001:db8::1', port: 9, path: '/p' }),
    'wss://[2001:db8::1]:9/p',
  );
});
