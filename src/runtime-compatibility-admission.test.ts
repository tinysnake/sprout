import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedEngineAdapter } from './engine/scripted.ts';
import { WORKER_PROTOCOL_VERSION } from './worker/protocol.ts';
import {
  agent,
  INSTANCE_ID,
  readinessWorkflowHarness,
  waitFor,
} from './runtime-test-harness.ts';

for (const backend of ['memory', 'sqlite'] as const) {
  test(`#129 ${backend}: ready, unknown, missing, login-required, and model-unavailable observations align compatibility explanations with admission (Scenario 14)`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-129-scenario14-'));
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
        displayName: 'Scenario 14 Project',
        goal: 'Verify compatibility and admission parity.',
        agentMemberships: [{ agentId: 'scout' }],
      });

      let currentMode: 'ready' | 'unknown' | 'missing' | 'login-required' | 'model-unavailable' | 'unrequired-pi-degraded' = 'ready';
      let probeCounter = 0;

      const successEvents = [{ type: 'message' as const, text: 'done', final: true }];
      const successAdapter = new ScriptedEngineAdapter({
        turns: [{ events: successEvents, result: { status: 'completed' as const, text: 'done' } }],
      });
      Object.assign(successAdapter, { id: 'codex' });

      await h.connect(
        id,
        join(directory, 'worker-key.pem'),
        {
          engines: new Map([['codex', successAdapter]]),
          readinessProbe: async (params) => {
            probeCounter += 1;
            const probe = {
              at: 80_000 + probeCounter,
              latencyMs: 1,
              protocolOk: true,
              enginesOk: true,
              source: 'worker' as const,
              version: '3',
              summary: `scenario-14 probe ${currentMode}`,
            };
            const revision = params.requirements?.revisionsByEngine?.codex ?? params.requirements?.revision;

            if (currentMode === 'ready') {
              // Synthetic known-ready positive control (gate verification, not live entitlement proof)
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
            }

            if (currentMode === 'unknown') {
              // Required model availability unknown (strict unknown fact)
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

            if (currentMode === 'missing') {
              // Engine uninstalled / missing
              return {
                readiness: {
                  protocolVersion: WORKER_PROTOCOL_VERSION,
                  probe,
                  engines: [
                    {
                      engine: 'codex',
                      installed: false,
                      readiness: 'missing' as const,
                      modelAvailability: 'none' as const,
                      models: [],
                      probedAt: 1,
                      probeExitCode: 1,
                    },
                  ],
                },
                probe,
              };
            }

            if (currentMode === 'login-required') {
              // Engine requires login
              return {
                readiness: {
                  protocolVersion: WORKER_PROTOCOL_VERSION,
                  probe,
                  engines: [
                    {
                      engine: 'codex',
                      installed: true,
                      authenticated: false,
                      readiness: 'login-required' as const,
                      modelAvailability: 'none' as const,
                      models: [],
                      probedAt: 1,
                      probeExitCode: 1,
                    },
                  ],
                },
                probe,
              };
            }

            if (currentMode === 'model-unavailable') {
              // Model is not available for engine
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
                      models: ['other-model'],
                      targetModels: ['target-model'],
                      modelIdPresent: false,
                      probedAt: 1,
                      probeExitCode: 0,
                      ...(revision !== undefined ? { requirementRevision: revision } : {}),
                    },
                  ],
                },
                probe,
              };
            }

            // unrequired-pi-degraded mode: Codex is ready (positive control), Pi is degraded (missing)
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
                  {
                    engine: 'pi',
                    installed: false,
                    readiness: 'missing' as const,
                    modelAvailability: 'none' as const,
                    models: [],
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
        const text = await post.text();
        assert.equal(post.status, 201, text);
      };

      const getCompatibility = async () => {
        const response = await fetch(`${h.base}/api/agents/scout/compatibility`, {
          headers: { cookie: h.cookie },
        });
        assert.equal(response.status, 200);
        return (await response.json()) as {
          available: boolean;
          unavailableReason?: string;
          explanation?: string;
          options: readonly { option: unknown; state: string; reason: string }[];
        };
      };

      // 1. Ready state: synthetic known-ready positive control
      currentMode = 'ready';
      await triggerProbe();
      let compat = await getCompatibility();
      assert.equal(compat.available, true);
      assert.equal(compat.options[0]?.state, 'available');
      assert.match(compat.options[0]?.reason ?? '', /ready with the option's work model/);
      assert.match(compat.explanation ?? '', /Compatibility reflects engine and model readiness only/);
      let admission = await h.runtime.orchestrator.evaluateOptionAdmission('scout', INSTANCE_ID);
      assert.equal(admission.ok, true);

      let submitReady = await h.runtime.orchestrator.submit({ agentId: 'scout', prompt: 'hi', projectId: authorityProject.id });
      let settledReady = await h.runtime.orchestrator.waitFor(submitReady.id);
      assert.equal(settledReady.status, 'completed', `ready failed: ${settledReady.failure}`);
      assert.equal(settledReady.workOption?.workModel, 'target-model');

      // 2. Unknown model state: required unknown model
      currentMode = 'unknown';
      await triggerProbe();
      compat = await getCompatibility();
      assert.equal(compat.available, false, 'a required unknown model never appears available in compatibility');
      assert.equal(compat.options[0]?.state, 'unknown');
      assert.match(compat.options[0]?.reason ?? '', /availability is unknown for "codex"/);
      assert.equal(compat.unavailableReason, compat.options[0]?.reason);

      admission = await h.runtime.orchestrator.evaluateOptionAdmission('scout', INSTANCE_ID);
      assert.equal(admission.ok, false);
      assert.equal(admission.reason, compat.options[0]?.reason, 'compatibility and admission explanations agree for unknown model');

      let submitResult = await h.runtime.orchestrator.submit({ agentId: 'scout', prompt: 'hi', projectId: authorityProject.id });
      let settled = await h.runtime.orchestrator.waitFor(submitResult.id);
      assert.equal(settled.status, 'failed');
      assert.match(settled.failure ?? '', /no available environment for capability: agent-run/);

      // 3. Missing state: engine not installed
      currentMode = 'missing';
      await triggerProbe();
      compat = await getCompatibility();
      assert.equal(compat.available, false);
      assert.equal(compat.options[0]?.state, 'missing');
      assert.match(compat.options[0]?.reason ?? '', /is not installed/);
      assert.equal(compat.unavailableReason, compat.options[0]?.reason);

      admission = await h.runtime.orchestrator.evaluateOptionAdmission('scout', INSTANCE_ID);
      assert.equal(admission.ok, false);
      assert.equal(admission.reason, compat.options[0]?.reason, 'compatibility and admission explanations agree for missing engine');

      submitResult = await h.runtime.orchestrator.submit({ agentId: 'scout', prompt: 'hi', projectId: authorityProject.id });
      settled = await h.runtime.orchestrator.waitFor(submitResult.id);
      assert.equal(settled.status, 'failed');
      assert.match(settled.failure ?? '', /no available environment for capability: agent-run/);

      // 4. Login-required state: engine requires login
      currentMode = 'login-required';
      await triggerProbe();
      compat = await getCompatibility();
      assert.equal(compat.available, false);
      assert.equal(compat.options[0]?.state, 'login-required');
      assert.match(compat.options[0]?.reason ?? '', /requires a login/);
      assert.equal(compat.unavailableReason, compat.options[0]?.reason);

      admission = await h.runtime.orchestrator.evaluateOptionAdmission('scout', INSTANCE_ID);
      assert.equal(admission.ok, false);
      assert.equal(admission.reason, compat.options[0]?.reason, 'compatibility and admission explanations agree for login-required');

      submitResult = await h.runtime.orchestrator.submit({ agentId: 'scout', prompt: 'hi', projectId: authorityProject.id });
      settled = await h.runtime.orchestrator.waitFor(submitResult.id);
      assert.equal(settled.status, 'failed');
      assert.match(settled.failure ?? '', /no available environment for capability: agent-run/);

      // 5. Model-unavailable state: model not supported
      currentMode = 'model-unavailable';
      await triggerProbe();
      compat = await getCompatibility();
      assert.equal(compat.available, false);
      assert.equal(compat.options[0]?.state, 'model-unavailable');
      assert.match(compat.options[0]?.reason ?? '', /is not available for "codex"/);
      assert.equal(compat.unavailableReason, compat.options[0]?.reason);

      admission = await h.runtime.orchestrator.evaluateOptionAdmission('scout', INSTANCE_ID);
      assert.equal(admission.ok, false);
      assert.equal(admission.reason, compat.options[0]?.reason, 'compatibility and admission explanations agree for model-unavailable');

      submitResult = await h.runtime.orchestrator.submit({ agentId: 'scout', prompt: 'hi', projectId: authorityProject.id });
      settled = await h.runtime.orchestrator.waitFor(submitResult.id);
      assert.equal(settled.status, 'failed');
      assert.match(settled.failure ?? '', /no available environment for capability: agent-run/);

      // 6. Independent facts & non-required degradation (AC 3)
      currentMode = 'unrequired-pi-degraded';
      await triggerProbe();

      const getReadiness = await fetch(`${h.base}/api/environments/enrollments/${id}/readiness`, {
        headers: { cookie: h.cookie },
      });
      assert.equal(getReadiness.status, 200);
      const readBody = (await getReadiness.json()) as {
        readiness: {
          connection: { state: string };
          compatibility: { state: string };
          workSafety: { state: string };
          capabilities: readonly { name: string; permission: string }[];
          summary: { level: string; reason: string };
          engines: readonly {
            engine: string;
            installed: boolean;
            readiness: string;
            authenticated?: boolean;
            modelIdPresent?: boolean;
            targetModels?: readonly string[];
          }[];
        };
      };

      // Assert independent facts are preserved
      assert.equal(readBody.readiness.connection.state, 'online', 'connectivity is independent fact');
      assert.equal(readBody.readiness.compatibility.state, 'compatible', 'protocol is independent fact');
      assert.equal(readBody.readiness.workSafety.state, 'clear', 'work-safety is independent fact');
      assert.equal(readBody.readiness.capabilities.find((c) => c.name === 'agent-run')?.permission, 'allowed');
      const codexFact = readBody.readiness.engines.find((e) => e.engine === 'codex')!;
      const piFact = readBody.readiness.engines.find((e) => e.engine === 'pi')!;
      assert.equal(codexFact.installed, true, 'executable presence is independent fact');
      assert.equal(piFact.installed, false);
      assert.equal(codexFact.authenticated, true, 'authentication is independent fact');
      assert.equal(codexFact.modelIdPresent, true, 'local catalog is independent fact');

      // Environment health is Yellow due to unrequired Pi degradation
      assert.equal(readBody.readiness.summary.level, 'yellow');
      assert.match(readBody.readiness.summary.reason, /pi/i);

      // But required Codex option remains eligible, available, and admits to completion!
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, true, 'non-required degradation does not block catalog eligibility');
      compat = await getCompatibility();
      assert.equal(compat.available, true, 'non-required degradation does not block compatibility of required option');
      assert.equal(compat.options[0]?.state, 'available');

      submitResult = await h.runtime.orchestrator.submit({ agentId: 'scout', prompt: 'hi', projectId: authorityProject.id });
      settled = await h.runtime.orchestrator.waitFor(submitResult.id);
      assert.equal(settled.status, 'completed', 'required compatible option runs to completion despite non-required degradation');
      assert.equal(settled.workOption?.engine, 'codex');
    } finally {
      await h.close();
    }
  });
}
