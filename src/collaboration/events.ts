/**
 * Project events and their required routing disposition (ADR-0007, #96).
 *
 * `CONTEXT.md` defines a **Project event** as "a durable system-produced fact
 * exposed in a Project, with an explicit routing disposition that determines
 * whether it has a responsible Agent, may be judged by a wake model, remains
 * informational, or requires Human action", and a **Routing disposition** as
 * "the declared treatment of a Project event: addressed, wake-eligible,
 * informational, human-action-required, or non-routing. Only addressed events
 * route deterministically and only wake-eligible events may enter wake-model
 * routing."
 *
 * Publication therefore never accepts an implicit disposition: a missing or
 * unknown value is a refusal, not a default. `addressed` additionally names
 * its responsible Agent targets at publication time, so an addressed event
 * can never exist without the targets its deterministic routing needs.
 *
 * A Project event is not a Message: it is system-produced, it is not bound to
 * a conversation scope (it is exposed in the Project as a whole), and its
 * producer marker is attribution rather than authorship of conversation.
 *
 * Privacy: no field here may carry a credential, provider/account identity,
 * hostname, address, absolute path, or raw command. Free text passes the
 * shared privacy boundary before it becomes durable.
 */

import { redactProjectText, sanitizeIdentifier } from '../environment/privacy.ts';

/**
 * Who produced one Project event.
 *
 * Unlike a Message's author, an event's producer may be the system itself:
 * `system` covers facts Sprout records on its own (run lifecycle, routing,
 * recovery), while `human` and `agent` attribute a fact to the member whose
 * action caused it. The producer is attribution for routing exclusion and
 * evidence — never conversation authorship.
 */
export type ProjectEventProducerKind = 'system' | 'human' | 'agent';

export interface ProjectEventProducer {
  readonly id: string;
  readonly kind: ProjectEventProducerKind;
}

/**
 * The declared treatment of one Project event (ADR-0007).
 *
 * - `addressed` names a responsible Agent and routes deterministically;
 * - `wake-eligible` may enter a routing batch (#97);
 * - `informational` remains durable without waking an Agent;
 * - `human-action-required` remains durable for Human attention and cannot
 *   delegate that authority to an Agent; and
 * - `non-routing` may be useful as later shared context but cannot initiate
 *   routing.
 */
export type RoutingDisposition =
  | 'addressed'
  | 'wake-eligible'
  | 'informational'
  | 'human-action-required'
  | 'non-routing';

/** Every valid disposition, in the order `CONTEXT.md` declares them. */
export const ROUTING_DISPOSITIONS: readonly RoutingDisposition[] = [
  'addressed',
  'wake-eligible',
  'informational',
  'human-action-required',
  'non-routing',
];

/**
 * One durable system-produced Project fact.
 *
 * `deliveryKey` gives publication the same idempotent-retry identity a
 * Message has: a producer that retries after a lost acknowledgement reuses
 * one durable event instead of appending a second copy.
 */
export interface ProjectEvent {
  readonly id: string;
  readonly projectId: string;
  /** The producer-declared stable event kind (for example `task-blocker`). */
  readonly kind: string;
  /** The sanitized one-line fact this event records. */
  readonly summary: string;
  /** Optional sanitized elaboration; never a credential or host fact. */
  readonly detail?: string;
  /** Who produced the fact: the system, or the member whose action caused it. */
  readonly producer: ProjectEventProducer;
  /** Read projection from durable run → wake → Message links; not routing targets. */
  readonly originScopeIds?: readonly string[];
  /** Exact Task-group Message a system fact came from, when one exists. */
  readonly originMessageId?: string;
  /** The declared routing disposition; publication requires exactly one. */
  readonly disposition: RoutingDisposition;
  /** The responsible Agent ids; non-empty only when `disposition` is `addressed`. */
  readonly responsibleAgentIds: readonly string[];
  /** Idempotency key: repeated publication of the key yields one event. */
  readonly deliveryKey: string;
  readonly createdAt: number;
}

export type ProjectEventErrorCode =
  | 'disposition-required'
  | 'invalid-disposition'
  | 'invalid-event'
  | 'addressed-requires-target'
  | 'unknown-project';

export class ProjectEventError extends Error {
  readonly code: ProjectEventErrorCode;

  constructor(code: ProjectEventErrorCode, message: string) {
    super(message);
    this.name = 'ProjectEventError';
    this.code = code;
  }
}

const MAX_KIND = 64;
const MAX_TEXT = 4_000;

/**
 * Parse an untrusted disposition candidate.
 *
 * Returns `undefined` for a missing or unknown value; there is deliberately no
 * default disposition, because an implicit routing treatment is exactly what
 * ADR-0007 forbids.
 */
export function parseRoutingDisposition(value: unknown): RoutingDisposition | undefined {
  return typeof value === 'string' && (ROUTING_DISPOSITIONS as readonly string[]).includes(value)
    ? (value as RoutingDisposition)
    : undefined;
}

/**
 * Validate a disposition on one publication, refusing a missing or unknown one.
 *
 * `addressed` must also carry at least one responsible Agent: an addressed
 * event that names nobody would publish a durable fact whose deterministic
 * routing could never run.
 */
export function requireRoutingDisposition(input: {
  readonly disposition: unknown;
  readonly responsibleAgentIds?: readonly string[] | undefined;
}): RoutingDisposition {
  const disposition = parseRoutingDisposition(input.disposition);
  if (input.disposition === undefined || input.disposition === null || input.disposition === '') {
    throw new ProjectEventError(
      'disposition-required',
      'publishing a Project event requires one routing disposition',
    );
  }
  if (disposition === undefined) {
    throw new ProjectEventError(
      'invalid-disposition',
      `unknown routing disposition: ${String(input.disposition)}`,
    );
  }
  if (disposition === 'addressed' && (input.responsibleAgentIds ?? []).filter(isUsableTarget).length === 0) {
    throw new ProjectEventError(
      'addressed-requires-target',
      'an addressed Project event requires at least one responsible Agent',
    );
  }
  return disposition;
}

function isUsableTarget(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Validate safe conversation origins before they become durable routing evidence. */
export function sanitizeEventOrigins(values: readonly string[] | undefined): readonly string[] {
  const unique: string[] = [];
  for (const value of values ?? []) {
    if (!isSafeEventOrigin(value)) {
      throw new ProjectEventError('invalid-event', 'a Project event has an unsafe conversation scope identity');
    }
    if (!unique.includes(value)) unique.push(value);
  }
  return unique;
}

/** Validate an exact Message origin and require it to name one owning scope. */
export function sanitizeEventMessageOrigin(
  value: string | undefined,
  scopeIds: readonly string[],
): string | undefined {
  if (value === undefined) return undefined;
  if (!isSafeEventOrigin(value) || scopeIds.length !== 1) {
    throw new ProjectEventError('invalid-event', 'a Project event Message origin requires one safe conversation scope');
  }
  return value;
}

function isSafeEventOrigin(value: string): boolean {
  return /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,159}$/.test(value) && value !== '.' && value !== '..';
}

/** The sanitized event kind, or an error when nothing usable remains. */
export function sanitizeProjectEventKind(value: string | undefined): string {
  const kind = sanitizeIdentifier(value ?? '', { fallback: '', kind: 'generic', maxLength: MAX_KIND });
  if (kind === '') {
    throw new ProjectEventError('invalid-event', 'a Project event requires a stable kind');
  }
  return kind;
}

/** The sanitized event summary: free text through the shared privacy boundary. */
export function sanitizeProjectEventSummary(value: string | undefined): string {
  const text = redactProjectText((value ?? '').trim());
  if (text === '') {
    throw new ProjectEventError('invalid-event', 'a Project event requires a summary');
  }
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1).trimEnd()}\u2026`;
}

/** The sanitized optional event detail; an empty value stays absent. */
export function sanitizeProjectEventDetail(value: string | undefined): string | undefined {
  const text = redactProjectText((value ?? '').trim());
  if (text === '') return undefined;
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1).trimEnd()}\u2026`;
}

/** The sanitized responsible-Agent targets, deduplicated and order-preserving. */
export function sanitizeResponsibleAgents(
  values: readonly string[] | undefined,
): readonly string[] {
  const unique: string[] = [];
  for (const value of values ?? []) {
    if (!isUsableTarget(value)) continue;
    const target = value.trim();
    if (!unique.includes(target)) unique.push(target);
  }
  return unique;
}
