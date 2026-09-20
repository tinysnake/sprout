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

export interface EnvironmentEnrollmentBrowserAdapter {
  state(): BrowserTransportState;
  subscribeState(listener: (state: BrowserTransportState) => void): () => void;
  listEnrollments(): Promise<readonly EnrollmentView[]>;
  getEnrollment(id: string): Promise<EnrollmentView>;
  requestEnrollment(input: {
    readonly environmentInstanceId: string;
    readonly displayName: string;
    readonly platform: string;
    readonly publicKey: string;
    readonly protocolVersion?: string;
    readonly capabilityRequests?: readonly string[];
  }): Promise<{ readonly enrollment: EnrollmentView; readonly bootstrap: { readonly instructions: readonly string[] } }>;
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
  };
}

function jsonCommand(body?: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}
