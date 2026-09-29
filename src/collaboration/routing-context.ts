/**
 * The bounded routing context builder (#97, ADR-0007 "Bounded routing
 * context").
 *
 * This module is pure: it turns already-resolved Project-shared facts into
 * frozen batches — chronological partition, deterministic truncation, the
 * rendered context snapshot, and the manifest that records what the model will
 * see. It never reads a store and never calls a model.
 *
 * The privacy hard gate combines a source whitelist with redaction of every
 * free-text field before rendering: the builder only receives batch inputs
 * (eligible unaddressed Messages and `wake-eligible` Project events), the
 * Project contract (goal and rules; Tasks are omitted without a relevance rule),
 * candidate Agent facts (identifiers, Project responsibilities, collaboration
 * instructions), thread ancestors of the batch's own inputs, and recent
 * *Project-channel* context including non-routing projected replies. Direct
 * Messages, credentials, private memory, raw reasoning, sessions, tool output,
 * host facts, and transient Environment availability have no independent
 * source here. Shared text still requires redaction; the exclusion list alone
 * is evidence, not enforcement.
 *
 * Sizing rules:
 *
 * - Every input content is redacted and bounded first (`inputContentChars`) with an
 *   explicit truncation marker; the complete content stays durable on the
 *   Message/event.
 * - Shared narrative is capped before chronological packing. Input excerpts
 *   shrink to the remaining budget and overflow starts a new batch. One input
 *   is always accepted, and its complete source remains durable.
 * - Candidate inputs have priority, then their direct thread ancestors, then
 *   recent shared channel context within the remaining bound.
 */

import {
  DEFAULT_ROUTING_BOUNDS,
  ROUTING_CONTEXT_EXCLUSIONS,
  type RoutingBatchInput,
  type RoutingBounds,
  type RoutingCandidateView,
  type RoutingContextManifest,
  type RoutingManifestInput,
  type RoutingTaskFact,
  type RoutingWindow,
} from './routing.ts';
import { ROUTING_JUDGEMENT_CONTRACT } from './routing-judgement.ts';
import { redactSensitiveText } from '../environment/privacy.ts';

/** One eligible unaddressed input, resolved from durable records. */
export interface RoutingInputFact {
  readonly inputId: string;
  readonly kind: 'message' | 'event';
  readonly authorId: string;
  readonly createdAt: number;
  /** The Message's conversation scope; empty for a Project event. */
  readonly scopeId: string;
  /** The complete durable content (excerpted deterministically below). */
  readonly content: string;
  /** Eligible current Agent candidates for this input, author excluded. */
  readonly candidates: readonly string[];
  /** The Message this one replies to, when it is a reply. */
  readonly inReplyTo?: string;
}

/** A Project-channel message usable as bounded shared context. */
export interface RoutingContextMessage {
  readonly id: string;
  readonly authorId: string;
  readonly authorKind: string;
  readonly createdAt: number;
  readonly body: string;
  readonly inReplyTo?: string;
}

/** The Project-shared contract facts frozen into the context. */
export interface RoutingContractFacts {
  readonly projectId: string;
  readonly goal: string;
  readonly rules: readonly string[];
  /** Every current candidate Agent with its Project-declared facts. */
  readonly candidates: readonly RoutingCandidateView[];
  /** Reserved for a future explicit per-input relevance rule; currently omitted. */
  readonly tasks?: readonly RoutingTaskFact[];
}

/** How many curated Task facts the frozen context may present at most. */
export const ROUTING_CONTEXT_TASK_CAP = 12;

export interface FreezeRoutingBatchesInput {
  readonly window: RoutingWindow;
  /** The window's inputs, already in chronological order. */
  readonly inputs: readonly RoutingInputFact[];
  readonly contract: RoutingContractFacts;
  /** Recent Project-channel context (chronological), inputs excluded by id. */
  readonly recentContext: readonly RoutingContextMessage[];
  /** Thread-ancestor lookup; ancestors may live outside the recent window. */
  readonly messageById: (id: string) => RoutingContextMessage | undefined;
  readonly bounds?: Partial<RoutingBounds>;
  readonly now: number;
  readonly createBatchId: () => string;
}

export interface FrozenRoutingBatchPlan {
  readonly batchId: string;
  readonly splitIndex: number;
  readonly splitCount: number;
  readonly cutoffAt: number;
  readonly bounds: RoutingBounds;
  readonly manifest: RoutingContextManifest;
  readonly context: string;
  readonly inputs: readonly RoutingBatchInput[];
}

/** The deterministic bounded excerpt of one input's content. */
export function truncateRoutingContent(
  content: string,
  maxChars: number,
  durableChars = content.length,
): { readonly excerpt: string; readonly truncated: boolean; readonly contentChars: number } {
  const contentChars = durableChars;
  if (content.length <= maxChars) {
    return { excerpt: content, truncated: false, contentChars };
  }
  const marker =
    `\n…[truncated: first ${maxChars} of ${contentChars} characters; ` +
    'the complete content remains durable]';
  return { excerpt: content.slice(0, maxChars) + marker, truncated: true, contentChars };
}

function inputHeader(input: RoutingInputFact, position: number): string {
  const kindLabel = input.kind === 'message' ? 'message' : 'project-event';
  const scope = input.scopeId === '' ? 'project' : input.scopeId;
  return (
    `[input ${position + 1} | id=${input.inputId} | kind=${kindLabel} | ` +
    `author=${input.authorId} | at=${input.createdAt} | scope=${scope}]`
  );
}

function renderSharedPrefix(
  contract: RoutingContractFacts,
  window: RoutingWindow,
  bounds: RoutingBounds,
): string {
  const lines = [
    `You are the wake model for project ${contract.projectId}, judging one frozen batch of eligible unaddressed inputs under the wake-model-assisted policy.`,
    `Collection window opened at ${window.openedAt} with a fixed ${window.intervalMs}ms interval; deadline ${window.deadlineAt}. This batch was cut at that deadline.`,
    `Bounds: input content ${bounds.inputContentChars} chars, context message ${bounds.contextMessageChars} chars, recent context ${bounds.recentContextMessages} messages, total ${bounds.totalContextChars} chars.`,
    '',
    ROUTING_JUDGEMENT_CONTRACT,
    '',
    'Project goal:',
    redactSensitiveText(contract.goal),
    'Project rules:',
    ...(contract.rules.length > 0 ? contract.rules.map((rule) => `- ${redactSensitiveText(rule)}`) : ['- (none)']),
    '',
    'Candidate Agents (Project responsibilities and collaboration instructions):',
    ...contract.candidates.flatMap((candidate) => [
      `- ${candidate.agentId}: responsibilities: ${candidate.responsibilities.length > 0 ? candidate.responsibilities.map(redactSensitiveText).join('; ') : '(none declared)'} | collaboration instructions: ${candidate.collaborationInstructions === '' ? '(none)' : redactSensitiveText(candidate.collaborationInstructions)}`,
    ]),
    '',
    'Open Tasks (curated public state, lead, and blocker summary; no Environment, lease, or run facts):',
    '- (no explicitly relevant Tasks)',
    '',
    'Privacy boundary — this context deliberately excludes: ' +
      ROUTING_CONTEXT_EXCLUSIONS.join('; ') +
      '.',
    '',
  ];
  return lines.join('\n');
}

/** The curated Task facts a contract presents, capped deterministically. */
export function curatedTasks(contract: RoutingContractFacts): readonly RoutingTaskFact[] {
  return (contract.tasks ?? []).slice(0, ROUTING_CONTEXT_TASK_CAP);
}

/**
 * Freeze one closed window into chronological, bounded batches.
 *
 * Pure and deterministic: the same window facts always produce the same
 * batches, excerpts, manifests, and context bytes — which is exactly what
 * makes the automatic retry a judgement of an *identical* snapshot.
 */
export function freezeRoutingBatches(
  input: FreezeRoutingBatchesInput,
): readonly FrozenRoutingBatchPlan[] {
  const bounds: RoutingBounds = { ...DEFAULT_ROUTING_BOUNDS, ...(input.bounds ?? {}) };
  const budget = bounds.totalContextChars;
  // Reserve room for at least one input and its identifiers. A tiny budget
  // clips shared narrative rather than silently increasing the declared bound.
  const rawPrefix = renderSharedPrefix(input.contract, input.window, bounds);
  const prefixCap = Math.max(0, budget - Math.min(375, Math.floor(budget * 0.9)));
  const sharedPrefix = rawPrefix.length <= prefixCap
    ? rawPrefix
    : rawPrefix.slice(0, Math.max(0, prefixCap - 24)) + '\n[shared facts truncated]';

  const excerpts = input.inputs.map((fact) =>
    truncateRoutingContent(redactSensitiveText(fact.content), Math.max(0, Math.min(
      bounds.inputContentChars,
      budget - sharedPrefix.length - inputHeader(fact, 0).length - 110,
    )), fact.content.length),
  );
  const blockSize = (index: number): number =>
    inputHeader(input.inputs[index]!, index).length + 2 + excerpts[index]!.excerpt.length + 2;

  // Chronological greedy packing: an input joins the open batch while it fits,
  // otherwise it opens the next one. An empty batch always accepts its first
  // input, so nothing durable is ever dropped.
  const groups: number[][] = [];
  let current: number[] = [];
  let currentSize = 0;
  for (let index = 0; index < input.inputs.length; index += 1) {
    const size = blockSize(index);
    if (current.length > 0 && sharedPrefix.length + currentSize + size + 105 > budget) {
      groups.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(index);
    currentSize += size;
  }
  if (current.length > 0) groups.push(current);

  const splitCount = groups.length;
  return groups.map((group, splitIndex) => {
    const batchId = input.createBatchId();
    const batchInputs: RoutingBatchInput[] = group.map((index, position) => {
      const fact = input.inputs[index]!;
      const excerpt = excerpts[index]!;
      return {
        batchId,
        inputId: fact.inputId,
        position,
        excerpt: excerpt.excerpt,
        truncated: excerpt.truncated,
        excerptChars: excerpt.excerpt.length,
        contentChars: excerpt.contentChars,
      };
    });

    // Thread ancestors first (bounded, deduplicated, never a batch input),
    // then recent shared channel context, both within the remaining bound.
    const batchInputIds = new Set(group.map((index) => input.inputs[index]!.inputId));
    const ancestors: RoutingContextMessage[] = [];
    const ancestorIds: string[] = [];
    const seen = new Set<string>(batchInputIds);
    let contextSize = sharedPrefix.length + group.reduce((sum, index) => sum + blockSize(index), 0);
    for (const index of group) {
      let parentId = input.inputs[index]!.inReplyTo;
      while (parentId !== undefined && !seen.has(parentId)) {
        const parent = input.messageById(parentId);
        if (parent === undefined) break;
        seen.add(parentId);
        const size = redactSensitiveText(parent.body).slice(0, bounds.contextMessageChars).length + 120;
        if (contextSize + size > budget) {
          parentId = undefined;
          break;
        }
        ancestors.push(parent);
        ancestorIds.push(parent.id);
        contextSize += size;
        parentId = parent.inReplyTo;
      }
    }

    const recent: RoutingContextMessage[] = [];
    const recentIds: string[] = [];
    const recentPool = [...input.recentContext]
      .reverse()
      .filter((message) => !seen.has(message.id))
      .slice(0, bounds.recentContextMessages)
      .reverse();
    for (const message of recentPool) {
      const size = redactSensitiveText(message.body).slice(0, bounds.contextMessageChars).length + 120;
      if (contextSize + size > budget) break;
      recent.push(message);
      recentIds.push(message.id);
      seen.add(message.id);
      contextSize += size;
    }

    const manifestInputs: RoutingManifestInput[] = group.map((index) => {
      const fact = input.inputs[index]!;
      const excerpt = excerpts[index]!;
      return {
        inputId: fact.inputId,
        kind: fact.kind,
        authorId: fact.authorId,
        createdAt: fact.createdAt,
        scopeId: fact.scopeId,
        candidates: [...fact.candidates],
        excerptChars: excerpt.excerpt.length,
        contentChars: excerpt.contentChars,
        truncated: excerpt.truncated,
      };
    });

    const sections: string[] = [sharedPrefix];
    sections.push(`--- Batch inputs (chronological, ${batchInputs.length})`);
    group.forEach((index, position) => {
      sections.push(inputHeader(input.inputs[index]!, position));
      sections.push(excerpts[index]!.excerpt);
      sections.push('');
    });
    if (ancestors.length > 0) {
      sections.push(`--- Thread ancestors of batch inputs (${ancestors.length})`);
      for (const ancestor of ancestors) {
        sections.push(
          `[ancestor | id=${ancestor.id} | author=${ancestor.authorId} | at=${ancestor.createdAt}]`,
        );
        sections.push(redactSensitiveText(ancestor.body).slice(0, bounds.contextMessageChars));
        sections.push('');
      }
    }
    if (recent.length > 0) {
      sections.push(`--- Recent Project-channel context, non-routing (${recent.length})`);
      for (const message of recent) {
        sections.push(
          `[channel | id=${message.id} | author=${message.authorKind}:${message.authorId} | at=${message.createdAt}]`,
        );
        sections.push(redactSensitiveText(message.body).slice(0, bounds.contextMessageChars));
        sections.push('');
      }
    }
    sections.push('Remember: your rationale is model judgement, not fact.');
    const context = sections.join('\n').slice(0, budget);

    const manifest: RoutingContextManifest = {
      projectId: input.contract.projectId,
      windowId: input.window.id,
      cutoffAt: input.window.deadlineAt,
      policy: 'wake-model-assisted',
      bounds,
      inputs: manifestInputs,
      candidates: input.contract.candidates.map((candidate) => ({
        agentId: candidate.agentId,
        responsibilities: candidate.responsibilities.map(redactSensitiveText),
        collaborationInstructions: redactSensitiveText(candidate.collaborationInstructions),
      })),
      tasks: [],
      recentContextIds: recentIds,
      ancestorContextIds: ancestorIds,
      exclusions: [...ROUTING_CONTEXT_EXCLUSIONS],
      contextChars: context.length,
    };

    return {
      batchId,
      splitIndex,
      splitCount,
      cutoffAt: input.window.deadlineAt,
      bounds,
      manifest,
      context,
      inputs: batchInputs,
    };
  });
}
