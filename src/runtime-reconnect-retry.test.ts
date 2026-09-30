import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScriptedEngineAdapter } from './engine/scripted.ts';
import { projectChannelScopeId } from './conversation/model.ts';
import {
  INSTANCE_ID,
  readinessWorkflowHarness,
  scriptedStartupReadiness,
  scriptedTurn,
  testComposition,
  waitFor,
} from './runtime-test-harness.ts';

const PROJECT_ID = 'retry-project';

test('a fully disconnected Project re-admits its failed run on the first reconnect, once, with a linked reply', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-reconnect-retry-e2e-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const h = await readinessWorkflowHarness({ backend: 'memory', directory });
  try {
    const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
    const keyPath = join(directory, 'worker-key.pem');

    // Connect first: a workspace grant validates its selection against the
    // live Environment Worker.
    const firstAdapter = new ScriptedEngineAdapter({ turns: [scriptedTurn('baseline reply')] });
    await h.connect(enrollmentId, keyPath, {
      engines: new Map([['scripted', firstAdapter]]),
      readiness: scriptedStartupReadiness,
    });
    await waitFor(
      () => h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === true,
      'eligible Worker before baseline',
    );

    // The Project the runs belong to, with a granted workspace so a one-round
    // run resolves its working directory through the same access record the
    // production path uses.
    const project = await h.runtime.projectService.create({
      id: PROJECT_ID,
      displayName: 'Bounded Retry',
      goal: 'Prove the bounded reconnect retry end to end.',
      agentMemberships: [{ agentId: 'scout' }],
    });
    await h.runtime.projectAccess.grant({
      projectId: project.id,
      environmentInstanceId: INSTANCE_ID,
      selection: { kind: 'default' },
    });
    const scopeId = projectChannelScopeId(project.id);

    // Baseline: an ordinary addressed Message runs and projects its reply.
    const baseline = await h.runtime.collaboration.deliver({
      scopeId,
      author: { id: 'operator', kind: 'human' },
      body: '@scout please answer',
      deliveryKey: 'retry-e2e-baseline',
      awaitReply: true,
    });
    assert.equal(baseline.admittedRunIds.length, 1);
    const baselineRun = await h.runtime.orchestrator.load(baseline.admittedRunIds[0]!);
    assert.equal(baselineRun?.status, 'completed');

    // Full disconnect: the only granted Environment loses its connection, so
    // the Project's gate arms.
    testComposition(h.runtime).workerGateway.liveFor(INSTANCE_ID)!.close();
    const retryStore = h.runtime.stores.runReconnectRetries;
    await waitFor(
      async () => (await retryStore.getGate(project.id))?.armed === true,
      'full-disconnect gate armed',
    );

    // A Message while disconnected fails fast at admission — the owner's
    // preview failure — durably and without a reply.
    const failedDelivery = await h.runtime.collaboration.deliver({
      scopeId,
      author: { id: 'operator', kind: 'human' },
      body: '@scout this run has no environment',
      deliveryKey: 'retry-e2e-failure',
      awaitReply: true,
    });
    assert.equal(failedDelivery.admittedRunIds.length, 1);
    const failedRunId = failedDelivery.admittedRunIds[0]!;
    const failedRun = await h.runtime.orchestrator.load(failedRunId);
    assert.equal(failedRun?.status, 'failed');
    assert.equal(failedRun?.failure, 'no available environment for capability: agent-run');
    assert.equal(failedRun?.projectId, project.id, 'the failure names its Project');
    const beforeRetry = await h.runtime.collaboration.listMessages({ scopeId });
    assert.deepEqual(
      beforeRetry.filter((message) => message.author.kind === 'agent').map((message) => message.body),
      ['baseline reply'],
      'a failed run projects no reply',
    );

    // The first reconnect after the full disconnect: readiness re-establishes,
    // the armed gate is consumed, and the eligible run is retried once.
    const retryAdapter = new ScriptedEngineAdapter({
      turns: [scriptedTurn('reconnected reply')],
    });
    await h.connect(enrollmentId, keyPath, {
      engines: new Map([['scripted', retryAdapter]]),
      readiness: scriptedStartupReadiness,
    });
    await waitFor(
      () => h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible === true,
      'eligible Worker after reconnect',
    );
    await waitFor(async () => {
      const rows = await retryStore.listRetries();
      return rows.length === 1 && rows[0]?.state === 'settled';
    }, 'one bounded retry, settled');

    const row = (await retryStore.listRetries())[0]!;
    assert.equal(row.originalRunId, failedRunId, 'the retry row keys on the original run');

    // The linked retry has its own terminal state; the original keeps its own.
    const retryRun = await h.runtime.orchestrator.load(row.retryRunId!);
    assert.ok(retryRun, 'the linked run exists');
    assert.equal(retryRun.retryOfRunId, failedRunId);
    assert.equal(retryRun.projectId, project.id);
    assert.equal(retryRun.status, 'completed');
    assert.equal(
      retryRun.result?.status === 'completed' ? retryRun.result.text : undefined,
      'reconnected reply',
    );
    const originalAfter = await h.runtime.orchestrator.load(failedRunId);
    assert.equal(originalAfter?.status, 'failed');
    assert.equal(originalAfter?.failure, 'no available environment for capability: agent-run');

    // The wake's reply is projected exactly once, through the wake's own
    // delivery key: the operator gets the answer without re-sending.
    const afterRetry = await h.runtime.collaboration.listMessages({ scopeId });
    assert.deepEqual(
      afterRetry.filter((message) => message.author.kind === 'agent').map((message) => message.body),
      ['baseline reply', 'reconnected reply'],
    );

    // The gate was consumed by that one reconnect; a repeat pass never
    // dispatches a second retry.
    assert.equal((await retryStore.getGate(project.id))?.armed, false);
    const reconcile = await h.runtime.reconcile();
    assert.deepEqual(reconcile.reconnectRetries.dispatchedRetryRunIds, []);
    assert.deepEqual(reconcile.reconnectRetries.queuedRunIds, []);
    assert.equal((await retryStore.listRetries()).length, 1);
  } finally {
    await h.close();
  }
});
