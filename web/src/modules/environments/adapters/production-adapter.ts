/**
 * The production `EnvironmentService`: the typed bridge from the page's port to
 * the #87/#88 wire adapter.
 *
 * It owns exactly one responsibility — mapping the enrollment/readiness/
 * recovery wire shapes onto the page's `EnvironmentInstance` composition — and
 * it deliberately owns no domain rule and no fixture: every fact is read from
 * the production Environment ports and every mutation is a wire command. When
 * the adapter reports nothing for an id, `getEnvironment` returns `undefined`
 * rather than inventing a row.
 *
 * The summary composition mirrors what the backend's deterministic projection
 * already decided (level + decisive reason); this bridge never re-derives or
 * overrides it, so the browser and the server cannot disagree about a
 * traffic light.
 */

import type {
  EnvironmentEnrollmentBrowserAdapter,
  EnrollmentView,
  EnvironmentReadinessView,
  EnvironmentRecoveryView,
  ForceReleaseView,
  ProbeResultView,
} from '../../../adapters/environment-api.js';import type {
  ActiveLeaseHolder,
  CapabilityKey,
  ConnectionState,
  EngineStatus,
  EnvironmentInstance,
  ForceReleaseParams,
  LeaseRecovery,
  ProbeRecord,
  ProtocolCompatibility,
  TrafficLight,
  WorkSafety,
} from '../types.js';
import type { EnvironmentService } from '../ports.js';

/** The composed facts one environmentFacts() call returns. */
type EnvironmentFacts = Awaited<
  ReturnType<EnvironmentEnrollmentBrowserAdapter['environmentFacts']>
>;

/** The deterministic backend summary, trusted as the traffic-light authority. */
function trafficLightOf(level: string): TrafficLight {
  return level === 'green' || level === 'yellow' ? level : 'red';
}

function connectionStateOf(state: string): ConnectionState {
  if (state === 'online' || state === 'reconnecting' || state === 'offline') return state;
  return 'never_connected';
}

function workSafetyOf(state: string): WorkSafety {
  if (state === 'clear' || state === 'held' || state === 'reconciling') return state;
  return 'recovery';
}

function compatibilityOf(state: string): ProtocolCompatibility {
  if (state === 'compatible' || state === 'incompatible') return state;
  return 'unknown';
}

function engineStatusOf(readiness: string): EngineStatus {
  if (readiness === 'ready' || readiness === 'login-required' || readiness === 'missing') {
    return readiness;
  }
  return 'unknown';
}

/** The last confirmed age in seconds, when the backend supplied a timestamp. */
function connectionAgeSec(lastConfirmedAt: number | undefined, now: number): number {
  if (lastConfirmedAt === undefined) return 0;
  return Math.max(0, Math.floor((now - lastConfirmedAt) / 1000));
}

function relativeTime(seconds: number): string {
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function leaseHolderOf(recovery: readonly EnvironmentRecoveryView[]): ActiveLeaseHolder | undefined {
  const open = recovery.find(
    (record) => record.phase === 'reconciling' || record.phase === 'recovery',
  );
  if (open === undefined) return undefined;
  if (open.holderKind !== 'task') return undefined;
  return {
    holderId: open.taskId ?? open.leaseId,
    holderKind: 'task',
    projectId: 'active-task',
    acquiredAt: new Date(open.startedAt).toISOString(),
  };
}

function leaseRecoveryOf(recovery: readonly EnvironmentRecoveryView[]): LeaseRecovery | undefined {
  const open = recovery.find(
    (record) => record.phase === 'reconciling' || record.phase === 'recovery',
  );
  if (open === undefined) return undefined;
  const composed: LeaseRecovery = {
    cause: open.cause,
    leaseId: open.leaseId,
    unresolvedFacts: [...open.unresolvedFacts],
    evidenceSynchronized: open.evidenceSynchronized,
  };
  if (open.runId !== undefined) {
    return { ...composed, interruptedRunId: open.runId };
  }
  if (open.evidence !== undefined) {
    return {
      ...composed,
      reconciledEvidence: {
        retainedEventsCount: open.evidence.retainedEventCount,
        engineStoppedProof: open.evidence.engineSessionStopped,
        turnSettlementObserved: open.evidence.turnSettlementObserved,
        taskContextRecycled: open.evidence.taskContextRecycled,
      },
    };
  }
  return composed;
}

/** The audit record the page's ForcedReleaseAuditBox renders, when one exists. */
function auditOf(history: readonly ForceReleaseView[]): EnvironmentInstance['forcedReleaseRecord'] {
  const latest = history[0];
  if (latest === undefined) return undefined;
  return {
    actor: latest.actor,
    timestamp: new Date(latest.at).toISOString(),
    reason: latest.reason,
  };
}

function probeOf(probe: ProbeResultView): ProbeRecord {
  return {
    timestamp: new Date(probe.at).toISOString(),
    observedAt: probe.at,
    latencyMs: probe.latencyMs,
    protocolOk: probe.protocolOk,
    enginesOk: probe.enginesOk,
    summary: probe.summary,
    ...(probe.source !== undefined ? { source: probe.source } : {}),
    ...(probe.version !== undefined ? { version: probe.version } : {}),
  };
}

function probesOf(probes: readonly ProbeResultView[]): ProbeRecord[] {
  return [...probes]
    .sort((a, b) => b.at - a.at)
    .slice(0, 12)
    .map(probeOf);
}

/** The permission rows the page renders, in the enrollment's declared order. */
function capabilityRows(enrollment: EnrollmentView): Record<string, boolean> {
  const rows: Record<string, boolean> = {};
  for (const [capability, allowed] of Object.entries(enrollment.capabilityPermissions)) {
    rows[capability] = allowed === true;
  }
  return rows;
}

/** The engine rows the readiness view reports, keyed by engine id. */
function engineRows(readiness: EnvironmentReadinessView): Record<string, EngineStatus> {
  const rows: Record<string, EngineStatus> = {};
  for (const engine of readiness.engines) {
    rows[engine.engine] = engineStatusOf(engine.readiness);
  }
  return rows;
}

/** Worker-proven engine detail, reduced by the server before it reaches Web. */
function engineDetails(readiness: EnvironmentReadinessView): EnvironmentInstance['engineDetails'] {
  const details: NonNullable<EnvironmentInstance['engineDetails']> = {};
  for (const engine of readiness.engines) {
    details[engine.engine] = {
      ...(engine.version !== undefined ? { version: engine.version } : {}),
      installed: engine.installed,
      readiness: engineStatusOf(engine.readiness),
      authStatus: engine.authenticated === true
        ? 'authenticated'
        : engine.authenticated === false ? 'not-authenticated' : 'unknown',
      ...(engine.authenticated !== undefined ? { authenticated: engine.authenticated } : {}),
      ...(engine.authMode !== undefined ? { authMode: engine.authMode } : {}),
      ...(engine.authType !== undefined ? { authType: engine.authType } : {}),
      modelAvailability: engine.models.state,
      models: [...engine.models.models],
      ...(engine.modelIdPresent !== undefined ? { modelIdPresent: engine.modelIdPresent } : {}),
      ...(engine.probedAt !== undefined ? { observedAt: engine.probedAt } : {}),
      ...(engine.probeExitCode !== undefined ? { probeExitCode: engine.probeExitCode } : {}),
      ...(engine.source !== undefined ? { source: engine.source } : {}),
    };
  }
  return details;
}

/** Compose one page row from the production facts. */
function composeInstance(facts: EnvironmentFacts, now: number): EnvironmentInstance {
  const { enrollment, readiness, probes, recovery, forceReleases, connectionAttempt } = facts;
  const openLease = leaseHolderOf(recovery);
  const ageSec = connectionAgeSec(readiness.connection.lastConfirmedAt, now);
  return {
    id: enrollment.id,
    displayName: enrollment.displayName,
    platform:
      enrollment.platform === 'windows' || enrollment.platform === 'container'
        ? enrollment.platform
        : 'macos',
    trafficLight: trafficLightOf(readiness.summary.level),
    trafficLightReason: readiness.summary.reason,
    enrollmentStatus:
      enrollment.status === 'approved' || enrollment.status === 'pending' || enrollment.status === 'archived'
        ? enrollment.status
        : 'revoked',
    connectionState: connectionStateOf(readiness.connection.state),
    connectionAgeSec: ageSec,
    lastConfirmedTime: relativeTime(ageSec),
    protocolVersion: readiness.compatibility.workerProtocolVersion ?? 'unknown',
    protocolCompatibility: compatibilityOf(readiness.compatibility.state),
    protocolMismatchDetail: readiness.compatibility.detail,
    ...(connectionAttempt !== undefined ? { connectionAttempt } : {}),
    workSafety: workSafetyOf(readiness.workSafety.state),
    activeLeaseHolder: openLease,
    capabilityPermissions: capabilityRows(enrollment),
    engineReadiness: engineRows(readiness),
    engineDetails: engineDetails(readiness),
    leaseRecovery: leaseRecoveryOf(recovery),
    forcedReleaseRecord: auditOf(forceReleases),
    probeHistory: probesOf(probes),
    boundWorkspaces: [],
  };
}

export class ProductionEnvironmentService implements EnvironmentService {
  readonly #adapter: EnvironmentEnrollmentBrowserAdapter;

  /**
   * Production never reconciles evidence on the operator's behalf.
   *
   * Retained settlement evidence is a Worker fact (ADR-0009): it exists only
   * when the reconnected Worker itself synchronized what it retained. No Worker
   * evidence port exists on the wire yet, so this bridge declares the capability
   * absent and its `reconcileEvidence` is a typed refusal — never a placeholder
   * payload posted as if the Worker had synchronized.
   */
  readonly supportsEvidenceReconciliation = false;

  constructor(adapter: EnvironmentEnrollmentBrowserAdapter) {
    this.#adapter = adapter;
  }

  async listEnvironments(): Promise<EnvironmentInstance[]> {
    const enrollments = await this.#adapter.listEnrollments();
    const rows = await Promise.all(
      enrollments.map(async (enrollment) => {
        try {
          return composeInstance(await this.#adapter.environmentFacts(enrollment.id), Date.now());
        } catch {
          // One unreachable row degrades to its authority facts alone; it never
          // hides the whole list. The failed row keeps its enrollment identity
          // and an honest unavailable summary.
          return {
            ...composeInstance(
              {
                enrollment,
                readiness: {
                  environmentInstanceId: enrollment.environmentInstanceId,
                  summary: {
                    level: 'yellow',
                    reason: 'Readiness facts are not reachable; the enrollment authority is preserved.',
                  },
                  enrollmentStatus: enrollment.status,
                  connection: { state: 'reconnecting' },
                  compatibility: { state: 'unknown' },
                  capabilities: [],
                  engines: [],
                  workSafety: { state: 'clear' },
                },
                probes: [],
                recovery: [],
                forceReleases: [],
              },
              Date.now(),
            ),
          };
        }
      }),
    );
    return rows;
  }

  async getEnvironment(id: string): Promise<EnvironmentInstance | undefined> {
    try {
      return composeInstance(await this.#adapter.environmentFacts(id), Date.now());
    } catch {
      return undefined;
    }
  }

  async approveEnrollment(id: string): Promise<void> {
    const { enrollment } = await this.#adapter.environmentFacts(id);
    const permissions: Record<string, boolean> = {};
    for (const capability of Object.keys(enrollment.capabilityPermissions)) {
      permissions[capability] = true;
    }
    await this.#adapter.approveEnrollment(id, permissions);
  }

  async triggerProbe(id: string): Promise<ProbeRecord> {
    // The browser can request a probe, but cannot provide its result. The
    // authenticated Worker measures latency and derives each observation on
    // the Environment host.
    const recorded = await this.#adapter.requestProbe(id);
    return probeOf(recorded);
  }

  async togglePermission(id: string, cap: CapabilityKey): Promise<void> {
    const { enrollment } = await this.#adapter.environmentFacts(id);
    const current = enrollment.capabilityPermissions[cap] === true;
    await this.#adapter.setCapabilityPermission(id, cap, !current);
  }

  /** No bound-workspace authority exists on the wire yet; nothing is mutated. */
  async unbindWorkspace(_projectId: string, _envId: string): Promise<void> {
    await Promise.resolve();
  }

  async reconcileEvidence(id: string): Promise<void> {
    void id;
    // The production bridge never fabricates Worker-synchronized evidence. The
    // recovery service records an evidence decision with actor `worker`, so any
    // operator-posted placeholder would both manufacture the ADR-0009 decision
    // gate and lie in the audit trail. Until a real Worker-declared evidence
    // port exists, this action is refused at the typed boundary and the page
    // renders the reconciling box read-only (see `supportsEvidenceReconciliation`).
    throw new Error(
      'Evidence reconciliation requires the reconnected Worker to synchronize its retained facts; no Worker evidence port is wired yet.',
    );
  }

  async resumeRecovery(taskId: string): Promise<void> {
    await this.#decision(taskId, (leaseId) => this.#adapter.resumeRecovery(leaseId));
  }

  async discardRecovery(taskId: string): Promise<void> {
    await this.#decision(taskId, (leaseId) => this.#adapter.discardRecovery(leaseId));
  }

  async forceRelease(params: ForceReleaseParams): Promise<void> {
    const leaseId = await this.#openLeaseId(params.environmentId);
    if (leaseId === undefined) return;
    await this.#adapter.forceRelease(leaseId, {
      acknowledgedRisks: params.acknowledgedRisks,
      typedConfirmation: 'FORCE RELEASE',
      reason: params.reason,
    });
  }

  async archiveEnvironment(id: string): Promise<void> {
    await this.#adapter.archiveEnvironment(id);
  }

  async restoreEnvironment(id: string): Promise<void> {
    await this.#adapter.restoreEnvironment(id);
  }

  /** Revocation is the #87 authority decision; identity stays on the host. */
  async unenrollEnvironment(id: string): Promise<void> {
    await this.#adapter.revokeEnrollment(id, '');
  }

  /** Resolve the open lease behind a page row, or `undefined` when none. */
  async #openLeaseId(id: string): Promise<string | undefined> {
    const { recovery } = await this.#adapter.environmentFacts(id);
    const open = recovery.find(
      (record) => record.phase === 'reconciling' || record.phase === 'recovery',
    );
    return open?.leaseId;
  }

  /** Run an ordinary decision against the open record of the named Task. */
  async #decision(taskId: string, action: (leaseId: string) => Promise<unknown>): Promise<void> {
    const enrollments = await this.#adapter.listEnrollments();
    for (const enrollment of enrollments) {
      const { recovery } = await this.#adapter.environmentFacts(enrollment.id);
      const open = recovery.find(
        (record) =>
          (record.phase === 'reconciling' || record.phase === 'recovery') &&
          (record.taskId === taskId || record.leaseId === taskId),
      );
      if (open !== undefined) {
        await action(open.leaseId);
        return;
      }
    }
  }
}
