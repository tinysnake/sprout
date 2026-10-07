import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import { INSTANCE_ID, readinessWorkflowHarness, scriptedStartupReadiness, testComposition, waitFor } from './runtime-test-harness.ts';

const worker = () => ({ engines: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]), readiness: scriptedStartupReadiness });

test('SQLite grants and accepted connections: partial loss and grant addition cannot consume a gate', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'retry-durable-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const h = await readinessWorkflowHarness({ backend: 'sqlite', directory });
  try {
    const first = (await h.runtime.enrollments.list())[0]!.id;
    const secondId = 'additional-environment';
    const second = await h.enrollAdditional(secondId, join(directory, 'second-key.pem'));
    await h.connect(first, join(directory, 'worker-key.pem'), worker());
    await h.connect(second, join(directory, 'second-key.pem'), worker());
    await waitFor(() => h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === true &&
      h.runtime.environmentCatalog.entry(secondId)?.eligible === true, 'both accepted and ready');
    const project = await h.runtime.projectService.create({ id: 'durable-project', displayName: 'Durable', agentMemberships: [{ agentId: 'scout' }] });
    await h.runtime.projectAccess.grant({ projectId: project.id, environmentInstanceId: INSTANCE_ID, selection: { kind: 'default' } });
    await h.runtime.projectAccess.grant({ projectId: project.id, environmentInstanceId: secondId, selection: { kind: 'default' } });
    const store = h.runtime.stores.runReconnectRetries;
    testComposition(h.runtime).workerGateway.liveFor(secondId)!.close();
    await waitFor(() => h.runtime.workerGateway.liveFor(secondId) === undefined, 'second disconnected');
    assert.notEqual((await store.getGate(project.id))?.armed, true);
    await h.connect(second, join(directory, 'second-key.pem'), worker());
    await waitFor(() => h.runtime.environmentCatalog.entry(secondId)?.eligible === true, 'second reconnected');
    await h.runtime.reconcile();
    assert.notEqual((await store.getGate(project.id))?.armed, true);
    assert.deepEqual(await store.listRetries(), []);

    // An already-accepted second Environment is not a reconnect for a newly
    // armed Project. Granting it cannot consume the gate on later publications.
    testComposition(h.runtime).workerGateway.liveFor(INSTANCE_ID)!.close();
    // End the second grant first so the Project truly reaches full disconnect.
    await h.runtime.projectAccess.end({ projectId: project.id, environmentInstanceId: secondId, reason: 'test grant change' });
    await waitFor(async () => (await store.getGate(project.id))?.armed === true, 'full disconnect gate');
    await h.runtime.projectAccess.grant({ projectId: project.id, environmentInstanceId: secondId, selection: { kind: 'default' } });
    await h.runtime.refreshEnvironmentCatalog();
    await h.runtime.reconcile();
    assert.equal((await store.getGate(project.id))?.armed, true, 'grant addition cannot trigger');
    assert.deepEqual(await store.listRetries(), []);
  } finally { await h.close(); }

  const reopened = await readinessWorkflowHarness({ backend: 'sqlite', directory, reopen: true });
  try {
    assert.equal((await reopened.runtime.stores.runReconnectRetries.getGate('durable-project'))?.armed, true);
    assert.deepEqual(await reopened.runtime.stores.runReconnectRetries.listRetries(), []);
  } finally { await reopened.close(); }
});
