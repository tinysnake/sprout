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
 * - An input with no deterministic address stays durable and visible: under
 *   the Project's `wake-model-assisted` policy it is marked batch-eligible and
 *   collected into the Project's fixed routing window, where a wake model
 *   judges the frozen batch (#97); under `explicit-only` (the default) it
 *   records a durable `suppressed` observation and no model is asked and no
 *   member is woken by guesswork. The M1 fail-open behaviour (wake everyone
 *   when the model fails) is a rejected ADR-0007 alternative and no longer
 *   exists here.
 * - Recipients are **current Project Agents**. The author (or the event's
 *   producer) is never woken by its own input, targets are deduplicated per
 *   input and Agent across every addressing form, and a target that is unknown
 *   or no longer a Project member produces a durable per-target failure while
 *   every valid target continues. A Human member is a known non-wakeable
 *   target, not a failure: Humans are not woken by wake requests.
 * - A direct conversation and a Working group channel additionally resolve
 *   against their scope's **current participants** — the pair, or the group's
 *   active participations. A target outside them is an invalid target for that
 *   scope and produces a durable per-target failure while valid participants
 *   still wake, and a broadcast reaches only the scope's participant Agents:
 *   content stays inside the scope that carries it (ADR-0008). The Project
 *   channel has no narrower participant set — its participants are every
 *   current Project member.
 */

import type { ProjectEvent } from './events.ts';
import type {
  Message,
  WakeDecision,
  WakeObservation,
  WakePlan,
} from './model.ts';
import type { WakePolicy } from '../project/authority-model.ts';

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
  /**
   * The scope's current participants: the canonical pair for a direct
   * conversation, the active participations for a Working group. Absent for
   * the Project channel, whose participants are every current Project member.
   * A participant-scoped kind that names no participants fails closed —
   * missing facts never widen a fan-out.
   */
  readonly participants?: readonly string[];
}

export interface WakePlanInput {
  /** Current and ended Project member facts; one authority for "member". */
  readonly members: readonly WakeMember[];
  /** The scope the Message belongs to. */
  readonly scope: WakeScopeFacts;
  /**
   * The Project's wake policy in force for this input (#97). Defaults to
   * `explicit-only`, the migration and configuration default: an unaddressed
   * input then records its durable suppressed observation. Under
   * `wake-model-assisted` the same input instead becomes batch-eligible — no
   * observation and no model call happen here; the window path owns them.
   */
  readonly wakePolicy?: WakePolicy;
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
 * input, its scope (including its current participants), and the Project's
 * member facts.
 */
export function planWake(message: Message, input: WakePlanInput): WakePlan {
  const scope = input.scope;
  // Only the Project channel resolves over the whole Project. The direct pair
  // and the Working group's participants gate every target; if a scoped kind
  // arrives without a participant set, the gate is the empty set (fail
  // closed — missing facts never widen a fan-out).
  const participants = scope.kind === 'project' ? undefined : (scope.participants ?? []);
  const resolver = new TargetResolver({
    projectId: message.projectId,
    excludedId: message.author.id,
    members: input.members,
    ...(participants !== undefined
      ? {
          participants,
          scopeLabel: scope.kind === 'direct' ? 'direct conversation' : 'working group',
        }
      : {}),
  });
  const decisions: WakeDecision[] = [];
  const observations: WakeObservation[] = [];

  if (scope.kind === 'direct') {
    const pair: readonly string[] = participants ?? [];
    const targets =
      message.recipients.length > 0
        ? message.recipients
        : pair.filter((memberId) => memberId !== message.author.id);
    for (const target of dedupe(targets)) {
      resolver.resolve(target, 'direct-recipient', decisions, observations);
    }
    return { inputId: message.id, decisions, observations };
  }

  // Broadcast and explicit mentions are independent addresses on the same
  // input. Broadcast excludes nonparticipants silently, but an explicitly
  // named nonparticipant must still receive a durable failure. Neither form
  // reaches a model.
  const broadcast = ALL_MENTION.test(message.body);
  if (broadcast) {
    for (const agentId of resolver.currentAgentIds) {
      if (agentId === message.author.id) continue;
      if (!resolver.isParticipant(agentId)) continue;
      decisions.push({ agentId, reason: 'broadcast' });
    }
  }

  const mentioned = parseMentions(message.body, resolver.currentMemberIds);
  const targets = dedupe([...mentioned.members, ...mentioned.unknown])
    .filter((target) => !(broadcast && target.toLowerCase() === 'all'));
  if (broadcast || targets.length > 0) {
    for (const target of targets) {
      if (decisions.some((decision) => decision.agentId === target)) continue;
      resolver.resolve(target, 'agent-mention', decisions, observations);
    }
    return { inputId: message.id, decisions, observations };
  }

  // No deterministic address: durable and visible, never silent and never
  // guessed at. Under `wake-model-assisted` the input is eligible for the
  // Project's next routing batch (#97) — no suppressed observation here,
  // because a batch outcome (selected, suppressed, or failed) will be its
  // durable, richer evidence. Under `explicit-only` it stays durable with the
  // suppressed observation and no model is ever asked.
  if (input.wakePolicy === 'wake-model-assisted') {
    return { inputId: message.id, decisions, observations, batchEligible: true };
  }
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
export function planEventWake(
  event: ProjectEvent,
  input: { members: readonly WakeMember[]; wakePolicy?: WakePolicy },
): WakePlan {
  const resolver = new TargetResolver({
    projectId: event.projectId,
    excludedId: event.producer.id,
    members: input.members,
  });
  const decisions: WakeDecision[] = [];
  const observations: WakeObservation[] = [];
  if (event.disposition !== 'addressed') {
    // A `wake-eligible` event under wake-model-assisted routing joins the
    // Project's next routing batch (#97); every other disposition persists as
    // its own durable evidence with no wake and no eligibility. The field is
    // present only when the input actually joins a window, exactly as on the
    // Message path, so callers read one meaning: absent means "not collected".
    if (event.disposition === 'wake-eligible' && input.wakePolicy === 'wake-model-assisted') {
      return { inputId: event.id, decisions, observations, batchEligible: true };
    }
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

/** The resolver's scope facts: Project membership plus, optionally, one
 * participant-scoped conversation's current participants. */
interface TargetResolverOptions {
  readonly projectId: string;
  readonly excludedId: string;
  readonly members: readonly WakeMember[];
  /**
   * The Message scope's current participants. Absent means the Project
   * channel, whose participants are every current Project member.
   */
  readonly participants?: readonly string[];
  /** The scope label a participant failure names (direct conversation / working group). */
  readonly scopeLabel?: string;
}

/**
 * Resolves one input's targets against the scope's current participants and,
 * beneath that, the Project's current membership.
 *
 * The scope gate comes first: a target outside the conversation's current
 * participants can never be woken with that scope's content, whatever its
 * Project membership. The membership classification beneath it is exactly
 * three-way, so no target can vanish silently: a current Agent wakes, a
 * current Human member is a known non-wakeable target, and anything else —
 * unknown or ended — is a durable failure.
 */
class TargetResolver {
  readonly currentAgentIds: readonly string[];
  readonly currentMemberIds: readonly string[];
  readonly #members: readonly WakeMember[];
  readonly #projectId: string;
  readonly #excludedId: string;
  readonly #participants: readonly string[] | undefined;
  readonly #scopeLabel: string;
  readonly #seen = new Set<string>();

  constructor(options: TargetResolverOptions) {
    this.#projectId = options.projectId;
    this.#excludedId = options.excludedId;
    this.#members = options.members;
    this.#participants = options.participants;
    this.#scopeLabel = options.scopeLabel ?? 'conversation scope';
    this.currentAgentIds = options.members
      .filter((member) => member.memberKind === 'agent' && member.endedAt === undefined)
      .map((member) => member.memberId);
    this.currentMemberIds = options.members
      .filter((member) => member.endedAt === undefined)
      .map((member) => member.memberId);
  }

  /** Whether the member belongs to the scope this input was posted to. */
  isParticipant(memberId: string): boolean {
    return this.#participants === undefined || this.#participants.includes(memberId);
  }

  resolve(
    target: string,
    reason: WakeDecision['reason'],
    decisions: WakeDecision[],
    observations: WakeObservation[],
  ): void {
    if (target === this.#excludedId || this.#seen.has(target)) return;
    this.#seen.add(target);
    if (!this.isParticipant(target)) {
      // A target outside this conversation's participants is an invalid
      // target for the scope: its content never wakes them, and the refusal
      // is durable beside the valid wakes. The Project channel has no
      // narrower participant set, so this gate only bites for direct and
      // Working-group scopes.
      observations.push({
        agentId: target,
        status: 'failed',
        reason,
        detail: `addressed target is not a participant of this ${this.#scopeLabel}`,
      });
      return;
    }
    if (this.currentAgentIds.includes(target)) {
      decisions.push({ agentId: target, reason });
      return;
    }
    if (this.currentMemberIds.includes(target)) {
      // A current Human member of the scope is a known non-wakeable target,
      // not a failure: wake requests admit Agent runs, and Human attention is
      // not model- or wake-granted authority.
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
