import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProductionAgentService } from './production-adapter.ts';
import type { AgentBrowserAdapter, AgentCompatibilityView, AgentView } from '../../../adapters/agent-api.ts';
import type { RunView } from '../../../../../src/web/views.ts';

/**
 * Unit tests for the production bridge (#91): every fact the page renders
 * must come from the #90 wire adapter's projections, and every mutation must
 * be a wire command. The bridge never invents a fact and never keeps a
 * fixture; an unreachable read degrades honestly instead.
 */

const agent: AgentView = {
  id: 'programmer',
  displayName: 'Programmer',
  status: 'active',
  configuration: {
    currentVersion: 2,
    versions: [
      {
        version: 1,
        at: 1_000,
        reason: 'Agent created with its initial ordered work options.',
        options: [{ id: 'opt-1', engine: 'codex', workModel: 'gpt-5.2-codex', effort: 'high' }],
      },
      {
        version: 2,
        at: 2_000,
        reason: 'switch primary engine',
        instructions: 'Verify tests first.',
        options: [{ id: 'opt-2', engine: 'pi', workModel: 'glm-5', effort: 'medium' }],
      },
    ],
  },
  createdAt: 1_000,
  updatedAt: 2_000,
};

const compatible: AgentCompatibilityView = {
  agentId: 'programmer',
  environmentInstanceId: 'inst-1',
  available: true,
  firstAvailable: { id: 'opt-2', engine: 'pi', workModel: 'glm-5', effort: 'medium' },
  options: [
    {
      option: { id: 'opt-2', engine: 'pi', workModel: 'glm-5', effort: 'medium' },
      state: 'available',
      reason: 'Engine "pi" is ready with the option\'s work model.',
    },
  ],
};

const incompatible: AgentCompatibilityView = {
  agentId: 'programmer',
  environmentInstanceId: 'inst-1',
  available: false,
  unavailableReason: 'Engine "pi" is not installed on this Environment.',
  options: [
    {
      option: { id: 'opt-2', engine: 'pi', workModel: 'glm-5', effort: 'medium' },
      state: 'missing',
      reason: 'Engine "pi" is not installed on this Environment.',
    },
  ],
};

interface Recorder {
  readonly calls: string[];
  readonly adapter: AgentBrowserAdapter;
  failCompatibility: boolean;
  compatibility: AgentCompatibilityView;
}

function recordingAdapter(): Recorder {
  const calls: string[] = [];
  const recorder: Recorder = {
    calls,
    failCompatibility: false,
    compatibility: compatible,
    adapter: {
      state: () => ({ status: 'online', connection: 'online', loading: false }),
      subscribeState: () => () => undefined,
      setCsrfToken: () => undefined,
      async listAgents() {
        calls.push('listAgents');
        return [agent];
      },
      async getAgent(id: string) {
        calls.push(`getAgent:${id}`);
        return agent;
      },
      async createAgent() {
        calls.push('createAgent');
        return agent;
      },
      async reconfigureAgent() {
        calls.push('reconfigureAgent');
        return agent;
      },
      async archiveAgent() {
        calls.push('archiveAgent');
        return { ...agent, status: 'archived' };
      },
      async restoreAgent() {
        calls.push('restoreAgent');
        return agent;
      },
      async compatibility(id: string) {
        calls.push(`compatibility:${id}`);
        if (recorder.failCompatibility) throw new Error('not configured');
        return recorder.compatibility;
      },
      async runWorkOption() {
        calls.push('runWorkOption');
        throw new Error('not used by the page bridge');
      },
    },
  };
  return recorder;
}

function runHistory(runs: readonly Partial<RunView>[]): () => Promise<{ runs: RunView[] }> {
  return async () => ({ runs: runs as RunView[] });
}

test('the bridge projects the compatibility verdict into every composed row', async () => {
  const wire = recordingAdapter();
  const service = new ProductionAgentService(wire.adapter, runHistory([]));
  const rows = await service.listAgents();

  assert.equal(wire.calls.filter((call) => call === 'listAgents').length, 2, 'list and projection read the same wire');
  assert.equal(wire.calls.some((call) => call === 'compatibility:programmer'), true);

  const row = rows[0]!;
  assert.equal(row.trafficLight, 'green');
  assert.match(row.trafficLightReason, /Ready: Priority 1 option \(PI · glm-5 · medium\)/);
  assert.equal(row.compatibility?.environmentAvailable, true);
  assert.equal(row.workOptions[0]!.compatibility, 'available');
  assert.equal(row.workOptions[0]!.compatibilityReason, 'Engine "pi" is ready with the option\'s work model.');
  // The current instructions ride the latest version's record.
  assert.equal(row.instructions, 'Verify tests first.');
});

test('an unavailable projection renders the decisive reason as Action Required', async () => {
  const wire = recordingAdapter();
  wire.compatibility = incompatible;
  const service = new ProductionAgentService(wire.adapter, runHistory([]));
  const rows = await service.listAgents();

  const row = rows[0]!;
  assert.equal(row.trafficLight, 'red');
  assert.match(row.trafficLightReason, /not installed/);
  assert.equal(row.workOptions[0]!.compatibility, 'missing');
  assert.equal(row.workOptions[0]!.compatibilityReason, 'Engine "pi" is not installed on this Environment.');
});

test('an unreachable projection degrades to not-yet-observed, never a fabricated verdict', async () => {
  const wire = recordingAdapter();
  wire.failCompatibility = true;
  const service = new ProductionAgentService(wire.adapter, runHistory([]));
  const rows = await service.listAgents();

  const row = rows[0]!;
  assert.equal(row.compatibility, undefined);
  assert.equal(row.trafficLight, 'yellow');
  assert.match(row.trafficLightReason, /not reachable/);
});

test('an unknown id returns undefined instead of an invented row', async () => {
  const wire = recordingAdapter();
  const failing = { ...wire.adapter, getAgent: async () => { throw new Error('404'); } };
  const service = new ProductionAgentService(failing, runHistory([]));
  assert.equal(await service.getAgent('nobody'), undefined);
});

test('mutations are wire commands with the preserved option identities', async () => {
  const wire = recordingAdapter();
  const service = new ProductionAgentService(wire.adapter, runHistory([]));

  await service.createAgent({
    displayName: 'Auditor',
    workOptions: [{ engine: 'pi', workModel: 'glm-5', effort: 'medium' }],
  });
  await service.reconfigureAgent('programmer', {
    workOptions: [{ id: 'opt-2', engine: 'pi', workModel: 'glm-5', effort: 'low' }],
    reason: 'lower effort',
  });
  await service.archiveAgent('programmer');
  await service.restoreAgent('programmer');

  assert.deepEqual(wire.calls, [
    'createAgent',
    'reconfigureAgent',
    'archiveAgent',
    'restoreAgent',
  ]);
});

test('run attribution rows come from the durable run history, newest first', async () => {
  const wire = recordingAdapter();
  const service = new ProductionAgentService(
    wire.adapter,
    runHistory([
      {
        id: 'run-new',
        agentId: 'programmer',
        status: 'completed',
        createdAt: 2_000,
        workOption: { engine: 'pi', workModel: 'glm-5', effort: 'medium', configurationVersion: 2 },
      },
      {
        id: 'run-old',
        agentId: 'programmer',
        status: 'failed',
        createdAt: 1_000,
        workOption: { engine: 'codex', workModel: 'gpt-5.2-codex', effort: 'high', configurationVersion: 1 },
      },
      {
        id: 'run-unattributed',
        agentId: 'other-agent',
        status: 'completed',
        createdAt: 3_000,
      },
    ]),
  );
  const rows = await service.listRunAttributions();
  // The bridge returns the page-level attribution read; the detail panel
  // filters per Agent, so all rows arrive newest-first.
  assert.deepEqual(rows.map((row) => row.runId), ['run-unattributed', 'run-new', 'run-old']);
  const programmerRows = rows.filter((row) => row.agentId === 'programmer');
  assert.deepEqual(programmerRows.map((row) => row.runId), ['run-new', 'run-old']);
  assert.equal(programmerRows[0]!.engine, 'pi');
  assert.equal(programmerRows[0]!.configurationVersion, 2);
  assert.equal(programmerRows[1]!.engine, 'codex');
});
