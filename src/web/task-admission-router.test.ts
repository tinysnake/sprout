import test from 'node:test';
import assert from 'node:assert/strict';
import { build, INSTANCE_ID, PROJECT_ID } from '../runtime-test-harness.ts';

test('begin against a recovering Task-held lease returns HTTP 409 with its admission code', async () => {
  const credential = 'task-admission-test-credential';
  const { runtime } = await build({ configuration: { operatorCredential: credential }, listen: false });
  const { port } = await runtime.api.listen(0, '127.0.0.1');
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

    const holder = await runtime.tasks.create({
      projectId: PROJECT_ID, title: 'Existing Task', goal: 'Hold its Environment lease.', assignedAgentId: 'scout',
    });
    const begun = await runtime.tasks.begin(holder.id);
    assert.ok(begun.environmentLeaseId);
    assert.equal(runtime.pool.markRecovering(begun.environmentLeaseId)?.state, 'recovering');

    const created = await fetch(`${base}/api/projects/${PROJECT_ID}/task-proposals`, {
      method: 'POST', headers,
      body: JSON.stringify({
        title: 'Fresh proposal', goal: 'Begin only when the Environment is safe.', constraints: [],
        validationCriteria: ['The lease conflict is reported precisely.'],
      }),
    });
    assert.equal(created.status, 201);
    const { proposal } = (await created.json()) as { proposal: { id: string } };

    const response = await fetch(`${base}/api/task-proposals/${proposal.id}/begin`, {
      method: 'POST', headers,
      body: JSON.stringify({
        expectedRevision: 1,
        environmentInstanceId: INSTANCE_ID,
        lead: { memberId: 'operator', memberKind: 'human' },
        reason: 'Approve after recovery is resolved.',
      }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      code: 'environment-recovering',
      error: 'the selected Environment is protected by Task lease recovery',
    });
  } finally {
    await runtime.api.close();
    await runtime.close();
  }
});
