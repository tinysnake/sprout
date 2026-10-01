/**
 * `GET /api/feed` — the read-only Feed projection over HTTP (#103).
 *
 * The route serves one derived snapshot and applies at most a read filter:
 * `?scope=` (`all`, `infra`, or a Project id) and `?urgency=` (one severity
 * tier). It is deliberately a GET-only route with no sibling commands — there
 * is no dismiss, snooze, or acknowledge endpoint, because an attention item
 * must clear only when its authoritative source clears. Unknown filter values
 * refuse rather than silently widening the view.
 *
 * The transport already authenticated the operator session and CSRF token;
 * this router still requires the session id so an unauthenticated M1-style
 * composition can never serve Attention state.
 */

import { FEED_SEVERITIES, filterFeed, type FeedProjection, type FeedSeverity } from './feed.ts';
import type { ApiRequestContext, ApiRouter } from './router.ts';

function json(context: ApiRequestContext, status: number, body: unknown): boolean {
  context.response.writeHead(status, { 'content-type': 'application/json' });
  context.response.end(JSON.stringify(body));
  return true;
}

export function createFeedRouter(options: { readonly feed: FeedProjection }): ApiRouter {
  const { feed } = options;
  return {
    name: 'feed',
    async handle(context) {
      if (context.segments[0] !== 'api' || context.segments[1] !== 'feed') return false;
      // Anything deeper (a hypothetical dismiss/snooze command) is not a Feed
      // route; fall through so the transport answers 404.
      if (context.method !== 'GET' || context.segments.length !== 2) return false;
      if (!context.operatorSessionId) return json(context, 401, { error: 'authentication required' });
      const snapshot = await feed.snapshot();
      const scope = context.searchParams.get('scope') ?? 'all';
      if (!snapshot.scopes.some((option) => option.id === scope)) {
        return json(context, 400, { code: 'unknown-scope', error: `unknown Feed scope: ${scope}` });
      }
      const urgency = context.searchParams.get('urgency');
      if (urgency !== null && !(FEED_SEVERITIES as readonly string[]).includes(urgency)) {
        return json(context, 400, { code: 'unknown-urgency', error: `unknown urgency tier: ${urgency}` });
      }
      const filter = urgency === null ? { scope } : { scope, urgency: urgency as FeedSeverity };
      return json(context, 200, filterFeed(snapshot, filter));
    },
  };
}
