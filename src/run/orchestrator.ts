import type { AgentDefinition, AgentRegistry } from '../agent/registry.ts';
import type { EnvironmentPool } from '../environment/pool.ts';
import type { EngineAdapter, EngineSession, EngineTurnResult } from '../engine/port.ts';
import { EngineResumeRefusedError } from '../engine/port.ts';
import { createIdFactory, type IdFactory } from '../ids.ts';
import { assembleProjectContract, renderProjectContract } from '../project/contract.ts';
import type { ProjectRegistry } from '../project/registry.ts';
import type { EnvironmentPreference } from '../environment/model.ts';
import { resolveEnvironmentInstance } from '../project/resolve.ts';
import { buildHandOffContext, renderHandOffPrompt, shouldAttachHandOff } from './hand-off.ts';
import type { AgentRun, AgentRunStatus, RunObserver } from './model.ts';
import type { RunStore } from './store.ts';
import type { SessionKeyIdentity, SessionKeyStore } from './session-key-store.ts';
import type { TaskContextProvider, TaskRunObserver } from './task-link.ts';

/**
 * Run orchestration: the one place where agent identity, environment leases, and
 * engine sessions meet.
 *
 * The interface is small on purpose — `submit`, `stop`, `get`, `waitFor`,
 * `subscribe` — and everything that makes a run hard (lease acquisition, refusal
 * on conflict, event streaming, terminal-state mapping, persistence) sits behind
 * it. Callers and tests cross this same seam.
 */

export interface RunOrchestratorOptions {
  /**
   * Where engine adapters come from, keyed by environment instance.
   *
   * A plain map is the single-instance case: it satisfies this for tests and for
   * callers with one fixed worker. A function keyed by instance id is what makes
   * execution follow the resolved and leased instance instead of a global pool,
   * which is the F1 fix (#18): the adapter that runs a run must belong to the
   * same environment instance the run leases and records.
   *
   * A function (rather than a value) also lets an environment worker be restarted
   * after it dies instead of failing every later run against a dead connection
   * (ADR-0003).
   */
  readonly engines:
    | ReadonlyMap<string, EngineAdapter>
    | ((environmentInstanceId: string) => Promise<ReadonlyMap<string, EngineAdapter>>);
  readonly agents: AgentRegistry;
  /**
   * Where an agent's project memberships come from. Optional so existing callers
   * and tests that never resolve an environment need not supply one; a run by an
   * agent with no project fails with an explicit message rather than a guess.
   */
  readonly projects?: ProjectRegistry;
  readonly pool: EnvironmentPool;
  readonly store: RunStore;
  /**
   * Durable engine session keys, so a later run in the same environment and
   * working directory continues the prior conversation instead of repeating it.
   *
   * Optional: a map of empty stores (and tests that do not exercise
   * continuation) leaves every run on its fresh-session path.
   */
  readonly sessionKeys?: SessionKeyStore;
  /**
   * Every persisted run, used to build a cross-environment hand-off.
   *
   * Defaults to the run store, so production reads the same durable history the
   * run is recorded in. Exposed so a test can supply an explicit history without
   * seeding a store.
   */
  readonly runs?: () => Promise<readonly AgentRun[]>;
  /**
   * How a run that advances a durable Task is assembled and observed (#28).
   *
   * When present, a submission naming a `taskId` is a Task run: its prompt is the
   * Task's assembled context, its environment resolution honours the Task's
   * `environmentPreference` first, and its settlement is reported back so the
   * Task's state and run summaries stay current. Absent means this orchestrator
   * serves one-round runs only; a `taskId` submission then fails explicitly
   * rather than silently running without Task context.
   */
  readonly tasks?: TaskContextProvider;
  /**
   * Told when a Task-linked run settles, so the Task can advance its state.
   *
   * Optional; without it a Task run still assembles and links, but the Task's own
   * status is only advanced by the caller. Exposed as a function so the run seam
   * stays ignorant of the Task service's shape.
   */
  readonly onTaskRunSettled?: TaskRunObserver;
  readonly leaseTtlMs?: number;
  /** Injected so tests get deterministic ids; production uses unique ids. */
  readonly ids?: IdFactory;
  readonly clock?: { now(): number };
}

export interface SubmitRunRequest {
  /** A lifecycle-reserved id for a Task nested run. */
  readonly runId?: string;
  readonly agentId: string;
  readonly prompt: string;
  /**
   * Resolve strictly within this Project when supplied.
   *
   * TaskService always supplies its Task's `projectId`. One-round callers may
   * omit it to retain the established "first granted project" behaviour.
   */
  readonly projectId?: string;
  /**
   * The durable Task this run advances (#28).
   *
   * When set, the run is a Task run: its prompt is assembled from the Task's
   * goal, constraints, and prior run summaries, and this run is linked into the
   * Task's run sequence. Absent means a one-round run.
   */
  readonly taskId?: string;
  /**
   * An explicit environment selection, taking priority over project matching.
   *
   * For a Task run this is normally the Task's own `environmentPreference`,
   * supplied by the advancement service; a direct caller may pass one too.
   */
  readonly environmentPreference?: EnvironmentPreference;
  /** Fixed Task binding, supplied only by TaskEnvironmentLifecycle. */
  readonly environmentInstanceId?: string;
  readonly environmentLeaseId?: string;
  /** Portable Worker workspace reference supplied by the Task lifecycle. */
  readonly projectWorkspaceId?: string;
  /** Worker-produced relative-file bootstrap for this Task Agent run. */
  readonly taskBootstrapInstructions?: string;
}

/**
 * The outcome of one attempt to run a session.
 *
 * A failure carries `resumeRefused`: true only when the engine explicitly told
 * us it would not resume the supplied key and did no work. That is the one
 * failure the caller may retry from a fresh session. Everything else — an
 * initialization failure, a missing binary, an authentication failure, a turn
 * that failed after emitting events — is reported as a plain failure so the
 * stored key is neither discarded nor reused unsafely.
 */
type SessionAttempt =
  | {
      readonly ok: true;
      readonly run: AgentRun;
      readonly result: EngineTurnResult;
      readonly engineSessionKey: string | undefined;
    }
  | {
      readonly ok: false;
      readonly run: AgentRun;
      readonly message: string;
      /** True only when the engine refused the supplied key and did no work. */
      readonly resumeRefused: boolean;
    };

export class RunOrchestrator {
  readonly #engines: RunOrchestratorOptions['engines'];
  readonly #agents: AgentRegistry;
  readonly #projects: ProjectRegistry | undefined;
  readonly #pool: EnvironmentPool;
  readonly #store: RunStore;
  readonly #sessionKeys: SessionKeyStore | undefined;
  /** Reads the durable run history a hand-off is derived from. */
  readonly #runHistory: () => Promise<readonly AgentRun[]>;
  /** Assembles and links durable Task runs; absent for a one-round-only build. */
  readonly #tasks: TaskContextProvider | undefined;
  /** Told when a Task-linked run settles, so the Task can advance its state. */
  readonly #onTaskRunSettled: TaskRunObserver | undefined;
  readonly #leaseTtlMs: number;
  readonly #clock: { now(): number };

  readonly #runs = new Map<string, AgentRun>();
  readonly #sessions = new Map<string, EngineSession>();
  readonly #settled = new Map<string, Promise<AgentRun>>();
  readonly #observers = new Set<RunObserver>();
  readonly #ids: IdFactory;

  constructor(options: RunOrchestratorOptions) {
    this.#engines = options.engines;
    this.#agents = options.agents;
    this.#projects = options.projects;
    this.#pool = options.pool;
    this.#store = options.store;
    this.#sessionKeys = options.sessionKeys;
    this.#runHistory = options.runs ?? (() => options.store.list());
    this.#tasks = options.tasks;
    this.#onTaskRunSettled = options.onTaskRunSettled;
    this.#leaseTtlMs = options.leaseTtlMs ?? 300_000;
    this.#ids = options.ids ?? createIdFactory();
    this.#clock = options.clock ?? { now: () => Date.now() };
  }

  /**
   * Accept a run and return as soon as it is recorded.
   *
   * Returning an id rather than the finished run is what lets the Web client
   * observe progress: the run is inspectable and subscribable immediately, and
   * `waitFor` is available for callers that need the terminal state.
   */
  async submit(request: SubmitRunRequest): Promise<{ id: string }> {
    const run: AgentRun = {
      id: request.runId ?? this.#ids.run(),
      agentId: request.agentId,
      prompt: request.prompt,
      environmentInstanceId: '',
      status: 'queued',
      events: [],
      ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
      createdAt: this.#clock.now(),
    };

    const agent = this.#agents.get(request.agentId);
    if (!agent) {
      await this.settleTaskRun(
        await this.#finish(run, 'failed', {
          status: 'failed',
          message: `unknown agent: ${request.agentId}`,
        }),
      );
      return { id: run.id };
    }

    // A Task run's prompt is assembled from the Task's goal, constraints, and
    // prior run summaries (#28). A submission that names a Task this process
    // cannot assemble context for is refused explicitly, never run context-free.
    let prompt = request.prompt;
    if (request.taskId !== undefined) {
      if (this.#tasks === undefined) {
        await this.settleTaskRun(
          await this.#finish(run, 'failed', {
            status: 'failed',
            message: `task runs are not configured on this orchestrator: ${request.taskId}`,
          }),
        );
        return { id: run.id };
      }
      try {
        prompt = await this.#tasks.prompt({ taskId: request.taskId, prompt: request.prompt });
      } catch (error) {
        await this.settleTaskRun(
          await this.#finish(run, 'failed', {
            status: 'failed',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        return { id: run.id };
      }
    }
    const taskRun: AgentRun = { ...run, prompt };

    // Task runs are created exclusively by TaskEnvironmentLifecycle. A partial
    // binding used to fall through to the normal one-round lease path, inventing
    // a second lifecycle for a Task; reject it before resolving or acquiring.
    if (request.taskId !== undefined && (request.environmentInstanceId === undefined || request.environmentLeaseId === undefined)) {
      await this.settleTaskRun(await this.#finish(taskRun, 'failed', {
        status: 'failed',
        message: `task run ${request.taskId} requires lifecycle lease and environment bindings`,
      }));
      return { id: taskRun.id };
    }

    // Do not permit a Task caller to fall back to the agent's other projects.
    // TaskService always provides this field from the durable Task; rejecting a
    // malformed direct call is safer than silently executing its Task elsewhere.
    if (request.taskId !== undefined && request.projectId === undefined) {
      await this.settleTaskRun(
        await this.#finish(taskRun, 'failed', {
          status: 'failed',
          message: `task run ${request.taskId} is missing its project scope`,
        }),
      );
      return { id: taskRun.id };
    }

    // Resolve the environment before recording the run, so the persisted run
    // names the instance it actually used rather than an agent's fixed device.
    // An explicit environment preference — normally the Task's own — is honoured
    // first, with project matching as the fallback (M1 scope item 8).
    const agentProjects = this.#projects?.forAgent(agent.id) ?? [];
    const scopedProjects =
      request.projectId === undefined
        ? agentProjects
        : agentProjects.filter((project) => project.id === request.projectId);
    if (request.projectId !== undefined && scopedProjects.length === 0) {
      await this.settleTaskRun(
        await this.#finish(taskRun, 'failed', {
          status: 'failed',
          message: `agent ${agent.id} is not a member of project ${request.projectId}`,
        }),
      );
      return { id: taskRun.id };
    }
    const resolution = request.taskId !== undefined && request.environmentInstanceId !== undefined
      ? { ok: true as const, instanceId: request.environmentInstanceId, projectId: request.projectId!, preferred: true }
      : resolveEnvironmentInstance(
      {
        projects: scopedProjects,
        capability: agent.capability,
        ...(request.environmentPreference !== undefined
          ? { environmentPreference: request.environmentPreference }
          : {}),
      },
      this.#pool,
    );
    if (!resolution.ok) {
      await this.settleTaskRun(
        await this.#finish(taskRun, 'failed', {
          status: 'failed',
          message: this.#resolutionFailure(agent, resolution.reason),
        }),
      );
      return { id: taskRun.id };
    }

    const recorded: AgentRun = {
      ...taskRun,
      environmentInstanceId: resolution.instanceId,
      projectId: resolution.projectId,
      ...(request.environmentLeaseId !== undefined ? { leaseId: request.environmentLeaseId } : {}),
    };
    this.#runs.set(recorded.id, recorded);
    await this.#store.save(recorded);

    // Link the run into the Task's sequence before it executes, so even a run
    // that fails to start is part of the Task's durable history. A link failure
    // is a run failure: a Task run that is not linked would be invisible to
    // later advancement and accumulate no summary.
    if (recorded.taskId !== undefined && this.#tasks !== undefined) {
      try {
        await this.#tasks.link({
          taskId: recorded.taskId,
          runId: recorded.id,
          agentId: recorded.agentId,
        });
      } catch (error) {
        await this.settleTaskRun(
          await this.#finish(recorded, 'failed', {
            status: 'failed',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        return { id: recorded.id };
      }
    }

    const workspace = {
      ...(request.projectWorkspaceId !== undefined ? { projectWorkspaceId: request.projectWorkspaceId } : {}),
      ...(request.taskBootstrapInstructions !== undefined ? { taskBootstrapInstructions: request.taskBootstrapInstructions } : {}),
    };
    const settled = this.#execute(recorded, agent, workspace).then((run) => this.settleTaskRun(run));
    this.#settled.set(recorded.id, settled);
    return { id: recorded.id };
  }

  /**
   * Report a settled Task run back so the Task can record a summary and advance.
   *
   * A bookkeeping failure must never change the run's own terminal state, so it is
   * isolated here and reported rather than allowed to reject the run's settled
   * promise. A one-round run is returned untouched.
   */
  async settleTaskRun(run: AgentRun): Promise<AgentRun> {
    if (run.taskId === undefined || this.#onTaskRunSettled === undefined) return run;
    try {
      await this.#onTaskRunSettled({ taskId: run.taskId, run });
    } catch (error) {
      process.stderr.write(
        `[task] failed to advance task ${run.taskId} after run ${run.id}: ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    return run;
  }

  #resolutionFailure(agent: AgentDefinition, reason: 'no-project' | 'no-available-environment'): string {
    return reason === 'no-project'
      ? `no project grants agent ${agent.id} access to an environment for capability: ${agent.capability}`
      : `no available environment for capability: ${agent.capability}`;
  }

  /** The current observable state of a run. */
  get(runId: string): AgentRun | undefined {
    return this.#runs.get(runId);
  }

  /** Every run this process currently knows about, in submission order. */
  known(): readonly AgentRun[] {
    return [...this.#runs.values()];
  }

  /**
   * Every run, including ones persisted by a previous process.
   *
   * The in-memory state wins for runs this process is already tracking, so a
   * recovered run never shadows live progress.
   */
  async list(): Promise<readonly AgentRun[]> {
    for (const stored of await this.#store.list()) {
      if (!this.#runs.has(stored.id)) this.#runs.set(stored.id, stored);
    }
    return [...this.#runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Mark runs left mid-flight by a previous process as failed and transition
   * their active leases into recovery.
   *
   * A run recorded as `running` belongs to a process that no longer exists: its
   * engine session died with it, so nothing will ever settle it. Its capacity
   * lease transitions to `recovering` (O4) so the environment is protected from
   * unsafe reassignment until uncommitted work is captured or discarded.
   */
  async reconcileOrphanedRuns(): Promise<readonly AgentRun[]> {
    await this.#pool.load();
    const recovered: AgentRun[] = [];
    for (const stored of await this.#store.list()) {
      if (this.#runs.has(stored.id)) continue;
      const orphaned = stored.status === 'running' || stored.status === 'queued';
      const next: AgentRun = orphaned
        ? {
            ...stored,
            status: 'failed',
            failure: 'interrupted by a Sprout restart before this run finished',
            result: {
              status: 'failed',
              message: 'interrupted by a Sprout restart before this run finished',
            },
            completedAt: this.#clock.now(),
          }
        : stored;
      this.#runs.set(next.id, next);
      if (orphaned) {
        if (stored.leaseId) {
          this.#pool.markRecovering(stored.leaseId);
        }
        await this.#store.save(next);
        recovered.push(await this.settleTaskRun(next));
      } else if (next.taskId !== undefined) {
        // A terminal run can be durable before its Task observer receives the
        // settlement callback. Re-deliver every terminal Task run on restart:
        // TaskService's link and summary writes are idempotent, so this both
        // repairs a missing summary and leaves an already-settled run unchanged.
        await this.settleTaskRun(next);
      }
    }
    return recovered;
  }

  /** The active lease on an environment instance, for observability. */
  activeLease(instanceId: string): ReturnType<EnvironmentPool['activeLease']> {
    return this.#pool.activeLease(instanceId);
  }

  /** Every lease known to the pool, for observability. */
  leases(): ReturnType<EnvironmentPool['leases']> {
    return this.#pool.leases();
  }

  /** Release a lease (e.g. to resolve recovery), making the environment available again. */
  releaseLease(leaseId: string): ReturnType<EnvironmentPool['releaseLease']> {
    if (this.#pool.getLease(leaseId)?.holderKind === 'task') return undefined;
    return this.#pool.releaseLease(leaseId);
  }

  /** Recover a run recorded by a previous process. */
  async load(runId: string): Promise<AgentRun | undefined> {
    const existing = this.#runs.get(runId);
    if (existing) return existing;
    const persisted = await this.#store.get(runId);
    if (persisted) this.#runs.set(persisted.id, persisted);
    return persisted;
  }

  /** Observe status and progress changes for every run. */
  subscribe(observer: RunObserver): () => void {
    this.#observers.add(observer);
    return () => {
      this.#observers.delete(observer);
    };
  }

  /** Await a run's terminal state. */
  async waitFor(runId: string): Promise<AgentRun> {
    const settled = this.#settled.get(runId);
    if (settled) return settled;
    const recovered = await this.load(runId);
    if (recovered) return recovered;
    throw new Error(`unknown run: ${runId}`);
  }

  /**
   * Stop a running run.
   *
   * Stopping is only meaningful for a live run; a settled run is returned as-is
   * so the Web client never has to guess what "stop" meant for it.
   */
  async stop(runId: string): Promise<AgentRun> {
    const run = this.#runs.get(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    if (run.status !== 'running' && run.status !== 'queued') return run;

    const session = this.#sessions.get(runId);
    if (session) {
      // Ask the engine to stop, then close the session. `close` is what
      // guarantees the run settles, so a wedged or already-dead engine cannot
      // leave the user's stop command waiting.
      await session.interrupt();
      await session.close();
      this.#sessions.delete(runId);
    }

    return (await this.waitFor(runId)) ?? run;
  }

  async #execute(
    initial: AgentRun,
    agent: AgentDefinition,
    workspace: { readonly projectWorkspaceId?: string; readonly taskBootstrapInstructions?: string } = {},
  ): Promise<AgentRun> {
    // Adapters are resolved *for the instance this run resolved and will lease*,
    // never from a global pool: a run that leases container-1 must execute on
    // container-1's worker, or the run record would name a machine it never used.
    let engines: ReadonlyMap<string, EngineAdapter>;
    try {
      engines =
        typeof this.#engines === 'function'
          ? await this.#engines(initial.environmentInstanceId)
          : this.#engines;
    } catch (error) {
      // A worker that cannot be started is a run failure with a reason, not a
      // rejected promise the caller has to interpret.
      return this.#finish(initial, 'failed', {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const adapter = engines.get(agent.engine);
    if (!adapter) {
      return this.#finish(initial, 'failed', {
        status: 'failed',
        message: `no engine adapter registered for: ${agent.engine}`,
      });
    }
    const nestedTaskLease = initial.taskId !== undefined && initial.leaseId !== undefined;
    if (nestedTaskLease) {
      const lease = this.#pool.getLease(initial.leaseId!);
      if (!lease || lease.state !== 'active' || lease.holderKind !== 'task' || lease.taskId !== initial.taskId || lease.instanceId !== initial.environmentInstanceId) {
        return this.#finish(initial, 'failed', { status: 'failed', message: `task lease is not active for run ${initial.id}` });
      }
    }
    const acquired = nestedTaskLease ? undefined : this.#pool.acquireLease({
      instanceId: initial.environmentInstanceId,
      capability: agent.capability,
      holderId: agent.id,
      runId: initial.id,
      ttlMs: this.#leaseTtlMs,
    });
    if (acquired !== undefined && !acquired.ok) {
      const instanceId = initial.environmentInstanceId;
      const busyMessage =
        acquired.state === 'recovering'
          ? `environment busy: ${instanceId} is in recovery (held by ${acquired.heldBy ?? 'another run'})`
          : `environment busy: ${instanceId} is leased by ${acquired.heldBy ?? 'another run'}`;
      return this.#finish(initial, 'failed', {
        status: 'failed',
        message:
          acquired.reason === 'conflict'
            ? busyMessage
            : `environment unavailable: ${acquired.reason}`,
      });
    }

    const running = await this.#advance(initial, { status: 'running', ...(acquired !== undefined && acquired.ok ? { leaseId: acquired.lease.id } : {}) });
    let prepared = running;

    try {
      // Assemble what this run is presented with, before the session starts: the
      // project contract (standing instructions, on every run) and, when the run
      // moved to a different environment instance than the agent's previous run, a
      // fact-form hand-off. Both are deterministic functions of persisted facts.
      // Keep all setup inside the lease guard so a rejected assembly is persisted
      // as a terminal failure and cannot leave the acquired lease active.
      const workingDirectory = workspace.projectWorkspaceId === undefined
        ? resolveWorkingDirectory(this.#pool, initial.environmentInstanceId, agent)
        : `project-workspace:${workspace.projectWorkspaceId}`;
      const assembled = await this.#assembleInput(initial, agent, running.id);
      prepared = await this.#advance(running, {
        ...(assembled.handOff !== undefined ? { handOff: assembled.handOff } : {}),
      });

      // The continuation slot is `(agent, engine, environment instance, working
      // directory)`. All four must match for a stored key to be reusable: the key
      // belongs to one engine, lives in one environment's engine store, and (for
      // Pi and opencode, #19) is coupled to the directory it was created in.
      // Resolve it inside the lease guard: an absent instance directory and agent
      // fallback is an explicit failed run, not a rejected promise that leaks a lease.
      const identity: SessionKeyIdentity = {
        agentId: agent.id,
        engine: agent.engine,
        environmentInstanceId: initial.environmentInstanceId,
        workingDirectory,
      };
      const stored = this.#sessionKeys ? await this.#sessionKeys.get(identity) : undefined;

      let attempt = await this.#runSession(
        adapter,
        agent,
        assembled.prompt,
        prepared,
        stored?.key,
        appendBootstrap(assembled.instructions, workspace.taskBootstrapInstructions),
        workingDirectory,
        workspace.projectWorkspaceId,
      );

      // A stored key the engine refuses must not fail the run. Pi and `agy`
      // soft-fall-back themselves (#19), but Codex and `opencode` hard-fail on a
      // stale key, so the orchestrator degrades for them: forget the refused key
      // and retry once from a fresh session. The `resumeRefused` gate is the
      // important part — it is set only when the engine *explicitly* refused the
      // supplied key and did no work. An initialization failure, a missing
      // binary, an authentication failure, or a valid resume whose first turn
      // fails before emitting events is a plain failure: retrying it fresh would
      // hide a real engine problem and would discard a key that may still be
      // good, so it is reported instead.
      if (stored !== undefined && !attempt.ok && attempt.resumeRefused) {
        if (this.#sessionKeys) await this.#sessionKeys.delete(identity);
        attempt = await this.#runSession(
          adapter,
          agent,
          assembled.prompt,
          prepared,
          undefined,
          appendBootstrap(assembled.instructions, workspace.taskBootstrapInstructions),
          workingDirectory,
          workspace.projectWorkspaceId,
        );
      }

      if (!attempt.ok) {
        return this.#finish(attempt.run, 'failed', {
          status: 'failed',
          message: attempt.message,
        });
      }

      // Persist the key the run actually used, not the one it was handed. A
      // run that degraded to a fresh session stores the fresh key, so the next
      // run continues *that* session rather than re-offering the refused one.
      if (this.#sessionKeys && attempt.result.status === 'completed') {
        const key = attempt.engineSessionKey;
        if (key !== undefined && key !== '') {
          await this.#sessionKeys.save({ ...identity, key, updatedAt: this.#clock.now() });
        }
      }
      return await this.#settleWithResult(attempt.run, attempt.result);
    } catch (error) {
      return this.#finish(prepared, 'failed', {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (acquired !== undefined && acquired.ok) this.#pool.releaseLease(acquired.lease.id);
    }
  }

  /**
   * One attempt at a run's engine session.
   *
   * Owns the session's lifetime and event streaming, but not the lease or the
   * run's terminal state: the caller decides whether to retry a resume-key
   * refusal before settling the run. `resumeRefused` exists so that decision is
   * based on the engine's own classification of the failure, not on parsing
   * engine messages or on the bare fact that no event was emitted. It is true
   * for a refused session start and for an engine that reports a refused resume
   * through its turn result; a session that starts and then fails for any other
   * reason is not a refusal.
   */
  async #runSession(
    adapter: EngineAdapter,
    agent: AgentDefinition,
    prompt: string,
    running: AgentRun,
    resumeKey: string | undefined,
    instructions: string | undefined,
    workingDirectory: string,
    projectWorkspaceId: string | undefined,
  ): Promise<SessionAttempt> {
    let session: EngineSession;
    try {
      session = await adapter.startSession({
        agentId: agent.id,
        workingDirectory,
        // The assembled project contract is re-sent on every run, because it is
        // the standing agreement the agent works under and must not depend on a
        // prior session having carried it (O5).
        ...(instructions !== undefined ? { instructions } : {}),
        ...(projectWorkspaceId !== undefined ? { projectWorkspaceId } : {}),
        ...(resumeKey !== undefined ? { resumeSessionKey: resumeKey } : {}),
      });
    } catch (error) {
      return {
        ok: false,
        run: running,
        message: error instanceof Error ? error.message : String(error),
        // Only the engine's explicit refusal of the supplied key is retryable.
        // Any other start failure is a real failure and must not discard a key.
        resumeRefused: resumeKey !== undefined && error instanceof EngineResumeRefusedError,
      };
    }

    this.#sessions.set(running.id, session);
    let current = running;
    try {
      const turn = session.run(prompt);
      // The events iterator throws when a turn fails, so the *authoritative*
      // outcome is read from `completion` afterwards. Reading it there is what
      // lets a turn-level refusal (opencode exits 1 on a stale `--session`) be
      // told apart from any other turn failure.
      let streamError: unknown;
      try {
        for await (const event of turn.events) {
          current = await this.#advance(current, {
            events: [...current.events, event],
          });
        }
      } catch (error) {
        streamError = error;
      }
      const result = await turn.completion;
      if (result.status === 'failed') {
        // A turn-level failure is an attempt failure, not a completed run. It is
        // retryable only when the engine classified it as a refused resume;
        // every other failure (provider error, bad authentication, a crash) is
        // reported as-is so the stored key survives untouched.
        return {
          ok: false,
          run: current,
          message: result.message,
          resumeRefused: result.resumeRefused === true,
        };
      }
      if (streamError !== undefined) {
        // The stream failed without the turn reporting failure. That is not a
        // refusal, and it must not be retried fresh.
        return {
          ok: false,
          run: current,
          message: streamError instanceof Error ? streamError.message : String(streamError),
          resumeRefused: false,
        };
      }
      return { ok: true, run: current, result, engineSessionKey: session.engineSessionKey };
    } catch (error) {
      return {
        ok: false,
        run: current,
        message: error instanceof Error ? error.message : String(error),
        // A thrown error is never a resume refusal: the engine had a working
        // session and failed while doing the work (or reading its result).
        resumeRefused: false,
      };
    } finally {
      this.#sessions.delete(running.id);
      await session.close();
    }
  }

  /**
   * Assemble what one run is presented with: the project contract and, on an
   * environment change, a fact-form hand-off.
   *
   * Both halves are deterministic and read only persisted facts. The contract is
   * assembled from the project the run resolved into, plus the agent's own
   * configuration. The hand-off is derived from the agent's own prior runs and is
   * attached only when this run's environment instance differs from the previous
   * run's. When the instance matches, the run is the continued-session case
   * (ADR-0004), so no hand-off is added and the prompt is the user's alone.
   */
  async #assembleInput(
    run: AgentRun,
    agent: AgentDefinition,
    currentRunId: string,
  ): Promise<{ prompt: string; instructions: string | undefined; handOff: AgentRun['handOff'] }> {
    const project = run.projectId !== undefined ? this.#projects?.get(run.projectId) : undefined;
    const contract =
      project !== undefined
        ? renderProjectContract(
            assembleProjectContract({
              project,
              agentId: agent.id,
              ...(agent.instructions !== undefined
                ? { agentInstructions: agent.instructions }
                : {}),
            }),
          )
        : // No project means the run could not have resolved an environment, so
          // this is unreachable in practice; falling back to the agent's own
          // instructions keeps the agent's standing configuration intact.
          agent.instructions;

    const handOff = buildHandOffContext(await this.#runHistory(), {
      agentId: agent.id,
      currentRunId,
      currentCreatedAt: run.createdAt,
    });
    // ADR-0004: a session key is scoped to one (agent, engine, instance,
    // directory), so a stored key only exists for the same environment instance.
    // An environment change therefore means the run is on its fresh-session path,
    // and a hand-off is exactly what closes the resulting gap.
    const attach =
      handOff !== undefined &&
      shouldAttachHandOff({
        previousEnvironmentInstanceId: handOff.previousEnvironmentInstanceId,
        currentEnvironmentInstanceId: run.environmentInstanceId,
      });

    return {
      prompt: attach ? renderHandOffPrompt(handOff, run.prompt) : run.prompt,
      instructions: contract,
      handOff: attach ? handOff : undefined,
    };
  }

  async #settleWithResult(run: AgentRun, result: EngineTurnResult): Promise<AgentRun> {
    switch (result.status) {
      case 'completed':
        return this.#finish(run, 'completed', result);
      case 'interrupted':
        return this.#finish(run, 'interrupted', result);
      case 'failed':
        return this.#finish(run, 'failed', result);
    }
  }

  async #finish(
    run: AgentRun,
    status: AgentRunStatus,
    result: EngineTurnResult,
  ): Promise<AgentRun> {
    return this.#advance(run, {
      status,
      result,
      completedAt: this.#clock.now(),
      ...(result.status === 'failed' ? { failure: result.message } : {}),
    });
  }

  /** Record a new run state, persist it, and notify observers in that order. */
  async #advance(run: AgentRun, patch: Partial<AgentRun>): Promise<AgentRun> {
    const next: AgentRun = { ...run, ...patch };
    this.#runs.set(next.id, next);
    await this.#store.save(next);
    for (const observer of this.#observers) observer(next);
    return next;
  }
}

/**
 * The directory a run executes in, inside the instance it actually uses.
 *
 * A path is a fact about the environment (ADR-0003): the same agent needs
 * `/sprout` inside a container and a host path on macOS. The resolved instance is
 * therefore authoritative, and the agent's value is only a fallback for an
 * environment that cannot state its own directory (F1 suggestion, #18).
 */
function resolveWorkingDirectory(
  pool: Pick<EnvironmentPool, 'instance'>,
  instanceId: string,
  agent: AgentDefinition,
): string {
  const fromInstance = pool.instance(instanceId)?.workingDirectory;
  if (fromInstance !== undefined) return fromInstance;
  if (agent.workingDirectory !== undefined) return agent.workingDirectory;
  throw new Error(
    `no working directory for environment instance ${instanceId} and agent ${agent.id}`,
  );
}

/** Task bootstrap is deterministic Worker-owned-file guidance, not prompt text. */
function appendBootstrap(instructions: string | undefined, bootstrap: string | undefined): string | undefined {
  if (bootstrap === undefined || bootstrap === '') return instructions;
  return instructions === undefined || instructions === ''
    ? bootstrap
    : `${instructions}\n\n${bootstrap}`;
}
