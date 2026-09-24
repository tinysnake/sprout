import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
  test(`#129 ${backend}: ordered pre-acceptance selection and post-acceptance failure non-replay (Scenario 16)`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-129-scenario16-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({
      backend,
      directory,
      engineId: 'scripted',
      agents: [
        {
          ...agent('ordered-agent'),
          engine: 'scripted',
          model: 'model-two',
          workOptions: [
            { id: 'opt-1', engine: 'codex', workModel: 'model-one', effort: 'high' },
            { id: 'opt-2', engine: 'scripted', workModel: 'model-two', effort: 'medium' },
          ],
        },
      ],
    });
    try {
      const id = (await h.runtime.enrollments.list())[0]!.id;
      await h.runtime.agentService.create({
        id: 'ordered-agent',
        displayName: 'Ordered Agent',
        workOptions: [
          { id: 'opt-1', engine: 'codex', workModel: 'model-one', effort: 'high' },
          { id: 'opt-2', engine: 'scripted', workModel: 'model-two', effort: 'medium' },
        ],
      });

      const authorityProject = await h.runtime.projectService.create({
        displayName: 'Scenario 16 Project',
        goal: 'Verify pre-acceptance ordered walk and post-acceptance non-replay.',
        agentMemberships: [{ agentId: 'ordered-agent' }],
      });

      const scriptedSuccessEvents = [{ type: 'message' as const, text: 'scripted-turn-done', final: true }];
      const scriptedAdapter = new ScriptedEngineAdapter({
        turns: [{ events: scriptedSuccessEvents, result: { status: 'completed' as const, text: 'scripted-turn-done' } }],
      });

      let probeCounter = 0;
      let codexInstalled = false;

      await h.connect(
        id,
        join(directory, 'worker-key.pem'),
        {
          engines: new Map([['scripted', scriptedAdapter]]),
          readinessProbe: async (params) => {
            probeCounter += 1;
            const probe = {
              at: 95_000 + probeCounter,
              latencyMs: 1,
              protocolOk: true,
              enginesOk: true,
              source: 'worker' as const,
              version: '3',
              summary: 'scenario-16 probe',
            };
            const revision = params.requirements?.revisionsByEngine?.scripted ?? params.requirements?.revision;
            return {
              readiness: {
                protocolVersion: WORKER_PROTOCOL_VERSION,
                probe,
                engines: [
                  {
                    engine: 'codex',
                    installed: codexInstalled,
                    readiness: codexInstalled ? ('ready' as const) : ('missing' as const),
                    modelAvailability: codexInstalled ? ('available' as const) : ('none' as const),
                    models: codexInstalled ? ['model-one'] : [],
                    targetModels: codexInstalled ? ['model-one'] : [],
                    modelIdPresent: codexInstalled,
                  },
                  {
                    engine: 'scripted',
                    installed: true,
                    readiness: 'ready' as const,
                    modelAvailability: 'available' as const,
                    models: ['model-two'],
                    targetModels: ['model-two'],
                    modelIdPresent: true,
                    probedAt: 1,
                    probeExitCode: 0,
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

      // 1. Pre-acceptance ordered walk:
      // Option 1 (Codex) is missing; Option 2 (Scripted) is ready and available.
      codexInstalled = false;
      await triggerProbe();

      const compatResponse = await fetch(`${h.base}/api/agents/ordered-agent/compatibility`, {
        headers: { cookie: h.cookie },
      });
      const compat = (await compatResponse.json()) as {
        available: boolean;
        firstAvailable?: { engine: string; workModel: string };
        options: readonly { state: string }[];
      };
      assert.equal(compat.available, true);
      assert.equal(compat.options[0]?.state, 'missing', 'option 1 is missing');
      assert.equal(compat.options[1]?.state, 'available', 'option 2 is available');
      assert.equal(compat.firstAvailable?.engine, 'scripted', 'first available option is scripted');

      // Submit run: admission walks in order, skips missing option 1, and admits option 2 before engine acceptance.
      let run = await h.runtime.orchestrator.submit({ agentId: 'ordered-agent', prompt: 'hi', projectId: authorityProject.id });
      let settled = await h.runtime.orchestrator.waitFor(run.id);
      assert.equal(settled.status, 'completed', `run failed: ${settled.failure}`);
      assert.equal(settled.workOption?.engine, 'scripted');
      assert.equal(settled.workOption?.workModel, 'model-two');
      assert.equal(scriptedAdapter.requests.length, 1);

      // 2. Post-acceptance failure non-replay:
      const fallbackEvents = [{ type: 'message' as const, text: 'fallback-executed', final: true }];
      const fallbackAdapter = new ScriptedEngineAdapter({
        turns: [{ events: fallbackEvents, result: { status: 'completed' as const, text: 'fallback-executed' } }],
      });
      Object.assign(fallbackAdapter, { id: 'scripted-fallback' });
      const failingAdapter = new ScriptedEngineAdapter({
        turns: [{ events: [], result: { status: 'failed' as const, message: 'engine crashed during execution' } }],
      });
      Object.assign(failingAdapter, { id: 'scripted-failing' });

      const subDir = join(directory, 'sub-scenario16');
      mkdirSync(subDir, { recursive: true });
      const h2 = await readinessWorkflowHarness({
        backend,
        directory: subDir,
        engineId: 'scripted-failing',
        agents: [
          {
            ...agent('fail-agent'),
            engine: 'scripted-failing',
            workOptions: [
              { id: 'opt-f1', engine: 'scripted-failing', workModel: 'model-fail', effort: 'medium' },
              { id: 'opt-f2', engine: 'scripted-fallback', workModel: 'model-fallback', effort: 'low' },
            ],
          },
        ],
      });
      try {
        const id2 = (await h2.runtime.enrollments.list())[0]!.id;
        await h2.runtime.agentService.create({
          id: 'fail-agent',
          displayName: 'Fail Agent',
          workOptions: [
            { id: 'opt-f1', engine: 'scripted-failing', workModel: 'model-fail', effort: 'medium' },
            { id: 'opt-f2', engine: 'scripted-fallback', workModel: 'model-fallback', effort: 'low' },
          ],
        });
        const proj2 = await h2.runtime.projectService.create({
          displayName: 'Fail Project',
          goal: 'Verify post-acceptance no replay.',
          agentMemberships: [{ agentId: 'fail-agent' }],
        });

        await h2.connect(
          id2,
          join(subDir, 'worker-key.pem'),
          {
            engines: new Map([
              ['scripted-failing', failingAdapter],
              ['scripted-fallback', fallbackAdapter],
            ]),
            readinessProbe: async (params) => {
              const probe = {
                at: 99_000,
                latencyMs: 1,
                protocolOk: true,
                enginesOk: true,
                source: 'worker' as const,
                version: '3',
                summary: 'post-acceptance probe',
              };
              const revFailing = params.requirements?.revisionsByEngine?.['scripted-failing'] ?? params.requirements?.revision;
              const revFallback = params.requirements?.revisionsByEngine?.['scripted-fallback'] ?? params.requirements?.revision;
              return {
                readiness: {
                  protocolVersion: WORKER_PROTOCOL_VERSION,
                  probe,
                  engines: [
                    {
                      engine: 'scripted-failing',
                      installed: true,
                      readiness: 'ready' as const,
                      modelAvailability: 'available' as const,
                      models: ['model-fail'],
                      targetModels: ['model-fail'],
                      modelIdPresent: true,
                      probedAt: 1,
                      probeExitCode: 0,
                      ...(revFailing !== undefined ? { requirementRevision: revFailing } : {}),
                    },
                    {
                      engine: 'scripted-fallback',
                      installed: true,
                      readiness: 'ready' as const,
                      modelAvailability: 'available' as const,
                      models: ['model-fallback'],
                      targetModels: ['model-fallback'],
                      modelIdPresent: true,
                      probedAt: 1,
                      probeExitCode: 0,
                      ...(revFallback !== undefined ? { requirementRevision: revFallback } : {}),
                    },
                  ],
                },
                probe,
              };
            },
          },
        );
        await waitFor(() => h2.runtime.workerGateway.liveFor(INSTANCE_ID) !== undefined, 'accepted channel h2');
        await h2.runtime.projectAccess.grant({
          projectId: proj2.id,
          environmentInstanceId: INSTANCE_ID,
          selection: { kind: 'default' },
        });

        const postProbe2 = await fetch(`${h2.base}/api/environments/enrollments/${id2}/probes`, {
          method: 'POST',
          headers: { cookie: h2.cookie, 'x-sprout-csrf': h2.csrf, 'content-type': 'application/json' },
          body: '{}',
        });
        assert.equal(postProbe2.status, 201);

        const failRun = await h2.runtime.orchestrator.submit({ agentId: 'fail-agent', prompt: 'hi', projectId: proj2.id });
        const failSettled = await h2.runtime.orchestrator.waitFor(failRun.id);
        assert.equal(failSettled.status, 'failed');
        assert.match(failSettled.failure ?? '', /the engine turn failed|engine crashed during execution/);
        assert.equal(failSettled.workOption?.engine, 'scripted-failing', 'run stayed on its admitted option');

        assert.equal(failingAdapter.requests.length, 1, 'the primary engine was accepted and attempted');
        assert.equal(fallbackAdapter.requests.length, 0, 'the fallback engine was NEVER started or replayed after acceptance');
      } finally {
        await h2.close();
      }
    } finally {
      await h.close();
    }
  });
}
