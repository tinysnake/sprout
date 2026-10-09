import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteOperationalStore } from './sqlite-store.ts';
import { OperatorDiagnostics } from './module.ts';
import { MemoryOperationalStore, diagnosticSubject } from './service.ts';
import { OperatorSessionService } from '../auth/service.ts';
import { InMemoryOperatorSessionStore } from '../auth/store.ts';
import { createExecutionStrategy } from '../execution-mode.ts';

test('diagnostic recovery rows retain correlation and validated owners across journal reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'diagnostic-correlation-'));
  const filename = join(directory, 'journal.db');
  let db = new DatabaseSync(filename);
  let store = new SqliteOperationalStore(db);
  const recovery = { list: async () => [
    { id: 'recovery-task', runId: 'run-1', taskId: 'task-1', decisions: [{ kind: 'interrupted', at: 1000, reason: 'PRIVATE_REASON' }] },
    { id: 'recovery-chat', runId: 'run-2', decisions: [{ kind: 'interrupted', at: 2000 }] },
    { id: 'recovery-missing', runId: 'run-missing', decisions: [{ kind: 'interrupted', at: 3000 }] },
    { id: 'recovery-holder', holderKind: 'task', holderId: 'task-1', decisions: [{ kind: 'released', at: 4000 }] },
  ] };
  const options = { schema: 22, auth: new OperatorSessionService({ store: new InMemoryOperatorSessionStore() }),
    executionStrategy: createExecutionStrategy('environment-hosted'),
    enrollments: { list: async () => [] } as never, recovery: recovery as never,
    task: async (id: string) => id === 'task-1' ? { id, projectId: 'project-1', goal: 'PRIVATE_GOAL' } : undefined,
    run: async (id: string) => id === 'run-2' ? { id, projectId: 'project-1', agentId: 'agent-1', prompt: 'PRIVATE_PROMPT' } : undefined,
  };
  try {
    for (let i = 0; i < 2; i++) {
      const events = (await new OperatorDiagnostics({ ...options, store }).export()).events;
      assert.equal(events.length, 4, 'rejoining does not append duplicate observations');
      assert.deepEqual(events[0]!.correlation, { runId: 'run-1', taskId: 'task-1' });
      assert.deepEqual(events[0]!.target, { surface: 'project-task-detail', projectId: 'project-1', taskId: 'task-1', path: '/project/tasks/task-1' });
      assert.deepEqual(events[1]!.target, { surface: 'project-chat', projectId: 'project-1', runId: 'run-2', path: '/project/chat' });
      assert.deepEqual(events[2]!.correlation, { runId: 'run-missing' });
      assert.equal(events[2]!.target, undefined, 'missing owner stays plain');
      assert.deepEqual(events[3]!.correlation, { taskId: 'task-1' }, 'the authoritative lease holder is also a Task identity');
      assert.deepEqual(events[3]!.target, events[0]!.target);
      assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
      assert.equal((await store.events())[0]!.subject, diagnosticSubject('recovery:recovery-task:0'));
      assert.equal(Object.hasOwn((await store.events())[0]!, 'correlation'), false, 'journal stays minimal');
      db.close();
      db = new DatabaseSync(filename);
      store = new SqliteOperationalStore(db);
    }
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

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
    executionStrategy: createExecutionStrategy('environment-hosted'),
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
  assert.equal(settings.executionMode, 'environment-hosted');
  assert.equal(settings.access.publicInternetSupported, false);
  assert.equal(JSON.stringify(settings).includes(privateText), false);
  await auth.revokeSession(session.session.id);
  await assert.rejects(operations.settings(session.session.id));
});

test('Host Pi and Codex Settings project local readiness facts without exposing profile identities', async () => {
  const secretProfileId = 'opaque-local-profile-id';
  const secretCodexProfileId = 'opaque-codex-profile-id';
  const auth = new OperatorSessionService({ store: new InMemoryOperatorSessionStore() });
  await auth.initializeOrRecover('synthetic-credential');
  const login = (await auth.signIn('synthetic-credential'))!;
  const session = await auth.authenticate(login.bearerToken);
  assert.ok(session.authenticated);
  const operations = new OperatorDiagnostics({
    store: new MemoryOperationalStore(), schema: 22, auth,
    executionStrategy: createExecutionStrategy('host-run', true),
    hostPiReadiness: async () => ({
      profileId: secretProfileId, engine: 'pi', status: 'ready', installation: 'ready',
      authentication: 'ready', modelAvailability: 'available', adapterControls: 'ready',
      version: '1.0.4', observedAt: 1_000,
    }),
    hostCodexReadiness: async () => ({
      profileId: secretCodexProfileId, engine: 'codex', status: 'ready', installation: 'ready',
      authentication: 'ready', modelAvailability: 'available', adapterControls: 'ready',
      version: '0.159.3', supportedEfforts: ['medium'], observedAt: 1_000,
    }),
    enrollments: { list: async () => [] } as never,
    recovery: { list: async () => [] } as never,
  });
  const settings = await operations.settings(session.session.id);
  assert.equal(settings.executionMode, 'host-run');
  assert.deepEqual(settings.hostPi, {
    status: 'ready', installation: 'ready', authentication: 'ready',
    modelAvailability: 'available', adapterControls: 'ready', version: '1.0.4',
  });
  assert.deepEqual(settings.hostCodex, {
    status: 'ready', installation: 'ready', authentication: 'ready',
    modelAvailability: 'available', adapterControls: 'ready', version: '0.159.3',
  });
  assert.equal(JSON.stringify(settings).includes(secretProfileId), false);
  assert.equal(JSON.stringify(settings).includes(secretCodexProfileId), false);
});
