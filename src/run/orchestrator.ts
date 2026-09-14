import type { AgentDefinition, AgentRegistry } from '../agent/registry.ts';
import type { EnvironmentPool } from '../environment/pool.ts';
import type { EngineAdapter, EngineSession, EngineTurnResult } from '../engine/port.ts';
import { createIdFactory, type IdFactory } from '../ids.ts';
import type { ProjectRegistry } from '../project/registry.ts';
import { resolveEnvironmentInstance } from '../project/resolve.ts';
import type { AgentRun, AgentRunStatus, RunObserver } from './model.ts';
import type { RunStore } from './store.ts';

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
   * Where engine adapters come from.
   *
   * A plain map satisfies this for tests and for adapters that never disappear.
   * A function is used when adapters must be resolved per run, which is what lets
   * an environment worker be restarted after it dies instead of failing every
   * later run against a dead connection (ADR-0003).
   */
  readonly engines: ReadonlyMap<string, EngineAdapter> | (() => Promise<ReadonlyMap<string, EngineAdapter>>);
  readonly agents: AgentRegistry;
  /**
   * Where an agent's project memberships come from. Optional so existing callers
   * and tests that never resolve an environment need not supply one; a run by an
   * agent with no project fails with an explicit message rather than a guess.
   */
  readonly projects?: ProjectRegistry;
  readonly pool: EnvironmentPool;
  readonly store: RunStore;
  readonly leaseTtlMs?: number;
  /** Injected so tests get deterministic ids; production uses unique ids. */
  readonly ids?: IdFactory;
  readonly clock?: { now(): number };
}

export interface SubmitRunRequest {
  readonly agentId: string;
  readonly prompt: string;
}

export class RunOrchestrator {
  readonly #engines: RunOrchestratorOptions['engines'];
  readonly #agents: AgentRegistry;
  readonly #projects: ProjectRegistry | undefined;
  readonly #pool: EnvironmentPool;
  readonly #store: RunStore;
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
      id: this.#ids.run(),
      agentId: request.agentId,
      prompt: request.prompt,
      environmentInstanceId: '',
      status: 'queued',
      events: [],
      createdAt: this.#clock.now(),
    };

    const agent = this.#agents.get(request.agentId);
    if (!agent) {
      await this.#finish(run, 'failed', { status: 'failed', message: `unknown agent: ${request.agentId}` });
      return { id: run.id };
    }

    // Resolve the environment before recording the run, so the persisted run
    // names the instance it actually used rather than an agent's fixed device.
    const resolution = resolveEnvironmentInstance(
      this.#projects?.forAgent(agent.id) ?? [],
      agent.capability,
      this.#pool,
    );
    if (!resolution.ok) {
      await this.#finish(run, 'failed', {
        status: 'failed',
        message: this.#resolutionFailure(agent, resolution.reason),
      });
      return { id: run.id };
    }

    const recorded: AgentRun = {
      ...run,
      environmentInstanceId: resolution.instanceId,
      projectId: resolution.projectId,
    };
    this.#runs.set(recorded.id, recorded);
    await this.#store.save(recorded);

    const settled = this.#execute(recorded, agent);
    this.#settled.set(recorded.id, settled);
    return { id: recorded.id };
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
        recovered.push(next);
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

  async #execute(initial: AgentRun, agent: AgentDefinition): Promise<AgentRun> {
    const engines =
      typeof this.#engines === 'function' ? await this.#engines() : this.#engines;
    const adapter = engines.get(agent.engine);
    if (!adapter) {
      return this.#finish(initial, 'failed', {
        status: 'failed',
        message: `no engine adapter registered for: ${agent.engine}`,
      });
    }

    const acquired = this.#pool.acquireLease({
      instanceId: initial.environmentInstanceId,
      capability: agent.capability,
      holderId: agent.id,
      runId: initial.id,
      ttlMs: this.#leaseTtlMs,
    });
    if (!acquired.ok) {
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

    const running = await this.#advance(initial, { status: 'running', leaseId: acquired.lease.id });

    let session: EngineSession;
    try {
      session = await adapter.startSession({
        agentId: agent.id,
        workingDirectory: agent.workingDirectory,
        ...(agent.instructions !== undefined ? { instructions: agent.instructions } : {}),
      });
    } catch (error) {
      this.#pool.releaseLease(acquired.lease.id);
      return this.#finish(running, 'failed', {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    this.#sessions.set(running.id, session);

    try {
      const turn = session.run(initial.prompt);
      let current = running;
      for await (const event of turn.events) {
        current = await this.#advance(current, {
          events: [...current.events, event],
        });
      }

      const result = await turn.completion;
      return await this.#settleWithResult(current, result);
    } catch (error) {
      return this.#finish(running, 'failed', {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.#sessions.delete(running.id);
      this.#pool.releaseLease(acquired.lease.id);
      await session.close();
    }
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
