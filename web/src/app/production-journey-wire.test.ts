import assert from 'node:assert/strict';
import { test } from 'node:test';

import { journeyWire } from './production-journey-wire.ts';

test('unknown Usage paths fail instead of returning aggregate fixture data', async () => {
  const wire = journeyWire();
  const path = '/api/usage/not-a-supported-route';

  const response = await wire.respond(path);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Unimplemented wire route' });
  assert.deepEqual(wire.unknown, [path]);
});
