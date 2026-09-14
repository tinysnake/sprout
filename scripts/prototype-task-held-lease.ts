/**
 * Disposable evidence for #31. This is intentionally not imported by src/: it
 * explores the proposed TaskEnvironmentLifecycle seam without changing a
 * production caller.
 *
 * The controller owns durable ordering in SQLite. The environment worker is a
 * separate Node process and is the only process that creates, inspects, or
 * recycles project/task files. Its engine is deliberately fake; the worker and
 * SQLite boundaries are real.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const PORT = 41010;
const INSTANCE = 'prototype-macos-environment';

type TaskState =
  | 'beginning'
  | 'idle'
  | 'running'
  | 'blocked'
  | 'awaiting-validation'
  | 'ending'
  | 'recovery'
  | 'ended'
  | 'discarded';
type LeaseState = 'active' | 'recovering' | 'released';
type RecoveryAction = 'resume' | 'discard';

interface TaskRow {
  readonly id: string;
  readonly project_id: string;
  readonly instance_id: string;
  readonly lease_id: string;
  readonly state: TaskState;
  readonly recovery_state: TaskState | null;
  readonly active_run_id: string | null;
}

interface LeaseRow {
  readonly id: string;
  readonly instance_id: string;
  readonly holder_kind: 'task' | 'run';
  readonly holder_id: string;
  readonly state: LeaseState;
}

interface RunRow {
  readonly id: string;
  readonly task_id: string | null;
  readonly agent_id: string;
  readonly state: 'running' | 'completed' | 'stopped' | 'failed';
}

interface WorkerReply {
  readonly id: number;
  readonly ok: boolean;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
}

interface WorkerRequest {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** Minimal real process boundary used only by this disposable prototype. */
class PrototypeWorkerClient {
  readonly #socket: net.Socket;
  readonly #pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(reason: Error): void }>();
  #nextId = 0;
  #buffer = '';

  private constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.#receive(chunk));
    socket.on('error', (error) => this.#failAll(error));
    socket.on('close', () => this.#failAll(new Error('environment worker channel closed')));
  }

  static async connect(port: number): Promise<PrototypeWorkerClient> {
    const socket = net.createConnection({ port });
    await Promise.race([
      once(socket, 'connect'),
      once(socket, 'error').then(([error]) => Promise.reject(error)),
    ]);
    return new PrototypeWorkerClient(socket);
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.#nextId;
    const request: WorkerRequest = { id, method, params };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.write(`${JSON.stringify(request)}\n`);
    });
  }

  close(): void {
    this.#socket.end();
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const reply = JSON.parse(line) as WorkerReply;
      const pending = this.#pending.get(reply.id);
      this.#pending.delete(reply.id);
      if (pending) {
        if (reply.ok) pending.resolve(reply.result ?? {});
        else pending.reject(new Error(reply.error ?? 'environment worker failed'));
      }
      newline = this.#buffer.indexOf('\n');
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

/** The durable boundary. All task/lease ordering belongs here, not in callers. */
class PrototypeStore {
  readonly #db: DatabaseSync;

  constructor(filename: string) {
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS prototype_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        lease_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        recovery_state TEXT,
        active_run_id TEXT
      );
      CREATE TABLE IF NOT EXISTS prototype_leases (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        holder_kind TEXT NOT NULL,
        holder_id TEXT NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS prototype_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        agent_id TEXT NOT NULL,
        state TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.#db.close();
  }

  task(id: string): TaskRow | undefined {
    return this.#db.prepare('SELECT * FROM prototype_tasks WHERE id = ?').get(id) as TaskRow | undefined;
  }

  lease(id: string): LeaseRow | undefined {
    return this.#db.prepare('SELECT * FROM prototype_leases WHERE id = ?').get(id) as LeaseRow | undefined;
  }

  run(id: string): RunRow | undefined {
    return this.#db.prepare('SELECT * FROM prototype_runs WHERE id = ?').get(id) as RunRow | undefined;
  }

  liveLease(instanceId: string): LeaseRow | undefined {
    return this.#db
      .prepare("SELECT * FROM prototype_leases WHERE instance_id = ? AND state != 'released'")
      .get(instanceId) as LeaseRow | undefined;
  }

  createTaskAndLease(taskId: string, projectId: string, instanceId: string): TaskRow {
    const existing = this.task(taskId);
    if (existing) return existing;
    const conflict = this.liveLease(instanceId);
    if (conflict) {
      throw new Error(`environment ${instanceId} is unavailable: held by ${conflict.holder_kind} ${conflict.holder_id} (${conflict.state})`);
    }
    const leaseId = `task-lease-${taskId}`;
    this.#db.exec('BEGIN');
    try {
      this.#db
        .prepare('INSERT INTO prototype_leases VALUES (?, ?, ?, ?, ?)')
        .run(leaseId, instanceId, 'task', taskId, 'active');
      this.#db
        .prepare('INSERT INTO prototype_tasks VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(taskId, projectId, instanceId, leaseId, 'beginning', null, null);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return this.requireTask(taskId);
  }

  updateTask(taskId: string, state: TaskState, recoveryState: TaskState | null, activeRunId: string | null): void {
    this.#db
      .prepare('UPDATE prototype_tasks SET state = ?, recovery_state = ?, active_run_id = ? WHERE id = ?')
      .run(state, recoveryState, activeRunId, taskId);
  }

  updateLease(leaseId: string, state: LeaseState): void {
    this.#db.prepare('UPDATE prototype_leases SET state = ? WHERE id = ?').run(state, leaseId);
  }

  createRun(id: string, taskId: string | null, agentId: string): void {
    this.#db.prepare('INSERT INTO prototype_runs VALUES (?, ?, ?, ?)').run(id, taskId, agentId, 'running');
  }

  createRunLease(leaseId: string, runId: string): void {
    this.#db
      .prepare('INSERT INTO prototype_leases VALUES (?, ?, ?, ?, ?)')
      .run(leaseId, INSTANCE, 'run', runId, 'active');
  }

  settleRun(runId: string, state: RunRow['state']): void {
    this.#db.prepare('UPDATE prototype_runs SET state = ? WHERE id = ?').run(state, runId);
  }

  markRestartRecovery(): void {
    const tasks = this.#db
      .prepare("SELECT * FROM prototype_tasks WHERE state NOT IN ('ended', 'discarded')")
      .all() as unknown as TaskRow[];
    for (const task of tasks) {
      if (task.state !== 'recovery') {
        this.updateTask(task.id, 'recovery', task.state, task.active_run_id);
      }
      this.updateLease(task.lease_id, 'recovering');
    }
  }

  finishEnd(task: TaskRow, endState: 'ended' | 'discarded'): void {
    this.#db.exec('BEGIN');
    try {
      this.updateLease(task.lease_id, 'released');
      this.updateTask(task.id, endState, null, null);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  requireTask(id: string): TaskRow {
    const task = this.task(id);
    if (!task) throw new Error(`unknown task ${id}`);
    return task;
  }
}

interface FaultPoint {
  afterPrepare?: () => never;
  afterRecycle?: () => never;
}

/**
 * Candidate deep module selected by the prototype. It serializes durable intent,
 * worker filesystem effects, and lease transitions so callers cannot reorder
 * them. The fake engine remains behind the real worker boundary.
 */
class TaskEnvironmentLifecycle {
  readonly #store: PrototypeStore;
  readonly #worker: PrototypeWorkerClient;
  readonly #fault: FaultPoint;
  #runNumber = 0;

  constructor(store: PrototypeStore, worker: PrototypeWorkerClient, fault: FaultPoint = {}) {
    this.#store = store;
    this.#worker = worker;
    this.#fault = fault;
  }

  async begin(taskId: string, projectId: string, instanceId = INSTANCE): Promise<TaskRow> {
    const task = this.#store.createTaskAndLease(taskId, projectId, instanceId);
    if (task.state !== 'beginning') return task;
    try {
      await this.#worker.request('task/prepare', { taskId, projectId });
    } catch (error) {
      this.timeout(taskId);
      throw error;
    }
    this.#fault.afterPrepare?.();
    this.#store.updateTask(taskId, 'idle', null, null);
    return this.#store.requireTask(taskId);
  }

  async beginRun(taskId: string, agentId: string, outcome: RunRow['state']): Promise<string> {
    const task = this.#store.requireTask(taskId);
    if (!['idle', 'blocked', 'awaiting-validation'].includes(task.state)) {
      throw new Error(`task ${taskId} is ${task.state}; it cannot start another run`);
    }
    const lease = this.#store.lease(task.lease_id);
    if (!lease || lease.state !== 'active') throw new Error(`task ${taskId} lease is not active`);
    const runId = `task-run-${++this.#runNumber}`;
    this.#store.createRun(runId, taskId, agentId);
    this.#store.updateTask(taskId, 'running', null, runId);
    // A fake engine is intentional. The execution still crosses a real worker
    // process, while the durable run remains active until this controller settles it.
    try {
      await this.#worker.request('engine/run-fake', { taskId, projectId: task.project_id, agentId, outcome });
    } catch (error) {
      this.timeout(taskId);
      throw error;
    }
    return runId;
  }

  settleRun(runId: string, outcome: RunRow['state']): void {
    const run = this.#store.run(runId);
    if (!run || !run.task_id) throw new Error(`unknown Task run ${runId}`);
    const task = this.#store.requireTask(run.task_id);
    if (task.active_run_id !== runId) throw new Error(`run ${runId} is not active for Task ${task.id}`);
    this.#store.settleRun(runId, outcome);
    // Deliberately no lease transition here: all terminal run outcomes preserve
    // the outer Task reservation.
    this.#store.updateTask(task.id, outcome === 'completed' ? 'idle' : 'blocked', null, null);
  }

  setWaiting(taskId: string, state: 'blocked' | 'awaiting-validation'): void {
    const task = this.#store.requireTask(taskId);
    if (task.active_run_id) throw new Error(`task ${taskId} has an active run`);
    this.#store.updateTask(taskId, state, null, null);
  }

  timeout(taskId: string): void {
    const task = this.#store.requireTask(taskId);
    if (task.state === 'ended' || task.state === 'discarded') return;
    this.#store.updateTask(taskId, 'recovery', task.state, task.active_run_id);
    this.#store.updateLease(task.lease_id, 'recovering');
  }

  restart(): void {
    this.#store.markRestartRecovery();
  }

  async recover(taskId: string, action: RecoveryAction): Promise<void> {
    const task = this.#store.requireTask(taskId);
    if (task.state !== 'recovery') throw new Error(`task ${taskId} is not awaiting recovery`);
    const prior = task.recovery_state;
    if (action === 'discard') {
      await this.#recycleThenRelease(task, 'discarded');
      return;
    }
    if (prior === 'beginning') {
      await this.#worker.request('task/prepare', { taskId: task.id, projectId: task.project_id });
      this.#store.updateLease(task.lease_id, 'active');
      this.#store.updateTask(task.id, 'idle', null, null);
      return;
    }
    if (prior === 'ending') {
      throw new Error(`task ${taskId} was ending; complete cleanup with discard instead of resuming`);
    }
    // A run observed as active across interruption is not restarted implicitly.
    // It becomes visible blocked work that the human advances deliberately.
    if (task.active_run_id) this.#store.settleRun(task.active_run_id, 'failed');
    this.#store.updateLease(task.lease_id, 'active');
    this.#store.updateTask(task.id, 'blocked', null, null);
  }

  async end(taskId: string): Promise<void> {
    const task = this.#store.requireTask(taskId);
    if (task.active_run_id) throw new Error(`task ${taskId} cannot end while run ${task.active_run_id} is active`);
    if (!['idle', 'blocked', 'awaiting-validation'].includes(task.state)) {
      throw new Error(`task ${taskId} is ${task.state}; it cannot end`);
    }
    this.#store.updateTask(taskId, 'ending', null, null);
    try {
      await this.#recycleThenRelease(this.#store.requireTask(taskId), 'ended');
    } catch (error) {
      this.timeout(taskId);
      throw error;
    }
  }

  async runMessage(runId: string, agentId: string): Promise<LeaseRow> {
    const conflict = this.#store.liveLease(INSTANCE);
    if (conflict) throw new Error(`message run cannot acquire ${INSTANCE}: held by ${conflict.holder_kind}`);
    const leaseId = `message-lease-${runId}`;
    this.#store.createRun(runId, null, agentId);
    // The run, not a Task, owns this one-round lease; no task context is prepared.
    this.#store.createRunLease(leaseId, runId);
    await this.#worker.request('engine/run-fake', { taskId: null, agentId, outcome: 'completed' });
    this.#store.settleRun(runId, 'completed');
    this.#store.updateLease(leaseId, 'released');
    return this.#store.lease(leaseId)!;
  }

  async #recycleThenRelease(task: TaskRow, endState: 'ended' | 'discarded'): Promise<void> {
    // The worker's recycle operation is manifest-validated and idempotent. A
    // crash after it succeeds leaves the durable lease held in `ending`; retrying
    // it is safe, and release cannot precede destructive cleanup.
    await this.#worker.request('task/recycle', { taskId: task.id, projectId: task.project_id });
    this.#fault.afterRecycle?.();
    this.#store.finishEnd(task, endState);
  }
}

async function runWorker(root: string, port: number): Promise<void> {
  await mkdir(root, { recursive: true });
  const safe = (value: unknown, label: string): string => {
    if (typeof value !== 'string' || !/^[a-z0-9-]+$/i.test(value)) throw new Error(`invalid ${label}`);
    return value;
  };
  const projectWorkspace = (projectId: string) => join(root, 'projects', projectId, 'workspace');
  const taskContext = (taskId: string) => join(root, 'tasks', taskId);

  const handle = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (method === 'worker/dispose') {
      await rm(root, { recursive: true, force: true });
      return {};
    }
    if (method === 'project/seed-sentinel') {
      const projectId = safe(params.projectId, 'project id');
      await mkdir(projectWorkspace(projectId), { recursive: true });
      await writeFile(join(projectWorkspace(projectId), 'project-sentinel.txt'), 'persistent-project-state');
      return {};
    }
    if (method === 'task/prepare') {
      const taskId = safe(params.taskId, 'task id');
      const projectId = safe(params.projectId, 'project id');
      await mkdir(projectWorkspace(projectId), { recursive: true });
      await mkdir(taskContext(taskId), { recursive: true });
      await writeFile(
        join(taskContext(taskId), 'manifest.json'),
        JSON.stringify({ taskId, projectId, kind: 'sprout-task-context-v1' }),
      );
      return { prepared: true };
    }
    if (method === 'task/recycle') {
      const taskId = safe(params.taskId, 'task id');
      const projectId = safe(params.projectId, 'project id');
      const context = taskContext(taskId);
      try {
        const manifest = JSON.parse(await readFile(join(context, 'manifest.json'), 'utf8')) as Record<string, unknown>;
        if (manifest.taskId !== taskId || manifest.projectId !== projectId || manifest.kind !== 'sprout-task-context-v1') {
          throw new Error('task context manifest does not authorize recycle');
        }
        await rm(context, { recursive: true, force: true });
        return { recycled: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { recycled: true, alreadyAbsent: true };
        throw error;
      }
    }
    if (method === 'worker/inspect') {
      const taskId = safe(params.taskId, 'task id');
      const projectId = safe(params.projectId, 'project id');
      const exists = async (path: string): Promise<boolean> => {
        try {
          await readFile(path);
          return true;
        } catch {
          return false;
        }
      };
      const sentinel = join(projectWorkspace(projectId), 'project-sentinel.txt');
      return {
        projectSentinel: (await exists(sentinel)) ? await readFile(sentinel, 'utf8') : null,
        contextExists: await exists(join(taskContext(taskId), 'manifest.json')),
        runLog: (await exists(join(projectWorkspace(projectId), 'run-log.txt')))
          ? await readFile(join(projectWorkspace(projectId), 'run-log.txt'), 'utf8')
          : '',
      };
    }
    if (method === 'engine/run-fake') {
      const agentId = safe(params.agentId, 'agent id');
      const outcome = safe(params.outcome, 'outcome');
      if (params.projectId !== undefined) {
        const projectId = safe(params.projectId, 'project id');
        await mkdir(projectWorkspace(projectId), { recursive: true });
        await appendFile(join(projectWorkspace(projectId), 'run-log.txt'), `${agentId}:${outcome}\n`);
      }
      return { agentId, outcome, engine: 'fake-engine' };
    }
    throw new Error(`unknown worker method ${method}`);
  };

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void (async () => {
          const request = JSON.parse(line) as WorkerRequest;
          try {
            const result = await handle(request.method, request.params);
            socket.write(`${JSON.stringify({ id: request.id, ok: true, result } satisfies WorkerReply)}\n`);
          } catch (error) {
            socket.write(`${JSON.stringify({ id: request.id, ok: false, error: String(error) } satisfies WorkerReply)}\n`);
          }
        })();
        newline = buffer.indexOf('\n');
      }
    });
  });
  server.listen(port);
  await once(server, 'listening');
}

async function waitForWorker(port: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const client = await PrototypeWorkerClient.connect(port);
      client.close();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error('prototype environment worker did not start');
}

async function runCrashMode(kind: 'begin' | 'end', database: string, port: number): Promise<never> {
  const store = new PrototypeStore(database);
  const worker = await PrototypeWorkerClient.connect(port);
  const fault = {
    ...(kind === 'begin' ? { afterPrepare: () => process.exit(91) } : {}),
    ...(kind === 'end' ? { afterRecycle: () => process.exit(92) } : {}),
  };
  const lifecycle = new TaskEnvironmentLifecycle(store, worker, fault);
  if (kind === 'begin') await lifecycle.begin('crash-begin', 'project-alpha');
  else await lifecycle.end('crash-end');
  throw new Error('fault injection did not terminate the core process');
}

async function expectConflict(lifecycle: TaskEnvironmentLifecycle, taskId: string): Promise<void> {
  await assert.rejects(lifecycle.begin(taskId, 'project-beta'), /environment .* unavailable/);
}

async function spawnCrash(kind: 'begin' | 'end', database: string): Promise<number | null> {
  const child = spawn(process.execPath, [SCRIPT, `--crash-${kind}`, `--database=${database}`, `--port=${PORT}`], {
    stdio: 'ignore',
  });
  const [code] = (await once(child, 'exit')) as [number | null];
  return code;
}

async function runPrototype(): Promise<void> {
  // The controller chooses only an opaque sandbox name. The worker creates and
  // removes everything in that environment, including Project and Task paths.
  const root = join(tmpdir(), `sprout-task-held-lease-${process.pid}-${Date.now()}`);
  const database = join(root, 'prototype.sqlite');
  const worker = spawn(process.execPath, [SCRIPT, '--worker', `--root=${root}`, `--port=${PORT}`], {
    stdio: 'ignore',
  });
  let store: PrototypeStore | undefined;
  let client: PrototypeWorkerClient | undefined;
  try {
    await waitForWorker(PORT);
    store = new PrototypeStore(database);
    client = await PrototypeWorkerClient.connect(PORT);
    const lifecycle = new TaskEnvironmentLifecycle(store, client);
    await client.request('project/seed-sentinel', { projectId: 'project-alpha' });

    // One durable Task lease spans exactly the Pi -> Codex -> Pi sequence. The
    // distinct terminal outcomes prove nested runs never release that lease.
    const task = await lifecycle.begin('task-main', 'project-alpha');
    const leaseId = task.lease_id;
    for (const [agent, outcome] of [
      ['agent-pi', 'completed'],
      ['agent-codex', 'stopped'],
      ['agent-pi', 'failed'],
    ] as const) {
      const runId = await lifecycle.beginRun('task-main', agent, outcome);
      lifecycle.settleRun(runId, outcome);
      assert.equal(store.lease(leaseId)?.state, 'active', `${outcome} run retained the Task lease`);
    }

    // Idle, blocked, and human-validation gaps all retain the reservation.
    lifecycle.setWaiting('task-main', 'awaiting-validation');
    await expectConflict(lifecycle, 'task-conflict-validation');
    lifecycle.setWaiting('task-main', 'blocked');
    await expectConflict(lifecycle, 'task-conflict-blocked');
    lifecycle.settleRun(await lifecycle.beginRun('task-main', 'agent-codex', 'completed'), 'completed');
    await expectConflict(lifecycle, 'task-conflict-idle');

    // End must refuse the persisted active-run window before it can recycle.
    const activeRun = await lifecycle.beginRun('task-main', 'agent-pi', 'completed');
    await assert.rejects(lifecycle.end('task-main'), /cannot end while run/);
    lifecycle.settleRun(activeRun, 'completed');
    await lifecycle.end('task-main');
    assert.equal(store.lease(leaseId)?.state, 'released');
    const mainFiles = await client.request('worker/inspect', { taskId: 'task-main', projectId: 'project-alpha' });
    assert.equal(mainFiles.contextExists, false);
    assert.equal(mainFiles.projectSentinel, 'persistent-project-state');
    assert.match(String(mainFiles.runLog), /^agent-pi:completed\nagent-codex:stopped\nagent-pi:failed\n/);

    // Timeout is recovery, never expiration/reassignment. The owner can resume
    // explicitly and retains its original lease and workspace.
    const timeoutTask = await lifecycle.begin('task-timeout', 'project-alpha');
    lifecycle.timeout(timeoutTask.id);
    assert.equal(store.lease(timeoutTask.lease_id)?.state, 'recovering');
    await expectConflict(lifecycle, 'task-conflict-timeout');
    await lifecycle.recover(timeoutTask.id, 'resume');
    assert.equal(store.lease(timeoutTask.lease_id)?.state, 'active');
    await lifecycle.end(timeoutTask.id);

    // Crash after worker prepare, before the core records ready: durable intent
    // and the worker manifest make restart a blocking recovery, then a safe resume.
    assert.equal(await spawnCrash('begin', database), 91);
    const afterBeginCrash = new PrototypeStore(database);
    const crashBegin = new TaskEnvironmentLifecycle(afterBeginCrash, client);
    crashBegin.restart();
    assert.equal(afterBeginCrash.task('crash-begin')?.state, 'recovery');
    await expectConflict(crashBegin, 'task-conflict-crash-begin');
    await crashBegin.recover('crash-begin', 'resume');
    await crashBegin.end('crash-begin');
    afterBeginCrash.close();

    // Crash after worker recycle, before lease release: the lease remains held
    // through recovery; an operator deliberately discards and retries idempotent cleanup.
    await lifecycle.begin('crash-end', 'project-alpha');
    assert.equal(await spawnCrash('end', database), 92);
    const afterEndCrash = new PrototypeStore(database);
    const crashEnd = new TaskEnvironmentLifecycle(afterEndCrash, client);
    crashEnd.restart();
    assert.equal(afterEndCrash.task('crash-end')?.state, 'recovery');
    await expectConflict(crashEnd, 'task-conflict-crash-end');
    const endFiles = await client.request('worker/inspect', { taskId: 'crash-end', projectId: 'project-alpha' });
    assert.equal(endFiles.contextExists, false);
    assert.equal(endFiles.projectSentinel, 'persistent-project-state');
    await crashEnd.recover('crash-end', 'discard');
    assert.equal(afterEndCrash.lease('task-lease-crash-end')?.state, 'released');
    afterEndCrash.close();

    // A Message is one run, not a disguised Task. Its run-held lease ends when
    // its single fake-engine turn settles and it never prepares Task context.
    const messageLease = await lifecycle.runMessage('message-run-1', 'agent-pi');
    assert.equal(messageLease.holder_kind, 'run');
    assert.equal(messageLease.state, 'released');

    console.log('task-held lease prototype checks: PASS');
  } finally {
    store?.close();
    if (client) {
      await client.request('worker/dispose', {}).catch(() => undefined);
      client.close();
    }
    worker.kill('SIGTERM');
    await once(worker, 'exit').catch(() => undefined);
  }
}

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.split('=', 2);
  return [key!, value];
}));

if (args.has('--worker')) {
  const root = args.get('--root');
  const port = Number(args.get('--port'));
  if (!root || !Number.isInteger(port)) throw new Error('worker requires root and port');
  await runWorker(root, port);
} else if (args.has('--crash-begin') || args.has('--crash-end')) {
  const database = args.get('--database');
  const port = Number(args.get('--port'));
  if (!database || !Number.isInteger(port)) throw new Error('crash mode requires database and port');
  await runCrashMode(args.has('--crash-begin') ? 'begin' : 'end', database, port);
} else {
  await runPrototype();
}
