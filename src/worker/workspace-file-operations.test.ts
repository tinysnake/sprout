import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EndpointCarrier } from './carrier.ts';
import { WorkerWorkspace } from './workspace.ts';
import { WorkerWorkspaceFiles } from './workspace-file-operations.ts';

test('Worker file reads return the same-name remote sentinel and deny traversal, another Project, and host paths', async (t) => {
  const hostRoot = await mkdtemp(join(tmpdir(), 'sprout-host-sentinel-'));
  const workerRoot = await mkdtemp(join(tmpdir(), 'sprout-remote-sentinel-'));
  t.after(async () => {
    await rm(hostRoot, { recursive: true, force: true });
    await rm(workerRoot, { recursive: true, force: true });
  });
  const connection = await worker(workerRoot);
  t.after(() => connection.close());
  const hostSentinel = join(hostRoot, 'sentinel.txt');
  await writeFile(hostSentinel, 'LOCAL_HOST_SENTINEL');
  const selected = await connection.contexts.validateWorkspace({ projectId: 'project-1', environmentInstanceId: 'env-1', kind: 'relative', path: 'repo' });
  await writeFile(join(workerRoot, 'repo', 'sentinel.txt'), 'REMOTE_PROJECT_SENTINEL');
  const binding = {
    projectId: 'project-1', environmentInstanceId: 'env-1', bindingId: 'binding-1',
    generation: 1, connectionEpoch: 4, workspaceId: selected.workspaceId, kind: 'relative', path: 'repo',
  } as const;
  await connection.contexts.attachWorkspaceBinding(binding);

  const { path: workspacePath, ...bindingIdentity } = binding;
  const operationBinding = { ...bindingIdentity, workspacePath };
  const remote = await connection.contexts.executeWorkspaceFileOperation({ ...operationBinding, operationId: 'remote-read-1', operation: 'read', path: 'sentinel.txt' });
  if (remote.status !== 'completed') throw new Error(`Worker read failed: ${remote.failure ?? 'no failure detail'}`);
  assert.equal(remote.content, 'REMOTE_PROJECT_SENTINEL');
  assert.notEqual(remote.content, 'LOCAL_HOST_SENTINEL', 'the same-name host fixture is not the read origin');
  assert.equal(remote.projectId, 'project-1');
  assert.equal(remote.bindingId, 'binding-1');
  assert.equal(remote.generation, 1);
  assert.equal(remote.connectionEpoch, 4);

  const traversal = await connection.contexts.executeWorkspaceFileOperation({ ...operationBinding, operationId: 'traversal-1', operation: 'read', path: '../sentinel.txt' });
  assert.equal(traversal.status, 'failed');
  assert.equal(traversal.failure, 'invalid-path');
  const hostRead = await connection.contexts.executeWorkspaceFileOperation({ ...operationBinding, operationId: 'host-read-1', operation: 'read', path: hostSentinel });
  assert.equal(hostRead.status, 'failed');
  assert.equal(hostRead.failure, 'invalid-path');
  await assert.rejects(
    connection.contexts.executeWorkspaceFileOperation({ ...operationBinding, projectId: 'project-2', operationId: 'cross-project-1', operation: 'read', path: 'sentinel.txt' }),
    /Worker request could not be completed/i,
  );
});


test('Worker refuses a same-generation binding retarget and fences calls after a new generation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sprout-workspace-generation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new WorkerWorkspace(root);
  const first = await workspace.validateWorkspace({ projectId: 'project-1', environmentInstanceId: 'env-1', kind: 'relative', path: 'repo-one' });
  const second = await workspace.validateWorkspace({ projectId: 'project-1', environmentInstanceId: 'env-1', kind: 'relative', path: 'repo-two' });
  await writeFile(join(root, 'repo-one', 'sentinel.txt'), 'first workspace');
  await writeFile(join(root, 'repo-two', 'sentinel.txt'), 'second workspace');

  const files = new WorkerWorkspaceFiles(workspace, 'env-1');
  const binding = {
    projectId: 'project-1', environmentInstanceId: 'env-1', bindingId: 'binding-1',
    generation: 1, connectionEpoch: 4, workspaceId: first.workspaceId, kind: 'relative', path: 'repo-one',
  } as const;
  await files.attach(binding);
  const { path: firstWorkspacePath, ...firstIdentity } = binding;
  const firstOperationBinding = { ...firstIdentity, workspacePath: firstWorkspacePath };
  await assert.rejects(files.attach({ ...binding, workspaceId: second.workspaceId, path: 'repo-two' }), /conflicting workspace binding/);

  const firstRead = await files.execute({ ...firstOperationBinding, operationId: 'operation-1', operation: 'read', path: 'sentinel.txt' });
  assert.equal(firstRead.content, 'first workspace', 'a refused attach leaves the original generation bound');

  const next = { ...binding, bindingId: 'binding-2', generation: 2, workspaceId: second.workspaceId, path: 'repo-two' } as const;
  const { path: secondWorkspacePath, ...secondIdentity } = next;
  const secondOperationBinding = { ...secondIdentity, workspacePath: secondWorkspacePath };
  await files.attach(next);
  await assert.rejects(
    files.execute({ ...firstOperationBinding, operationId: 'operation-2', operation: 'read', path: 'sentinel.txt' }),
    /stale workspace binding/,
  );
  const secondRead = await files.execute({ ...secondOperationBinding, operationId: 'operation-3', operation: 'read', path: 'sentinel.txt' });
  assert.equal(secondRead.content, 'second workspace');

  await assert.rejects(files.attach({ ...next, bindingId: 'binding-3', generation: 3, connectionEpoch: 3 }), /stale workspace binding/);
});

test('Worker edits and patches only the pinned remote Project file', async (t) => {
  const hostRoot = await mkdtemp(join(tmpdir(), 'sprout-edit-host-'));
  const workerRoot = await mkdtemp(join(tmpdir(), 'sprout-edit-worker-'));
  t.after(async () => {
    await rm(hostRoot, { recursive: true, force: true });
    await rm(workerRoot, { recursive: true, force: true });
  });
  const connection = await worker(workerRoot);
  t.after(() => connection.close());
  const hostSentinel = join(hostRoot, 'same-name.txt');
  await writeFile(hostSentinel, 'HOST_SENTINEL');
  const selected = await connection.contexts.validateWorkspace({ projectId: 'project-edit', environmentInstanceId: 'env-1', kind: 'relative', path: 'repo' });
  const remoteFile = join(workerRoot, 'repo', 'same-name.txt');
  await writeFile(remoteFile, 'remote old\nsecond line\n');
  const binding = {
    projectId: 'project-edit', environmentInstanceId: 'env-1', bindingId: 'binding-edit',
    generation: 3, connectionEpoch: 8, workspaceId: selected.workspaceId, kind: 'relative', path: 'repo',
  } as const;
  await connection.contexts.attachWorkspaceBinding(binding);
  const { path: workspacePath, ...bindingIdentity } = binding;
  const operationBinding = { ...bindingIdentity, workspacePath };

  const edited = await connection.contexts.executeWorkspaceFileOperation({ ...operationBinding, operationId: 'remote-edit-1', operation: 'edit', path: 'same-name.txt', oldText: 'old', newText: 'changed' });
  assert.equal(edited.status, 'completed');
  assert.equal(edited.operation, 'edit');
  assert.deepEqual(edited.changedPaths, ['same-name.txt']);
  assert.equal(await readFile(remoteFile, 'utf8'), 'remote changed\nsecond line\n');
  assert.equal(await readFile(hostSentinel, 'utf8'), 'HOST_SENTINEL');

  const patched = await connection.contexts.executeWorkspaceFileOperation({ ...operationBinding, operationId: 'remote-patch-1', operation: 'patch', path: 'same-name.txt', hunks: [
    { before: 'remote changed', after: 'REMOTE_PROJECT_SENTINEL' },
    { before: 'second line', after: 'test passed' },
  ] });
  assert.equal(patched.status, 'completed');
  assert.deepEqual(patched.changedPaths, ['same-name.txt']);
  assert.equal(await readFile(remoteFile, 'utf8'), 'REMOTE_PROJECT_SENTINEL\ntest passed\n');
  assert.equal(await readFile(hostSentinel, 'utf8'), 'HOST_SENTINEL');

  const conflict = await connection.contexts.executeWorkspaceFileOperation({ ...operationBinding, operationId: 'remote-patch-conflict', operation: 'patch', path: 'same-name.txt', hunks: [{ before: 'absent text', after: 'would be unsafe' }] });
  assert.equal(conflict.status, 'failed');
  assert.equal(conflict.failure, 'content-conflict');
  assert.equal(await readFile(remoteFile, 'utf8'), 'REMOTE_PROJECT_SENTINEL\ntest passed\n');
});

test('Worker operation identities replay completed edits without applying them twice and reject conflicting reuse', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sprout-edit-identity-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = new WorkerWorkspace(root);
  const selected = await workspace.validateWorkspace({ projectId: 'project-identity', environmentInstanceId: 'env-1', kind: 'relative', path: 'repo' });
  const target = join(root, 'repo', 'file.txt');
  await writeFile(target, 'before');
  const files = new WorkerWorkspaceFiles(workspace, 'env-1');
  const binding = { projectId: 'project-identity', environmentInstanceId: 'env-1', bindingId: 'binding-identity', generation: 1, connectionEpoch: 1, workspaceId: selected.workspaceId, kind: 'relative', path: 'repo' } as const;
  await files.attach(binding);
  const { path, ...bindingIdentity } = binding;
  const request = { ...bindingIdentity, workspacePath: path, operationId: 'stable-edit-id', operation: 'edit' as const, path: 'file.txt', oldText: 'before', newText: 'after' };
  const first = await files.execute(request);
  const replay = await files.execute(request);
  assert.deepEqual(replay, first);
  const inspection = await files.inspect({ ...bindingIdentity, path, operationId: 'stable-edit-id' });
  assert.equal(inspection.status, 'completed');
  assert.deepEqual(inspection.result, first);
  assert.equal(await readFile(target, 'utf8'), 'after');
  const conflict = await files.execute({ ...request, newText: 'conflicting' });
  assert.equal(conflict.status, 'failed');
  assert.equal(conflict.failure, 'operation-identity-conflict');
  assert.equal(await readFile(target, 'utf8'), 'after');

  const restarted = new WorkerWorkspaceFiles(workspace, 'env-1');
  await restarted.attach(binding);
  const durableInspection = await restarted.inspect({ ...binding, operationId: 'stable-edit-id' });
  assert.equal(durableInspection.status, 'completed');
  assert.deepEqual(durableInspection.result, first);
  assert.deepEqual(await restarted.execute(request), first, 'the durable journal returns the known result without repeating the edit');
  assert.equal(await readFile(target, 'utf8'), 'after');
});

test('Worker commands stream bounded sequenced output and cancellation remains inspectable until the process stops', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sprout-worker-command-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = new WorkerWorkspace(root);
  const selected = await workspace.validateWorkspace({ projectId: 'command-project', environmentInstanceId: 'env-1', kind: 'relative', path: 'repo' });
  const binding = { projectId: 'command-project', environmentInstanceId: 'env-1', bindingId: 'command-binding', generation: 1,
    connectionEpoch: 1, workspaceId: selected.workspaceId, kind: 'relative', path: 'repo' } as const;
  const { path, ...bindingIdentity } = binding;
  const progress: { operationId: string; sequence: number; stream: string; text: string }[] = [];
  let cancelStartedResolve!: () => void;
  const cancelStarted = new Promise<void>(resolve => { cancelStartedResolve = resolve; });
  const streamedFiles = new WorkerWorkspaceFiles(workspace, 'env-1', chunk => {
    progress.push(chunk);
    if (chunk.operationId === 'command-cancel-1') cancelStartedResolve();
  });
  await streamedFiles.attach(binding);
  const streamed = await streamedFiles.execute({ ...bindingIdentity, workspacePath: path, operationId: 'command-stream-1',
    operation: 'command', executable: 'node', args: ['-e', "process.stdout.write('OUT');process.stderr.write('ERR')"], timeoutMs: 5_000 });
  assert.equal(streamed.status, 'completed');
  assert.equal(streamed.exitCode, 0);
  assert.equal(streamed.output, 'OUTERR');
  assert.deepEqual(streamed.outputChunks?.map(chunk => chunk.sequence), [1, 2]);
  assert.deepEqual(progress.map(chunk => chunk.sequence), [1, 2]);
  assert.deepEqual(progress.map(chunk => chunk.stream), ['stdout', 'stderr']);

  const bounded = await streamedFiles.execute({ ...bindingIdentity, workspacePath: path, operationId: 'command-output-limit-1',
    operation: 'command', executable: 'node', args: ['-e', "process.stdout.write('x'.repeat(50000))"], timeoutMs: 5_000 });
  assert.equal(bounded.status, 'completed');
  assert.equal(bounded.truncated, true);
  assert.equal(Buffer.byteLength(bounded.output ?? '', 'utf8'), 32 * 1024);
  assert.deepEqual(bounded.outputChunks?.map(chunk => chunk.sequence), Array.from({ length: 32 }, (_, index) => index + 1));

  const cancellationPromise = streamedFiles.execute({ ...bindingIdentity, workspacePath: path, operationId: 'command-cancel-1',
    operation: 'command', executable: 'node', args: ['-e', "console.log('started');setInterval(()=>{},1000)"], timeoutMs: 10_000 });
  await cancelStarted;
  const accepted = await streamedFiles.cancel({ ...binding, operationId: 'command-cancel-1' });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.status, 'cancel-requested');
  assert.equal((await streamedFiles.inspect({ ...binding, operationId: 'command-cancel-1' })).status, 'cancel-requested');
  const stopped = await cancellationPromise;
  assert.equal(stopped.status, 'cancelled');
  assert.equal((await streamedFiles.inspect({ ...binding, operationId: 'command-cancel-1' })).status, 'cancelled');
});

test('Worker reports recovery-required when cancellation cannot prove descendant settlement', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sprout-worker-command-recovery-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = new WorkerWorkspace(root);
  const selected = await workspace.validateWorkspace({ projectId: 'command-recovery-project', environmentInstanceId: 'env-1', kind: 'relative', path: 'repo' });
  const binding = { projectId: 'command-recovery-project', environmentInstanceId: 'env-1', bindingId: 'command-recovery-binding', generation: 1,
    connectionEpoch: 1, workspaceId: selected.workspaceId, kind: 'relative', path: 'repo' } as const;
  let commandStarted!: () => void;
  const started = new Promise<void>(resolve => { commandStarted = resolve; });
  const files = new WorkerWorkspaceFiles(workspace, 'env-1', chunk => {
    if (chunk.operationId === 'command-unknown-1') commandStarted();
  }, {
    groupAlive: () => true,
    signalGroup: (pid, signal) => { try { process.kill(-pid, signal); return true; } catch { return false; } },
    gracePeriodMs: 25,
  });
  await files.attach(binding);
  const { path, ...identity } = binding;
  const operation = files.execute({ ...identity, workspacePath: path, operationId: 'command-unknown-1', operation: 'command', executable: 'node',
    args: ['-e', "console.log('started');setInterval(()=>{},1000)"], timeoutMs: 10_000 });
  await started;
  const cancel = await files.cancel({ ...binding, operationId: 'command-unknown-1' });
  assert.equal(cancel.accepted, true);
  assert.equal(cancel.status, 'cancel-requested');
  const result = await operation;
  assert.equal(result.status, 'recovery-required');
  assert.equal(result.failure, 'descendant-process-unknown');
  assert.equal((await files.inspect({ ...binding, operationId: 'command-unknown-1' })).status, 'recovery-required');
});

async function worker(root: string) {
  const server = new URL('./server.ts', import.meta.url).pathname;
  const carrier = new URL('./carrier.ts', import.meta.url).pathname;
  const scripted = new URL('../engine/scripted.ts', import.meta.url).pathname;
  return EndpointCarrier.start({
    command: process.execPath,
    args: ['--input-type=module', '-e', `
      import { EnvironmentWorker } from ${JSON.stringify(server)};
      import { ScriptedEngineAdapter } from ${JSON.stringify(scripted)};
      import { serveWorkerEndpoint, WORKER_READY_PREFIX } from ${JSON.stringify(carrier)};
      const endpoint = await serveWorkerEndpoint({ serve: (socket) => new EnvironmentWorker({
        environmentInstanceId: 'env-1', engines: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
        input: socket, output: socket, workspaceRoot: ${JSON.stringify(root)},
      }) });
      process.stdout.write(WORKER_READY_PREFIX + JSON.stringify(endpoint.ready) + '\\n');
    `],
    label: 'workspace-file-worker',
    onLog: (line) => process.stderr.write(`${line}\\n`),
  });
}
