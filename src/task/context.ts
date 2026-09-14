/**
 * Context assembly for a Task's next run (ticket #28).
 *
 * A Task advances through several sequential `AgentRun`s, but each run is a fresh
 * bounded activation — and if it lands on a different environment instance than
 * the previous one, the engine's own conversation cannot follow it (ADR-0004).
 * The durable Task is therefore what carries context across runs. This module
 * assembles that context from the Task and its *curated* run summaries.
 *
 * Two properties are load-bearing:
 *
 * 1. **Deterministic and testable, with no model call.** The text is a pure
 *    function of the persisted Task and its linked run summaries, so the same
 *    history always produces byte-identical text.
 * 2. **No raw event blow-up.** The input is the Task's goal and constraints plus
 *    each prior run's bounded *summary* — never a run's `events` stream. A run's
 *    events can carry another agent's raw tool output and reasoning, which must
 *    not accumulate into shared Task context. This is the same privacy rule the
 *    O5 hand-off follows.
 */

import type { Task, TaskRunLink } from './model.ts';

export interface TaskContextOptions {
  /** Most recent prior run summaries to include. */
  readonly maxPriorRuns?: number;
  /** Upper bound on the rendered context text, so a prompt stays token-restrained. */
  readonly maxCharacters?: number;
}

const DEFAULT_MAX_PRIOR_RUNS = 8;
const DEFAULT_MAX_CHARACTERS = 1_600;
/** A single summary line's own bound, so one verbose result cannot fill the budget. */
const MAX_ENTRY_CHARACTERS = 400;

/** The assembled, fact-form context one Task run is presented with. */
export interface TaskContext {
  readonly taskId: string;
  readonly title: string;
  readonly goal: string;
  readonly constraints: readonly string[];
  /** The prior runs whose summaries contributed to `text`, newest-last. */
  readonly sourceRunIds: readonly string[];
  readonly text: string;
}

/**
 * Build the context for a Task's next run.
 *
 * Prior runs are considered newest-first so the budget is spent on the most
 * recent work, then rendered oldest-first so the reading order matches the work
 * order. Renders `undefined`-free text: a Task with no settled prior runs still
 * gets its goal and constraints stated, because those are the durable contract
 * every run works under.
 */
export function buildTaskContext(
  task: Task,
  runs: readonly TaskRunLink[],
  options: TaskContextOptions = {},
): TaskContext {
  const maxPriorRuns = options.maxPriorRuns ?? DEFAULT_MAX_PRIOR_RUNS;
  const maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;

  const settled = runs
    .filter((link) => link.summary !== undefined)
    .slice()
    .sort((a, b) => b.sequence - a.sequence);

  const selected: TaskRunLink[] = [];
  const lines: string[] = [];
  let total = 0;
  for (const link of settled) {
    if (selected.length >= maxPriorRuns) break;
    const line = summaryLine(link);
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (total + cost > maxCharacters) break;
    lines.push(line);
    selected.push(link);
    total += cost;
  }
  // Reverse back to work order: oldest first, newest last.
  selected.reverse();
  lines.reverse();

  return {
    taskId: task.id,
    title: task.title,
    goal: task.goal,
    constraints: task.constraints,
    sourceRunIds: selected.map((link) => link.runId),
    text: lines.join('\n'),
  };
}

/** One bounded, fact-form line for a settled run. */
function summaryLine(link: TaskRunLink): string {
  const summary = link.summary!;
  const detail = bound(summary.summary.replace(/\s+/g, ' ').trim(), MAX_ENTRY_CHARACTERS);
  const label = `Run ${link.sequence} (${summary.agentId}, ${summary.status})`;
  return detail === '' ? `- ${label}` : `- ${label}: ${detail}`;
}

/**
 * Compose the run input for a Task advancement.
 *
 * The Task context is attached to the prompt rather than the standing
 * instructions, because it is *per-run* context: the standing instructions are
 * the durable project contract, while this describes the Task's goal and what its
 * earlier runs achieved. The section is clearly marked so the engine does not
 * mistake the accumulated history for a user request.
 */
export function renderTaskPrompt(context: TaskContext, prompt: string): string {
  const constraintLines =
    context.constraints.length === 0
      ? ['(none declared)']
      : context.constraints.map((constraint) => `- ${constraint}`);

  const priorSection =
    context.text === ''
      ? 'No prior run has settled for this Task yet.'
      : context.text;

  return [
    '## Task',
    `Title: ${context.title}`,
    `Goal: ${context.goal}`,
    '',
    'Constraints:',
    ...constraintLines,
    '',
    '## Prior work on this Task',
    'The following are factual summaries of earlier runs. They contain no',
    "transcript and no other agent's private reasoning.",
    priorSection,
    '',
    '## Request',
    prompt,
  ].join('\n');
}

/** Truncate to `limit` characters with an ellipsis when it does not fit. */
function bound(text: string, limit: number): string {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  if (limit === 1) return '…';
  return `${text.slice(0, limit - 1)}…`;
}

export { bound as boundTaskContextText };
