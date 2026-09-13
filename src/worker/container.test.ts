import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { EnvironmentPool } from '../environment/pool.ts';
import {
  containerEnvironmentDefinition,
  containerEnvironmentInstance,
  type ContainerRuntime,
  type CreateContainerOptions,
} from '../environment/container.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import { EnvironmentWorker } from './server.ts';
import { ContainerCarrier } from './container-carrier.ts';

/**
 * A container runtime whose exec channel is an in-memory pipe.
 *
 * This lets the container carrier be tested without Docker while still exercising
 * the real protocol, which is the point: the container differs from a local
 * machine only in the carrier.
 */
class FakeContainerRuntime implements ContainerRuntime {
  readonly created: CreateContainerOptions[] = [];
  readonly execs: string[][] = [];
  readonly containers = new Set<string>();
  /** Processes started through the exec channel, newest last. */
  readonly processes: PassThrough[][] = [];
  readonly #engines: readonly ScriptedEngineAdapter[];

  constructor(engines: readonly ScriptedEngineAdapter[] = []) {
    this.#engines = engines;
  }

  async available(): Promise<{ available: boolean; detail: string }> {
    return { available: true, detail: 'fake container runtime' };
  }

  async create(options: CreateContainerOptions): Promise<void> {
    this.created.push(options);
    this.containers.add(options.name);
  }

  async exists(name: string): Promise<boolean> {
    return this.containers.has(name);
  }

  async exec(name: string, command: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    this.execs.push([name, ...command]);
    return { code: 0, stdout: '', stderr: '' };
  }

  async stop(name: string): Promise<void> {
    this.containers.delete(name);
  }

  async remove(name: string): Promise<void> {
    this.containers.delete(name);
  }

  /** Behaves like an interactive exec: returns a process wired to a worker. */
  execProcess(): import('node:child_process').ChildProcess {
    const input = new PassThrough();
    const output = new PassThrough();
    const errors = new PassThrough();
    this.processes.push([input, output, errors]);

    // Serve the worker protocol on this pipe, exactly as the container would.
    const engines = new Map(this.#engines.map((engine) => [engine.id, engine]));
    const worker = new EnvironmentWorker({
      environmentInstanceId: 'container-1',
      engines,
      input: input,
      output: output,
    });

    return {
      stdin: input,
      stdout: output,
      stderr: errors,
      kill: () => {
        void worker.shutdown();
        input.end();
        output.end();
      },
      on: (event: string, listener: (...args: unknown[]) => void) => {
        // The carrier waits for an exit event; this fake never exits on its own.
        if (event === 'exit') void listener;
        return undefined;
      },
    } as unknown as import('node:child_process').ChildProcess;
  }
}

const definition = containerEnvironmentDefinition({ id: 'container-linux', image: 'sprout/environment:latest' });
const instance = containerEnvironmentInstance({
  instanceId: 'container-1',
  definitionId: 'container-linux',
});

test('a container environment declares the same lease rules as any other platform', () => {
  const pool = new EnvironmentPool({ definitions: [definition], instances: [instance] });

  // The platform difference is confined to the adapter: the lease registry needs
  // no container-specific rule.
  assert.equal(pool.requiresLease('container-1', 'agent-run'), true);
  assert.equal(pool.requiresLease('container-1', 'read-only-investigation'), false);
  assert.equal(definition.platform, 'container');
});

test('a container instance is exclusive once leased, like any other environment', () => {
  const pool = new EnvironmentPool({ definitions: [definition], instances: [instance] });

  const first = pool.acquireLease({
    instanceId: 'container-1',
    capability: 'agent-run',
    holderId: 'agent-a',
    ttlMs: 60_000,
  });
  assert.equal(first.ok, true);

  const second = pool.acquireLease({
    instanceId: 'container-1',
    capability: 'agent-run',
    holderId: 'agent-b',
    ttlMs: 60_000,
  });
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.reason, 'conflict');
});

test('a worker is reached inside the container with no published port', async (t) => {
  const runtime = new FakeContainerRuntime([
    new ScriptedEngineAdapter({
      turns: [
        {
          events: [
            { type: 'tool-call', name: 'shell', detail: 'echo container-ok' },
            { type: 'message', text: 'done', final: true },
          ],
          result: { status: 'completed', text: 'done' },
        },
      ],
    }),
  ]);
  await runtime.create({ name: 'container-1', image: 'sprout/environment:latest' });

  const carrier = new ContainerCarrier({
    runtime,
    containerName: 'container-1',
    workerEntryPath: '/sprout/src/worker/main.ts',
    environmentInstanceId: 'container-1',
    workingDirectory: '/sprout',
  });
  const connection = await carrier.start();
  t.after(() => connection.close());

  assert.equal(connection.info.environmentInstanceId, 'container-1');
  assert.deepEqual([...connection.adapters.keys()], ['scripted']);
  // A pipe, not a socket: no port was opened, so nothing needs authentication yet.
  assert.equal(runtime.processes.length, 1);
});

test('a run completes inside the container through the same worker protocol', async (t) => {
  const engine = new ScriptedEngineAdapter({
    turns: [
      {
        events: [
          { type: 'tool-call', name: 'shell', detail: 'echo container-ok' },
          { type: 'tool-output', text: 'container-ok\n' },
          { type: 'message', text: 'container-ok', final: true },
        ],
        result: { status: 'completed', text: 'container-ok' },
      },
    ],
  });
  const runtime = new FakeContainerRuntime([engine]);
  await runtime.create({ name: 'container-1', image: 'sprout/environment:latest' });

  const connection = await new ContainerCarrier({
    runtime,
    containerName: 'container-1',
    workerEntryPath: '/sprout/src/worker/main.ts',
    environmentInstanceId: 'container-1',
    workingDirectory: '/sprout',
  }).start();
  t.after(() => connection.close());

  const adapter = connection.adapters.get('scripted');
  assert.ok(adapter);
  const session = await adapter.startSession({
    agentId: 'agent-scout',
    workingDirectory: '/sprout',
  });
  const turn = session.run('run echo');
  const types: string[] = [];
  for await (const event of turn.events) types.push(event.type);
  const result = await turn.completion;

  assert.deepEqual(types, ['tool-call', 'tool-output', 'message']);
  assert.deepEqual(result, { status: 'completed', text: 'container-ok' });
  assert.equal(engine.requests[0]?.workingDirectory, '/sprout');
});

test('a container that does not exist is a clear error, not a silent empty engine list', async () => {
  const runtime = new FakeContainerRuntime();
  const carrier = new ContainerCarrier({
    runtime,
    containerName: 'missing',
    workerEntryPath: '/sprout/src/worker/main.ts',
    environmentInstanceId: 'missing',
    workingDirectory: '/sprout',
  });

  await assert.rejects(carrier.start(), /container instance does not exist: missing/);
});

test('a container is created without being destroyed, since deletion is irrecoverable', async () => {
  const runtime = new FakeContainerRuntime();
  await runtime.create({
    name: 'container-1',
    image: 'sprout/environment:latest',
    volumes: ['/host/repo:/sprout'],
    environment: { SPROUT_ENV_INSTANCE: 'container-1' },
    labels: { 'sprout.environment': 'container-1' },
    addHostGateway: true,
  });

  assert.equal(runtime.created.length, 1);
  assert.deepEqual(runtime.created[0]?.volumes, ['/host/repo:/sprout']);
  assert.equal(runtime.created[0]?.addHostGateway, true);
  assert.equal(await runtime.exists('container-1'), true);
});
