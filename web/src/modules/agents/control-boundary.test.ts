import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AgentControlRefused,
  createAgentControlBoundary,
} from './control-boundary.ts';
import { OFFLINE_CONNECTION, createShellConnectionController } from '../../shell/connection.ts';
import type { AgentManagementService } from './types.ts';

/**
 * The Agent control boundary: the single typed seam where the Shell's
 * connection fact meets the page's mutations (#91).
 *
 * An unsettled connection refuses an action immediately with a typed reason;
 * nothing is queued and nothing is replayed after reconnect (the #85 rule).
 */

function service(): AgentManagementService {
  return {
    listAgents: async () => [],
    getAgent: async () => undefined,
    createAgent: async () => undefined,
    reconfigureAgent: async () => undefined,
    archiveAgent: async () => undefined,
    restoreAgent: async () => undefined,
    listRunAttributions: async () => [],
  };
}

function boundary(initial = OFFLINE_CONNECTION) {
  const controller = createShellConnectionController(initial);
  return {
    controller,
    boundary: createAgentControlBoundary({
      service,
      presentation: () => {
        const state = controller.state();
        const online = state.connection === 'online';
        return {
          status: online ? 'green' : 'red',
          label: online ? 'Online' : 'Offline',
          announce: online ? 'Online.' : 'Offline: actions are refused until reconnected.',
          controlAvailable: online,
        };
      },
    }),
  };
}

test('a control action reaches the service while the connection is settled', async () => {
  const { controller, boundary: seam } = boundary({
    status: 'online',
    connection: 'online',
    loading: false,
  });
  let reached = 0;
  await seam.run(async () => {
    reached += 1;
  });
  assert.equal(reached, 1);
  assert.equal(seam.canControl(), true);
  controller.set(OFFLINE_CONNECTION);
});

test('an offline connection refuses the action with a typed reason and never queues it', async () => {
  const { boundary: seam } = boundary();
  let reached = 0;
  await assert.rejects(
    seam.run(async () => {
      reached += 1;
    }),
    (error: unknown) => {
      assert.ok(error instanceof AgentControlRefused);
      assert.equal(error.kind, 'connection-unsettled');
      assert.match(error.message, /refused until reconnected/);
      return true;
    },
  );
  assert.equal(reached, 0, 'the service was never touched');
  assert.equal(seam.canControl(), false);
});

test('a missing authority refuses with the authority-unavailable kind', async () => {
  const seam = createAgentControlBoundary({
    service: () => undefined,
    presentation: () => ({
      status: 'green',
      label: 'Online',
      announce: 'Online.',
      controlAvailable: true,
    }),
  });
  await assert.rejects(
    seam.run(async () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof AgentControlRefused);
      assert.equal(error.kind, 'authority-unavailable');
      return true;
    },
  );
});
