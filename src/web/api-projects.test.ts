import { test } from 'node:test';
import assert from 'node:assert/strict';


import { withServer, buildObservableCollaboration } from './api-harness.ts';

test('an unknown mention failure is visible through the observations route', async () => {
  const context = buildObservableCollaboration();
  const { port } = await context.api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const delivered = (await (
      await fetch(`${base}/api/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: 'project-sprout',
          channel: 'project',
          authorId: 'operator',
          body: '@ghost are you there?',
          deliveryKey: 'web-unknown-mention-1',
        }),
      })
    ).json()) as { message: { id: string }; wakes: unknown[]; admittedRunIds: string[] };
    assert.equal(delivered.wakes.length, 0, 'an unknown target wakes nobody');
    assert.equal(delivered.admittedRunIds.length, 0);

    const observations = (await (
      await fetch(`${base}/api/messages/${delivered.message.id}/observations`)
    ).json()) as { observations: { status: string; reason: string; agentId: string; detail: string }[] };
    const failure = observations.observations.find((observation) => observation.status === 'failed');
    assert.ok(failure, 'the unknown target is reported, not silently dropped');
    assert.equal(failure.reason, 'agent-mention');
    assert.equal(failure.agentId, 'ghost');
    assert.match(failure.detail, /not a member/);
  } finally {
    await context.api.close();
  }
});

test('the project list is absent when no project registry is configured', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/projects`);
    assert.equal(response.status, 404);
  });
});
