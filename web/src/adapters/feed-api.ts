/**
 * The typed browser adapter for the read-only Feed projection (#103).
 *
 * Shared portable types come from the backend projection module — one wire
 * vocabulary, not a second one — and no backend runtime import happens here.
 * The adapter exposes exactly one read command (`load`) plus transport state:
 * Attention has no dismiss or snooze, so there is deliberately no command
 * method that could hide an unresolved item from the browser.
 */

import type { BrowserTransport, BrowserTransportState } from '../transport/browser-transport.js';
import type { FeedFilter, FeedSnapshot } from '../../../src/web/feed.ts';

export type {
  FeedActivityItem,
  FeedAttentionCategory,
  FeedAttentionItem,
  FeedFilter,
  FeedInFlightItem,
  FeedScopeOption,
  FeedSeverity,
  FeedSnapshot,
  FeedTarget,
  FeedTargetSurface,
} from '../../../src/web/feed.ts';

export interface FeedBrowserAdapter {
  state(): BrowserTransportState;
  subscribeState(listener: (state: BrowserTransportState) => void): () => void;
  /** Fetch one filtered snapshot; the server applies scope and urgency. */
  load(filter?: FeedFilter): Promise<FeedSnapshot>;
}

export function createFeedBrowserAdapter(transport: BrowserTransport): FeedBrowserAdapter {
  return {
    state: () => transport.state(),
    subscribeState: (listener) => transport.subscribeState(listener),
    async load(filter: FeedFilter = {}) {
      const params = new URLSearchParams();
      if (filter.scope !== undefined) params.set('scope', filter.scope);
      if (filter.urgency !== undefined) params.set('urgency', filter.urgency);
      const query = params.toString();
      return await transport.request<FeedSnapshot>(`/api/feed${query === '' ? '' : `?${query}`}`);
    },
  };
}
