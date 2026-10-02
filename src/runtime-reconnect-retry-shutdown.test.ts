import test from 'node:test';
import assert from 'node:assert/strict';

import { ScriptedEngineAdapter } from './engine/scripted.ts';
import { InMemoryRunReconnectRetryStore } from './run/reconnect-retry-store.ts';
import { RUN_RECONNECT_RETRY_SHUTDOWN_DEADLINE_MS } from './run/reconnect-retry.ts';
import {
  createRuntime,
  hostConfiguration,
  inMemoryStores,
  scriptedEnvironment,
} from './runtime-test-harness.ts';
import type { RuntimeStores } from './runtime.ts';

test('runtime shutdown bounds a reconnect observation blocked in the retry store and reports it', async () => {
  let enteredGetGate!: () => void;
  const getGateEntered = new Promise<void>((resolve) => { enteredGetGate = resolve; });
  let releaseGetGate!: () => void;
  const blockedGetGate = new Promise<void>((resolve) => { releaseGetGate = resolve; });
  let getGateCalls = 0;
  let armGateCalls = 0;
  const retryStore = new Proxy(new InMemoryRunReconnectRetryStore(), {
    get(target, property, receiver) {
      if (property === 'getGate') {
        return async () => {
          getGateCalls += 1;
          enteredGetGate();
          await blockedGetGate;
          return undefined;
        };
      }
      if (property === 'armGate') {
        return async (...args: Parameters<InMemoryRunReconnectRetryStore['armGate']>) => {
          armGateCalls += 1;
          return target.armGate(...args);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const baseStores = inMemoryStores();
  const stores: RuntimeStores = { ...baseStores, runReconnectRetries: retryStore };
  const environment = scriptedEnvironment({
    adapters: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
  });
  const runtime = await createRuntime({
    configuration: hostConfiguration(),
    projectRoot: '/synthetic/project-root',
    environment,
    stores,
  });

  const originalWrite = process.stderr.write;
  let shutdownLog = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    shutdownLog += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await getGateEntered;
    const startedAt = Date.now();
    let closeTimeout: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      runtime.close().then(() => true),
      new Promise<false>((resolve) => {
        closeTimeout = setTimeout(
          () => resolve(false),
          RUN_RECONNECT_RETRY_SHUTDOWN_DEADLINE_MS + 1_000,
        );
      }),
    ]);
    if (closeTimeout !== undefined) clearTimeout(closeTimeout);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(closed, true, 'runtime.close() must finish within its bounded retry-drain deadline');
    assert.ok(
      elapsedMs <= RUN_RECONNECT_RETRY_SHUTDOWN_DEADLINE_MS + 500,
      `shutdown exceeded the retry-drain deadline: ${elapsedMs}ms`,
    );
    assert.match(shutdownLog, /shutdown deadline exceeded; abandoned [1-9][0-9]* pending observation/);
    assert.equal(baseStores.closes(), 1, 'stores close after the bounded wait');
    releaseGetGate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(getGateCalls, 1, 'queued observations never start after stores close');
    assert.equal(armGateCalls, 0, 'an abandoned in-flight observation never resumes store access');
  } finally {
    releaseGetGate();
    process.stderr.write = originalWrite;
  }
});
