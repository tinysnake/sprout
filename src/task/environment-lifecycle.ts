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
import { isTerminalTaskStatus } from './model.ts';
import type { TaskStore } from './store.ts';
import { buildTaskContext } from './context.ts';
import type { TaskContextMaterialization } from '../worker/protocol.ts';

export type TaskRecoveryAction = 'resume' | 'discard';

/** A test process may throw this immediately after a durable commit. */
export class DurableWriteCrash extends Error {}

/** #33 replaces this contract implementation with the Worker protocol. */
export interface TaskContextWorker {
  prepare(input: TaskContextMaterialization): Promise<{ readonly bootstrapInstructions: string }>;
  recycle(input: { readonly taskId: string; readonly projectId: string; readonly environmentInstanceId: string; readonly environmentLeaseId: string }): Promise<void>;
}

/** Deliberate production stub: no core filesystem operation is permitted by ADR-0003. */
export const noOpTaskContextWorker: TaskContextWorker = {
  async prepare() { return { bootstrapInstructions: '' }; },
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
    readonly projectWorkspaceId?: string;
    readonly taskBootstrapInstructions?: string;
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
  /** Test-only durable-write crash hooks; production leaves them absent. */
  readonly faults?: {
    readonly afterBeginningCommit?: () => void;
    readonly afterTerminalCommit?: () => void;
  };
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
  readonly #faults: NonNullable<TaskEnvironmentLifecycleOptions['faults']> | undefined;

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
    this.#faults = options.faults;
  }

  async begin(taskId: string, options: { readonly agentId?: string; readonly selection?: EnvironmentPreference } = {}): Promise<Task> {
    let task = await this.#require(taskId);
    if (isTerminalTaskStatus(task.status)) throw new Error(`task ${taskId} is ${task.status} and cannot begin`);
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
      // Reserve only in memory. The following store operation commits the
      // beginning intent and this Task lease in one SQLite transaction, so no
      // durable state can expose a live lease with no owning Task binding.
      const acquired = this.#pool.reserveTaskLease({
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
      try {
        await this.#store.saveBeginningWithLease(task, acquired.lease);
      } catch (error) {
        this.#pool.abandonReservation(acquired.lease.id);
        throw error;
      }
      this.#faults?.afterBeginningCommit?.();
      this.#pool.adoptLease(acquired.lease);
    }
    try {
      await this.#prepare(task, task.assignedAgentId!);
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
    if (isTerminalTaskStatus(task.status)) throw new Error(`task ${taskId} is ${task.status} and cannot be advanced`);
    if (task.environmentLifecycleState === 'running') throw new Error(`task ${taskId} already has an active run`);
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
    const admitted = await this.#store.saveIfUnchanged(running, {
      environmentLifecycleState: task.environmentLifecycleState,
      activeRunId: task.activeRunId,
    });
    if (!admitted) throw new Error(`task ${taskId} already has an active run`);
    let prepared: { readonly bootstrapInstructions: string };
    try {
      // The active-run admission is durable before this refresh.  A Worker
      // failure must therefore durably retain the Task lease in recovery rather
      // than leaving a running Task with no submitted run.
      prepared = await this.#prepare(running, agentId);
    } catch (error) {
      await this.#toRecovery(running, 'running');
      throw error;
    }
    await this.#runs.submit({ runId, taskId, agentId, prompt: input, projectId: task.projectId, environmentInstanceId: task.environmentInstanceId, environmentLeaseId: task.environmentLeaseId, projectWorkspaceId: task.projectId, taskBootstrapInstructions: prepared.bootstrapInstructions });
    return { task: running, runId };
  }

  /** Nested settlement changes Task progress only; it never releases the outer lease. */
  async settleRun(taskId: string, run: AgentRun): Promise<void> {
    const task = await this.#store.get(taskId);
    if (!task || task.activeRunId !== run.id) return; // idempotent restart redelivery
    if (run.status === 'queued' || run.status === 'running') return;
    if (run.status === 'interrupted' || isWorkerLoss(run)) {
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
    if (task.environmentLifecycleState === 'ending') return this.#recycleThenRelease(task, 'ended');
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
        await this.#prepare(task, task.assignedAgentId!);
      } catch (error) { await this.#toRecovery(task, 'beginning'); throw error; }
      const resumed = omit({ ...task, status: 'in-progress' as const, environmentLifecycleState: 'idle' as const, updatedAt: this.#clock.now() }, 'recoveryState');
      await this.#store.save(resumed); return resumed;
    }
    // A lost nested session is a visible interrupted fact, never an automatic relaunch.
    const resumed = omit(omit({ ...task, status: 'blocked' as const, environmentLifecycleState: 'blocked' as const, blockerReason: task.blockerReason ?? 'nested run interrupted; advance deliberately to resume', updatedAt: this.#clock.now() }, 'recoveryState'), 'activeRunId');
    await this.#store.save(resumed); return resumed;
  }

  /** Enter the retained human-validation gap without releasing the Task lease. */
  async awaitHumanValidation(taskId: string): Promise<Task> {
    const task = await this.#require(taskId);
    if (task.environmentLifecycleState === 'awaiting-validation') return task;
    if (!['idle', 'blocked'].includes(task.environmentLifecycleState ?? '')) {
      throw new Error(`task ${taskId} is ${task.environmentLifecycleState ?? 'unbegun'} and cannot await validation`);
    }
    const lease = task.environmentLeaseId ? this.#pool.getLease(task.environmentLeaseId) : undefined;
    if (!lease || lease.holderKind !== 'task' || lease.state !== 'active') throw new Error(`task ${taskId} lease is not active`);
    const awaiting: Task = {
      ...task,
      status: 'in-progress',
      environmentLifecycleState: 'awaiting-validation',
      updatedAt: this.#clock.now(),
    };
    await this.#store.save(awaiting);
    return awaiting;
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
      await this.#worker.recycle({ taskId: task.id, projectId: task.projectId, environmentInstanceId: task.environmentInstanceId!, environmentLeaseId: task.environmentLeaseId! });
    } catch (error) { await this.#toRecovery(task, 'ending'); throw error; }
    const ended = omit(omit({ ...task, status: terminal === 'ended' ? 'done' as const : 'cancelled' as const, completedAt: this.#clock.now(), environmentLifecycleState: terminal, updatedAt: this.#clock.now() }, 'recoveryState'), 'activeRunId');
    if (!task.environmentLeaseId) {
      await this.#toRecovery(task, 'ending');
      throw new Error(`task ${task.id} lease could not be released after cleanup`);
    }
    try {
      // One transaction makes release and terminal persistence inseparable. A
      // crash before it leaves `ending` recoverable; a crash after it is already
      // terminal with a released lease, so retry/discard never gets stuck.
      await this.#store.saveTerminalWithLease(ended, task.environmentLeaseId);
      this.#faults?.afterTerminalCommit?.();
      this.#pool.releaseTaskLease(task.environmentLeaseId);
      return ended;
    } catch (error) {
      if (error instanceof DurableWriteCrash) throw error;
      await this.#toRecovery(task, 'ending');
      throw error;
    }
  }

  async #toRecovery(task: Task, prior: NonNullable<Task['environmentLifecycleState']>): Promise<void> {
    if (task.environmentLeaseId) this.#pool.markRecovering(task.environmentLeaseId);
    const recovering: Task = { ...task, environmentLifecycleState: 'recovery', recoveryState: prior, updatedAt: this.#clock.now() };
    await this.#store.save(recovering);
  }

  /** Render portable durable facts; only the Worker turns them into files. */
  async #prepare(task: Task, agentId: string): Promise<{ readonly bootstrapInstructions: string }> {
    if (!task.environmentInstanceId || !task.environmentLeaseId) throw new Error(`task ${task.id} has no environment lease`);
    const project = this.#projects.get(task.projectId);
    const membership = project?.memberships.find((candidate) => candidate.agentId === agentId);
    if (!project || !membership) throw new Error(`agent ${agentId} is not a member of project ${task.projectId}`);
    const priorRunSummaries = buildTaskContext(task, await this.#store.listRuns(task.id)).text;
    return this.#worker.prepare({
      projectId: project.id,
      projectGoal: project.goal,
      projectRules: project.rules,
      taskId: task.id,
      taskTitle: task.title,
      taskGoal: task.goal,
      taskConstraints: task.constraints,
      taskStatus: task.status,
      priorRunSummaries,
      agentId,
      responsibilities: membership.responsibilities,
      collaborationInstructions: membership.collaborationInstructions,
      environmentInstanceId: task.environmentInstanceId,
      environmentLeaseId: task.environmentLeaseId,
    });
  }

  async #require(taskId: string): Promise<Task> {
    const task = await this.#store.get(taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    return task;
  }
}

function isWorkerLoss(run: AgentRun): boolean {
  return run.status === 'failed' && /environment worker (?:channel closed|connection|unavailable|lost)/i.test(run.failure ?? '');
}

function omit<K extends keyof Task>(task: Task, key: K): Task {
  const { [key]: _ignored, ...rest } = task;
  return rest as Task;
}
