import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import { agent, INSTANCE_ID, readinessWorkflowHarness, waitFor } from './runtime-test-harness.ts';
import { WORKER_PROTOCOL_VERSION } from './worker/protocol.ts';

test('a Web-created Agent can begin and advance a Task, while an archived Agent cannot advance', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-durable-task-agent-'));
  const h = await readinessWorkflowHarness({ backend: 'sqlite', directory, agents: [agent('seed')] });
  t.after(async () => { await h.close(); rmSync(directory, { recursive: true, force: true }); });
  async function command(path: string, body?: unknown) {
    const response = await fetch(`${h.base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', cookie: h.cookie, 'x-sprout-csrf': h.csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as any };
    if (result.status >= 400 && !path.endsWith('/advances')) assert.fail(`${path}: ${JSON.stringify(result.body)}`);
    return result;
  }
  assert.equal((await command('/api/agents', {
    id: 'durable-agent', displayName: 'Durable Agent',
    workOptions: [{ engine: 'scripted', workModel: 'scripted-model', effort: 'low' }],
  })).status, 201);
  const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;
  await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
    engines: new Map([['scripted', new ScriptedEngineAdapter({ turns: [
      { events: [], result: { status: 'completed', text: 'done' } },
    ] })]]),
    readinessProbe: async (params) => {
      const probe = { at: Date.now(), latencyMs: 1, protocolOk: true, enginesOk: true, source: 'worker' as const, version: '3', summary: 'Synthetic readiness control' };
      return { probe, readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, probe, engines: [{
        engine: 'scripted', installed: true, authenticated: true, readiness: 'ready', modelAvailability: 'available',
        models: ['scripted-model'], targetModels: ['scripted-model'], modelIdPresent: true,
        ...(params.requirements?.revisionsByEngine?.scripted !== undefined
          ? { requirementRevision: params.requirements.revisionsByEngine.scripted } : {}),
      }] } };
    },
  });
  assert.equal((await command(`/api/environments/enrollments/${enrollmentId}/probes`, {})).status, 201);
  assert.equal((await command(`/api/agents/durable-agent/compatibility?environmentInstanceId=${INSTANCE_ID}`)).body.available, true);
  assert.equal((await command('/api/projects', {
    id: 'durable-project', displayName: 'Durable Project', agentMemberships: [{ agentId: 'durable-agent' }],
    environmentAssignments: [{ environmentInstanceId: INSTANCE_ID, workspace: { kind: 'default' } }],
  })).status, 201);
  const proposal = (await command('/api/projects/durable-project/task-proposals', {
    title: 'Durable Task', goal: 'Verify Task admission', constraints: [], validationCriteria: ['Turn completes'],
  })).body.proposal;
  const begun = await command(`/api/task-proposals/${proposal.id}/begin`, {
    expectedRevision: proposal.revision, environmentInstanceId: INSTANCE_ID,
    lead: { memberId: 'operator', memberKind: 'human' }, reason: 'Verify durable Agent admission',
  });
  assert.equal(begun.status, 201, JSON.stringify(begun.body));
  const taskId = begun.body.task.id;
  const advanced = await command(`/api/tasks/${taskId}/advances`, {
    targetAgentId: 'durable-agent', prompt: 'Complete the turn', reason: 'Verify nested admission',
  });
  assert.equal(advanced.status, 202, JSON.stringify(advanced.body));
  await waitFor(() => h.runtime.orchestrator.get(advanced.body.runId)?.status === 'completed', 'nested turn completion');
  await h.runtime.agentService.archive('durable-agent');
  const refused = await command(`/api/tasks/${taskId}/advances`, {
    targetAgentId: 'durable-agent', reason: 'Archived Agent must remain ineligible',
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'target-ineligible');
});
