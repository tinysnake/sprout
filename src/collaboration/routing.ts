/**
 * The wake-model-assisted routing vocabulary: windows, batches, attempts, and
 * per-input outcomes (#97, ADR-0007).
 *
 * These are the durable facts that make assisted routing explainable without
 * internal logs:
 *
 * - A **routing window** opens with the first eligible unaddressed input of a
 *   Project under the `wake-model-assisted` policy. Its cursor, deadline, and
 *   input membership are durable, the deadline never resets when later inputs
 *   join, and a restart continues the same window.
 * - Closing a window freezes one or more **routing batches**: the window's
 *   inputs in chronological order, split into bounded batches rather than
 *   dropped when they cannot fit one bounded model context. A single oversized
 *   input is represented by a deterministic bounded excerpt marked truncated;
 *   its complete durable content stays in the Message/event record.
 * - A **routing attempt** is one wake-model evaluation of one frozen batch and
 *   its frozen context snapshot. A failure (missing model, timeout, exception,
 *   malformed/incomplete/unknown output) retries exactly once on the identical
 *   snapshot and then **fails closed**: no Agent is woken and every input gets
 *   a durable, visible failed outcome.
 * - A **routing input outcome** is the per-input result of one settled batch:
 *   selected (with per-Agent rationale), suppressed (model judgement), or
 *   failed. Every batch input always has exactly one outcome.
 *
 * The routing context itself is built by `routing-context.ts`; the model's
 * answer is parsed and validated by `routing-judgement.ts`. Nothing in this
 * file calls a model or a store.
 */

import type { WakePolicy } from '../project/authority-model.ts';

/** The durable lifecycle of one collection window. */
export type RoutingWindowStatus = 'open' | 'closed';

/**
 * One Project's fixed collection window (ADR-0007 "Collection windows and
 * routing batches").
 *
 * `deadlineAt` is fixed at open time and never moves: later eligible inputs
 * join without resetting it (a debounce window could starve under continuous
 * conversation). The cursor is the last input joined — the durable pointer
 * that proves membership survived a restart.
 */
export interface RoutingWindow {
  readonly id: string;
  readonly projectId: string;
  readonly openedAt: number;
  readonly deadlineAt: number;
  /** The fixed interval this window was opened with (configurable per Project). */
  readonly intervalMs: number;
  readonly status: RoutingWindowStatus;
  /** Last joined input id, in join order; absent while the window is empty. */
  readonly cursor?: string;
  readonly inputCount: number;
  readonly closedAt?: number;
}

/** The deterministic bounds one frozen routing context is built under. */
export interface RoutingBounds {
  /** Per-input content chars presented to the model before truncation. */
  readonly inputContentChars: number;
  /** Per-message chars for thread ancestors and recent channel context. */
  readonly contextMessageChars: number;
  /** Maximum recent Project-channel context messages in one context. */
  readonly recentContextMessages: number;
  /** The total rendered context budget; over it the window splits batches. */
  readonly totalContextChars: number;
}

/**
 * The default bounds. Deliberately generous for a cheap model but still
 * bounded: the split rule and the excerpt rule below are what make "no input
 * is dropped" true regardless of these numbers.
 */
export const DEFAULT_ROUTING_BOUNDS: RoutingBounds = {
  inputContentChars: 4_000,
  contextMessageChars: 1_000,
  recentContextMessages: 12,
  totalContextChars: 48_000,
};

/**
 * The privacy hard gate, as evidence (ADR-0007 "Bounded routing context").
 *
 * These categories are excluded from every routing context by construction —
 * the builder only reads the whitelisted Project-shared sources — and the list
 * itself is frozen into the manifest so the Human can see the boundary the
 * attempt was built under, not just trust it.
 */
export const ROUTING_CONTEXT_EXCLUSIONS: readonly string[] = [
  'direct Messages and their replies',
  'credentials, tokens, and secrets',
  'Agent-private memory',
  'raw reasoning and thinking traces',
  'engine sessions and run transcripts',
  'tool output',
  'host identity and private network facts',
  'transient Environment availability',
];

/** The durable lifecycle of one frozen routing batch. */
export type RoutingBatchStatus =
  /** Frozen from a closed window; not yet judged (or judgment interrupted). */
  | 'frozen'
  /** A valid attempt selected at least one Agent; WakeRequests exist. */
  | 'routed'
  /** A valid attempt deliberately selected no Agent (not a failure). */
  | 'suppressed'
  /** Two failed attempts: failed closed, every input has a failed outcome. */
  | 'failed';

/**
 * One durable frozen batch: the window's inputs, cut at `cutoffAt`, split
 * chronologically, with the exact context snapshot every attempt of this batch
 * is judged against.
 */
export interface RoutingBatch {
  readonly id: string;
  readonly projectId: string;
  /** The window this batch was frozen from; also its split group. */
  readonly windowId: string;
  /** 0-based position of this batch within its window's chronological split. */
  readonly splitIndex: number;
  /** How many batches the window was split into. */
  readonly splitCount: number;
  /** The window deadline this batch was cut at. */
  readonly cutoffAt: number;
  readonly status: RoutingBatchStatus;
  readonly bounds: RoutingBounds;
  /** The frozen manifest: inputs, candidates, bounds, truncations, exclusions. */
  readonly manifest: RoutingContextManifest;
  /** The frozen context snapshot; retries receive byte-identical bytes. */
  readonly context: string;
  /** Fail-closed reason, set only on `failed`. */
  readonly error?: string;
  readonly createdAt: number;
  readonly settledAt?: number;
}

/** One input's frozen representation inside a batch. */
export interface RoutingBatchInput {
  readonly batchId: string;
  readonly inputId: string;
  /** 0-based chronological position within the batch. */
  readonly position: number;
  /** The deterministic bounded excerpt shown to the model. */
  readonly excerpt: string;
  readonly truncated: boolean;
  readonly excerptChars: number;
  /** The complete durable content length (the content itself is not copied). */
  readonly contentChars: number;
}

/** One candidate Agent as frozen into the manifest. */
export interface RoutingCandidateView {
  readonly agentId: string;
  readonly responsibilities: readonly string[];
  readonly collaborationInstructions: string;
}

/**
 * One curated open Task as Project-shared routing context (ADR-0007
 * "curated public Task state, Task lead, and blocker summaries").
 *
 * Deliberately narrow: identity, title, lifecycle state, the lead Agent, and
 * the blocker reason. Environment bindings, leases, run links, constraints,
 * and any run-derived summary are excluded — transient capacity must not
 * become a routing fact (the privacy boundary excludes Environment
 * availability outright).
 */
export interface RoutingTaskFact {
  readonly taskId: string;
  readonly title: string;
  readonly status: 'todo' | 'in-progress' | 'blocked';
  readonly leadAgentId?: string;
  readonly blockerReason?: string;
  readonly createdAt: number;
}

/** The curation input: structurally satisfied by the durable Task record. */
export interface CuratableTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly assignedAgentId?: string;
  readonly blockerReason?: string;
  readonly createdAt: number;
}

/**
 * Curate durable Tasks into the bounded Project-shared facts a batch context
 * may show: only non-terminal lifecycle states, deterministically ordered,
 * with exactly the fields ADR-0007 names (state, lead, blocker summary).
 */
export function curateOpenTaskFacts(tasks: readonly CuratableTask[]): readonly RoutingTaskFact[] {
  return tasks
    .filter(
      (task) => task.status === 'todo' || task.status === 'in-progress' || task.status === 'blocked',
    )
    .map((task) => ({
      taskId: task.id,
      title: task.title,
      status: task.status as 'todo' | 'in-progress' | 'blocked',
      ...(task.assignedAgentId !== undefined ? { leadAgentId: task.assignedAgentId } : {}),
      ...(task.blockerReason !== undefined ? { blockerReason: task.blockerReason } : {}),
      createdAt: task.createdAt,
    }))
    .sort((a, b) => a.createdAt - b.createdAt || (a.taskId < b.taskId ? -1 : 1));
}

/** One input as frozen into the manifest, with its eligible candidates. */
export interface RoutingManifestInput {
  readonly inputId: string;
  readonly kind: 'message' | 'event';
  readonly authorId: string;
  readonly createdAt: number;
  /** The conversation scope for a Message; empty for a Project event. */
  readonly scopeId: string;
  /** Eligible current Agent candidates for this input (author excluded). */
  readonly candidates: readonly string[];
  readonly excerptChars: number;
  readonly contentChars: number;
  readonly truncated: boolean;
}

/**
 * The frozen context manifest: everything an evidence reader needs to see
 * *what the model saw*, without reconstructing it from logs.
 */
export interface RoutingContextManifest {
  readonly projectId: string;
  readonly windowId: string;
  readonly cutoffAt: number;
  readonly policy: WakePolicy;
  readonly bounds: RoutingBounds;
  /** Chronological batch inputs with their per-input candidate sets. */
  readonly inputs: readonly RoutingManifestInput[];
  /** Candidate Agents of the Project this context presents. */
  readonly candidates: readonly RoutingCandidateView[];
  /** Curated open Task state the context presents (capped and bounded). */
  readonly tasks: readonly RoutingTaskFact[];
  /** Recent Project-channel message ids included after candidate inputs. */
  readonly recentContextIds: readonly string[];
  /** Thread-ancestor message ids included for this batch's inputs. */
  readonly ancestorContextIds: readonly string[];
  /** The privacy exclusion list the builder enforced. */
  readonly exclusions: readonly string[];
  readonly contextChars: number;
}

/** Why one routing attempt failed (ADR-0007 "Failure, suppression, admission, and retry"). */
export type RoutingFailureKind =
  /** No wake model is configured, or the model threw. */
  | 'model-unavailable'
  /** The model did not answer within the attempt timeout. */
  | 'timeout'
  /** Output is not parseable JSON, or structurally not a judgement. */
  | 'malformed-output'
  /** A valid judgement that does not account for every batch input. */
  | 'incomplete-output'
  /** A selection names an Agent outside the input's eligible candidates. */
  | 'unknown-agent'
  /** A selection or suppression names an input outside the batch. */
  | 'unknown-input'
  /** Any other invalid combination (ambiguous/duplicate/contradictory). */
  | 'invalid-output';

/** One settled model evaluation of one frozen batch. */
export interface RoutingAttempt {
  readonly id: string;
  readonly batchId: string;
  /** 1-based; 2 is the one automatic retry on the identical snapshot. */
  readonly attemptNumber: number;
  /** The wake model's stable identity, as evidence. */
  readonly modelId: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly status: 'started' | 'succeeded' | 'failed';
  readonly errorKind?: RoutingFailureKind;
  /** Redacted, bounded failure detail — never raw model output. */
  readonly errorDetail?: string;
  /** Validated, redacted judgement, persisted before settlement for restart recovery. */
  readonly judgement?: import('./routing-judgement.ts').RoutingJudgement;
}

/** The durable result of one input in one settled batch. */
export type RoutingInputStatus = 'selected' | 'suppressed' | 'failed';

/** One Agent the model selected for one input, with its concise rationale. */
export interface RoutingAssignment {
  readonly agentId: string;
  /** Concise model rationale, labelled as model judgement (not fact). */
  readonly rationale: string;
}

/** One input's explicit result in a settled batch. */
export interface RoutingInputOutcome {
  readonly batchId: string;
  readonly inputId: string;
  readonly status: RoutingInputStatus;
  /** Selected Agents for this input; empty unless `selected`. */
  readonly assignments: readonly RoutingAssignment[];
  /** The model's rationale for suppressing this input, when suppressed. */
  readonly rationale?: string;
  /** Fail-closed detail, when failed. */
  readonly detail?: string;
  readonly settledAt: number;
}

/**
 * The wake-model port: one judgement of one frozen batch (#97).
 *
 * The port returns the model's raw answer (JSON text) and nothing else: the
 * core owns parsing, validation, retry, and fail-closed so an adapter cannot
 * decide which subset of a plausible-looking answer is trusted. `id` is the
 * stable model identity recorded on every attempt as evidence.
 *
 * There is no production wake-model adapter yet — configuring a real low-cost
 * model is explicit future work (docs/roadmap.md M2 evidence note). A build
 * with no model therefore fails every attempt as `model-unavailable`, which
 * ADR-0007 defines as a retried-then-failed-closed attempt with visible
 * per-input failures: never silence, never fail-open fan-out.
 * A future adapter must inject its provider key out of band (environment or OS
 * secret store), never through `id`, `judge` request fields, exceptions,
 * manifests, Messages, Project contracts, evidence, or logs. `id` is a public
 * model identity, not a provider credential. The coordinator records only a
 * constrained model identifier and product-owned failure text.
 */
export interface RoutingModelPort {
  readonly id: string;
  /** Optional trusted producer telemetry correlated to this exact invocation. */
  readonly telemetryForAttempt?: (attemptId: string) => Partial<import('../usage/routing-adapter.ts').RoutingTelemetry> | undefined;
  judge(request: {
    /** Coordinator-owned durable attempt identity; never synthesized by an adapter. */
    readonly attemptId: string;
    readonly batchId: string;
    readonly projectId: string;
    /** 1-based attempt number; the retry is attempt 2 on the same snapshot. */
    readonly attempt: number;
    /** The frozen context snapshot for this batch. */
    readonly context: string;
  }): Promise<string>;
}
