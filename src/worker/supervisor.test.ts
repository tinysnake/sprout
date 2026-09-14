import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EngineAdapter, EngineSession, EngineTurn, StartSessionRequest } from '../engine/port.ts';
import { EventQueue } from '../engine/event-queue.ts';
import type { WorkerConnection } from './carrier.ts';
import { EnvironmentWorkerRegistry, WorkerSupervisor } from './supervisor.ts';

/**
 * A stand-in for a worker connection whose liveness the test controls.
 */
class FakeConnection implements WorkerConnection {
  readonly info: { pid: number; environmentInstanceId: string; engines: [] };
  readonly adapters: ReadonlyMap<string, EngineAdapter>;
  #alive = true;
  closes = 0;

  constructor(environmentInstanceId = 'mac-mini-1') {
    this.info = { pid: 1, environmentInstanceId, engines: [] };
    this.adapters = new Map<string, EngineAdapter>([['scripted', new FakeAdapter()]]);
  }

  get alive(): boolean {
    return this.#alive;
  }

  die(): void {
    this.#alive = false;
  }

  async close(): Promise<void> {
    this.closes += 1;
  }
}

class FakeAdapter implements EngineAdapter {
  readonly id = 'scripted';
  readonly capabilities = {
    streaming: 'incremental',
    supportsInterrupt: true,
    standingInstructions: 'out-of-band',
  } as const;
  async startSession(_request: StartSessionRequest): Promise<EngineSession> {
    const queue = new EventQueue();
    queue.end();
    const turn: EngineTurn = {
      events: queue,
      completion: Promise.resolve({ status: 'completed', text: 'done' }),
    };
    return {
      sessionId: 's1',
      engineSessionKey: 's1',
      run: () => turn,
      interrupt: async () => true,
      close: async () => undefined,
    };
  }
}

test('a dead worker is replaced before the next run instead of failing it', async () => {
  // Regression from the live runtime: one worker death left every later run
  // failing with "channel is closed" and no worker ever came back, turning a
  // transient crash into a permanent outage of the whole environment.
  const connections: FakeConnection[] = [];
  const supervisor = new WorkerSupervisor({
    connect: async () => {
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    },
  });

  const first = await supervisor.adapters();
  assert.equal(supervisor.starts, 1);
  assert.equal(supervisor.alive, true);
  assert.ok(first.has('scripted'));

  connections[0]?.die();
  assert.equal(supervisor.alive, false);

  const second = await supervisor.adapters();
  assert.ok(second.has('scripted'));
  assert.equal(supervisor.starts, 2, 'a fresh worker was started');
  assert.equal(supervisor.alive, true);
  assert.equal(connections.length, 2);
});

test('a live worker is reused rather than restarted on every run', async () => {
  const connections: FakeConnection[] = [];
  const supervisor = new WorkerSupervisor({
    connect: async () => {
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    },
  });

  await supervisor.adapters();
  await supervisor.adapters();
  await supervisor.adapters();

  assert.equal(supervisor.starts, 1, 'the long-lived worker is reused across runs');
});

test('a worker that fails to start reports the failure and can be retried', async () => {
  let attempts = 0;
  const supervisor = new WorkerSupervisor({
    connect: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('docker is not running');
      return new FakeConnection();
    },
  });

  await assert.rejects(supervisor.adapters(), /docker is not running/);
  assert.equal(supervisor.alive, false);

  const recovered = await supervisor.adapters();
  assert.ok(recovered.has('scripted'), 'a later run can start a worker successfully');
  assert.equal(attempts, 2);
});

test('closing the supervisor closes the live worker and refuses further use', async () => {
  const connections: FakeConnection[] = [];
  const supervisor = new WorkerSupervisor({
    connect: async () => {
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    },
  });

  await supervisor.adapters();
  await supervisor.close();

  assert.equal(connections[0]?.closes, 1);
  await assert.rejects(supervisor.adapters(), /supervisor is closed/);
});

test('the instance-keyed registry starts one worker per requested instance', async () => {
  const connections: FakeConnection[] = [];
  const requested: string[] = [];
  const registry = new EnvironmentWorkerRegistry({
    connect: async (instanceId) => {
      requested.push(instanceId);
      const connection = new FakeConnection(instanceId);
      connections.push(connection);
      return connection;
    },
  });

  const mac = await registry.adapters('mac-mini-1');
  const container = await registry.adapters('container-1');

  assert.ok(mac.has('scripted'));
  assert.ok(container.has('scripted'));
  assert.deepEqual(requested, ['mac-mini-1', 'container-1'], 'each instance gets its own worker');

  // The same instance reuses its worker rather than restarting it.
  await registry.adapters('mac-mini-1');
  assert.deepEqual(requested, ['mac-mini-1', 'container-1']);
  assert.equal(registry.starts, 2);
  await registry.close();
  assert.equal(connections.length, 2);
});

test('the registry refuses a worker whose own instance does not match the resolved one', async () => {
  // Regression guard for F1 (#18): executing on the wrong machine while recording
  // another must be a loud wiring error, never a silent success.
  const registry = new EnvironmentWorkerRegistry({
    // The worker claims to be mac-mini-1 whatever instance was requested.
    connect: async () => new FakeConnection('mac-mini-1'),
  });

  await assert.rejects(registry.adapters('container-1'), /instance mismatch/i);
  assert.ok((await registry.adapters('mac-mini-1')).has('scripted'));
});
