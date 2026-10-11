import type { AgentRun } from '../run/model.ts';
import { sanitizeIdentifier } from '../environment/privacy.ts';

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
  /** The Environment instance the previous run used, when Environment-hosted. */
  readonly previousEnvironmentInstanceId: string;
  /** Execution placement used by the prior run. */
  readonly previousExecutionMode?: import('../execution-mode.ts').ExecutionMode;
  /** Opaque local Engine profile identity, when the prior run was Host-run. */
  readonly previousEngineHostProfileId?: string;
  /** The bounded, fact-form summary text. */
  readonly text: string;
  /** Sprout-produced binding transition, when the prior activation used another grant. */
  readonly bindingChange?: string;
  /** Binding used by the prior run, for the current activation's transition check. */
  readonly previousWorkspaceBinding?: AgentRun['workspaceBinding'];
  /** Which runs contributed a fact, so the hand-off is auditable. */
  readonly sourceRunIds: readonly string[];
}

function workspaceBindingChange(
  previous: AgentRun,
  current: {
    readonly currentEnvironmentInstanceId?: string;
    readonly currentWorkspaceBinding?: AgentRun['workspaceBinding'];
  },
): string | undefined {
  if (current.currentEnvironmentInstanceId === undefined && current.currentWorkspaceBinding === undefined) return undefined;
  const previousEnvironmentId = previous.workspaceBinding?.environmentInstanceId ?? previous.environmentInstanceId;
  const currentEnvironmentId = current.currentWorkspaceBinding?.environmentInstanceId ??
    current.currentEnvironmentInstanceId ?? '';
  const previousEnvironment = previousEnvironmentId === ''
    ? 'none'
    : sanitizeIdentifier(previousEnvironmentId, { fallback: 'unknown-environment', kind: 'generic' });
  const currentEnvironment = currentEnvironmentId === ''
    ? 'none'
    : sanitizeIdentifier(currentEnvironmentId, { fallback: 'unknown-environment', kind: 'generic' });
  if (previousEnvironment !== currentEnvironment) {
    return `Sprout switched the current Work Environment from ${previousEnvironment} to ${currentEnvironment}.`;
  }
  if (sameWorkspaceBinding(previous.workspaceBinding, current.currentWorkspaceBinding)) return undefined;
  const prior = previous.workspaceBinding;
  const next = current.currentWorkspaceBinding;
  const describeCapabilities = (binding: NonNullable<AgentRun['workspaceBinding']>): string => {
    const operations = binding.operations ?? [];
    const mcpTools = binding.projectMcpTools ?? [];
    return `workspace operations ${operations.length ? operations.join(', ') : 'none'}; Project MCP tools ${mcpTools.length ? mcpTools.join(', ') : 'none'}`;
  };
  if (prior !== undefined && next !== undefined &&
      prior.environmentInstanceId === next.environmentInstanceId &&
      prior.bindingId === next.bindingId && prior.generation === next.generation &&
      prior.workspaceId === next.workspaceId && prior.kind === next.kind && prior.path === next.path) {
    return `Sprout refreshed the current tool catalog. Available operations: ${describeCapabilities(next)}.`;
  }
  const describe = (binding: AgentRun['workspaceBinding'] | undefined): string => {
    if (binding === undefined) return 'no workspace binding';
    const generation = binding.generation === undefined ? '' : ` at generation ${binding.generation}`;
    return `${binding.kind} workspace${generation}`;
  };
  return `Sprout switched the current workspace binding from ${describe(previous.workspaceBinding)} to ${describe(current.currentWorkspaceBinding)}.`;
}

function sameWorkspaceBinding(
  left: AgentRun['workspaceBinding'] | undefined,
  right: AgentRun['workspaceBinding'] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.environmentInstanceId === right.environmentInstanceId &&
    left.bindingId === right.bindingId && left.workspaceId === right.workspaceId &&
    left.generation === right.generation && left.kind === right.kind && left.path === right.path &&
    left.catalogIdentity === right.catalogIdentity &&
    sameStrings(left.operations, right.operations) && sameStrings(left.projectMcpTools, right.projectMcpTools);
}

function sameStrings(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.length === rightSorted.length && leftSorted.every((value, index) => value === rightSorted[index]);
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
  readonly previousExecutionMode?: import('../execution-mode.ts').ExecutionMode;
  readonly currentExecutionMode?: import('../execution-mode.ts').ExecutionMode;
  readonly previousEngineHostProfileId?: string;
  readonly currentEngineHostProfileId?: string;
  readonly currentWorkspaceBinding?: AgentRun['workspaceBinding'];
  readonly previousWorkspaceBinding?: AgentRun['workspaceBinding'];
}): boolean {
  const previous = request.previousEnvironmentInstanceId;
  if (previous === undefined) return false;
  const previousMode = request.previousExecutionMode ?? 'environment-hosted';
  const currentMode = request.currentExecutionMode ?? 'environment-hosted';
  if (previousMode !== currentMode) return true;
  if (currentMode === 'host-run' && request.previousEngineHostProfileId !== request.currentEngineHostProfileId) return true;
  if (previous !== request.currentEnvironmentInstanceId) return true;
  return !sameWorkspaceBinding(request.previousWorkspaceBinding, request.currentWorkspaceBinding);
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
    readonly projectId?: string;
  },
): boolean {
  return (
    run.agentId === request.agentId &&
    (request.projectId === undefined || run.projectId === request.projectId) &&
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
    readonly projectId?: string;
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
    readonly projectId?: string;
  },
): readonly AgentRun[] {
  const candidates = runs.filter((run) => isPriorRun(run, request));
  candidates.sort(byRecency);
  return candidates;
}

/**
 * How the hand-off opens, so a reader knows it is prior-work context and not a
 * user request. Chosen so the shortest useful hand-off still states the move.
 */
function moveNotice(previous: AgentRun): string {
  const placement = previous.executionMode === 'host-run'
    ? `Engine host profile ${previous.engineHostProfileId ?? 'unknown'}`
    : `environment instance ${previous.environmentInstanceId}`;
  return `This run continues prior work after a move from ${placement}.`;
}

/**
 * Build the fact-form hand-off for a run moving to a different environment.
 *
 * Returns `undefined` when there is nothing to hand off. The text is bounded in
 * both entry count and characters; entries are considered newest first and the
 * budget is consumed in that order, so the result depends only on the records and
 * the options. The bound applies to *every* outcome, including the no-result
 * notice, so an unusually small `maxCharacters` can never be exceeded.
 */
export function buildHandOffContext(
  runs: readonly AgentRun[],
  request: {
    readonly agentId: string;
    readonly currentRunId: string;
    readonly currentCreatedAt: number;
    readonly projectId?: string;
    readonly currentEnvironmentInstanceId?: string;
    readonly currentExecutionMode?: import('../execution-mode.ts').ExecutionMode;
    readonly currentEngineHostProfileId?: string;
    readonly currentWorkspaceBinding?: AgentRun['workspaceBinding'];
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
  const bindingChange = workspaceBindingChange(previous, request);
  if (bindingChange !== undefined) {
    const fact = bound(bindingChange, MAX_ENTRY_CHARACTERS);
    if (fact.length <= maxCharacters) {
      entries.push(fact);
      total = fact.length;
    }
  }
  for (const run of history) {
    const fact = factFor(run);
    if (fact === undefined) continue;
    const cost = fact.length + (entries.length > 0 ? 1 : 0);
    if (total + cost > maxCharacters) break;
    entries.push(fact);
    sourceRunIds.push(run.id);
    total += cost;
  }

  if (entries.length === 0) {
    // A prior run exists but left no fact-form result (e.g. it was interrupted
    // before settling). The environment change is still worth stating, but the
    // notice is bounded like any entry so a tiny budget is honoured rather than
    // silently exceeded.
    return {
      previousEnvironmentInstanceId: previous.environmentInstanceId,
      previousExecutionMode: previous.executionMode ?? 'environment-hosted',
      ...(previous.workspaceBinding !== undefined ? { previousWorkspaceBinding: previous.workspaceBinding } : {}),
      ...(bindingChange !== undefined ? { bindingChange } : {}),
      text: bound(entries.length > 0 ? entries.join('\n') : moveNotice(previous), maxCharacters),
      sourceRunIds,
    };
  }

  return {
    previousEnvironmentInstanceId: previous.environmentInstanceId,
    previousExecutionMode: previous.executionMode ?? 'environment-hosted',
    ...(previous.engineHostProfileId !== undefined ? { previousEngineHostProfileId: previous.engineHostProfileId } : {}),
    ...(previous.workspaceBinding !== undefined ? { previousWorkspaceBinding: previous.workspaceBinding } : {}),
    ...(bindingChange !== undefined ? { bindingChange } : {}),
    text: entries.join('\n'),
    sourceRunIds,
  };
}

/** One bounded fact line for a run, or `undefined` when it has no fact to state. */
function factFor(run: AgentRun): string | undefined {
  const environment = run.workspaceBinding?.environmentInstanceId ?? run.environmentInstanceId;
  const where = run.workspaceBinding !== undefined
    ? `Environment ${environment}, ${run.workspaceBinding.kind} workspace${run.workspaceBinding.generation !== undefined ? ` at binding generation ${run.workspaceBinding.generation}` : ''}`
    : run.executionMode === 'host-run'
      ? `Engine host profile ${run.engineHostProfileId ?? 'unknown'}${environment ? `, Environment ${environment}` : ''}`
      : environment;
  if (run.status === 'stopped') return `- Stopped in ${where}`;
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
  return bound(text.replace(/\s+/g, ' ').trim(), MAX_ENTRY_CHARACTERS);
}

/** Truncate to `limit` characters with an ellipsis when it does not fit. */
function bound(text: string, limit: number): string {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  if (limit === 1) return '…';
  return `${text.slice(0, limit - 1)}…`;
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
    handOff.bindingChange !== undefined
      ? 'The current work binding changed as recorded below.'
      : handOff.previousExecutionMode === 'host-run'
        ? 'You are continuing prior work after moving to a different Engine host profile.'
        : 'You are continuing prior work after moving to a different environment instance.',
    'The following is a factual summary of earlier results. It contains no',
    'transcript and no other agent\'s private reasoning.',
    '',
    handOff.text,
    '',
    '## Task',
    prompt,
  ].join('\n');
}
