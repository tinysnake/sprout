import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OperatorDiagnostics } from './module.ts';
import { MemoryOperationalStore } from './service.ts';
import { OperatorSessionService } from '../auth/service.ts';
import { InMemoryOperatorSessionStore } from '../auth/store.ts';

/** Arbitrary sensitive payloads are discarded, not pattern-redacted. */
test('export selects typed facts from enrollment, readiness and recovery without content', async () => {
  const privateText = 'UNTRUSTED_PRIVATE_PAYLOAD';
  const auth = new OperatorSessionService({ store: new InMemoryOperatorSessionStore() });
  await auth.initializeOrRecover(privateText);
  const login = (await auth.signIn(privateText))!;
  const session = await auth.authenticate(login.bearerToken);
  assert.ok(session.authenticated);
  const enrollment = { id: privateText, status: 'approved', displayName: privateText, worker: { identityDigest: privateText }, decisions: [{ kind: 'approved', at: 1, actor: privateText, reason: privateText }] };
  const operations = new OperatorDiagnostics({ store: new MemoryOperationalStore(), schema: 22, auth,
    enrollments: { list: async () => [enrollment], readiness: async () => ({ readiness: { connection: { state: 'online', address: privateText }, compatibility: { state: 'compatible', detail: privateText }, engines: [{ engine: 'pi', readiness: 'ready', models: [privateText], authMode: privateText, version: privateText }], workSafety: { state: 'recovery' } } }) } as never,
    recovery: { list: async () => [{ id: privateText, decisions: [{ kind: 'interrupted', at: 2, reason: privateText }, { kind: 'force-released', at: 3, reason: privateText }], unresolvedFacts: [privateText] }] } as never,
  });
  await operations.start();
  const first = await operations.export();
  const second = await operations.export();
  assert.equal(second.events.length, first.events.length, 'repeated reads retain no heartbeat event');
  assert.deepEqual(first.events.map(e => e.kind), ['startup', 'enrollment', 'connection', 'compatibility', 'interruption', 'release']);
  assert.equal(first.environments[0]!.reachability, 'reachable');
  assert.equal(JSON.stringify(first).includes(privateText), false);
  assert.equal(JSON.stringify(first).includes(login.bearerToken), false);
  const settings = await operations.settings(session.session.id);
  assert.equal(settings.session.activeCount, 1);
  assert.equal(settings.access.publicInternetSupported, false);
  assert.equal(JSON.stringify(settings).includes(privateText), false);
  await auth.revokeSession(session.session.id);
  await assert.rejects(operations.settings(session.session.id));
});
