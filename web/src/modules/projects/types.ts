import type { InjectionKey } from 'vue';
import type { AgentInstance, AgentManagementService } from '../agents/types.js';
import type { EnvironmentInstance } from '../environments/types.js';
import type { EnvironmentService } from '../environments/ports.js';
import type {
  AgentMembershipInput,
  ProjectAccessBrowserAdapter,
  ProjectAuthorityView,
  ProjectBrowserAdapter,
  ProjectEnvironmentAccessView,
  ProjectWorkspaceBindingReadinessView,
  ProjectEnvironmentCreationInput,
  ProjectMcpConfigurationSelection,
  ProjectMcpInspectionView,
  WorkspaceSelectionInput,
} from '../../adapters/project-api.js';

/** Current compatibility evidence for one active Agent on one Environment. */
export interface ProjectAgentEnvironmentCompatibility {
  readonly agentId: string;
  readonly environmentInstanceId: string;
  readonly available?: boolean;
  readonly executionMode?: 'environment-hosted' | 'host-run';
  readonly unavailableReason?: string;
}

/** Complete, authoritative read model for the Project Overview page. */
export interface ProjectOverviewData {
  readonly project: ProjectAuthorityView;
  readonly agents: readonly AgentInstance[];
  readonly environments: readonly EnvironmentInstance[];
  readonly access: readonly ProjectEnvironmentAccessView[];
  readonly bindingReadiness: readonly ProjectWorkspaceBindingReadinessView[];
  readonly compatibility: readonly ProjectAgentEnvironmentCompatibility[];
}

export interface CreateProjectInput {
  readonly displayName: string;
  readonly goal?: string;
  readonly rules?: readonly string[];
  readonly wakePolicy?: string;
  readonly routingIntervalMs?: number;
  readonly mcpConfiguration?: ProjectMcpConfigurationSelection;
  readonly agentMemberships?: readonly AgentMembershipInput[];
  readonly environmentAssignments?: readonly ProjectEnvironmentCreationInput[];
}

export interface ProjectCreationOptions {
  readonly agents: readonly AgentInstance[];
  readonly environments: readonly EnvironmentInstance[];
}

/** The Project page's one typed authority seam. */
export interface ProjectManagementService {
  listProjects(): Promise<readonly ProjectAuthorityView[]>;
  loadCreationOptions(): Promise<ProjectCreationOptions>;
  loadOverview(projectId: string): Promise<ProjectOverviewData>;
  createProject(input: CreateProjectInput): Promise<ProjectAuthorityView>;
  updateProjectContent(id: string, input: {
    readonly displayName?: string;
    readonly goal: string | null;
    readonly completionGuidance: string;
    readonly rules: readonly string[];
    readonly wakePolicy: string;
    readonly routingIntervalMs: number;
    readonly mcpConfiguration?: ProjectMcpConfigurationSelection | null;
  }): Promise<ProjectAuthorityView>;
  addProjectMembership(id: string, input: AgentMembershipInput): Promise<ProjectAuthorityView>;
  updateProjectMembership(id: string, memberId: string, input: {
    readonly responsibilities: readonly string[];
    readonly collaborationInstructions: string;
  }): Promise<ProjectAuthorityView>;
  endProjectMembership(id: string, memberId: string): Promise<ProjectAuthorityView>;
  grantProjectAccess(id: string, environmentInstanceId: string, workspace: WorkspaceSelectionInput): Promise<ProjectEnvironmentAccessView>;
  changeProjectWorkspace(id: string, environmentInstanceId: string, workspace: WorkspaceSelectionInput): Promise<ProjectEnvironmentAccessView>;
  endProjectAccess(id: string, environmentInstanceId: string): Promise<ProjectEnvironmentAccessView>;
  inspectProjectMcpConfiguration(id: string, environmentInstanceId: string): Promise<ProjectMcpInspectionView>;
  archiveProject(id: string): Promise<ProjectAuthorityView>;
  restoreProject(id: string): Promise<ProjectAuthorityView>;
}

/** Production wiring is explicit; routes do not construct fixture authority. */
export interface ProjectManagementPorts {
  readonly projects: ProjectBrowserAdapter;
  readonly access: ProjectAccessBrowserAdapter;
  readonly agents: AgentManagementService;
  readonly environments: EnvironmentService;
}

export const PROJECT_SERVICE: InjectionKey<ProjectManagementService> = Symbol('sprout.projects.service');
