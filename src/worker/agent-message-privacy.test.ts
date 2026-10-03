import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { OpenCodeEngineAdapter } from '../engine/opencode.ts';
import { LineJsonRpcTransport } from '../engine/jsonrpc.ts';
import { EnvironmentWorker } from './server.ts';
import { WorkerClient } from './client.ts';

for (const fallback of [false, true]) {
  test(`bridge authenticates without exposing credentials in ${fallback ? 'fallback contract' : 'AGENTS.md'} or standing context after session close`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'sprout-message-privacy-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    if (fallback) await writeFile(join(directory, 'AGENTS.md'), 'Operator instructions\n');
    let token = '';
    let visible = '';
    let authenticated = false;
    const adapter = new OpenCodeEngineAdapter({
      binaryPath: '/usr/bin/true',
      spawnProcess: (_binary, _args, env) => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let exit: (code: number | null) => void = () => {};
        queueMicrotask(() => { void (async () => {
          const files = await readdir(directory);
          visible = (await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))).join('\n');
          token = env?.SPROUT_AGENT_MESSAGE_TOKEN ?? visible.match(/Bearer ([a-f0-9]+)/)?.[1] ?? '';
          const url = env?.SPROUT_AGENT_MESSAGE_URL ?? visible.match(/http:\/\/127\.0\.0\.1:\d+\/direct-message/)?.[0];
          assert.ok(token); assert.ok(url);
          assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403);
          const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ recipientId: 'forge', body: 'help', deliveryKey: 'privacy' }) });
          assert.equal(response.status, 200);
          authenticated = true;
          stdout.end(); exit(0);
        })().catch(error => { stderr.write(String(error)); stdout.end(); exit(1); }); });
        return { stdout, stderr, writeStdin() {}, endStdin() {}, kill() { exit(0); }, onSpawnError() {}, onExit(handler) { exit = handler; } };
      },
    });
    const input = new PassThrough(); const output = new PassThrough();
    const worker = new EnvironmentWorker({ environmentInstanceId: 'instance', engines: new Map([['opencode', adapter]]), input, output });
    const transport = new LineJsonRpcTransport({ input: output, output: input });
    t.after(async () => { await worker.shutdown(); transport.close(); });
    const connected = await WorkerClient.connect(transport);
    const session = await connected.adapters.get('opencode')!.startSession({ agentId: 'scout', workingDirectory: directory, instructions: 'Project contract', sendDirectMessage: async () => ({ messageId: 'message', scopeId: 'pair', authorId: 'scout', duplicate: false, admittedRunIds: [], runs: [], wakes: [] }) });
    const turn = session.run('send');
    for await (const _event of turn.events) { /* consume the real adapter turn */ }
    assert.equal((await turn.completion).status, 'completed');
    await session.close();
    assert.equal(authenticated, true);
    for (const file of await readdir(directory)) assert.equal((await readFile(join(directory, file), 'utf8')).includes(token), false, `credential persisted in ${file}`);
    assert.equal(visible.includes(token), false, 'credential entered standing instruction context');
  });
}
