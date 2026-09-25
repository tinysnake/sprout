import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { EngineAdapter } from '../engine/port.ts';
import { WorkerRecoveryJournal } from './recovery-journal.ts';
import { EnvironmentWorker } from './server.ts';

test('a failed engine fence remains unproved after Worker shutdown and process restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-fence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal');
  const journal = new WorkerRecoveryJournal(path, 1);
  const input = new PassThrough();
  const output = new PassThrough();
  const adapter: EngineAdapter = {
    id: 'fault', capabilities: { streaming: 'incremental', supportsInterrupt: true, standingInstructions: 'out-of-band' },
    async startSession() {
      return {
        sessionId: 'engine-session',
        engineSessionKey: 'engine-key',
        run() { throw new Error('not run'); },
        async interrupt() { return false; },
        async close() { throw new Error('fence failed'); },
      };
    },
  };
  const worker = new EnvironmentWorker({ environmentInstanceId: 'instance', engines: new Map([['fault', adapter]]),
    input, output, recoveryJournal: journal });
  const started = new Promise<void>((resolve) => output.once('data', () => resolve()));
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/start',
    params: { engine: 'fault', agentId: 'agent', workingDirectory: '.' } })}\n`);
  await started;
  assert.equal(journal.snapshot().engineStopped, false);
  await worker.shutdown();
  assert.equal(journal.snapshot().engineStopped, false);
  const next = new WorkerRecoveryJournal(path, 2);
  const idle = new EnvironmentWorker({ environmentInstanceId: 'instance', engines: new Map(),
    input: new PassThrough(), output: new PassThrough(), recoveryJournal: next });
  await idle.shutdown();
  assert.equal(next.snapshot().engineStopped, false, 'new Worker cannot fence a prior orphan by doing nothing');
});
