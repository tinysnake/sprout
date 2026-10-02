import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import { INSTANCE_ID, readinessWorkflowHarness, scriptedStartupReadiness, testComposition, waitFor } from './runtime-test-harness.ts';
import { WorkerRecoveryJournal } from './worker/recovery-journal.ts';
import { SqliteStore } from './store/db.ts';

test('authenticated reconnect replays only retained evidence, not the interrupted Task run', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-e5-reconnect-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const h = await readinessWorkflowHarness({ backend: 'sqlite', directory: dir, engineId: 'scripted' });
  let recoveredRunId = '';
  try {
    const id = (await h.runtime.enrollments.list())[0]!.id;
    const key = join(dir, 'worker-key.pem');
    const path = join(dir, 'worker-recovery.json');
    const slow = new ScriptedEngineAdapter({ turns: [{
      events: [{ type: 'notice', text: 'already destined for Sprout' }],
      result: { status: 'completed', text: 'not replayed' }, settleAfterMs: 60_000,
    }] });
    const first = await h.connect(id, key, {
      engines: new Map([['scripted', slow]]), readiness: scriptedStartupReadiness,
      recoveryJournal: new WorkerRecoveryJournal(path, 1),
    });
    await waitFor(() => h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === true, 'eligible Worker');
    const project = await h.runtime.projectService.create({ id: 'e5-project', displayName: 'Project', goal: 'Test',
      agentMemberships: [{ agentId: 'scout' }] });
    await h.runtime.projectAccess.grant({ projectId: project.id, environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'default' } });
    const task = await h.runtime.tasks.create({ projectId: project.id, title: 'Task', goal: 'Test', assignedAgentId: 'scout' });
    const begun = await h.runtime.tasks.begin(task.id);
    const { runId } = await h.runtime.tasks.advance(task.id, { prompt: 'one turn' });
    recoveredRunId = runId;
    await waitFor(() => slow.sessions[0]?.prompts.length === 1, 'scripted turn started');
    assert.doesNotMatch(readFileSync(path, 'utf8'), /one turn|worker-key|synthetic\/project-root/,
      'journal has only delivery facts, never prompt, credential path or host workspace');
    const stale = testComposition(h.runtime).workerGateway.liveFor(INSTANCE_ID)!;
    stale.close();
    await waitFor(async () => (await h.runtime.recovery.forLease(begun.environmentLeaseId!)) !== undefined,
      'protected Task recovery');
    await waitFor(() => (JSON.parse(readFileSync(path, 'utf8')) as { engineStopped: boolean }).engineStopped,
      'Worker fenced engine on channel loss');
    const next = await h.connect(id, key, { engines: new Map([['scripted', new ScriptedEngineAdapter({
      turns: [{ events: [], result: { status: 'completed', text: 'must not execute' } }],
    })]]), readiness: scriptedStartupReadiness, recoveryJournal: new WorkerRecoveryJournal(path, first.epoch + 1) });
    assert.ok(next.epoch > first.epoch);
    await assert.rejects(stale.transport.request('recovery/acknowledge', {
      epoch: first.epoch, turnId: 'stale', sequence: 0, settlement: true,
    }), 'superseded Worker connection cannot acknowledge evidence');
    await waitFor(async () => (await h.runtime.recovery.forLease(begun.environmentLeaseId!))?.evidence?.turnSettlementObserved === true,
      'retained Worker settlement synchronized');
    const recovered = (await h.runtime.recovery.forLease(begun.environmentLeaseId!))!;
    assert.equal(recovered.enrollmentId, id);
    assert.ok(recovered.workerIdentityDigest, 'lost lease is pinned to the authenticated host identity');
    assert.equal(recovered.runId, runId);
    assert.equal(recovered.evidence?.terminalStatus, 'interrupted', String(JSON.stringify(recovered.evidence)));
    assert.equal(recovered.evidence?.engineSessionStopped, true);
    assert.equal(recovered.evidence?.taskContextPrepared, true);
    assert.equal(recovered.evidence?.turnSettlementObserved, true);
    assert.deepEqual((await h.runtime.orchestrator.load(runId))?.recoverySettlement,
      { status: 'interrupted', eventCount: 1 });
    assert.equal((await h.runtime.orchestrator.load(runId))?.recoveredEvents?.[0]?.sequence, 1);
    await waitFor(async () => (await h.runtime.stores.recovery.workerRunEvents?.(id, runId))?.length === 0,
      'recovered payload pruned after run projection and settlement ack');
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { turns: readonly unknown[] }).turns.length, 0);
    // A duplicate wire notification after ack is at-least-once delivery, not a
    // new turn or a second Human decision. SQLite metadata remains idempotent.
    const duplicateFrame = `${JSON.stringify({ jsonrpc: '2.0', method: 'recovery/changed' })}\n`;
    next.stream.write(duplicateFrame);
    next.stream.write(duplicateFrame);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal((await h.runtime.stores.recovery.workerRunReceipt?.(id, runId))?.pending, false);
    assert.equal((await h.runtime.orchestrator.load(runId))?.recoveredEvents?.length, 1);
    assert.equal(h.runtime.pool.getLease(begun.environmentLeaseId!)?.state, 'recovering');
    const resumed = await fetch(`${h.base}/api/tasks/${task.id}/recovery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: h.cookie, 'x-sprout-csrf': h.csrf },
      body: JSON.stringify({ action: 'resume', reason: 'Human resumes synchronized Task recovery' }),
    });
    assert.equal(resumed.status, 200);
    assert.equal((await h.runtime.recovery.listForEnvironment(INSTANCE_ID))
      .find(record => record.leaseId === begun.environmentLeaseId)?.phase, 'resolved',
    'the Task control resolves the Environment recovery record with the held lease');
    assert.equal((await h.runtime.tasks.get(task.id))?.environmentLifecycleState, 'blocked');
    assert.equal(h.runtime.pool.getLease(begun.environmentLeaseId!)?.state, 'active');
    assert.equal(slow.sessions[0]?.prompts.length, 1, 'no turn replay');
  } finally { await h.close(); }
  const reopened = new SqliteStore({ filename: join(dir, 'sprout.db') });
  try {
    assert.deepEqual((await reopened.runs.get(recoveredRunId))?.recoverySettlement,
      { status: 'interrupted', eventCount: 1 }, 'recovered outcome survives SQLite reopen');
  } finally { reopened.close(); }
});

test('SQLite reopen restores an idle Task only after the same Worker proves its held context', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-e5-idle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = join(dir, 'worker-key.pem');
  const path = join(dir, 'worker-recovery.json');
  const first = await readinessWorkflowHarness({ backend: 'sqlite', directory: dir, engineId: 'scripted' });
  let taskId: string;
  let leaseId: string;
  let enrollmentId: string;
  let lastEpoch: number;
  try {
    enrollmentId = (await first.runtime.enrollments.list())[0]!.id;
    const initial = await first.connect(enrollmentId, key, { engines: new Map([['scripted', new ScriptedEngineAdapter({
      turns: [{ events: [], result: { status: 'completed', text: '' } }],
    })]]), readiness: scriptedStartupReadiness, recoveryJournal: new WorkerRecoveryJournal(path, 1) });
    await waitFor(() => first.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === true, 'idle Worker eligible');
    const project = await first.runtime.projectService.create({ id: 'idle-project', displayName: 'Project', goal: 'Test',
      agentMemberships: [{ agentId: 'scout' }] });
    await first.runtime.projectAccess.grant({ projectId: project.id, environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'default' } });
    const task = await first.runtime.tasks.create({ projectId: project.id, title: 'Idle', goal: 'Test', assignedAgentId: 'scout' });
    const begun = await first.runtime.tasks.begin(task.id);
    taskId = task.id;
    leaseId = begun.environmentLeaseId!;
    assert.equal((await first.runtime.tasks.get(taskId))?.environmentLifecycleState, 'idle');
    testComposition(first.runtime).workerGateway.liveFor(INSTANCE_ID)!.close();
    await waitFor(async () => (await first.runtime.recovery.forLease(leaseId)) !== undefined,
      'idle Task protected on channel loss');
    assert.equal(first.runtime.pool.getLease(leaseId)?.state, 'recovering');
    const sameProcess = await first.connect(enrollmentId, key, { engines: new Map([['scripted', new ScriptedEngineAdapter({
      turns: [{ events: [], result: { status: 'completed', text: '' } }],
    })]]), readiness: scriptedStartupReadiness,
    recoveryJournal: new WorkerRecoveryJournal(path, initial.epoch + 1) });
    lastEpoch = sameProcess.epoch;
    await waitFor(async () => (await first.runtime.recovery.listForEnvironment(INSTANCE_ID))
      .some((record) => record.leaseId === leaseId && record.phase === 'resolved'), 'same-process idle proof');
    assert.equal((await first.runtime.tasks.get(taskId))?.environmentLifecycleState, 'idle');
    assert.equal(first.runtime.pool.getLease(leaseId)?.state, 'active', 'same-process idle reconnect restores held lease');
  } finally { await first.close(); }

  const second = await readinessWorkflowHarness({ backend: 'sqlite', directory: dir, engineId: 'scripted', reopen: true });
  try {
    await second.runtime.reconcile();
    assert.equal(second.runtime.pool.getLease(leaseId)?.state, 'recovering');
    const pending = (await second.runtime.recovery.forLease(leaseId))!;
    assert.equal(pending.interruptedRunActive, false);
    await second.connect(enrollmentId, key, { engines: new Map([['scripted', new ScriptedEngineAdapter({
      turns: [{ events: [], result: { status: 'completed', text: '' } }],
    })]]), readiness: scriptedStartupReadiness, recoveryJournal: new WorkerRecoveryJournal(path, lastEpoch + 1) });
    try {
      await waitFor(async () => (await second.runtime.recovery.forLease(leaseId)) === undefined &&
        second.runtime.pool.getLease(leaseId)?.state === 'active', 'idle context proof');
    } catch {
      const record = await second.runtime.recovery.forLease(leaseId);
      const task = await second.runtime.tasks.get(taskId);
      throw new Error(`idle proof unresolved: ${JSON.stringify({ phase: record?.phase, evidence: record?.evidence,
        taskState: task?.environmentLifecycleState, priorState: task?.recoveryState,
        leaseState: second.runtime.pool.getLease(leaseId)?.state,
        projectPresent: second.runtime.projects.get('idle-project') !== undefined,
        contextReceipt: await second.runtime.stores.recovery.workerContext?.(enrollmentId, taskId),
        journalContext: (JSON.parse(readFileSync(path, 'utf8')) as { taskContexts: Record<string, string> }).taskContexts[taskId] })}`);
    }
    assert.equal(second.runtime.pool.getLease(leaseId)?.state, 'active', 'SQLite reopen restores held lease');
    assert.equal((await second.runtime.tasks.get(taskId))?.environmentLifecycleState, 'idle');
  } finally { await second.close(); }
});

test('a recycled Task context cannot authorize ordinary recovery even when workspace files remain', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-e5-recycled-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const h = await readinessWorkflowHarness({ backend: 'sqlite', directory: dir, engineId: 'scripted' });
  try {
    const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
    const key = join(dir, 'worker-key.pem');
    const path = join(dir, 'worker-recovery.json');
    const first = await h.connect(enrollmentId, key, { engines: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
      readiness: scriptedStartupReadiness, recoveryJournal: new WorkerRecoveryJournal(path, 1) });
    await waitFor(() => h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === true, 'eligible Worker');
    const project = await h.runtime.projectService.create({ id: 'recycled-project', displayName: 'Project', goal: 'Test',
      agentMemberships: [{ agentId: 'scout' }] });
    await h.runtime.projectAccess.grant({ projectId: project.id, environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'default' } });
    const task = await h.runtime.tasks.create({ projectId: project.id, title: 'Held', goal: 'Test', assignedAgentId: 'scout' });
    const begun = await h.runtime.tasks.begin(task.id);
    testComposition(h.runtime).workerGateway.liveFor(INSTANCE_ID)!.close();
    await waitFor(async () => (await h.runtime.recovery.forLease(begun.environmentLeaseId!)) !== undefined, 'protected lease');
    const nextJournal = new WorkerRecoveryJournal(path, first.epoch + 1);
    nextJournal.context(task.id, 'recycled');
    await h.connect(enrollmentId, key, { engines: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
      readiness: scriptedStartupReadiness, recoveryJournal: nextJournal });
    await waitFor(async () => (await h.runtime.recovery.forLease(begun.environmentLeaseId!))?.evidence?.taskContextRecycled === true,
      'recycled fact synchronized');
    const recovery = (await h.runtime.recovery.forLease(begun.environmentLeaseId!))!;
    assert.equal(recovery.evidence?.taskContextPrepared, false);
    assert.equal(h.runtime.pool.getLease(begun.environmentLeaseId!)?.state, 'recovering');
    const refused = await fetch(`${h.base}/api/tasks/${task.id}/recovery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: h.cookie, 'x-sprout-csrf': h.csrf },
      body: JSON.stringify({ action: 'resume', reason: 'Unsafe context cannot resume' }),
    });
    assert.equal(refused.status, 409);
    assert.match((await refused.json() as { error: string }).error, /safe held context/);
    assert.equal(h.runtime.pool.getLease(begun.environmentLeaseId!)?.state, 'recovering');
  } finally { await h.close(); }
});
