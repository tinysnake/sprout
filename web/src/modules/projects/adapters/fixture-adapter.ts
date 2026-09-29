import type {
  ProjectAuthorityView,
  ProjectEnvironmentAccessView,
  ProjectMembershipView,
  WorkspaceSelectionInput,
} from '../../../adapters/project-api.js';
import type { AgentManagementService } from '../../agents/types.js';
import type { EnvironmentService } from '../../environments/ports.js';
import type { CreateProjectInput, ProjectManagementService, ProjectOverviewData } from '../types.js';

let fixtureClock = 1_800_000_000_000;
const nextTime = () => ++fixtureClock;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableProject = Mutable<ProjectAuthorityView>;

function projectFixture(
  id: string,
  displayName: string,
  options: { readonly archived?: boolean; readonly memberships?: readonly ProjectMembershipView[] } = {},
): ProjectAuthorityView {
  const createdAt = nextTime();
  const memberships = options.memberships ?? [
    { memberId: 'operator', memberKind: 'human', responsibilities: [], collaborationInstructions: '', startedAt: createdAt },
    { memberId: 'programmer', memberKind: 'agent', responsibilities: ['Implement verified changes'], collaborationInstructions: 'Report concise evidence.', startedAt: createdAt },
  ];
  const status = options.archived ? 'archived' : 'active';
  const contentVersion = {
    version: 1,
    at: createdAt,
    reason: 'Created from the General collaboration template.',
    goal: 'Coordinate durable, Human-supervised work toward a shared goal.',
    completionGuidance: 'A Human validates checkable evidence before accepting completion.',
    rules: ['Keep Project identity portable.', 'Preserve workspace history.'],
    wakePolicy: 'explicit-only',
    routingIntervalMs: 30_000,
    memberships,
  };
  return {
    id,
    displayName,
    status,
    goal: contentVersion.goal,
    memberIds: memberships.filter((entry) => entry.memberKind === 'agent' && entry.endedAt === undefined).map((entry) => entry.memberId),
    template: {
      templateId: 'general-collaboration',
      templateVersion: 1,
      templateName: 'General collaboration',
      collaborationGuidance: 'Coordinate through the Project channel.',
      completionGuidance: 'A Human validates checkable evidence before accepting completion.',
      goalGuidance: 'Coordinate durable, Human-supervised work toward a shared goal.',
      suggestedRules: ['Keep Project identity portable.'],
      roleSlots: [],
      wakePolicy: 'explicit-only',
      routingIntervalMs: 30_000,
    },
    content: { currentVersion: 1, versions: [contentVersion] },
    createdAt,
    updatedAt: createdAt,
    ...(options.archived ? { archivedAt: createdAt, archivedReason: 'Archived for fixture state coverage.' } : {}),
  };
}

export function createInitialProjectFixtures(): ProjectAuthorityView[] {
  return [
    projectFixture('project-sprout', 'Sprout M2 Operator'),
    projectFixture('project-incomplete', 'Resource-incomplete Project', {
      memberships: [
        { memberId: 'operator', memberKind: 'human', responsibilities: [], collaborationInstructions: '', startedAt: nextTime() },
      ],
    }),
    projectFixture('project-archived', 'Archived Project', { archived: true }),
  ];
}

function accessFixture(projectId: string): ProjectEnvironmentAccessView {
  const boundAt = nextTime();
  const binding = {
    bindingId: `binding-${projectId}`,
    workspaceId: `workspace-${projectId}`,
    kind: 'relative',
    path: 'repos/sprout',
    boundAt,
  } as const;
  return {
    projectId,
    environmentInstanceId: 'inst-ready',
    status: 'active',
    startedAt: boundAt,
    updatedAt: boundAt,
    current: binding,
    history: [binding],
  };
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Deterministic test-only authority implementing the Project module's port.
 * Production bootstrap and route code never import this adapter.
 */
export class FixtureProjectService implements ProjectManagementService {
  readonly #agents: AgentManagementService;
  readonly #environments: EnvironmentService;
  readonly #projects: MutableProject[];
  readonly #access = new Map<string, ProjectEnvironmentAccessView[]>();
  #nextId = 0;

  constructor(
    agents: AgentManagementService,
    environments: EnvironmentService,
    initialProjects: readonly ProjectAuthorityView[] = createInitialProjectFixtures(),
  ) {
    this.#agents = agents;
    this.#environments = environments;
    this.#projects = copy([...initialProjects]);
    if (this.#projects.some((project) => project.id === 'project-sprout')) {
      this.#access.set('project-sprout', [accessFixture('project-sprout')]);
    }
  }

  async listProjects(): Promise<readonly ProjectAuthorityView[]> {
    return copy(this.#projects);
  }

  async loadCreationOptions() {
    const [agents, environments] = await Promise.all([
      this.#agents.listAgents(),
      this.#environments.listEnvironments(),
    ]);
    return { agents, environments };
  }

  async loadOverview(projectId: string): Promise<ProjectOverviewData> {
    const project = this.#requireProject(projectId);
    const [agents, environments] = await Promise.all([
      this.#agents.listAgents(),
      this.#environments.listEnvironments(),
    ]);
    const access = copy(this.#access.get(projectId) ?? []);
    const current = project.content.versions.find((version) => version.version === project.content.currentVersion);
    const activeAgentIds = new Set(agents.filter((agent) => agent.status === 'active').map((agent) => agent.id));
    const members = current?.memberships.filter((membership) =>
      membership.memberKind === 'agent' && membership.endedAt === undefined && activeAgentIds.has(membership.memberId),
    ) ?? [];
    const compatibility = await Promise.all(
      members.flatMap((membership) =>
        access.filter((entry) => entry.status === 'active' && entry.current !== undefined).map(async (entry) => {
          const result = await this.#agents.compatibilityForEnvironment(membership.memberId, entry.environmentInstanceId);
          return {
            agentId: membership.memberId,
            environmentInstanceId: entry.environmentInstanceId,
            ...(result !== undefined ? { available: result.environmentAvailable } : {}),
            ...(result?.unavailableReason !== undefined ? { unavailableReason: result.unavailableReason } : {}),
          };
        }),
      ),
    );
    return { project: copy(project), agents, environments, access, compatibility };
  }

  async createProject(input: CreateProjectInput): Promise<ProjectAuthorityView> {
    const now = nextTime();
    const memberships: ProjectMembershipView[] = [
      { memberId: 'operator', memberKind: 'human', responsibilities: [], collaborationInstructions: '', startedAt: now },
      ...(input.agentMemberships ?? []).map((membership) => ({
        memberId: membership.agentId,
        memberKind: 'agent',
        responsibilities: [...(membership.responsibilities ?? [])],
        collaborationInstructions: membership.collaborationInstructions ?? '',
        startedAt: now,
      })),
    ];
    const project = copy(projectFixture(`project-fixture-${++this.#nextId}`, input.displayName, { memberships })) as MutableProject;
    const first = project.content.versions[0]!;
    const initialVersion = {
      ...first,
      goal: input.goal ?? first.goal,
      completionGuidance: first.completionGuidance,
      rules: input.rules ?? first.rules,
      wakePolicy: input.wakePolicy ?? first.wakePolicy,
      routingIntervalMs: input.routingIntervalMs ?? first.routingIntervalMs,
    };
    project.content = { currentVersion: 1, versions: [initialVersion] };
    project.goal = initialVersion.goal;
    const initialAccess = (input.environmentAssignments ?? []).map((assignment) => {
      const at = nextTime();
      const current = bindingFor(assignment.workspace, at, `${project.id}-${assignment.environmentInstanceId}`);
      return {
        projectId: project.id,
        environmentInstanceId: assignment.environmentInstanceId,
        status: 'active' as const,
        startedAt: at,
        updatedAt: at,
        current,
        history: [current],
      };
    });
    if (initialAccess.length > 0) {
      this.#access.set(project.id, initialAccess);
    }
    this.#projects.unshift(project);
    return copy(project);
  }

  async updateProjectContent(id: string, input: { displayName?: string; goal: string | null; completionGuidance: string; rules: readonly string[]; wakePolicy: string; routingIntervalMs: number }): Promise<ProjectAuthorityView> {
    const project = this.#requireEditable(id);
    const current = this.#currentContent(project);
    const next = {
      ...current,
      version: current.version + 1,
      at: nextTime(),
      reason: 'Project content updated.',
      goal: input.goal ?? '',
      completionGuidance: input.completionGuidance,
      rules: [...input.rules],
      wakePolicy: input.wakePolicy,
      routingIntervalMs: input.routingIntervalMs,
    };
    project.content = { currentVersion: next.version, versions: [...project.content.versions, next] };
    if (input.displayName !== undefined) project.displayName = input.displayName;
    project.goal = next.goal;
    project.updatedAt = next.at;
    return copy(project);
  }

  async addProjectMembership(id: string, input: { agentId: string; responsibilities?: readonly string[]; collaborationInstructions?: string }): Promise<ProjectAuthorityView> {
    const project = this.#requireEditable(id);
    const current = this.#currentContent(project);
    const now = nextTime();
    const memberships = current.memberships.filter((member) => member.memberId !== input.agentId);
    memberships.push({
      memberId: input.agentId,
      memberKind: 'agent',
      responsibilities: [...(input.responsibilities ?? [])],
      collaborationInstructions: input.collaborationInstructions ?? '',
      startedAt: now,
    });
    this.#appendMemberships(project, memberships, now);
    return copy(project);
  }

  async updateProjectMembership(id: string, memberId: string, input: { responsibilities: readonly string[]; collaborationInstructions: string }): Promise<ProjectAuthorityView> {
    const project = this.#requireEditable(id);
    const now = nextTime();
    const memberships = this.#currentContent(project).memberships.map((member) => member.memberId === memberId
      ? { ...member, responsibilities: [...input.responsibilities], collaborationInstructions: input.collaborationInstructions }
      : member);
    this.#appendMemberships(project, memberships, now);
    return copy(project);
  }

  async endProjectMembership(id: string, memberId: string): Promise<ProjectAuthorityView> {
    const project = this.#requireEditable(id);
    const now = nextTime();
    const memberships = this.#currentContent(project).memberships.map((member) => member.memberId === memberId
      ? { ...member, endedAt: now, endedReason: 'Membership ended by the Human.' }
      : member);
    this.#appendMemberships(project, memberships, now);
    return copy(project);
  }

  async grantProjectAccess(id: string, environmentInstanceId: string, selection: WorkspaceSelectionInput): Promise<ProjectEnvironmentAccessView> {
    this.#requireEditable(id);
    const now = nextTime();
    const current = bindingFor(selection, now, `${id}-${environmentInstanceId}`);
    const access: ProjectEnvironmentAccessView = {
      projectId: id,
      environmentInstanceId,
      status: 'active',
      startedAt: now,
      updatedAt: now,
      current,
      history: [current],
    };
    this.#access.set(id, [...(this.#access.get(id) ?? []), access]);
    return copy(access);
  }

  async changeProjectWorkspace(id: string, environmentInstanceId: string, selection: WorkspaceSelectionInput): Promise<ProjectEnvironmentAccessView> {
    const rows = this.#access.get(id) ?? [];
    const index = rows.findIndex((entry) => entry.environmentInstanceId === environmentInstanceId && entry.status === 'active');
    if (index < 0) throw new Error('Project Environment access is not active.');
    const old = rows[index]!;
    const now = nextTime();
    const history = old.history.map((binding) => binding.unboundAt === undefined ? { ...binding, unboundAt: now, unboundReason: 'Workspace changed.' } : binding);
    const current = bindingFor(selection, now, `${id}-${environmentInstanceId}-${now}`);
    const changed = { ...old, current, history: [...history, current], updatedAt: now };
    rows[index] = changed;
    return copy(changed);
  }

  async endProjectAccess(id: string, environmentInstanceId: string): Promise<ProjectEnvironmentAccessView> {
    const rows = this.#access.get(id) ?? [];
    const index = rows.findIndex((entry) => entry.environmentInstanceId === environmentInstanceId && entry.status === 'active');
    if (index < 0) throw new Error('Project Environment access is not active.');
    const old = rows[index]!;
    const now = nextTime();
    const history = old.history.map((binding) => binding.unboundAt === undefined ? { ...binding, unboundAt: now, unboundReason: 'Environment access ended.' } : binding);
    const ended: ProjectEnvironmentAccessView = { ...old, status: 'ended', updatedAt: now, endedAt: now, endedReason: 'Access ended by the Human.', history };
    delete (ended as { current?: unknown }).current;
    rows[index] = ended;
    return copy(ended);
  }

  async archiveProject(id: string): Promise<ProjectAuthorityView> {
    const project = this.#requireEditable(id);
    const now = nextTime();
    project.status = 'archived';
    project.archivedAt = now;
    project.archivedReason = 'Archived by the Human.';
    project.updatedAt = now;
    return copy(project);
  }

  async restoreProject(id: string): Promise<ProjectAuthorityView> {
    const project = this.#requireProject(id);
    if (project.status !== 'archived') throw new Error('Project is not archived.');
    project.status = 'active';
    project.restoredAt = nextTime();
    project.updatedAt = project.restoredAt;
    return copy(project);
  }

  #requireProject(id: string): MutableProject {
    const project = this.#projects.find((candidate) => candidate.id === id);
    if (!project) throw new Error('Project could not be found.');
    return project;
  }

  #requireEditable(id: string): MutableProject {
    const project = this.#requireProject(id);
    if (project.status === 'archived') throw new Error('Archived Projects are read-only; restore this Project first.');
    return project;
  }

  #currentContent(project: MutableProject) {
    return project.content.versions.find((version) => version.version === project.content.currentVersion)!;
  }

  #appendMemberships(project: MutableProject, memberships: readonly ProjectMembershipView[], at: number) {
    const current = this.#currentContent(project);
    const next = { ...current, version: current.version + 1, at, reason: 'Project memberships updated.', memberships };
    project.content = { currentVersion: next.version, versions: [...project.content.versions, next] };
    project.memberIds = memberships.filter((member) => member.memberKind === 'agent' && member.endedAt === undefined).map((member) => member.memberId);
    project.updatedAt = at;
  }
}

function bindingFor(selection: WorkspaceSelectionInput, boundAt: number, suffix: string) {
  return {
    bindingId: `binding-${suffix}`,
    workspaceId: `workspace-${suffix}`,
    kind: selection.kind,
    ...(selection.kind === 'relative' ? { path: selection.path } : {}),
    boundAt,
  } as const;
}
