import assert from 'node:assert/strict';
import { test } from 'node:test';

import { journeyWire } from './production-journey-wire.ts';

test('journey wire supports Chat run routes and rejects unknown Usage paths', async () => {
  const wire = journeyWire();

  const active = await wire.respond('/api/chat/scopes/dm-a/active-runs');
  assert.equal(active.status, 200);
  assert.deepEqual(await active.json(), { runs: [] });

  const stopped = await wire.respond('/api/chat/scopes/dm-a/runs/chat-run-a/stop', { method: 'POST' });
  assert.equal(stopped.status, 200);
  assert.deepEqual(await stopped.json(), { id: 'chat-run-a', status: 'interrupted' });

  const path = '/api/usage/not-a-supported-route';
  const response = await wire.respond(path);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Unimplemented wire route' });
  assert.deepEqual(wire.unknown, [path]);
});
