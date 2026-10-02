/**
 * Durable storage for Tasks and their run linkages (ticket #28, ADR-0002).
 *
 * A seam, not a detail of SQLite: the advancement service never issues a query,
 * and the in-memory implementation is enough for unit tests. The production
 * backend is `SqliteTaskStore`, mounted on Sprout's primary `SqliteStore` so Task
 * rows share the one database the runs, leases, projects, session keys, and
 * collaboration rows already use.
 *
 * The store's job is to make two invariants durable:
 *
 * 1. **A Task survives process restart.** Every Task attribute and status
 *    transition is written before it is observable, so a restart restores the
 *    Task exactly as the process left it.
 * 2. **A run links to a Task at most once.** `(taskId, runId)` is the link
 *    identity, enforced by the store rather than by a caller remembering to
 *    check first, so a retried advancement cannot double-count a run.
 */

import { serializeTaskControlDocument } from './model.ts';
import type {
  Task,
  TaskRunLink,
  TaskRunSummary,
  TaskStatus,
  TaskActor,
  TaskWithRuns,
} from './model.ts';
import type { EnvironmentLease } from '../environment/pool.ts';

/** Filters for listing Tasks. Both are optional and combine with AND. */
export interface TaskFilter {
  readonly projectId?: string;
  readonly status?: TaskStatus;
}

export interface TaskStore {
  /** Persist a new Task. A second call with the same id must not duplicate it. */
  create(task: Task): Promise<Task>;

  get(taskId: string): Promise<Task | undefined>;
  list(filter?: TaskFilter): Promise<readonly Task[]>;

  /**
   * Replace a Task's mutable state.
   *
   * The caller is responsible for having already computed `updatedAt` and any
   * terminal `completedAt`; the store keeps no clock of its own so transitions
   * stay deterministic and testable.
   */
  save(task: Task): Promise<void>;

  /**
   * Compare-and-set the lifecycle admission fields.  This is the durable
   * single-active-run guard: a stale reader must not overwrite another
   * caller's admitted run.
   */
  saveIfUnchanged(
    task: Task,
    expected: {
      readonly environmentLifecycleState: Task['environmentLifecycleState'];
      readonly activeRunId: Task['activeRunId'];
      readonly updatedAt?: number;
      readonly controlDocument: string | null;
    },
  ): Promise<boolean>;

  /** Persist Pause retry-required intent without replacing concurrently settled Task fields. */
  recordPauseRetryRequired(taskId: string, actor: TaskActor, at: number, reason: string): Promise<Task | undefined>;

  /**
   * Commit a Task's beginning intent and its Task lease together.
   *
   * One shared transaction: the Task row and the lease row commit or roll back
   * as one state. The lease statements belong to the environment domain and are
   * reached through its `TaskLeaseBinding` port, not issued here.
   */
  saveBeginningWithLease(task: Task, lease: EnvironmentLease): Promise<void>;

  /** Insert an approved Task, consume its proposal revision, and bind its lease atomically. */
  createBeginningWithLease(task: Task, lease: EnvironmentLease, consumeProposal: () => void): Promise<void>;

  /** Atomically admit one attributed run and persist its audit link with the active-run fence. */
  admitRun(task: Task, input: {
    readonly runId: string;
    readonly agentId: string;
    readonly actor: TaskActor;
    readonly reason?: string;
    readonly contentVersion: number;
    readonly now: number;
  }, expected: {
    readonly environmentLifecycleState: Task['environmentLifecycleState'];
    readonly activeRunId: Task['activeRunId'];
    readonly updatedAt?: number;
    readonly controlDocument: string | null;
  }): Promise<boolean>;

  /** Commit a terminal Task state and release its Task lease together. */
  saveTerminalWithLease(task: Task, leaseId: string): Promise<void>;

  /**
   * Link a run to a Task, assigning the next sequence number.
   *
   * Linking the same `(taskId, runId)` twice must not create a second link; the
   * existing link is returned, so a retried advancement is idempotent.
   */
  linkRun(input: {
    readonly taskId: string;
    readonly runId: string;
    readonly agentId: string;
    readonly now: number;
  }): Promise<TaskRunLink>;

  /** A Task's runs in sequence order. */
  listRuns(taskId: string): Promise<readonly TaskRunLink[]>;

  /** A Task with its ordered run history, for one read. */
  getWithRuns(taskId: string): Promise<TaskWithRuns | undefined>;

  /**
   * Record the settled summary for one linked run.
   *
   * A summary is only ever written for a run already linked to the Task, so an
   * unknown link is refused rather than silently dropped.
   */
  recordRunSummary(summary: TaskRunSummary & { readonly taskId: string }): Promise<void>;
}

/**
 * In-memory Task storage.
 *
 * Sufficient for unit tests. It enforces the same identities as the SQLite
 * implementation — one Task per id, one link per `(taskId, runId)` — so a test
 * that passes here is a statement about the contract rather than about one
 * backend.
 */
export class InMemoryTaskStore implements TaskStore {
  readonly #tasks = new Map<string, Task>();
  readonly #links = new Map<string, TaskRunLink[]>();

  async create(task: Task): Promise<Task> {
    const existing = this.#tasks.get(task.id);
    if (existing) return existing;
    this.#tasks.set(task.id, task);
    this.#links.set(task.id, []);
    return task;
  }

  async get(taskId: string): Promise<Task | undefined> {
    return this.#tasks.get(taskId);
  }

  async list(filter: TaskFilter = {}): Promise<readonly Task[]> {
    return [...this.#tasks.values()]
      .filter((task) => filter.projectId === undefined || task.projectId === filter.projectId)
      .filter((task) => filter.status === undefined || task.status === filter.status)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async save(task: Task): Promise<void> {
    this.#tasks.set(task.id, task);
  }

  async saveIfUnchanged(task: Task, expected: {
    readonly environmentLifecycleState: Task['environmentLifecycleState'];
    readonly activeRunId: Task['activeRunId'];
    readonly updatedAt?: number;
    readonly controlDocument: string | null;
  }): Promise<boolean> {
    const current = this.#tasks.get(task.id);
    if (!current || current.environmentLifecycleState !== expected.environmentLifecycleState || current.activeRunId !== expected.activeRunId
      || (expected.updatedAt !== undefined && current.updatedAt !== expected.updatedAt)
      || serializeTaskControlDocument(current) !== expected.controlDocument) return false;
    this.#tasks.set(task.id, task);
    return true;
  }

  async recordPauseRetryRequired(taskId: string, actor: TaskActor, at: number, reason: string): Promise<Task | undefined> {
    const current = this.#tasks.get(taskId);
    if (!current || current.pauseState !== undefined) return current;
    const retryRequired: Task = {
      ...current,
      pauseState: 'retry-required',
      controlHistory: [...(current.controlHistory ?? []), { action: 'pause-retry-required', actor, at, reason }],
    };
    this.#tasks.set(taskId, retryRequired);
    return retryRequired;
  }

  async saveBeginningWithLease(task: Task, _lease: EnvironmentLease): Promise<void> {
    this.#tasks.set(task.id, structuredClone(task));
  }

  async createBeginningWithLease(task: Task, _lease: EnvironmentLease, consumeProposal: () => void): Promise<void> {
    if (this.#tasks.has(task.id)) throw new Error(`task ${task.id} already exists`);
    consumeProposal();
    this.#tasks.set(task.id, structuredClone(task));
    this.#links.set(task.id, []);
  }

  async admitRun(task: Task, input: {
    readonly runId: string;
    readonly agentId: string;
    readonly actor: TaskActor;
    readonly reason?: string;
    readonly contentVersion: number;
    readonly now: number;
  }, expected: {
    readonly environmentLifecycleState: Task['environmentLifecycleState'];
    readonly activeRunId: Task['activeRunId'];
    readonly updatedAt?: number;
    readonly controlDocument: string | null;
  }): Promise<boolean> {
    const current = this.#tasks.get(task.id);
    if (!current || current.environmentLifecycleState !== expected.environmentLifecycleState || current.activeRunId !== expected.activeRunId
      || (expected.updatedAt !== undefined && current.updatedAt !== expected.updatedAt)
      || serializeTaskControlDocument(current) !== expected.controlDocument) return false;
    const links = this.#links.get(task.id) ?? [];
    if (links.some(link => link.runId === input.runId)) return false;
    const link: TaskRunLink = {
      taskId: task.id, runId: input.runId, agentId: input.agentId,
      actor: structuredClone(input.actor), ...(input.reason !== undefined ? { reason: input.reason } : {}), contentVersion: input.contentVersion,
      requestedAt: input.now, sequence: links.length + 1, linkedAt: input.now,
    };
    this.#tasks.set(task.id, structuredClone(task));
    this.#links.set(task.id, [...links, link]);
    return true;
  }

  async saveTerminalWithLease(task: Task, _leaseId: string): Promise<void> {
    this.#tasks.set(task.id, task);
  }

  async linkRun(input: {
    readonly taskId: string;
    readonly runId: string;
    readonly agentId: string;
    readonly now: number;
  }): Promise<TaskRunLink> {
    const links = this.#links.get(input.taskId) ?? [];
    const existing = links.find((link) => link.runId === input.runId);
    if (existing) return existing;
    const link: TaskRunLink = {
      taskId: input.taskId,
      runId: input.runId,
      agentId: input.agentId,
      sequence: links.length + 1,
      linkedAt: input.now,
    };
    links.push(link);
    this.#links.set(input.taskId, links);
    return link;
  }

  async listRuns(taskId: string): Promise<readonly TaskRunLink[]> {
    return [...(this.#links.get(taskId) ?? [])].sort((a, b) => a.sequence - b.sequence);
  }

  async getWithRuns(taskId: string): Promise<TaskWithRuns | undefined> {
    const task = this.#tasks.get(taskId);
    if (!task) return undefined;
    return { task, runs: await this.listRuns(taskId) };
  }

  async recordRunSummary(summary: TaskRunSummary & { readonly taskId: string }): Promise<void> {
    const links = this.#links.get(summary.taskId);
    const index = links?.findIndex((link) => link.runId === summary.runId) ?? -1;
    if (!links || index < 0) {
      throw new Error(`run ${summary.runId} is not linked to task ${summary.taskId}`);
    }
    const link = links[index]!;
    links[index] = {
      ...link,
      summary: {
        runId: summary.runId,
        agentId: summary.agentId,
        status: summary.status,
        summary: summary.summary,
        recordedAt: summary.recordedAt,
      },
    };
  }
}
