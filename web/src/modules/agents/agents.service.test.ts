import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createInitialAgentFixtures,
  createInitialAttributionFixtures,
  FixtureAgentService,
} from './adapters/fixture-adapter.ts';
import { evaluateAgentStatus, optionStateLabel } from './status.ts';
import type { AgentInstance, AgentWorkOptionRow } from './types.ts';

/**
 * The service contract and state matrix for the Manage Agents page (#91).
 *
 * The states are the product's settled vocabulary (ADR-0008): ready,
 * attention, unavailable, empty, archived, validation-error, and the
 * not-yet-observed case. Every row and every mutation here goes through the
 * typed service port, so the tests prove what the page can actually receive.
 */

function option(
  id: string,
  engine: string,
  workModel: string,
  effort: string,
  compatibility: AgentWorkOptionRow['compatibility'] = 'available',
  compatibilityReason = 'ready'
): AgentWorkOptionRow {
  return { id, engine, workModel, effort, compatibility, compatibilityReason };
}

test('the fixture covers ready, attention, unavailable, archived, and not-observed rows distinctly', async () => {
  const service = new FixtureAgentService();
  const agents = await service.listAgents();

  const ready = agents.find((a) => a.id === 'programmer');
  assert.ok(ready);
  assert.equal(ready.status, 'active');
  assert.equal(ready.trafficLight, 'green');
  assert.match(ready.trafficLightReason, /Ready: Priority 1 option/);

  const attention = agents.find((a) => a.id === 'architect');
  assert.ok(attention);
  assert.equal(attention.trafficLight, 'yellow');
  assert.match(attention.trafficLightReason, /Attention:/);
  assert.match(attention.trafficLightReason, /pre-acceptance fallback/);
  assert.notEqual(attention.trafficLightReason, ready.trafficLightReason);

  const missing = agents.find((a) => a.id === 'sentinel');
  assert.ok(missing);
  assert.equal(missing.trafficLight, 'red');
  assert.match(missing.trafficLightReason, /not installed/);

  const modelMissing = agents.find((a) => a.id === 'legacy-model');
  assert.ok(modelMissing);
  assert.equal(modelMissing.trafficLight, 'red');
  assert.match(modelMissing.trafficLightReason, /not available/);
  assert.notEqual(modelMissing.trafficLightReason, missing.trafficLightReason);

  const unobserved = agents.find((a) => a.id === 'unobserved');
  assert.ok(unobserved);
  assert.equal(unobserved.trafficLight, 'yellow');
  assert.match(unobserved.trafficLightReason, /not reachable/);

  const archived = agents.find((a) => a.id === 'legacy-coder');
  assert.ok(archived);
  assert.equal(archived.status, 'archived');
  assert.equal(archived.trafficLight, 'neutral');
  assert.match(archived.trafficLightReason, /Archived Agent/);
});

test('the empty state is a zero-row list, not a fixture row', async () => {
  const service = new FixtureAgentService([]);
  assert.deepEqual(await service.listAgents(), []);
  assert.equal(await service.getAgent('programmer'), undefined);
});

test('configuration edits append versions and never rewrite earlier ones', async () => {
  const service = new FixtureAgentService();
  const before = await service.getAgent('programmer');
  assert.ok(before);
  const originalVersions = JSON.stringify(before.versions);

  await service.reconfigureAgent('programmer', {
    workOptions: [
      { id: 'opt-pi-glm', engine: 'pi', workModel: 'glm-5', effort: 'high' },
      { id: 'opt-codex-gpt', engine: 'codex', workModel: 'gpt-5.2-codex', effort: 'medium' },
      { engine: 'agy', workModel: 'antigravity-deep-code', effort: 'low' },
    ],
    reason: 'Added agy fallback',
  });

  const after = await service.getAgent('programmer');
  assert.ok(after);
  assert.equal(after.currentVersion, before.currentVersion + 1);
  assert.equal(after.versions.length, before.versions.length + 1);
  assert.equal(JSON.stringify(after.versions.slice(0, before.versions.length)), originalVersions);
  assert.match(after.versions[after.versions.length - 1]!.reason, /Added agy fallback/);
  assert.equal(after.workOptions.length, 3);
});

test('removing the last work option is refused and leaves the configuration unchanged', async () => {
  const service = new FixtureAgentService();
  const before = await service.getAgent('sentinel');
  assert.ok(before);
  const snapshot = JSON.stringify(before);

  await assert.rejects(
    service.reconfigureAgent('sentinel', { workOptions: [] }),
    /at least one ordered work option/,
  );
  assert.equal(JSON.stringify(await service.getAgent('sentinel')), snapshot);
});

test('archived Agents are read-only until restored, and restore always works', async () => {
  const service = new FixtureAgentService();

  await assert.rejects(
    service.reconfigureAgent('legacy-coder', {
      workOptions: [{ engine: 'pi', workModel: 'glm-5', effort: 'low' }],
    }),
    /read-only/,
  );

  await service.restoreAgent('legacy-coder');
  const restored = await service.getAgent('legacy-coder');
  assert.ok(restored);
  assert.equal(restored.status, 'active');
  // Compatibility re-derives from the retained projection facts (which for this
  // retired fixture row say unavailable), never resets to a stored green.
  assert.notEqual(restored.trafficLight, 'green');
  assert.notEqual(restored.trafficLight, 'neutral');

  // The version history survived the archive/restore round trip.
  assert.equal(restored.versions.length, 1);
});

test('the archive guard refuses while active work depends on the Agent', async () => {
  const service = new FixtureAgentService();
  service.markActiveWork('programmer', true);

  await assert.rejects(service.archiveAgent('programmer'), /has an active run/);
  const stillActive = await service.getAgent('programmer');
  assert.ok(stillActive);
  assert.equal(stillActive.status, 'active');

  service.markActiveWork('programmer', false);
  await service.archiveAgent('programmer');
  const archived = await service.getAgent('programmer');
  assert.ok(archived);
  assert.equal(archived.status, 'archived');
  // Attribution and versions survive archive (non-destructive, ADR-0008).
  assert.equal(archived.versions.length, 3);
});

test('a created Agent enters with version 1 and the not-yet-observed compatibility state', async () => {
  const service = new FixtureAgentService();
  await service.createAgent({
    displayName: 'Auditor',
    instructions: 'Audit dependencies.',
    workOptions: [{ engine: 'pi', workModel: 'glm-5', effort: 'medium' }],
  });

  const agents = await service.listAgents();
  const created = agents.find((agent) => agent.displayName === 'Auditor');
  assert.ok(created);
  assert.equal(created.currentVersion, 1);
  assert.equal(created.trafficLight, 'yellow');
  assert.equal(created.workOptions[0]!.compatibility, 'unknown');
  assert.equal(created.workOptions[0]!.compatibilityReason.includes('not been evaluated'), true);
});

test('run attribution rows are durable facts with engine, model, effort, and version', async () => {
  const service = new FixtureAgentService();
  const attributions = await service.listRunAttributions();
  assert.ok(attributions.length >= 3);
  const newest = attributions[0]!;
  assert.equal(newest.engine, 'pi');
  assert.equal(newest.workModel, 'glm-5');
  assert.equal(newest.effort, 'high');
  assert.equal(newest.configurationVersion, 3);
  // Newest first ordering.
  assert.ok(attributions.every((row, index) => index === 0 || attributions[index - 1]!.createdAt >= row.createdAt));
});

test('the status evaluation is a pure function over typed facts', () => {
  const available = evaluateAgentStatus({
    status: 'active',
    workOptions: [option('o1', 'pi', 'glm-5', 'high')],
    compatibility: { environmentAvailable: true, firstAvailableOptionId: 'o1' },
  });
  assert.equal(available.trafficLight, 'green');
  assert.match(available.reason, /Ready/);

  const fallback = evaluateAgentStatus({
    status: 'active',
    workOptions: [
      option('o1', 'codex', 'gpt-5.2-codex', 'high', 'login-required'),
      option('o2', 'pi', 'glm-5', 'medium'),
    ],
    compatibility: { environmentAvailable: true, firstAvailableOptionId: 'o2' },
  });
  assert.equal(fallback.trafficLight, 'yellow');
  assert.match(fallback.reason, /Attention/);

  const unavailable = evaluateAgentStatus({
    status: 'active',
    workOptions: [option('o1', 'agy', 'm', 'high', 'missing')],
    compatibility: { environmentAvailable: false, unavailableReason: 'Engine "agy" is not installed.' },
  });
  assert.equal(unavailable.trafficLight, 'red');
  assert.match(unavailable.reason, /not installed/);

  const noFacts = evaluateAgentStatus({
    status: 'active',
    workOptions: [option('o1', 'pi', 'glm-5', 'high')],
  });
  assert.equal(noFacts.trafficLight, 'yellow');
  assert.match(noFacts.reason, /not reachable/);

  const archived = evaluateAgentStatus({
    status: 'archived',
    workOptions: [option('o1', 'pi', 'glm-5', 'high')],
  });
  assert.equal(archived.trafficLight, 'neutral');
  assert.match(archived.reason, /Archived Agent/);
});

test('option verdict labels are textual, never colour-only', () => {
  assert.equal(optionStateLabel('available'), 'Ready');
  assert.equal(optionStateLabel('login-required'), 'Login Required');
  assert.equal(optionStateLabel('missing'), 'Missing');
  assert.equal(optionStateLabel('model-unavailable'), 'Model Unavailable');
  assert.equal(optionStateLabel('unknown'), 'Not Yet Observed');
});

test('every fixture row renders its stable identity and no host facts', async () => {
  const service = new FixtureAgentService();
  const agents: readonly AgentInstance[] = await service.listAgents();
  const serialized = JSON.stringify(agents);
  assert.equal(/\/Users\//.test(serialized), false, 'no macOS home paths');
  assert.equal(/[A-Z]:\\Users\\/.test(serialized), false, 'no Windows home paths');
  assert.equal(/\b192\.168\.\d+\.\d+\b/.test(serialized), false, 'no private addresses');
  assert.equal(/sk-[a-zA-Z0-9]{20,}/.test(serialized), false, 'no API-key shapes');
  for (const agent of agents) {
    assert.ok(agent.id.length > 0);
    assert.ok(agent.displayName.length > 0);
    for (const version of agent.versions) {
      assert.ok(version.reason.length > 0, 'every version records a reason');
    }
  }
});

test('attribution fixtures carry no transport addresses or paths', () => {
  const serialized = JSON.stringify(createInitialAttributionFixtures());
  assert.equal(/wss?:\/\//.test(serialized), false);
  assert.equal(/\/(Users|home)\//.test(serialized), false);
});
