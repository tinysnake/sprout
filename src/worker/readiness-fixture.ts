import type { WorkerProbeFact, WorkerReadinessFacts, WorkerReadinessProbeResult } from './protocol.ts';

/** Synthetic Worker evidence for tests and offline diagnostic scripts only. */
export function workerReadinessProbeFixture(
  readiness: Omit<WorkerReadinessFacts, 'probe'>,
  overrides: Partial<WorkerProbeFact> = {},
): WorkerReadinessProbeResult {
  const probe: WorkerProbeFact = {
    at: readiness.observedAt ?? 1_000,
    latencyMs: 5,
    protocolOk: true,
    enginesOk: true,
    source: 'worker',
    version: 'unknown',
    summary: 'Synthetic Worker readiness probe.',
    ...overrides,
  };
  return { readiness: { ...readiness, probe }, probe };
}
