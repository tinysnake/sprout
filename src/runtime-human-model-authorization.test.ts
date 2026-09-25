import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import { WORKER_PROTOCOL_VERSION } from './worker/protocol.ts';
import {
  agent,
  readinessWorkflowHarness,
  waitFor,
} from './runtime-test-harness.ts';

for (const backend of ['memory', 'sqlite'] as const) {
  test(`#138 ${backend}: unselected model blocks admission; ceremony explicit authorization admits run from unknown model state`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), `sprout-138-auth-${backend}-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));

    const triggerProbe = async (h: { base: string; cookie: string; csrf: string }, id: string) => {
      const post = await fetch(`${h.base}/api/environments/enrollments/${id}/probes`, {
        method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: '{}',
      });
      const text = await post.text();
      assert.equal(post.status, 201, text);
    };

    // --- CASE A: Approval ceremony WITHOUT model authorization ---
    // The operator approves permissions but does not authorize the model (no default/implication)
    const dirA = join(directory, 'a');
    mkdirSync(dirA, { recursive: true });
    const hA = await readinessWorkflowHarness({
      backend,
      directory: dirA,
      engineId: 'codex',
      agents: [{ ...agent('scout'), engine: 'codex', model: 'target-model' }],
    });

    try {
      const idA = (await hA.runtime.enrollments.list())[0]!.id;
      const instanceIdA = (await hA.runtime.enrollments.get(idA))!.environmentInstanceId;

      await hA.runtime.agentService.create({
        id: 'scout',
        displayName: 'Scout',
        workOptions: [{ engine: 'codex', workModel: 'target-model', effort: 'medium' }],
      });

      let probeCounterA = 0;
      const successEvents = [{ type: 'message' as const, text: 'completed task', final: true }];
      const dummyAdapter = new ScriptedEngineAdapter({
        turns: [{ events: successEvents, result: { status: 'completed' as const, text: 'completed task' } }],
      });
      Object.assign(dummyAdapter, { id: 'codex' });

      await hA.connect(
        idA,
        join(dirA, 'worker-key.pem'),
        {
          engines: new Map([['codex', dummyAdapter]]),
          readinessProbe: async (params) => {
            probeCounterA += 1;
            const probe = {
              at: 80_000 + probeCounterA,
              latencyMs: 1,
              protocolOk: true,
              enginesOk: true,
              source: 'worker' as const,
              version: '3',
              summary: 'codex non-inference probe',
            };
            const revision = params.requirements?.revisionsByEngine?.codex ?? params.requirements?.revision;
            return {
              readiness: {
                protocolVersion: WORKER_PROTOCOL_VERSION,
                observedAt: 80_000 + probeCounterA,
                engines: [
                  {
                    engine: 'codex',
                    installed: true,
                    readiness: 'ready',
                    modelAvailability: 'unknown' as const,
                    models: [],
                    authenticated: true,
                    modelIdPresent: true,
                    targetModels: ['target-model'],
                    ...(revision !== undefined ? { requirementRevision: revision } : {}),
                    source: 'codex-account-read',
                  },
                ],
                probe,
              },
              probe,
            };
          },
        },
      );

      await triggerProbe(hA, idA);

      // Without model authorization, unknown model availability blocks work
      const entryA = hA.runtime.environmentCatalog.entries().find((e) => e.instanceId === instanceIdA);
      assert.equal(entryA?.eligible, false, 'Unselected model must remain ineligible');

      const compatResA = await fetch(`${hA.base}/api/agents/scout/compatibility?environment=${instanceIdA}`, {
        headers: { cookie: hA.cookie },
      });
      assert.equal(compatResA.status, 200);
      const compatBodyA = (await compatResA.json()) as { available: boolean; options: { state: string; reason: string }[] };
      assert.equal(compatBodyA.available, false);
      assert.equal(compatBodyA.options[0]?.state, 'unknown');
      assert.match(compatBodyA.options[0]?.reason ?? '', /availability is unknown for "codex"/);
    } finally {
      await hA.close();
    }

    // --- CASE B: Approval ceremony WITH explicit model authorization ---
    const dirB = join(directory, 'b');
    mkdirSync(dirB, { recursive: true });
    const hB = await readinessWorkflowHarness({
      backend,
      directory: dirB,
      engineId: 'codex',
      agents: [{ ...agent('scout'), engine: 'codex', model: 'target-model' }],
      modelAuthorizations: { codex: ['target-model'] },
    });

    try {
      const idB = (await hB.runtime.enrollments.list())[0]!.id;
      const instanceIdB = (await hB.runtime.enrollments.get(idB))!.environmentInstanceId;

      await hB.runtime.agentService.create({
        id: 'scout',
        displayName: 'Scout',
        workOptions: [{ engine: 'codex', workModel: 'target-model', effort: 'medium' }],
      });

      const authorityProject = await hB.runtime.projectService.create({
        displayName: 'Ticket 138 Project',
        goal: 'Verify explicit human model authorization.',
        agentMemberships: [{ agentId: 'scout' }],
      });

      let probeCounterB = 0;
      const successEvents = [{ type: 'message' as const, text: 'completed task', final: true }];
      const successAdapter = new ScriptedEngineAdapter({
        turns: [{ events: successEvents, result: { status: 'completed' as const, text: 'completed task' } }],
      });
      Object.assign(successAdapter, { id: 'codex' });

      await hB.connect(
        idB,
        join(dirB, 'worker-key.pem'),
        {
          engines: new Map([['codex', successAdapter]]),
          readinessProbe: async (params) => {
            probeCounterB += 1;
            const probe = {
              at: 90_000 + probeCounterB,
              latencyMs: 1,
              protocolOk: true,
              enginesOk: true,
              source: 'worker' as const,
              version: '3',
              summary: 'codex non-inference probe',
            };
            const revision = params.requirements?.revisionsByEngine?.codex ?? params.requirements?.revision;
            return {
              readiness: {
                protocolVersion: WORKER_PROTOCOL_VERSION,
                observedAt: 90_000 + probeCounterB,
                engines: [
                  {
                    engine: 'codex',
                    installed: true,
                    readiness: 'ready',
                    modelAvailability: 'unknown' as const,
                    models: [],
                    authenticated: true,
                    modelIdPresent: true,
                    targetModels: ['target-model'],
                    ...(revision !== undefined ? { requirementRevision: revision } : {}),
                    source: 'codex-account-read',
                  },
                ],
                probe,
              },
              probe,
            };
          },
        },
      );

      await triggerProbe(hB, idB);

      // 1. With explicit model authorization, catalog entry becomes eligible
      await waitFor(async () => {
        const entry = hB.runtime.environmentCatalog.entries().find((e) => e.instanceId === instanceIdB);
        return entry?.eligible === true;
      }, 'catalog entry eligible');

      // 2. Compatibility projection reports available with human-approval provenance in reason
      const compatResB = await fetch(`${hB.base}/api/agents/scout/compatibility?environment=${instanceIdB}`, {
        headers: { cookie: hB.cookie },
      });
      assert.equal(compatResB.status, 200);
      const compatBodyB = (await compatResB.json()) as {
        available: boolean;
        firstAvailable?: { engine: string; workModel: string };
        options: { state: string; reason: string }[];
      };
      assert.equal(compatBodyB.available, true);
      assert.equal(compatBodyB.firstAvailable?.workModel, 'target-model');
      assert.match(compatBodyB.options[0]?.reason ?? '', /human-approval/);

      // 3. Readiness presentation keeps measured fact and authorization distinguishable
      const readinessRes = await fetch(`${hB.base}/api/environments/enrollments/${idB}/readiness`, {
        headers: { cookie: hB.cookie },
      });
      assert.equal(readinessRes.status, 200);
      const readinessBody = (await readinessRes.json()) as {
        readiness: {
          engines: {
            engine: string;
            models: { state: string };
            source?: string;
            modelAuthorizations?: { engine: string; model: string; source: string }[];
          }[];
        };
      };
      const codexView = readinessBody.readiness.engines.find((e) => e.engine === 'codex');
      assert.equal(codexView?.models.state, 'unknown', 'Measured fact remains unknown (never promoted to ready)');
      assert.equal(codexView?.source, 'codex-account-read', 'Measured source is codex-account-read');
      assert.equal(codexView?.modelAuthorizations?.length, 1);
      assert.equal(codexView?.modelAuthorizations[0]?.source, 'human-approval', 'Authorizations provenance is human-approval');

      // 4. Admission succeeds: grant project access and run agent
      await hB.runtime.projectAccess.grant({
        projectId: authorityProject.id,
        environmentInstanceId: instanceIdB,
        selection: { kind: 'default' },
      });

      const admission = await hB.runtime.orchestrator.evaluateOptionAdmission('scout', instanceIdB);
      assert.equal(admission.ok, true, 'Admission evaluates ok: true with human model authorization');
      assert.equal(admission.option?.workModel, 'target-model');

      const submitReady = await hB.runtime.orchestrator.submit({
        agentId: 'scout',
        prompt: 'Run with authorized model',
        projectId: authorityProject.id,
      });
      const settledReady = await hB.runtime.orchestrator.waitFor(submitReady.id);
      assert.equal(settledReady.status, 'completed', `Run failed: ${settledReady.failure}`);
      assert.equal(settledReady.workOption?.workModel, 'target-model');

      // 5. Invalidation on requirement scope change (#123 US20):
      // Reconfigure agent with a different work model -> revision changes -> authorization invalidated
      const reconfigRes = await fetch(`${hB.base}/api/agents/scout/configuration`, {
        method: 'POST',
        headers: { cookie: hB.cookie, 'x-sprout-csrf': hB.csrf, 'content-type': 'application/json' },
        body: JSON.stringify({
          workOptions: [{ engine: 'codex', workModel: 'changed-model', effort: 'medium' }],
        }),
      });
      assert.equal(reconfigRes.status, 200);

      // Wait for catalog to observe change and become ineligible
      await waitFor(async () => {
        const entry = hB.runtime.environmentCatalog.entries().find((e) => e.instanceId === instanceIdB);
        return entry?.eligible === false;
      }, 'catalog entry ineligible on scope change');

      const compatAfterChange = await fetch(`${hB.base}/api/agents/scout/compatibility?environment=${instanceIdB}`, {
        headers: { cookie: hB.cookie },
      });
      const compatAfterBody = (await compatAfterChange.json()) as { available: boolean; options: { state: string; reason: string }[] };
      assert.equal(compatAfterBody.available, false, 'Changed model without authorization is not available');
      assert.match(compatAfterBody.options[0]?.reason ?? '', /not established for the current requirement revision|availability is unknown/);

      // Admission refused for changed model
      const admissionChanged = await hB.runtime.orchestrator.evaluateOptionAdmission('scout', instanceIdB);
      assert.equal(admissionChanged.ok, false);
      assert.match(admissionChanged.reason ?? '', /not established for the current requirement revision|availability is unknown/);

      const submitChanged = await hB.runtime.orchestrator.submit({
        agentId: 'scout',
        prompt: 'Attempt with unapproved changed model',
        projectId: authorityProject.id,
      });
      const settledChanged = await hB.runtime.orchestrator.waitFor(submitChanged.id);
      assert.equal(settledChanged.status, 'failed', 'Run must fail when model is unapproved');
      assert.match(settledChanged.failure ?? '', /no available environment for capability: agent-run/);

      // 6. Invalidation on revocation
      await hB.runtime.enrollments.revoke(idB, 'Revoked for testing');
      const revoked = await hB.runtime.enrollments.get(idB);
      assert.equal(revoked?.status, 'revoked');
      assert.deepEqual(revoked?.modelAuthorizations, []);

      // Catalog marks revoked environment ineligible
      await waitFor(async () => {
        const entry = hB.runtime.environmentCatalog.entries().find((e) => e.instanceId === instanceIdB);
        return entry?.eligible === false;
      }, 'catalog entry ineligible on revocation');
    } finally {
      await hB.close();
    }
  });
}
