import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PassThrough } from 'node:stream';
import { OpenCodeEngineAdapter } from '../engine/opencode.ts';
import { LineJsonRpcTransport } from '../engine/jsonrpc.ts';
import { EnvironmentWorker } from './server.ts';
import { WorkerClient } from './client.ts';

const postInput = { body: 'The report is ready.', deliveryKey: 'privacy-post-1', kind: 'handoff' as const };

for (const fallback of [false, true]) {
  test(`Task-group credential is absent from persisted files in ${fallback ? 'fallback contract' : 'AGENTS.md'} mode after session close`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'sprout-task-group-privacy-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    if (fallback) await writeFile(join(directory, 'AGENTS.md'), 'Operator instructions\n');

    let token = '';
    let url = '';
    let standingContext = '';
    let authenticated = false;
    const adapter = new OpenCodeEngineAdapter({
      binaryPath: '/usr/bin/true',
      spawnProcess: (_binary, _args, env) => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let exit: (code: number | null) => void = () => {};
        queueMicrotask(() => { void (async () => {
          const files = await filesUnder(directory);
          standingContext = (await Promise.all(files.map(file => readFile(file, 'utf8')))).join('\n');
          token = env?.SPROUT_TASK_GROUP_POST_TOKEN ?? '';
          url = env?.SPROUT_TASK_GROUP_POST_URL ?? '';
          assert.ok(token);
          assert.ok(url);
          assert.equal(standingContext.includes(token), false, 'credential entered standing instruction context');

          assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(postInput) })).status, 403);
          const response = await fetch(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(postInput),
          });
          assert.equal(response.status, 200);
          authenticated = true;
          stdout.end();
          exit(0);
        })().catch(error => { stderr.write(String(error)); stdout.end(); exit(1); }); });
        return {
          stdout,
          stderr,
          writeStdin() {},
          endStdin() {},
          kill() { exit(0); },
          onExit(handler) { exit = handler; },
          onSpawnError() {},
        };
      },
    });

    const input = new PassThrough();
    const output = new PassThrough();
    const worker = new EnvironmentWorker({
      environmentInstanceId: 'instance',
      engines: new Map([['opencode', adapter]]),
      input,
      output,
    });
    const transport = new LineJsonRpcTransport({ input: output, output: input });
    t.after(async () => { await worker.shutdown(); transport.close(); });

    const connected = await WorkerClient.connect(transport);
    const session = await connected.adapters.get('opencode')!.startSession({
      agentId: 'scout',
      workingDirectory: directory,
      instructions: 'Project contract',
      postTaskGroupMessage: async () => ({
        messageId: 'message-1',
        scopeId: 'task-group-1',
        authorId: 'scout',
        duplicate: false,
        admittedRunIds: [],
        runs: [],
        wakes: [],
      }),
    });
    const turn = session.run('post');
    for await (const _event of turn.events) { /* consume the real adapter turn */ }
    assert.equal((await turn.completion).status, 'completed');
    await session.close();
    assert.equal(authenticated, true);
    for (const file of await filesUnder(directory)) {
      assert.equal((await readFile(file, 'utf8')).includes(token), false, `credential persisted in ${relative(directory, file)}`);
    }
  });
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
