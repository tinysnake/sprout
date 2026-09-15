import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseRuntimeConfiguration } from './runtime-config.ts';

test('runtime configuration registers independently configured Agents and Project membership', () => {
  const configured = parseRuntimeConfiguration(JSON.stringify({
    agents: [
      {
        id: 'pi-a', name: 'Pi A', engine: 'pi', capability: 'agent-run',
        model: 'pi-model', effort: 'medium',
      },
      { id: 'codex-b', name: 'Codex B', engine: 'codex', capability: 'agent-run' },
    ],
    project: {
      id: 'live-project', goal: 'Validate', rules: ['Use durable facts'],
      availableEnvironmentInstanceIds: ['live-macos'],
      memberships: [
        { agentId: 'pi-a', responsibilities: ['Implement'], collaborationInstructions: 'Report facts.' },
        { agentId: 'codex-b', responsibilities: ['Verify'], collaborationInstructions: 'Report facts.' },
      ],
    },
  }));
  assert.equal(configured.agents?.length, 2);
  assert.equal(configured.agents?.[0]?.model, 'pi-model');
  assert.equal(configured.agents?.[0]?.effort, 'medium');
  assert.equal(configured.project?.memberships[1]?.agentId, 'codex-b');
});

test('runtime configuration refuses a Project member absent from configured Agents', () => {
  assert.throws(() => parseRuntimeConfiguration(JSON.stringify({
    agents: [{ id: 'pi-a', name: 'Pi A', engine: 'pi', capability: 'agent-run' }],
    project: {
      id: 'live-project', goal: 'Validate', rules: [], availableEnvironmentInstanceIds: ['live-macos'],
      memberships: [{ agentId: 'missing', responsibilities: [], collaborationInstructions: 'Report facts.' }],
    },
  })), /not an Agent/);
});

test('the O7 Minesweeper configuration registers its local workspace and all four hand-off Agents', () => {
  const file = new URL('../config/o7-minesweeper-runtime.json', import.meta.url);
  const configured = parseRuntimeConfiguration(readFileSync(file, 'utf8'));

  assert.deepEqual(configured.project?.workspaces, [
    { environmentInstanceId: 'local-macos', path: 'minesweeper' },
  ]);
  assert.deepEqual(
    configured.agents?.map(({ id, engine, model, effort }) => ({ id, engine, model, effort })),
    [
      { id: 'planner', engine: 'codex', model: 'gpt-5.6-terra', effort: 'medium' },
      { id: 'designer', engine: 'pi', model: 'antigravity/gemini-3.8-flash', effort: 'high' },
      { id: 'programmer', engine: 'pi', model: 'workbuddy/deepseek-v4.1-flash', effort: 'high' },
      { id: 'reviewer', engine: 'codex', model: 'gpt-5.6-luna', effort: 'xhigh' },
    ],
  );
  for (const membership of configured.project?.memberships ?? []) {
    assert.match(membership.collaborationInstructions, /direct-message the planner|direct messages/i);
  }
});

test('runtime configuration refuses unsafe or ungranted Project workspace registrations', () => {
  const base = {
    agents: [{ id: 'planner', name: 'Planner', engine: 'codex', capability: 'agent-run' }],
    project: {
      id: 'game', goal: 'Validate', rules: [], availableEnvironmentInstanceIds: ['local-macos'],
      memberships: [{ agentId: 'planner', responsibilities: [], collaborationInstructions: 'Report facts.' }],
    },
  };
  assert.throws(() => parseRuntimeConfiguration(JSON.stringify({
    ...base,
    project: { ...base.project, workspaces: [{ environmentInstanceId: 'local-macos', path: '../outside' }] },
  })), /relative path/);
  assert.throws(() => parseRuntimeConfiguration(JSON.stringify({
    ...base,
    project: { ...base.project, workspaces: [{ environmentInstanceId: 'other-macos', path: 'game' }] },
  })), /not available/);
});
