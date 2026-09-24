import type { ApiRequestContext, ApiRouter } from './router.ts';
import {
  ArchiveError,
} from '../environment/archive.ts';
import {
  EnrollmentError,
  type EnrollmentEngineFact,
} from '../environment/enrollment.ts';
import type { EnvironmentEnrollmentService } from '../environment/enrollment-service.ts';
import { ReadinessOutcomeError } from '../environment/readiness-workflow.ts';
import type { EnvironmentRecoveryService } from '../environment/recovery-service.ts';
import { EnvironmentRecoveryError } from '../environment/recovery-service.ts';
import type { RetainedEvidence } from '../environment/recovery.ts';
import type { WorkerIdentityProof } from '../environment/worker-proof.ts';
import type { EnvironmentArchivePort } from '../environment/archive.ts';
import type {
  CompatibilityFact,
  ConnectionFact,
  EngineReadinessFact,
  ReadinessProbeFact,
  ReadinessReceipt,
} from '../environment/readiness.ts';
import {
  toEnrollmentView,
  toEnvironmentReadinessView,
  toEnvironmentRecoveryView,
  toForceReleaseView,
  toProbeResultView,
  toReadinessReceiptView,
} from './views.ts';

/**
 * The Environment enrollment and readiness router (#87).
 *
 * A domain-owned route set composed through the #85 additive seam rather than a
 * central dispatcher. Every route delegates to the enrollment service, so the
 * Human-approval, duplicate-identity, revocation, reset, and readiness rules have
 * exactly one implementation and the transport keeps none.
 *
 * Privacy: no route accepts or returns a private key, engine credential,
 * hostname, address, topology, or absolute path. A Worker proves possession of
 * its host-generated private key with a signed challenge; only its public key's
 * digest is retained, and the wire contract never echoes the key or signature.
 */

export interface EnvironmentRouterOptions {
  readonly enrollments: EnvironmentEnrollmentService;
  /** Worker-hosted probe request. The browser never submits observation facts. */
  readonly requestProbe?: (enrollmentId: string) => Promise<ReadinessProbeFact | ReadinessReceipt>;
  /**
   * The Environment reconciliation and recovery capability (#88).
   *
   * Optional so the #87 enrollment/readiness contract remains usable on its own;
   * when present the recovery, ordinary-decision, and Force Release routes are
   * enabled and every one of them delegates to this service, so the safety rules
   * have exactly one implementation.
   */
  readonly recovery?: EnvironmentRecoveryService;
  /**
   * The archive/restore authority (ADR-0008, additive for #89).
   *
   * Optional so the #87/#88 contracts remain usable without it; when present
   * the archive and restore routes are enabled. The ADR-0008 safety rules
   * (no archive during active work; restore may reuse a valid enrollment) live
   * in the port's implementation, so this router stays a thin projection.
   */
  readonly archive?: EnvironmentArchivePort;
}

export function createEnvironmentRouter(options: EnvironmentRouterOptions): ApiRouter {
  const { enrollments, recovery, archive, requestProbe } = options;

  return {
    name: 'environment-enrollment',
    async handle(context: ApiRequestContext): Promise<boolean> {
      const { method, pathname, segments } = context;

      // POST /api/environments/enrollments — request a pending enrollment.
      //
      // A Human browser creates this without a Worker public key, host address,
      // or engine credential (#115). The response separates the public bootstrap
      // input from the short-lived, one-use claim secret, which is returned
      // exactly once and never echoed again.
      if (method === 'POST' && pathname === '/api/environments/enrollments') {
        const body = await context.readBody();
        const environmentInstanceId = stringField(body, 'environmentInstanceId');
        const displayName = stringField(body, 'displayName');
        const platform = stringField(body, 'platform');
        if (
          environmentInstanceId === undefined ||
          displayName === undefined ||
          platform === undefined
        ) {
          return json(context, 400, {
            error: 'environmentInstanceId, displayName, and platform are required',
          });
        }
        const capabilityRequests = stringArray(body, 'capabilityRequests');
        if (capabilityRequests === undefined) {
          return json(context, 400, { error: 'capabilityRequests must be an array of strings' });
        }
        const engines = parseEngineFacts(body['engines']);
        if (engines === 'invalid') {
          return json(context, 400, { error: 'engines must be an array of engine facts' });
        }
        const protocolVersion = stringField(body, 'protocolVersion');
        // A legacy or probe caller may pass an already-known public key, but Web
        // does not: the identity is bound only after a claim proves key
        // possession.
        const publicKey = stringField(body, 'publicKey');
        try {
          const result = await enrollments.requestEnrollment({
            environmentInstanceId,
            displayName,
            ...(publicKey !== undefined ? { publicKey } : {}),
            platform,
            ...(protocolVersion !== undefined ? { protocolVersion } : {}),
            capabilityRequests,
            engineFacts: engines,
          });
          return json(context, 201, {
            enrollment: toEnrollmentView(result.enrollment),
            bootstrap: result.bootstrap,
            ...(result.claim !== undefined
              ? { claim: { secret: result.claim.secret, expiresAt: result.claim.expiresAt } }
              : {}),
          });
        } catch (error) {
          return enrollmentFailure(context, error);
        }
      }

      // GET /api/environments/enrollments — list durable enrollments.
      if (method === 'GET' && pathname === '/api/environments/enrollments') {
        return json(context, 200, {
          enrollments: (await enrollments.list()).map(toEnrollmentView),
        });
      }

      // GET /api/environments/enrollments/:id — inspect one enrollment.
      if (
        method === 'GET' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments'
      ) {
        const enrollment = await enrollments.get(segments[3] ?? '');
        if (enrollment === undefined) return json(context, 404, { error: 'unknown enrollment' });
        return json(context, 200, { enrollment: toEnrollmentView(enrollment) });
      }

      // POST /api/environments/enrollments/:id/challenge — issue a proof nonce.
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments' &&
        segments[4] === 'challenge'
      ) {
        try {
          const challenge = await enrollments.issueChallenge(segments[3] ?? '');
          return json(context, 200, { challenge });
        } catch (error) {
          return enrollmentFailure(context, error);
        }
      }

      // POST /api/environments/enrollments/:id/connect — verified Worker identity.
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments' &&
        segments[4] === 'connect'
      ) {
        const body = await context.readBody();
        // A connection must prove possession of the Worker's private key: a bare
        // public key or digest is not proof and is refused. The proof is the
        // signed response to a challenge issued for this enrollment.
        const proof = parseWorkerProof(body['proof']);
        if (proof === 'invalid') {
          return json(context, 400, {
            error: 'proof with challengeId, publicKey, and signature is required',
          });
        }
        const connection = parseConnection(body['connection']);
        if (connection === 'invalid') {
          return json(context, 400, { error: 'connection must be a connection fact' });
        }
        const compatibility = parseCompatibility(body['compatibility']);
        if (compatibility === 'invalid') {
          return json(context, 400, { error: 'compatibility must be a compatibility fact' });
        }
        const engines = parseReadinessEngines(body['engines']);
        if (engines === 'invalid') {
          return json(context, 400, { error: 'engines must be an array of readiness facts' });
        }
        try {
          const outcome = await enrollments.connectWorker({
            enrollmentId: segments[3] ?? '',
            proof,
            connection,
            compatibility,
            engines,
          });
          return json(context, 200, {
            outcome: outcome.outcome,
            requiresHumanApproval: outcome.requiresHumanApproval,
            enrollment: toEnrollmentView(outcome.enrollment),
          });
        } catch (error) {
          return enrollmentFailure(context, error);
        }
      }

      // POST /api/environments/enrollments/:id/approve — one Human approval.
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments' &&
        segments[4] === 'approve'
      ) {
        const body = await context.readBody();
        const permissions = booleanRecord(body['capabilityPermissions']);
        if (permissions === 'invalid') {
          return json(context, 400, { error: 'capabilityPermissions must be a record of booleans' });
        }
        try {
          const result = await enrollments.approve(segments[3] ?? '', {
            capabilityPermissions: permissions,
          });
          return json(context, 200, { enrollment: toEnrollmentView(result.enrollment) });
        } catch (error) {
          return enrollmentFailure(context, error);
        }
      }

      // POST /api/environments/enrollments/:id/revoke
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments' &&
        segments[4] === 'revoke'
      ) {
        const body = await context.readBody();
        try {
          const revoked = await enrollments.revoke(segments[3] ?? '', stringField(body, 'reason') ?? '');
          return json(context, 200, { enrollment: toEnrollmentView(revoked) });
        } catch (error) {
          return enrollmentFailure(context, error);
        }
      }

      // POST /api/environments/enrollments/:id/reset — fresh identity reset.
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments' &&
        segments[4] === 'reset'
      ) {
        const body = await context.readBody();
        try {
          const reset = await enrollments.reset(segments[3] ?? '', stringField(body, 'reason') ?? '');
          return json(context, 200, { enrollment: toEnrollmentView(reset) });
        } catch (error) {
          return enrollmentFailure(context, error);
        }
      }

      // POST /api/environments/enrollments/:id/permissions — capability permission.
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments' &&
        segments[4] === 'permissions'
      ) {
        const body = await context.readBody();
        const capability = stringField(body, 'capability');
        const allowed = body['allowed'];
        if (capability === undefined || typeof allowed !== 'boolean') {
          return json(context, 400, { error: 'capability and boolean allowed are required' });
        }
        try {
          const updated = await enrollments.setCapabilityPermission(segments[3] ?? '', capability, allowed);
          return json(context, 200, { enrollment: toEnrollmentView(updated) });
        } catch (error) {
          return enrollmentFailure(context, error);
        }
      }

      // GET /api/environments/enrollments/:id/readiness — facts plus summary.
      if (
        method === 'GET' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments' &&
        segments[4] === 'readiness'
      ) {
        try {
          // Readiness, summary, and the current-epoch probe history come from
          // one authority snapshot, so a lifecycle decision crossing the read
          // cannot yield an approved body with differently-scoped probes.
          const assembled = await enrollments.readiness(segments[3] ?? '');
          const receiptView = toReadinessReceiptView(assembled.receipt);
          return json(context, 200, {
            readiness: toEnvironmentReadinessView({
              environmentInstanceId: assembled.enrollment.environmentInstanceId,
              readiness: assembled.readiness,
              summary: assembled.summary,
            }),
            probes: assembled.probes
              .map(toProbeResultView)
              .filter((probe) => probe !== undefined),
            ...(assembled.connectionAttempt !== undefined ? { connectionAttempt: {
              outcome: assembled.connectionAttempt.outcome,
              reason: assembled.connectionAttempt.reason,
              at: assembled.connectionAttempt.at,
            } } : {}),
            ...(receiptView !== undefined ? { receipt: receiptView } : {}),
          });
        } catch (error) {
          return enrollmentFailure(context, error);
        }
      }

      // GET /api/environments/enrollments/:id/receipts/:observationId — direct receipt query (#126).
      if (
        method === 'GET' &&
        segments.length === 6 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments' &&
        segments[4] === 'receipts'
      ) {
        try {
          const receipt = await enrollments.getReceipt(segments[3] ?? '', segments[5] ?? '');
          if (receipt === undefined) {
            return json(context, 404, { error: 'observation receipt not found' });
          }
          const receiptView = toReadinessReceiptView(receipt);
          if (receiptView === undefined) {
            return json(context, 404, { error: 'observation receipt not found' });
          }
          return json(context, 200, {
            receipt: receiptView,
            authorityCurrent: (await enrollments.readiness(segments[3] ?? '')).receipt?.observationId === receipt.observationId,
          });
        } catch (error) {
          return enrollmentFailure(context, error);
        }
      }

      // GET /api/environments/enrollments/:id/observations/:observationId — direct observation query (#126).
      if (
        method === 'GET' &&
        segments.length === 6 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments' &&
        segments[4] === 'observations'
      ) {
        try {
          const obs = await enrollments.getObservation(segments[3] ?? '', segments[5] ?? '');
          if (obs === undefined) {
            return json(context, 404, { error: 'observation not found' });
          }
          const receiptView = toReadinessReceiptView(obs.receipt);
          const probeView = toProbeResultView(obs.probe);
          return json(context, 200, {
            observation: {
              observationId: obs.observationId,
              environmentInstanceId: obs.environmentInstanceId,
              sequence: obs.sequence,
              committedAt: obs.committedAt,
              readiness: receiptView?.readiness,
              authorityScope: receiptView?.authorityScope,
              authorityCurrent: (await enrollments.readiness(segments[3] ?? '')).receipt?.observationId === obs.observationId,
              ...(receiptView !== undefined ? { receipt: receiptView } : {}),
              ...(probeView !== undefined ? { probe: probeView } : {}),
            },
          });
        } catch (error) {
          return enrollmentFailure(context, error);
        }
      }

      // POST /api/environments/enrollments/:id/probes — request a Worker probe.
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments' &&
        segments[4] === 'probes'
      ) {
        try {
          if (requestProbe !== undefined) {
            // Ignore the body entirely. A client can request a probe, but only
            // the authenticated Worker may supply its measured observations.
            const recorded = await requestProbe(segments[3] ?? '');
            const receipt = 'receipt' in recorded && recorded.receipt !== undefined
              ? (recorded.receipt as ReadinessReceipt)
              : ('observationId' in recorded && recorded.observationId !== undefined ? recorded as unknown as ReadinessReceipt : undefined);
            if (receipt?.observationId === undefined) return json(context, 503, { error: 'committed receipt unavailable' });
            const committed = await enrollments.getReceipt(segments[3] ?? '', receipt.observationId);
            if (committed === undefined) return json(context, 503, { error: 'committed receipt unavailable' });
            const receiptView = toReadinessReceiptView(committed);
            return json(context, 201, {
              probe: toProbeResultView(committed.probe),
              receipt: receiptView,
            });
          }
          return json(context, 503, { error: 'the Environment Worker probe is unavailable' });
        } catch (error) {
          return enrollmentFailure(context, error);
        }
      }

      // GET /api/environments/enrollments/:id/recovery — the open recovery record
      // plus the permanent Force Release history for this Environment (#88).
      if (
        method === 'GET' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments' &&
        segments[4] === 'recovery' &&
        recovery
      ) {
        try {
          const enrollment = await enrollments.get(segments[3] ?? '');
          if (enrollment === undefined) return json(context, 404, { error: 'unknown enrollment' });
          const records = await recovery.listForEnvironment(enrollment.environmentInstanceId);
          return json(context, 200, {
            recovery: records.map(toEnvironmentRecoveryView),
            forceReleases: (await recovery.forceReleaseHistory(enrollment.environmentInstanceId)).map(
              toForceReleaseView,
            ),
          });
        } catch (error) {
          return recoveryFailure(context, error);
        }
      }

      // POST /api/environments/enrollments/:id/archive — non-destructive archive
      // (ADR-0008). Bars new work; preserves enrollment, history, and decisions.
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments' &&
        segments[4] === 'archive' &&
        archive
      ) {
        try {
          const archived = await archive.archive(segments[3] ?? '');
          return json(context, 200, { enrollment: toEnrollmentView(archived) });
        } catch (error) {
          return archiveFailure(context, error);
        }
      }

      // POST /api/environments/enrollments/:id/restore — restore an archived
      // Environment; it may reuse its still-valid enrollment.
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments' &&
        segments[4] === 'restore' &&
        archive
      ) {
        try {
          const restored = await archive.restore(segments[3] ?? '');
          return json(context, 200, { enrollment: toEnrollmentView(restored) });
        } catch (error) {
          return archiveFailure(context, error);
        }
      }

      // POST /api/environments/recovery/:leaseId/reconnect — a verified same-identity
      // reconnect. Moves the record to `reconciling`; it never resolves it.
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'recovery' &&
        segments[4] === 'reconnect' &&
        recovery
      ) {
        const body = await context.readBody();
        const connection = parseConnection(body['connection']);
        if (connection === 'invalid') return json(context, 400, { error: 'connection must be a connection fact' });
        const compatibility = parseCompatibility(body['compatibility']);
        if (compatibility === 'invalid') {
          return json(context, 400, { error: 'compatibility must be a compatibility fact' });
        }
        const evidence = parseRetainedEvidence(body['evidence']);
        if (evidence === 'invalid') {
          return json(context, 400, { error: 'evidence must be a retained-evidence fact' });
        }
        try {
          const record = await recovery.observeReconnect(segments[3] ?? '', {
            enrollmentId: stringField(body, 'enrollmentId') ?? '',
            environmentInstanceId: stringField(body, 'environmentInstanceId') ?? '',
            identityVerified: body['identityVerified'] === true,
            protocolCompatible: body['protocolCompatible'] === true,
            permissionsAllowed: body['permissionsAllowed'] === true,
            hadActiveRun: body['hadActiveRun'] === true,
            ...(evidence !== undefined ? { evidence } : {}),
          });
          return json(context, 200, { recovery: toEnvironmentRecoveryView(record) });
        } catch (error) {
          return recoveryFailure(context, error);
        }
      }

      // POST /api/environments/recovery/:leaseId/evidence — synchronize retained
      // evidence. The only path that can resolve or reach `recovery`; no replay.
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'recovery' &&
        segments[4] === 'evidence' &&
        recovery
      ) {
        const body = await context.readBody();
        const evidence = parseRetainedEvidence(body['evidence']);
        if (evidence === 'invalid' || evidence === undefined) {
          return json(context, 400, { error: 'evidence must be a retained-evidence fact' });
        }
        try {
          const record = await recovery.synchronizeEvidence(segments[3] ?? '', {
            evidence,
            hadActiveRun: body['hadActiveRun'] === true,
          });
          return json(context, 200, { recovery: toEnvironmentRecoveryView(record) });
        } catch (error) {
          return recoveryFailure(context, error);
        }
      }

      // POST /api/environments/recovery/:leaseId/resume — ordinary Resume.
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'recovery' &&
        segments[4] === 'resume' &&
        recovery
      ) {
        const body = await context.readBody();
        try {
          const reason = stringField(body, 'reason');
          const record = await recovery.resume(segments[3] ?? '', {
            ...(reason !== undefined ? { reason } : {}),
          });
          return json(context, 200, { recovery: toEnvironmentRecoveryView(record) });
        } catch (error) {
          return recoveryFailure(context, error);
        }
      }

      // POST /api/environments/recovery/:leaseId/discard — ordinary safe Task end.
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'recovery' &&
        segments[4] === 'discard' &&
        recovery
      ) {
        const body = await context.readBody();
        try {
          const reason = stringField(body, 'reason');
          const record = await recovery.discard(segments[3] ?? '', {
            ...(reason !== undefined ? { reason } : {}),
          });
          return json(context, 200, { recovery: toEnvironmentRecoveryView(record) });
        } catch (error) {
          return recoveryFailure(context, error);
        }
      }

      // POST /api/environments/recovery/:leaseId/release — ordinary one-round release.
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'recovery' &&
        segments[4] === 'release' &&
        recovery
      ) {
        const body = await context.readBody();
        try {
          const reason = stringField(body, 'reason');
          const record = await recovery.release(segments[3] ?? '', {
            ...(reason !== undefined ? { reason } : {}),
          });
          return json(context, 200, { recovery: toEnvironmentRecoveryView(record) });
        } catch (error) {
          return recoveryFailure(context, error);
        }
      }

      // POST /api/environments/recovery/:leaseId/force-release — Human-only override.
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'recovery' &&
        segments[4] === 'force-release' &&
        recovery
      ) {
        const body = await context.readBody();
        const reason = stringField(body, 'reason');
        const typedConfirmation = stringField(body, 'typedConfirmation');
        if (reason === undefined || typedConfirmation === undefined) {
          return json(context, 400, { error: 'reason and typedConfirmation are required' });
        }
        try {
          const outcome = await recovery.forceRelease(segments[3] ?? '', {
            acknowledgedRisks: body['acknowledgedRisks'] === true,
            typedConfirmation,
            reason,
          });
          return json(context, 201, { forceRelease: toForceReleaseView(outcome) });
        } catch (error) {
          return recoveryFailure(context, error);
        }
      }

      return false;
    },
  };
}

function json(context: ApiRequestContext, status: number, payload: unknown): true {
  context.response.writeHead(status, { 'content-type': 'application/json' });
  context.response.end(JSON.stringify(payload));
  return true;
}

function enrollmentFailure(context: ApiRequestContext, error: unknown): true {
  if (error instanceof ReadinessOutcomeError && error.code !== undefined) {
    return json(context, 409, { error: error.message, code: error.code });
  }
  if (error instanceof EnrollmentError) {
    let status = 409;
    if (error.code === 'unknown-enrollment') status = 404;
    if (error.code === 'invalid-proof') status = 401;
    return json(context, status, { error: error.message, code: error.code });
  }
  return json(context, 500, { error: 'environment enrollment could not be completed' });
}

function archiveFailure(context: ApiRequestContext, error: unknown): true {
  if (error instanceof ArchiveError) {
    const status = error.code === 'unknown-enrollment' ? 404 : 409;
    return json(context, status, { error: error.message, code: error.code });
  }
  return json(context, 500, { error: 'environment archive could not be completed' });
}

function recoveryFailure(context: ApiRequestContext, error: unknown): true {
  if (error instanceof EnvironmentRecoveryError) {
    const status = error.code === 'unknown-recovery' || error.code === 'unknown-lease' ? 404 : 409;
    return json(context, status, { error: error.message, code: error.code });
  }
  if (error instanceof EnrollmentError) return enrollmentFailure(context, error);
  return json(context, 500, { error: 'environment recovery could not be completed' });
}

/**
 * Parse retained evidence.
 *
 * Every field is a positive boolean or a bounded count; an omitted field is
 * honest "not proven" rather than an assumed true, which is exactly what keeps an
 * unresolved fact unresolved.
 */
function parseRetainedEvidence(value: unknown): RetainedEvidence | undefined | 'invalid' {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) return 'invalid';
  const record = value as Record<string, unknown>;
  const retainedEventCount = record['retainedEventCount'];
  if (typeof retainedEventCount !== 'number' || !Number.isFinite(retainedEventCount) || retainedEventCount < 0) {
    return 'invalid';
  }
  for (const key of ['turnSettlementObserved', 'engineSessionStopped', 'taskContextRecycled'] as const) {
    if (typeof record[key] !== 'boolean') return 'invalid';
  }
  return {
    retainedEventCount: Math.floor(retainedEventCount),
    turnSettlementObserved: record['turnSettlementObserved'] === true,
    engineSessionStopped: record['engineSessionStopped'] === true,
    taskContextRecycled: record['taskContextRecycled'] === true,
  };
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function stringArray(body: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = body[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return undefined;
  return value as readonly string[];
}

function booleanRecord(value: unknown): Readonly<Record<string, boolean>> | 'invalid' {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'invalid';
  const record: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'boolean') return 'invalid';
    record[key] = entry;
  }
  return record;
}

function parseConnection(value: unknown): ConnectionFact | 'invalid' {
  if (value === undefined) return { state: 'never-connected' };
  if (typeof value !== 'object' || value === null) return 'invalid';
  const state = (value as Record<string, unknown>)['state'];
  if (
    state !== 'never-connected' &&
    state !== 'online' &&
    state !== 'reconnecting' &&
    state !== 'offline'
  ) {
    return 'invalid';
  }
  const lastConfirmedAt = (value as Record<string, unknown>)['lastConfirmedAt'];
  if (lastConfirmedAt !== undefined && typeof lastConfirmedAt !== 'number') return 'invalid';
  return {
    state,
    ...(lastConfirmedAt !== undefined ? { lastConfirmedAt } : {}),
  };
}

function parseCompatibility(value: unknown): CompatibilityFact | 'invalid' {
  if (value === undefined) return { state: 'unknown' };
  if (typeof value !== 'object' || value === null) return 'invalid';
  const state = (value as Record<string, unknown>)['state'];
  if (state !== 'unknown' && state !== 'compatible' && state !== 'incompatible') return 'invalid';
  const workerProtocolVersion = (value as Record<string, unknown>)['workerProtocolVersion'];
  if (workerProtocolVersion !== undefined && typeof workerProtocolVersion !== 'string') return 'invalid';
  const detail = (value as Record<string, unknown>)['detail'];
  if (detail !== undefined && typeof detail !== 'string') return 'invalid';
  return {
    state,
    ...(workerProtocolVersion !== undefined ? { workerProtocolVersion } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}

function parseEngineFacts(value: unknown): readonly EnrollmentEngineFact[] | 'invalid' {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return 'invalid';
  const facts: EnrollmentEngineFact[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return 'invalid';
    const record = entry as Record<string, unknown>;
    const engine = record['engine'];
    if (typeof engine !== 'string' || engine === '') return 'invalid';
    const models = record['models'];
    if (models !== undefined && (!Array.isArray(models) || !models.every((m) => typeof m === 'string'))) {
      return 'invalid';
    }
    facts.push({
      engine,
      installed: record['installed'] === true,
      authenticated: record['authenticated'] === true,
      models: (models as readonly string[] | undefined) ?? [],
    });
  }
  return facts;
}

function parseReadinessEngines(value: unknown): readonly EngineReadinessFact[] | 'invalid' {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return 'invalid';
  const facts: EngineReadinessFact[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return 'invalid';
    const record = entry as Record<string, unknown>;
    const engine = record['engine'];
    if (typeof engine !== 'string' || engine === '') return 'invalid';
    const readiness = record['readiness'];
    if (
      readiness !== 'ready' &&
      readiness !== 'login-required' &&
      readiness !== 'missing' &&
      readiness !== 'unknown'
    ) {
      return 'invalid';
    }
    const models = parseModelAvailability(record['models']);
    if (models === 'invalid') return 'invalid';
    const required = record['required'];
    if (required !== undefined && typeof required !== 'boolean') return 'invalid';
    const installed = record['installed'];
    if (installed !== undefined && typeof installed !== 'boolean') return 'invalid';
    facts.push({ engine, installed: installed === true, readiness, required: required === true, models });
  }
  return facts;
}

function parseModelAvailability(
  value: unknown,
): { readonly state: 'available' | 'none' | 'unknown'; readonly models: readonly string[] } | 'invalid' {
  if (value === undefined) return { state: 'unknown', models: [] };
  if (typeof value !== 'object' || value === null) return 'invalid';
  const record = value as Record<string, unknown>;
  const state = record['state'];
  if (state !== 'available' && state !== 'none' && state !== 'unknown') return 'invalid';
  const models = record['models'];
  if (models !== undefined && (!Array.isArray(models) || !models.every((m) => typeof m === 'string'))) {
    return 'invalid';
  }
  return { state, models: (models as readonly string[] | undefined) ?? [] };
}

function parseWorkerProof(value: unknown): WorkerIdentityProof | 'invalid' {
  if (typeof value !== 'object' || value === null) return 'invalid';
  const record = value as Record<string, unknown>;
  const challengeId = record['challengeId'];
  const publicKey = record['publicKey'];
  const signature = record['signature'];
  if (typeof challengeId !== 'string' || challengeId === '') return 'invalid';
  if (typeof publicKey !== 'string' || publicKey === '') return 'invalid';
  if (typeof signature !== 'string' || signature === '') return 'invalid';
  return { challengeId, publicKey, signature };
}

/** Re-exported so a caller can build the durable observation from parsed facts. */
export type { EngineReadinessFact };
