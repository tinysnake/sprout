import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canAutoResolve,
  deriveUnresolvedFacts,
  FORCE_RELEASE_CONFIRMATION,
  phaseAfterEvidence,
  phaseAfterReconnect,
  validateForceRelease,
  workSafetyFromRecovery,
  UNRESOLVED_FACT_ENGINE_SESSION,
  UNRESOLVED_FACT_SETTLEMENT,
  UNRESOLVED_FACT_TASK_CONTEXT,
  UNRESOLVED_FACT_WORKER_OFFLINE,
  type RetainedEvidence,
} from './recovery.ts';

const cleanEvidence: RetainedEvidence = {
  retainedEventCount: 3,
  turnSettlementObserved: true,
  engineSessionStopped: true,
  taskContextRecycled: true,
};

test('a reconnect alone is not proof and never resolves an Environment', () => {
  assert.equal(phaseAfterReconnect(), 'reconciling');
  assert.notEqual(phaseAfterReconnect(), 'resolved');
});

test('an interrupted run always requires a Human decision, even with clean evidence', () => {
  assert.equal(
    phaseAfterEvidence({ hadActiveRun: true, holderKind: 'task', evidence: cleanEvidence }),
    'recovery',
  );
  assert.equal(
    phaseAfterEvidence({ hadActiveRun: true, holderKind: 'run', evidence: cleanEvidence }),
    'recovery',
  );
  assert.equal(canAutoResolve({ hadActiveRun: true, holderKind: 'run', evidence: cleanEvidence }), false);
});

test('an idle restart with proven engine stop and recycled Task context may return to clear', () => {
  assert.equal(
    phaseAfterEvidence({ hadActiveRun: false, holderKind: 'task', evidence: cleanEvidence }),
    'resolved',
  );
  assert.equal(canAutoResolve({ hadActiveRun: false, holderKind: 'task', evidence: cleanEvidence }), true);
});

test('an unproven engine stop or unrecycled Task context keeps the record in recovery', () => {
  assert.equal(
    phaseAfterEvidence({
      hadActiveRun: false,
      holderKind: 'task',
      evidence: { ...cleanEvidence, engineSessionStopped: false },
    }),
    'recovery',
  );
  assert.equal(
    phaseAfterEvidence({
      hadActiveRun: false,
      holderKind: 'task',
      evidence: { ...cleanEvidence, taskContextRecycled: false },
    }),
    'recovery',
  );
});

test('unresolved facts are derived deterministically from retained evidence', () => {
  assert.deepEqual(deriveUnresolvedFacts({ holderKind: 'task', evidenceSynchronized: false }), [
    UNRESOLVED_FACT_WORKER_OFFLINE,
  ]);
  assert.deepEqual(
    deriveUnresolvedFacts({ holderKind: 'task', evidenceSynchronized: true, evidence: cleanEvidence }),
    [],
  );
  assert.deepEqual(
    deriveUnresolvedFacts({
      holderKind: 'task',
      evidenceSynchronized: true,
      evidence: { ...cleanEvidence, engineSessionStopped: false, taskContextRecycled: false },
    }),
    [UNRESOLVED_FACT_ENGINE_SESSION, UNRESOLVED_FACT_TASK_CONTEXT],
  );
  assert.deepEqual(
    deriveUnresolvedFacts({
      holderKind: 'task',
      evidenceSynchronized: true,
      evidence: { ...cleanEvidence, turnSettlementObserved: false },
    }),
    [UNRESOLVED_FACT_SETTLEMENT],
  );
  // A run-held lease has no Task context, so that fact is not fabricated.
  assert.deepEqual(
    deriveUnresolvedFacts({
      holderKind: 'run',
      evidenceSynchronized: true,
      evidence: { ...cleanEvidence, taskContextRecycled: false },
    }),
    [],
  );
});

test('Force Release is refused unless it is in recovery with facts and full acknowledgement', () => {
  const valid = {
    phase: 'recovery' as const,
    unresolvedFacts: [UNRESOLVED_FACT_WORKER_OFFLINE],
    acknowledgedRisks: true,
    typedConfirmation: FORCE_RELEASE_CONFIRMATION,
    reason: 'host kernel panic',
  };
  assert.deepEqual(validateForceRelease(valid), { ok: true });

  // A `reconciling` record is still synchronizing evidence, so the override is
  // refused: the ordinary path has not been exhausted.
  assert.equal(
    validateForceRelease({ ...valid, phase: 'reconciling' }).ok,
    false,
  );
  assert.equal(
    (validateForceRelease({ ...valid, phase: 'reconciling' }) as { code: string }).code,
    'not-in-recovery',
  );
  assert.equal(validateForceRelease({ ...valid, phase: 'resolved' }).ok, false);
  assert.equal(validateForceRelease({ ...valid, unresolvedFacts: [] }).ok, false);
  assert.equal(
    (validateForceRelease({ ...valid, unresolvedFacts: [] }) as { code: string }).code,
    'no-unresolved-facts',
  );
  assert.equal(validateForceRelease({ ...valid, acknowledgedRisks: false }).ok, false);
  assert.equal(validateForceRelease({ ...valid, typedConfirmation: 'force release' }).ok, false);
  assert.equal(validateForceRelease({ ...valid, typedConfirmation: 'FORCE' }).ok, false);
  assert.equal(validateForceRelease({ ...valid, reason: '   ' }).ok, false);
});

test('work safety keeps clear, reconciling, and recovery distinct and a record outranks a stale lease', () => {
  // A lease that merely looks active cannot make a protected Environment safe.
  assert.equal(
    workSafetyFromRecovery([], [{ instanceId: 'env-1', state: 'active' }], 'env-1'),
    'held',
  );
  assert.equal(
    workSafetyFromRecovery(
      [{ environmentInstanceId: 'env-1', phase: 'reconciling' }],
      [{ instanceId: 'env-1', state: 'active' }],
      'env-1',
    ),
    'reconciling',
  );
  assert.equal(
    workSafetyFromRecovery(
      [{ environmentInstanceId: 'env-1', phase: 'recovery' }],
      [{ instanceId: 'env-1', state: 'active' }],
      'env-1',
    ),
    'recovery',
  );
  // A resolved record is history, not a protection.
  assert.equal(
    workSafetyFromRecovery(
      [{ environmentInstanceId: 'env-1', phase: 'resolved' }],
      [],
      'env-1',
    ),
    'clear',
  );
  assert.equal(workSafetyFromRecovery([], [], 'env-1'), 'clear');
});
