import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import { projectChannelScopeId } from './conversation/model.ts';
import { INSTANCE_ID, readinessWorkflowHarness, scriptedStartupReadiness, testComposition, waitFor } from './runtime-test-harness.ts';

const worker = () => ({ engines: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]), readiness: scriptedStartupReadiness });

test('SQLite trigger insert/disarm crash window rolls back the whole eligible set across reopen', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'retry-crash-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'sprout.db');
  const h = await readinessWorkflowHarness({ backend: 'sqlite', directory });
  let originalId: string;
  try {
    const enrollment = (await h.runtime.enrollments.list())[0]!.id;
    const key = join(directory, 'worker-key.pem');
    await h.connect(enrollment, key, worker());
    await waitFor(() => h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === true, 'ready');
    const project = await h.runtime.projectService.create({ id: 'crash-project', displayName: 'Crash', agentMemberships: [{ agentId: 'scout' }] });
    await h.runtime.projectAccess.grant({ projectId: project.id, environmentInstanceId: INSTANCE_ID, selection: { kind: 'default' } });
    testComposition(h.runtime).workerGateway.liveFor(INSTANCE_ID)!.close();
    const store = h.runtime.stores.runReconnectRetries;
    await waitFor(async () => (await store.getGate(project.id))?.armed === true, 'armed');
    const delivery = await h.runtime.collaboration.deliver({
      scopeId: projectChannelScopeId(project.id), author: { id: 'operator', kind: 'human' },
      body: '@scout wait for reconnection', deliveryKey: 'crash-window', awaitReply: true,
    });
    originalId = delivery.admittedRunIds[0]!;
    assert.equal((await h.runtime.orchestrator.load(originalId))?.status, 'failed');

    // An injected SQLite failure occurs *after* trigger insertion and retry
    // inserts, at gate disarm. A process crash at the same boundary has the
    // identical SQLite rollback outcome (no partial commit).
    const injector = new DatabaseSync(path);
    injector.exec(`CREATE TRIGGER fail_disarm BEFORE UPDATE OF armed ON run_reconnect_gates
      WHEN NEW.armed = 0 BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`);
    injector.close();
    await h.connect(enrollment, key, worker());
    await waitFor(() => h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === true, 'reaccepted');
    await assert.rejects(() => h.runtime.reconcile(), /simulated crash/);
    assert.equal((await store.getGate(project.id))?.armed, true, 'rollback kept gate armed');
    assert.deepEqual(await store.listRetries(), []);
    assert.deepEqual(await store.listUnsettledTriggers(), []);
  } finally { await h.close(); }

  const injector = new DatabaseSync(path);
  injector.exec('DROP TRIGGER fail_disarm');
  injector.close();
  const reopened = await readinessWorkflowHarness({ backend: 'sqlite', directory, reopen: true });
  try {
    const store = reopened.runtime.stores.runReconnectRetries;
    assert.equal((await store.getGate('crash-project'))?.armed, true);
    assert.deepEqual(await store.listRetries(), []);
    const enrollment = (await reopened.runtime.enrollments.list())[0]!.id;
    await reopened.connect(enrollment, join(directory, 'worker-key.pem'), worker());
    await waitFor(async () => (await store.listRetries()).length === 1, 'one retry row');
    const row = (await store.listRetries())[0]!;
    assert.equal(row.originalRunId, originalId!);
    await reopened.runtime.reconcile();
    assert.equal((await store.listRetries()).length, 1);
    const db = new DatabaseSync(path);
    const count = db.prepare('SELECT count(*) AS n FROM run_reconnect_triggers WHERE project_id = ?').get('crash-project') as { n: number };
    assert.equal(count.n, 1, 'a single trigger committed across the crash window');
    db.close();
  } finally { await reopened.close(); }
});
