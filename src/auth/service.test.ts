import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OperatorSessionService } from './service.ts';
import { InMemoryOperatorSessionStore } from './store.ts';
import { SqliteOperatorSessionStore } from './sqlite-store.ts';

/** Inputs are generated at test time, never committed as credentials or tokens. */
function privateInput(): string {
  return randomBytes(32).toString('base64url');
}

test('a host-initialized identity creates independent hashed browser sessions', async () => {
  const store = new InMemoryOperatorSessionStore();
  const service = new OperatorSessionService({ store });
  const credential = privateInput();
  await service.initializeOrRecover(credential);

  const first = await service.signIn(credential);
  const second = await service.signIn(credential);
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.bearerToken, second.bearerToken);
  assert.notEqual(first.csrfToken, second.csrfToken);

  const operator = await store.getOperator();
  const sessions = await store.listSessions();
  assert.ok(operator);
  assert.equal(sessions.length, 2);
  const portable = JSON.stringify({ operator, sessions });
  assert.equal(portable.includes(credential), false);
  assert.equal(portable.includes(first.bearerToken), false);
  assert.equal(portable.includes(first.csrfToken), false);

  const authenticated = await service.authenticate(first.bearerToken);
  assert.equal(authenticated.authenticated, true);
  if (!authenticated.authenticated) return;
  assert.equal(await service.verifyRequestForgery(authenticated.session.id, first.csrfToken), true);
  assert.equal(await service.verifyRequestForgery(authenticated.session.id, privateInput()), false);
});

test('session revocation, revoke-others, and host recovery remain durable across restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-auth-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'sprout.db');
  const credential = privateInput();

  const firstStore = new SqliteOperatorSessionStore({ filename });
  const firstService = new OperatorSessionService({ store: firstStore });
  await firstService.initializeOrRecover(credential);
  const current = await firstService.signIn(credential);
  const other = await firstService.signIn(credential);
  assert.ok(current);
  assert.ok(other);
  const currentAuth = await firstService.authenticate(current.bearerToken);
  assert.equal(currentAuth.authenticated, true);
  if (!currentAuth.authenticated) return;
  assert.equal(await firstService.revokeOtherSessions(currentAuth.session.id), 1);
  assert.equal((await firstService.authenticate(other.bearerToken)).authenticated, false);
  firstStore.close();

  const restartedStore = new SqliteOperatorSessionStore({ filename });
  const restarted = new OperatorSessionService({ store: restartedStore });
  assert.equal((await restarted.authenticate(current.bearerToken)).authenticated, true);

  // A distinct host-local recovery input rotates the identity and invalidates
  // even the session that survived the ordinary restart.
  await restarted.initializeOrRecover(privateInput());
  assert.equal((await restarted.authenticate(current.bearerToken)).authenticated, false);
  assert.equal((await restarted.listSessions(currentAuth.session.id)).length, 0);
  restartedStore.close();
});
