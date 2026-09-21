import type { BrowserTransport, BrowserTransportState } from '../transport/browser-transport.ts';

/**
 * Typed browser port for Environment enrollment and readiness (#87).
 *
 * It is a thin, typed wrapper over the `/api/environments/enrollments` routes.
 * It never constructs its own authority and never queues a command: a failed
 * request rejects immediately through the shared transport (the #85 rule).
 *
 * The wire shapes mirror `src/web/views.ts` so the browser adapter and the
 * server projection cannot drift into two different contracts.
 */

export interface EnrollmentDecisionView {
  readonly kind: string;
  readonly actor: string;
  readonly at: number;
  readonly reason: string;
}

export interface EnrollmentView {
  readonly id: string;
  readonly environmentInstanceId: string;
  readonly displayName: string;
  readonly status: string;
  readonly platform: string;
  readonly identityDigest: string;
  readonly protocolVersion?: string;
  readonly capabilityPermissions: Readonly<Record<string, boolean>>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly decisions: readonly EnrollmentDecisionView[];
}

export interface EnvironmentReadinessView {
  readonly environmentInstanceId: string;
  readonly summary: { readonly level: string; readonly reason: string };
  readonly enrollmentStatus: string;
  readonly connection: { readonly state: string; readonly lastConfirmedAt?: number };
  readonly compatibility: {
    readonly state: string;
    readonly workerProtocolVersion?: string;
    readonly detail?: string;
  };
  readonly capabilities: readonly {
    readonly name: string;
    readonly permission: string;
    readonly required: boolean;
  }[];
  readonly engines: readonly {
    readonly engine: string;
    readonly installed: boolean;
    readonly readiness: string;
    readonly required: boolean;
    readonly models: { readonly state: string; readonly models: readonly string[] };
  }[];
  readonly probe?: {
    readonly at: number;
    readonly latencyMs: number;
    readonly protocolOk: boolean;
    readonly enginesOk: boolean;
    readonly summary: string;
  };
  readonly workSafety: { readonly state: string };
}

export interface ProbeResultView {
  readonly at: number;
  readonly latencyMs: number;
  readonly protocolOk: boolean;
  readonly enginesOk: boolean;
  readonly summary: string;
}

export interface WorkerIdentityProofView {
  readonly challengeId: string;
  readonly publicKey: string;
  readonly signature: string;
}

export interface WorkerIdentityChallengeView {
  readonly id: string;
  readonly enrollmentId: string;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/**
 * The wire shape of one Environment recovery record (#88).
 *
 * Mirrors `src/web/views.ts` so the browser adapter and the server projection
 * cannot drift into two different contracts. Only neutral evidence facts,
 * product-owned unresolved facts, and sanitized decision reasons cross the wire.
 */
export interface EnvironmentRecoveryView {
  readonly id: string;
  readonly environmentInstanceId: string;
  readonly leaseId: string;
  readonly holderKind: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly cause: string;
  readonly phase: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly reconnectObservedAt?: number;
  readonly evidence?: {
    readonly retainedEventCount: number;
    readonly turnSettlementObserved: boolean;
    readonly engineSessionStopped: boolean;
    readonly taskContextRecycled: boolean;
  };
  readonly unresolvedFacts: readonly string[];
  readonly evidenceSynchronized: boolean;
  readonly decisions: readonly {
    readonly kind: string;
    readonly actor: string;
    readonly at: number;
    readonly reason: string;
  }[];
}

/** The wire shape of one permanent Force Release outcome (#88). */
export interface ForceReleaseView {
  readonly id: string;
  readonly environmentInstanceId: string;
  readonly leaseId: string;
  readonly holderKind: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly actor: string;
  readonly at: number;
  readonly reason: string;
  readonly risksAcknowledged: boolean;
  readonly unresolvedFacts: readonly string[];
  readonly affectedRunIds: readonly string[];
  readonly projectWorkspacePreserved: boolean;
  readonly unrecycledTaskContext: boolean;
}

/** The neutral retained evidence a reconnected Worker synchronizes. */
export interface RetainedEvidenceView {
  readonly retainedEventCount: number;
  readonly turnSettlementObserved: boolean;
  readonly engineSessionStopped: boolean;
  readonly taskContextRecycled: boolean;
}

export interface EnvironmentEnrollmentBrowserAdapter {
  state(): BrowserTransportState;
  subscribeState(listener: (state: BrowserTransportState) => void): () => void;
  listEnrollments(): Promise<readonly EnrollmentView[]>;
  getEnrollment(id: string): Promise<EnrollmentView>;
  requestEnrollment(input: {
    readonly environmentInstanceId: string;
    readonly displayName: string;
    readonly platform: string;
    /**
     * A pre-known Worker public key, when a caller has one. Web creation (#115)
     * omits it and receives a short-lived one-use claim instead.
     */
    readonly publicKey?: string;
    readonly protocolVersion?: string;
    readonly capabilityRequests?: readonly string[];
  }): Promise<{
    readonly enrollment: EnrollmentView;
    readonly bootstrap: { readonly instructions: readonly string[] };
    /** The one-use claim secret, present only on Web creation (#115). */
    readonly claim?: { readonly secret: string; readonly expiresAt: number };
  }>;
  /**
   * Request a proof challenge for one enrollment.
   *
   * A Worker signs `challenge.nonce` with its host-generated private key and
   * returns the signed proof to `connectWorker`; a bare public key is not proof.
   */
  requestChallenge(id: string): Promise<WorkerIdentityChallengeView>;
  connectWorker(id: string, input: {
    readonly proof: WorkerIdentityProofView;
    readonly connection: { readonly state: string; readonly lastConfirmedAt?: number };
    readonly compatibility: { readonly state: string; readonly workerProtocolVersion?: string };
    readonly engines: readonly {
      readonly engine: string;
      readonly readiness: string;
      readonly required?: boolean;
      readonly models?: { readonly state: string; readonly models: readonly string[] };
    }[];
  }): Promise<{ readonly outcome: string; readonly requiresHumanApproval: boolean; readonly enrollment: EnrollmentView }>;
  approveEnrollment(id: string, capabilityPermissions: Readonly<Record<string, boolean>>): Promise<EnrollmentView>;
  revokeEnrollment(id: string, reason: string): Promise<EnrollmentView>;
  resetEnrollment(id: string, reason: string): Promise<EnrollmentView>;
  setCapabilityPermission(id: string, capability: string, allowed: boolean): Promise<EnrollmentView>;
  readiness(id: string): Promise<{ readonly readiness: EnvironmentReadinessView; readonly probes: readonly ProbeResultView[] }>;
  recordProbe(id: string, probe: ProbeResultView): Promise<ProbeResultView>;
  /**
   * The open recovery record plus the permanent Force Release history for one
   * Environment (#88). No mutation: a reconnect alone never proves safety.
   */
  recovery(enrollmentId: string): Promise<{
    readonly recovery: readonly EnvironmentRecoveryView[];
    readonly forceReleases: readonly ForceReleaseView[];
  }>;
  /** Record a verified same-identity reconnect; moves the record to reconciling. */
  observeReconnect(leaseId: string, input: {
    readonly enrollmentId: string;
    readonly environmentInstanceId: string;
    readonly identityVerified: boolean;
    readonly protocolCompatible: boolean;
    readonly permissionsAllowed: boolean;
    readonly hadActiveRun: boolean;
    readonly evidence?: RetainedEvidenceView;
  }): Promise<EnvironmentRecoveryView>;
  /** Synchronize retained evidence; the only path that can resolve or reach recovery. */
  synchronizeEvidence(leaseId: string, input: {
    readonly evidence: RetainedEvidenceView;
    readonly hadActiveRun: boolean;
  }): Promise<EnvironmentRecoveryView>;
  /** Ordinary Resume: keep the interrupted run as history on the same lease. */
  resumeRecovery(leaseId: string, reason?: string): Promise<EnvironmentRecoveryView>;
  /** Ordinary Discard: safe Task end that recycles context before release. */
  discardRecovery(leaseId: string, reason?: string): Promise<EnvironmentRecoveryView>;
  /** Ordinary Release of a one-round run-held lease. */
  releaseRecovery(leaseId: string, reason?: string): Promise<EnvironmentRecoveryView>;
  /**
   * Human-only emergency Force Release. Requires the exact typed confirmation,
   * risk acknowledgement, and a reason; it is refused unless the record is in
   * `recovery` with a concrete unresolved fact.
   */
  forceRelease(leaseId: string, input: {
    readonly acknowledgedRisks: boolean;
    readonly typedConfirmation: string;
    readonly reason: string;
  }): Promise<ForceReleaseView>;

  /**
   * Non-destructive archive and restore (ADR-0008, #89). Archive bars new work
   * while preserving enrollment, history, and decisions; restore reuses the
   * still-valid enrollment.
   */
  archiveEnvironment(id: string, reason?: string): Promise<EnrollmentView>;
  restoreEnvironment(id: string, reason?: string): Promise<EnrollmentView>;

  /** The composed read-only facts behind one Environment page row. */
  environmentFacts(id: string): Promise<EnvironmentFactsView>;
}

/** The composed facts behind one Environment page row (all reads, no mutation). */
export interface EnvironmentFactsView {
  readonly enrollment: EnrollmentView;
  readonly readiness: EnvironmentReadinessView;
  readonly probes: readonly ProbeResultView[];
  readonly recovery: readonly EnvironmentRecoveryView[];
  readonly forceReleases: readonly ForceReleaseView[];
}

export function createEnvironmentEnrollmentBrowserAdapter(
  transport: BrowserTransport,
): EnvironmentEnrollmentBrowserAdapter {
  return {
    state: () => transport.state(),
    subscribeState: (listener) => transport.subscribeState(listener),
    async listEnrollments() {
      const response = await transport.request<{ readonly enrollments: readonly EnrollmentView[] }>(
        '/api/environments/enrollments',
      );
      return response.enrollments;
    },
    async getEnrollment(id) {
      const response = await transport.request<{ readonly enrollment: EnrollmentView }>(
        `/api/environments/enrollments/${encodeURIComponent(id)}`,
      );
      return response.enrollment;
    },
    async requestEnrollment(input) {
      return transport.request('/api/environments/enrollments', jsonCommand(input));
    },
    async requestChallenge(id) {
      const response = await transport.request<{ readonly challenge: WorkerIdentityChallengeView }>(
        `/api/environments/enrollments/${encodeURIComponent(id)}/challenge`,
        jsonCommand({}),
      );
      return response.challenge;
    },
    async connectWorker(id, input) {
      return transport.request(
        `/api/environments/enrollments/${encodeURIComponent(id)}/connect`,
        jsonCommand(input),
      );
    },
    async approveEnrollment(id, capabilityPermissions) {
      const response = await transport.request<{ readonly enrollment: EnrollmentView }>(
        `/api/environments/enrollments/${encodeURIComponent(id)}/approve`,
        jsonCommand({ capabilityPermissions }),
      );
      return response.enrollment;
    },
    async revokeEnrollment(id, reason) {
      const response = await transport.request<{ readonly enrollment: EnrollmentView }>(
        `/api/environments/enrollments/${encodeURIComponent(id)}/revoke`,
        jsonCommand({ reason }),
      );
      return response.enrollment;
    },
    async resetEnrollment(id, reason) {
      const response = await transport.request<{ readonly enrollment: EnrollmentView }>(
        `/api/environments/enrollments/${encodeURIComponent(id)}/reset`,
        jsonCommand({ reason }),
      );
      return response.enrollment;
    },
    async setCapabilityPermission(id, capability, allowed) {
      const response = await transport.request<{ readonly enrollment: EnrollmentView }>(
        `/api/environments/enrollments/${encodeURIComponent(id)}/permissions`,
        jsonCommand({ capability, allowed }),
      );
      return response.enrollment;
    },
    readiness: (id) =>
      transport.request(`/api/environments/enrollments/${encodeURIComponent(id)}/readiness`),
    async recordProbe(id, probe) {
      const response = await transport.request<{ readonly probe: ProbeResultView }>(
        `/api/environments/enrollments/${encodeURIComponent(id)}/probes`,
        jsonCommand(probe),
      );
      return response.probe;
    },
    recovery: (id) =>
      transport.request(`/api/environments/enrollments/${encodeURIComponent(id)}/recovery`),
    async observeReconnect(leaseId, input) {
      const response = await transport.request<{ readonly recovery: EnvironmentRecoveryView }>(
        `/api/environments/recovery/${encodeURIComponent(leaseId)}/reconnect`,
        jsonCommand(input),
      );
      return response.recovery;
    },
    async synchronizeEvidence(leaseId, input) {
      const response = await transport.request<{ readonly recovery: EnvironmentRecoveryView }>(
        `/api/environments/recovery/${encodeURIComponent(leaseId)}/evidence`,
        jsonCommand(input),
      );
      return response.recovery;
    },
    async resumeRecovery(leaseId, reason) {
      const response = await transport.request<{ readonly recovery: EnvironmentRecoveryView }>(
        `/api/environments/recovery/${encodeURIComponent(leaseId)}/resume`,
        jsonCommand(reason === undefined ? {} : { reason }),
      );
      return response.recovery;
    },
    async discardRecovery(leaseId, reason) {
      const response = await transport.request<{ readonly recovery: EnvironmentRecoveryView }>(
        `/api/environments/recovery/${encodeURIComponent(leaseId)}/discard`,
        jsonCommand(reason === undefined ? {} : { reason }),
      );
      return response.recovery;
    },
    async releaseRecovery(leaseId, reason) {
      const response = await transport.request<{ readonly recovery: EnvironmentRecoveryView }>(
        `/api/environments/recovery/${encodeURIComponent(leaseId)}/release`,
        jsonCommand(reason === undefined ? {} : { reason }),
      );
      return response.recovery;
    },
    async forceRelease(leaseId, input) {
      const response = await transport.request<{ readonly forceRelease: ForceReleaseView }>(
        `/api/environments/recovery/${encodeURIComponent(leaseId)}/force-release`,
        jsonCommand(input),
      );
      return response.forceRelease;
    },
    async archiveEnvironment(id, reason) {
      const response = await transport.request<{ readonly enrollment: EnrollmentView }>(
        `/api/environments/enrollments/${encodeURIComponent(id)}/archive`,
        jsonCommand(reason === undefined ? {} : { reason }),
      );
      return response.enrollment;
    },
    async restoreEnvironment(id, reason) {
      const response = await transport.request<{ readonly enrollment: EnrollmentView }>(
        `/api/environments/enrollments/${encodeURIComponent(id)}/restore`,
        jsonCommand(reason === undefined ? {} : { reason }),
      );
      return response.enrollment;
    },
    async environmentFacts(id): Promise<EnvironmentFactsView> {
      const encoded = encodeURIComponent(id);
      const [enrollment, readiness, recovery] = await Promise.all([
        transport.request<{ readonly enrollment: EnrollmentView }>(
          `/api/environments/enrollments/${encoded}`,
        ),
        transport.request<{ readonly readiness: EnvironmentReadinessView; readonly probes: readonly ProbeResultView[] }>(
          `/api/environments/enrollments/${encoded}/readiness`,
        ),
        transport.request<{ readonly recovery: readonly EnvironmentRecoveryView[]; readonly forceReleases: readonly ForceReleaseView[] }>(
          `/api/environments/enrollments/${encoded}/recovery`,
        ),
      ]);
      return {
        enrollment: enrollment.enrollment,
        readiness: readiness.readiness,
        probes: readiness.probes,
        recovery: recovery.recovery,
        forceReleases: recovery.forceReleases,
      };
    },
  };
}

function jsonCommand(body?: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}
