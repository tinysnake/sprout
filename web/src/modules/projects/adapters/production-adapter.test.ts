import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectAccessBrowserAdapter, ProjectBrowserAdapter } from '../../../adapters/project-api.ts';
import { FixtureAgentService } from '../../agents/adapters/fixture-adapter.ts';
import { FixtureEnvironmentService } from '../../environments/adapters/fixture-adapter.ts';
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
        environmentInstanceId: 'env-ready',
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
  assert.equal(overview.environments.some((environment) => environment.id === 'env-ready'), true);
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
      environmentInstanceId: 'env-ready',
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
