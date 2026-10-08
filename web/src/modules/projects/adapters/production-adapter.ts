import type { ProjectMembershipView } from '../../../adapters/project-api.js';
import type { ProjectManagementPorts, ProjectManagementService, ProjectOverviewData } from '../types.js';

/**
 * The production Project composition: durable Project/access authority plus
 * current Agent and Environment facts. It owns no fixture state and does not
 * infer server-owned lifecycle rules.
 */
export class ProductionProjectService implements ProjectManagementService {
  readonly #ports: ProjectManagementPorts;

  constructor(ports: ProjectManagementPorts) {
    this.#ports = ports;
  }

  listProjects() {
    return this.#ports.projects.listProjects();
  }

  async loadCreationOptions() {
    const [agents, environments] = await Promise.all([
      this.#ports.agents.listAgents(),
      this.#ports.environments.listEnvironments(),
    ]);
    return { agents, environments };
  }

  async loadOverview(projectId: string): Promise<ProjectOverviewData> {
    const [project, agents, environments, access, bindingReadiness] = await Promise.all([
      this.#ports.projects.getProject(projectId),
      this.#ports.agents.listAgents(),
      this.#ports.environments.listEnvironments(),
      this.#ports.access.listProjectAccess(projectId),
      Promise.resolve(this.#ports.access.listWorkspaceBindingReadiness?.(projectId)).then(value => value ?? []).catch(() => []),
    ]);
    const memberships = currentMemberships(project.content.versions, project.content.currentVersion);
    const activeAgentIdsInAuthority = new Set(
      agents.filter((agent) => agent.status === 'active').map((agent) => agent.id),
    );
    const activeAgentIds = memberships
      .filter((membership) =>
        membership.memberKind === 'agent' &&
        membership.endedAt === undefined &&
        activeAgentIdsInAuthority.has(membership.memberId),
      )
      .map((membership) => membership.memberId);
    const usableAccess = access.filter((entry) => entry.status === 'active' && entry.current !== undefined);

    const compatibility = await Promise.all(
      activeAgentIds.flatMap((agentId) =>
        usableAccess.map(async (entry) => {
          try {
            const result = await this.#ports.agents.compatibilityForEnvironment(
              agentId,
              entry.environmentInstanceId,
            );
            return {
              agentId,
              environmentInstanceId: entry.environmentInstanceId,
              ...(result !== undefined ? { available: result.environmentAvailable } : {}),
              ...(result?.unavailableReason !== undefined ? { unavailableReason: result.unavailableReason } : {}),
            };
          } catch {
            // Compatibility is an observation. A failed observation must not
            // turn into a fabricated unavailable or available verdict.
            return { agentId, environmentInstanceId: entry.environmentInstanceId };
          }
        }),
      ),
    );

    return { project, agents, environments, access, bindingReadiness, compatibility };
  }

  createProject(input: Parameters<ProjectManagementService['createProject']>[0]) {
    return this.#ports.projects.createProject(input);
  }

  updateProjectContent(
    id: string,
    input: Parameters<ProjectManagementService['updateProjectContent']>[1],
  ) {
    return this.#ports.projects.updateProjectContent(id, input);
  }

  addProjectMembership(id: string, input: Parameters<ProjectManagementService['addProjectMembership']>[1]) {
    return this.#ports.projects.addProjectMembership(id, input);
  }

  updateProjectMembership(
    id: string,
    memberId: string,
    input: Parameters<ProjectManagementService['updateProjectMembership']>[2],
  ) {
    return this.#ports.projects.updateProjectMembership(id, memberId, input);
  }

  endProjectMembership(id: string, memberId: string) {
    return this.#ports.projects.endProjectMembership(id, memberId, { reason: 'Project membership ended by the Human.' });
  }

  grantProjectAccess(
    id: string,
    environmentInstanceId: string,
    workspace: Parameters<ProjectManagementService['grantProjectAccess']>[2],
  ) {
    return this.#ports.access.grantProjectAccess(id, { environmentInstanceId, workspace });
  }

  changeProjectWorkspace(
    id: string,
    environmentInstanceId: string,
    workspace: Parameters<ProjectManagementService['changeProjectWorkspace']>[2],
  ) {
    return this.#ports.access.changeProjectWorkspace(id, environmentInstanceId, { workspace });
  }

  endProjectAccess(id: string, environmentInstanceId: string) {
    return this.#ports.access.endProjectAccess(id, environmentInstanceId, {
      reason: 'Project Environment access ended by the Human; workspace files are preserved.',
    });
  }

  inspectProjectMcpConfiguration(id: string, environmentInstanceId: string) {
    return this.#ports.access.inspectProjectMcpConfiguration(id, environmentInstanceId);
  }

  archiveProject(id: string) {
    return this.#ports.projects.archiveProject(id, { reason: 'Project archived by the Human.' });
  }

  restoreProject(id: string) {
    return this.#ports.projects.restoreProject(id);
  }
}

function currentMemberships(
  versions: readonly { readonly version: number; readonly memberships: readonly ProjectMembershipView[] }[],
  currentVersion: number,
): readonly ProjectMembershipView[] {
  return versions.find((version) => version.version === currentVersion)?.memberships ?? [];
}
