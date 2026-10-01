import type { InjectionKey } from 'vue';
import type { FeedBrowserAdapter } from '../adapters/feed-api.js';

/** Production read authority for the Feed landing page. */
export const FEED_API: InjectionKey<FeedBrowserAdapter> = Symbol('sprout.feed.api');
/** Clock used to render in-flight elapsed durations; tests provide a fixed clock. */
export const FEED_CLOCK: InjectionKey<() => number> = Symbol('sprout.feed.clock');
