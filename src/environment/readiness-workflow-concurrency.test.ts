import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentReadinessWorkflow } from './readiness-workflow.ts';
import type { EnvironmentEnrollmentService } from './enrollment-service.ts';
import type { ReadinessLiveGateway } from './readiness-workflow.ts';

for (const failure of [false, true]) {
  test(`bootstrap observers share catalog settlement ${failure ? 'including persistence failure' : 'after receipt commit'}`, async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    let receipt = false;
    let projected = false;
    let writes = 0;
    const authority = { connectionId: 'conn', isCurrent: () => true };
    const ticket = { observationId: 'observation', sequence: 1, requirements: { requiredModels: [] } };
    const enrollments = {
      get: async () => ({ id: 'enroll', environmentInstanceId: 'env', status: 'approved' }),
      issueReadinessAttempt: async () => ticket,
      getReceipt: async () => receipt ? { observationId: ticket.observationId } : undefined,
      readiness: async () => ({ currentObservation: undefined }),
      recordReadinessObservation: async () => {
        writes++;
        if (failure) {
          reached();
          await gate;
          throw new Error('persistence failed');
        }
        receipt = true;
        return { observationId: ticket.observationId };
      },
    } as unknown as EnvironmentEnrollmentService;
    const gateway = {
      liveFor: () => ({ enrollment: { id: 'enroll' }, epoch: { connectionId: 'conn', epoch: 1 }, requiredModels: [] }),
      authorizeObservation: () => authority,
    } as unknown as ReadinessLiveGateway;
    const workflow = new EnvironmentReadinessWorkflow({
      enrollments, workerGateway: gateway,
      environment: { info: async () => ({ readiness: {
        protocolVersion: '3', engines: [], probe: { at: 100, latencyMs: 1, protocolOk: true, enginesOk: true, source: 'worker', version: '3', summary: 'ready' },
      } }) as never },
      refreshEnvironmentCatalog: async () => {
        reached();
        await gate;
        projected = true;
      },
    });
    const acceptance = { enrollment: { id: 'enroll', environmentInstanceId: 'env' },
      epoch: { connectionId: 'conn', epoch: 1 }, requiredModels: [] };
    const leader = workflow.observeAccepted(acceptance);
    await entered;
    let waiterSettled = false;
    const waiter = workflow.observeAccepted(acceptance).then(
      () => { waiterSettled = true; },
      (error: unknown) => { waiterSettled = true; throw error; },
    );
    try {
      // Allow the second observer's enrollment/attempt/receipt awaits to run.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      assert.equal(waiterSettled, false, 'waiter must not finish before the leader settles');
    } finally {
      release();
    }
    if (failure) {
      await assert.rejects(leader, /persistence failed/);
      await assert.rejects(waiter, /persistence failed/);
    } else {
      await Promise.all([leader, waiter]);
      assert.equal(projected, true);
    }
    assert.equal(writes, 1);
  });
}
