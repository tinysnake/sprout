import type { InjectionKey } from 'vue';
import type { FeedBrowserAdapter } from '../adapters/feed-api.js';

/** Production read authority for the Feed landing page. */
export const FEED_API: InjectionKey<FeedBrowserAdapter> = Symbol('sprout.feed.api');
