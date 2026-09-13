import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { PiEngineAdapter } from './pi.ts';

/**
 * A spawn failure fires 'error' and never 'exit'. The adapter must settle the
 * turn as failed, not hang forever and not crash the worker with an unhandled
 * error event. Both wrong behaviours were observed live on Windows, where the
 * configured working directory did not exist.
 */
test('a spawn failure fails the turn instead of hanging or crashing', async () => {
  const adapter = new PiEngineAdapter({
    binaryPath: '/usr/bin/true',
    spawnProcess: () => {
      const fake = {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => undefined,
        onExit: (_handler: (code: number | null) => void) => undefined,
        onSpawnError: (handler: (error: Error) => void) => {
          queueMicrotask(() => handler(new Error('spawn ENOENT')));
        },
      };
      return fake;
    },
  });

  const session = await adapter.startSession({ agentId: 'scout', workingDirectory: '/tmp' });
  const turn = session.run('anything');
  const result = await turn.completion;

  assert.deepEqual(result, { status: 'failed', message: 'pi failed to start: spawn ENOENT' });
});
