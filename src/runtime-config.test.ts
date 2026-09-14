import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRuntimeConfiguration } from './runtime-config.ts';

test('runtime configuration registers independently configured Agents and Project membership', () => {
  const configured = parseRuntimeConfiguration(JSON.stringify({
    agents: [
      { id: 'pi-a', name: 'Pi A', engine: 'pi', capability: 'agent-run' },
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
