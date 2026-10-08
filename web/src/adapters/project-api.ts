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

export interface ProjectMcpConfigurationSelection {
  readonly format: 'claude-code-mcp-json-v1';
}

export interface ProjectMcpServerDescriptor {
  readonly name: string;
  readonly transport: 'stdio';
}

export interface ProjectMcpInspectionView {
  readonly environmentInstanceId: string;
  readonly bindingId?: string;
  readonly generation?: number;
  readonly status: 'not-selected' | 'blocked' | 'valid' | 'missing' | 'invalid' | 'unsupported';
  readonly reason?: string;
  readonly servers: readonly ProjectMcpServerDescriptor[];
}

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
  readonly completionGuidance: string;
  readonly rules: readonly string[];
  readonly wakePolicy: string;
  readonly routingIntervalMs: number;
  readonly mcpConfiguration?: ProjectMcpConfigurationSelection;
  readonly memberships: readonly ProjectMembershipView[];
}

export interface ProjectAuthorityView {
  /** Preserved composer field: the stable identity the client addresses. */
  readonly id: string;
  /** Preserved composer field, kept in sync with the current goal. */
  readonly goal: string;
  /** Preserved composer field: current Agent member ids for @mentions. */
  readonly memberIds: readonly string[];
  readonly displayName: string;
  readonly status: string;
  readonly template: {
    readonly templateId: string;
    readonly templateVersion: number;
    readonly templateName: string;
    readonly collaborationGuidance: string;
    readonly completionGuidance: string;
    readonly goalGuidance: string;
    readonly suggestedRules: readonly string[];
    readonly roleSlots: readonly {
      readonly name: string;
      readonly suggestedResponsibilities: readonly string[];
      readonly suggestedCollaborationInstructions: string;
    }[];
    readonly wakePolicy: string;
    readonly routingIntervalMs: number;
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

export interface ProjectEnvironmentCreationInput {
  readonly environmentInstanceId: string;
  readonly workspace: WorkspaceSelectionInput;
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
    readonly mcpConfiguration?: ProjectMcpConfigurationSelection;
    readonly agentMemberships?: readonly AgentMembershipInput[];
    readonly environmentAssignments?: readonly ProjectEnvironmentCreationInput[];
    readonly reason?: string;
  }): Promise<ProjectAuthorityView>;
  /** Append one content version; earlier versions are never rewritten. */
  updateProjectContent(id: string, input: {
    /** Optional display identity edit; stable Project id remains unchanged. */
    readonly displayName?: string;
    readonly goal?: string | null;
    readonly completionGuidance?: string;
    readonly rules?: readonly string[];
    readonly wakePolicy?: string;
    readonly routingIntervalMs?: number;
    readonly mcpConfiguration?: ProjectMcpConfigurationSelection | null;
    readonly reason?: string;
  }): Promise<ProjectAuthorityView>;
  /** Update one active Agent membership as a new content version. */
  updateProjectMembership(id: string, memberId: string, input: {
    readonly responsibilities?: readonly string[];
    readonly collaborationInstructions?: string;
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
    async updateProjectMembership(id, memberId, input) {
      const response = await transport.request<{ readonly project: ProjectAuthorityView }>(
        `/api/projects/${encodeURIComponent(id)}/memberships/${encodeURIComponent(memberId)}`,
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

/**
 * The typed browser port for Project Environment access and Project workspace
 * bindings (#93, ADR-0008).
 *
 * The wire shapes mirror `src/web/views.ts`: a binding exposes the Worker's
 * opaque workspace identity and, for a relative selection, the Worker-root-
 * relative location — never an absolute host path.
 */
export interface WorkspaceBindingView {
  readonly bindingId: string;
  readonly generation?: number;
  readonly workspaceId: string;
  readonly kind: string;
  readonly path?: string;
  readonly boundAt: number;
  readonly unboundAt?: number;
  readonly unboundReason?: string;
}

export interface ProjectEnvironmentAccessView {
  readonly projectId: string;
  readonly environmentInstanceId: string;
  readonly status: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly endedAt?: number;
  readonly endedReason?: string;
  readonly current?: WorkspaceBindingView;
  readonly history: readonly WorkspaceBindingView[];
}

export interface ProjectWorkspaceBindingReadinessView {
  readonly environmentInstanceId: string;
  readonly bindingId?: string;
  readonly generation?: number;
  readonly status: 'ready' | 'blocked';
  readonly reason?: 'project-denied' | 'access-ended' | 'workspace-unbound' | 'worker-offline' | 'stale-epoch' | 'unsupported' | 'capability-denied' | 'lease-required' | 'worker-refused';
}

/** A portable workspace selection: the Worker default or a relative location. */
export type WorkspaceSelectionInput =
  | { readonly kind: 'default' }
  | { readonly kind: 'relative'; readonly path: string };

export interface ProjectAccessBrowserAdapter {
  /** One Project's Environment access and workspace binding history. */
  listProjectAccess(projectId: string): Promise<readonly ProjectEnvironmentAccessView[]>;
  /** Current remote file readiness, separate from Environment engine readiness. */
  listWorkspaceBindingReadiness?(projectId: string): Promise<readonly ProjectWorkspaceBindingReadinessView[]>;
  /** Grant access and record the current workspace; the Worker validates first. */
  grantProjectAccess(
    projectId: string,
    input: {
      readonly environmentInstanceId: string;
      readonly workspace: WorkspaceSelectionInput;
      readonly reason?: string;
    },
  ): Promise<ProjectEnvironmentAccessView>;
  /** Change the current workspace; the previous binding is retained. */
  changeProjectWorkspace(
    projectId: string,
    environmentInstanceId: string,
    input: { readonly workspace: WorkspaceSelectionInput; readonly reason?: string },
  ): Promise<ProjectEnvironmentAccessView>;
  /** Inspect the selected configuration on one authorized Environment Worker. */
  inspectProjectMcpConfiguration(projectId: string, environmentInstanceId: string): Promise<ProjectMcpInspectionView>;
  /** End access non-destructively. */
  endProjectAccess(
    projectId: string,
    environmentInstanceId: string,
    input?: { readonly reason?: string },
  ): Promise<ProjectEnvironmentAccessView>;
}

export function createProjectAccessBrowserAdapter(
  transport: BrowserTransport,
): ProjectAccessBrowserAdapter {
  return {
    async listProjectAccess(projectId) {
      const response = await transport.request<{
        readonly access: readonly ProjectEnvironmentAccessView[];
      }>(`/api/projects/${encodeURIComponent(projectId)}/access`);
      return response.access;
    },
    async listWorkspaceBindingReadiness(projectId) {
      const response = await transport.request<{
        readonly readiness: readonly ProjectWorkspaceBindingReadinessView[];
      }>(`/api/projects/${encodeURIComponent(projectId)}/access/readiness`);
      return response.readiness;
    },
    async grantProjectAccess(projectId, input) {
      const response = await transport.request<{ readonly access: ProjectEnvironmentAccessView }>(
        `/api/projects/${encodeURIComponent(projectId)}/access`,
        jsonCommand(input),
      );
      return response.access;
    },
    async changeProjectWorkspace(projectId, environmentInstanceId, input) {
      const response = await transport.request<{ readonly access: ProjectEnvironmentAccessView }>(
        `/api/projects/${encodeURIComponent(projectId)}/access/${encodeURIComponent(environmentInstanceId)}/workspace`,
        jsonCommand(input),
      );
      return response.access;
    },
    async inspectProjectMcpConfiguration(projectId, environmentInstanceId) {
      const response = await transport.request<{ readonly inspection: ProjectMcpInspectionView }>(
        `/api/projects/${encodeURIComponent(projectId)}/access/${encodeURIComponent(environmentInstanceId)}/mcp-configuration`,
      );
      return response.inspection;
    },
    async endProjectAccess(projectId, environmentInstanceId, input) {
      const response = await transport.request<{ readonly access: ProjectEnvironmentAccessView }>(
        `/api/projects/${encodeURIComponent(projectId)}/access/${encodeURIComponent(environmentInstanceId)}/end`,
        jsonCommand(input ?? {}),
      );
      return response.access;
    },
  };
}
