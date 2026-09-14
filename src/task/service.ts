/**
 * Task advancement (#28): the service that owns the durable Task lifecycle.
 *
 * This is where the Task domain's rules live:
 *
 * - **Creation and state.** A Task is created in `todo` (or at another explicit
 *   status) and moves through the `TaskStatus` lifecycle. Terminal statuses stamp
 *   `completedAt`; a later non-terminal change clears it.
 * - **Multi-run advancement.** `advance` moves a `todo` or `blocked` Task to
 *   `in-progress` and submits one agent run linked to it. The run's prompt is
 *   assembled from the Task's goal, constraints, and the curated summaries of its
 *   prior runs, so context accumulates without replaying raw events.
 * - **Run settlement.** When a linked run settles, its outcome is recorded as a
 *   bounded, fact-form summary, and a failed or interrupted run moves the Task to
 *   `blocked` so the halt is visible and a human can decide to retry, correct, or
 *   cancel.
 * - **Environment preference.** A Task's `environmentPreference` is passed to
 *   every run submission, where the orchestrator honours it before falling back
 *   to project matching.
 *
 * The service implements the run seam's `TaskContextProvider`/`TaskRunObserver`
 * shapes directly, so the orchestrator depends on two small method contracts
 * rather than on this class. The dependency stays one-way: Task code knows the run
 * layer, the run layer never knows the Task domain model.
 */

import type { EnvironmentPreference } from '../environment/model.ts';
import { createIdFactory, type IdFactory } from '../ids.ts';
import type { AgentRun } from '../run/model.ts';
import { buildTaskContext, renderTaskPrompt } from './context.ts';
import {
  canAdvanceTask,
  isTerminalTaskStatus,
  type Task,
  type TaskRunSummary,
  type TaskStatus,
  type TaskWithRuns,
} from './model.ts';
import type { TaskFilter, TaskStore } from './store.ts';

/** The slice of the run orchestrator the Task service uses. */
export interface TaskRunner {
  submit(request: {
    readonly agentId: string;
    readonly prompt: string;
    readonly taskId?: string;
    readonly environmentPreference?: EnvironmentPreference;
  }): Promise<{ readonly id: string }>;
}

export interface CreateTaskInput {
  readonly projectId: string;
  readonly title: string;
  readonly goal: string;
  /** Declared constraints; omitted means "no declared constraints". */
  readonly constraints?: readonly string[];
  readonly assignedAgentId?: string;
  readonly environmentPreference?: EnvironmentPreference;
  /** Defaults to `todo`; the only status a Task is normally created in. */
  readonly status?: TaskStatus;
}

/** A partial update. `null` clears an optional field; `undefined` leaves it. */
export interface UpdateTaskInput {
  readonly title?: string;
  readonly goal?: string;
  readonly constraints?: readonly string[];
  readonly status?: TaskStatus;
  readonly assignedAgentId?: string | null;
  readonly environmentPreference?: EnvironmentPreference | null;
  readonly blockerReason?: string | null;
}

export interface AdvanceTaskOptions {
  /** The agent to advance the Task. Defaults to the Task's `assignedAgentId`. */
  readonly agentId?: string;
  /**
   * The run instruction. Defaults to a deterministic "continue the Task" prompt;
   * the Task's assembled goal/constraints/prior-run context is added regardless.
   */
  readonly prompt?: string;
}

export interface TaskServiceOptions {
  readonly store: TaskStore;
  readonly runs: TaskRunner;
  /** Injected so tests get deterministic ids; production uses unique ids. */
  readonly ids?: IdFactory;
  readonly clock?: { now(): number };
}

export class TaskService {
  readonly #store: TaskStore;
  readonly #runs: TaskRunner;
  readonly #ids: IdFactory;
  readonly #clock: { now(): number };

  constructor(options: TaskServiceOptions) {
    this.#store = options.store;
    this.#runs = options.runs;
    this.#ids = options.ids ?? createIdFactory();
    this.#clock = options.clock ?? { now: () => Date.now() };
  }

  /** Create a durable Task. A second create with the same id is a no-op retry. */
  async create(input: CreateTaskInput): Promise<Task> {
    assertRequired(input.projectId, 'projectId');
    assertRequired(input.title, 'title');
    assertRequired(input.goal, 'goal');
    const now = this.#clock.now();
    const status = input.status ?? 'todo';
    const task: Task = {
      id: this.#ids.task(),
      projectId: input.projectId,
      title: input.title,
      goal: input.goal,
      constraints: input.constraints ?? [],
      status,
      ...(input.assignedAgentId !== undefined ? { assignedAgentId: input.assignedAgentId } : {}),
      ...(input.environmentPreference !== undefined
        ? { environmentPreference: input.environmentPreference }
        : {}),
      createdAt: now,
      updatedAt: now,
      ...(isTerminalTaskStatus(status) ? { completedAt: now } : {}),
    };
    return this.#store.create(task);
  }

  get(taskId: string): Promise<Task | undefined> {
    return this.#store.get(taskId);
  }

  list(filter: TaskFilter = {}): Promise<readonly Task[]> {
    return this.#store.list(filter);
  }

  getWithRuns(taskId: string): Promise<TaskWithRuns | undefined> {
    return this.#store.getWithRuns(taskId);
  }

  /**
   * Apply a partial update to a Task.
   *
   * Moving into a terminal status stamps `completedAt`; moving back out of one
   * clears it, so a Task that is reopened does not claim a completion time it no
   * longer has.
   */
  async update(taskId: string, patch: UpdateTaskInput): Promise<Task> {
    const task = await this.#require(taskId);
    if (patch.title !== undefined) assertRequired(patch.title, 'title');
    if (patch.goal !== undefined) assertRequired(patch.goal, 'goal');

    const status = patch.status ?? task.status;
    const now = this.#clock.now();
    const next: Task = {
      ...task,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
      ...(patch.constraints !== undefined ? { constraints: patch.constraints } : {}),
      status,
      updatedAt: now,
    };
    // Optional fields need explicit clearing, which spread cannot express.
    const withAgent = clearOrSet(next, 'assignedAgentId', patch.assignedAgentId);
    const withPreference = clearOrSet(withAgent, 'environmentPreference', patch.environmentPreference);
    const withBlocker = clearOrSet(withPreference, 'blockerReason', patch.blockerReason);
    const withCompletion = isTerminalTaskStatus(status)
      ? { ...withBlocker, completedAt: task.completedAt ?? now }
      : omit(withBlocker, 'completedAt');
    await this.#store.save(withCompletion);
    return withCompletion;
  }

  /**
   * Advance a Task with one new run.
   *
   * A `todo` or `blocked` Task moves to `in-progress` *before* the run is
   * admitted, so the status is durable even if the run then fails to start. The
   * run is linked into the Task's sequence by the orchestrator through `link`,
   * and its settlement is reported through `onRunSettled`.
   */
  async advance(
    taskId: string,
    options: AdvanceTaskOptions = {},
  ): Promise<{ readonly task: Task; readonly runId: string }> {
    let task = await this.#require(taskId);
    if (!canAdvanceTask(task.status)) {
      throw new Error(`task ${taskId} is ${task.status} and cannot be advanced`);
    }
    const agentId = options.agentId ?? task.assignedAgentId;
    if (agentId === undefined) {
      throw new Error(`task ${taskId} has no assigned agent; assign one or name an agent to advance it`);
    }

    if (task.status !== 'in-progress') {
      await this.#store.save({ ...task, status: 'in-progress', updatedAt: this.#clock.now() });
      task = await this.#require(taskId);
    }

    const prompt = options.prompt ?? defaultAdvancePrompt(task);
    const { id: runId } = await this.#runs.submit({
      agentId,
      prompt,
      taskId,
      ...(task.environmentPreference !== undefined
        ? { environmentPreference: task.environmentPreference }
        : {}),
    });
    return { task: (await this.#store.get(taskId)) ?? task, runId };
  }

  /**
   * Render the prompt for a Task run.
   *
   * This is the `TaskContextProvider` the orchestrator calls. It reads the Task
   * and its run links, which the store returns in sequence order, then assembles
   * goal + constraints + curated prior summaries. An unknown Task is refused
   * rather than run context-free.
   */
  async prompt(input: { readonly taskId: string; readonly prompt: string }): Promise<string> {
    const task = await this.#require(input.taskId);
    const runs = await this.#store.listRuns(input.taskId);
    return renderTaskPrompt(buildTaskContext(task, runs), input.prompt);
  }

  /** Link an admitted run into its Task's sequence. Idempotent per run id. */
  async link(input: {
    readonly taskId: string;
    readonly runId: string;
    readonly agentId: string;
  }): Promise<void> {
    await this.#store.linkRun({ ...input, now: this.#clock.now() });
    // The first run to advance a Task records which agent owns it, so later
    // advances need no explicit agent.
    const task = await this.#store.get(input.taskId);
    if (task && task.assignedAgentId === undefined) {
      await this.#store.save({ ...task, assignedAgentId: input.agentId, updatedAt: this.#clock.now() });
    }
  }

  /**
   * Record a settled Task run and advance the Task's state.
   *
   * This is the `TaskRunObserver` the orchestrator calls. It links the run (so an
   * early failure that never reached `link` is still part of history), records a
   * bounded fact-form summary for every terminal run, and moves the Task to
   * `blocked` when the run did not complete. A non-terminal run is ignored: only
   * settled work is recorded.
   */
  async onRunSettled(input: { readonly taskId: string; readonly run: AgentRun }): Promise<void> {
    const { taskId, run } = input;
    await this.link({ taskId, runId: run.id, agentId: run.agentId });
    if (run.status === 'queued' || run.status === 'running') return;

    const summary: TaskRunSummary & { readonly taskId: string } = {
      taskId,
      runId: run.id,
      agentId: run.agentId,
      status: run.status,
      summary: summarizeRun(run),
      recordedAt: this.#clock.now(),
    };
    await this.#store.recordRunSummary(summary);

    const task = await this.#store.get(taskId);
    if (!task) return;
    // A failed or interrupted run halts the multi-run progression until a human
    // decides what to do. `completed` leaves the Task in progress: a Task is
    // multi-run work and one successful run does not finish it on its own.
    if (task.status === 'in-progress' && (run.status === 'failed' || run.status === 'interrupted')) {
      await this.#store.save({
        ...task,
        status: 'blocked',
        blockerReason: `run ${run.id} ${run.status}: ${run.failure ?? 'no failure detail'}`,
        updatedAt: this.#clock.now(),
      });
    }
  }

  async #require(taskId: string): Promise<Task> {
    const task = await this.#store.get(taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    return task;
  }
}

/** The deterministic default instruction for advancing a Task with no prompt. */
function defaultAdvancePrompt(task: Task): string {
  return (
    `Continue work on Task "${task.title}". Review the prior work summarized above and take the ` +
    `next concrete step toward the goal. Report what you actually did and what remains.`
  );
}

/**
 * A run's bounded, fact-form summary.
 *
 * Only the terminal result text (or failure message) is used — never the run's
 * `events` stream — so a summary can never leak another agent's raw tool output
 * or private reasoning into the Task's accumulated context (the same privacy rule
 * as the O5 hand-off).
 */
function summarizeRun(run: AgentRun): string {
  if (run.result?.status === 'completed') return run.result.text.trim();
  if (run.result?.status === 'failed') return run.result.message.trim();
  return run.failure?.trim() ?? '';
}

/** Set an optional field to a value, or remove it when the patch says `null`. */
function clearOrSet<K extends keyof Task>(
  task: Task,
  key: K,
  value: Task[K] | null | undefined,
): Task {
  if (value === undefined) return task;
  if (value === null) return omit(task, key);
  return { ...task, [key]: value };
}

/** A Task without one optional field, honoring `exactOptionalPropertyTypes`. */
function omit<K extends keyof Task>(task: Task, key: K): Task {
  const { [key]: _removed, ...rest } = task;
  return rest as Task;
}

function assertRequired(value: string, field: string): void {
  if (value.trim() === '') throw new Error(`${field} is required`);
}
