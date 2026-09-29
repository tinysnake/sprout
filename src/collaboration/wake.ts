/**
 * The deterministic wake contract (ADR-0007, #96; settled by the #25 prototype).
 *
 * Given one durable input — a Message in one of the three conversation scopes,
 * or a system-produced Project event — decide who is woken and why. The plan
 * is pure and deterministic: **it never consults a wake model**. That is the
 * M2 sharpening of the proven M1 path:
 *
 * - A Project-scoped direct Message, an exact whole-token `@id` mention, an
 *   exact `@all` broadcast, and an `addressed` Project event wake their
 *   recipients immediately and never consult the Project's wake policy or
 *   model (ADR-0007 "Deterministic addressing"). Determinism is what prevents
 *   the one silent failure mode: an addressed Agent that was never woken
 *   leaves no reply and no run record.
 * - An input with no deterministic address records a durable `suppressed`
 *   observation and stays available: wake-model-assisted judgement of
 *   unaddressed inputs arrives with routing batches (#97), and until then no
 *   model is asked and no member is woken by guesswork. The M1 fail-open
 *   behaviour (wake everyone when the model fails) is a rejected ADR-0007
 *   alternative and no longer exists here.
 * - Recipients are **current Project Agents**. The author (or the event's
 *   producer) is never woken by its own input, targets are deduplicated per
 *   input and Agent across every addressing form, and a target that is unknown
 *   or no longer a Project member produces a durable per-target failure while
 *   every valid target continues. A Human member is a known non-wakeable
 *   target, not a failure: Humans are not woken by wake requests.
 * - A direct conversation additionally resolves against its scope's
 *   participants: a target outside the pair cannot be woken with that
 *   conversation's content.
 */

import type { ProjectEvent } from './events.ts';
import type {
  Message,
  WakeDecision,
  WakeObservation,
  WakePlan,
} from './model.ts';

/** `@all` is a broadcast; it is matched as a whole token, not as a prefix. */
const ALL_MENTION = /(?<![\w@])@all(?![\w-])/i;

/** One Project member as routing resolves targets against it. */
export interface WakeMember {
  readonly memberId: string;
  readonly memberKind: 'human' | 'agent';
  readonly endedAt?: number;
}

/** The conversation-scope facts the plan resolves a Message's targets in. */
export interface WakeScopeFacts {
  /** The scope kind the Message was posted to. */
  readonly kind: 'project' | 'direct' | 'working-group';
  /** The canonical participant pair; present only for a direct scope. */
  readonly participants?: readonly [string, string];
}

export interface WakePlanInput {
  /** Current and ended Project member facts; one authority for "member". */
  readonly members: readonly WakeMember[];
  /** The scope the Message belongs to. */
  readonly scope: WakeScopeFacts;
}

/**
 * Exact agent mentions in a Message body.
 *
 * An agent id is matched as a whole `@id` token, so `@scout` does not match
 * `@scout-two`, matching the same token rule `@all` uses. The member set is
 * the authority on which ids are real, so a mention of a non-member (or of a
 * membership that has ended) is reported rather than guessed at.
 */
export function parseMentions(
  body: string,
  memberIds: readonly string[],
): { readonly members: readonly string[]; readonly unknown: readonly string[] } {
  const members = new Set(memberIds);
  const mentionedMembers = new Set<string>();
  const unknownMentions = new Set<string>();
  const tokens = /(?<![\w@])@([a-zA-Z0-9_-]+)(?![\w-])/g;

  for (const match of body.matchAll(tokens)) {
    const agentId = match[1]!;
    if (members.has(agentId)) mentionedMembers.add(agentId);
    else unknownMentions.add(agentId);
  }
  return { members: [...mentionedMembers], unknown: [...unknownMentions] };
}

/** @deprecated Use `parseMentions` when unknown addressed targets matter. */
export function parseAgentMentions(body: string, memberIds: readonly string[]): readonly string[] {
  return parseMentions(body, memberIds).members;
}

/**
 * Apply the deterministic wake contract to one Message.
 *
 * Returns the addresses to wake plus the durable non-wake outcomes. The plan
 * never consults a model and never needs to: every branch is decided from the
 * input, its scope, and the Project's member facts.
 */
export function planWake(message: Message, input: WakePlanInput): WakePlan {
  const resolver = new TargetResolver(message.projectId, message.author.id, input.members);
  const decisions: WakeDecision[] = [];
  const observations: WakeObservation[] = [];

  if (input.scope.kind === 'direct') {
    const participants: readonly string[] = input.scope.participants ?? [];
    const targets =
      message.recipients.length > 0
        ? message.recipients
        : participants.filter((memberId) => memberId !== message.author.id);
    for (const target of dedupe(targets)) {
      if (!participants.includes(target)) {
        observations.push({
          agentId: target,
          status: 'failed',
          reason: 'direct-recipient',
          detail: 'addressed target is not a participant of this direct conversation',
        });
        continue;
      }
      resolver.resolve(target, 'direct-recipient', decisions, observations);
    }
    return { inputId: message.id, decisions, observations };
  }

  // The Project and Working group channels. A broadcast or an exact mention is
  // deterministic and never reaches any model.
  if (ALL_MENTION.test(message.body)) {
    for (const agentId of resolver.currentAgentIds) {
      if (agentId === message.author.id) continue;
      decisions.push({ agentId, reason: 'broadcast' });
    }
    return { inputId: message.id, decisions, observations };
  }

  const mentioned = parseMentions(message.body, resolver.currentMemberIds);
  if (mentioned.members.length > 0 || mentioned.unknown.length > 0) {
    for (const target of dedupe([...mentioned.members, ...mentioned.unknown])) {
      resolver.resolve(target, 'agent-mention', decisions, observations);
    }
    return { inputId: message.id, decisions, observations };
  }

  // No deterministic address: durable and visible, never silent and never
  // guessed at. Wake-model-assisted judgement of this input is #97's batch
  // path, gated by the Project's wake policy.
  observations.push({
    agentId: '*',
    status: 'suppressed',
    reason: 'unaddressed',
    detail:
      'no deterministic address on this input; it remains durable under the Project wake policy',
  });
  return { inputId: message.id, decisions, observations };
}

/**
 * Apply the deterministic wake contract to one Project event.
 *
 * Only an `addressed` event routes; every other disposition persists without
 * wake decisions (the disposition itself is the durable evidence). The
 * responsible Agent targets are resolved against current Project membership
 * exactly like Message targets: deduplicated, producer-excluded, and failing
 * durably per target without blocking the valid ones.
 */
export function planEventWake(event: ProjectEvent, input: { members: readonly WakeMember[] }): WakePlan {
  const resolver = new TargetResolver(event.projectId, event.producer.id, input.members);
  const decisions: WakeDecision[] = [];
  const observations: WakeObservation[] = [];
  if (event.disposition !== 'addressed') {
    return { inputId: event.id, decisions, observations };
  }
  for (const target of dedupe(event.responsibleAgentIds)) {
    resolver.resolve(target, 'event-addressed', decisions, observations);
  }
  return { inputId: event.id, decisions, observations };
}

/** Order-preserving dedupe of routing targets. */
function dedupe(targets: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const target of targets) {
    if (target === '' || seen.has(target)) continue;
    seen.add(target);
    unique.push(target);
  }
  return unique;
}

/**
 * Resolves one input's targets against the Project's current membership.
 *
 * The classification is exactly three-way, so no target can vanish silently:
 * a current Agent wakes, a current Human member is a known non-wakeable
 * target, and anything else is a durable failure.
 */
class TargetResolver {
  readonly currentAgentIds: readonly string[];
  readonly currentMemberIds: readonly string[];
  readonly #members: readonly WakeMember[];
  readonly #projectId: string;
  readonly #excludedId: string;
  readonly #seen = new Set<string>();

  constructor(projectId: string, excludedId: string, members: readonly WakeMember[]) {
    this.#projectId = projectId;
    this.#excludedId = excludedId;
    this.#members = members;
    this.currentAgentIds = members
      .filter((member) => member.memberKind === 'agent' && member.endedAt === undefined)
      .map((member) => member.memberId);
    this.currentMemberIds = members
      .filter((member) => member.endedAt === undefined)
      .map((member) => member.memberId);
  }

  resolve(
    target: string,
    reason: WakeDecision['reason'],
    decisions: WakeDecision[],
    observations: WakeObservation[],
  ): void {
    if (target === this.#excludedId || this.#seen.has(target)) return;
    this.#seen.add(target);
    if (this.currentAgentIds.includes(target)) {
      decisions.push({ agentId: target, reason });
      return;
    }
    if (this.currentMemberIds.includes(target)) {
      // A current Human member belongs to the Project but is never a wake
      // target: wake requests admit Agent runs, and Human attention is not
      // model- or wake-granted authority.
      return;
    }
    const ended = this.#members.some(
      (member) => member.memberId === target && member.endedAt !== undefined,
    );
    observations.push({
      agentId: target,
      status: 'failed',
      reason,
      detail: ended
        ? `addressed target's membership in project ${this.#projectId} has ended`
        : `addressed target is not a member of project ${this.#projectId}`,
    });
  }
}
