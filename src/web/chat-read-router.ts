import type { CollaborationStore } from '../collaboration/store.ts';
import type { ConversationScopeService } from '../conversation/service.ts';
import { ConversationScopeError, workingGroupStatus } from '../conversation/model.ts';
import type { ApiRequestContext, ApiRouter } from './router.ts';

export interface UnreadScopeCount {
  readonly scopeId: string;
  readonly projectId: string;
  readonly count: number;
}

function json(context: ApiRequestContext, status: number, body: unknown) {
  context.response.writeHead(status, { 'content-type': 'application/json' });
  context.response.end(JSON.stringify(body));
  return true;
}

/** Operator-only read receipts and count-only projection. Message content never enters a badge payload. */
export function createChatReadRouter(options: { readonly store: CollaborationStore; readonly scopes: ConversationScopeService }): ApiRouter {
  const { store, scopes } = options;
  async function visibleScope(scopeId: string) {
    const scope = await scopes.getScope(scopeId);
    if (!scope) return undefined;
    const human = await scopes.humanAuthority(scope.projectId);
    // A Project's Human cannot inspect a private conversation between Agents.
    if (scope.kind === 'direct' && !scope.participants.includes(human.memberId)) return undefined;
    const counted = scope.kind !== 'working-group' || workingGroupStatus(scope) !== 'disbanded';
    const state = await scopes.scopeState(scopeId, human.memberId);
    return { scope, human, counted: counted && state.reason !== 'membership-ended' };
  }
  return {
    name: 'chat-read-state',
    async handle(context) {
      const s = context.segments;
      const summary = context.method === 'GET' && s.length === 3 && s[0] === 'api' && s[1] === 'chat' && s[2] === 'unread';
      const receipt = context.method === 'POST' && s.length === 4 && s[0] === 'api' && s[1] === 'scopes' && s[3] === 'read';
      if (!summary && !receipt) return false;
      if (!context.operatorSessionId) return json(context, 401, { error: 'authentication required' });
      try {
        if (summary) {
          const ids = new Set((await store.listMessages()).map((m) => m.scopeId));
          const counts: UnreadScopeCount[] = [];
          for (const id of ids) {
            let visible;
            try { visible = await visibleScope(id); } catch (error) { if (error instanceof ConversationScopeError) continue; throw error; }
            if (!visible) continue;
            counts.push({ scopeId: id, projectId: visible.scope.projectId, count: visible.counted ? await store.unreadCount(id, visible.human.memberId) : 0 });
          }
          return json(context, 200, { scopes: counts });
        }
        const scopeId = s[2]!;
        const visible = await visibleScope(scopeId);
        if (!visible) return json(context, 404, { error: 'Conversation not found' });
        const body = await context.readBody();
        const ids = body['messageIds'];
        if (!Array.isArray(ids) || !ids.length || !ids.every((id) => typeof id === 'string')) return json(context, 400, { error: 'Observed message identities are required' });
        // Validate the whole receipt before mutating any marker. Each cursor is
        // bounded by observed identities, so concurrently appended rows remain unread.
        const messages = await store.listMessages();
        if (ids.some((id) => !messages.some((m) => m.id === id && m.scopeId === scopeId))) return json(context, 400, { error: 'Message does not belong to this scope' });
        for (const id of ids) await store.markReadThrough(scopeId, visible.human.memberId, id);
        return json(context, 200, { scopeId, projectId: visible.scope.projectId, count: visible.counted ? await store.unreadCount(scopeId, visible.human.memberId) : 0 });
      } catch (error) {
        if (error instanceof ConversationScopeError) return json(context, 404, { error: 'Conversation not found' });
        return json(context, 500, { error: 'Read state is unavailable' });
      }
    },
  };
}
