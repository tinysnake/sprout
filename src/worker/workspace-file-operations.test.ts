import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerWorkspace } from './workspace.ts';
import { WorkerWorkspaceFiles } from './workspace-file-operations.ts';

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
  await assert.rejects(files.attach({ ...binding, workspaceId: second.workspaceId, path: 'repo-two' }), /conflicting workspace binding/);

  const firstRead = await files.execute({ ...binding, operationId: 'operation-1', operation: 'read', path: 'sentinel.txt' });
  assert.equal(firstRead.content, 'first workspace', 'a refused attach leaves the original generation bound');

  const next = { ...binding, bindingId: 'binding-2', generation: 2, workspaceId: second.workspaceId, path: 'repo-two' } as const;
  await files.attach(next);
  await assert.rejects(
    files.execute({ ...binding, operationId: 'operation-2', operation: 'read', path: 'sentinel.txt' }),
    /stale workspace binding/,
  );
  const secondRead = await files.execute({ ...next, operationId: 'operation-3', operation: 'read', path: 'sentinel.txt' });
  assert.equal(secondRead.content, 'second workspace');

  await assert.rejects(files.attach({ ...next, bindingId: 'binding-3', generation: 3, connectionEpoch: 3 }), /stale workspace binding/);
});
