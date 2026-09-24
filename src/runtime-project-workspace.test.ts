import test from 'node:test';
import assert from 'node:assert/strict';
import {
  build,
  INSTANCE_ID,
  scriptedTurn,
} from './runtime-test-harness.ts';

test('the composed Project access capability grants a validated workspace and gates change on active work (#93)', async () => {
  const { runtime } = await build({ listen: false });

  // Access names a durable authority Project and only an approved enrollment: a
  // bare instance id is never a grant, exactly like membership never names an
  // invented Agent.
  await runtime.projectService.create({ id: 'project-access-graph', displayName: 'Access graph' });
  await assert.rejects(
    () =>
      runtime.projectAccess.grant({
        projectId: 'project-access-graph',
        environmentInstanceId: INSTANCE_ID,
        selection: { kind: 'default' },
      }),
    (error: unknown) =>
      error instanceof Error && error.message.includes('approved Environment enrollment'),
  );

  const requested = await runtime.enrollments.requestEnrollment({
    environmentInstanceId: INSTANCE_ID,
    displayName: 'Composed Environment',
    publicKey: 'composed-public-key',
    platform: 'macos',
    protocolVersion: '2.1',
    capabilityRequests: ['agent-run'],
    engineFacts: [],
  });
  await runtime.enrollments.approve(requested.enrollment.id, {
    capabilityPermissions: { 'agent-run': true },
  });

  const granted = await runtime.projectAccess.grant({
    projectId: 'project-access-graph',
    environmentInstanceId: INSTANCE_ID,
    selection: { kind: 'relative', path: 'repos/sprout' },
    reason: 'initial repository',
  });
  assert.equal(granted.status, 'active');
  assert.equal(granted.current?.path, 'repos/sprout');
  // The Worker validated before anything durable; the absolute location never
  // crosses the boundary.
  assert.ok(!JSON.stringify(granted).includes('/Users/'));

  // The grant republishes the M1 projection, so the Project becomes executable.
  assert.deepEqual(runtime.projects.get('project-access-graph')?.availableEnvironmentInstanceIds, [INSTANCE_ID]);
  assert.deepEqual(runtime.projects.get('project-access-graph')?.workspaces, [
    { environmentInstanceId: INSTANCE_ID, path: 'repos/sprout' },
  ]);

  // An active run on the Environment blocks both the workspace change and the
  // access end, and a refused change records nothing.
  runtime.pool.adoptLease({
    id: 'lease-active-work',
    instanceId: INSTANCE_ID,
    capability: 'agent-run',
    holderId: 'scout',
    holderKind: 'run',
    runId: 'missing-run',
    acquiredAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    state: 'active',
  });
  await assert.rejects(
    () =>
      runtime.projectAccess.changeWorkspace({
        projectId: 'project-access-graph',
        environmentInstanceId: INSTANCE_ID,
        selection: { kind: 'relative', path: 'repos/other' },
      }),
    (error: unknown) => error instanceof Error && error.message.includes('active work'),
  );
  await assert.rejects(
    () =>
      runtime.projectAccess.end({
        projectId: 'project-access-graph',
        environmentInstanceId: INSTANCE_ID,
      }),
    (error: unknown) => error instanceof Error && error.message.includes('active work'),
  );
  assert.equal(
    (await runtime.projectAccess.get('project-access-graph', INSTANCE_ID))?.current?.path,
    'repos/sprout',
    'a refused change leaves the binding untouched',
  );

  // Once the work settles, the change appends a binding and the old binding is
  // retained unbound; the projection follows the current binding.
  runtime.pool.releaseLease('lease-active-work');
  const changed = await runtime.projectAccess.changeWorkspace({
    projectId: 'project-access-graph',
    environmentInstanceId: INSTANCE_ID,
    selection: { kind: 'relative', path: 'repos/other' },
    reason: 'moved',
  });
  assert.equal(changed.history.length, 2);
  assert.equal(changed.history.filter((binding) => binding.unboundAt === undefined).length, 1);
  assert.deepEqual(runtime.projects.get('project-access-graph')?.workspaces, [
    { environmentInstanceId: INSTANCE_ID, path: 'repos/other' },
  ]);

  // Ending access removes the Environment from the projection but keeps the
  // relationship and its binding history.
  const ended = await runtime.projectAccess.end({
    projectId: 'project-access-graph',
    environmentInstanceId: INSTANCE_ID,
    reason: 'retired',
  });
  assert.equal(ended.status, 'ended');
  assert.equal(ended.current, undefined);
  assert.equal(ended.history.length, 2);
  assert.deepEqual(
    runtime.projects.get('project-access-graph')?.availableEnvironmentInstanceIds,
    [],
    'an ended access is no longer an execution grant',
  );

  await runtime.close();
});

test('a composed run records the durable workspace binding it was admitted under (#93)', async () => {
  const { runtime } = await build({
    turns: [scriptedTurn('composition reply')],
  });
  await runtime.projectService.create({ id: 'project-bound', displayName: 'Bound' });
  const requested = await runtime.enrollments.requestEnrollment({
    environmentInstanceId: INSTANCE_ID,
    displayName: 'Bound Environment',
    publicKey: 'bound-public-key',
    platform: 'macos',
    protocolVersion: '2.1',
    capabilityRequests: ['agent-run'],
    engineFacts: [],
  });
  await runtime.enrollments.approve(requested.enrollment.id, {
    capabilityPermissions: { 'agent-run': true },
  });
  await runtime.projectAccess.grant({
    projectId: 'project-bound',
    environmentInstanceId: INSTANCE_ID,
    selection: { kind: 'relative', path: 'repos/sprout' },
  });
  await runtime.projectService.addMembership('project-bound', { agentId: 'scout' });

  const { id } = await runtime.orchestrator.submit({
    agentId: 'scout',
    prompt: 'inspect the bound workspace',
    projectId: 'project-bound',
  });
  const run = await runtime.orchestrator.waitFor(id);

  assert.equal(run.status, 'completed');
  const durable = await runtime.stores.projectAccess.get('project-bound', INSTANCE_ID);
  assert.deepEqual(
    run.workspaceBinding,
    {
      bindingId: durable?.current?.bindingId,
      workspaceId: durable?.current?.workspaceId,
      kind: 'relative',
      path: 'repos/sprout',
    },
    'the run carries the durable binding facts, not a re-derivation',
  );
  const stored = await runtime.stores.runs.get(id);
  assert.deepEqual(stored?.workspaceBinding, run.workspaceBinding, 'the binding survives a restart');

  // A later change appends a new binding for future runs; the historical run
  // still names the binding it used.
  await runtime.projectAccess.changeWorkspace({
    projectId: 'project-bound',
    environmentInstanceId: INSTANCE_ID,
    selection: { kind: 'relative', path: 'repos/moved' },
  });
  const after = await runtime.stores.projectAccess.get('project-bound', INSTANCE_ID);
  assert.equal(after?.history.length, 2);
  assert.equal(after?.current?.path, 'repos/moved');
  const historical = (await runtime.stores.runs.get(id))?.workspaceBinding;
  assert.equal(historical?.path, 'repos/sprout', 'history is not rewritten by the change');
  assert.equal(historical?.bindingId, durable?.current?.bindingId);

  // A corrupt legacy durable access document bypasses the ordinary access
  // service. Runtime admission must still reject its traversal location before
  // it becomes a new AgentRun record or reaches the Worker request.
  assert.ok(after?.current);
  await runtime.stores.projectAccess.save({
    ...after,
    current: { ...after.current, path: '../corrupt-binding' },
    history: after.history.map((binding) =>
      binding.bindingId === after.current?.bindingId
        ? { ...binding, path: '../corrupt-binding' }
        : binding,
    ),
  });
  const corruptSubmission = await runtime.orchestrator.submit({
    agentId: 'scout', prompt: 'do not leak the corrupt workspace', projectId: 'project-bound',
  });
  const corruptRun = await runtime.orchestrator.waitFor(corruptSubmission.id);
  assert.equal(corruptRun.status, 'completed');
  assert.equal(corruptRun.workspaceBinding, undefined);
  assert.equal(
    JSON.stringify(await runtime.stores.runs.get(corruptSubmission.id)).includes('../corrupt-binding'),
    false,
    'the raw durable corruption is neither run history nor a Worker-bound fact',
  );

  await runtime.close();
});
