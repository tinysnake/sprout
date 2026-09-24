import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMISSION_CAPABILITY, admissionRefusal } from './environment/catalog.ts';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import { WORKER_PROTOCOL_VERSION } from './worker/protocol.ts';
import {
  agent,
  INSTANCE_ID,
  readinessWorkflowHarness,
  waitFor,
  testComposition,
} from './runtime-test-harness.ts';

for (const backend of ['memory', 'sqlite'] as const) {
  test(`#129 ${backend}: synthetic known-ready positive control admits while required unknown refuses, and compatible options remain blockable (Scenario 15)`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-129-scenario15-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      engineId: 'codex',
      agents: [{ ...agent('scout'), engine: 'codex', model: 'target-model' }],
    });
    try {
      const id = (await h.runtime.enrollments.list())[0]!.id;
      await h.runtime.agentService.create({
        id: 'scout',
        displayName: 'Scout',
        workOptions: [{ engine: 'codex', workModel: 'target-model', effort: 'medium' }],
      });

      const authorityProject = await h.runtime.projectService.create({
        displayName: 'Scenario 15 Project',
        goal: 'Verify synthetic control vs unknown and authority/lease blocks.',
        agentMemberships: [{ agentId: 'scout' }],
      });

      let mode: 'unknown' | 'synthetic-ready' = 'unknown';
      let probeCounter = 0;
      const successEvents = [{ type: 'message' as const, text: 'success-done', final: true }];
      const adapter = new ScriptedEngineAdapter({
        turns: [{ events: successEvents, result: { status: 'completed' as const, text: 'success-done' } }],
      });
      Object.assign(adapter, { id: 'codex' });

      await h.connect(
        id,
        join(directory, 'worker-key.pem'),
        {
          engines: new Map([['codex', adapter]]),
          readinessProbe: async (params) => {
            probeCounter += 1;
            const probe = {
              at: 90_000 + probeCounter,
              latencyMs: 1,
              protocolOk: true,
              enginesOk: true,
              source: 'worker' as const,
              version: '3',
              summary: 'scenario-15 probe',
            };
            const revision = params.requirements?.revisionsByEngine?.codex ?? params.requirements?.revision;
            if (mode === 'unknown') {
              return {
                readiness: {
                  protocolVersion: WORKER_PROTOCOL_VERSION,
                  probe,
                  engines: [
                    {
                      engine: 'codex',
                      installed: true,
                      authenticated: true,
                      readiness: 'ready' as const,
                      modelAvailability: 'unknown' as const,
                      models: [],
                      targetModels: ['target-model'],
                      modelIdPresent: true,
                      probedAt: 1,
                      probeExitCode: 0,
                      source: 'codex-account-read',
                      ...(revision !== undefined ? { requirementRevision: revision } : {}),
                    },
                  ],
                },
                probe,
              };
            }
            // Synthetic target-bound known-ready gate control: this proves the gate
            // can admit established evidence, not that live account entitlement is provable (#123 §6, #129 AC5).
            return {
              readiness: {
                protocolVersion: WORKER_PROTOCOL_VERSION,
                probe,
                engines: [
                  {
                    engine: 'codex',
                    installed: true,
                    authenticated: true,
                    readiness: 'ready' as const,
                    modelAvailability: 'available' as const,
                    models: ['target-model'],
                    targetModels: ['target-model'],
                    modelIdPresent: true,
                    probedAt: 1,
                    probeExitCode: 0,
                    source: 'codex-account-read',
                    ...(revision !== undefined ? { requirementRevision: revision } : {}),
                  },
                ],
              },
              probe,
            };
          },
        },
      );
      await waitFor(() => h.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel');
      await h.runtime.projectAccess.grant({
        projectId: authorityProject.id,
        environmentInstanceId: INSTANCE_ID,
        selection: { kind: 'default' },
      });

      const triggerProbe = async () => {
        const post = await fetch(`${h.base}/api/environments/enrollments/${id}/probes`, {
          method: 'POST',
          headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
          body: '{}',
        });
        assert.equal(post.status, 201);
      };

      // 1. Strict required-unknown refusal:
      mode = 'unknown';
      await triggerProbe();
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false);

      const optionAdm = await h.runtime.orchestrator.evaluateOptionAdmission('scout', INSTANCE_ID);
      assert.equal(optionAdm.ok, false);
      assert.match(optionAdm.reason ?? '', /availability is unknown for "codex"/);

      let run = await h.runtime.orchestrator.submit({ agentId: 'scout', prompt: 'hi', projectId: authorityProject.id });
      let settled = await h.runtime.orchestrator.waitFor(run.id);
      assert.equal(settled.status, 'failed');
      assert.match(settled.failure ?? '', /no available environment for capability: agent-run/);

      // 2. Synthetic known-ready positive control admits through the same composed Runtime/WorkerGateway channel:
      mode = 'synthetic-ready';
      await triggerProbe();
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, true);
      run = await h.runtime.orchestrator.submit({ agentId: 'scout', prompt: 'hi', projectId: authorityProject.id });
      settled = await h.runtime.orchestrator.waitFor(run.id);
      assert.equal(settled.status, 'completed', `synthetic known-ready control admits: ${settled.failure ?? 'none'}`);
      assert.equal(settled.workOption?.workModel, 'target-model');

      // 3. Independent blocking of compatible option by lifecycle, current authority, permissions, leases (AC 4):
      // 3a. Work safety / active lease conflict block
      const held = h.runtime.pool.acquireLease({
        instanceId: INSTANCE_ID,
        capability: 'agent-run',
        holderId: 'competing-task',
        ttlMs: 60_000,
      });
      assert.equal(held.ok, true);
      run = await h.runtime.orchestrator.submit({ agentId: 'scout', prompt: 'hi', projectId: authorityProject.id });
      settled = await h.runtime.orchestrator.waitFor(run.id);
      assert.equal(settled.status, 'failed');
      h.runtime.pool.releaseLease(held.lease.id);

      // 3b. Capability permission block
      await h.runtime.enrollments.setCapabilityPermission(id, ADMISSION_CAPABILITY, false);
      await h.runtime.refreshEnvironmentCatalog();
      let entry = h.runtime.environmentCatalog.entry(INSTANCE_ID)!;
      assert.equal(entry.eligible, false);
      let refusal = admissionRefusal(entry);
      assert.equal(refusal.ok, false);
      run = await h.runtime.orchestrator.submit({ agentId: 'scout', prompt: 'hi', projectId: authorityProject.id });
      settled = await h.runtime.orchestrator.waitFor(run.id);
      assert.equal(settled.status, 'failed');

      // 3c. Current authority / disconnect block
      const accepted = h.runtime.workerGateway.liveFor(INSTANCE_ID);
      if (accepted !== undefined) testComposition(h.runtime).workerGateway.liveFor(INSTANCE_ID)?.close();
      assert.equal(h.runtime.workerGateway.liveFor(INSTANCE_ID), undefined);

      // 3d. Lifecycle revocation block
      await h.runtime.enrollments.revoke(id, 'revoked by test');
      await h.runtime.refreshEnvironmentCatalog();
      entry = h.runtime.environmentCatalog.entry(INSTANCE_ID)!;
      assert.equal(entry.eligible, false);
      refusal = admissionRefusal(entry);
      assert.equal(refusal.ok, false);
      if (!refusal.ok) assert.equal(refusal.reason, 'revoked');
      run = await h.runtime.orchestrator.submit({ agentId: 'scout', prompt: 'hi', projectId: authorityProject.id });
      settled = await h.runtime.orchestrator.waitFor(run.id);
      assert.equal(settled.status, 'failed');
    } finally {
      await h.close();
    }
  });

  test(`#129 ${backend}: API Agent creation and reconfiguration drive accepted-channel admission`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-129-current-agent-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({ backend, directory, engineId: 'scripted', agents: [] });
    try {
      const api = async (path: string, body: unknown) => fetch(`${h.base}${path}`, {
        method: 'POST', headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const first = { id: 'ready', engine: 'scripted', workModel: 'model-two', effort: 'medium' };
      const missing = { id: 'missing', engine: 'codex', workModel: 'model-one', effort: 'high' };
      assert.equal((await api('/api/agents', { id: 'api-agent', displayName: 'API Agent', workOptions: [first] })).status, 201);
      const project = await h.runtime.projectService.create({ displayName: 'API project', goal: 'Current admission',
        agentMemberships: [{ agentId: 'api-agent' }] });
      const id = (await h.runtime.enrollments.list())[0]!.id;
      const adapter = new ScriptedEngineAdapter({ turns: [
        { events: [], result: { status: 'completed' as const, text: 'ok' } },
        { events: [], result: { status: 'completed' as const, text: 'ok' } },
      ] });
      await h.connect(id, join(directory, 'worker-key.pem'), {
        engines: new Map([['scripted', adapter]]),
        readinessProbe: async (params) => {
          const probe = { at: Date.now(), latencyMs: 1, protocolOk: true, enginesOk: true,
            source: 'worker' as const, version: '3', summary: 'current agent' };
          const revision = params.requirements?.revisionsByEngine?.scripted ?? params.requirements?.revision;
          return { probe, readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, probe, engines: [
            { engine: 'scripted', installed: true, readiness: 'ready' as const,
              modelAvailability: 'available' as const, models: ['model-two'], targetModels: ['model-two'],
              modelIdPresent: true, probedAt: 1, probeExitCode: 0,
              ...(revision !== undefined ? { requirementRevision: revision } : {}) },
            { engine: 'codex', installed: false, readiness: 'missing' as const,
              modelAvailability: 'none' as const, models: [], targetModels: [], modelIdPresent: false },
          ] } };
        },
      });
      await waitFor(() => h.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel');
      await h.runtime.projectAccess.grant({ projectId: project.id, environmentInstanceId: INSTANCE_ID,
        selection: { kind: 'default' } });
      const probe = async () => assert.equal((await api(`/api/environments/enrollments/${id}/probes`, {})).status, 201);
      await probe();
      const run = async (version: number) => {
        const response = await fetch(`${h.base}/api/agents/api-agent/compatibility`, { headers: { cookie: h.cookie } });
        const compatibility = await response.json() as { available: boolean; firstAvailable?: { workModel: string } };
        assert.equal(compatibility.available, true);
        assert.equal(compatibility.firstAvailable?.workModel, 'model-two');
        const submitted = await h.runtime.orchestrator.submit({ agentId: 'api-agent', prompt: 'hi', projectId: project.id });
        const settled = await h.runtime.orchestrator.waitFor(submitted.id);
        assert.equal(settled.status, 'completed', `run failed: ${settled.failure}`);
        assert.equal(settled.configurationVersion, version);
        assert.equal(settled.workOption?.workModel, 'model-two');
      };
      await run(1);
      assert.equal((await api('/api/agents/api-agent/configuration', {
        displayName: 'API Agent', workOptions: [missing, first], reason: 'change priority',
      })).status, 200);
      await probe();
      await run(2);
    } finally { await h.close(); }
  });
}
