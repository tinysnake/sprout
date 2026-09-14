/**
 * The M1 wake contract (prototype for ticket #25).
 *
 * Given one durable Message and the project's members, decide who is woken and
 * why. The decision is pure and deterministic except for the single
 * unaddressed-project-channel case, which consults the low-cost wake model.
 *
 * The governing rule is **prefer an observable extra wake over silently losing
 * addressed work**. Consequences that follow from it:
 *
 * - An addressed Message (direct recipient, exact `@id` mention, or `@all`
 *   broadcast) never reaches the wake model at all. Determinism is what prevents
 *   the one silent failure mode: an addressed agent that was never woken leaves
 *   no reply and no run record.
 * - The wake model only ever decides *whether* an unaddressed project Message
 *   engages the room. It never picks recipients, and it never sees an addressed
 *   Message.
 * - When the wake model cannot be constructed, throws, or returns something
 *   unusable, the contract **fails open**: it records a
 *   `wake-model-fail-open` decision for every other member rather than dropping
 *   the Message.
 * - A refusal is recorded as an explicit, durable `suppressed` observation, not
 *   as silence. It is only ever reachable for an unaddressed Message.
 */

import type {
  CollaborationMessage,
  WakeDecision,
  WakeModel,
  WakeObservation,
  WakePlan,
} from './model.ts';
import { ProjectRegistry } from '../project/registry.ts';

/** `@all` is a broadcast; it is matched as a whole token, not as a prefix. */
const ALL_MENTION = /(?<![\w@])@all(?![\w-])/i;

/**
 * Exact agent mentions on the project channel.
 *
 * An agent id is matched as a whole `@id` token, so `@scout` does not match
 * `@scout-two`, matching the same token rule Cumora uses for `@all` and for its
 * reply coordination. The member set is the authority on which ids are real, so
 * a mention of a non-member is reported rather than guessed at.
 */
export function parseAgentMentions(body: string, memberIds: readonly string[]): readonly string[] {
  const found = new Set<string>();
  for (const id of memberIds) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const token = new RegExp(`(?<![\\w@])@${escaped}(?![\\w-])`);
    if (token.test(body)) found.add(id);
  }
  return [...found];
}

export interface WakeContractOptions {
  readonly projects: ProjectRegistry;
  /**
   * The low-cost wake model. Optional: with none configured, an unaddressed
   * project Message fails open exactly as it would when the model itself fails,
   * because "no model" and "model broken" are the same product situation —
   * nobody is confidently judging, so nobody may silently drop the Message.
   */
  readonly wakeModel?: WakeModel;
}

/**
 * Apply the M1 wake contract to one Message.
 *
 * Returns the addresses to wake plus the durable non-wake outcomes. The author
 * is never woken by its own Message, and every other member is a candidate.
 */
export async function planWake(
  message: CollaborationMessage,
  options: WakeContractOptions,
): Promise<WakePlan> {
  const project = options.projects.get(message.projectId);
  if (!project) {
    return {
      messageId: message.id,
      decisions: [],
      observations: [
        {
          agentId: '*',
          status: 'failed',
          reason: 'direct-recipient',
          detail: `unknown project: ${message.projectId}`,
        },
      ],
    };
  }
  const memberIds = project.memberships.map((membership) => membership.agentId);

  if (message.channel === 'direct') {
    const resolved = resolveDirect(message, memberIds);
    return {
      messageId: message.id,
      decisions: resolved.decisions,
      observations: resolved.observations,
    };
  }

  // The project channel. A broadcast or an exact mention is deterministic and
  // never reaches the wake model.
  if (ALL_MENTION.test(message.body)) {
    return {
      messageId: message.id,
      decisions: others(message, memberIds).map((agentId) => ({
        agentId,
        reason: 'broadcast' as const,
      })),
      observations: [],
    };
  }

  const mentioned = parseAgentMentions(message.body, memberIds);
  if (mentioned.length > 0) {
    const { decisions, observations } = resolveTargets(message, memberIds, mentioned, 'agent-mention');
    return { messageId: message.id, decisions, observations };
  }

  // Unaddressed: the single judgement call. It fails open.
  return planUnaddressed(message, memberIds, options.wakeModel);
}

/** A direct Message wakes exactly its declared recipients. */
function resolveDirect(
  message: CollaborationMessage,
  memberIds: readonly string[],
): { decisions: readonly WakeDecision[]; observations: readonly WakeObservation[] } {
  return resolveTargets(message, memberIds, message.recipients, 'direct-recipient');
}

/**
 * Wake each requested target, reporting a target that is not a project member.
 *
 * A target that is not a member cannot be woken; reporting it as `failed` keeps
 * the loss observable instead of pretending the Message had no addressee.
 */
function resolveTargets(
  message: CollaborationMessage,
  memberIds: readonly string[],
  targets: readonly string[],
  reason: WakeDecision['reason'],
): { decisions: readonly WakeDecision[]; observations: readonly WakeObservation[] } {
  const decisions: WakeDecision[] = [];
  const observations: WakeObservation[] = [];
  const seen = new Set<string>();
  for (const agentId of targets) {
    if (agentId === message.author.id || seen.has(agentId)) continue;
    seen.add(agentId);
    if (!memberIds.includes(agentId)) {
      observations.push({
        agentId,
        status: 'failed',
        reason,
        detail: `addressed agent is not a member of project ${message.projectId}`,
      });
      continue;
    }
    decisions.push({ agentId, reason });
  }
  return { decisions, observations };
}

/** Every project member except the author. */
function others(message: CollaborationMessage, memberIds: readonly string[]): readonly string[] {
  return memberIds.filter((agentId) => agentId !== message.author.id);
}

/**
 * The unaddressed project-channel case, where the wake model decides.
 *
 * The model is asked only whether the room should engage. Its verdict never
 * narrows the recipient set: a `true` wakes every other member, and only an
 * explicit `false` suppresses — and even then the suppression is recorded as a
 * durable observation so a human can see that a judgement was made.
 *
 * A model that is missing, throws, or answers with a non-boolean fails open to
 * one extra wake per member.
 */
async function planUnaddressed(
  message: CollaborationMessage,
  memberIds: readonly string[],
  wakeModel: WakeModel | undefined,
): Promise<WakePlan> {
  const candidates = others(message, memberIds);
  if (wakeModel === undefined) {
    return {
      messageId: message.id,
      decisions: candidates.map((agentId) => ({ agentId, reason: 'wake-model-fail-open' })),
      observations: [
        {
          agentId: '*',
          status: 'failed',
          reason: 'wake-model-fail-open',
          detail: 'no wake model is configured; failing open to one extra wake per member',
        },
      ],
    };
  }

  let verdict;
  try {
    verdict = await wakeModel.decide({ message, memberIds });
  } catch (error) {
    return {
      messageId: message.id,
      decisions: candidates.map((agentId) => ({ agentId, reason: 'wake-model-fail-open' })),
      observations: [
        {
          agentId: '*',
          status: 'failed',
          reason: 'wake-model-fail-open',
          detail: `wake model failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  if (verdict.engage) {
    return {
      messageId: message.id,
      decisions: candidates.map((agentId) => ({ agentId, reason: 'wake-model' })),
      observations: [],
    };
  }

  // A deliberate, recorded refusal. Reachable only for an unaddressed Message;
  // an addressed Message never consults the model at all.
  return {
    messageId: message.id,
    decisions: [],
    observations: [
      {
        agentId: '*',
        status: 'suppressed',
        reason: 'wake-model',
        detail: verdict.detail ?? 'wake model judged the room need not engage',
      },
    ],
  };
}
