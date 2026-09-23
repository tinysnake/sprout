/**
 * The browser-requested Worker readiness probe (#118, ADR-0013).
 *
 * A browser may ask for a probe, but it may never supply facts. This Module is
 * the one production implementation of that request: it resolves the live
 * accepted Worker epoch, asks the Worker over the already-authenticated channel,
 * records the result under that exact epoch, and refuses to return anything once
 * a revoke/reset/disconnect has crossed the request (R118-EPOCH-001).
 *
 * It owns no transport and no store: the gateway, the epoch registry, and the
 * enrollment service arrive as explicit dependencies, so the same logic runs in
 * production and in an API-level integration test with a real accepted Worker
 * connection.
 */

import type { EnvironmentEnrollmentService } from '../environment/enrollment-service.ts';
import { EnrollmentError } from '../environment/enrollment.ts';
import type { ProbeResultFact } from '../environment/readiness.ts';
import type { WorkerConnectionRegistry } from '../environment/worker-epoch.ts';
import type { RuntimeEnvironment } from '../runtime.ts';
import type { WorkerGateway } from './gateway.ts';
import type { WorkerReadinessProbeResult } from './protocol.ts';
import { validateWorkerReadinessProbeResult } from './readiness-ingress.ts';

export interface WorkerProbeRequesterOptions {
  readonly enrollments: EnvironmentEnrollmentService;
  readonly workerGateway: WorkerGateway;
  readonly workerEpochs: WorkerConnectionRegistry;
  readonly environment: RuntimeEnvironment;
  /** Re-project the catalog after a successful observation. */
  readonly refreshEnvironmentCatalog: () => Promise<unknown>;
}

/**
 * Build the browser-triggered probe requester.
 *
 * The returned function throws on pending/revoked/reset/offline/superseded
 * states rather than reporting a stale probe, so the HTTP layer maps every
 * refusal to a non-success response.
 */
export function createWorkerProbeRequester(
  options: WorkerProbeRequesterOptions,
): (enrollmentId: string) => Promise<ProbeResultFact> {
  const { enrollments, workerGateway, workerEpochs, environment } = options;
  return async (enrollmentId: string): Promise<ProbeResultFact> => {
    // Capture the lifecycle generation so the response can prove the enrollment
    // was still approved when it was produced, not just when it began.
    const lifecycleGeneration = enrollments.lifecycleAuthority.generation(enrollmentId);
    const enrollment = await enrollments.get(enrollmentId);
    if (enrollment === undefined) throw new EnrollmentError('unknown-enrollment', 'Unknown enrollment.');
    if (enrollment.status !== 'approved') {
      throw new EnrollmentError('not-approved', 'The Environment enrollment is not approved.');
    }
    const live = workerGateway.liveFor(enrollment.environmentInstanceId);
    if (live === undefined) throw new Error('the Environment Worker is offline');
    const isCurrent = (): boolean =>
      enrollments.lifecycleAuthority.generation(enrollment.id) === lifecycleGeneration &&
      workerEpochs.isCurrent(enrollment.id, live.epoch.connectionId) &&
      workerGateway.liveFor(enrollment.environmentInstanceId)?.epoch.connectionId === live.epoch.connectionId;
    if (!isCurrent()) throw new Error('the Environment Worker is offline');
    const rawResult = await environment.probeReadiness?.(enrollment.environmentInstanceId);
    if (rawResult === undefined) throw new Error('the Environment Worker is offline');
    const result = validateWorkerReadinessProbeResult(rawResult);
    if (result === undefined) {
      throw new Error('the Environment Worker returned an invalid readiness probe result');
    }
    const recorded = await enrollments.observeReadiness(enrollmentId, result, {
      enrollmentId,
      connectionEpoch: live.epoch.epoch,
      isCurrent,
    });
    if (!recorded || !isCurrent()) {
      throw new Error('the readiness probe result belongs to a superseded Worker connection epoch');
    }
    await options.refreshEnvironmentCatalog();
    // Read back the durable, ingress-sanitized fact. The Worker result itself
    // is untrusted runtime JSON-RPC input; returning it would allow a response
    // that was never committed or whose privacy reduction differs from GET.
    const committed = (await enrollments.readiness(enrollmentId)).probes
      .filter((probe) =>
        probe.enrollmentId === enrollmentId &&
        probe.connectionEpoch === live.epoch.epoch &&
        sameProbe(probe, result.probe),
      )
      .at(-1);
    // Final authority check after the catalog refresh: a revoke/reset can land
    // inside that await, and a response must never carry a probe from an epoch
    // the lifecycle has since invalidated (R118-EPOCH-001).
    if (!isCurrent() || committed === undefined) {
      throw new Error('the readiness probe result belongs to a superseded Worker connection epoch');
    }
    return committed;
  };
}

function sameProbe(left: WorkerReadinessProbeResult['probe'] | ProbeResultFact, right: WorkerReadinessProbeResult['probe']): boolean {
  return left.at === right.at &&
    left.latencyMs === right.latencyMs &&
    left.protocolOk === right.protocolOk &&
    left.enginesOk === right.enginesOk &&
    left.source === right.source &&
    left.version === right.version &&
    left.summary === right.summary;
}
