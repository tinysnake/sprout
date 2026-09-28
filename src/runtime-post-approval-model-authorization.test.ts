import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKER_PROTOCOL_VERSION } from './worker/protocol.ts';
import { INSTANCE_ID } from './runtime-test-harness.ts';
import { agent, readinessWorkflowHarness, waitFor } from './runtime-test-harness.ts';

/**
 * #172 acceptance: an Agent created (or edited) after enrollment approval must
 * be able to reach `state: "available"` through a supported post-approval Human
 * model-authorization decision — without resetting the enrollment.
 *
 * ADR-0013's amendment says a requirement-scope change invalidates affected
 * authorizations "requiring a fresh Human decision"; that fresh decision must be
 * recordable on the already-approved enrollment (reset exists for identity
 * replacement, not for model entitlement). These tests pin the durable decision
 * audit, the requirement-revision stamping, and the three-way compatibility
 * state copy.
 */
for (const backend of ['memory', 'sqlite'] as const) {
  test(`#172 ${backend}: an Agent created after approval reaches available through a post-approval Human model authorization without resetting the enrollment`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), `sprout-172-post-approval-${backend}-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));

    const h = await readinessWorkflowHarness({
      backend,
      directory,
      engineId: 'codex',
      agents: [{ ...agent('scout'), engine: 'codex', model: 'target-model' }],
      // Approval-time authorization for the model an Agent already demanded.
      modelAuthorizations: { codex: ['target-model'] },
    });
    const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;

    const compatibility = async (agentId: string) => {
      const response = await fetch(`${h.base}/api/agents/${agentId}/compatibility?environment=${INSTANCE_ID}`, {
        headers: { cookie: h.cookie },
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      return JSON.parse(text) as {
        available: boolean;
        options: { state: string; reason: string }[];
      };
    };
    const triggerProbe = async () => {
      const response = await fetch(`${h.base}/api/environments/enrollments/${enrollmentId}/probes`, {
        method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 201, await response.text());
    };

    try {
      await h.runtime.agentService.create({
        id: 'scout',
        displayName: 'Scout',
        workOptions: [{ engine: 'codex', workModel: 'target-model', effort: 'medium' }],
      });

      let probeCounter = 0;
      await h.connect(enrollmentId, join(directory, 'worker-key.pem'), {
        readinessProbe: async (params) => {
          probeCounter += 1;
          const targets = params.requirements?.modelsByEngine?.codex ?? [];
          const revision = params.requirements?.revisionsByEngine?.codex ?? params.requirements?.revision;
          const probe = {
            at: 70_000 + probeCounter,
            latencyMs: 1,
            protocolOk: true,
            enginesOk: true,
            source: 'worker' as const,
            version: '3',
            summary: 'codex non-inference probe',
          };
          return {
            readiness: {
              protocolVersion: WORKER_PROTOCOL_VERSION,
              observedAt: 70_000 + probeCounter,
              engines: [
                {
                  engine: 'codex',
                  installed: true,
                  readiness: 'ready' as const,
                  modelAvailability: 'unknown' as const,
                  models: [],
                  authenticated: true,
                  modelIdPresent: true,
                  targetModels: targets,
                  ...(revision !== undefined ? { requirementRevision: revision } : {}),
                  source: 'codex-account-read',
                },
              ],
              probe,
            },
            probe,
          };
        },
      });
      await waitFor(() => h.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined, 'Worker accepted');
      await triggerProbe();

      // Approval-time semantics unchanged: the approval-approved model is available.
      await waitFor(
        async () =>
          h.runtime.environmentCatalog.entries().find((entry) => entry.instanceId === INSTANCE_ID)?.eligible === true,
        'catalog eligible from approval-time authorization',
      );

      // Create an Agent after approval whose work model was not in the approval-time requirements.
      await h.runtime.agentService.create({
        id: 'late',
        displayName: 'Late',
        workOptions: [{ engine: 'codex', workModel: 'late-model', effort: 'medium' }],
      });

      const before = await compatibility('late');
      assert.equal(before.available, false, 'the post-approval Agent starts unavailable');
      assert.equal(before.options[0]?.state, 'unknown', 'unknown = not yet human-authorized');
      assert.match(before.options[0]?.reason ?? '', /availability is unknown for "codex"/);

      // The supported post-approval path records the Human decision in place.
      const authorize = await fetch(
        `${h.base}/api/environments/enrollments/${enrollmentId}/model-authorizations`,
        {
          method: 'POST',
          headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
          body: JSON.stringify({ modelAuthorizations: { codex: ['target-model', 'late-model'] } }),
        },
      );
      assert.equal(authorize.status, 200, await authorize.text());

      // No enrollment reset ceremony: same identity, still approved, no reset decision.
      const enrollment = await h.runtime.enrollments.get(enrollmentId);
      assert.equal(enrollment?.status, 'approved');
      assert.equal(enrollment?.id, enrollmentId);
      assert.equal(
        (enrollment?.decisions ?? []).some((decision) => decision.kind === 'reset'),
        false,
        'no reset decision was recorded',
      );
      // Human-decision audit stays intact.
      assert.ok(
        (enrollment?.decisions ?? []).some(
          (decision) => decision.kind === 'models-authorized' && decision.actor === 'operator',
        ),
        'the post-approval Human decision is durably audited',
      );

      // The measured fact must be re-established for the current requirement
      // revision; authorizing models does not fabricate a Worker observation.
      await triggerProbe();
      await waitFor(
        async () =>
          h.runtime.environmentCatalog.entries().find((entry) => entry.instanceId === INSTANCE_ID)?.eligible === true,
        'catalog eligible after post-approval authorization',
      );

      const after = await compatibility('late');
      assert.equal(after.available, true, `post-approval Agent unavailable: ${after.options[0]?.reason}`);
      assert.equal(after.options[0]?.state, 'available');
      assert.match(after.options[0]?.reason ?? '', /human-approval/);

      // The previously authorized model is still available after re-authorization.
      const scout = await compatibility('scout');
      assert.equal(scout.available, true, `prior Agent unavailable: ${scout.options[0]?.reason}`);

      // Readiness keeps measured fact and Human authorization distinguishable, and
      // the authorization is stamped with the current requirement revision.
      const readinessResponse = await fetch(
        `${h.base}/api/environments/enrollments/${enrollmentId}/readiness`,
        { headers: { cookie: h.cookie } },
      );
      assert.equal(readinessResponse.status, 200);
      const readinessBody = (await readinessResponse.json()) as {
        readiness: { engines: { engine: string; models: { state: string }; modelAuthorizations?: { model: string; source: string; requirementRevision?: string }[] }[] };
      };
      const codex = readinessBody.readiness.engines.find((engine) => engine.engine === 'codex');
      assert.equal(codex?.models.state, 'unknown', 'measured model availability stays unknown');
      const lateAuth = codex?.modelAuthorizations?.find((auth) => auth.model === 'late-model');
      assert.equal(lateAuth?.source, 'human-approval');
      assert.ok(lateAuth?.requirementRevision, 'the decision is stamped with a requirement revision');
    } finally {
      await h.close();
    }
  });
}

test('#172 authority: post-approval authorization requires an approved enrollment and an existing one', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-172-authority-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const h = await readinessWorkflowHarness({ backend: 'memory', directory, engineId: 'codex', approve: false });
  const enrollmentId = (await h.runtime.enrollments.list())[0]!.id;

  try {
    const post = (id: string, body: unknown) =>
      fetch(`${h.base}/api/environments/enrollments/${id}/model-authorizations`, {
        method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // A pending enrollment has no approved Human decision to amend.
    const pending = await post(enrollmentId, { modelAuthorizations: { codex: ['target-model'] } });
    assert.equal(pending.status, 409, await pending.text());

    // An unknown enrollment is not found.
    const unknown = await post('enr-does-not-exist', { modelAuthorizations: { codex: ['target-model'] } });
    assert.equal(unknown.status, 404, await unknown.text());

    // The selection is required; a bare call cannot clear or guess authorization.
    const missing = await post(enrollmentId, {});
    assert.equal(missing.status, 400, await missing.text());
  } finally {
    await h.close();
  }
});
