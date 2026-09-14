/**
 * The outer Task environment lifecycle (#32).
 *
 * This is the only production module allowed to compose Task persistence, a
 * Task-held lease, nested-run admission, and the Worker context seam.  The
 * Task service, run orchestrator, HTTP API, and eventual Web controls call its
 * five commands; they do not recreate this ordering themselves.
 */

import type { AgentRegistry } from '../agent/registry.ts';
import type { EnvironmentPreference } from '../environment/model.ts';
import type { EnvironmentPool } from '../environment/pool.ts';
import { createIdFactory, type IdFactory } from '../ids.ts';
import { resolveEnvironmentInstance } from '../project/resolve.ts';
import type { ProjectRegistry } from '../project/registry.ts';
import type { AgentRun } from '../run/model.ts';
import type { Task } from './model.ts';
import type { TaskStore } from './store.ts';

export type TaskRecoveryAction = 'resume' | 'discard';

/** #33 replaces this contract implementation with the Worker protocol. */
export interface TaskContextWorker {
  prepare(input: { readonly taskId: string; readonly projectId: string; readonly environmentInstanceId: string }): Promise<void>;
  recycle(input: { readonly taskId: string; readonly projectId: string; readonly environmentInstanceId: string }): Promise<void>;
}

/** Deliberate production stub: no core filesystem operation is permitted by ADR-0003. */
export const noOpTaskContextWorker: TaskContextWorker = {
  async prepare() {},
  async recycle() {},
};

export interface TaskEnvironmentRunner {
  submit(request: {
    readonly runId: string;
    readonly agentId: string;
    readonly prompt: string;
    readonly taskId: string;
    readonly projectId: string;
    readonly environmentInstanceId: string;
    readonly environmentLeaseId: string;
  }): Promise<{ readonly id: string }>;
}

export interface TaskEnvironmentLifecycleOptions {
  readonly store: TaskStore;
  readonly pool: EnvironmentPool;
  readonly agents: AgentRegistry;
  readonly projects: ProjectRegistry;
  readonly runs: TaskEnvironmentRunner;
  readonly worker?: TaskContextWorker;
  readonly ids?: IdFactory;
  readonly clock?: { now(): number };
  readonly leaseTtlMs?: number;
}

/**
 * Durable coordinator for `begin`, `advanceRun`, `settleRun`, `end`, and
 * `recover`, in the exact ordering selected by prototype #31.
 */
export class TaskEnvironmentLifecycle {
  readonly #store: TaskStore;
  readonly #pool: EnvironmentPool;
  readonly #agents: AgentRegistry;
  readonly #projects: ProjectRegistry;
  readonly #runs: TaskEnvironmentRunner;
  readonly #worker: TaskContextWorker;
  readonly #ids: IdFactory;
  readonly #clock: { now(): number };
  readonly #leaseTtlMs: number;

  constructor(options: TaskEnvironmentLifecycleOptions) {
    this.#store = options.store;
    this.#pool = options.pool;
    this.#agents = options.agents;
    this.#projects = options.projects;
    this.#runs = options.runs;
    this.#worker = options.worker ?? noOpTaskContextWorker;
    this.#ids = options.ids ?? createIdFactory();
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#leaseTtlMs = options.leaseTtlMs ?? 300_000;
  }

  async begin(taskId: string, options: { readonly agentId?: string; readonly selection?: EnvironmentPreference } = {}): Promise<Task> {
    let task = await this.#require(taskId);
    if (task.environmentLifecycleState === 'ended' || task.environmentLifecycleState === 'discarded') return task;
    if (task.environmentLifecycleState === 'idle' || task.environmentLifecycleState === 'blocked' || task.environmentLifecycleState === 'awaiting-validation') return task;
    if (task.environmentLifecycleState !== undefined && task.environmentLifecycleState !== 'beginning') {
      throw new Error(`task ${taskId} is ${task.environmentLifecycleState} and cannot begin`);
    }

    if (task.environmentLifecycleState === undefined) {
      const agentId = options.agentId ?? task.assignedAgentId;
      if (!agentId) throw new Error(`task ${taskId} has no assigned agent; assign one or name an agent to begin`);
      const agent = this.#agents.get(agentId);
      if (!agent) throw new Error(`unknown agent: ${agentId}`);
      const project = this.#projects.get(task.projectId);
      if (!project || !project.memberships.some((member) => member.agentId === agentId)) {
        throw new Error(`agent ${agentId} is not a member of project ${task.projectId}`);
      }
      const resolution = resolveEnvironmentInstance({
        projects: [project], capability: agent.capability,
        ...(options.selection !== undefined ? { environmentPreference: options.selection } : task.environmentPreference !== undefined ? { environmentPreference: task.environmentPreference } : {}),
      }, this.#pool);
      if (!resolution.ok) throw new Error(`no available environment for capability: ${agent.capability}`);
      const acquired = this.#pool.acquireLease({
        instanceId: resolution.instanceId, capability: agent.capability, holderId: task.id,
        taskId: task.id, ttlMs: this.#leaseTtlMs,
      });
      if (!acquired.ok) {
        throw new Error(`environment ${resolution.instanceId} is unavailable: held by ${acquired.heldBy ?? 'another holder'} (${acquired.state ?? 'active'})`);
      }
      // Durable begin intent precedes Worker preparation. The lease remains
      // blocking if the process dies before, during, or after that call.
      task = {
        ...task, assignedAgentId: agentId, environmentInstanceId: resolution.instanceId,
        environmentLeaseId: acquired.lease.id, environmentLifecycleState: 'beginning',
        updatedAt: this.#clock.now(),
      };
      await this.#store.save(task);
    }
    try {
      await this.#worker.prepare({ taskId: task.id, projectId: task.projectId, environmentInstanceId: task.environmentInstanceId! });
    } catch (error) {
      await this.#toRecovery(task, 'beginning');
      throw error;
    }
    const ready = { ...task, status: 'in-progress' as const, environmentLifecycleState: 'idle' as const, updatedAt: this.#clock.now() };
    await this.#store.save(ready);
    return ready;
  }

  async advanceRun(taskId: string, agentId: string, input: string): Promise<{ readonly task: Task; readonly runId: string }> {
    const task = await this.#require(taskId);
    if (!['idle', 'blocked', 'awaiting-validation'].includes(task.environmentLifecycleState ?? '')) {
      throw new Error(`task ${taskId} is ${task.environmentLifecycleState ?? 'unbegun'} and cannot advance`);
    }
    if (!task.environmentInstanceId || !task.environmentLeaseId) throw new Error(`task ${taskId} has no environment lease`);
    const lease = this.#pool.getLease(task.environmentLeaseId);
    if (!lease || lease.state !== 'active' || lease.holderKind !== 'task' || lease.taskId !== task.id || lease.instanceId !== task.environmentInstanceId) {
      throw new Error(`task ${taskId} lease is not active`);
    }
    const runId = this.#ids.run();
    // Persist the active nested-run fact before the orchestrator can start a worker session.
    const running: Task = { ...task, status: 'in-progress', environmentLifecycleState: 'running', activeRunId: runId, updatedAt: this.#clock.now() };
    await this.#store.save(running);
    await this.#runs.submit({ runId, taskId, agentId, prompt: input, projectId: task.projectId, environmentInstanceId: task.environmentInstanceId, environmentLeaseId: task.environmentLeaseId });
    return { task: running, runId };
  }

  /** Nested settlement changes Task progress only; it never releases the outer lease. */
  async settleRun(taskId: string, run: AgentRun): Promise<void> {
    const task = await this.#store.get(taskId);
    if (!task || task.activeRunId !== run.id) return; // idempotent restart redelivery
    if (run.status === 'queued' || run.status === 'running') return;
    if (run.status === 'interrupted') {
      await this.#toRecovery(task, 'running');
      return;
    }
    const next: Task = {
      ...task,
      status: run.status === 'failed' ? 'blocked' : 'in-progress',
      environmentLifecycleState: run.status === 'failed' ? 'blocked' : 'idle',
      ...(run.status === 'failed' ? { blockerReason: `run ${run.id} failed: ${run.failure ?? 'no failure detail'}` } : {}),
      updatedAt: this.#clock.now(),
    };
    await this.#store.save(omit(next, 'activeRunId'));
  }

  async end(taskId: string): Promise<Task> {
    const task = await this.#require(taskId);
    if (task.environmentLifecycleState === 'ended' || task.environmentLifecycleState === 'discarded') return task;
    if (task.activeRunId) throw new Error(`task ${taskId} cannot end while run ${task.activeRunId} is active`);
    if (!['idle', 'blocked', 'awaiting-validation'].includes(task.environmentLifecycleState ?? '')) {
      throw new Error(`task ${taskId} is ${task.environmentLifecycleState ?? 'unbegun'} and cannot end`);
    }
    const ending = { ...task, environmentLifecycleState: 'ending' as const, updatedAt: this.#clock.now() };
    await this.#store.save(ending);
    return this.#recycleThenRelease(ending, 'ended');
  }

  async recover(taskId: string, action: TaskRecoveryAction): Promise<Task> {
    const task = await this.#require(taskId);
    if (action === 'discard' && task.environmentLifecycleState === 'discarded') return task;
    if (task.environmentLifecycleState !== 'recovery') throw new Error(`task ${taskId} is not awaiting recovery`);
    if (action === 'discard') return this.#recycleThenRelease(task, 'discarded');
    if (task.recoveryState === 'ending') throw new Error(`task ${taskId} was ending; discard completes its cleanup`);
    if (!task.environmentLeaseId || !this.#pool.resumeTaskLease(task.environmentLeaseId)) throw new Error(`task ${taskId} lease cannot resume`);
    if (task.recoveryState === 'beginning') {
      try {
        await this.#worker.prepare({ taskId: task.id, projectId: task.projectId, environmentInstanceId: task.environmentInstanceId! });
      } catch (error) { await this.#toRecovery(task, 'beginning'); throw error; }
      const resumed = omit({ ...task, status: 'in-progress' as const, environmentLifecycleState: 'idle' as const, updatedAt: this.#clock.now() }, 'recoveryState');
      await this.#store.save(resumed); return resumed;
    }
    // A lost nested session is a visible interrupted fact, never an automatic relaunch.
    const resumed = omit(omit({ ...task, status: 'blocked' as const, environmentLifecycleState: 'blocked' as const, blockerReason: task.blockerReason ?? 'nested run interrupted; advance deliberately to resume', updatedAt: this.#clock.now() }, 'recoveryState'), 'activeRunId');
    await this.#store.save(resumed); return resumed;
  }

  /** Called during restart/worker-loss reconciliation; all unfinished Task leases block in recovery. */
  async reconcile(): Promise<void> {
    for (const task of await this.#store.list()) {
      if (!task.environmentLeaseId || ['ended', 'discarded'].includes(task.environmentLifecycleState ?? '')) continue;
      await this.#toRecovery(task, task.environmentLifecycleState ?? 'beginning');
    }
  }

  async #recycleThenRelease(task: Task, terminal: 'ended' | 'discarded'): Promise<Task> {
    try {
      await this.#worker.recycle({ taskId: task.id, projectId: task.projectId, environmentInstanceId: task.environmentInstanceId! });
    } catch (error) { await this.#toRecovery(task, 'ending'); throw error; }
    if (!task.environmentLeaseId || !this.#pool.releaseLease(task.environmentLeaseId)) {
      await this.#toRecovery(task, 'ending'); throw new Error(`task ${task.id} lease could not be released after cleanup`);
    }
    const ended = omit(omit({ ...task, status: terminal === 'ended' ? 'done' as const : 'cancelled' as const, completedAt: this.#clock.now(), environmentLifecycleState: terminal, updatedAt: this.#clock.now() }, 'recoveryState'), 'activeRunId');
    await this.#store.save(ended); return ended;
  }

  async #toRecovery(task: Task, prior: NonNullable<Task['environmentLifecycleState']>): Promise<void> {
    if (task.environmentLeaseId) this.#pool.markRecovering(task.environmentLeaseId);
    const recovering: Task = { ...task, environmentLifecycleState: 'recovery', recoveryState: prior, updatedAt: this.#clock.now() };
    await this.#store.save(recovering);
  }

  async #require(taskId: string): Promise<Task> {
    const task = await this.#store.get(taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    return task;
  }
}

function omit<K extends keyof Task>(task: Task, key: K): Task {
  const { [key]: _ignored, ...rest } = task;
  return rest as Task;
}
