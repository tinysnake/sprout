import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRegistry } from '../agent/registry.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { ProjectRegistry } from '../project/registry.ts';
import { SqliteStore } from '../store/db.ts';
import { TaskEnvironmentLifecycle } from '../task/environment-lifecycle.ts';
import { EndpointCarrier } from './carrier.ts';
import { WorkerWorkspace } from './workspace.ts';

/**
 * These cases use a separate Worker process and its real filesystem root.  The
 * core only sends ids/facts through the protocol; it never calculates a path.
 */
test('a Worker persists Project workspaces, refreshes Task context, and safely recycles only owned context', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-workspace-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const first = await worker(root);
  t.after(() => first.close());

  const prepared = await first.contexts.prepare(materialization());
  assert.match(prepared.bootstrapInstructions, /^Sprout Task bootstrap:/);
  assert.doesNotMatch(prepared.bootstrapInstructions, /\/Users\/|\\Users\\/);
  const workspace = onlyWorkspace(root);
  const context = onlyContext(workspace);
  writeFileSync(join(workspace, 'AGENTS.md'), '# repository-owned rules\n');
  writeFileSync(join(workspace, 'repository-sentinel.txt'), 'keep\n');

  // A later Agent refreshes only Sprout-owned files and preserves repository work.
  await first.contexts.prepare(materialization({ agentId: 'codex', taskStatus: 'blocked', priorRunSummaries: '- Run 1 (pi, completed): Investigated.' }));
  assert.equal(readFileSync(join(workspace, 'AGENTS.md'), 'utf8'), '# repository-owned rules\n');
  assert.match(readFileSync(join(context, 'TASK.md'), 'utf8'), /Status: blocked/);
  assert.equal(readdirSync(join(context, 'agents')).length, 2, 'both Agents have owned instructions');

  await assert.rejects(
    first.contexts.recycle({ projectId: 'project-1', taskId: 'task-1', environmentInstanceId: 'env-1', environmentLeaseId: 'wrong-lease' }),
    /does not match/,
  );
  assert.equal(existsSync(context), true, 'a mismatched manifest never authorizes deletion');
  writeFileSync(join(context, 'foreign.txt'), 'do not delete\n');
  await assert.rejects(first.contexts.recycle(recycle()), /foreign file/);
  assert.equal(existsSync(join(context, 'foreign.txt')), true, 'foreign context content is retained');
  await rm(join(context, 'foreign.txt'));
  await first.contexts.recycle(recycle());
  assert.equal(existsSync(context), false);
  assert.equal(readFileSync(join(workspace, 'repository-sentinel.txt'), 'utf8'), 'keep\n');

  // A later Task gets a new context in the same durable Project workspace.
  await first.contexts.prepare(materialization({ taskId: 'task-2', agentId: 'pi' }));
  assert.equal(onlyWorkspace(root), workspace);
  assert.equal(existsSync(join(workspace, '.sprout', 'workspace-sentinel.json')), true);
});

test('cleanup can retry through a replacement Worker after a transient failure', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-retry-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const first = await worker(root);
  await first.contexts.prepare(materialization());
  const workspace = onlyWorkspace(root);
  const context = onlyContext(workspace);
  await first.close();

  const replacement = await worker(root);
  t.after(() => replacement.close());
  // The first attempted cleanup is observable as a refused ownership mismatch;
  // a retry against the restarted Worker uses the durable manifest and succeeds.
  await assert.rejects(
    replacement.contexts.recycle({ ...recycle(), environmentLeaseId: 'not-the-lease' }),
    /refusing cleanup/,
  );
  assert.equal(existsSync(context), true);
  await replacement.contexts.recycle(recycle());
  assert.equal(existsSync(context), false);
  assert.equal(existsSync(join(workspace, '.sprout', 'workspace-sentinel.json')), true);
});

test('a planted Project symlink cannot escape the Worker root during prepare, cwd resolution, or recycle', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-symlink-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'sprout-worker-symlink-outside-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const project = join(root, 'projects', hash('project-1'));
  mkdirSync(join(root, 'projects'), { recursive: true });
  symlinkSync(outside, project, 'dir');
  const connection = await worker(root);
  t.after(() => connection.close());

  await assert.rejects(connection.contexts.prepare(materialization()), /outside Worker root/);
  const adapter = connection.adapters.get('scripted');
  assert.ok(adapter);
  await assert.rejects(
    adapter.startSession({ agentId: 'pi', workingDirectory: 'ignored', projectWorkspaceId: 'project-1' }),
    /outside Worker root/,
  );
  await assert.rejects(connection.contexts.recycle(recycle()), /outside Worker root/);
  assert.equal(existsSync(join(outside, '.sprout')), false, 'the Worker never writes or deletes through the planted symlink');
});

test('cleanup authenticates its Sprout manifest and verifies the Project sentinel before deletion', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-cleanup-auth-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const connection = await worker(root);
  t.after(() => connection.close());
  await connection.contexts.prepare(materialization());
  const workspace = onlyWorkspace(root);
  const context = onlyContext(workspace);
  const manifest = recycle();

  // Matching binding fields alone are not ownership: the exact version marker
  // is required before cleanup can remove anything.
  writeFileSync(join(context, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  await assert.rejects(connection.contexts.recycle(recycle()), /ownership marker/);
  assert.equal(existsSync(context), true, 'a forged manifest never authorizes deletion');

  writeFileSync(join(context, 'manifest.json'), `${JSON.stringify({ sprout: 'sprout-task-context-v1', ...manifest })}\n`);
  await connection.contexts.prepare(materialization());
  rmSync(join(workspace, '.sprout', 'workspace-sentinel.json'));
  await assert.rejects(connection.contexts.recycle(recycle()), /sentinel/);
  assert.equal(existsSync(context), true, 'a missing Project sentinel preserves retryable Task context');
  await connection.contexts.prepare(materialization());
  await connection.contexts.recycle(recycle());
  assert.equal(existsSync(context), false, 'refresh restores the sentinel and permits a safe retry');
});

test('a durable cleanup failure retains the Task lease until restart retries through the Worker', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-durable-cleanup-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const filename = join(root, 'state.db');
  const first = await worker(root);
  const store = new SqliteStore({ filename });
  await store.tasks.create({
    id: 'task-1', projectId: 'project-1', title: 'Task one', goal: 'Do useful work.', constraints: [],
    status: 'todo', assignedAgentId: 'pi', createdAt: 1, updatedAt: 1,
  });
  const initial = lifecycle(store, first, true);
  const begun = await initial.lifecycle.begin('task-1');
  await assert.rejects(initial.lifecycle.end('task-1'), /temporary recycle failure/);
  assert.equal((await store.tasks.get('task-1'))?.environmentLifecycleState, 'recovery');
  assert.equal(initial.pool.getLease(begun.environmentLeaseId!)?.state, 'recovering');
  store.close();
  await first.close();

  const replacement = await worker(root);
  t.after(() => replacement.close());
  const reopened = new SqliteStore({ filename });
  const retry = lifecycle(reopened, replacement, false);
  assert.equal(retry.pool.getLease(begun.environmentLeaseId!)?.state, 'recovering');
  const discarded = await retry.lifecycle.recover('task-1', 'discard');
  assert.equal(discarded.environmentLifecycleState, 'discarded');
  assert.equal(retry.pool.getLease(begun.environmentLeaseId!)?.state, 'released');
  reopened.close();
});

function materialization(overrides: Partial<Parameters<typeof taskInput>[0]> = {}) {
  return taskInput(overrides);
}

function taskInput(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'project-1', projectGoal: 'Keep durable work.', projectRules: ['Preserve user files.'],
    taskId: 'task-1', taskTitle: 'Task one', taskGoal: 'Do useful work.', taskConstraints: ['Be safe.'],
    taskStatus: 'in-progress', priorRunSummaries: '', agentId: 'pi', responsibilities: ['Inspect.'],
    collaborationInstructions: 'Report facts.', environmentInstanceId: 'env-1', environmentLeaseId: 'lease-1',
    ...overrides,
  } as const;
}

function recycle() {
  return { projectId: 'project-1', taskId: 'task-1', environmentInstanceId: 'env-1', environmentLeaseId: 'lease-1' };
}

function onlyWorkspace(root: string): string {
  const projects = join(root, 'projects');
  return join(projects, readdirSync(projects)[0]!);
}

function onlyContext(workspace: string): string {
  const tasks = join(workspace, '.sprout', 'tasks');
  return join(tasks, readdirSync(tasks)[0]!);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

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
    label: 'workspace-worker',
    onLog: (line) => process.stderr.write(`${line}\n`),
  });
}

function lifecycle(store: SqliteStore, connection: Awaited<ReturnType<typeof worker>>, failRecycle: boolean) {
  const pool = new EnvironmentPool({
    definitions: [{ id: 'mac', platform: 'macos', capabilities: [{ name: 'agent-run', requiresLease: true }] }],
    instances: [{ id: 'env-1', definitionId: 'mac' }],
    store: store.leases,
    idFactory: () => 'lease-1',
  });
  const lifecycle = new TaskEnvironmentLifecycle({
    store: store.tasks,
    pool,
    agents: new AgentRegistry([{ id: 'pi', name: 'Pi', engine: 'scripted', capability: 'agent-run' }]),
    projects: new ProjectRegistry([{ id: 'project-1', goal: 'Keep durable work.', rules: ['Preserve user files.'], availableEnvironmentInstanceIds: ['env-1'], memberships: [{ agentId: 'pi', responsibilities: ['Inspect.'], collaborationInstructions: 'Report facts.' }] }]),
    runs: { submit: async (request) => ({ id: request.runId }) },
    worker: {
      prepare: (input) => connection.contexts.prepare(input),
      recycle: async (input) => {
        if (failRecycle) throw new Error('temporary recycle failure');
        await connection.contexts.recycle(input);
      },
    },
    ids: { task: () => 'task', message: () => 'message', lease: () => 'lease-1', run: () => 'run-1' },
    clock: { now: () => 2 },
  });
  return { pool, lifecycle };
}

/**
 * Worker-owned Project workspace validation (#93).
 *
 * The Worker is the filesystem authority: it turns a portable selection into a
 * real workspace and returns an opaque identity plus, for a relative selection,
 * the relative location. The absolute location never crosses the boundary.
 */
test('the Worker validates a default and a relative Project workspace selection without exposing the root', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-validate-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const connection = await worker(root);
  t.after(() => connection.close());

  const defaultWorkspace = await connection.contexts.validateWorkspace({
    projectId: 'project-1',
    environmentInstanceId: 'env-1',
    kind: 'default',
  });
  assert.equal(defaultWorkspace.kind, 'default');
  assert.match(defaultWorkspace.workspaceId, /^[a-f0-9]{24}$/);
  assert.equal(defaultWorkspace.path, undefined);
  // The default workspace exists below the Worker's own projects root.
  assert.equal(existsSync(join(root, 'projects', hash('project-1'))), true);

  const relative = await connection.contexts.validateWorkspace({
    projectId: 'project-1',
    environmentInstanceId: 'env-1',
    kind: 'relative',
    path: 'repos/sprout',
  });
  assert.equal(relative.kind, 'relative');
  assert.equal(relative.path, 'repos/sprout');
  assert.match(relative.workspaceId, /^[a-f0-9]{24}$/);
  // The relative location was created and resolves below the physical root.
  assert.equal(existsSync(join(root, 'repos', 'sprout')), true);
  // The result never carries the absolute root.
  assert.ok(!JSON.stringify(relative).includes(root));
});

test('a validated Worker-managed default identity starts in the directory it validated', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-default-start-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const connection = await worker(root);
  t.after(() => connection.close());

  const binding = await connection.contexts.validateWorkspace({
    projectId: 'project-1', environmentInstanceId: 'env-1', kind: 'default',
  });
  const boundary = new WorkerWorkspace(root);

  assert.equal(
    await boundary.projectWorkingDirectory(binding.workspaceId, undefined, binding.kind),
    await realpath(join(root, 'projects', hash('project-1'))),
    'the start-session resolver reaches the exact default directory validation prepared, without hashing the opaque id again',
  );
});

test('the Worker refuses to validate an escaping or absolute relative selection', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-validate-unsafe-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const connection = await worker(root);
  t.after(() => connection.close());

  await assert.rejects(
    connection.contexts.validateWorkspace({
      projectId: 'project-1',
      environmentInstanceId: 'env-1',
      kind: 'relative',
      path: '../outside',
    }),
    /relative/,
  );
  await assert.rejects(
    connection.contexts.validateWorkspace({
      projectId: 'project-1',
      environmentInstanceId: 'env-1',
      kind: 'relative',
      path: '/absolute/path',
    }),
    /relative/,
  );
  assert.equal(existsSync(join(root, '..', 'outside')), false);
});

test('a planted symlink cannot make workspace validation escape the Worker root', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-validate-symlink-'));
  const outside = mkdtempSync(join(tmpdir(), 'sprout-worker-validate-outside-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'repos'), { recursive: true });
  symlinkSync(outside, join(root, 'repos', 'planted'), 'dir');
  const connection = await worker(root);
  t.after(() => connection.close());

  await assert.rejects(
    connection.contexts.validateWorkspace({
      projectId: 'project-1',
      environmentInstanceId: 'env-1',
      kind: 'relative',
      path: 'repos/planted',
    }),
    /outside Worker root/,
  );
  assert.equal(existsSync(join(outside, '.sprout')), false);
});

/**
 * The Worker/start boundary (ADR-0009): the core names portable facts only, so
 * a corrupt projection that carried an absolute host path is refused here
 * rather than resolved into a real location.
 */
test('the Worker refuses to resolve an absolute or escaping registered workspace path', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sprout-worker-start-boundary-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const connection = await worker(root);
  t.after(() => connection.close());
  const boundary = new WorkerWorkspace(root);

  for (const corrupt of ['/Users/<user>/private', '../outside', 'C:\\Users\\x']) {
    await assert.rejects(
      boundary.projectWorkingDirectory('project-1', corrupt),
      /relative/,
    );
  }
  // Nothing was created outside or inside the root for the refused paths.
  assert.equal(existsSync(join(root, 'Users')), false);
  assert.equal(existsSync(join(root, '..', 'outside')), false);
  // A safe relative location still resolves (creating it, as the default
  // workspace flow does), so the refusal is not a shutdown.
  await mkdir(join(root, 'repos', 'sprout'), { recursive: true });
  const safe = await boundary.projectWorkingDirectory('project-1', 'repos/sprout');
  assert.equal(safe, await realpath(join(root, 'repos', 'sprout')), 'the resolved location stays below the root');
});
