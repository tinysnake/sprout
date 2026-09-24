import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentOptions, effectiveWorkOptions } from './agent/model.ts';
import { readinessRequirements, targetEvidenceSatisfiesRequirements } from './environment/readiness.ts';
import { WORKER_PROTOCOL_VERSION, type WorkerReadinessProbeParams } from './worker/protocol.ts';
import {
  agent,
  INSTANCE_ID,
  readinessWorkflowHarness,
  waitFor,
} from './runtime-test-harness.ts';

for (const backend of ['memory', 'sqlite'] as const) {
  test(`#128 ${backend}: an unrelated Pi edit retains Codex target evidence on the accepted channel`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-128-independent-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({ backend, directory, agents: [
      { ...agent('codex-agent'), engine: 'codex', model: 'codex-model' },
      { ...agent('pi-agent'), engine: 'pi', model: 'pi-old' },
    ] });
    try {
      const id = (await h.runtime.enrollments.list())[0]!.id;
      const requests: WorkerReadinessProbeParams[] = [];
      await h.runtime.agentService.create({ id: 'pi-agent', displayName: 'Pi Agent',
        workOptions: [{ engine: 'pi', workModel: 'pi-old', effort: 'medium' }] });
      await h.connect(id, join(directory, 'worker-key.pem'), { readinessProbe: async (params) => {
        requests.push(params);
        const probe = { at: 42_000 + requests.length, latencyMs: 2, protocolOk: true,
          enginesOk: true, source: 'worker' as const, version: '3', summary: 'scoped evidence' };
        return { readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, probe, engines: [
          { engine: 'codex', installed: true, authenticated: true, readiness: 'ready',
            modelAvailability: 'available', models: ['codex-model'], targetModels: ['codex-model'],
            modelIdPresent: true, requirementRevision: params.requirements!.revisionsByEngine!.codex! },
          { engine: 'pi', installed: true, readiness: 'unknown', modelAvailability: 'unknown',
            models: [], targetModels: [], modelIdPresent: false,
            requirementRevision: params.requirements!.revisionsByEngine!.pi! },
        ] }, probe };
      } });
      await waitFor(() => requests.length > 0, 'initial scoped request');
      const post = (path: string, body: object) => fetch(`${h.base}${path}`, { method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: JSON.stringify(body) });
      assert.equal((await post(`/api/environments/enrollments/${id}/probes`, {})).status, 201);
      const old = (await h.runtime.stores.environmentReadiness.getCurrentObservation(INSTANCE_ID))!;
      const codex = old.readiness.engines.find((engine) => engine.engine === 'codex')!;
      assert.equal(codex.requirementRevision, old.requirements?.revisionsByEngine?.codex);
      const edit = await post('/api/agents/pi-agent/configuration', { displayName: 'Pi Agent',
        workOptions: [{ engine: 'pi', workModel: 'pi-new', effort: 'medium' }] });
      assert.equal(edit.status, 200);
      await h.runtime.refreshEnvironmentCatalog();

      // Before any fresh probe: resolve current core-owned requirements the same
      // way the runtime does (durable Agents over the configured seed), then prove
      // the committed pre-edit Codex evidence is still applicable to the
      // *current* Codex scope while the Pi revision has moved. This is a composed
      // read projection, not a raw current-readiness seed.
      const durableAgents = (await h.runtime.agentService.list()).filter((agent) => agent.status !== 'archived');
      const durableIds = new Set(durableAgents.map((agent) => agent.id));
      const currentScope = readinessRequirements([
        ...h.runtime.agents.list().filter((a) => !durableIds.has(a.id))
          .flatMap((a) => effectiveWorkOptions(a).map((option) => ({ ...option, id: a.id }))),
        ...durableAgents.flatMap((a) => currentOptions(a).map((option) => ({ ...option, id: a.id }))),
      ]);
      assert.deepEqual(currentScope.modelsByEngine, { codex: ['codex-model'], pi: ['pi-new'] },
        'the post-edit core-held scope is current');
      assert.equal(codex.requirementRevision, currentScope.revisionsByEngine?.codex,
        'pre-edit Codex evidence still matches the current Codex scope revision');
      assert.ok(targetEvidenceSatisfiesRequirements({ ...codex, required: true }, currentScope),
        'pre-edit Codex target evidence remains applicable before a fresh probe');
      assert.notEqual(old.requirements?.revisionsByEngine?.pi, currentScope.revisionsByEngine?.pi,
        'only the changed Pi revision moved');
      const catalogBeforeProbe = h.runtime.environmentCatalog.entry(INSTANCE_ID)!;
      assert.ok(catalogBeforeProbe.observed?.engines?.some((engine) => engine.engine === 'codex'),
        'the composed catalog projection still carries the pre-edit Codex evidence');

      const result = await post(`/api/environments/enrollments/${id}/probes`, {});
      assert.equal(result.status, 201);
      const fresh = (await h.runtime.stores.environmentReadiness.getCurrentObservation(INSTANCE_ID))!;
      assert.deepEqual(requests.at(-1)?.requirements?.modelsByEngine, {
        codex: ['codex-model'], pi: ['pi-new'],
      });
      assert.equal(fresh.requirements?.revisionsByEngine?.codex, old.requirements?.revisionsByEngine?.codex);
      assert.equal(fresh.readiness.engines.find((engine) => engine.engine === 'codex')?.requirementRevision,
        codex.requirementRevision, 'the independent Codex target remains applicable');
      assert.notEqual(fresh.requirements?.revisionsByEngine?.pi, old.requirements?.revisionsByEngine?.pi);
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false,
        'neutral Pi measurement cannot be promoted by Codex evidence');
    } finally { await h.close(); }
  });

  test(`#128 ${backend}: Pi-only and mixed targets stay engine-scoped and unsupported`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-128-pi-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({ backend, directory,
      agents: [{ ...agent('scout'), engine: 'pi', model: 'pi-model' }] });
    try {
      const id = (await h.runtime.enrollments.list())[0]!.id;
      const requests: WorkerReadinessProbeParams[] = [];
      await h.connect(id, join(directory, 'worker-key.pem'), { readinessProbe: async (params) => {
        requests.push(params);
        const probe = { at: Date.now(), latencyMs: 1, protocolOk: true, enginesOk: true,
          source: 'worker' as const, version: '3', summary: 'Pi unsupported measurement' };
        return { readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, probe, engines: [
          { engine: 'pi', installed: true, readiness: 'unknown', modelAvailability: 'unknown', models: [],
            targetModels: [], modelIdPresent: false,
            ...(params.requirements?.revisionsByEngine?.pi !== undefined ? { requirementRevision: params.requirements.revisionsByEngine.pi } : {}) },
          ...(params.requirements?.modelsByEngine?.codex?.length ? [{ engine: 'codex', installed: true,
            readiness: 'ready' as const, modelAvailability: 'available' as const,
            models: [...params.requirements.modelsByEngine.codex], targetModels: [...params.requirements.modelsByEngine.codex],
            modelIdPresent: true, ...(params.requirements.revisionsByEngine?.codex !== undefined
              ? { requirementRevision: params.requirements.revisionsByEngine.codex } : {}) }] : []),
        ] }, probe };
      } });
      const post = () => fetch(`${h.base}/api/environments/enrollments/${id}/probes`, { method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' }, body: '{}' });
      assert.equal((await post()).status, 201);
      assert.deepEqual(requests.at(-1)?.requirements?.modelsByEngine?.pi, ['pi-model']);
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false);
      const add = await fetch(`${h.base}/api/agents`, { method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'codex-agent', displayName: 'Codex Agent',
          workOptions: [{ engine: 'codex', workModel: 'codex-model', effort: 'medium' }] }) });
      assert.equal(add.status, 201);
      assert.equal((await post()).status, 201);
      assert.deepEqual(requests.at(-1)?.requirements?.modelsByEngine?.pi, ['pi-model']);
      assert.deepEqual(requests.at(-1)?.requirements?.modelsByEngine?.codex, ['codex-model']);
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false,
        'Codex local catalog cannot turn unsupported Pi measurement into eligibility');
    } finally { await h.close(); }
  });

  test(`#128 ${backend}: an unrequired degraded engine stays inspectable and does not reject the required Codex option`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-128-unrequired-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    // Only Codex is a configured work option, so Pi is measured but unrequired.
    const h = await readinessWorkflowHarness({ backend, directory, engineId: 'codex',
      agents: [{ ...agent('codex-agent'), engine: 'codex', model: 'codex-model' }] });
    try {
      const id = (await h.runtime.enrollments.list())[0]!.id;
      const requests: WorkerReadinessProbeParams[] = [];
      await h.connect(id, join(directory, 'worker-key.pem'), { readinessProbe: async (params) => {
        requests.push(params);
        const probe = { at: 97_000, latencyMs: 2, protocolOk: true, enginesOk: true,
          source: 'worker' as const, version: '0.154.0', summary: 'required Codex plus unrequired Pi' };
        const codexTargets = params.requirements?.modelsByEngine?.codex ?? [];
        return { readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, probe, engines: [
          { engine: 'codex', installed: true, authenticated: true, readiness: 'ready',
            modelAvailability: 'available', models: [...codexTargets], targetModels: [...codexTargets],
            modelIdPresent: codexTargets.length > 0, probedAt: 5, probeExitCode: 0, source: 'codex-account-read',
            ...(params.requirements?.revisionsByEngine?.codex !== undefined
              ? { requirementRevision: params.requirements.revisionsByEngine.codex } : {}) },
          // A degraded, unrequired engine: installed but its login is unverified,
          // so its readiness is honestly `unknown` and no model is claimed.
          { engine: 'pi', installed: true, readiness: 'unknown', modelAvailability: 'unknown',
            models: [], targetModels: [], modelIdPresent: false },
        ] }, probe };
      } });
      await waitFor(() => requests.length > 0, 'scoped target request');
      const post = () => fetch(`${h.base}/api/environments/enrollments/${id}/probes`, { method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: JSON.stringify({ requiredModels: ['forged'], probe: { source: 'browser' } }) });
      const response = await post();
      const responseText = await response.text();
      assert.equal(response.status, 201, responseText);
      // The core never asks the Worker for an unrequired engine target, and never
      // asks it to enumerate Pi models (no Pi model-list operation).
      assert.deepEqual(requests.at(-1)?.requirements?.modelsByEngine, { codex: ['codex-model'] },
        'only the required Codex engine carries a target');

      // HTTP inspection keeps the independent Pi degradation visible.
      const get = await fetch(`${h.base}/api/environments/enrollments/${id}/readiness`, { headers: { cookie: h.cookie } });
      assert.equal(get.status, 200);
      const body = (await get.json()) as {
        readiness: { summary: { level: string; reason: string }; engines: readonly {
          engine: string; required: boolean; readiness: string; modelIdPresent?: boolean }[] } };
      const codex = body.readiness.engines.find((engine) => engine.engine === 'codex')!;
      const pi = body.readiness.engines.find((engine) => engine.engine === 'pi')!;
      assert.equal(codex.required, true, 'Codex is the required engine');
      assert.equal(codex.readiness, 'ready');
      assert.equal(pi.required, false, 'Pi is measured but unrequired');
      assert.equal(pi.readiness, 'unknown', 'Pi degradation stays an independent inspectable fact');
      assert.equal(pi.modelIdPresent, false, 'the Worker measured no Pi target presence; no entitlement is inferred');
      // A non-required degradation may be Yellow without blocking the option.
      assert.equal(body.readiness.summary.level, 'yellow', body.readiness.summary.reason);

      // The required Codex option admits despite the unrequired Pi degradation.
      const entry = h.runtime.environmentCatalog.entry(INSTANCE_ID)!;
      assert.equal(entry.eligible, true, 'the required Codex option remains eligible');
      // Synthetic target-bound known-ready gate control only, not live entitlement.
      assert.equal(entry.readiness.readiness.engines.find((engine) => engine.engine === 'pi')?.required, false);
    } finally { await h.close(); }
  });

  test(`#128 ${backend}: HTTP Agent edits fence held target evidence and preserve independent observations`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-128-edit-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({ backend, directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'model-a' }] });
    let release: (() => void) | undefined;
    try {
      const id = (await h.runtime.enrollments.list())[0]!.id;
      await h.runtime.agentService.create({ id: 'scout', displayName: 'Scout',
        workOptions: [{ engine: 'codex', workModel: 'model-a', effort: 'medium' }] });
      const post = (path: string, body: object) => fetch(`${h.base}${path}`, { method: 'POST',
        headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' },
        body: JSON.stringify(body) });
      const edit = async (model: string, displayName: string) => {
        const response = await post('/api/agents/scout/configuration', { displayName,
          workOptions: [{ engine: 'codex', workModel: model, effort: 'medium' }] });
        assert.equal(response.status, 200);
      };
      let started: (() => void) | undefined;
      const first = new Promise<void>((resolve) => { started = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const requests: WorkerReadinessProbeParams[] = [];
      await h.connect(id, join(directory, 'worker-key.pem'), { readinessProbe: async (params) => {
        requests.push(params);
        if (requests.length === 1) { started?.(); await gate; }
        const model = params.requirements?.modelsByEngine?.codex?.[0] ?? '';
        const probe = { at: Date.now(), latencyMs: 1, protocolOk: true, enginesOk: true,
          source: 'worker' as const, version: '3', summary: 'synthetic target measurement' };
        // Synthetic local-catalog gate control, not live entitlement evidence.
        return { readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, probe,
          engines: [{ engine: 'codex', installed: true, authenticated: true, readiness: 'ready',
            modelAvailability: 'available', models: [model], targetModels: [model], modelIdPresent: true,
            ...(params.requirements?.revisionsByEngine?.codex !== undefined
              ? { requirementRevision: params.requirements.revisionsByEngine.codex } : {}) }] }, probe };
      } });
      await first;
      assert.deepEqual(requests[0]?.requiredModels, ['model-a']);
      await edit('model-b', 'Scout');
      release?.();
      await waitFor(async () => (await h.runtime.enrollments.listProbes(id)).length === 1, 'held old-target receipt');
      await h.runtime.refreshEnvironmentCatalog();
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false);
      const old = (await h.runtime.stores.environmentReadiness.getCurrentObservation(INSTANCE_ID))!;
      assert.deepEqual(old.requirements?.modelsByEngine?.codex, ['model-a']);
      const response = await post(`/api/environments/enrollments/${id}/probes`, {
        requirements: { modelsByEngine: { codex: ['forged'] } }, connectionEpoch: 9000,
        probe: { source: 'browser', summary: 'forged' }, engines: [{ engine: 'codex', readiness: 'ready' }],
      });
      assert.equal(response.status, 201);
      assert.deepEqual(requests.at(-1)?.requiredModels, ['model-b']);
      const receipt = (await response.json()) as { receipt: { observationId: string; probe: { source: string } } };
      assert.equal(receipt.receipt.probe.source, 'worker');
      const current = (await h.runtime.stores.environmentReadiness.getCurrentObservation(INSTANCE_ID))!;
      assert.equal(current.observationId, receipt.receipt.observationId);
      assert.notEqual(current.observationId, old.observationId);
      assert.equal((await h.runtime.stores.environmentReadiness.listObservations(INSTANCE_ID)).length, 2);
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, true);
      await edit('model-b', 'Renamed Scout');
      await h.runtime.refreshEnvironmentCatalog();
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, true, 'metadata edit preserves target evidence');
      await edit('model-c', 'Renamed Scout');
      await h.runtime.refreshEnvironmentCatalog();
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false, 'post-success target edit invalidates evidence');
      assert.equal((await post(`/api/environments/enrollments/${id}/probes`, {})).status, 201);
      assert.deepEqual(requests.at(-1)?.requiredModels, ['model-c']);
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, true);
    } finally { release?.(); await h.close(); }
  });

  test(`#128 ${backend}: durable Agent edits bind each fresh authenticated probe to current targets`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sprout-durable-targets-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = await readinessWorkflowHarness({ backend, directory,
      agents: [{ ...agent('scout'), engine: 'codex', model: 'old-target' }] });
    try {
      const id = (await h.runtime.enrollments.list())[0]!.id;
      const received: WorkerReadinessProbeParams[] = [];
      await h.connect(id, join(directory, 'worker-key.pem'), { readinessProbe: async (params) => {
        received.push(params);
        const probe = { at: Date.now(), latencyMs: 1, protocolOk: true, enginesOk: true,
          source: 'worker' as const, version: '3', summary: 'target read' };
        return { readiness: { protocolVersion: WORKER_PROTOCOL_VERSION, engines: [], probe }, probe };
      } });
      const post = () => fetch(`${h.base}/api/environments/enrollments/${id}/probes`, {
        method: 'POST', headers: { cookie: h.cookie, 'x-sprout-csrf': h.csrf, 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal((await post()).status, 201);
      assert.deepEqual(received.at(-1)?.requiredModels, ['old-target']);
      const created = await h.runtime.agentService.create({ id: 'scout', displayName: 'Scout',
        workOptions: [{ engine: 'codex', workModel: 'new-target', effort: 'medium' }] });
      assert.equal(created.id, 'scout');
      assert.equal((await post()).status, 201);
      assert.deepEqual(received.at(-1)?.requiredModels, ['new-target']);
      assert.equal(h.runtime.environmentCatalog.entry(INSTANCE_ID)?.eligible, false,
        'no target-specific available evidence may be inferred from an empty probe');
    } finally { await h.close(); }
  });
}
