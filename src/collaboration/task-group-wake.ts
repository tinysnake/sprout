import { redactSensitiveText } from '../environment/privacy.ts';
import type { Message, WakePlan } from './model.ts';
import { parseMentions, planWake, type WakeMember } from './wake.ts';

export const TASK_GROUP_IDLE_MS = 5 * 60_000;
export const TASK_GROUP_MODEL_TIMEOUT_MS = 30_000;
export const TASK_GROUP_MAX_AGENT_CHAIN = 2;
export const TASK_GROUP_MAX_MODEL_CALLS = 1;
export const TASK_GROUP_MODEL_MAX_BODY_CHARS = 4_000;
export const TASK_GROUP_MODEL_MAX_CANDIDATES = 64;
export const TASK_GROUP_MAX_LEAD_REWAKES = 1;
export const TASK_GROUP_ATTENTION_KIND = 'task-group-unanswered';

/** Public Task facts only. Responsibility keys are exact routing labels, not prose guesses. */
export interface TaskGroupWakeFacts {
  readonly lead: { readonly id: string; readonly kind: 'agent' | 'human' };
  readonly assignedAgentIds?: readonly string[];
  readonly roles?: readonly { readonly agentId: string; readonly keys: readonly string[] }[];
}
export interface TaskGroupWakeModelPort {
  /** One bounded call for an ambiguous durable Message; no private run context. */
  select(input: { readonly message: Pick<Message, 'id' | 'body' | 'kind'>; readonly candidates: readonly string[]; readonly signal: AbortSignal }): Promise<readonly string[]>;
}
export interface TaskGroupPlan extends WakePlan { readonly ambiguous?: boolean }

export function taskGroupFallback(message: Message, members: readonly WakeMember[], facts: TaskGroupWakeFacts): TaskGroupPlan {
  const eligible = facts.lead.kind === 'agent' && facts.lead.id !== message.author.id && members.some(m => m.memberId === facts.lead.id && m.memberKind === 'agent' && m.endedAt === undefined);
  return { inputId: message.id, decisions: eligible ? [{ agentId: facts.lead.id, reason: 'task-lead' }] : [], observations: [] };
}

/** Deterministic precedence. Empty explicit addressing never falls through to a model. */
export function planTaskGroupWake(message: Message, members: readonly WakeMember[], facts: TaskGroupWakeFacts): TaskGroupPlan {
  const explicit = planWake(message, { members, scope: { kind: 'task-group' } });
  const mentions = parseMentions(message.body, members.map(m => m.memberId));
  if (explicit.decisions.length || mentions.members.length || mentions.unknown.length) {
    return { ...explicit, decisions: explicit.decisions.length ? explicit.decisions : taskGroupFallback(message, members, facts).decisions };
  }
  if (message.kind === 'question' || message.kind === 'escalation' || facts.lead.kind === 'human') return taskGroupFallback(message, members, facts);
  const candidates = members.filter(m => m.memberKind === 'agent' && m.endedAt === undefined && m.memberId !== message.author.id).map(m => m.memberId);
  const assigned = (facts.assignedAgentIds ?? []).filter(id => candidates.includes(id));
  const roleHits = (facts.roles ?? []).filter(role => role.keys.some(key => message.body.split(/\s+/).includes(key))).map(role => role.agentId).filter(id => candidates.includes(id));
  const targets = [...new Set(assigned.length ? assigned : roleHits)];
  if (targets.length) return { inputId: message.id, decisions: targets.map(agentId => ({ agentId, reason: 'task-assignment' })), observations: [] };
  if (candidates.length === 0) return taskGroupFallback(message, members, facts);
  return { inputId: message.id, decisions: [], observations: [], ambiguous: true };
}

/** Timeout aborts the provider; even a provider ignoring cancellation cannot block fallback. */
export async function resolveTaskGroupAmbiguity(message: Message, members: readonly WakeMember[], facts: TaskGroupWakeFacts, model?: TaskGroupWakeModelPort, timeoutMs = TASK_GROUP_MODEL_TIMEOUT_MS): Promise<TaskGroupPlan> {
  const deterministic = planTaskGroupWake(message, members, facts);
  if (!deterministic.ambiguous) return deterministic;
  const candidates = members.filter(m => m.memberKind === 'agent' && m.endedAt === undefined && m.memberId !== message.author.id).map(m => m.memberId);
  if (model) {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const selected = await Promise.race([
        model.select({ message: { id: message.id, body: redactSensitiveText(message.body).slice(0, TASK_GROUP_MODEL_MAX_BODY_CHARS), kind: message.kind ?? 'status' }, candidates: candidates.slice(0, TASK_GROUP_MODEL_MAX_CANDIDATES), signal: abort.signal }),
        new Promise<readonly string[]>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('timeout')); }, Math.max(1, Math.min(TASK_GROUP_MODEL_TIMEOUT_MS, timeoutMs))); }),
      ]);
      if (Array.isArray(selected) && selected.every(id => candidates.slice(0, TASK_GROUP_MODEL_MAX_CANDIDATES).includes(id))) {
        const ids = [...new Set(selected)];
        if (ids.length) return { inputId: message.id, decisions: ids.map(agentId => ({ agentId, reason: 'routing-model' })), observations: [] };
      }
    } catch { /* Failure is bounded and resolves to the lead, never all members. */ }
    finally { if (timer) clearTimeout(timer); abort.abort(); }
  }
  return taskGroupFallback(message, members, facts);
}
