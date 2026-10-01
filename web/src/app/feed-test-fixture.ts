import type { FeedFilter, FeedSnapshot } from '../adapters/feed-api.js';
import type { FeedAttentionItem, FeedInFlightItem } from '../adapters/feed-api.js';
import type { BrowserTransportState } from '../transport/browser-transport.js';
import type { FeedBrowserAdapter } from '../adapters/feed-api.js';
import { FEED_ALL_SCOPE, feedTarget } from '../../../src/web/feed.ts';

export const EMPTY_FEED_SNAPSHOT: FeedSnapshot = {
  attention: [],
  inFlight: [],
  activity: [],
  scopes: [
    { id: FEED_ALL_SCOPE, kind: 'all', label: 'All Projects', attentionCount: 0 },
    { id: 'feed:infra', kind: 'infrastructure', label: 'Infrastructure', attentionCount: 0 },
  ],
};

/** Explicit Feed authority for deterministic production DOM tests. */
export function createFeedTestAdapter(snapshot: FeedSnapshot = EMPTY_FEED_SNAPSHOT): FeedBrowserAdapter {
  const listeners = new Set<(state: BrowserTransportState) => void>();
  const state: BrowserTransportState = { status: 'online', connection: 'online', loading: false };
  return {
    state: () => state,
    subscribeState(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    async load(filter: FeedFilter = {}) {
      const scope = filter.scope ?? FEED_ALL_SCOPE;
      return {
        ...snapshot,
        attention: snapshot.attention.filter((item) =>
          (scope === FEED_ALL_SCOPE || item.scopes.includes(scope))
          && (filter.urgency === undefined || item.severity === filter.urgency)),
        inFlight: snapshot.inFlight.filter((item) => scope === FEED_ALL_SCOPE || item.scopes.includes(scope)),
        activity: snapshot.activity.filter((item) => scope === FEED_ALL_SCOPE || item.scopes.includes(scope)),
      };
    },
  };
}

export function pendingEnrollmentSnapshot(enrollments: readonly { readonly id: string; readonly displayName: string }[]): FeedSnapshot {
  const attention: FeedAttentionItem[] = enrollments.map((enrollment, index) => ({
    id: `enrollment:${enrollment.id}`,
    severity: 'attention',
    category: 'enrollment-pending',
    reason: `Environment enrollment \"${enrollment.displayName}\" awaits Human approval.`,
    lifecycle: 'Enrollment pending · Approval not granted · Work admission barred',
    target: feedTarget({ surface: 'environment-detail', environmentId: enrollment.id }),
    scopes: ['feed:infra'],
    source: { kind: 'enrollment', id: enrollment.id },
    at: index + 1,
  }));
  return {
    ...EMPTY_FEED_SNAPSHOT,
    attention,
    scopes: EMPTY_FEED_SNAPSHOT.scopes.map((scope) =>
      scope.id === 'feed:infra' ? { ...scope, attentionCount: attention.length } : scope),
  };
}

export function taskWorkSnapshot(projectId: string, taskId: string): FeedSnapshot {
  const item: FeedInFlightItem = {
    id: `task:${taskId}`,
    kind: 'task',
    lifecycle: 'Task active · Agent run active · Lease held',
    scopes: [projectId],
    target: feedTarget({ surface: 'project-task-detail', projectId, taskId }),
    projectId,
    taskId,
    at: 1,
  };
  return {
    ...EMPTY_FEED_SNAPSHOT,
    inFlight: [item],
    scopes: [
      EMPTY_FEED_SNAPSHOT.scopes[0]!,
      { id: projectId, kind: 'project', label: 'Test Project', attentionCount: 0 },
      EMPTY_FEED_SNAPSHOT.scopes[1]!,
    ],
  };
}

export function recoveryAttentionSnapshot(environmentId: string): FeedSnapshot {
  const item: FeedAttentionItem = {
    id: `lease-recovery:${environmentId}`,
    severity: 'action_required',
    category: 'lease-recovery',
    reason: 'An Environment lease needs Human recovery review.',
    lifecycle: 'Environment lease recovery · Task task-104 · Cause worker-channel-lost',
    target: feedTarget({ surface: 'environment-detail', environmentId }),
    scopes: ['feed:infra'],
    source: { kind: 'recovery', id: `recovery-${environmentId}` },
    at: 1,
  };
  return {
    ...EMPTY_FEED_SNAPSHOT,
    attention: [item],
    scopes: EMPTY_FEED_SNAPSHOT.scopes.map((scope) =>
      scope.id === 'feed:infra' ? { ...scope, attentionCount: 1 } : scope),
  };
}
