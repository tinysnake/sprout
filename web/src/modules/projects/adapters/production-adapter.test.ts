import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectAccessBrowserAdapter, ProjectBrowserAdapter } from '../../../adapters/project-api.ts';
import type { EnvironmentEnrollmentBrowserAdapter, EnvironmentFactsView } from '../../../adapters/environment-api.ts';
import { FixtureAgentService } from '../../agents/adapters/fixture-adapter.ts';
import { FixtureEnvironmentService } from '../../environments/adapters/fixture-adapter.ts';
import { ProductionEnvironmentService } from '../../environments/adapters/production-adapter.ts';
import { createInitialProjectFixtures } from './fixture-adapter.ts';
import { ProductionProjectService } from './production-adapter.ts';

test('the Project production composition joins durable Project, Agent, Environment, workspace, and compatibility facts', async () => {
  const project = createInitialProjectFixtures()[0]!;
  const envRows = await new FixtureEnvironmentService().listEnvironments();
  const agentService = new FixtureAgentService();
  const calls: string[] = [];
  const projectPort = {
    async listProjects() { calls.push('projects:list'); return [project]; },
    async getProject(id: string) { calls.push(`project:${id}`); return project; },
  } as unknown as ProjectBrowserAdapter;
  const accessPort = {
    async listProjectAccess(id: string) {
      calls.push(`access:${id}`);
      return [{
        projectId: id,
        environmentInstanceId: 'inst-ready',
        status: 'active',
        startedAt: 10,
        updatedAt: 10,
        current: { bindingId: 'binding-a', workspaceId: 'workspace-a', kind: 'relative', path: 'repos/sprout', boundAt: 10 },
        history: [{ bindingId: 'binding-a', workspaceId: 'workspace-a', kind: 'relative', path: 'repos/sprout', boundAt: 10 }],
      }];
    },
  } as unknown as ProjectAccessBrowserAdapter;
  const service = new ProductionProjectService({
    projects: projectPort,
    access: accessPort,
    agents: agentService,
    environments: new FixtureEnvironmentService(envRows),
  });

  assert.deepEqual(await service.listProjects(), [project]);
  const overview = await service.loadOverview(project.id);
  assert.equal(overview.project.id, project.id);
  assert.equal(overview.agents.some((agent) => agent.id === 'programmer'), true);
  assert.equal(overview.environments.some((environment) => environment.id === 'env-ready' && environment.environmentInstanceId === 'inst-ready'), true);
  assert.equal(overview.access[0]?.current?.path, 'repos/sprout');
  assert.equal(overview.compatibility[0]?.available, true);
  assert.deepEqual(calls, ['projects:list', `project:${project.id}`, `access:${project.id}`]);
});

test('an unobserved per-Environment compatibility result stays unknown', async () => {
  const project = createInitialProjectFixtures()[0]!;
  class UnknownCompatibilityAgentService extends FixtureAgentService {
    override async compatibilityForEnvironment() { return undefined; }
  }
  const agentService = new UnknownCompatibilityAgentService();
  const service = new ProductionProjectService({
    projects: { async listProjects() { return [project]; }, async getProject() { return project; } } as unknown as ProjectBrowserAdapter,
    access: { async listProjectAccess(id: string) { return [{
      projectId: id,
      environmentInstanceId: 'inst-ready',
      status: 'active',
      startedAt: 10,
      updatedAt: 10,
      current: { bindingId: 'binding-a', workspaceId: 'workspace-a', kind: 'default', boundAt: 10 },
      history: [{ bindingId: 'binding-a', workspaceId: 'workspace-a', kind: 'default', boundAt: 10 }],
    }]; } } as unknown as ProjectAccessBrowserAdapter,
    agents: agentService,
    environments: new FixtureEnvironmentService([]),
  });
  const overview = await service.loadOverview(project.id);
  assert.equal(overview.compatibility[0]?.available, undefined);
});

test('Project creation and later workspace grants use the approved instance id from production enrollment facts', async () => {
  const enrollment = {
    id: 'enroll-approved', environmentInstanceId: 'inst-approved', displayName: 'Approved Worker',
    status: 'approved', platform: 'macos', identityDigest: 'digest', capabilityPermissions: { 'agent-run': true },
    createdAt: 1, updatedAt: 2, decisions: [],
  } as const;
  const facts = {
    enrollment,
    readiness: {
      environmentInstanceId: 'inst-approved', enrollmentStatus: 'approved',
      summary: { level: 'green', reason: 'Worker ready' }, connection: { state: 'online' },
      compatibility: { state: 'compatible' }, capabilities: [], engines: [], workSafety: { state: 'clear' },
    },
    probes: [], recovery: [], forceReleases: [],
  } satisfies EnvironmentFactsView;
  const environmentPort = new ProductionEnvironmentService({
    async listEnrollments() { return [enrollment]; },
    async environmentFacts(id: string) {
      assert.equal(id, enrollment.id, 'Environment reads remain enrollment-keyed');
      return facts;
    },
  } as unknown as EnvironmentEnrollmentBrowserAdapter);
  const project = createInitialProjectFixtures()[0]!;
  const selected: string[] = [];
  const requireApprovedInstance = (id: string) => {
    assert.equal(id, enrollment.environmentInstanceId, 'access authority rejects enrollment identity');
    selected.push(id);
  };
  const service = new ProductionProjectService({
    environments: environmentPort,
    agents: new FixtureAgentService(),
    projects: {
      async createProject(input: { environmentAssignments?: readonly { environmentInstanceId: string }[] }) {
        for (const assignment of input.environmentAssignments ?? []) requireApprovedInstance(assignment.environmentInstanceId);
        return project;
      },
      async getProject() { return project; },
    } as unknown as ProjectBrowserAdapter,
    access: {
      async listProjectAccess() { return []; },
      async grantProjectAccess(_id: string, input: { environmentInstanceId: string }) {
        requireApprovedInstance(input.environmentInstanceId);
        return { projectId: project.id, environmentInstanceId: input.environmentInstanceId,
          status: 'active', startedAt: 1, updatedAt: 1, history: [] };
      },
    } as unknown as ProjectAccessBrowserAdapter,
  });

  const option = (await service.loadCreationOptions()).environments[0]!;
  assert.equal(option.id, enrollment.id);
  assert.equal(option.environmentInstanceId, enrollment.environmentInstanceId);
  await service.createProject({ displayName: 'With Worker', agentMemberships: [{ agentId: 'programmer' }],
    environmentAssignments: [{ environmentInstanceId: option.environmentInstanceId, workspace: { kind: 'default' } }] });
  const overview = await service.loadOverview(project.id);
  const grantOption = overview.environments[0]!;
  await service.grantProjectAccess(project.id, grantOption.environmentInstanceId, { kind: 'relative', path: 'repos/next' });
  assert.deepEqual(selected, ['inst-approved', 'inst-approved']);
});
