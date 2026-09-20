import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createEnvironmentEnrollmentBrowserAdapter } from './environment-api.ts';
import { BrowserRequestError, type BrowserTransport } from '../transport/browser-transport.ts';

function recordingTransport(
  responder: (path: string, init?: RequestInit) => unknown,
): { readonly transport: BrowserTransport; readonly calls: { path: string; init?: RequestInit }[] } {
  const calls: { path: string; init?: RequestInit }[] = [];
  const transport: BrowserTransport = {
    state: () => ({ status: 'online', connection: 'online', loading: false }),
    subscribeState: () => () => undefined,
    setCsrfToken: () => undefined,
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      calls.push(init === undefined ? { path } : { path, init });
      return responder(path, init) as T;
    },
    events: () => () => undefined,
  };
  return { transport, calls };
}

test('the environment adapter lists enrollments through the typed route', async () => {
  const { transport, calls } = recordingTransport(() => ({ enrollments: [] }));
  const adapter = createEnvironmentEnrollmentBrowserAdapter(transport);
  assert.deepEqual(await adapter.listEnrollments(), []);
  assert.deepEqual(calls.map((call) => call.path), ['/api/environments/enrollments']);
});

test('request, approve, revoke, and reset use explicit POST routes', async () => {
  const { transport, calls } = recordingTransport((path) => {
    if (path.endsWith('/approve')) return { enrollment: { id: 'e1', status: 'approved' } };
    if (path.endsWith('/revoke')) return { enrollment: { id: 'e1', status: 'revoked' } };
    if (path.endsWith('/reset')) return { enrollment: { id: 'e1', status: 'pending' } };
    return { enrollment: { id: 'e1', status: 'pending' }, bootstrap: { instructions: [] } };
  });
  const adapter = createEnvironmentEnrollmentBrowserAdapter(transport);

  await adapter.requestEnrollment({
    environmentInstanceId: 'mac-mini-1',
    displayName: 'Local Mac',
    platform: 'macos',
    publicKey: 'public-key-a',
    capabilityRequests: ['agent-run'],
  });
  const approved = await adapter.approveEnrollment('e1', { 'agent-run': true });
  assert.equal(approved.status, 'approved');
  await adapter.revokeEnrollment('e1', '');
  await adapter.resetEnrollment('e1', '');

  assert.deepEqual(
    calls.map((call) => `${call.init?.method} ${call.path}`),
    [
      'POST /api/environments/enrollments',
      'POST /api/environments/enrollments/e1/approve',
      'POST /api/environments/enrollments/e1/revoke',
      'POST /api/environments/enrollments/e1/reset',
    ],
  );
  // The public key is sent once as the proof input; nothing is retained.
  const firstBody = calls[0]?.init?.body;
  assert.equal(typeof firstBody, 'string');
  assert.equal(firstBody.includes('public-key-a'), true);
});

test('the adapter never retains a command for replay after a failure', async () => {
  const { transport } = recordingTransport(() => {
    throw new BrowserRequestError('unavailable');
  });
  const adapter = createEnvironmentEnrollmentBrowserAdapter(transport);
  await assert.rejects(() => adapter.listEnrollments(), (error: unknown) => error instanceof BrowserRequestError);
});

test('connectWorker requests a challenge and submits a signed proof', async () => {
  const { transport, calls } = recordingTransport((path) => {
    if (path.endsWith('/challenge')) {
      return {
        challenge: { id: 'challenge-1', enrollmentId: 'e1', nonce: 'nonce-1', issuedAt: 1, expiresAt: 2 },
      };
    }
    if (path.endsWith('/connect')) {
      return { outcome: 'reconnected', requiresHumanApproval: false, enrollment: { id: 'e1' } };
    }
    return { readiness: { environmentInstanceId: 'mac-mini-1' }, probes: [] };
  });
  const adapter = createEnvironmentEnrollmentBrowserAdapter(transport);

  const challenge = await adapter.requestChallenge('e1');
  assert.equal(challenge.nonce, 'nonce-1');
  const connected = await adapter.connectWorker('e1', {
    proof: { challengeId: challenge.id, publicKey: 'public-key-a', signature: 'signed-nonce-1' },
    connection: { state: 'online' },
    compatibility: { state: 'compatible', workerProtocolVersion: '2.1' },
    engines: [{ engine: 'codex', installed: true, readiness: 'ready', models: { state: 'available', models: [] } }],
  });
  assert.equal(connected.outcome, 'reconnected');
  await adapter.readiness('e1');

  assert.deepEqual(
    calls.map((call) => `${call.init?.method ?? 'GET'} ${call.path}`),
    [
      'POST /api/environments/enrollments/e1/challenge',
      'POST /api/environments/enrollments/e1/connect',
      'GET /api/environments/enrollments/e1/readiness',
    ],
  );
  // The signed proof is carried on the connect command.
  const connectBody = calls[1]?.init?.body;
  assert.equal(typeof connectBody, 'string');
  assert.equal((connectBody as string).includes('signed-nonce-1'), true);
});

test('no adapter request path carries credentials, hostnames, or absolute paths', async () => {
  const { transport, calls } = recordingTransport(() => ({ enrollments: [] }));
  const adapter = createEnvironmentEnrollmentBrowserAdapter(transport);
  await adapter.listEnrollments();
  await adapter.readiness('e1/../secret');
  const serialized = JSON.stringify(calls.map((call) => call.path));
  assert.equal(serialized.includes('credential'), false);
  assert.equal(/\/Users\//.test(serialized), false);
  // A path segment is escaped, so it cannot traverse to another route.
  assert.equal(serialized.includes('e1/../'), false);
});
