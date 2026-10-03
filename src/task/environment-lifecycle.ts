/**
 * The outer Task environment lifecycle (#32).
 *
 * This is the only production module allowed to compose Task persistence, a
 * Task-held lease, nested-run admission, and the Worker context seam.  The
 * Task service, run orchestrator, HTTP API, and eventual Web controls call its
 * five commands; they do not recreate this ordering themselves.
 */

import { sanitizeOperatorText } from '../environment/privacy.ts';
import type { AgentDefinition, AgentRegistry } from '../agent/registry.ts';
import type { EnvironmentPreference } from '../environment/model.ts';
import type { AcquireLeaseFailure, AcquireLeaseResult, EnvironmentPool, LeaseState } from '../environment/pool.ts';
import { createIdFactory, type IdFactory } from '../ids.ts';
import { resolveEnvironmentInstance, workspaceFor } from '../project/resolve.ts';
import type { ProjectRegistry } from '../project/registry.ts';
import type { AgentRun } from '../run/model.ts';
import { serializeTaskControlDocument, isTerminalTaskStatus, type Task, type TaskActor, type TaskBlocker, type TaskCompletionClaim, type TaskContent } from './model.ts';
import type { TaskStore } from './store.ts';
import { buildTaskContext } from './context.ts';
import type { TaskContextMaterialization } from '../worker/protocol.ts';

export type TaskRecoveryAction = 'resume' | 'discard';

/** A Task begin cannot reserve an Environment whose lease is already held. */
export class TaskEnvironmentLeaseRefusal extends Error {
  readonly reason: AcquireLeaseFailure;
  readonly state: LeaseState | undefined;

  constructor(instanceId: string, refusal: Extract<AcquireLeaseResult, { readonly ok: false }>, includeLeaseState = false) {
    const holder = refusal.heldBy ?? (includeLeaseState ? 'another holder' : refusal.reason);
    const message = includeLeaseState
      ? `environment ${instanceId} is unavailable: held by ${holder} (${refusal.state ?? 'active'})`
      : `environment ${instanceId} is unavailable: ${holder}`;
    super(message);
    this.name = 'TaskEnvironmentLeaseRefusal';
    this.reason = refusal.reason;
    this.state = refusal.state;
  }
}

/** Why one Task recovery request cannot apply (#171). */
export type TaskRecoveryRefusalCode = 'not-awaiting-recovery' | 'lease-cannot-resume';

/**
 * A recovery request that cannot apply, named so the API can surface it.
 *
 * These refusals carry only product-owned text and domain ids — never host
 * paths or secrets — so an authenticated browser session may see the exact
 * reason instead of the protected generic failure (#171). Operational
 * failures (context recycle, durable writes) stay masked.
 */
export class TaskRecoveryRefusal extends Error {
  readonly code: TaskRecoveryRefusalCode;

  constructor(code: TaskRecoveryRefusalCode, message: string) {
    super(message);
    this.name = 'TaskRecoveryRefusal';
    this.code = code;
  }
}

/** A concurrent Task advance lost the durable one-active-run admission fence. */
export class TaskAdvanceConflictError extends Error {
  readonly code = 'advance-conflict';

  constructor(message: string) {
    super(message);
    this.name = 'TaskAdvanceConflictError';
  }
}

/** A blocker cannot be changed once its Task has reached a terminal status. */
export class TaskTerminalMutationError extends Error {
  readonly code = 'terminal-task';

  constructor(status: Task['status'], mutation: 'record' | 'clear') {
    super(mutation === 'clear'
      ? `This Task is ${status}; its blocker is historical.`
      : `This Task is ${status}; terminal Tasks cannot record blockers.`);
    this.name = 'TaskTerminalMutationError';
  }
}

/** A test process may throw this immediately after a durable commit. */
export class DurableWriteCrash extends Error {}

/** A Human Pause remains gated and requires an explicit retry or cancellation. */
export class TaskPauseRetryRequired extends Error {
  constructor() {
    super('Pause could not be recorded after repeated Task changes; retry Human Pause or explicitly cancel the outstanding Pause request');
    this.name = 'TaskPauseRetryRequired';
  }
}

/** #33 replaces this contract implementation with the Worker protocol. */
export interface TaskContextWorker {
  prepare(input: TaskContextMaterialization): Promise<{ readonly bootstrapInstructions: string }>;
  recycle(input: { readonly taskId: string; readonly projectId: string; readonly projectWorkspacePath?: string; readonly environmentInstanceId: string; readonly environmentLeaseId: string }): Promise<void>;
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
    readonly projectWorkspacePath?: string;
    readonly taskBootstrapInstructions?: string;
  }): Promise<{ readonly id: string }>;
  /** Current Environment compatibility, shared with ordinary run admission. */
  evaluateOptionAdmission?(agentId: string, environmentInstanceId: string): Promise<{ readonly ok: boolean }>;
}

export interface TaskEnvironmentLifecycleOptions {
  readonly store: TaskStore;
  readonly pool: EnvironmentPool;
  readonly agents: AgentRegistry;
  /** Current portable Agent identity, shared with ordinary run admission. */
  readonly resolveAgent?: (agentId: string) => Promise<AgentDefinition | undefined>;
  readonly projects: ProjectRegistry;
  readonly runs: TaskEnvironmentRunner;
  readonly worker?: TaskContextWorker;
  readonly ids?: IdFactory;
  readonly clock?: { now(): number };
  readonly leaseTtlMs?: number;
  /**
   * Told when a Task entered recovery (#88).
   *
   * Optional and injected so the Task lifecycle keeps importing no Environment
   * domain module directly; the recovery service uses this to open the durable
   * recovery record that protects the lease it just moved into recovery. The
   * callback must not change the Task's state: the lifecycle owns that ordering.
   */
  readonly onRecovery?: (input: {
    readonly taskId: string;
    readonly leaseId: string;
    readonly hadActiveRun: boolean;
    readonly runId?: string;
    readonly cause?: 'lease-overdue';
  }) => Promise<void>;
  /**
   * How the Environment domain resolves a permanent Force Release (#88).
   *
   * `pool` deliberately refuses a Task-held lease, so the emergency end needs the
   * capability that explicitly authorizes the override. Absent means the overdue
   * `ending` state is preserved rather than silently marked clean.
   */
  readonly forceReleaseLease?: (leaseId: string) => boolean;
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
  readonly #resolveAgent: (agentId: string) => Promise<AgentDefinition | undefined>;
  readonly #projects: ProjectRegistry;
  readonly #runs: TaskEnvironmentRunner;
  readonly #worker: TaskContextWorker;
  readonly #ids: IdFactory;
  readonly #clock: { now(): number };
  readonly #leaseTtlMs: number;
  readonly #onRecovery: NonNullable<TaskEnvironmentLifecycleOptions['onRecovery']> | undefined;
  readonly #forceReleaseLease: NonNullable<TaskEnvironmentLifecycleOptions['forceReleaseLease']> | undefined;
  readonly #faults: NonNullable<TaskEnvironmentLifecycleOptions['faults']> | undefined;
  readonly #admissionPauseTails = new Map<string, Promise<void>>();
  readonly #pauseRetryGates = new Map<string, { readonly promise: Promise<void>; readonly resolve: () => void }>();

  constructor(options: TaskEnvironmentLifecycleOptions) {
    this.#store = options.store;
    this.#pool = options.pool;
    this.#resolveAgent = options.resolveAgent ?? (async (agentId) => options.agents.get(agentId));
    this.#projects = options.projects;
    this.#runs = options.runs;
    this.#worker = options.worker ?? noOpTaskContextWorker;
    this.#ids = options.ids ?? createIdFactory();
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#leaseTtlMs = options.leaseTtlMs ?? 300_000;
    this.#onRecovery = options.onRecovery;
    this.#forceReleaseLease = options.forceReleaseLease;
    this.#faults = options.faults;
    this.#pool.setTaskLeaseRevalidator(async (lease) => {
      const task = await this.#require(lease.taskId ?? lease.holderId);
      if (task.environmentLeaseId !== lease.id || isTerminalTaskStatus(task.status)) {
        throw new Error('Overdue Task lease requires reconciliation of its durable holder');
      }
      if (task.environmentLifecycleState === 'recovery') return;
      await this.#toRecovery(task, task.environmentLifecycleState ?? 'beginning', task.activeRunId !== undefined, false, 'lease-overdue');
    });
  }

  /** Agents that are current Project members and can run on this eligible Environment. */
  async eligibleAgents(projectId: string, environmentInstanceId: string): Promise<readonly string[]> {
    const project = this.#projects.get(projectId);
    if (!project || !project.availableEnvironmentInstanceIds.includes(environmentInstanceId)) return [];
    return (await Promise.all(project.memberships.map(async membership =>
      await this.#agentEligible(membership.agentId, projectId, environmentInstanceId) ? membership.agentId : undefined,
    ))).filter((id): id is string => id !== undefined);
  }

  /** Begin a proposal-backed Task: approval, Task insertion and lease share one durable boundary. */
  async beginApproved(task: Task, input: {
    readonly environmentInstanceId: string;
    readonly contextAgentId: string;
    readonly consumeProposal: () => void;
  }): Promise<Task> {
    if (await this.#store.get(task.id)) throw new Error(`task ${task.id} already exists`);
    const project = this.#projects.get(task.projectId);
    if (!project || !project.availableEnvironmentInstanceIds.includes(input.environmentInstanceId)) {
      throw new Error(`environment ${input.environmentInstanceId} is not available to project ${task.projectId}`);
    }
    if (!await this.#agentEligible(input.contextAgentId, task.projectId, input.environmentInstanceId)) {
      throw new Error(`agent ${input.contextAgentId} is not eligible on environment ${input.environmentInstanceId}`);
    }
    const contextAgent = await this.#resolveAgent(input.contextAgentId);
    if (!contextAgent) throw new Error(`unknown agent: ${input.contextAgentId}`);
    await this.#pool.revalidateTaskLease(input.environmentInstanceId);
    const acquired = this.#pool.reserveTaskLease({
      instanceId: input.environmentInstanceId, capability: contextAgent.capability, holderId: task.id,
      taskId: task.id, ttlMs: this.#leaseTtlMs,
    });
    if (!acquired.ok) throw new TaskEnvironmentLeaseRefusal(input.environmentInstanceId, acquired);
    const beginning: Task = {
      ...task,
      ...(task.admission?.lead.memberKind === 'agent' ? { assignedAgentId: task.admission.lead.memberId } : {}),
      environmentInstanceId: input.environmentInstanceId,
      environmentLeaseId: acquired.lease.id,
      environmentLifecycleState: 'beginning',
      status: 'in-progress',
      updatedAt: this.#clock.now(),
    };
    try {
      await this.#store.createBeginningWithLease(beginning, acquired.lease, input.consumeProposal);
    } catch (error) {
      this.#pool.abandonReservation(acquired.lease.id);
      throw error;
    }
    this.#faults?.afterBeginningCommit?.();
    this.#pool.adoptLease(acquired.lease);
    try {
      await this.#prepare(beginning, input.contextAgentId);
    } catch (error) {
      await this.#toRecovery(beginning, 'beginning');
      throw error;
    }
    const ready: Task = { ...beginning, environmentLifecycleState: 'idle', updatedAt: this.#clock.now() };
    try {
      await this.#store.save(ready);
    } catch (error) {
      await this.#toRecovery(beginning, 'beginning');
      throw error;
    }
    return ready;
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
      const agent = await this.#resolveAgent(agentId);
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
      await this.#pool.revalidateTaskLease(resolution.instanceId);
      const acquired = this.#pool.reserveTaskLease({
        instanceId: resolution.instanceId, capability: agent.capability, holderId: task.id,
        taskId: task.id, ttlMs: this.#leaseTtlMs,
      });
      if (!acquired.ok) throw new TaskEnvironmentLeaseRefusal(resolution.instanceId, acquired, true);
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

  async advanceRun(taskId: string, agentId: string, input: string, audit?: {
    readonly actor: TaskActor;
    readonly reason?: string;
    readonly contentVersion: number;
  }): Promise<{ readonly task: Task; readonly runId: string }> {
    return this.#withAdmissionPauseLock(taskId, () => this.#advanceRun(taskId, agentId, input, audit), true);
  }

  async #advanceRun(taskId: string, agentId: string, input: string, audit?: {
    readonly actor: TaskActor;
    readonly reason?: string;
    readonly contentVersion: number;
  }): Promise<{ readonly task: Task; readonly runId: string }> {
    const task = await this.#require(taskId);
    if (isTerminalTaskStatus(task.status)) throw new Error(`task ${taskId} is ${task.status} and cannot be advanced`);
    if (task.environmentLifecycleState === 'running') throw new TaskAdvanceConflictError(`task ${taskId} already has an active run`);
    if (task.pauseState !== undefined) throw new Error(`task ${taskId} is paused and cannot admit a run`);
    if (task.blocker !== undefined) throw new Error(`task ${taskId} has an unresolved blocker`);
    if (!['idle', 'blocked'].includes(task.environmentLifecycleState ?? '')) {
      throw new Error(`task ${taskId} is ${task.environmentLifecycleState ?? 'unbegun'} and cannot advance`);
    }
    if (!task.environmentInstanceId || !task.environmentLeaseId) throw new Error(`task ${taskId} has no environment lease`);
    const lease = this.#pool.getLease(task.environmentLeaseId);
    if (!lease || lease.state !== 'active' || lease.holderKind !== 'task' || lease.taskId !== task.id || lease.instanceId !== task.environmentInstanceId) {
      throw new Error(`task ${taskId} lease is not active`);
    }
    if (task.admission !== undefined && audit === undefined) throw new Error(`task ${taskId} advance requires actor and content version`);
    if (audit !== undefined) {
      this.#assertLeadOrHuman(task, audit.actor);
      if (task.admission === undefined || audit.contentVersion !== task.admission.contentVersion) throw new Error(`task ${taskId} advance content version is not current`);
      if (!await this.#agentEligible(agentId, task.projectId, task.environmentInstanceId)) throw new Error(`agent ${agentId} is not eligible on the Task's environment`);
    }
    const runId = this.#ids.run();
    // Persist the active nested-run fact and its complete advance attribution before the Worker can start.
    const running: Task = { ...task, status: 'in-progress', environmentLifecycleState: 'running', activeRunId: runId, updatedAt: this.#clock.now() };
    const expected = { environmentLifecycleState: task.environmentLifecycleState, activeRunId: task.activeRunId,
      updatedAt: task.updatedAt, controlDocument: serializeTaskControlDocument(task) };
    const admitted = audit === undefined
      ? await this.#store.saveIfUnchanged(running, expected)
      : await this.#store.admitRun(running, {
        runId, agentId, actor: audit.actor,
        ...(audit.reason !== undefined ? { reason: audit.reason } : {}),
        contentVersion: audit.contentVersion, now: this.#clock.now(),
      }, expected);
    if (!admitted) throw new TaskAdvanceConflictError(`task ${taskId} already has an active run`);
    let prepared: { readonly bootstrapInstructions: string };
    try {
      // The active-run admission is durable before this refresh.  A Worker
      // failure must therefore durably retain the Task lease in recovery rather
      // than leaving a running Task with no submitted run.
      prepared = await this.#prepare(running, agentId);
    } catch (error) {
      await this.#toRecovery(running, 'running', true);
      throw error;
    }
    const workspacePath = this.#workspacePath(task.projectId, task.environmentInstanceId);
    try {
      await this.#runs.submit({
        runId, taskId, agentId, prompt: input, projectId: task.projectId,
        environmentInstanceId: task.environmentInstanceId, environmentLeaseId: task.environmentLeaseId,
        projectWorkspaceId: task.projectId,
        ...(workspacePath !== undefined ? { projectWorkspacePath: workspacePath } : {}),
        taskBootstrapInstructions: prepared.bootstrapInstructions,
      });
    } catch (error) {
      await this.#toRecovery(running, 'running', true);
      throw error;
    }
    return { task: running, runId };
  }

  /** Nested settlement changes Task progress only; it never releases the outer lease. */
  async settleRun(taskId: string, run: AgentRun, retry = false): Promise<void> {
    const task = await this.#store.get(taskId);
    if (!task || task.activeRunId !== run.id) return; // idempotent restart redelivery
    if (run.status === 'queued' || run.status === 'running') return;
    if (task.environmentLifecycleState === 'recovery') return; // channel loss already protected it
    if (run.status === 'interrupted' || isWorkerLoss(run)) {
      await this.#toRecovery(task, 'running', true);
      return;
    }
    const requestedPause = task.pauseState === 'requested'
      ? [...(task.controlHistory ?? [])].reverse().find(event => event.action === 'pause-requested' && 'reason' in event)
      : undefined;
    if (task.pauseState === 'requested' && requestedPause === undefined) throw new Error('Task pause request has no durable Human action');
    const next: Task = {
      ...task,
      status: run.status === 'failed' ? 'blocked' : task.blocker !== undefined ? 'blocked' : 'in-progress',
      environmentLifecycleState: run.status === 'failed' || task.blocker !== undefined ? 'blocked' : 'idle',
      ...(run.status === 'failed' ? { blockerReason: `run ${run.id} failed; inspect the bounded run summary`,
        ...(task.admission !== undefined ? { blocker: this.#unfinishedBlocker(task, `run ${run.id} failed`) } : {}),
      } : {}),
      ...(requestedPause !== undefined ? { pauseState: 'paused' as const,
        controlHistory: [...(task.controlHistory ?? []), {
          action: 'paused' as const, actor: requestedPause.actor, at: this.#clock.now(), reason: requestedPause.reason,
        }] } : {}),
      updatedAt: this.#clock.now(),
    };
    const saved = await this.#store.saveIfUnchanged(omit(next, 'activeRunId'), {
      environmentLifecycleState: task.environmentLifecycleState, activeRunId: task.activeRunId,
      updatedAt: task.updatedAt, controlDocument: serializeTaskControlDocument(task),
    });
    if (!saved) {
      if (retry) throw new Error('Task changed repeatedly during run settlement; reconciliation is required');
      await this.settleRun(taskId, run, true);
    }
  }

  async end(taskId: string): Promise<Task> {
    const task = await this.#require(taskId);
    if (task.environmentLifecycleState === 'ended' || task.environmentLifecycleState === 'discarded') return task;
    if (task.pauseState === 'retry-required') throw new Error(`task ${taskId} Pause must be retried or explicitly cancelled before Task end`);
    if (task.activeRunId) throw new Error(`task ${taskId} cannot end while run ${task.activeRunId} is active`);
    if (task.admission !== undefined && (task.environmentLifecycleState !== 'ending'
      || !task.controlHistory?.some(event => event.action === 'end-requested' && event.actor.memberKind === 'human'))) {
      throw new Error('Human-authorized accepted completion or discard is required before Task end');
    }
    if (task.environmentLifecycleState === 'ending') return this.#recycleThenRelease(task);
    if (!['idle', 'blocked', 'awaiting-validation'].includes(task.environmentLifecycleState ?? '')) {
      throw new Error(`task ${taskId} is ${task.environmentLifecycleState ?? 'unbegun'} and cannot end`);
    }
    const ending = { ...task, environmentLifecycleState: 'ending' as const, endDisposition: task.endDisposition ?? 'completed' as const, updatedAt: this.#clock.now() };
    await this.#store.save(ending);
    return this.#recycleThenRelease(ending);
  }

  async recover(taskId: string, action: TaskRecoveryAction, actor?: TaskActor): Promise<Task> {
    const task = await this.#require(taskId);
    if (task.admission !== undefined) this.#assertHuman(task, actor);
    if (action === 'discard' && task.environmentLifecycleState === 'discarded') return task;
    if (task.environmentLifecycleState !== 'recovery') throw new TaskRecoveryRefusal('not-awaiting-recovery', `task ${taskId} is not awaiting recovery`);
    if (task.recoveryState === 'ending') {
      if (!task.environmentLeaseId || !this.#pool.resumeTaskLease(task.environmentLeaseId, this.#leaseTtlMs)) throw new TaskRecoveryRefusal('lease-cannot-resume', `task ${taskId} lease cannot resume`);
      return this.#recycleThenRelease(task);
    }
    if (action === 'discard') {
      const { pendingCompletionClaimId: _pending, ...rest } = task;
      const ending = { ...rest, environmentLifecycleState: 'ending' as const, endDisposition: 'cancelled' as const, updatedAt: this.#clock.now() };
      await this.#store.save(ending);
      return this.#recycleThenRelease(ending);
    }
    const leaseBeforeResume = task.environmentLeaseId ? this.#pool.getLease(task.environmentLeaseId) : undefined;
    if (!leaseBeforeResume || !this.#pool.resumeTaskLease(task.environmentLeaseId!, this.#leaseTtlMs)) throw new TaskRecoveryRefusal('lease-cannot-resume', `task ${taskId} lease cannot resume`);
    const persistResumedTask = async (resumed: Task): Promise<Task> => {
      try {
        await this.#store.save(resumed);
        return resumed;
      } catch (error) {
        try {
          this.#pool.restoreLease(leaseBeforeResume);
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            'Task resume failed and its lease could not return to recovery.',
          );
        }
        throw error;
      }
    };
    if (task.recoveryState === 'beginning') {
      try {
        await this.#prepare(task, task.admission?.contextAgentId ?? task.assignedAgentId!);
      } catch (error) { await this.#toRecovery(task, 'beginning'); throw error; }
      const resumed = omit({ ...task, status: 'in-progress' as const, environmentLifecycleState: 'idle' as const, updatedAt: this.#clock.now() }, 'recoveryState');
      return persistResumedTask(resumed);
    }
    if (!task.activeRunId && ['idle', 'blocked', 'awaiting-validation'].includes(task.recoveryState ?? '')) {
      const restored = omit({ ...task, environmentLifecycleState: task.recoveryState!, updatedAt: this.#clock.now() }, 'recoveryState');
      return persistResumedTask(restored);
    }
    // A lost nested session is a visible interrupted fact, never an automatic relaunch.
    const requestedPause = task.pauseState === 'requested'
      ? [...(task.controlHistory ?? [])].reverse().find(event => event.action === 'pause-requested' && 'reason' in event)
      : undefined;
    if (task.pauseState === 'requested' && requestedPause === undefined) throw new Error('Task pause request has no durable Human action');
    const resumed = omit(omit({
      ...task,
      status: 'blocked' as const,
      environmentLifecycleState: 'blocked' as const,
      blockerReason: task.blockerReason ?? 'nested run interrupted; advance deliberately to resume',
      ...(task.admission !== undefined && task.blocker === undefined ? { blocker: this.#unfinishedBlocker(task, 'nested run interrupted') } : {}),
      ...(requestedPause !== undefined ? { pauseState: 'paused' as const,
        controlHistory: [...(task.controlHistory ?? []), { action: 'paused' as const, actor: requestedPause.actor, at: this.#clock.now(), reason: requestedPause.reason }] } : {}),
      updatedAt: this.#clock.now(),
    }, 'recoveryState'), 'activeRunId');
    return persistResumedTask(resumed);
  }

  /** No turn was active: restore exactly the prior held state, without replay. */
  async clearIdleRecovery(taskId: string): Promise<void> {
    const task = await this.#require(taskId);
    if (task.environmentLifecycleState !== 'recovery') return; // retry after a crash
    if (!['idle', 'blocked', 'awaiting-validation'].includes(task.recoveryState ?? '') || task.activeRunId) {
      throw new Error('Task has active or unproven work');
    }
    if (!task.environmentLeaseId) throw new Error('Task lease cannot be restored');
    const leaseId = task.environmentLeaseId;
    const leaseBeforeResume = this.#pool.getLease(leaseId);
    if (!leaseBeforeResume || !this.#pool.resumeTaskLease(leaseId, this.#leaseTtlMs)) {
      throw new Error('Task lease cannot be restored');
    }
    try {
      await this.#store.save(omit({ ...task, environmentLifecycleState: task.recoveryState!,
        updatedAt: this.#clock.now() }, 'recoveryState'));
    } catch (error) {
      try {
        this.#pool.restoreLease(leaseBeforeResume);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          'Task recovery clearing failed and its lease could not be restored.',
        );
      }
      throw error;
    }
  }

  /** A lost Worker protects even an idle Task's preserved workspace. */
  async workerChannelLost(taskId: string): Promise<void> {
    const task = await this.#require(taskId);
    if (task.environmentLifecycleState === 'recovery' || !task.environmentLeaseId) return;
    if (!['beginning', 'idle', 'blocked', 'awaiting-validation', 'running', 'ending'].includes(task.environmentLifecycleState ?? '')) return;
    await this.#toRecovery(task, task.environmentLifecycleState!, task.activeRunId !== undefined);
  }

  /** Human revisions never mutate an already admitted run or pending claim. */
  async reviseContent(taskId: string, actor: TaskActor, input: {
    readonly expectedContentVersion: number; readonly content: TaskContent; readonly reason: string;
  }): Promise<Task> {
    const task = await this.#require(taskId);
    this.#assertHuman(task, actor);
    if (!task.admission || !Number.isSafeInteger(input.expectedContentVersion)
      || task.admission.contentVersion !== input.expectedContentVersion) throw new Error('stale Task content version');
    if (isTerminalTaskStatus(task.status) || ['ending', 'ended', 'discarded'].includes(task.environmentLifecycleState ?? '')
      || task.recoveryState === 'ending') throw new Error('Task end intent cannot be revised');
    const at = this.#clock.now();
    const contentVersion = task.admission.contentVersion + 1;
    const { assignedAgentId: _assigned, ...rest } = task;
    const next: Task = {
      ...rest, title: input.content.title, goal: input.content.goal, constraints: [...input.content.constraints],
      ...(input.content.lead.memberKind === 'agent' ? { assignedAgentId: input.content.lead.memberId } : {}),
      admission: { ...task.admission, contentVersion, validationCriteria: [...input.content.validationCriteria], lead: { ...input.content.lead } },
      controlHistory: [...(task.controlHistory ?? []), {
        action: 'content-revised', actor, at, reason: input.reason, contentVersion,
        previous: { title: task.title, goal: task.goal, constraints: [...task.constraints], validationCriteria: [...task.admission.validationCriteria], lead: { ...task.admission.lead } },
        content: structuredClone(input.content),
      }], updatedAt: at,
    };
    await this.#saveControlTransition(task, next, 'content revision');
    return next;
  }

  /** Pause stops future admissions immediately while preserving an active run and its lease. */
  async requestPause(taskId: string, actor: TaskActor, reason: string): Promise<Task> {
    return this.#withAdmissionPauseLock(taskId, () => this.#requestPause(taskId, actor, reason));
  }

  async #requestPause(taskId: string, actor: TaskActor, reason: string): Promise<Task> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const task = await this.#require(taskId);
      this.#assertHuman(task, actor);
      if (task.pauseState === 'requested' || task.pauseState === 'paused') return task;
      if (!['running', 'idle', 'blocked', 'awaiting-validation'].includes(task.environmentLifecycleState ?? '')
        || !task.environmentLeaseId) throw new Error(`task ${taskId} cannot be paused in its current lifecycle`);
      const lease = this.#pool.getLease(task.environmentLeaseId);
      if (!lease || lease.state !== 'active' || lease.holderKind !== 'task' || lease.taskId !== task.id) {
        throw new Error(`task ${taskId} lease is not active`);
      }
      if ((task.environmentLifecycleState === 'running') !== (task.activeRunId !== undefined)) {
        throw new Error(`task ${taskId} active run state is inconsistent`);
      }
      const at = this.#clock.now();
      const action = task.activeRunId === undefined ? 'paused' as const : 'pause-requested' as const;
      const next: Task = {
        ...task,
        pauseState: action === 'paused' ? 'paused' : 'requested',
        controlHistory: [...(task.controlHistory ?? []), { action, actor, at, reason }],
        updatedAt: at,
      };
      const saved = await this.#store.saveIfUnchanged(next, {
        environmentLifecycleState: task.environmentLifecycleState,
        activeRunId: task.activeRunId,
        updatedAt: task.updatedAt,
        controlDocument: serializeTaskControlDocument(task),
      });
      if (saved) {
        this.#resolvePauseRetryGate(taskId);
        return next;
      }
    }
    this.#getPauseRetryGate(taskId);
    const retryRequired = await this.#store.recordPauseRetryRequired(taskId, actor, this.#clock.now(), reason);
    if (retryRequired?.pauseState !== 'retry-required') this.#resolvePauseRetryGate(taskId);
    throw new TaskPauseRetryRequired();
  }

  /** Only the Human may cancel an outstanding Pause request after CAS exhaustion. */
  async cancelPauseRetryForHuman(taskId: string, actor: TaskActor, reason: string): Promise<Task> {
    return this.#withAdmissionPauseLock(taskId, async () => {
      const task = await this.#require(taskId);
      this.#assertHuman(task, actor);
      if (task.pauseState !== 'retry-required') {
        throw new Error(`task ${taskId} has no retry-required Pause request to cancel`);
      }
      const { pauseState: _pause, ...rest } = task;
      const at = this.#clock.now();
      const next: Task = {
        ...rest,
        controlHistory: [...(task.controlHistory ?? []), { action: 'pause-request-cancelled', actor, at, reason }],
        updatedAt: at,
      };
      const saved = await this.#store.saveIfUnchanged(next, {
        environmentLifecycleState: task.environmentLifecycleState,
        activeRunId: task.activeRunId,
        updatedAt: task.updatedAt,
        controlDocument: serializeTaskControlDocument(task),
      });
      if (!saved) throw new Error(`task ${taskId} changed before the Pause cancellation was recorded`);
      this.#resolvePauseRetryGate(taskId);
      return next;
    });
  }

  /** Resume is an explicit Human action; it never admits a run by itself. */
  async resumePause(taskId: string, actor: TaskActor, reason: string): Promise<Task> {
    const task = await this.#require(taskId);
    this.#assertHuman(task, actor);
    if (task.pauseState === 'retry-required') throw new Error(`task ${taskId} Pause must be retried or explicitly cancelled before resume`);
    if (task.pauseState === undefined) throw new Error(`task ${taskId} is not paused`);
    if (task.activeRunId !== undefined || !['idle', 'blocked', 'awaiting-validation'].includes(task.environmentLifecycleState ?? '')) {
      throw new Error(`task ${taskId} cannot resume while work is active or recovery is unresolved`);
    }
    this.#assertActiveTaskLease(task);
    const at = this.#clock.now();
    const { pauseState: _pause, ...rest } = task;
    const next: Task = {
      ...rest,
      controlHistory: [...(task.controlHistory ?? []), { action: 'resumed', actor, at, reason }],
      updatedAt: at,
    };
    const saved = await this.#store.saveIfUnchanged(next, {
      environmentLifecycleState: task.environmentLifecycleState,
      activeRunId: task.activeRunId,
      updatedAt: task.updatedAt,
      controlDocument: serializeTaskControlDocument(task),
    });
    if (!saved) throw new Error(`task ${taskId} changed before resume was recorded`);
    return next;
  }

  async raiseBlocker(taskId: string, actor: TaskActor, blocker: TaskBlocker): Promise<Task> {
    const task = await this.#require(taskId);
    this.#assertLeadOrHuman(task, actor);
    if (isTerminalTaskStatus(task.status)) throw new TaskTerminalMutationError(task.status, 'record');
    if (task.activeRunId !== undefined || !['idle', 'blocked'].includes(task.environmentLifecycleState ?? '')
      || task.pendingCompletionClaimId !== undefined) throw new Error(`task ${taskId} cannot be blocked in its current lifecycle`);
    this.#assertActiveTaskLease(task);
    const next: Task = {
      ...task, status: 'blocked', environmentLifecycleState: 'blocked', blocker,
      blockerReason: blocker.reason,
      controlHistory: [...(task.controlHistory ?? []), { action: 'blocker-raised', actor, at: blocker.createdAt, blocker }],
      updatedAt: blocker.createdAt,
    };
    await this.#saveControlTransition(task, next, 'blocker');
    return next;
  }

  async clearBlocker(taskId: string, actor: TaskActor, reason: string): Promise<Task> {
    const task = await this.#require(taskId);
    this.#assertHuman(task, actor);
    if (isTerminalTaskStatus(task.status)) throw new TaskTerminalMutationError(task.status, 'clear');
    if (task.blocker === undefined || task.activeRunId !== undefined || task.environmentLifecycleState !== 'blocked') {
      throw new Error(`task ${taskId} has no clearable blocker`);
    }
    this.#assertActiveTaskLease(task);
    const { blocker: _blocker, blockerReason: _reason, ...rest } = task;
    const at = this.#clock.now();
    const next: Task = {
      ...rest, status: 'in-progress', environmentLifecycleState: 'idle',
      controlHistory: [...(task.controlHistory ?? []), { action: 'blocker-cleared', actor, at, reason }], updatedAt: at,
    };
    await this.#saveControlTransition(task, next, 'blocker');
    return next;
  }

  async submitCompletionClaim(taskId: string, claim: TaskCompletionClaim): Promise<Task> {
    const task = await this.#require(taskId);
    const lead = task.admission?.lead;
    const isLead = lead !== undefined && claim.actor.memberId === lead.memberId
      && claim.actor.memberKind === lead.memberKind;
    const isHumanSubstitute = task.admission !== undefined && lead?.memberKind === 'agent'
      && claim.actor.memberKind === 'human' && claim.actor.memberId === task.admission.approvedBy.memberId;
    if (task.admission !== undefined && !isLead && !isHumanSubstitute) throw new Error('Task lead authority is required');
    if (claim.substitutedFor !== undefined && (!isHumanSubstitute || lead === undefined
      || claim.substitutedFor.memberId !== lead.memberId || claim.substitutedFor.memberKind !== lead.memberKind)) {
      throw new Error('Task lead authority is required');
    }
    if (task.activeRunId !== undefined || !['idle', 'blocked'].includes(task.environmentLifecycleState ?? '')
      || task.blocker !== undefined || task.pendingCompletionClaimId !== undefined) {
      throw new Error(`task ${taskId} cannot accept a completion claim in its current lifecycle`);
    }
    this.#assertActiveTaskLease(task);
    const recordedClaim: TaskCompletionClaim = isHumanSubstitute && lead !== undefined
      ? { ...claim, substitutedFor: { ...lead } } : claim;
    const next: Task = {
      ...task,
      status: 'in-progress', environmentLifecycleState: 'awaiting-validation',
      completionClaims: [...(task.completionClaims ?? []), recordedClaim], pendingCompletionClaimId: claim.id,
      controlHistory: [...(task.controlHistory ?? []), {
        action: 'completion-claimed', actor: claim.actor, at: claim.at, claimId: claim.id,
        ...(isHumanSubstitute && lead !== undefined ? { substitutedFor: { ...lead } } : {}),
      }],
      updatedAt: claim.at,
    };
    await this.#saveControlTransition(task, next, 'completion claim');
    return next;
  }

  async validateCompletionClaim(taskId: string, actor: TaskActor, input: {
    readonly claimId: string;
    readonly decision: 'accept' | 'correct';
    readonly reason: string;
  }): Promise<Task> {
    const task = await this.#require(taskId);
    this.#assertHuman(task, actor);
    if (input.decision !== 'accept' && input.decision !== 'correct') throw new Error('invalid validation decision');
    const claim = task.completionClaims?.find(item => item.id === input.claimId);
    if (task.pendingCompletionClaimId !== input.claimId || claim === undefined
      || task.environmentLifecycleState !== 'awaiting-validation' || task.activeRunId !== undefined) {
      throw new Error(`task ${taskId} has no matching pending completion claim`);
    }
    const at = this.#clock.now();
    this.#assertActiveTaskLease(task);
    if (input.decision === 'correct') {
      const { pendingCompletionClaimId: _pending, ...rest } = task;
      const next: Task = {
        ...rest,
        status: task.blocker !== undefined ? 'blocked' : 'in-progress',
        environmentLifecycleState: task.blocker !== undefined ? 'blocked' : 'idle',
        controlHistory: [...(task.controlHistory ?? []), {
          action: 'validation-corrected', actor, at, claimId: claim.id, reason: input.reason,
        }],
        updatedAt: at,
      };
      await this.#saveControlTransition(task, next, 'validation');
      return next;
    }
    if (claim.recommendedDisposition !== 'complete') throw new Error('only a completion recommendation can be accepted');
    this.#assertActiveTaskLease(task);
    const { pendingCompletionClaimId: _pending, ...rest } = task;
    const next: Task = {
      ...rest,
      environmentLifecycleState: 'ending', endDisposition: 'completed',
      controlHistory: [...(task.controlHistory ?? []),
        { action: 'validation-accepted', actor, at, claimId: claim.id, reason: input.reason },
        { action: 'end-requested', actor, at, disposition: 'completed', reason: input.reason }],
      updatedAt: at,
    };
    await this.#saveControlTransition(task, next, 'validation');
    return this.#recycleThenRelease(next);
  }

  async discardForHuman(taskId: string, actor: TaskActor, reason: string): Promise<Task> {
    const task = await this.#require(taskId);
    this.#assertHuman(task, actor);
    if (task.pauseState === 'retry-required') throw new Error(`task ${taskId} Pause must be retried or explicitly cancelled before discard`);
    if (task.activeRunId !== undefined || !['idle', 'blocked', 'awaiting-validation'].includes(task.environmentLifecycleState ?? '')) {
      throw new Error(`task ${taskId} cannot be discarded in its current lifecycle`);
    }
    this.#assertActiveTaskLease(task);
    const at = this.#clock.now();
    const { pendingCompletionClaimId: _pending, ...rest } = task;
    const ending: Task = {
      ...rest, environmentLifecycleState: 'ending', endDisposition: 'cancelled',
      controlHistory: [...(task.controlHistory ?? []), { action: 'end-requested', actor, at, disposition: 'cancelled', reason }],
      updatedAt: at,
    };
    await this.#saveControlTransition(task, ending, 'discard');
    return this.#recycleThenRelease(ending);
  }

  async recordInterruptRequest(taskId: string, actor: TaskActor, reason: string): Promise<Task> {
    const task = await this.#require(taskId);
    this.#assertHuman(task, actor);
    if (task.pauseState !== 'requested' || task.activeRunId === undefined || task.environmentLifecycleState !== 'running') {
      throw new Error(`task ${taskId} has no active run awaiting Interrupt`);
    }
    this.#assertActiveTaskLease(task);
    const at = this.#clock.now();
    const next: Task = { ...task, controlHistory: [...(task.controlHistory ?? []), { action: 'interrupt-requested', actor, at, reason }], updatedAt: at };
    await this.#saveControlTransition(task, next, 'interrupt');
    return next;
  }

  async recordSubordinateStopRequest(taskId: string, actor: TaskActor, runId: string, reason: string): Promise<Task> {
    const task = await this.#require(taskId);
    this.#assertLeadOrHuman(task, actor);
    const link = (await this.#store.listRuns(taskId)).find(item => item.runId === runId);
    if (!link?.actor || link.actor.memberKind !== actor.memberKind || link.actor.memberId !== actor.memberId) {
      throw new Error('Task lead stop authority is limited to runs they initiated');
    }
    if (task.activeRunId !== runId || task.environmentLifecycleState !== 'running') throw new Error(`run ${runId} is not active for Task ${taskId}`);
    this.#assertActiveTaskLease(task);
    const at = this.#clock.now();
    const next: Task = { ...task, controlHistory: [...(task.controlHistory ?? []), { action: 'subordinate-run-stop-requested', actor, at, runId, reason }], updatedAt: at };
    await this.#saveControlTransition(task, next, 'run stop');
    return next;
  }

  async recoverForHuman(taskId: string, action: TaskRecoveryAction, actor: TaskActor, reason: string): Promise<Task> {
    const task = await this.#require(taskId);
    this.#assertHuman(task, actor);
    if (task.environmentLifecycleState !== 'recovery') throw new TaskRecoveryRefusal('not-awaiting-recovery', `task ${taskId} is not awaiting recovery`);
    const at = this.#clock.now();
    const next: Task = { ...task, controlHistory: [...(task.controlHistory ?? []), { action: 'recovery-requested', actor, at, recoveryAction: action, reason }], updatedAt: at };
    await this.#saveControlTransition(task, next, 'recovery');
    return this.recover(taskId, action, actor);
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
      if (task.environmentLifecycleState === 'recovery') {
        this.#pool.markRecovering(task.environmentLeaseId);
        continue; // preserve the original prior state across repeated restarts
      }
      await this.#toRecovery(task, task.environmentLifecycleState ?? 'beginning', task.activeRunId !== undefined);
    }
  }

  /**
   * Emergency Task end for a Human Force Release (#88, ADR-0009).
   *
   * Records `cancelled` with a permanent forced-release disposition, keeps the
   * interrupted run as history, and releases the Task-held lease. It never
   * deletes the Project workspace and records unrecycled Task context as leftover
   * data rather than pretending cleanup finished. This is the only path that ends
   * a Task whose context cleanup could not be proved.
   */
  async forceRelease(
    taskId: string,
    input: {
      readonly actor: string;
      readonly reason: string;
      readonly unresolvedFacts: readonly string[];
      readonly at: number;
    },
  ): Promise<readonly string[]> {
    const task = await this.#require(taskId);
    if (task.admission !== undefined) this.#assertHuman(task, { memberId: input.actor, memberKind: 'human' });
    const affectedRunIds = (await this.#store.listRuns(taskId)).map((link) => link.runId);
    if (task.activeRunId !== undefined) affectedRunIds.push(task.activeRunId);
    if (isTerminalTaskStatus(task.status) && task.environmentLifecycleState !== 'recovery') {
      // #162: the Task already ended through its own lifecycle (for example an
      // operator discarded it from the Task plane while its Environment
      // recovery record stayed open). A terminal Task must keep its own
      // history — never be rewritten into another terminal state — and the
      // emergency end must not throw past the recovery resolution the Force
      // Release is performing. Releasing the retained lease binding is
      // idempotent, so only the Task mutation is skipped; the permanent
      // outcome record and the record resolution stay with the Environment
      // domain.
      if (task.environmentLeaseId !== undefined && this.#forceReleaseLease !== undefined) {
        this.#forceReleaseLease(task.environmentLeaseId);
      }
      return [...new Set(affectedRunIds)];
    }
    if (!task.environmentLeaseId || this.#forceReleaseLease === undefined) {
      throw new Error('Force Release lease-release capability is unavailable');
    }
    const forced: Task = omit(
      omit(
        omit(
          {
            ...task,
            status: 'cancelled' as const,
            completedAt: input.at,
            environmentLifecycleState: 'discarded' as const,
            endDisposition: 'cancelled' as const,
            forcedRelease: { actor: input.actor, reason: sanitizeOperatorText(input.reason, { maxLength: 2000, fallback: 'Human Force Release' }),
              unresolvedFacts: input.unresolvedFacts.map(fact => sanitizeOperatorText(fact, { maxLength: 2000, fallback: 'unresolved cleanup proof' })), at: input.at },
            blockerReason: 'Force Released by the Human operator; unresolved facts recorded.',
            updatedAt: input.at,
          },
          'recoveryState',
        ),
        'activeRunId',
      ),
      'pendingCompletionClaimId',
    );
    // One transaction commits the terminal Task row and the Task-held lease
    // release together. Without the explicit release capability above, unfinished
    // work remains in recovery rather than claiming terminal cancellation.
    await this.#store.saveTerminalWithLease(forced, task.environmentLeaseId);
    this.#resolvePauseRetryGate(taskId);
    this.#forceReleaseLease(task.environmentLeaseId);
    return [...new Set(affectedRunIds)];
  }

  async #recycleThenRelease(task: Task): Promise<Task> {
    try {
      const workspacePath = this.#workspacePath(task.projectId, task.environmentInstanceId!);
      await this.#worker.recycle({
        taskId: task.id, projectId: task.projectId,
        ...(workspacePath !== undefined ? { projectWorkspacePath: workspacePath } : {}),
        environmentInstanceId: task.environmentInstanceId!, environmentLeaseId: task.environmentLeaseId!,
      });
    } catch (error) { await this.#toRecovery(task, 'ending'); throw error; }
    const completed = (task.endDisposition ?? 'completed') === 'completed';
    const terminal = completed ? 'ended' as const : 'discarded' as const;
    const ended = omit(omit({ ...task, status: completed ? 'done' as const : 'cancelled' as const, completedAt: this.#clock.now(), environmentLifecycleState: terminal, endDisposition: completed ? 'completed' as const : 'cancelled' as const, updatedAt: this.#clock.now() }, 'recoveryState'), 'activeRunId');
    if (!task.environmentLeaseId) {
      await this.#toRecovery(task, 'ending');
      throw new Error(`task ${task.id} lease could not be released after cleanup`);
    }
    try {
      // One transaction makes release and terminal persistence inseparable. A
      // crash before it leaves `ending` recoverable; a crash after it is already
      // terminal with a released lease, so retry/discard never gets stuck.
      await this.#store.saveTerminalWithLease(ended, task.environmentLeaseId);
      this.#resolvePauseRetryGate(task.id);
      this.#faults?.afterTerminalCommit?.();
      this.#pool.releaseTaskLease(task.environmentLeaseId);
      return ended;
    } catch (error) {
      if (error instanceof DurableWriteCrash) throw error;
      await this.#toRecovery(task, 'ending');
      throw error;
    }
  }

  async #toRecovery(task: Task, prior: NonNullable<Task['environmentLifecycleState']>, hadActiveRun = false, retry = false, cause?: 'lease-overdue'): Promise<void> {
    if (task.environmentLeaseId) this.#pool.markRecovering(task.environmentLeaseId);
    const recovering: Task = { ...task, environmentLifecycleState: 'recovery', recoveryState: prior, updatedAt: this.#clock.now() };
    const saved = await this.#store.saveIfUnchanged(recovering, {
      environmentLifecycleState: task.environmentLifecycleState, activeRunId: task.activeRunId,
      updatedAt: task.updatedAt, controlDocument: serializeTaskControlDocument(task),
    });
    if (!saved) {
      const current = await this.#require(task.id);
      if (isTerminalTaskStatus(current.status) || current.environmentLifecycleState === 'recovery') return;
      if (retry) throw new Error('Task changed repeatedly during recovery protection; reconciliation is required');
      return this.#toRecovery(current, current.environmentLifecycleState ?? prior, current.activeRunId !== undefined, true, cause);
    }
    // The durable recovery record (#88) is opened after the Task state is durable,
    // so the record always describes a Task that really entered recovery. A
    // failure here must not roll back the protection: the lease is already
    // `recovering`, which already blocks reassignment.
    if (this.#onRecovery !== undefined && task.environmentLeaseId !== undefined) {
      try {
        await this.#onRecovery({ taskId: task.id, leaseId: task.environmentLeaseId, hadActiveRun,
          ...(cause !== undefined ? { cause } : {}),
          ...(hadActiveRun && task.activeRunId !== undefined ? { runId: task.activeRunId } : {}) });
      } catch (error) {
        process.stderr.write(
          `[recovery] failed to open the recovery record for task ${task.id}: ` +
            `${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }

  /** Render portable durable facts; only the Worker turns them into files. */
  async #prepare(task: Task, agentId: string): Promise<{ readonly bootstrapInstructions: string }> {
    if (!task.environmentInstanceId || !task.environmentLeaseId) throw new Error(`task ${task.id} has no environment lease`);
    const project = this.#projects.get(task.projectId);
    const membership = project?.memberships.find((candidate) => candidate.agentId === agentId);
    if (!project || !membership) throw new Error(`agent ${agentId} is not a member of project ${task.projectId}`);
    const priorRunSummaries = buildTaskContext(task, await this.#store.listRuns(task.id)).text;
    const workspacePath = workspaceFor(project, task.environmentInstanceId)?.path;
    return this.#worker.prepare({
      projectId: project.id,
      ...(workspacePath !== undefined ? { projectWorkspacePath: workspacePath } : {}),
      projectGoal: project.goal,
      projectRules: project.rules,
      taskId: task.id,
      taskTitle: task.title,
      taskGoal: task.goal,
      taskConstraints: task.constraints,
      ...(task.admission !== undefined ? {
        taskValidationCriteria: task.admission.validationCriteria,
        taskContentVersion: task.admission.contentVersion,
      } : {}),
      taskStatus: task.status,
      priorRunSummaries,
      agentId,
      responsibilities: membership.responsibilities,
      collaborationInstructions: membership.collaborationInstructions,
      environmentInstanceId: task.environmentInstanceId,
      environmentLeaseId: task.environmentLeaseId,
    });
  }

  #workspacePath(projectId: string, environmentInstanceId: string): string | undefined {
    const project = this.#projects.get(projectId);
    return project === undefined ? undefined : workspaceFor(project, environmentInstanceId)?.path;
  }

  async #agentEligible(agentId: string, projectId: string, environmentInstanceId: string): Promise<boolean> {
    const project = this.#projects.get(projectId);
    const agent = await this.#resolveAgent(agentId);
    if (!project || !agent || !project.availableEnvironmentInstanceIds.includes(environmentInstanceId)
      || !project.memberships.some(member => member.agentId === agentId)
      || this.#pool.requiresLease(environmentInstanceId, agent.capability) !== true) return false;
    const admission = await this.#runs.evaluateOptionAdmission?.(agentId, environmentInstanceId);
    return admission?.ok ?? true;
  }

  #unfinishedBlocker(task: Task, reason: string): TaskBlocker {
    return {
      reason, requiredAction: 'Inspect unfinished work and clear this blocker before deliberately advancing',
      responsible: { kind: 'human', memberId: task.admission!.approvedBy.memberId },
      nextAdvancer: { ...task.admission!.lead }, createdBy: { memberKind: 'system', memberId: 'sprout' }, createdAt: this.#clock.now(),
    };
  }

  #assertHuman(task: Task, actor: TaskActor | undefined): void {
    if (actor?.memberKind !== 'human' || !actor.memberId
      || (task.admission !== undefined && actor.memberId !== task.admission.approvedBy.memberId)) {
      throw new Error('Human authority is required');
    }
  }

  #assertLeadOrHuman(task: Task, actor: TaskActor): void {
    if (actor?.memberKind === 'human') return this.#assertHuman(task, actor);
    if (actor?.memberKind !== 'agent' || !task.admission
      || task.admission.lead.memberKind !== 'agent' || task.admission.lead.memberId !== actor.memberId) {
      throw new Error('Task lead authority is required');
    }
  }

  #assertActiveTaskLease(task: Task): void {
    const lease = task.environmentLeaseId === undefined ? undefined : this.#pool.getLease(task.environmentLeaseId);
    if (!lease || lease.state !== 'active' || lease.holderKind !== 'task' || lease.taskId !== task.id
      || lease.instanceId !== task.environmentInstanceId) throw new Error(`task ${task.id} lease is not active`);
  }

  async #withAdmissionPauseLock<T>(taskId: string, action: () => Promise<T>, waitForPauseRetryResolution = false): Promise<T> {
    while (true) {
      if (waitForPauseRetryResolution) await this.#awaitPauseRetryResolution(taskId);
      const previous = this.#admissionPauseTails.get(taskId) ?? Promise.resolve();
      let releaseTail!: () => void;
      const tail = new Promise<void>((resolve) => { releaseTail = resolve; });
      this.#admissionPauseTails.set(taskId, tail);
      await previous;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        releaseTail();
        if (this.#admissionPauseTails.get(taskId) === tail) this.#admissionPauseTails.delete(taskId);
      };
      try {
        if (waitForPauseRetryResolution && (await this.#store.get(taskId))?.pauseState === 'retry-required') {
          const gate = this.#getPauseRetryGate(taskId);
          release();
          await gate.promise;
          continue;
        }
        return await action();
      } finally {
        release();
      }
    }
  }

  async #awaitPauseRetryResolution(taskId: string): Promise<void> {
    let gate = this.#pauseRetryGates.get(taskId);
    if (!gate && (await this.#store.get(taskId))?.pauseState === 'retry-required') gate = this.#getPauseRetryGate(taskId);
    await gate?.promise;
  }

  #getPauseRetryGate(taskId: string): { readonly promise: Promise<void>; readonly resolve: () => void } {
    const current = this.#pauseRetryGates.get(taskId);
    if (current) return current;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const gate = { promise, resolve };
    this.#pauseRetryGates.set(taskId, gate);
    return gate;
  }

  #resolvePauseRetryGate(taskId: string): void {
    const gate = this.#pauseRetryGates.get(taskId);
    if (!gate) return;
    this.#pauseRetryGates.delete(taskId);
    gate.resolve();
  }

  async #saveControlTransition(current: Task, next: Task, operation: string): Promise<void> {
    const saved = await this.#store.saveIfUnchanged(next, {
      environmentLifecycleState: current.environmentLifecycleState,
      activeRunId: current.activeRunId,
      updatedAt: current.updatedAt,
      controlDocument: serializeTaskControlDocument(current),
    });
    if (!saved) throw new Error(`task ${current.id} changed before ${operation} was recorded`);
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
