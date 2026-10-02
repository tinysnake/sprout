<script setup lang="ts">
import { computed, inject, nextTick, onMounted, ref, watch } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { FEED_ALL_SCOPE, isFeedDeepLink } from '../../../src/web/feed.ts';
import type {
  FeedActivityItem,
  FeedAttentionItem,
  FeedBrowserAdapter,
  FeedInFlightItem,
  FeedScopeOption,
  FeedSeverity,
  FeedSnapshot,
  FeedTarget,
} from '../adapters/feed-api.ts';
import { useAppStore } from '../stores/app.ts';
import { useAnnouncer } from '../primitives/announcer.ts';
import { useShellConnection } from '../shell/use-shell-connection.ts';
import { FEED_API, FEED_CLOCK } from './feed-port.ts';
import Badge from '../primitives/Badge.vue';
import Button from '../primitives/Button.vue';
import EmptyState from '../primitives/EmptyState.vue';
import Icon from '../primitives/Icon.vue';
import StatusDot from '../primitives/StatusDot.vue';
import { useUnreadState } from '../modules/chat/unread-state.ts';
import UnreadBadge from '../modules/chat/UnreadBadge.vue';

const unread = useUnreadState();
const unreadConversations = computed(() => unread?.scopes.value.filter((s) => s.count > 0 && (activeScope.value === FEED_ALL_SCOPE || activeScope.value === s.projectId)) ?? []);
function activityUnread(target: FeedTarget | undefined) { return target?.surface === 'project-chat' && target.scopeId ? unread?.count(target.scopeId) ?? 0 : 0; }
const props = defineProps<{ api?: FeedBrowserAdapter }>();
const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const announcer = useAnnouncer();
const connection = useShellConnection().presentation;
const injectedApi = inject(FEED_API, undefined);
const api = computed(() => props.api ?? injectedApi);
const feedClock = inject(FEED_CLOCK, () => Date.now());

const urgencyChoices: readonly ('all' | FeedSeverity)[] = [
  'all',
  'action_required',
  'attention',
  'info',
];
const activityChoices = ['all', 'tasks', 'messages', 'envs', 'usage', 'other'] as const;
type ActivityFilter = (typeof activityChoices)[number];

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function queryUrgency(value: unknown): 'all' | FeedSeverity {
  return urgencyChoices.includes(value as 'all' | FeedSeverity)
    ? (value as 'all' | FeedSeverity)
    : 'all';
}

function queryActivity(value: unknown): ActivityFilter {
  return activityChoices.includes(value as ActivityFilter) ? (value as ActivityFilter) : 'all';
}

const activeScope = ref(queryString(route.query['scope']) ?? FEED_ALL_SCOPE);
const activeUrgency = ref(queryUrgency(route.query['urgency']));
const activeActivity = ref(queryActivity(route.query['activity']));
const scopeOptions = ref<readonly FeedScopeOption[]>([]);
const snapshot = ref<FeedSnapshot>();
const loading = ref(true);
const loaded = ref(false);
const pageError = ref<'offline' | 'authentication' | 'forbidden' | 'failure'>();
const heading = ref<HTMLHeadingElement>();
let loadGeneration = 0;

const scopeLabel = computed(
  () => scopeOptions.value.find((scope) => scope.id === activeScope.value)?.label ?? 'Feed',
);
const feedQuery = computed(() => ({
  scope: activeScope.value,
  urgency: activeUrgency.value,
  activity: activeActivity.value,
}));

const visibleAttention = computed(() => {
  const items = snapshot.value?.attention ?? [];
  if (activeUrgency.value === 'all') return items;
  return items.filter((item) => item.severity === activeUrgency.value);
});
const attentionCounts = computed(() => {
  const items = snapshot.value?.attention ?? [];
  return {
    all: items.length,
    action_required: items.filter((item) => item.severity === 'action_required').length,
    attention: items.filter((item) => item.severity === 'attention').length,
    info: items.filter((item) => item.severity === 'info').length,
  };
});
const inFlightItems = computed(() => snapshot.value?.inFlight ?? []);
const activityItems = computed(() => {
  const items = snapshot.value?.activity ?? [];
  return activeActivity.value === 'all'
    ? items
    : items.filter((item) => activityGroup(item) === activeActivity.value);
});
const activityCounts = computed(() => {
  const items = snapshot.value?.activity ?? [];
  return {
    all: items.length,
    tasks: items.filter((item) => activityGroup(item) === 'tasks').length,
    messages: items.filter((item) => activityGroup(item) === 'messages').length,
    envs: items.filter((item) => activityGroup(item) === 'envs').length,
    usage: items.filter((item) => activityGroup(item) === 'usage').length,
    other: items.filter((item) => activityGroup(item) === 'other').length,
  };
});
const totalVisibleItems = computed(
  () => visibleAttention.value.length + inFlightItems.value.length + activityItems.value.length,
);
const pageState = computed(() => {
  if (!api.value) return 'unavailable';
  if (loading.value && snapshot.value === undefined) return 'loading';
  if (snapshot.value === undefined && pageError.value === 'offline') return 'offline';
  if (snapshot.value === undefined && pageError.value !== undefined) return 'failure';
  if (snapshot.value !== undefined && totalVisibleItems.value === 0) return 'empty';
  return 'ready';
});

function categoryLabel(category: FeedAttentionItem['category']): string {
  const labels: Record<FeedAttentionItem['category'], string> = {
    'proposal-pending': 'Task proposal',
    'task-validation': 'Task validation',
    'task-blocker': 'Task blocker',
    'task-recovery': 'Task recovery',
    'lease-recovery': 'Lease recovery',
    'enrollment-pending': 'Enrollment',
    'routing-failure': 'Routing failure',
    'human-action-required': 'Project event',
  };
  return labels[category];
}

function severityLabel(severity: FeedSeverity): string {
  if (severity === 'action_required') return 'Action required';
  return severity === 'attention' ? 'Attention' : 'Info';
}

function severityVariant(severity: FeedSeverity): 'red' | 'yellow' | 'info' {
  if (severity === 'action_required') return 'red';
  return severity === 'attention' ? 'yellow' : 'info';
}

function severityBorder(severity: FeedSeverity): string {
  if (severity === 'action_required') return 'border-l-[var(--red-action)]';
  return severity === 'attention'
    ? 'border-l-[var(--yellow-attention)]'
    : 'border-l-[var(--purple-agent)]';
}

function activityGroup(item: FeedActivityItem): ActivityFilter {
  const kind = item.kind.toLowerCase();
  if (kind.includes('task') || (kind === 'agent-run' && item.target?.surface === 'project-task-detail')) return 'tasks';
  if (/message|routing|wake|chat/.test(kind) || (kind !== 'agent-run' && /run/.test(kind)) || (kind === 'agent-run' && item.target?.surface === 'project-chat')) return 'messages';
  if (/environment|enrollment|lease|worker|recovery|readiness/.test(kind)) return 'envs';
  if (/usage|cost|token/.test(kind)) return 'usage';
  return 'other';
}

function activityGroupLabel(group: ActivityFilter): string {
  switch (group) {
    case 'tasks': return 'Tasks';
    case 'messages': return 'Chat & routing';
    case 'envs': return 'Environments';
    case 'usage': return 'Usage';
    case 'other': return 'Other';
    default: return 'All activity';
  }
}

function projectName(projectId: string | undefined): string | undefined {
  if (!projectId) return undefined;
  return scopeOptions.value.find((scope) => scope.id === projectId)?.label ?? 'Project';
}

function targetLocation(target: FeedTarget | undefined): RouteLocationRaw | undefined {
  if (!target || !isFeedDeepLink(target)) return undefined;
  const projectSurfaces: readonly FeedTarget['surface'][] = [
    'project-overview',
    'project-tasks',
    'project-task-detail',
    'project-chat',
    'project-chat-routing',
  ];
  if (projectSurfaces.includes(target.surface) && !target.projectId) return undefined;
  // Check the projection's canonical path against the actual router before
  // translating its identity into a named route with the Project context.
  if (router.resolve(target.path).matched.length === 0) return undefined;

  const project = target.projectId ? { project: target.projectId } : {};
  let location: RouteLocationRaw;
  switch (target.surface) {
    case 'project-overview':
      location = { name: 'project-overview', query: project };
      break;
    case 'project-tasks':
      location = target.proposalId
        ? { name: 'project-task-proposal', params: { proposalId: target.proposalId }, query: project }
        : { name: 'project-tasks', query: project };
      break;
    case 'project-task-detail':
      if (!target.taskId) return undefined;
      location = { name: 'project-task-detail', params: { taskId: target.taskId }, query: project };
      break;
    case 'project-chat':
      location = {
        name: target.scopeId ? 'project-chat-scope' : 'project-chat',
        ...(target.scopeId ? { params: { scopeId: target.scopeId } } : {}),
        query: {
          ...project,
          ...(target.messageId ? { message: target.messageId } : {}),
          ...(target.eventId ? { event: target.eventId } : {}),
        },
      };
      break;
    case 'project-chat-routing':
      if (!target.batchId) return undefined;
      location = { name: 'project-chat-routing', params: { batchId: target.batchId }, query: project };
      break;
    case 'environments':
      location = { name: 'environments' };
      break;
    case 'environment-detail':
      if (!target.environmentId) return undefined;
      location = { name: 'environment-detail', params: { id: target.environmentId } };
      break;
    case 'agent-detail':
      if (!target.agentId) return undefined;
      location = { name: 'agent-detail', params: { agentId: target.agentId } };
      break;
  }
  return router.resolve(location).matched.length > 0 ? location : undefined;
}

function shortTime(at: number): string {
  if (!Number.isFinite(at)) return 'Time unavailable';
  const elapsed = Math.max(0, Date.now() - at);
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))}h ago`;
  return `${Math.floor(elapsed / (24 * 60 * 60_000))}d ago`;
}

function elapsedDuration(at: number): string {
  if (!Number.isFinite(at)) return 'unavailable';
  const elapsed = Math.max(0, feedClock() - at);
  const seconds = Math.floor(elapsed / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m${remainderSeconds === 0 ? '' : ` ${remainderSeconds}s`}`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  if (hours < 24) return `${hours}h${remainderMinutes === 0 ? '' : ` ${remainderMinutes}m`}`;
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return `${days}d${remainderHours === 0 ? '' : ` ${remainderHours}h`}`;
}

function isoTime(at: number): string | undefined {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function sourceLabel(item: FeedInFlightItem): string {
  if (item.kind === 'task') return item.taskId ? `Task ${item.taskId}` : 'Task work';
  return item.runId ? `Agent run ${item.runId}` : 'Agent run';
}

function safeErrorKind(error: unknown): 'offline' | 'authentication' | 'forbidden' | 'failure' {
  if (typeof error !== 'object' || error === null) return 'failure';
  const failure = error as { readonly kind?: unknown; readonly status?: unknown };
  if (failure.kind === 'unavailable') return 'offline';
  if (failure.kind === 'authentication-required' || failure.status === 401) return 'authentication';
  if (failure.kind === 'forbidden' || failure.status === 403) return 'forbidden';
  return 'failure';
}

function errorHeading(kind: 'offline' | 'authentication' | 'forbidden' | 'failure'): string {
  switch (kind) {
    case 'offline': return 'Feed is offline';
    case 'authentication': return 'Operator sign-in required';
    case 'forbidden': return 'Feed is unavailable to this operator';
    default: return 'Feed could not be loaded';
  }
}

function errorDescription(kind: 'offline' | 'authentication' | 'forbidden' | 'failure'): string {
  switch (kind) {
    case 'offline': return 'Sprout could not be reached. Check the connection and retry to load current Feed facts.';
    case 'authentication': return 'Sign in to load current Attention, in-flight work, and activity.';
    case 'forbidden': return 'The current operator session cannot read Feed facts.';
    default: return 'The Feed request failed. Retry to load the latest authoritative snapshot.';
  }
}

function announceSnapshot(value: FeedSnapshot): void {
  announcer.announce(
    `Feed updated for ${scopeLabel.value}: ${value.attention.length} Attention items, ${value.inFlight.length} in-flight items, and ${value.activity.length} activity items.`,
  );
}

async function loadInitial(): Promise<void> {
  const currentApi = api.value;
  if (!currentApi) {
    loading.value = false;
    announcer.announce('Feed is unavailable because its production read service is not configured.');
    return;
  }

  const generation = ++loadGeneration;
  loading.value = true;
  pageError.value = undefined;
  announcer.announce('Loading Feed facts.');
  try {
    // Load the canonical scope catalog first so an old URL can never widen or
    // alias a real Project when its identity is no longer present.
    const allScopes = await currentApi.load({ scope: FEED_ALL_SCOPE });
    if (generation !== loadGeneration) return;
    scopeOptions.value = allScopes.scopes;
    const requested = queryString(route.query['scope']) ?? FEED_ALL_SCOPE;
    const selected = allScopes.scopes.some((option) => option.id === requested)
      ? requested
      : FEED_ALL_SCOPE;
    activeScope.value = selected;
    activeUrgency.value = queryUrgency(route.query['urgency']);
    activeActivity.value = queryActivity(route.query['activity']);
    const result = selected === FEED_ALL_SCOPE
      ? allScopes
      : await currentApi.load({ scope: selected });
    if (generation !== loadGeneration) return;
    snapshot.value = result;
    scopeOptions.value = result.scopes;
    pageError.value = undefined;
    loaded.value = true;
    announceSnapshot(result);
  } catch (error) {
    if (generation !== loadGeneration) return;
    pageError.value = safeErrorKind(error);
    loaded.value = true;
    announcer.announce(`${errorHeading(pageError.value)}. ${errorDescription(pageError.value)}`);
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}

async function loadScope(scope: string, clearCurrent: boolean): Promise<void> {
  const currentApi = api.value;
  if (!currentApi) return;
  const generation = ++loadGeneration;
  loading.value = true;
  pageError.value = undefined;
  if (clearCurrent) snapshot.value = undefined;
  announcer.announce(`Loading Feed for ${scopeLabel.value}.`);
  try {
    const result = await currentApi.load({ scope });
    if (generation !== loadGeneration) return;
    scopeOptions.value = result.scopes;
    if (!result.scopes.some((option) => option.id === scope)) {
      activeScope.value = FEED_ALL_SCOPE;
      const all = scope === FEED_ALL_SCOPE ? result : await currentApi.load({ scope: FEED_ALL_SCOPE });
      if (generation !== loadGeneration) return;
      snapshot.value = all;
      pageError.value = undefined;
      announceSnapshot(all);
      return;
    }
    snapshot.value = result;
    pageError.value = undefined;
    announceSnapshot(result);
  } catch (error) {
    if (generation !== loadGeneration) return;
    pageError.value = safeErrorKind(error);
    announcer.announce(`${errorHeading(pageError.value)}. ${errorDescription(pageError.value)}`);
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}

function retry(): void {
  if (snapshot.value === undefined) void loadInitial();
  else void loadScope(activeScope.value, false);
}

function updateFeedUrl(): void {
  const resolved = router.resolve({ name: 'feed', query: feedQuery.value });
  if (resolved.fullPath !== route.fullPath) {
    void router.replace({ name: 'feed', query: feedQuery.value });
  }
}

async function navigateTo(target: FeedTarget | undefined, label: string): Promise<void> {
  const destination = targetLocation(target);
  if (!destination) {
    announcer.announce('This Feed item has no validated destination.');
    return;
  }
  appStore.setReturnContext({
    title: 'Back to Feed',
    to: router.resolve({ name: 'feed', query: feedQuery.value }).fullPath,
  });
  announcer.announce(`Opening ${label}.`);
  await router.push(destination);
  await nextTick();
  announcer.announce(`Opened ${label}. Back to Feed is available.`);
}

watch(activeScope, (scope, previous) => {
  if (!loaded.value || scope === previous) return;
  void loadScope(scope, true);
});

watch([activeScope, activeUrgency, activeActivity], () => {
  if (loaded.value) updateFeedUrl();
});

watch(
  () => [route.query['scope'], route.query['urgency'], route.query['activity']] as const,
  ([scope, urgency, activity]) => {
    if (!loaded.value) return;
    const requestedScope = queryString(scope) ?? FEED_ALL_SCOPE;
    activeScope.value = scopeOptions.value.some((option) => option.id === requestedScope)
      ? requestedScope
      : FEED_ALL_SCOPE;
    activeUrgency.value = queryUrgency(urgency);
    activeActivity.value = queryActivity(activity);
  },
);

watch([activeUrgency, activeActivity], () => {
  if (snapshot.value) {
    announcer.announce(
      `Feed filters updated. ${visibleAttention.value.length} Attention items and ${activityItems.value.length} activity items shown.`,
    );
  }
});

onMounted(() => {
  void nextTick(() => heading.value?.focus());
  void loadInitial();
});
</script>

<template>
  <div class="feed-view min-h-full bg-[var(--bg-app)]" :data-state="pageState" :aria-busy="loading">
    <div class="mx-auto flex w-full max-w-[1920px] flex-col gap-4 p-4 pb-28 sm:p-6 md:pb-8">
      <header class="flex flex-col gap-3 border-b border-[var(--border-subtle)] pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <h1 ref="heading" tabindex="-1" class="flex items-center gap-2 text-lg font-bold text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--border-focus)] sm:text-xl">
            <Icon name="feed" :size="20" /> Operations Feed & Human Attention
          </h1>
          <p class="mt-1 text-xs text-[var(--text-secondary)]">A read-only view of work that needs attention, work in progress, and recent operational activity.</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <label for="feed-scope-select" class="sr-only">Project scope</label>
          <select
            id="feed-scope-select"
            v-model="activeScope"
            class="min-h-[44px] min-w-[12rem] max-w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 text-sm text-[var(--text-primary)]"
            :disabled="scopeOptions.length === 0 || pageState === 'unavailable'"
          >
            <option v-for="scope in scopeOptions" :key="scope.id" :value="scope.id">
              {{ scope.label }} · {{ scope.attentionCount }} Attention
            </option>
          </select>
          <span class="inline-flex min-h-[44px] items-center gap-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 text-xs text-[var(--text-secondary)]" :data-connection="connection.status">
            <StatusDot :status="connection.status" size="sm" />
            <span>{{ connection.label }}</span>
          </span>
          <Button variant="secondary" size="sm" class="min-h-[44px]" :disabled="loading || pageState === 'unavailable'" @click="retry">
            <Icon name="refresh" :size="14" /><span>Refresh</span>
          </Button>
        </div>
      </header>

      <div v-if="connection.label !== 'Operator Online'" class="rounded border border-[var(--yellow-attention-border)] bg-[var(--bg-surface)] p-3 text-xs text-[var(--text-secondary)]" :data-connection-notice="connection.status">
        <strong class="text-[var(--text-primary)]">{{ connection.label }}.</strong> {{ connection.announce }}
      </div>

      <section v-if="pageState === 'unavailable'" class="rounded border border-[var(--yellow-attention-border)] bg-[var(--bg-surface)] p-4" aria-labelledby="feed-unavailable-heading">
        <h2 id="feed-unavailable-heading" class="font-bold">Feed is unavailable</h2>
        <p class="mt-1 text-sm text-[var(--text-secondary)]">The production Feed read service is not configured for this page.</p>
      </section>
      <section v-else-if="pageState === 'loading'" class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6" aria-labelledby="feed-loading-heading">
        <h2 id="feed-loading-heading" class="font-bold">Loading Feed</h2>
        <p class="mt-1 text-sm text-[var(--text-secondary)]">Reading current Attention, in-flight work, Project scopes, and activity.</p>
      </section>
      <section v-else-if="pageState === 'offline' || pageState === 'failure'" class="rounded border border-[var(--red-action-border)] bg-[var(--bg-surface)] p-4" :data-error-kind="pageError" aria-labelledby="feed-error-heading">
        <h2 id="feed-error-heading" class="font-bold">{{ errorHeading(pageError ?? 'failure') }}</h2>
        <p class="mt-1 text-sm text-[var(--text-secondary)]">{{ errorDescription(pageError ?? 'failure') }}</p>
        <Button variant="secondary" size="sm" class="mt-3 min-h-[44px]" @click="retry">Retry Feed</Button>
      </section>
      <div v-else-if="pageError" class="rounded border border-[var(--yellow-attention-border)] bg-[var(--bg-surface)] p-3 text-sm text-[var(--text-secondary)]" data-refresh-warning>
        The latest refresh failed. Showing the last Feed snapshot from {{ scopeLabel }}.
        <Button variant="secondary" size="sm" class="ml-2 min-h-[44px]" @click="retry">Retry</Button>
      </div>

      <section v-if="unreadConversations.length" class="mb-4 flex flex-col gap-2" aria-label="Unread conversations">
        <h2 class="text-sm font-bold">Unread conversations</h2>
        <div class="flex flex-wrap gap-2">
          <RouterLink v-for="scope in unreadConversations" :key="scope.scopeId" :data-unread-scope="scope.scopeId" :to="{ name: 'project-chat-scope', params: { scopeId: scope.scopeId }, query: { project: scope.projectId } }" class="flex min-h-11 items-center gap-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 text-xs focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]">
            <Icon name="chat" :size="14" /> {{ projectName(scope.projectId) }} · Conversation <UnreadBadge :count="scope.count" />
          </RouterLink>
        </div>
      </section>
      <p v-else-if="unread && !unread.available.value" class="mb-2 text-xs text-[var(--text-muted)]" role="status">Unread counts unavailable.</p>
      <template v-if="snapshot">
        <div v-if="pageState === 'empty'" class="rounded border border-[var(--green-ready-border)] bg-[var(--green-ready-bg)] p-4 text-sm text-[var(--text-primary)]" data-empty-state>
          No Attention, in-flight work, or activity is currently recorded for {{ scopeLabel }}.
        </div>

        <div class="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.85fr)]">
          <div class="flex min-w-0 flex-col gap-4">
            <section class="flex min-w-0 flex-col gap-3" aria-labelledby="feed-attention-heading">
              <div class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-3">
                <div class="flex items-center gap-2">
                  <Icon name="alert" :size="18" class="text-[var(--yellow-attention)]" />
                  <h2 id="feed-attention-heading" class="text-sm font-bold">Human Attention</h2>
                  <Badge variant="red">{{ attentionCounts.action_required }} Action</Badge>
                  <Badge variant="yellow">{{ attentionCounts.attention }} Attention</Badge>
                  <Badge variant="info">{{ attentionCounts.info }} Info</Badge>
                </div>
                <span class="text-[11px] text-[var(--text-muted)]">Actions stay on their authoritative pages</span>
              </div>

              <div class="flex flex-wrap gap-2" role="group" aria-label="Filter Attention by urgency">
                <button v-for="urgency in urgencyChoices" :key="urgency" type="button" class="min-h-[44px] rounded border px-3 text-xs focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]" :class="activeUrgency === urgency ? 'border-[var(--accent-primary)] bg-[var(--accent-bg)] font-bold text-[var(--text-primary)]' : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]'" :aria-pressed="activeUrgency === urgency" @click="activeUrgency = urgency">
                  {{ urgency === 'all' ? 'All' : severityLabel(urgency) }} ({{ attentionCounts[urgency] }})
                </button>
              </div>

              <div v-if="visibleAttention.length" class="grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-2">
                <button v-for="item in visibleAttention" :key="item.id" type="button" class="min-h-[132px] rounded border border-l-4 border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 text-left shadow-xs transition-colors hover:border-[var(--border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]" :class="severityBorder(item.severity)" :data-attention-id="item.id" @click="navigateTo(item.target, item.reason)">
                  <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div class="flex flex-wrap items-center gap-2">
                      <Badge :variant="severityVariant(item.severity)">{{ severityLabel(item.severity) }}</Badge>
                      <Badge variant="secondary">{{ categoryLabel(item.category) }}</Badge>
                      <Badge v-if="projectName(item.target.projectId)" variant="info">{{ projectName(item.target.projectId) }}</Badge>
                    </div>
                    <time v-if="isoTime(item.at)" class="text-[10px] text-[var(--text-muted)]" :datetime="isoTime(item.at)">{{ shortTime(item.at) }}</time>
                  </div>
                  <strong class="block text-sm leading-snug text-[var(--text-primary)]">{{ item.reason }}</strong>
                  <p class="mt-2 text-xs text-[var(--text-secondary)]">{{ item.lifecycle }}</p>
                </button>
              </div>
              <EmptyState v-else icon="check" :title="activeUrgency === 'all' ? 'All clear in this scope' : 'No matching Attention items'" :description="activeUrgency === 'all' ? 'No unresolved source currently requires Human attention.' : 'Choose another urgency filter to see the remaining Attention items.'" />
            </section>

            <section class="flex min-w-0 flex-col gap-3" aria-labelledby="feed-inflight-heading">
              <div class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-3">
                <div class="flex items-center gap-2">
                  <Icon name="tasks" :size="18" />
                  <h2 id="feed-inflight-heading" class="text-sm font-bold">In-flight Work</h2>
                  <Badge variant="info">{{ inFlightItems.length }} Active</Badge>
                </div>
                <span class="text-[11px] text-[var(--text-muted)]">Identity, configuration, and lifecycle</span>
              </div>
              <div v-if="inFlightItems.length" class="grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-2">
                <template v-for="item in inFlightItems" :key="item.id">
                  <button v-if="targetLocation(item.target)" type="button" class="min-h-[92px] rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 text-left transition-colors hover:border-[var(--border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]" :data-inflight-id="item.id" @click="navigateTo(item.target, sourceLabel(item))">
                    <div class="flex flex-wrap items-center justify-between gap-2"><Badge variant="info">{{ item.kind === 'task' ? 'Task' : 'Agent run' }}</Badge><span v-if="projectName(item.projectId)" class="text-xs text-[var(--text-muted)]">{{ projectName(item.projectId) }}</span></div>
                    <strong class="mt-2 block text-sm text-[var(--text-primary)]">{{ sourceLabel(item) }}</strong>
                    <p class="mt-1 text-xs text-[var(--text-secondary)]">Engine: {{ item.engine ?? 'unavailable' }} · Model: {{ item.model ?? 'unavailable' }}</p>
                    <p class="mt-1 text-xs text-[var(--text-secondary)]">Elapsed {{ elapsedDuration(item.at) }}</p>
                    <p class="mt-1 text-xs text-[var(--text-secondary)]">{{ item.lifecycle }}</p>
                  </button>
                  <article v-else class="min-h-[92px] rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4" :data-inflight-id="item.id">
                    <Badge variant="info">{{ item.kind === 'task' ? 'Task' : 'Agent run' }}</Badge>
                    <strong class="mt-2 block text-sm text-[var(--text-primary)]">{{ sourceLabel(item) }}</strong>
                    <p class="mt-1 text-xs text-[var(--text-secondary)]">Engine: {{ item.engine ?? 'unavailable' }} · Model: {{ item.model ?? 'unavailable' }}</p>
                    <p class="mt-1 text-xs text-[var(--text-secondary)]">Elapsed {{ elapsedDuration(item.at) }}</p>
                    <p class="mt-1 text-xs text-[var(--text-secondary)]">{{ item.lifecycle }}</p>
                  </article>
                </template>
              </div>
              <EmptyState v-else icon="tasks" title="No in-flight work" description="No Task is beginning or running and no Agent run is queued or running in this scope." />
            </section>
          </div>

          <section class="flex min-w-0 flex-col gap-3" aria-labelledby="feed-activity-heading">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-3">
              <div class="flex items-center gap-2">
                <Icon name="lightning" :size="18" />
                <h2 id="feed-activity-heading" class="text-sm font-bold">Operational Activity</h2>
                <Badge variant="info">{{ activityItems.length }} Shown</Badge>
              </div>
              <span class="text-[11px] text-[var(--text-muted)]">Sanitized facts · newest first</span>
            </div>
            <div class="flex flex-wrap gap-2" role="group" aria-label="Filter operational activity">
              <button v-for="group in activityChoices" :key="group" type="button" class="min-h-[44px] rounded border px-2.5 text-xs focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]" :class="activeActivity === group ? 'border-[var(--accent-primary)] bg-[var(--accent-bg)] font-bold text-[var(--text-primary)]' : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)]'" :aria-pressed="activeActivity === group" @click="activeActivity = group">
                {{ activityGroupLabel(group) }} ({{ activityCounts[group] }})
              </button>
            </div>
            <ol v-if="activityItems.length" class="flex flex-col gap-2" aria-label="Recent operational activity">
              <li v-for="item in activityItems" :key="item.id" class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
                <button v-if="targetLocation(item.target)" type="button" class="flex min-h-[64px] w-full items-start gap-3 p-3 text-left transition-colors hover:bg-[var(--bg-surface-elevated)] focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]" :data-activity-id="item.id" @click="navigateTo(item.target, activityGroupLabel(activityGroup(item)))">
                  <UnreadBadge :count="activityUnread(item.target)" />
                  <StatusDot status="blue" size="sm" class="mt-1 shrink-0" />
                  <span class="min-w-0 flex-1">
                    <span class="flex flex-wrap items-center gap-2"><Badge variant="secondary">{{ activityGroupLabel(activityGroup(item)) }}</Badge><span v-if="projectName(item.projectId)" class="text-[10px] text-[var(--text-muted)]">{{ projectName(item.projectId) }}</span></span>
                    <span class="mt-1 block text-xs text-[var(--text-primary)]">{{ item.summary }}</span>
                  </span>
                  <time v-if="isoTime(item.at)" class="shrink-0 text-[10px] text-[var(--text-muted)]" :datetime="isoTime(item.at)">{{ shortTime(item.at) }}</time>
                </button>
                <div v-else class="flex min-h-[64px] items-start gap-3 p-3" :data-activity-id="item.id">
                  <StatusDot status="blue" size="sm" class="mt-1 shrink-0" />
                  <span class="min-w-0 flex-1">
                    <span class="flex flex-wrap items-center gap-2"><Badge variant="secondary">{{ activityGroupLabel(activityGroup(item)) }}</Badge><span v-if="projectName(item.projectId)" class="text-[10px] text-[var(--text-muted)]">{{ projectName(item.projectId) }}</span></span>
                    <span class="mt-1 block text-xs text-[var(--text-primary)]">{{ item.summary }}</span>
                  </span>
                  <time v-if="isoTime(item.at)" class="shrink-0 text-[10px] text-[var(--text-muted)]" :datetime="isoTime(item.at)">{{ shortTime(item.at) }}</time>
                </div>
              </li>
            </ol>
            <EmptyState v-else icon="lightning" title="No matching activity" description="No sanitized activity facts match this scope and activity filter." />
          </section>
        </div>
      </template>
    </div>
  </div>
</template>
