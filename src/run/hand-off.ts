import type { AgentRun } from '../run/model.ts';

/**
 * Hand-off context for a run that moved to a different environment instance.
 *
 * When an agent's run resolves to a different instance than its previous run, the
 * engine's own conversation cannot follow it (ADR-0004: a session key is scoped
 * to one environment instance), so the *durable* context has to be re-presented.
 * This module produces that context from persisted run records only.
 *
 * Two properties are load-bearing and are what the rule exists to guarantee:
 *
 * 1. **Deterministic and testable, with no model call.** The summary is a pure
 *    function of persisted `AgentRun` records, so the same history always
 *    produces byte-identical text and a test can assert it exactly.
 * 2. **Fact-form only.** The input is the terminal *result* and the environment
 *    each run used — never the run's `events` stream. A run's events are its
 *    progress record and can carry another agent's raw tool output and reasoning,
 *    which must not leak into a hand-off (`docs/goal.md`, O5 privacy rule).
 *    Summarising a result into one bounded line is the whole rule; there is no
 *    transcript excerpt anywhere in it.
 */

export interface HandOffSummaryOptions {
  /** Most recent prior runs to consider, newest first. */
  readonly maxRuns?: number;
  /** Upper bound on the rendered text, so a hand-off stays token-restrained. */
  readonly maxCharacters?: number;
}

const DEFAULT_MAX_RUNS = 5;
const DEFAULT_MAX_CHARACTERS = 1_200;
/** A single fact line's own bound, so one verbose result cannot fill the budget. */
const MAX_ENTRY_CHARACTERS = 400;

export interface HandOffContext {
  /** The instance the previous run used. */
  readonly previousEnvironmentInstanceId: string;
  /** The bounded, fact-form summary text. */
  readonly text: string;
  /** Which runs contributed a fact, so the hand-off is auditable. */
  readonly sourceRunIds: readonly string[];
}

/**
 * Whether a run's history warrants attaching a hand-off.
 *
 * The rule is exactly the environment question: attach only when the resolved
 * instance differs from the agent's previous run's instance. A run on the same
 * instance as its predecessor is not re-presented any prior results, because
 * that is where session continuation applies (ADR-0004) and the engine's own
 * conversation already carries the context. Re-stating it in the prompt would
 * duplicate the conversation, so an unchanged instance is never a hand-off —
 * including the case where no session key happened to be stored, where a fresh
 * session begins with the user's prompt alone rather than a fabricated summary.
 */
export function shouldAttachHandOff(request: {
  readonly previousEnvironmentInstanceId: string | undefined;
  readonly currentEnvironmentInstanceId: string;
}): boolean {
  const previous = request.previousEnvironmentInstanceId;
  if (previous === undefined) return false;
  return previous !== request.currentEnvironmentInstanceId;
}

/**
 * Whether a run in the history can be a *prior* run of the current one.
 *
 * Ordering by `createdAt` alone would drop a run that shares the current run's
 * millisecond, which two back-to-back submissions can easily do, so equal
 * timestamps are admitted and the current run is excluded by id. The result is
 * ordered newest-first with an id tie-break, so "previous" is deterministic even
 * when timestamps tie.
 */
function isPriorRun(
  run: AgentRun,
  request: {
    readonly agentId: string;
    readonly currentRunId: string;
    readonly currentCreatedAt: number;
  },
): boolean {
  return (
    run.agentId === request.agentId &&
    run.id !== request.currentRunId &&
    run.createdAt <= request.currentCreatedAt
  );
}

/** Newest-first ordering with a deterministic id tie-break. */
function byRecency(a: AgentRun, b: AgentRun): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The agent's previous run, before `currentRunId`.
 *
 * The agent is the identity that persists across projects and environments
 * (`CONTEXT.md`), so "the agent's previous run" is agent-scoped: a move between
 * projects is still a move that loses the engine conversation. Ordering is
 * explicit rather than trusting the store's iteration order, so which run counts
 * as "previous" is deterministic.
 */
export function previousRun(
  runs: readonly AgentRun[],
  request: {
    readonly agentId: string;
    readonly currentRunId: string;
    readonly currentCreatedAt: number;
  },
): AgentRun | undefined {
  const candidates = runs.filter((run) => isPriorRun(run, request));
  candidates.sort(byRecency);
  return candidates[0];
}

/** Prior runs of this agent, newest first, before the current run. */
function priorRuns(
  runs: readonly AgentRun[],
  request: {
    readonly agentId: string;
    readonly currentRunId: string;
    readonly currentCreatedAt: number;
  },
): readonly AgentRun[] {
  const candidates = runs.filter((run) => isPriorRun(run, request));
  candidates.sort(byRecency);
  return candidates;
}

/**
 * Build the fact-form hand-off for a run moving to a different environment.
 *
 * Returns `undefined` when there is nothing to hand off. The text is bounded in
 * both entry count and characters; entries are considered newest first and the
 * budget is consumed in that order, so the result depends only on the records and
 * the options.
 */
export function buildHandOffContext(
  runs: readonly AgentRun[],
  request: {
    readonly agentId: string;
    readonly currentRunId: string;
    readonly currentCreatedAt: number;
  },
  options: HandOffSummaryOptions = {},
): HandOffContext | undefined {
  const previous = previousRun(runs, request);
  if (previous === undefined) return undefined;

  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
  const maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
  const history = priorRuns(runs, request).slice(0, maxRuns);

  const entries: string[] = [];
  const sourceRunIds: string[] = [];
  let total = 0;
  for (const run of history) {
    const fact = factFor(run);
    if (fact === undefined) continue;
    // `+ 1` accounts for the newline that will join this entry to the previous.
    const cost = fact.length + (entries.length > 0 ? 1 : 0);
    if (total + cost > maxCharacters) break;
    entries.push(fact);
    sourceRunIds.push(run.id);
    total += cost;
  }

  if (entries.length === 0) {
    // A prior run exists but left no fact-form result (e.g. it was interrupted
    // before settling). The environment change is still worth stating.
    return {
      previousEnvironmentInstanceId: previous.environmentInstanceId,
      text: `This run continues work after a move to a different environment instance (was ${previous.environmentInstanceId}). No earlier result is available to summarise.`,
      sourceRunIds: [],
    };
  }

  return {
    previousEnvironmentInstanceId: previous.environmentInstanceId,
    text: entries.join('\n'),
    sourceRunIds,
  };
}

/** One bounded fact line for a run, or `undefined` when it has no fact to state. */
function factFor(run: AgentRun): string | undefined {
  const where = run.environmentInstanceId;
  switch (run.result?.status) {
    case 'completed': {
      const detail = bounded(run.result.text);
      return detail === '' ? `- Completed in ${where}` : `- Completed in ${where}: ${detail}`;
    }
    case 'failed': {
      const detail = bounded(run.result.message);
      return detail === '' ? `- Failed in ${where}` : `- Failed in ${where}: ${detail}`;
    }
    case 'interrupted':
      return `- Interrupted in ${where}`;
    default:
      // A run with no terminal result contributes no fact. Only result status is
      // consulted; `run.events` is never read, so no other agent's raw output or
      // reasoning can appear here.
      return undefined;
  }
}

/** Collapse whitespace and bound length, so one result cannot dominate the budget. */
function bounded(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_ENTRY_CHARACTERS) return collapsed;
  return `${collapsed.slice(0, MAX_ENTRY_CHARACTERS - 1)}…`;
}

/**
 * Compose the run input for a hand-off run.
 *
 * The hand-off is attached to the prompt rather than the standing instructions,
 * because it is *per-run* context: standing instructions are the durable project
 * contract, while this describes what happened before this particular run. The
 * section is clearly marked so the engine does not mistake it for a user request.
 */
export function renderHandOffPrompt(handOff: HandOffContext, prompt: string): string {
  return [
    '## Hand-off context',
    'You are continuing prior work after moving to a different environment instance.',
    'The following is a factual summary of earlier results. It contains no',
    'transcript and no other agent\'s private reasoning.',
    '',
    handOff.text,
    '',
    '## Task',
    prompt,
  ].join('\n');
}
