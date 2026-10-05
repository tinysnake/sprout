import type { CollaborationStore } from './store.ts';
import type { Message, WakePlan, WakeRequest } from './model.ts';
import { planWake, type WakeMember } from './wake.ts';
import type { ProjectEvent } from './events.ts';
import { TASK_GROUP_ATTENTION_KIND, TASK_GROUP_IDLE_MS, TASK_GROUP_MAX_AGENT_CHAIN, planTaskGroupWake, resolveTaskGroupAmbiguity, taskGroupFallback, type TaskGroupWakeFacts, type TaskGroupWakeModelPort } from './task-group-wake.ts';

export interface TaskGroupEscalation {
  readonly eventId: string;
  readonly messageId: string;
  readonly scopeId: string;
  readonly projectId: string;
  readonly at: number;
}

interface Options {
  readonly store: CollaborationStore;
  readonly now: () => number;
  readonly facts: (scopeId: string) => Promise<TaskGroupWakeFacts | undefined>;
  readonly members: (projectId: string) => Promise<readonly WakeMember[]>;
  readonly writable: (message: Message) => Promise<boolean>;
  readonly working: (wakes: readonly WakeRequest[]) => Promise<boolean>;
  readonly admit: (wakes: readonly WakeRequest[], message: Message) => Promise<void>;
  readonly serialize?: <T>(message: Message, action: () => Promise<T>) => Promise<T>;
  readonly model?: TaskGroupWakeModelPort;
}

/** Durable stage identities are authoritative; timers only request reconciliation. */
export class TaskGroupOrchestration {
  readonly #options: Options;
  #flight: Promise<void> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(options: Options) { this.#options = options; }

  async plan(message: Message, members: readonly WakeMember[]): Promise<WakePlan> {
    const facts = await this.#options.facts(message.scopeId);
    if (await this.#bounded(message)) return { inputId: message.id, decisions: [], observations: [] };
    if (!facts) return planWake(message, { members, scope: { kind: 'task-group' } });
    return planTaskGroupWake(message, members, facts);
  }

  async escalations(projectId?: string): Promise<readonly TaskGroupEscalation[]> {
    const signals: TaskGroupEscalation[] = [];
    for (const event of await this.#options.store.listEvents(projectId)) {
      if (event.kind !== TASK_GROUP_ATTENTION_KIND || !event.deliveryKey.startsWith('task-group:') || !event.deliveryKey.endsWith(':attention')) continue;
      const messageId = event.deliveryKey.slice('task-group:'.length, -':attention'.length);
      const message = await this.#options.store.getMessage(messageId);
      if (message?.channel !== 'task-group' || message.projectId !== event.projectId) continue;
      signals.push({ eventId: event.id, messageId, scopeId: message.scopeId, projectId: event.projectId, at: event.createdAt });
    }
    return signals;
  }

  async #bounded(message: Message): Promise<boolean> {
    if (message.author.kind !== 'agent') return false;
    let hops = 1;
    let current = message;
    const visited = new Set([message.id]);
    while (current.inReplyTo) {
      const parent = await this.#options.store.getMessage(current.inReplyTo);
      // Cross-scope causal links cannot influence group routing or reveal context.
      if (!parent || parent.scopeId !== message.scopeId || parent.author.kind !== 'agent') break;
      if (visited.has(parent.id)) return true;
      visited.add(parent.id);
      if (!parent.deliveryKey.startsWith('reply:')) hops++;
      if (hops > TASK_GROUP_MAX_AGENT_CHAIN) return true;
      current = parent;
    }
    return false;
  }

  schedule(delay = 0): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.sweep().catch(() => this.schedule(TASK_GROUP_IDLE_MS));
    }, Math.max(0, delay));
    this.#timer.unref();
  }

  sweep(): Promise<void> {
    if (this.#flight) return this.#flight;
    this.#flight = this.#sweep().finally(() => { this.#flight = undefined; });
    return this.#flight;
  }

  async #event(message: Message, stage: string, plan: WakePlan, attention = false, replan?: (members: readonly WakeMember[]) => Promise<WakePlan | undefined>): Promise<{ readonly wakes: readonly WakeRequest[]; readonly duplicate: boolean; readonly skipped: boolean }> {
    const key = `task-group:${message.id}:${stage}`;
    const persist = async () => {
      if (!(await this.#options.writable(message))) return undefined;
      const members = await this.#options.members(message.projectId);
      const currentPlan = replan ? await replan(members) : plan;
      if (!currentPlan) return undefined;
      const decisions = currentPlan.decisions.filter(decision => decision.agentId !== message.author.id && members.some(member => member.memberId === decision.agentId && member.memberKind === 'agent' && member.endedAt === undefined));
      const event: ProjectEvent = {
        id: key, projectId: message.projectId, kind: attention ? TASK_GROUP_ATTENTION_KIND : `task-group-${stage}`,
        summary: attention ? 'Task group message needs Human attention.' : 'Task group wake orchestration advanced.',
        producer: { kind: 'system', id: 'sprout' },
        disposition: attention ? 'human-action-required' : decisions.length ? 'addressed' : 'non-routing',
        responsibleAgentIds: decisions.map(decision => decision.agentId), originScopeIds: [message.scopeId], deliveryKey: key, createdAt: this.#options.now(),
      };
      return this.#options.store.publishEvent({ event, plan: { ...currentPlan, decisions, inputId: key }, now: event.createdAt });
    };
    const stored = await (this.#options.serialize?.(message, persist) ?? persist());
    if (!stored) return { wakes: [], duplicate: false, skipped: true };
    // The event and wakes are durable together. Admission uses the original
    // Message, preserving group context instead of delivering a lifecycle fact.
    try { await this.#options.admit(stored.wakes, message); }
    catch { /* Pending wakes remain durable; admission failure must not block escalation. */ }
    return { ...stored, skipped: false };
  }

  async #sweep(): Promise<void> {
    const o = this.#options;
    const messages = await o.store.listMessages();
    let next = Infinity;
    for (const message of messages) {
      if (message.channel !== 'task-group' || message.deliveryKey.startsWith('reply:')) continue;
      const key = (stage: string) => `task-group:${message.id}:${stage}`;
      if (await o.store.getEventByDeliveryKey(key('attention')) || await o.store.getEventByDeliveryKey(key('answered'))) continue;
      if (!(await o.writable(message))) continue;
      let facts = await o.facts(message.scopeId);
      const members = await o.members(message.projectId);
      if (!facts || await this.#bounded(message)) {
        await this.#event(message, 'attention', { inputId: message.id, decisions: [], observations: [] }, true);
        continue;
      }
      const empty = { inputId: message.id, decisions: [], observations: [] };
      let wakes = (await o.store.listWakeRequests()).filter(w => w.inputId === message.id || w.inputId === key('routed') || w.inputId === key('rewake'));
      try { await o.admit(wakes, message); }
      catch { /* An unavailable run admitter cannot starve this Message's idle deadline. */ }
      wakes = (await o.store.listWakeRequests()).filter(w => w.inputId === message.id || w.inputId === key('routed') || w.inputId === key('rewake'));
      if (messages.some(m => m.scopeId === message.scopeId && m.inReplyTo === message.id && m.author.kind === 'agent') || await o.working(wakes)) {
        await this.#event(message, 'answered', empty);
        continue;
      }
      const deterministic = planTaskGroupWake(message, members, facts);
      if (deterministic.ambiguous && !await o.store.getEventByDeliveryKey(key('routed'))) {
        // Claim BEFORE inference. If the process dies mid-call, recovery falls
        // back to lead rather than paying for another model call.
        const claimed = await o.store.getEventByDeliveryKey(key('model-claimed'));
        const claim = await this.#event(message, 'model-claimed', empty);
        if (claim.skipped) continue;
        // Inference may not occupy an earlier Message's idle deadline. An
        // exhausted budget chooses lead fallback instead of queuing more calls.
        const budget = Math.min(next, message.createdAt + TASK_GROUP_IDLE_MS) - o.now();
        const plan = claimed || claim.duplicate || budget <= 0 ? taskGroupFallback(message, members, facts) : await resolveTaskGroupAmbiguity(message, members, facts, o.model, budget);
        let latestFacts: TaskGroupWakeFacts | undefined = facts;
        const routedStage = await this.#event(message, 'routed', empty, false, async currentMembers => {
          const currentMessages = await o.store.listMessages();
          const currentWakes = (await o.store.listWakeRequests()).filter(w => w.inputId === message.id || w.inputId === key('routed') || w.inputId === key('rewake'));
          if (currentMessages.some(m => m.scopeId === message.scopeId && m.inReplyTo === message.id && m.author.kind === 'agent') || await o.working(currentWakes)) return undefined;
          latestFacts = await o.facts(message.scopeId);
          facts = latestFacts;
          if (!latestFacts) return empty;
          const currentPlan = planTaskGroupWake(message, currentMembers, latestFacts);
          if (!currentPlan.ambiguous) return currentPlan;
          const currentCandidates = new Set(currentMembers.filter(member => member.memberKind === 'agent' && member.endedAt === undefined && member.memberId !== message.author.id).map(member => member.memberId));
          const currentDecisions = plan.decisions.filter(decision => currentCandidates.has(decision.agentId));
          return currentDecisions.length ? { ...plan, decisions: currentDecisions } : taskGroupFallback(message, currentMembers, latestFacts);
        });
        if (routedStage.skipped) {
          if (!latestFacts) {
            await this.#event(message, 'attention', empty, true);
            continue;
          }
          continue;
        }
        wakes = [...wakes, ...routedStage.wakes];
      }
      if (!facts) {
        await this.#event(message, 'attention', empty, true);
        continue;
      }
      const reWake = await o.store.getEventByDeliveryKey(key('rewake'));
      const deadline = (reWake?.createdAt ?? message.createdAt) + TASK_GROUP_IDLE_MS;
      if (o.now() < deadline) { next = Math.min(next, deadline); continue; }
      const lead = taskGroupFallback(message, members, facts);
      if (!reWake && lead.decisions.length) {
        await this.#event(message, 'rewake', lead);
        next = Math.min(next, o.now() + TASK_GROUP_IDLE_MS);
      } else {
        await this.#event(message, 'attention', empty, true);
      }
    }
    if (Number.isFinite(next)) this.schedule(next - o.now());
  }
}
