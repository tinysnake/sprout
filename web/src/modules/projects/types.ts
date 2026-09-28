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
  WorkspaceSelectionInput,
} from '../../adapters/project-api.js';

/** Current compatibility evidence for one active Agent on one Environment. */
export interface ProjectAgentEnvironmentCompatibility {
  readonly agentId: string;
  readonly environmentInstanceId: string;
  readonly available?: boolean;
  readonly unavailableReason?: string;
}

/** Complete, authoritative read model for the Project Overview page. */
export interface ProjectOverviewData {
  readonly project: ProjectAuthorityView;
  readonly agents: readonly AgentInstance[];
  readonly environments: readonly EnvironmentInstance[];
  readonly access: readonly ProjectEnvironmentAccessView[];
  readonly compatibility: readonly ProjectAgentEnvironmentCompatibility[];
}

export interface CreateProjectInput {
  readonly displayName: string;
  readonly goal?: string;
  readonly rules?: readonly string[];
  readonly wakePolicy?: string;
  readonly agentMemberships?: readonly AgentMembershipInput[];
}

/** The Project page's one typed authority seam. */
export interface ProjectManagementService {
  listProjects(): Promise<readonly ProjectAuthorityView[]>;
  loadOverview(projectId: string): Promise<ProjectOverviewData>;
  createProject(input: CreateProjectInput): Promise<ProjectAuthorityView>;
  updateProjectContent(id: string, input: {
    readonly displayName?: string;
    readonly goal: string | null;
    readonly rules: readonly string[];
    readonly wakePolicy: string;
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
