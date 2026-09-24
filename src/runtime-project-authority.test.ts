import test from 'node:test';
import assert from 'node:assert/strict';
import { GENERAL_COLLABORATION_TEMPLATE as GENERAL_TEMPLATE } from './project/template.ts';
import {
  build,
  INSTANCE_ID,
  PROJECT_ID,
  scriptedTurn,
} from './runtime-test-harness.ts';

test('the Project authority service composes over the shared durable store with active-work safety (#92)', async () => {
  const { runtime, stores } = await build({ listen: false });

  // Create a durable Project: only a name is required, the Human membership
  // and template snapshot are implicit, and missing resources do not
  // invalidate identity. A membership must name a real Agent authority: the
  // definition-era seed ('scout') or a durable #90 identity (F5). An invented
  // member id is refused.
  await assert.rejects(
    () =>
      runtime.projectService.create({
        id: 'project-ghost',
        displayName: 'Ghost member',
        agentMemberships: [{ agentId: 'agent-ghost' }],
      }),
    (error: unknown) => error instanceof Error && error.message.includes('agent-ghost'),
  );
  const project = await runtime.projectService.create({
    id: 'project-graph',
    displayName: 'Composed Project',
    goal: 'Prove the graph',
    agentMemberships: [{ agentId: 'scout', responsibilities: ['Investigate'] }],
  });
  assert.equal(project.status, 'active');
  assert.equal(project.template.templateVersion, 1);
  assert.equal((await stores.projectAuthorities.get('project-graph'))?.displayName, 'Composed Project');

  // Membership ending and archive go through the same composed safety port
  // the runs and Tasks own, so a quiet member can end but the composed record
  // keeps every version.
  const ended = await runtime.projectService.endMembership('project-graph', 'scout', {
    reason: 'test end',
  });
  assert.ok(ended.content.versions.at(-1)?.memberships.find((m) => m.memberId === 'scout')?.endedAt);
  const archived = await runtime.projectService.archive('project-graph', { reason: 'test archive' });
  assert.equal(archived.status, 'archived');
  await assert.rejects(
    () => runtime.projectService.updateContent('project-graph', { goal: 'x' }),
    (error: unknown) =>
      error instanceof Error && error.message.includes('read-only'),
  );
  const restored = await runtime.projectService.restore('project-graph');
  assert.equal(restored.status, 'active');

  // A durable archived lifecycle record wins over a same-id configured seed:
  // legacy existence cannot make an inactive Agent eligible for membership.
  await runtime.agentService.create({
    id: 'scout',
    displayName: 'Scout authority',
    workOptions: [{ engine: 'scripted', workModel: 'test-model', effort: 'medium' }],
  });
  await runtime.agentService.archive('scout');
  await assert.rejects(
    () => runtime.projectService.addMembership('project-graph', { agentId: 'scout' }),
    (error: unknown) => error instanceof Error && error.message.includes('active portable Agent'),
  );

  await runtime.close();
});

test('the composed Project router serves the authority contract after the auth boundary (#92)', async () => {
  const credential = 'composed-runtime-test-credential';
  const { runtime } = await build({ configuration: { operatorCredential: credential }, listen: false });
  const { port } = await runtime.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    // Sign in as the Operator: the one Human authority.
    const signIn = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    assert.equal(signIn.status, 201);
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
    const { csrfToken } = (await signIn.json()) as { csrfToken: string };

    const created = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-sprout-csrf': csrfToken },
      body: JSON.stringify({ id: 'project-http', displayName: 'Over HTTP' }),
    });
    assert.equal(created.status, 201);
    const listed = (await (
      await fetch(`${base}/api/projects/authorities`, { headers: { cookie } })
    ).json()) as { projects: { id: string; memberIds: string[] }[] };
    assert.ok(listed.projects.some((entry) => entry.id === 'project-http'));
  } finally {
    await runtime.api.close();
    await runtime.close();
  }
});

test('the authority bridge keeps GET compatibility without inventing execution access and archive removes routing (#92, F1)', async () => {
  const credential = 'composed-runtime-test-credential';
  const { runtime } = await build({
    turns: [scriptedTurn('bridged reply')],
    configuration: { operatorCredential: credential },
    listen: false,
  });
  const { port } = await runtime.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const signIn = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    assert.equal(signIn.status, 201);
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
    const { csrfToken } = (await signIn.json()) as { csrfToken: string };
    const headers = { cookie, 'content-type': 'application/json', 'x-sprout-csrf': csrfToken };

    // The configured legacy Project does not disappear behind the authority
    // route: the merged listing still carries it with its composer fields.
    const legacyListed = (await (
      await fetch(`${base}/api/projects`, { headers: { cookie } })
    ).json()) as { projects: { id: string; goal: string; memberIds: string[] }[] };
    assert.ok(
      legacyListed.projects.some((entry) => entry.id === PROJECT_ID && entry.goal.length > 0),
      'the configured legacy Project must stay visible on GET /api/projects',
    );

    // A durable authority Project with the same id as the configured one wins
    // the shared identity: one stable Project, never a fork.
    const created = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: PROJECT_ID, displayName: 'Authority version' }),
    });
    assert.equal(created.status, 201);
    const afterCreate = (await (
      await fetch(`${base}/api/projects`, { headers: { cookie } })
    ).json()) as { projects: { id: string; goal: string }[] };
    const sameId = afterCreate.projects.filter((entry) => entry.id === PROJECT_ID);
    assert.equal(sameId.length, 1, 'a shared id resolves to one Project, not two');
    assert.equal(sameId[0]?.goal, GENERAL_TEMPLATE.goalGuidance);

    // The new authority Project's channel routes exact mentions after creation,
    // but no durable Environment access exists yet. The bridge must not invent
    // the configured runtime Environment as an execution grant.
    const configuredAgent = runtime.agents.list().some((agent) => agent.id === 'scout');
    assert.ok(configuredAgent);
    const authorityProject = await runtime.projectService.create({
      id: 'project-channel-live',
      displayName: 'Channel live',
    });
    // Mirror-on-change already ran; the registry resolves it.
    assert.ok(runtime.projects.get('project-channel-live'));
    // An Agent membership on the authority Project must name a real Agent
    // authority: the definition-era seed or a durable #90 identity (F5).
    await assert.rejects(
      () => runtime.projectService.addMembership('project-channel-live', { agentId: 'agent-ghost' }),
    );
    await runtime.projectService.addMembership('project-channel-live', { agentId: 'scout' });
    assert.deepEqual(
      runtime.projects.get('project-channel-live')?.availableEnvironmentInstanceIds,
      [],
      'an authority Project with no durable Environment grant is not executable',
    );
    const delivered = await runtime.collaboration.deliver({
      projectId: authorityProject.id,
      channel: 'project',
      author: { id: 'human', kind: 'human' },
      body: '@scout answer on the new channel',
      deliveryKey: 'bridge-delivery-1',
      awaitReply: true,
    });
    assert.equal(delivered.admittedRunIds.length, 1, 'the new Project channel must wake its member');
    const run = await runtime.orchestrator.waitFor(delivered.admittedRunIds[0]!);
    assert.equal(run.status, 'failed');
    assert.match(run.failure ?? '', /available environment/i);

    await runtime.projectService.archive('project-channel-live');
    assert.equal(runtime.projects.get('project-channel-live'), undefined);
    const afterArchive = (await (
      await fetch(`${base}/api/projects`, { headers: { cookie } })
    ).json()) as { projects: { id: string }[] };
    assert.equal(
      afterArchive.projects.some((entry) => entry.id === 'project-channel-live'),
      false,
      'the preserved #85 GET route must not expose archived authority Projects',
    );
    const archivedStatusList = (await (
      await fetch(`${base}/api/projects?status=archived`, { headers: { cookie } })
    ).json()) as { projects: { id: string }[] };
    assert.equal(archivedStatusList.projects.some((entry) => entry.id === 'project-channel-live'), false);
    const archivedDelivery = await runtime.collaboration.deliver({
      projectId: authorityProject.id,
      channel: 'project',
      author: { id: 'human', kind: 'human' },
      body: '@scout must not wake after archive',
      deliveryKey: 'bridge-delivery-archived',
      awaitReply: true,
    });
    assert.deepEqual(archivedDelivery.admittedRunIds, []);
  } finally {
    await runtime.api.close();
    await runtime.close();
  }
});

test('archive refuses while recovery still owns the Environment behind a recovering lease (#92, F3)', async () => {
  const { runtime } = await build({ listen: false });

  // A prior process left a run mid-flight holding a lease; a restart marks
  // the run failed but the lease stays `recovering` until recovery resolves
  // it (the orchestrator marks a stored lease recovering on reconciliation).
  runtime.stores.leases.save({
    id: 'lease-orphan-1',
    instanceId: INSTANCE_ID,
    capability: 'agent-run',
    holderId: 'orphan-lease-run',
    runId: 'orphan-lease-run',
    acquiredAt: 1,
    expiresAt: 10_000_000,
    state: 'active',
  });
  await runtime.stores.runs.save({
    id: 'orphan-lease-run',
    agentId: 'scout',
    prompt: 'left behind by a restart',
    environmentInstanceId: INSTANCE_ID,
    projectId: PROJECT_ID,
    status: 'running',
    leaseId: 'lease-orphan-1',
    events: [],
    createdAt: 1,
  });
  const recovered = await runtime.reconcile();
  assert.deepEqual(recovered.recoveredRuns.map((run) => run.id), ['orphan-lease-run']);

  // The lease is held in recovery after reconciliation.
  const recovering = runtime.pool.leases().filter((lease) => lease.state === 'recovering');
  assert.equal(recovering.length, 1);

  // A durable authority Project over the same id must refuse archive: the
  // lease check sees the orphaned run's recovering lease, even though no
  // queued/running run row and no unfinished Task row remain (F3).
  await runtime.projectService.create({ id: PROJECT_ID, displayName: 'Lease gated' });
  await assert.rejects(
    () => runtime.projectService.archive(PROJECT_ID),
    (error: unknown) => error instanceof Error && error.message.includes('Environment lease'),
  );

  await runtime.close();
});

test('archive and restore fail closed for live leases whose run or Task owner row is missing (#92, F3)', async () => {
  const { runtime } = await build({ listen: false });
  await runtime.projectService.create({ id: 'project-orphan-guard', displayName: 'Orphan guard' });

  runtime.pool.adoptLease({
    id: 'lease-missing-run',
    instanceId: INSTANCE_ID,
    capability: 'agent-run',
    holderId: 'missing-run',
    holderKind: 'run',
    runId: 'missing-run',
    acquiredAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    state: 'active',
  });
  await assert.rejects(
    () => runtime.projectService.archive('project-orphan-guard'),
    (error: unknown) => error instanceof Error && error.message.includes('Environment lease'),
  );

  runtime.pool.releaseLease('lease-missing-run');
  await runtime.projectService.archive('project-orphan-guard');
  runtime.pool.adoptLease({
    id: 'lease-missing-task',
    instanceId: INSTANCE_ID,
    capability: 'agent-run',
    holderId: 'missing-task',
    holderKind: 'task',
    taskId: 'missing-task',
    acquiredAt: 2,
    expiresAt: Number.MAX_SAFE_INTEGER,
    state: 'recovering',
  });
  await assert.rejects(
    () => runtime.projectService.restore('project-orphan-guard'),
    (error: unknown) => error instanceof Error && error.message.includes('Environment lease'),
  );

  await runtime.close();
});
