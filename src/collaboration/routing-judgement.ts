/**
 * The wake-model judgement contract and its validator (#97, ADR-0007).
 *
 * One frozen batch produces exactly one model call, and the model's answer is
 * **fully accounted or invalid**: every batch input must appear as selected
 * (by one or more eligible Agents) or suppressed, and no answer may name an
 * input outside the batch or an Agent outside that input's eligible candidates.
 * A plausible-looking subset is never salvaged — accepting one would make an
 * omitted input indistinguishable from a model decision.
 *
 * The validator is pure and runs over the *frozen* manifest of the batch, so
 * the automatic retry validates against the identical snapshot, and a second
 * failure fails closed with one durable outcome per input.
 */

import { redactSensitiveText } from '../environment/privacy.ts';
import type { RoutingAssignment, RoutingFailureKind } from './routing.ts';

/**
 * The self-describing contract embedded in every routing context.
 *
 * It is part of the frozen snapshot, so a retry repeats it byte-identically
 * and the evidence reader sees exactly what the model was asked to return.
 */
export const ROUTING_JUDGEMENT_CONTRACT = [
  'Judgement contract: respond with ONLY a JSON object of the form',
  '{"selections":[{"agentId":"<agent>","inputIds":["<input-id>", ...],"rationale":"<concise reason>"}],"suppressions":[{"inputId":"<input-id>","rationale":"<concise reason>"}]}.',
  'Every batch input id must be accounted for exactly once: either listed in the inputIds of at least one selection, or present as exactly one suppression.',
  'A selection may only name candidate Agents eligible for each listed input; the rationale is concise model judgement, not fact.',
  'Select zero Agents when no candidate should act — that is deliberate suppression, not failure.',
].join('\n');

/** One parsed, fully validated judgement: the per-input assignments to persist. */
export interface RoutingJudgement {
  /** Per selected input, its Agent assignments (deduplicated, input order). */
  readonly selections: readonly {
    readonly inputId: string;
    readonly assignments: readonly RoutingAssignment[];
  }[];
  /** Per suppressed input, the model's rationale. */
  readonly suppressions: readonly { readonly inputId: string; readonly rationale: string }[];
}

/** The frozen facts a judgement is validated against. */
export interface JudgementExpectation {
  readonly inputIds: readonly string[];
  /** Eligible Agent ids per input id (the frozen candidate gate). */
  readonly candidatesByInput: ReadonlyMap<string, readonly string[]>;
}

export type JudgementParseResult =
  | { readonly ok: true; readonly judgement: RoutingJudgement }
  | { readonly ok: false; readonly kind: RoutingFailureKind; readonly detail: string };

const MAX_DETAIL = 400;

/**
 * Parse and fully validate one raw model answer against one frozen batch.
 *
 * Failure kinds are the durable evidence of *why* an attempt was invalid:
 * malformed (not a judgement at all), incomplete (an input was omitted),
 * unknown-agent / unknown-input (names outside the frozen snapshot), and
 * invalid-output (ambiguous or contradictory accounting).
 */
export function parseRoutingJudgement(
  raw: string,
  expected: JudgementExpectation,
): JudgementParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      kind: 'malformed-output',
      // Validation evidence only: the parser's own bounded message, never the
      // raw answer (ADR-0007: "validation errors, without raw private
      // reasoning").
      detail: `model output is not valid JSON: ${
        (error instanceof Error ? error.message : String(error)).slice(0, 200)
      }`.slice(0, MAX_DETAIL),
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, kind: 'malformed-output', detail: 'model output is not a JSON object' };
  }
  const object = parsed as Record<string, unknown>;
  const selections = object.selections;
  const suppressions = object.suppressions ?? [];
  if (!Array.isArray(selections)) {
    return { ok: false, kind: 'malformed-output', detail: 'selections must be an array' };
  }
  if (!Array.isArray(suppressions)) {
    return { ok: false, kind: 'malformed-output', detail: 'suppressions must be an array' };
  }

  const inputSet = new Set(expected.inputIds);
  const selectedByInput = new Map<string, RoutingAssignment[]>();
  const suppressedByInput = new Map<string, string>();

  for (const entry of selections) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, kind: 'malformed-output', detail: 'a selection is not an object' };
    }
    const { agentId, inputIds, rationale } = entry as Record<string, unknown>;
    if (typeof agentId !== 'string' || agentId === '') {
      return { ok: false, kind: 'malformed-output', detail: 'a selection is missing its agentId' };
    }
    if (!Array.isArray(inputIds) || inputIds.length === 0 || !inputIds.every((id) => typeof id === 'string' && id !== '')) {
      return { ok: false, kind: 'malformed-output', detail: `selection for ${agentId} has no input ids` };
    }
    if (rationale !== undefined && typeof rationale !== 'string') {
      return { ok: false, kind: 'malformed-output', detail: `selection rationale for ${agentId} is not text` };
    }
    for (const inputId of inputIds as readonly string[]) {
      if (!inputSet.has(inputId)) {
        return { ok: false, kind: 'unknown-input', detail: `selection names unknown input ${inputId}` };
      }
      const candidates = expected.candidatesByInput.get(inputId);
      if (candidates === undefined || !candidates.includes(agentId)) {
        return { ok: false, kind: 'unknown-agent', detail: `selection names ${agentId}, which is not a candidate for ${inputId}` };
      }
      const assignments = selectedByInput.get(inputId) ?? [];
      const existing = assignments.find((assignment) => assignment.agentId === agentId);
      if (existing === undefined) {
        assignments.push({ agentId, rationale: redactSensitiveText(String(rationale ?? '')).slice(0, MAX_DETAIL) });
      }
      selectedByInput.set(inputId, assignments);
    }
  }

  for (const entry of suppressions) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, kind: 'malformed-output', detail: 'a suppression is not an object' };
    }
    const { inputId, rationale } = entry as Record<string, unknown>;
    if (typeof inputId !== 'string' || inputId === '') {
      return { ok: false, kind: 'malformed-output', detail: 'a suppression is missing its inputId' };
    }
    if (rationale !== undefined && typeof rationale !== 'string') {
      return { ok: false, kind: 'malformed-output', detail: `suppression rationale for ${inputId} is not text` };
    }
    if (!inputSet.has(inputId)) {
      return { ok: false, kind: 'unknown-input', detail: `suppression names unknown input ${inputId}` };
    }
    if (selectedByInput.has(inputId)) {
      return { ok: false, kind: 'invalid-output', detail: `input ${inputId} is both selected and suppressed` };
    }
    if (suppressedByInput.has(inputId)) {
      return { ok: false, kind: 'invalid-output', detail: `input ${inputId} is suppressed more than once` };
    }
    suppressedByInput.set(inputId, redactSensitiveText(String(rationale ?? '')).slice(0, MAX_DETAIL));
  }

  const omitted = expected.inputIds.filter(
    (inputId) => !selectedByInput.has(inputId) && !suppressedByInput.has(inputId),
  );
  if (omitted.length > 0) {
    return { ok: false, kind: 'incomplete-output', detail: `judgement omitted input(s): ${omitted.join(', ')}` };
  }

  return {
    ok: true,
    judgement: {
      selections: expected.inputIds
        .filter((inputId) => selectedByInput.has(inputId))
        .map((inputId) => ({ inputId, assignments: selectedByInput.get(inputId)! })),
      suppressions: expected.inputIds
        .filter((inputId) => suppressedByInput.has(inputId))
        .map((inputId) => ({ inputId, rationale: suppressedByInput.get(inputId)! })),
    },
  };
}
