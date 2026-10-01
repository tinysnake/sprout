/** Human-only collaboration resolution commands; Feed itself remains read-only. */
import type { CollaborationStore } from '../collaboration/store.ts';
import { AttentionResolutionError, type CollaborationAttentionKind } from '../collaboration/attention.ts';
import type { ApiRequestContext, ApiRouter } from './router.ts';

function json(context: ApiRequestContext, status: number, body: unknown): boolean {
  context.response.writeHead(status, { 'content-type': 'application/json' });
  context.response.end(JSON.stringify(body));
  return true;
}

export function createCollaborationAttentionRouter(options: {
  readonly store: CollaborationStore;
  readonly now?: () => number;
}): ApiRouter {
  return {
    name: 'collaboration-attention',
    async handle(context) {
      const s = context.segments;
      if (context.method !== 'POST' || s.length !== 7 || s[0] !== 'api' || s[1] !== 'projects'
        || s[3] !== 'collaboration-attention' || s[6] !== 'resolve') return false;
      // Operator sessions authenticate the one Human; Worker/Agent credentials
      // cannot enter this browser route. Never accept an actor from the body.
      if (!context.operatorSessionId) return json(context, 401, { error: 'authentication required' });
      const kind = s[4];
      if (kind !== 'event' && kind !== 'wake-input' && kind !== 'routing-batch') {
        return json(context, 400, { code: 'invalid-resolution', error: 'Invalid Attention source kind.' });
      }
      try {
        await options.store.resolveAttention({
          projectId: s[2]!, kind: kind as CollaborationAttentionKind, sourceId: s[5]!,
          actor: { id: 'operator', kind: 'human' }, now: (options.now ?? Date.now)(),
        });
        return json(context, 200, { resolved: true });
      } catch (error) {
        if (error instanceof AttentionResolutionError) {
          return json(context, error.code === 'unknown-source' ? 404 : 400, { code: error.code, error: error.message });
        }
        return json(context, 500, { error: 'The resolution could not be recorded.' });
      }
    },
  };
}
