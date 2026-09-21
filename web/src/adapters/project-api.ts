import type { BrowserTransport, BrowserTransportState } from '../transport/browser-transport.js';

/**
 * Typed browser port for durable Project, template, and membership authority
 * (#92).
 *
 * A thin, typed wrapper over the additive `/api/projects` authority routes,
 * mirroring the Agent adapter's rules: it never constructs its own authority
 * and never queues a command — a failed request rejects immediately through
 * the shared transport. The wire shapes mirror `src/web/views.ts` so the
 * browser adapter and the server projection cannot drift into two different
 * contracts.
 *
 * Privacy: every field below is portable state — stable identity, display
 * name, template attribution, versioned goal/rules/wake-policy content, and
 * membership facts. No host path, credential, provider or account identity,
 * hostname, address, absolute path, or raw command can appear in these shapes,
 * and the adapter never accepts one as input.
 */

export interface ProjectMembershipView {
  readonly memberId: string;
  readonly memberKind: string;
  readonly responsibilities: readonly string[];
  readonly collaborationInstructions: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly endedReason?: string;
}

export interface ProjectContentVersionView {
  readonly version: number;
  readonly at: number;
  readonly reason: string;
  readonly goal: string;
  readonly rules: readonly string[];
  readonly wakePolicy: string;
  readonly routingIntervalMs: number;
  readonly memberships: readonly ProjectMembershipView[];
}

export interface ProjectAuthorityView {
  readonly id: string;
  readonly displayName: string;
  readonly status: string;
  readonly template: {
    readonly templateId: string;
    readonly templateVersion: number;
    readonly templateName: string;
    readonly collaborationGuidance: string;
    readonly completionGuidance: string;
  };
  readonly content: {
    readonly currentVersion: number;
    readonly versions: readonly ProjectContentVersionView[];
  };
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archivedAt?: number;
  readonly archivedReason?: string;
  readonly restoredAt?: number;
}

export interface AgentMembershipInput {
  readonly agentId: string;
  readonly responsibilities?: readonly string[];
  readonly collaborationInstructions?: string;
}

export interface ProjectBrowserAdapter {
  state(): BrowserTransportState;
  subscribeState(listener: (state: BrowserTransportState) => void): () => void;
  /** List durable Projects, optionally by lifecycle status. */
  listProjects(status?: 'active' | 'archived'): Promise<readonly ProjectAuthorityView[]>;
  getProject(id: string): Promise<ProjectAuthorityView>;
  /** Create one Project; the Human membership and template snapshot are implicit. */
  createProject(input: {
    readonly id?: string;
    readonly displayName: string;
    readonly goal?: string;
    readonly rules?: readonly string[];
    readonly wakePolicy?: string;
    readonly routingIntervalMs?: number;
    readonly agentMemberships?: readonly AgentMembershipInput[];
    readonly reason?: string;
  }): Promise<ProjectAuthorityView>;
  /** Append one content version; earlier versions are never rewritten. */
  updateProjectContent(id: string, input: {
    readonly goal?: string | null;
    readonly rules?: readonly string[];
    readonly wakePolicy?: string;
    readonly routingIntervalMs?: number;
    readonly reason?: string;
  }): Promise<ProjectAuthorityView>;
  /** Add one Agent membership (Human authority, enforced server-side). */
  addProjectMembership(id: string, input: AgentMembershipInput & { readonly reason?: string }): Promise<ProjectAuthorityView>;
  /** End one membership non-destructively; history and attribution remain. */
  endProjectMembership(id: string, memberId: string, input?: { readonly reason?: string }): Promise<ProjectAuthorityView>;
  /** Non-destructive archive (ADR-0008): refused while active work depends on the Project. */
  archiveProject(id: string, input?: { readonly reason?: string }): Promise<ProjectAuthorityView>;
  restoreProject(id: string): Promise<ProjectAuthorityView>;
}

function jsonCommand(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function createProjectBrowserAdapter(transport: BrowserTransport): ProjectBrowserAdapter {
  return {
    state: () => transport.state(),
    subscribeState: (listener) => transport.subscribeState(listener),
    async listProjects(status) {
      const suffix = status === undefined ? '' : `?status=${encodeURIComponent(status)}`;
      const response = await transport.request<{ readonly projects: readonly ProjectAuthorityView[] }>(
        `/api/projects/authorities${suffix}`,
      );
      return response.projects;
    },
    async getProject(id) {
      const response = await transport.request<{ readonly project: ProjectAuthorityView }>(
        `/api/projects/${encodeURIComponent(id)}`,
      );
      return response.project;
    },
    async createProject(input) {
      const response = await transport.request<{ readonly project: ProjectAuthorityView }>(
        '/api/projects',
        jsonCommand(input),
      );
      return response.project;
    },
    async updateProjectContent(id, input) {
      const response = await transport.request<{ readonly project: ProjectAuthorityView }>(
        `/api/projects/${encodeURIComponent(id)}/content`,
        jsonCommand(input),
      );
      return response.project;
    },
    async addProjectMembership(id, input) {
      const response = await transport.request<{ readonly project: ProjectAuthorityView }>(
        `/api/projects/${encodeURIComponent(id)}/memberships`,
        jsonCommand(input),
      );
      return response.project;
    },
    async endProjectMembership(id, memberId, input) {
      const response = await transport.request<{ readonly project: ProjectAuthorityView }>(
        `/api/projects/${encodeURIComponent(id)}/memberships/${encodeURIComponent(memberId)}/end`,
        jsonCommand(input ?? {}),
      );
      return response.project;
    },
    async archiveProject(id, input) {
      const response = await transport.request<{ readonly project: ProjectAuthorityView }>(
        `/api/projects/${encodeURIComponent(id)}/archive`,
        jsonCommand(input ?? {}),
      );
      return response.project;
    },
    async restoreProject(id) {
      const response = await transport.request<{ readonly project: ProjectAuthorityView }>(
        `/api/projects/${encodeURIComponent(id)}/restore`,
        jsonCommand({}),
      );
      return response.project;
    },
  };
}
