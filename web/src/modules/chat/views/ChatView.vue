<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { MessageView, ProjectEventView } from '../../../../../src/web/views.ts';
import type { ConversationScopeView, ScopeInspectionView, TaskGroupScopeView } from '../../../adapters/conversation-api.ts';
import { isEndedTaskStatus } from '../../../../../src/task/model.ts';
import type { RoutingBatchSummaryView, RoutingEvidenceView } from '../../../adapters/routing-api.ts';
import type { ProjectAuthorityView } from '../../../adapters/project-api.ts';
import { AGENT_SERVICE, type AgentInstance } from '../../agents/types.ts';
import { PROJECT_SERVICE } from '../../projects/types.ts';
import { CHAT_SERVICE, type ChatTimelineItem } from '../types.ts';
import { evidenceState, readOnlyReason } from '../evidence.ts';
import { useShellConnection } from '../../../shell/use-shell-connection.ts';
import { useConnectionNotice } from '../../../shell/use-connection-notice.ts';
import { useAnnouncer } from '../../../primitives/announcer.ts';
import Icon from '../../../primitives/Icon.vue';
import Button from '../../../primitives/Button.vue';
import ChatDialog from './ChatDialog.vue';
import EmptyState from '../../../primitives/EmptyState.vue';
import { useUnreadState } from '../unread-state.ts';
import UnreadBadge from '../UnreadBadge.vue';
import { useTimelineScroll } from '../use-timeline-scroll.ts';
import { newDeliveryKey } from '../../../utils/delivery-key.ts';
import { messageDateSeparators } from '../date-separators.ts';

const route = useRoute();
const router = useRouter();
const service = inject(CHAT_SERVICE, null);
const projectService = inject(PROJECT_SERVICE, null);
const agentService = inject(AGENT_SERVICE, null);
const { presentation, state: connectionState } = useShellConnection();
const announcer = useAnnouncer();
const projects = ref<readonly ProjectAuthorityView[]>([]);
const agents = ref<readonly AgentInstance[]>([]);
const scopes = ref<readonly ConversationScopeView[]>([]);
const messages = ref<readonly MessageView[]>([]);
const events = ref<readonly ProjectEventView[]>([]);
const activeRuns = ref<readonly { readonly id: string; readonly agentId: string; readonly status: 'queued' | 'running' }[]>([]);
const activeRunsLoading = ref(true);
const activeRunsKnown = ref(false);
const stoppingRunIds = ref<ReadonlySet<string>>(new Set());
const batches = ref<readonly RoutingBatchSummaryView[]>([]);
const inspection = ref<ScopeInspectionView | null>(null);
const loading = ref(true);
const detailLoading = ref(false);
// Admission affects authority and assistive status immediately; only visual display is delayed.
const showAdmissionNotice = useConnectionNotice(computed(() => !detailLoading.value));
const error = ref('');
const actionError = ref('');
const newMessage = ref('');
let pendingDelivery: { readonly scopeId: string; readonly body: string; readonly deliveryKey: string } | null = null;
const sending = ref(false);
const infoOpen = ref(false);
const createGroupOpen = ref(false);
const editGroupOpen = ref(false);
const disbandConfirm = ref(false);
const editName = ref('');
const editGoal = ref('');
const editRules = ref('');
const editMembers = ref<string[]>([]);
const groupName = ref('');
const groupGoal = ref('');
const groupMembers = ref<string[]>([]);
const managingGroup = ref(false);
const evidenceOpen = ref<string | null>(null);
const evidence = ref<RoutingEvidenceView | null>(null);
const evidenceLoading = ref(false);
const provenance = ref<{ runId?: string; runStatus?: string; failureReason?: string; inputIds: readonly string[]; batchId?: string } | null>(null);
const evidenceTrigger = ref<HTMLElement | null>(null);
const unreadState = useUnreadState();
const viewportWidth = ref(typeof window === 'undefined' ? 0 : window.innerWidth);
function onResize() { viewportWidth.value = window.innerWidth; void markVisible(); }
const knownEvents = new Set<string>();
let generation = 0;
let detailGeneration = 0;
let timelineGeneration = 0;
let activeRunGeneration = 0;
let activeRunScopeId = '';
let inspectedScopeKey = '';
let unsubRuns: (() => void) | undefined;
const refreshTimers = new Set<ReturnType<typeof setTimeout>>();
type ChatMessagePageState = { readonly hasOlder: boolean; readonly loading: boolean; readonly limited: boolean; readonly pagedOlder: boolean };
type ChatTimelinePageState = {
  projectId: string;
  scopeId: string;
  visibleIds: Set<string>;
  messageCursor?: string;
  eventCursor?: string;
  messageHasOlder: boolean;
  eventHasOlder: boolean;
  loading: boolean;
  limited: boolean;
  pagedOlder: boolean;
};
type ChatEventPage = Awaited<ReturnType<ChatService['listProjectEvents']>>;
const messagePages = ref<Record<string, ChatMessagePageState>>({});
const timelinePaging = ref<ChatTimelinePageState | null>(null);
const CHAT_MESSAGE_PAGE_SIZE = 50;
const CHAT_TIMELINE_MEMORY_LIMIT = 200;
// The Message port has no arrival signal. Observe the selected Project at a
// bounded cadence while visible; run-coupled replies keep their fast follow-ups.
const CHAT_POLL_MS = 15000;
const CHAT_ADMISSION_RUN_RETRY_MS = [250, 750, 1500] as const;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let refreshInFlight = false;
const requestedScopeId = computed(() => typeof route.params['scopeId'] === 'string' ? route.params['scopeId'] as string : '');
const requestedMessageId = computed(() => typeof route.query['message'] === 'string' ? route.query['message'] : '');
const requestedEventId = computed(() => typeof route.query['event'] === 'string' ? route.query['event'] : '');
const targetAnnouncement = ref('');
const projectId = computed(() => typeof route.query['project'] === 'string' ? route.query['project'] as string : projects.value.find((p) => p.status === 'active')?.id ?? projects.value[0]?.id ?? '');
const project = computed(() => projects.value.find((p) => p.id === projectId.value));
const channelScopes = computed(() => scopes.value.filter((s) => s.kind === 'project'));
const taskGroups = computed(() => scopes.value.filter((s) => s.kind === 'task-group'));
const activeTaskGroups = computed(() => taskGroups.value.filter((scope) => !isClosedTaskGroup(scope)));
const closedTaskGroups = computed(() => taskGroups.value.filter(isClosedTaskGroup));
const closedTaskGroupsExpanded = ref(false);
const workingGroups = computed(() => scopes.value.filter((s) => s.kind === 'working-group'));
const directScopes = computed(() => scopes.value.filter((s) => s.kind === 'direct'));
type ChatScopeSection =
  | { readonly kind: 'scopes'; readonly label: string; readonly items: readonly ConversationScopeView[] }
  | { readonly kind: 'closed-tasks'; readonly label: string; readonly items: readonly TaskGroupScopeView[] };
const scopeSections = computed<readonly ChatScopeSection[]>(() => [
  { kind: 'scopes', label: 'Project Channels', items: channelScopes.value },
  { kind: 'scopes', label: `Task Groups (${activeTaskGroups.value.length})`, items: activeTaskGroups.value },
  ...(closedTaskGroups.value.length ? [{
    kind: 'closed-tasks' as const,
    label: `Closed tasks (${closedTaskGroups.value.length})`,
    items: closedTaskGroups.value,
  }] : []),
  { kind: 'scopes', label: `Working Groups (${workingGroups.value.length})`, items: workingGroups.value },
  { kind: 'scopes', label: `Direct Messages (${directScopes.value.length + unopenedAgents.value.length})`, items: directScopes.value },
]);
const activeAgentMembers = computed(() => project.value && currentVersion(project.value)?.memberships.filter((m) => m.memberKind === 'agent' && m.endedAt === undefined) || []);
const unopenedAgents = computed(() => {
  return activeAgentMembers.value.filter((member) => !directScopes.value.some((scope) => scope.kind === 'direct' && scope.participants.includes(member.memberId)));
});
const missingScope = computed(() => !!requestedScopeId.value && !loading.value && !scopes.value.some((s) => s.id === requestedScopeId.value));
const activeScope = computed(() => requestedScopeId.value ? scopes.value.find((s) => s.id === requestedScopeId.value) : channelScopes.value[0] ?? scopes.value[0]);
// The selection identity the admission read follows: a background refresh that
// replaces the scope list with the same records is not a selection change.
const activeScopeId = computed(() => activeScope.value?.id ?? '');
const activeGroup = computed(() => activeScope.value?.kind === 'working-group' ? activeScope.value : null);
const archivedDirectAgent = computed(() => {
  const scope = activeScope.value;
  return scope?.kind === 'direct' ? agents.value.find((agent) => agent.status === 'archived' && scope.participants.includes(agent.id)) : undefined;
});
const activeMessages = computed(() => messages.value.filter((m) => m.scopeId === activeScope.value?.id));
function compareStableId(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }
function timelineEntryId(entry: ChatTimelineItem) { return entry.kind === 'message' ? entry.message.id : entry.event.id; }
function timelineEntryKey(entry: ChatTimelineItem) { return `${entry.kind}:${timelineEntryId(entry)}`; }
function compareTimelineItems(left: ChatTimelineItem, right: ChatTimelineItem) {
  const leftTime = left.kind === 'message' ? left.message.createdAt : left.event.createdAt;
  const rightTime = right.kind === 'message' ? right.message.createdAt : right.event.createdAt;
  return leftTime - rightTime || compareStableId(timelineEntryId(left), timelineEntryId(right)) || compareStableId(left.kind, right.kind);
}
const timeline = computed<ChatTimelineItem[]>(() => [
  ...activeMessages.value.map((message) => ({ kind: 'message' as const, message })),
  ...events.value.filter((event) => activeScope.value?.kind === 'project' || event.originScopeIds?.includes(activeScopeId.value)).map((event) => ({ kind: 'event' as const, event })),
].sort(compareTimelineItems));
const visibleTimeline = computed(() => {
  const page = timelinePaging.value;
  return page?.scopeId === activeScopeId.value && page.projectId === projectId.value
    ? timeline.value.filter((entry) => page.visibleIds.has(timelineEntryKey(entry)))
    : [];
});
const { viewport: messageViewport, content: messageContent, hasNewEntries, onScroll: onMessageScroll, jumpToLatest, noteHistory: noteTimelineHistory, scrollProgrammatically, consumeProgrammaticScroll } = useTimelineScroll(
  computed(() => `${projectId.value}|${activeScopeId.value}|${requestedScopeId.value}`),
  computed(() => visibleTimeline.value.map(timelineEntryKey)),
  computed(() => !!requestedMessageId.value || !!requestedEventId.value),
);
const dateSeparators = computed(() => messageDateSeparators(
  visibleTimeline.value.map((entry) => ({
    id: timelineEntryKey(entry),
    createdAt: entry.kind === 'message' ? entry.message.createdAt : entry.event.createdAt,
  })), Date.now(),
));
const activeChatRuns = computed(() => activeRuns.value.filter((run) => run.status === 'queued' || run.status === 'running'));
const canSend = computed(() => !!service && !!activeScope.value && !archivedDirectAgent.value && !detailLoading.value && activeRunsKnown.value && !activeRunsLoading.value && activeChatRuns.value.length === 0 && inspection.value?.scope.id === activeScope.value.id && inspection.value.state.writable && presentation.value.controlAvailable && !sending.value);
// A background read may refuse Send, but must not interrupt draft entry.
const canEnterText = computed(() => !!service && !!activeScope.value && !archivedDirectAgent.value && inspection.value?.state.writable !== false && connectionState.value.connection !== 'offline');
const currentEvidenceState = computed(() => evidence.value ? evidenceState(evidence.value, evidenceMessage.value ?? undefined, provenance.value?.runStatus) : 'informational');
const evidenceMessage = computed(() => messages.value.find((m) => m.id === evidenceOpen.value));

function currentVersion(p: ProjectAuthorityView) { return p.content.versions.find((v) => v.version === p.content.currentVersion) ?? p.content.versions.at(-1); }
function title(scope: ConversationScopeView): string {
  if (scope.kind === 'project') return '#general';
  if (scope.kind === 'task-group') return scope.taskTitle;
  if (scope.kind === 'working-group') return scope.content.versions.find((v) => v.version === scope.content.currentVersion)?.displayName ?? scope.id;
  const humanIds = new Set(project.value && currentVersion(project.value)?.memberships.filter((m) => m.memberKind === 'human').map((m) => m.memberId));
  const agentParticipants = scope.participants.filter(p => !humanIds.has(p));
  return agentParticipants.map(id => `@${agentName(id)}`).join(' ↔ ') || scope.id;
}
function agentName(id: string) { return agents.value.find((agent) => agent.id === id)?.displayName ?? id; }
function kindLabel(scope: ConversationScopeView) { return scope.kind === 'project' ? 'Project channel' : scope.kind === 'task-group' ? 'Task group' : scope.kind === 'working-group' ? 'Working group' : 'Direct message'; }
function icon(scope: ConversationScopeView) { return scope.kind === 'project' ? 'chat' : scope.kind === 'direct' ? 'agents' : 'project'; }
function preview(scope: ConversationScopeView) {
  const last = [...messages.value].reverse().find((m) => m.scopeId === scope.id);
  return last?.body ?? (scope.kind === 'working-group' ? scope.content.versions.at(-1)?.goal : scope.kind === 'task-group' ? scope.content.versions.at(-1)?.goal : undefined) ?? 'No messages yet in this conversation.';
}
function latestTime(scope: ConversationScopeView) { const last = [...messages.value].reverse().find((m) => m.scopeId === scope.id); return last ? time(last.createdAt) : ''; }
function time(at: number) { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function unread(scope: ConversationScopeView) { return scopePill(scope) ? 0 : unreadState?.count(scope.id) ?? 0; }
async function markVisible() {
  const id = activeScopeId.value;
  const token = generation;
  await nextTick();
  if (token !== generation || id !== activeScopeId.value || loading.value || error.value || detailLoading.value
    || document.visibilityState === 'hidden' || (!requestedScopeId.value && viewportWidth.value < 768)
    || inspection.value?.scope.id !== id) return;
  await unreadState?.markRead(id, visibleTimeline.value.flatMap((entry) => entry.kind === 'message' ? [entry.message.id] : []));
}
function scopeKind(scope: ConversationScopeView) { return scope.kind === 'project' ? 'channel' : scope.kind === 'direct' ? 'direct-message' : scope.kind; }
function isClosedTaskGroup(scope: ConversationScopeView): scope is TaskGroupScopeView {
  return scope.kind === 'task-group'
    && scope.terminalTaskStatus !== undefined
    && isEndedTaskStatus(scope.terminalTaskStatus);
}
function isTargetEntry(entry: ChatTimelineItem) {
  return entry.kind === 'message'
    ? requestedMessageId.value !== '' && entry.message.id === requestedMessageId.value
    : requestedEventId.value !== '' && entry.event.id === requestedEventId.value;
}
function scopePill(scope: ConversationScopeView) {
  if (scope.kind === 'task-group') return scope.status === 'frozen' ? 'Frozen' : '';
  if (scope.kind === 'working-group') return scope.status === 'disbanded' ? 'Disbanded' : '';
  if (scope.kind !== 'direct' || !project.value) return '';
  const member = currentVersion(project.value)?.memberships.find((item) => scope.participants.includes(item.memberId) && item.memberKind === 'agent');
  if (member?.endedAt) return 'Ended';
  if (member && agents.value.find((agent) => agent.id === member.memberId)?.status === 'archived') return 'Archived';
  return '';
}
function safeError() { return 'Could not load current Chat facts. Retry when the connection is available.'; }
async function refreshActiveRuns() {
  const scopeId = activeScopeId.value;
  const token = ++activeRunGeneration;
  if (activeRunScopeId !== scopeId) {
    activeRunScopeId = scopeId;
    activeRuns.value = [];
  }
  if (!service || !scopeId) {
    activeRuns.value = [];
    activeRunsKnown.value = true;
    activeRunsLoading.value = false;
    return;
  }
  activeRunsLoading.value = true;
  activeRunsKnown.value = false;
  try {
    const projected = await service.listActiveRuns(scopeId);
    if (token === activeRunGeneration && scopeId === activeScopeId.value) {
      activeRuns.value = projected;
      activeRunsKnown.value = true;
    }
  } catch {
    if (token === activeRunGeneration && scopeId === activeScopeId.value) {
      actionError.value = 'Active Agent run state could not be verified. Sending is disabled.';
    }
  } finally {
    if (token === activeRunGeneration && scopeId === activeScopeId.value) activeRunsLoading.value = false;
  }
}
async function refreshActiveRunsAfterSend(scopeId: string, admittedRunIds: readonly string[]) {
  const admittedRunIsActive = () => activeRuns.value.some((run) => admittedRunIds.includes(run.id));
  await refreshActiveRuns();
  if (admittedRunIds.length === 0 || admittedRunIsActive()) return;

  for (const delay of CHAT_ADMISSION_RUN_RETRY_MS) {
    if (!sending.value || activeScopeId.value !== scopeId) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        refreshTimers.delete(timer);
        resolve();
      }, delay);
      refreshTimers.add(timer);
    });
    if (!sending.value || activeScopeId.value !== scopeId) return;
    await refreshActiveRuns();
    if (admittedRunIsActive()) return;
  }
}
async function projectMessages(scopeList: readonly ConversationScopeView[]) {
  if (!service) return { messages: [] as MessageView[], hasOlder: {} as Record<string, boolean> };
  const pages = await Promise.all(scopeList.map(async (scope) => {
    const rows = await service!.listMessages(scope.id, { limit: CHAT_MESSAGE_PAGE_SIZE });
    return { scopeId: scope.id, rows, hasOlder: rows.length === CHAT_MESSAGE_PAGE_SIZE };
  }));
  return {
    messages: pages.flatMap((page) => page.rows),
    hasOlder: Object.fromEntries(pages.map((page) => [page.scopeId, page.hasOlder])),
  };
}
function mergeMessageWindows(current: readonly MessageView[], incoming: readonly MessageView[], forProjectId: string) {
  const messagesById = new Map<string, MessageView>();
  for (const message of [...current, ...incoming]) if (message.projectId === forProjectId) messagesById.set(message.id, message);
  const byScope = new Map<string, MessageView[]>();
  for (const message of messagesById.values()) byScope.set(message.scopeId, [...(byScope.get(message.scopeId) ?? []), message]);
  return [...byScope.entries()].flatMap(([scopeId, rows]) => {
    const retainedOlder = messagePages.value[scopeId]?.pagedOlder === true;
    // Active source rows include unconsumed buffers. The merged visible cap is
    // enforced below; trimming a source here could skip its next history row.
    const limit = scopeId !== activeScopeId.value ? 1 : retainedOlder ? Infinity : CHAT_MESSAGE_PAGE_SIZE;
    return rows.sort((left, right) => left.createdAt - right.createdAt || compareStableId(left.id, right.id)).slice(-limit);
  });
}
function mergeEventWindows(current: readonly ProjectEventView[], incoming: readonly ProjectEventView[], forProjectId: string) {
  const eventsById = new Map<string, ProjectEventView>();
  for (const event of [...current, ...incoming]) if (event.projectId === forProjectId) eventsById.set(event.id, event);
  return [...eventsById.values()]
    .sort((left, right) => left.createdAt - right.createdAt || compareStableId(left.id, right.id));
}
function mergeTimelineRows(messageRows: readonly MessageView[], eventRows: readonly ProjectEventView[]) {
  return [
    ...messageRows.map((message) => ({ kind: 'message' as const, message })),
    ...eventRows.map((event) => ({ kind: 'event' as const, event })),
  ].sort(compareTimelineItems);
}
function timelinePageState(scopeId: string, eventPage: ChatEventPage, markHistory = false): ChatTimelinePageState {
  const messageRows = activeMessages.value;
  const eventRows = eventPage.events;
  const newest = mergeTimelineRows(messageRows, eventRows).slice(-CHAT_MESSAGE_PAGE_SIZE);
  if (markHistory) noteTimelineHistory(newest.map((entry) => `${entry.kind}:${timelineEntryId(entry)}`));
  const oldestMessage = [...messageRows].sort((left, right) => left.createdAt - right.createdAt || compareStableId(left.id, right.id))[0];
  const messagePage = messagePages.value[scopeId];
  return {
    projectId: projectId.value,
    scopeId,
    visibleIds: new Set(newest.map(timelineEntryKey)),
    ...(oldestMessage !== undefined ? { messageCursor: oldestMessage.id } : {}),
    ...(eventRows[0] !== undefined ? { eventCursor: eventRows[0].id } : {}),
    messageHasOlder: messagePage?.hasOlder === true && messagePage.limited !== true,
    eventHasOlder: eventPage.hasOlder,
    loading: false,
    limited: false,
    pagedOlder: false,
  };
}
function eventOriginScopeId(scope: ConversationScopeView | undefined) {
  return scope?.kind === 'project' || scope === undefined ? undefined : scope.id;
}
let userScrollUntil = 0;
let loadingTimelineScopeId = '';
let pendingTimelinePageScopeId = '';
let pendingTimelinePageUntil = 0;
watch(activeScopeId, () => {
  userScrollUntil = 0;
  pendingTimelinePageScopeId = '';
}, { flush: 'sync' });
function onScrollInput(event: Event) {
  if (event instanceof KeyboardEvent && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
  if (event.type.startsWith('pointer') && (event as PointerEvent).buttons === 0) return;
  // Input may precede native scroll delivery. This is an intent expiry, not a
  // paging cooldown: every new gesture admits scrolling immediately.
  userScrollUntil = performance.now() + 1000;
}
function onMessagesScroll(event: Event) {
  const viewport = event.currentTarget as HTMLElement;
  const scopeId = activeScopeId.value;
  if (loadingTimelineScopeId === scopeId || timelinePaging.value?.scopeId !== scopeId) {
    if (viewport.scrollTop <= 40) {
      // Keep a recent admitted gesture while the filtered event head is loading.
      // It resumes only at the same near-top position; no layout event can create it.
      pendingTimelinePageScopeId = scopeId;
      pendingTimelinePageUntil = performance.now() + 1000;
    }
    return;
  }
  if (viewport.scrollHeight <= viewport.clientHeight || viewport.scrollTop > 40) return;
  void loadOlderTimeline(viewport);
}
function resumePendingTimelinePage(scopeId: string) {
  if (pendingTimelinePageScopeId !== scopeId) return;
  pendingTimelinePageScopeId = '';
  const viewport = messageViewport.value;
  if (performance.now() <= pendingTimelinePageUntil && viewport && viewport.scrollHeight > viewport.clientHeight && viewport.scrollTop <= 40) {
    void loadOlderTimeline(viewport);
  }
}
/** R4 admission gates this trigger; all positioning and anchor writes stay suppressed by useTimelineScroll. */
function onViewportScroll(event: Event) {
  const programmatic = consumeProgrammaticScroll();
  if (!programmatic && performance.now() <= userScrollUntil) {
    userScrollUntil = 0;
    onMessagesScroll(event);
  }
  onMessageScroll();
}
async function loadOlderTimeline(viewport: HTMLElement) {
  const state = timelinePaging.value;
  const scopeId = activeScopeId.value;
  if (!service || !state || state.scopeId !== scopeId || state.projectId !== projectId.value || state.loading || state.limited) return;
  if (refreshInFlight) {
    pendingTimelinePageScopeId = scopeId;
    pendingTimelinePageUntil = performance.now() + 1000;
    return;
  }
  const hasBufferedRows = activeMessages.value.some((message) => !state.visibleIds.has(`message:${message.id}`))
    || events.value.some((event) => !state.visibleIds.has(`event:${event.id}`));
  if (!hasBufferedRows && !state.messageHasOlder && !state.eventHasOlder) return;
  if (state.visibleIds.size >= CHAT_TIMELINE_MEMORY_LIMIT) {
    state.limited = true;
    messagePages.value = { ...messagePages.value, [scopeId]: { ...(messagePages.value[scopeId] ?? { hasOlder: false, loading: false, limited: false, pagedOlder: false }), limited: true } };
    return;
  }

  const token = timelineGeneration;
  const anchor = [...viewport.querySelectorAll<HTMLElement>('[data-message-id], [data-event-id]')]
    .find((row) => row.getBoundingClientRect().bottom > viewport.getBoundingClientRect().top);
  const anchorId = anchor?.dataset['messageId'] ?? anchor?.dataset['eventId'];
  const anchorTop = anchor?.getBoundingClientRect().top;
  const previousMessagePage = messagePages.value[scopeId] ?? { hasOlder: false, loading: false, limited: false, pagedOlder: false };
  state.loading = true;
  state.pagedOlder = true;
  messagePages.value = { ...messagePages.value, [scopeId]: { ...previousMessagePage, loading: true, pagedOlder: true } };
  const selected: ChatTimelineItem[] = [];
  const selectedIds = new Set<string>();
  const current = () => timelinePaging.value?.scopeId === scopeId && timelinePaging.value.projectId === state.projectId
    && token === timelineGeneration && scopeId === activeScopeId.value;

  try {
    const fetchOlderMessages = async () => {
      const cursor = state.messageCursor;
      if (!cursor) { state.messageHasOlder = false; return; }
      // Fill each empty source before choosing the globally newest pending row.
      // Source buffers are at most one page beyond the retained visible rows.
      const limit = CHAT_MESSAGE_PAGE_SIZE;
      const older = await service.listMessages(scopeId, { limit, before: cursor });
      if (!current()) return;
      if (older.length === 0) { state.messageHasOlder = false; return; }
      messages.value = mergeMessageWindows(messages.value, older, projectId.value);
      state.messageCursor = older[0]?.id;
      state.messageHasOlder = older.length === limit;
      messagePages.value = {
        ...messagePages.value,
        [scopeId]: { ...previousMessagePage, hasOlder: state.messageHasOlder, loading: true, limited: false, pagedOlder: true },
      };
    };
    const fetchOlderEvents = async () => {
      const cursor = state.eventCursor;
      if (!cursor) { state.eventHasOlder = false; return; }
      const limit = CHAT_MESSAGE_PAGE_SIZE;
      const scope = activeScope.value;
      const originScopeId = eventOriginScopeId(scope);
      const older = await service.listProjectEvents(projectId.value, {
        limit, before: cursor, ...(originScopeId !== undefined ? { originScopeId } : {}),
      });
      if (!current()) return;
      if (older.events.length === 0) { state.eventHasOlder = older.hasOlder; return; }
      events.value = mergeEventWindows(events.value, older.events, projectId.value);
      state.eventCursor = older.events[0]?.id;
      state.eventHasOlder = older.hasOlder;
    };

    while (selected.length < Math.min(CHAT_MESSAGE_PAGE_SIZE, CHAT_TIMELINE_MEMORY_LIMIT - state.visibleIds.size)) {
      let pendingMessages = activeMessages.value.filter((message) =>
        !state.visibleIds.has(`message:${message.id}`) && !selectedIds.has(`message:${message.id}`),
      );
      let pendingEvents = events.value.filter((event) =>
        !state.visibleIds.has(`event:${event.id}`) && !selectedIds.has(`event:${event.id}`),
      );
      if (pendingMessages.length === 0 && state.messageHasOlder) {
        await fetchOlderMessages();
        if (!current()) return;
        pendingMessages = activeMessages.value.filter((message) =>
          !state.visibleIds.has(`message:${message.id}`) && !selectedIds.has(`message:${message.id}`),
        );
      }
      if (pendingEvents.length === 0 && state.eventHasOlder) {
        await fetchOlderEvents();
        if (!current()) return;
        pendingEvents = events.value.filter((event) =>
          !state.visibleIds.has(`event:${event.id}`) && !selectedIds.has(`event:${event.id}`),
        );
      }
      const candidates = mergeTimelineRows(pendingMessages, pendingEvents).sort((left, right) => compareTimelineItems(right, left));
      const next = candidates[0];
      if (!next) break;
      selected.push(next);
      selectedIds.add(timelineEntryKey(next));
    }

    if (!current()) return;
    if (selected.length > 0) {
      // These rows were fetched as history, including rows buffered by the
      // initial source pages; mark before adding them to the rendered union.
      noteTimelineHistory(selected.map((entry) => `${entry.kind}:${timelineEntryId(entry)}`));
      state.visibleIds = new Set([...state.visibleIds, ...selected.map(timelineEntryKey)]);
    }
    state.limited = state.visibleIds.size >= CHAT_TIMELINE_MEMORY_LIMIT || state.limited;
    messagePages.value = {
      ...messagePages.value,
      [scopeId]: { ...messagePages.value[scopeId]!, hasOlder: state.messageHasOlder, loading: true, limited: state.limited, pagedOlder: state.pagedOlder },
    };
    await nextTick();
  } catch {
    if (current()) actionError.value = 'Older chat rows could not be loaded. Scroll up to retry.';
  } finally {
    if (current()) {
      state.loading = false;
      const latest = messagePages.value[scopeId] ?? previousMessagePage;
      messagePages.value = { ...messagePages.value, [scopeId]: { ...latest, loading: false, limited: state.limited, pagedOlder: state.pagedOlder } };
      // Restore against the final layout, after the temporary loading row and
      // its flex gap have been removed. A pre-removal measurement drifts when
      // that transient content disappears after the anchor write.
      await nextTick();
      if (!current() || anchorId === undefined || anchorTop === undefined) return;
      const currentAnchor = [...viewport.querySelectorAll<HTMLElement>('[data-message-id], [data-event-id]')]
        .find((row) => row.dataset['messageId'] === anchorId || row.dataset['eventId'] === anchorId);
      if (currentAnchor) scrollProgrammatically((element) => { element.scrollTop += currentAnchor.getBoundingClientRect().top - anchorTop; });
    }
  }
}
function selectProject(id: string) {
  if (id !== projectId.value) void router.push({ name: 'project-chat', query: { ...route.query, project: id } });
}
async function loadTimelineScope() {
  const scope = activeScope.value;
  if (!scope) {
    timelineGeneration++;
    timelinePaging.value = null;
    events.value = [];
    return;
  }
  if (!service || loading.value || (timelinePaging.value?.scopeId === scope.id && timelinePaging.value.projectId === projectId.value)) return;
  const token = ++timelineGeneration;
  const selectedProjectId = projectId.value;
  loadingTimelineScopeId = scope.id;
  timelinePaging.value = null;
  events.value = [];
  try {
    const originScopeId = eventOriginScopeId(scope);
    const [rows, page] = await Promise.all([
      service.listMessages(scope.id, { limit: CHAT_MESSAGE_PAGE_SIZE }),
      service.listProjectEvents(selectedProjectId, {
        limit: CHAT_MESSAGE_PAGE_SIZE,
        ...(originScopeId !== undefined ? { originScopeId } : {}),
      }),
    ]);
    if (token !== timelineGeneration || selectedProjectId !== projectId.value || scope.id !== activeScopeId.value) return;
    messagePages.value = {
      ...messagePages.value,
      [scope.id]: { hasOlder: rows.length === CHAT_MESSAGE_PAGE_SIZE, loading: false, limited: false, pagedOlder: false },
    };
    messages.value = mergeMessageWindows(messages.value.filter((message) => message.scopeId !== scope.id), rows, selectedProjectId);
    events.value = page.events;
    timelinePaging.value = timelinePageState(scope.id, page, true);
    await nextTick();
    if (token !== timelineGeneration || scope.id !== activeScopeId.value) return;
    resumePendingTimelinePage(scope.id);
  } catch {
    if (token === timelineGeneration && scope.id === activeScopeId.value) actionError.value = 'Project events could not be loaded. Shown facts may be stale.';
  } finally {
    if (loadingTimelineScopeId === scope.id) loadingTimelineScopeId = '';
  }
}

async function loadProject() {
  if (!service || !projectService) { loading.value = false; error.value = 'Project Chat is unavailable: production authority is not connected.'; return; }
  const token = ++generation;
  timelineGeneration++;
  timelinePaging.value = null;
  messages.value = [];
  events.value = [];
  messagePages.value = {};
  knownEvents.clear();
  loading.value = true;
  error.value = '';
  try {
    const listed = await projectService.listProjects();
    if (token !== generation) return;
    projects.value = listed;
    if (!projectId.value || !listed.some((p) => p.id === projectId.value)) { error.value = 'Project Not Found. Choose a Project from Overview.'; scopes.value = []; return; }
    const selectedId = projectId.value;
    const scopeList = await service.listScopes(selectedId);
    const selectedScope = requestedScopeId.value
      ? scopeList.find((scope) => scope.id === requestedScopeId.value)
      : scopeList.find((scope) => scope.kind === 'project') ?? scopeList[0];
    const originScopeId = eventOriginScopeId(selectedScope);
    const projectEventPagePromise = service.listProjectEvents(selectedId, { limit: CHAT_MESSAGE_PAGE_SIZE });
    const activeEventPagePromise = originScopeId === undefined
      ? projectEventPagePromise
      : service.listProjectEvents(selectedId, { limit: CHAT_MESSAGE_PAGE_SIZE, originScopeId });
    const [messageWindow, recentProjectEvents, activeEventPage, routing] = await Promise.all([
      projectMessages(scopeList), projectEventPagePromise, activeEventPagePromise, service.listRoutingBatches(selectedId),
    ]);
    if (token !== generation) return;
    scopes.value = scopeList;
    messages.value = mergeMessageWindows([], messageWindow.messages, selectedId);
    messagePages.value = Object.fromEntries(scopeList.map((scope) => [scope.id, {
      hasOlder: messageWindow.hasOlder[scope.id] ?? false, loading: false, limited: false, pagedOlder: false,
    }]));
    events.value = activeEventPage.events;
    for (const event of recentProjectEvents.events) knownEvents.add(event.id);
    if (selectedScope !== undefined) timelinePaging.value = timelinePageState(selectedScope.id, activeEventPage, true);
    batches.value = routing.batches;
    await refreshActiveRuns();
    await unreadState?.refresh();
  } catch { if (token === generation) error.value = safeError(); }
  finally { if (token === generation) loading.value = false; }
}
async function refreshMessages() {
  if (!service || !projectId.value || loading.value || error.value || refreshInFlight || timelinePaging.value?.loading) return;
  refreshInFlight = true;
  const id = projectId.value;
  const scopeId = activeScopeId.value;
  const scope = activeScope.value;
  const token = generation;
  const pageAtStart = timelinePaging.value?.scopeId === scopeId ? timelinePaging.value : null;
  try {
    const scopeList = await service.listScopes(id);
    const originScopeId = eventOriginScopeId(scope);
    const activeEventPagePromise = service.listProjectEvents(id, {
      limit: CHAT_MESSAGE_PAGE_SIZE,
      ...(originScopeId !== undefined ? { originScopeId } : {}),
    });
    const recentProjectEventsPromise = originScopeId === undefined
      ? activeEventPagePromise
      : service.listProjectEvents(id, { limit: CHAT_MESSAGE_PAGE_SIZE });
    const [window, activeEventPage, recentProjectEvents] = await Promise.all([
      projectMessages(scopeList), activeEventPagePromise, recentProjectEventsPromise,
    ]);
    if (token !== generation || id !== projectId.value || scopeId !== activeScopeId.value || document.visibilityState === 'hidden') return;
    const previousMessageIds = new Set(messages.value.map((message) => message.id));
    const activeMessageIds = new Set(messages.value.filter((message) => message.scopeId === scopeId).map((message) => message.id));
    const freshActiveMessages = window.messages.filter((message) => message.scopeId === scopeId && !activeMessageIds.has(message.id));
    const freshActiveEvents = activeEventPage.events.filter((event) => !events.value.some((loaded) => loaded.id === event.id));
    const incoming = window.messages.filter((message) => !previousMessageIds.has(message.id) && message.authorKind !== 'human');
    const newEvents = recentProjectEvents.events.filter((event) => !knownEvents.has(event.id));
    scopes.value = scopeList;
    const pageState = pageAtStart && timelinePaging.value === pageAtStart ? pageAtStart : null;
    messagePages.value = Object.fromEntries(scopeList.map((item) => {
      const previous = messagePages.value[item.id];
      const limited = previous?.limited ?? false;
      const pagedOlder = previous?.pagedOlder ?? false;
      return [item.id, {
        hasOlder: limited ? false : pagedOlder ? (previous?.hasOlder ?? false) : (window.hasOlder[item.id] ?? false),
        loading: previous?.loading ?? false,
        limited,
        pagedOlder,
      } satisfies ChatMessagePageState];
    }));

    if (pageState?.pagedOlder) {
      const currentMessages = messages.value.filter((message) => message.scopeId === scopeId);
      const latestMessages = window.messages.filter((message) => message.scopeId === scopeId);
      const candidates = mergeMessageWindows(currentMessages, latestMessages, id);
      const candidateEvents = mergeEventWindows(events.value, activeEventPage.events, id);
      // Only rendered rows count against the history cap. Unconsumed source
      // rows remain buffered; refresh must not move their fetch cursors.
      const candidateRows = mergeTimelineRows(candidates, candidateEvents);
      const visibleIds = new Set([
        ...pageState.visibleIds,
        ...freshActiveMessages.map((message) => `message:${message.id}`),
        ...freshActiveEvents.map((event) => `event:${event.id}`),
      ]);
      const retained = candidateRows.filter((entry) => visibleIds.has(timelineEntryKey(entry))).slice(-CHAT_TIMELINE_MEMORY_LIMIT);
      const retainedIds = new Set(retained.map(timelineEntryKey));
      const bufferedAndVisible = candidateRows.filter((entry) =>
        !visibleIds.has(timelineEntryKey(entry)) || retainedIds.has(timelineEntryKey(entry)),
      );
      const retainedMessages = bufferedAndVisible.flatMap((entry) => entry.kind === 'message' ? [entry.message] : []);
      const retainedEvents = bufferedAndVisible.flatMap((entry) => entry.kind === 'event' ? [entry.event] : []);
      const otherMessages = mergeMessageWindows(
        messages.value.filter((message) => message.scopeId !== scopeId),
        window.messages.filter((message) => message.scopeId !== scopeId),
        id,
      );
      messages.value = mergeMessageWindows(otherMessages, retainedMessages, id);
      events.value = retainedEvents;
      pageState.visibleIds = retainedIds;
      pageState.limited = pageState.limited || pageState.visibleIds.size >= CHAT_TIMELINE_MEMORY_LIMIT;
      messagePages.value = {
        ...messagePages.value,
        [scopeId]: { ...messagePages.value[scopeId]!, hasOlder: pageState.messageHasOlder, limited: pageState.limited, pagedOlder: true },
      };
    } else {
      messages.value = mergeMessageWindows(messages.value, window.messages, id);
      events.value = activeEventPage.events;
      if (pageState) Object.assign(pageState, timelinePageState(scopeId, activeEventPage));
      else timelinePaging.value = timelinePageState(scopeId, activeEventPage);
    }
    knownEvents.clear();
    for (const event of recentProjectEvents.events) knownEvents.add(event.id);
    await unreadState?.refresh();
    void markVisible();
    let sentence: string | undefined;
    if (incoming.length || newEvents.length) {
      const inCurrent = incoming.filter((message) => message.scopeId === activeScope.value?.id);
      sentence = `${incoming.length ? `${incoming.length} new ${incoming.length === 1 ? 'message' : 'messages'}` : ''}${incoming.length && newEvents.length ? ' and ' : ''}${newEvents.length ? `${newEvents.length} new Project ${newEvents.length === 1 ? 'event' : 'events'}` : ''} in ${project.value?.displayName ?? 'Project'}${inCurrent.length ? `; ${inCurrent.length} in ${activeScope.value ? title(activeScope.value) : 'current conversation'}` : ''}.`;
    }
    // Refresh replaces scope facts, so re-check admission before announcing arrivals.
    await loadScope();
    await refreshActiveRuns();
    if (sentence !== undefined && token === generation && document.visibilityState !== 'hidden') announcer.announce(sentence);
  } catch { if (token === generation) actionError.value = 'Could not refresh the conversation. Shown facts may be stale.'; }
  finally { refreshInFlight = false; resumePendingTimelinePage(scopeId); }
}
function onVisibilityChange() {
  if (pollTimer !== undefined) { clearInterval(pollTimer); pollTimer = undefined; }
  if (document.visibilityState === 'hidden') return;
  void refreshMessages(); // Catch up after a hidden interval without polling it.
  void refreshActiveRuns(); // Refresh run authority even if a message read is already in flight.
  pollTimer = setInterval(() => {
    void refreshMessages();
    void refreshActiveRuns();
  }, CHAT_POLL_MS);
}
async function loadScope() {
  const token = ++detailGeneration;
  const key = `${projectId.value}|${activeScopeId.value}`;
  if (key !== inspectedScopeKey) { evidenceOpen.value = null; inspectedScopeKey = key; }
  inspection.value = null;
  if (!service || !activeScope.value || missingScope.value) { detailLoading.value = false; return; }
  detailLoading.value = true;
  try {
    const inspected = await service.inspectScope(activeScope.value.id);
    if (token === detailGeneration) inspection.value = inspected;
  } catch { if (token === detailGeneration) actionError.value = 'Conversation admission could not be verified. Sending is disabled.'; }
  finally { if (token === detailGeneration) { detailLoading.value = false; await markVisible(); } }
}
let lastTargetAnnouncement = '';
watch([timeline, loading, detailLoading, missingScope, activeScopeId, requestedMessageId, requestedEventId], async () => {
  const messageId = requestedMessageId.value;
  const eventId = requestedEventId.value;
  if (!messageId && !eventId) { targetAnnouncement.value = ''; lastTargetAnnouncement = ''; return; }
  if (loading.value || detailLoading.value) return;
  const requested = `${activeScopeId.value}|${messageId}|${eventId}`;
  await nextTick();
  if (requested !== `${activeScopeId.value}|${requestedMessageId.value}|${requestedEventId.value}`) return;
  let result: string;
  if (missingScope.value || !activeScope.value) {
    result = 'The requested conversation is unavailable.';
  } else {
    const selector = messageId ? '[data-message-id]' : '[data-event-id]';
    const targetId = messageId || eventId;
    const target = [...document.querySelectorAll<HTMLElement>(selector)].find((row) =>
      (messageId ? row.dataset['messageId'] : row.dataset['eventId']) === targetId,
    );
    if (target) {
      scrollProgrammatically(() => target.scrollIntoView?.({ block: 'center' }));
      target.focus({ preventScroll: true });
      result = messageId ? 'Target message highlighted.' : 'Target Project event highlighted.';
    } else {
      result = messageId
        ? 'Target message is unavailable; the conversation is open without message focus.'
        : 'Target Project event is unavailable; the conversation is open without event focus.';
    }
  }
  targetAnnouncement.value = result;
  const announcementKey = `${requested}|${result}`;
  if (lastTargetAnnouncement !== announcementKey) {
    lastTargetAnnouncement = announcementKey;
    announcer.announce(result);
  }
}, { flush: 'post', immediate: true });
async function selectScope(scope: ConversationScopeView) {
  await router.push({ name: 'project-chat-scope', params: { scopeId: scope.id }, query: route.query });
  announcer.announce(`Opened ${title(scope)} conversation.`);
  await nextTick();
  (document.querySelector('.chat-mobile-back') as HTMLElement | null)?.focus();
}
async function openAgentDirect(agentId: string) {
  const humanId = project.value && currentVersion(project.value)?.memberships.find((member) => member.memberKind === 'human' && member.endedAt === undefined)?.memberId;
  if (!service || !presentation.value.controlAvailable || project.value?.status !== 'active' || !humanId || !projectId.value) return;
  actionError.value = '';
  try {
    const scope = await service.openDirectConversation(projectId.value, [humanId, agentId]);
    scopes.value = await service.listScopes(projectId.value);
    await selectScope(scope);
  } catch { actionError.value = 'Direct conversation could not be opened. No message was sent.'; announcer.announce(actionError.value); }
}
async function createGroup() {
  if (!service || !projectId.value || !presentation.value.controlAvailable || project.value?.status !== 'active' || !groupName.value.trim() || managingGroup.value) return;
  managingGroup.value = true;
  actionError.value = '';
  try {
    const created = await service.createWorkingGroup(projectId.value, { displayName: groupName.value.trim(), ...(groupGoal.value.trim() ? { goal: groupGoal.value.trim() } : {}), memberIds: groupMembers.value });
    scopes.value = await service.listScopes(projectId.value);
    createGroupOpen.value = false;
    groupName.value = ''; groupGoal.value = ''; groupMembers.value = [];
    await selectScope(created);
    announcer.announce(`Working Group ${title(created)} created.`);
  } catch { actionError.value = 'Working Group was not created. Check membership and try again.'; announcer.announce(actionError.value); }
  finally { managingGroup.value = false; }
}
async function restoreGroup() {
  if (!service || !activeScope.value || activeScope.value.kind !== 'working-group' || project.value?.status !== 'active' || !presentation.value.controlAvailable || managingGroup.value) return;
  managingGroup.value = true;
  try {
    await service.restoreWorkingGroup(activeScope.value.id);
    scopes.value = await service.listScopes(projectId.value);
    await loadScope();
    announcer.announce('Working Group restored; conversation is writable.');
  } catch { actionError.value = 'Working Group cannot be restored until its members are eligible.'; announcer.announce(actionError.value); }
  finally { managingGroup.value = false; }
}
function beginEditGroup() {
  const group = activeGroup.value;
  if (!group) return;
  const version = group.content.versions.find((v) => v.version === group.content.currentVersion);
  editName.value = version?.displayName ?? '';
  editGoal.value = version?.goal ?? '';
  editRules.value = version?.rules.join('\n') ?? '';
  editMembers.value = group.memberships.filter((m) => !m.endedAt && m.memberKind === 'agent').map((m) => m.memberId);
  infoOpen.value = false;
  editGroupOpen.value = true;
}
async function saveGroup() {
  const group = activeGroup.value;
  if (!service || !group || group.status !== 'active' || project.value?.status !== 'active' || !presentation.value.controlAvailable || managingGroup.value || !editName.value.trim()) return;
  managingGroup.value = true;
  actionError.value = '';
  try {
    const current = group.content.versions.find((v) => v.version === group.content.currentVersion);
    const rules = editRules.value.split('\n').map((rule) => rule.trim()).filter(Boolean);
    if (current?.displayName !== editName.value.trim() || current.goal !== editGoal.value.trim() || JSON.stringify(current.rules) !== JSON.stringify(rules))
      await service.updateWorkingGroupContent(group.id, { displayName: editName.value.trim(), goal: editGoal.value.trim() || null, rules });
    const members = group.memberships.filter((m) => !m.endedAt && m.memberKind === 'agent').map((m) => m.memberId);
    for (const id of editMembers.value.filter((id) => !members.includes(id))) await service.addWorkingGroupMember(group.id, id);
    for (const id of members.filter((id) => !editMembers.value.includes(id))) await service.endWorkingGroupMember(group.id, id);
    scopes.value = await service.listScopes(projectId.value);
    await loadScope();
    editGroupOpen.value = false;
    announcer.announce('Working Group updated.');
  } catch { actionError.value = 'Working Group update was refused. Review current membership and retry; some changes may have been saved.'; announcer.announce(actionError.value); scopes.value = await service.listScopes(projectId.value).catch(() => scopes.value); }
  finally { managingGroup.value = false; }
}
async function disbandGroup() {
  if (!service || !activeGroup.value || activeGroup.value.status !== 'active' || project.value?.status !== 'active' || !presentation.value.controlAvailable || managingGroup.value) return;
  managingGroup.value = true;
  try {
    await service.disbandWorkingGroup(activeGroup.value.id);
    scopes.value = await service.listScopes(projectId.value);
    await loadScope();
    disbandConfirm.value = false;
    editGroupOpen.value = false;
    announcer.announce('Working Group disbanded. Its conversation is read-only; history is retained.');
  } catch { actionError.value = 'Working Group could not be disbanded.'; announcer.announce(actionError.value); }
  finally { managingGroup.value = false; }
}
async function closeScope() {
  const id = activeScope.value?.id;
  await router.push({ name: 'project-chat', query: route.query });
  await nextTick();
  const card = [...document.querySelectorAll<HTMLElement>('[data-scope-id]')].find((el) => el.dataset['scopeId'] === id);
  card?.focus();
}
async function stopChatRun(run: { readonly id: string; readonly agentId: string }) {
  const scopeId = activeScopeId.value;
  if (!service || !scopeId || !presentation.value.controlAvailable || project.value?.status !== 'active' || stoppingRunIds.value.has(run.id)) return;
  stoppingRunIds.value = new Set([...stoppingRunIds.value, run.id]);
  actionError.value = '';
  try {
    const result = await service.stopChatRun(scopeId, run.id);
    await refreshMessages();
    await refreshActiveRuns();
    announcer.announce(result.status === 'interrupted'
      ? `@${agentName(run.agentId)} was stopped. The conversation is ready for another message.`
      : `@${agentName(run.agentId)} is no longer working in this conversation.`);
  } catch {
    actionError.value = 'Agent run could not be stopped. Its current status will be refreshed.';
    announcer.announce(actionError.value);
    await refreshActiveRuns();
  } finally {
    const remaining = new Set(stoppingRunIds.value);
    remaining.delete(run.id);
    stoppingRunIds.value = remaining;
  }
}
async function sendMessage() {
  if (!canSend.value || !newMessage.value.trim() || !service || !activeScope.value) return;
  const scopeId = activeScope.value.id;
  const body = newMessage.value.trim();
  // A transport refusal can follow durable delivery. Retrying the unchanged
  // draft uses the same key so the server deduplicates rather than re-waking.
  const deliveryKey = pendingDelivery?.scopeId === scopeId && pendingDelivery.body === body
    ? pendingDelivery.deliveryKey : newDeliveryKey();
  pendingDelivery = { scopeId, body, deliveryKey };
  sending.value = true;
  actionError.value = '';
  try {
    const delivery = await service.postMessage(pendingDelivery);
    pendingDelivery = null;
    if (newMessage.value.trim() === body) newMessage.value = '';
    // The run admission is returned with the Message, before slower timeline
    // reads. Read active status now even if refreshMessages is already in flight;
    // bounded retries cover a status projection that trails admission briefly.
    await refreshActiveRunsAfterSend(scopeId, delivery.admittedRunIds);
    await refreshMessages();
    announcer.announce(`Message sent to ${title(activeScope.value)}.`);
  } catch { actionError.value = 'Message was not sent. Check the connection and retry; it was not queued.'; announcer.announce(actionError.value); }
  finally { sending.value = false; }
}
async function resolveProvenance(message: MessageView) {
  if (!service) return;
  // The reply's inReplyTo is authoritative for a single-message trigger. The durable
  // reply id gives a lookup hint for event or multi-input batch replies; only
  // server evidence is displayed, never an inferred run or fabricated input.
  const hint = message.inReplyTo ?? (message.id.startsWith('reply-') ? message.id.slice(6).split(':').slice(0, -1).join(':') : '');
  if (!hint) {
    // A reply-less input — for example a direct message whose run failed — has
    // no reply to point back from. The evidence already loaded for this exact
    // message carries its own durable WakeRequests, so the chain
    // WakeRequest → run outcome is read from server evidence only: the run
    // comes from a wake the server returned for this message, and its outcome
    // from the minimal status + safe failure-reason projection (story 65, #182).
    const wake = evidence.value === null
      ? undefined
      : [...evidence.value.deterministicWakes, ...evidence.value.batches.flatMap((detail) => detail.wakes)]
          .find((candidate) => candidate.runId !== undefined);
    if (wake?.runId === undefined) return;
    const run = await service.getRunStatus(wake.runId).catch(() => undefined);
    provenance.value = {
      inputIds: [message.id],
      runId: wake.runId,
      ...(run !== undefined ? { runStatus: run.status, ...(run.failureReason ? { failureReason: run.failureReason } : {}) } : {}),
    };
    return;
  }
  try {
    let trigger: RoutingEvidenceView | undefined;
    try { trigger = await service.messageRouting(hint); } catch { try { trigger = await service.eventRouting(hint); } catch { /* may name a batch */ } }
    const detail = trigger?.batches.find((item) => item.replies.some((reply) => reply.messageId === message.id));
    let batch = detail;
    if (!batch) { try { batch = await service.getRoutingBatch(hint); } catch { /* not a batch */ } }
    const wake = (batch?.wakes ?? trigger?.deterministicWakes ?? []).find((w) => w.agentId === message.authorId);
    const run = wake?.runId ? await service.getRunStatus(wake.runId).catch(() => undefined) : undefined;
    provenance.value = { inputIds: batch?.inputs.map((item) => item.inputId) ?? (trigger ? [hint] : []), ...(batch ? { batchId: batch.batch.id } : {}), ...(wake?.runId ? { runId: wake.runId } : {}), ...(run ? { runStatus: run.status, ...(run.failureReason ? { failureReason: run.failureReason } : {}) } : {}) };
  } catch { provenance.value = { inputIds: [] }; }
}
async function openEvidence(id: string, kind: 'message' | 'event', trigger: Event) {
  if (!service) return;
  evidenceTrigger.value = trigger.currentTarget as HTMLElement;
  evidenceOpen.value = id;
  evidence.value = null;
  provenance.value = null;
  evidenceLoading.value = true;
  await nextTick();
  (document.querySelector('.chat-evidence-close') as HTMLElement | null)?.focus();
  try {
    evidence.value = kind === 'message' ? await service.messageRouting(id) : await service.eventRouting(id);
    const message = messages.value.find((item) => item.id === id);
    // Every Message with evidence resolves its WakeRequest → run outcome — a
    // reply-less input (for example a direct message whose run failed) has no
    // reply to anchor on, so the chain resolves from this message's own wakes.
    if (message) void resolveProvenance(message);
  } catch { announcer.announce('Routing evidence is unavailable.'); }
  finally { evidenceLoading.value = false; }
}
function closeEvidence() { evidenceOpen.value = null; evidence.value = null; evidenceTrigger.value?.focus(); }
function onKey(event: KeyboardEvent) { if (event.key === 'Escape' && evidenceOpen.value) { event.preventDefault(); closeEvidence(); } }
function onDocumentClick(event: MouseEvent) { if (evidenceOpen.value && !(event.target as Element).closest('.chat-evidence-wrap')) closeEvidence(); }
async function inspectBatch(id: string, attempt?: number) {
  infoOpen.value = false;
  closeEvidence();
  await router.push({ name: 'project-chat-routing', params: { batchId: id }, query: { ...route.query, ...(attempt ? { attempt: String(attempt) } : {}), ...(activeScope.value ? { from: activeScope.value.id } : {}) } });
}
watch(projectId, () => { if (projectId.value) void loadProject(); });
watch([activeScopeId, loading], () => {
  if (!loading.value) { void loadScope(); void refreshActiveRuns(); void loadTimelineScope(); }
});
watch(visibleTimeline, markVisible);
onMounted(() => { announcer.announce('Project chat view.'); void loadProject(); void agentService?.listAgents().then((rows) => { agents.value = rows; }).catch(() => {}); document.addEventListener('keydown', onKey); document.addEventListener('click', onDocumentClick);
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibilityChange);
  onVisibilityChange();
  unsubRuns = service?.subscribeRunStatuses(() => {
    // A new run first reaches this stream as `running`; the orchestrator's
    // initial queued record is durable but not published as a run event.
    void refreshActiveRuns();
    void refreshMessages();
    // Run settlement can reach the event stream just before its reply projection.
    for (const delay of [400, 1500]) {
      const timer = setTimeout(() => { refreshTimers.delete(timer); void refreshMessages(); }, delay);
      refreshTimers.add(timer);
    }
  }); });
onUnmounted(() => { window.removeEventListener('resize', onResize); generation++; detailGeneration++; activeRunGeneration++; unsubRuns?.(); if (pollTimer !== undefined) clearInterval(pollTimer); for (const timer of refreshTimers) clearTimeout(timer); refreshTimers.clear(); document.removeEventListener('visibilitychange', onVisibilityChange); document.removeEventListener('keydown', onKey); document.removeEventListener('click', onDocumentClick); });
</script>

<template>
  <div class="chat-view relative flex h-full min-h-0 flex-col bg-[var(--bg-app)] p-3 sm:p-5">
    <div class="chat-target-announcement sr-only" role="status" aria-live="polite" aria-atomic="true">{{ targetAnnouncement }}</div>
    <div class="chat-admission-announcement sr-only" role="status" aria-live="polite" aria-atomic="true">{{ detailLoading ? 'Checking conversation admission…' : '' }}</div>
    <div v-if="projects.length" class="mb-2 flex items-center gap-2 text-xs"><label for="chat-project-selector" class="font-bold">Project</label><select id="chat-project-selector" :value="projectId" class="min-h-11 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2" @change="selectProject(($event.target as HTMLSelectElement).value)"><option v-for="item in projects" :key="item.id" :value="item.id">{{ item.displayName }}</option></select></div>
    <div v-if="loading" class="chat-loading-state flex flex-col gap-3 p-6" role="status" aria-busy="true" aria-label="Loading conversations">
      <div class="h-8 w-52 animate-pulse rounded bg-[var(--bg-surface-elevated)]" />
      <div v-for="i in 4" :key="i" class="h-16 animate-pulse rounded bg-[var(--bg-surface-elevated)]" />
      <span>Loading conversations…</span>
    </div>
    <div v-else-if="error" class="chat-unavailable-state m-auto text-center text-sm" role="status">
      <EmptyState icon="alert" title="Project Chat Unavailable" :description="error" />
      <Button v-if="service" variant="secondary" size="sm" @click="loadProject">Retry</Button>
    </div>
    <!-- An unknown deep link replaces the entire split pane, including its composer. -->
    <div v-else-if="missingScope" class="chat-not-found-state flex flex-1 items-center justify-center rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-8">
      <EmptyState icon="alert" title="Conversation Not Found" description="No conversation matches this URL. Choose a conversation from the list instead.">
        <Button variant="primary" size="sm" class="chat-not-found-return min-h-11" @click="closeScope">Back to Conversations</Button>
      </EmptyState>
    </div>
    <div v-else class="chat-layout flex min-h-0 md:min-h-[520px] flex-1 overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-xs md:flex-row" data-chat-layout="split">
      <aside class="w-full shrink-0 flex-col gap-1 overflow-y-auto bg-[var(--bg-surface-elevated)] p-3 md:w-72 md:border-r lg:w-80" :class="requestedScopeId ? 'hidden md:flex' : 'flex'" aria-label="Conversation scopes">
        <div class="flex items-center justify-between px-2 pb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
          <span>Conversations &amp; Groups</span><span>{{ scopes.length }} Scopes</span>
        </div>
        <template v-for="section in scopeSections" :key="section.kind === 'closed-tasks' ? 'closed-tasks' : section.label">
          <div class="chat-section border-t border-[var(--border-subtle)] pt-2">
            <div class="flex items-center justify-between px-2 pb-1">
              <h2 v-if="section.kind === 'scopes'" class="text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">{{ section.label }}</h2>
              <button v-else type="button" class="chat-closed-tasks-toggle min-h-11 text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)]" :aria-expanded="closedTaskGroupsExpanded" aria-controls="chat-closed-task-groups" @click="closedTaskGroupsExpanded = !closedTaskGroupsExpanded">{{ section.label }} <Icon name="chevron-down" :class="closedTaskGroupsExpanded ? 'rotate-180' : ''" :size="12" /></button>
              <button v-if="section.kind === 'scopes' && section.label.startsWith('Working Groups')" type="button" class="chat-create-wg min-h-11 px-2 text-[11px] font-semibold text-[var(--accent-primary)] disabled:opacity-60" :disabled="!presentation.controlAvailable || project?.status !== 'active'" @click="createGroupOpen = true"><Icon name="plus" :size="12" /> New WG</button>
            </div>
            <p v-if="section.kind === 'scopes' && !section.items.length && !section.label.startsWith('Direct Messages')" class="px-2 py-2 text-xs text-[var(--text-muted)]">No conversations yet.</p>
            <div :id="section.kind === 'closed-tasks' ? 'chat-closed-task-groups' : undefined">
              <template v-if="section.kind !== 'closed-tasks' || closedTaskGroupsExpanded">
                <button v-for="scope in section.items" :key="scope.id" type="button" :data-scope-id="scope.id" :data-scope-kind="scopeKind(scope)" :aria-current="activeScope?.id === scope.id ? 'page' : undefined"
                  class="chat-scope-card mb-1 flex min-h-[64px] w-full items-start gap-2 rounded border p-2.5 text-left focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
                  :class="activeScope?.id === scope.id ? 'border-[var(--accent-primary)] bg-[var(--bg-surface)] ring-1 ring-[var(--accent-primary)]' : 'border-transparent hover:border-[var(--border-strong)]'" @click="selectScope(scope)">
                  <span class="rounded bg-[var(--bg-surface)] p-1.5 text-[var(--accent-primary)]"><Icon :name="icon(scope)" :size="17" /></span>
                  <span class="chat-card-content min-w-0 flex-1">
                    <span class="flex items-center gap-1.5"><strong class="truncate text-xs text-[var(--text-primary)]">{{ title(scope) }}</strong><span v-if="scopePill(scope)" class="text-[10px] text-[var(--text-muted)]">{{ scopePill(scope) }}</span><span class="ml-auto shrink-0 text-[10px] text-[var(--text-muted)]">{{ latestTime(scope) }}</span></span>
                    <span class="block text-[10px] text-[var(--text-muted)]">{{ kindLabel(scope) }}</span>
                    <span class="block truncate text-[11px] text-[var(--text-secondary)]">{{ preview(scope) }}</span>
                  </span>
                  <UnreadBadge :count="unread(scope)" class="chat-card-unread self-center shrink-0" />
                </button>
              </template>
            </div>
            <template v-if="section.kind === 'scopes' && section.label.startsWith('Direct Messages')">
              <button v-for="member in unopenedAgents" :key="member.memberId" type="button" :disabled="!presentation.controlAvailable || project?.status !== 'active' || agents.some((agent) => agent.id === member.memberId && agent.status === 'archived')" class="chat-direct-unopened mb-1 flex min-h-[64px] w-full items-center gap-2 rounded border border-transparent p-2.5 text-left text-xs hover:border-[var(--border-strong)] disabled:opacity-60" @click="openAgentDirect(member.memberId)">
                <Icon name="agents" :size="17" class="text-[var(--accent-primary)]" /><span><strong class="block">@{{ agentName(member.memberId) }} <span v-if="agents.some((agent) => agent.id === member.memberId && agent.status === 'archived')">· Archived</span></strong><span class="block text-[10px] text-[var(--text-muted)]">Direct message · {{ agents.some((agent) => agent.id === member.memberId && agent.status === 'archived') ? 'Read-only' : 'Open conversation' }}</span><span class="block truncate text-[var(--text-secondary)]">{{ member.responsibilities.join('; ') || 'No messages yet with agent.' }}</span></span>
              </button>
            </template>
          </div>
        </template>
      </aside>
      <section class="min-h-0 min-w-0 flex-1 flex-col" :class="requestedScopeId ? 'flex' : 'hidden md:flex'" aria-label="Conversation detail">
        <header class="flex min-h-14 items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3">
          <div class="flex min-w-0 items-center gap-2">
            <button type="button" class="chat-mobile-back min-h-11 rounded px-2 text-xs text-[var(--accent-primary)] md:hidden" @click="closeScope"><Icon name="chevron-left" :size="16" /> Back to Chats</button>
            <Icon v-if="activeScope" :name="icon(activeScope)" :size="16" class="hidden text-[var(--accent-primary)] md:block" />
            <strong class="truncate text-xs text-[var(--text-primary)]">{{ activeScope ? title(activeScope) : 'No conversation selected' }}</strong>
            <span v-if="activeScope" class="hidden text-[10px] text-[var(--text-muted)] sm:inline">{{ kindLabel(activeScope) }}</span>
          </div>
          <Button v-if="activeScope" variant="secondary" size="icon" class="chat-info-btn h-10 w-10 shrink-0" title="Conversation Information" aria-label="Conversation Information" @click="infoOpen = true"><Icon name="info" :size="16" /></Button>
        </header>
        <!-- The top strip owns live announcements; only the composer indicator pulses. -->
        <div v-if="activeChatRuns.length" class="chat-working-state flex flex-col gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] p-3 text-xs" role="status" aria-live="polite">
          <div v-for="run in activeChatRuns" :key="run.id" class="flex items-center gap-3">
            <span class="flex min-w-0 items-center gap-2 text-[var(--text-primary)]"><span class="h-2 w-2 shrink-0 rounded-full bg-[var(--accent-primary)]" aria-hidden="true" /><span class="truncate">@{{ agentName(run.agentId) }} {{ run.status === 'queued' ? 'is starting…' : 'is working' }}</span></span>
          </div>
        </div>
        <div v-if="inspection && !inspection.state.writable" class="chat-readonly-banner flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] p-3 text-xs" role="status"><span><Icon name="alert" :size="14" /> {{ readOnlyReason(inspection.state.reason) }}</span><Button v-if="inspection.state.reason === 'working-group-disbanded' && project?.status === 'active'" variant="secondary" size="sm" class="min-h-11 shrink-0" :disabled="!presentation.controlAvailable || managingGroup" @click="restoreGroup">Restore WG</Button></div>
        <div v-else-if="archivedDirectAgent" class="chat-readonly-banner border-b border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] p-3 text-xs" role="status"><Icon name="alert" :size="14" /> Agent @{{ archivedDirectAgent.displayName }} is archived. History is preserved for review; restore the Agent before sending new messages.</div>
        <div v-if="actionError" class="p-3 text-xs text-[var(--red-action)]" role="alert">{{ actionError }}</div>
        <div class="relative flex min-h-0 flex-1 flex-col">
          <!-- Admission covers messages without allocating a row or intercepting input. -->
          <div v-if="showAdmissionNotice" class="chat-detail-loading pointer-events-none absolute right-3 top-2 z-20 max-w-[min(20rem,calc(100%-1.5rem))] rounded border border-[var(--yellow-attention-border)] bg-[var(--bg-surface)] p-3 text-xs text-[var(--text-primary)] shadow-lg" aria-hidden="true">Checking conversation admission…</div>
          <div ref="messageViewport" class="chat-messages-body min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-4 [overflow-anchor:none]" :aria-busy="detailLoading || timelinePaging?.loading" @scroll="onViewportScroll" @wheel.passive="onScrollInput" @touchmove.passive="onScrollInput" @keydown="onScrollInput" @pointerdown="onScrollInput" @pointermove="onScrollInput">
          <div ref="messageContent" class="chat-messages-content flex min-h-full flex-col gap-3">
          <div v-if="timelinePaging?.loading" class="chat-older-loading text-center text-[10px] text-[var(--text-muted)]" role="status">Loading older chat rows…</div>
          <div v-if="timelinePaging?.limited" class="chat-history-limit text-center text-[10px] text-[var(--text-muted)]" role="note">The latest {{ CHAT_TIMELINE_MEMORY_LIMIT }} chat rows are retained in this view.</div>
          <div v-if="!visibleTimeline.length && !timelinePaging?.loading" class="chat-empty-state m-auto text-center text-xs text-[var(--text-muted)]"><Icon name="chat" :size="22" class="mx-auto mb-2" /><strong class="block">No messages yet in this conversation scope.</strong><p>Send a message or @mention a project agent below to begin collaboration.</p></div>
          <template v-for="entry in visibleTimeline" :key="timelineEntryKey(entry)">
          <div v-if="dateSeparators.has(timelineEntryKey(entry))" class="chat-date-separator flex items-center gap-3 py-2 text-xs font-medium text-[var(--text-secondary)]">
            <span class="h-px flex-1 bg-[var(--border-subtle)]" aria-hidden="true" />
            <span>{{ dateSeparators.get(timelineEntryKey(entry)) }}</span>
            <span class="h-px flex-1 bg-[var(--border-subtle)]" aria-hidden="true" />
          </div>
          <div :data-message-id="entry.kind === 'message' ? entry.message.id : undefined" :data-event-id="entry.kind === 'event' ? entry.event.id : undefined" :data-targeted="isTargetEntry(entry) ? (entry.kind === 'message' ? 'message' : 'event') : undefined" :tabindex="isTargetEntry(entry) ? -1 : undefined"
            class="chat-msg max-w-[90%] rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] p-3 text-xs" :class="[entry.kind === 'message' && entry.message.authorKind === 'human' ? 'self-end' : 'self-start', isTargetEntry(entry) ? 'ring-2 ring-[var(--accent-primary)]' : '']">
            <div class="flex items-center justify-between gap-3">
              <span v-if="entry.kind === 'message' && entry.message.authorKind === 'human'" data-author-kind="human" class="rounded border border-[var(--border-subtle)] px-1 text-[var(--text-secondary)]">Human</span>
              <span v-else-if="entry.kind === 'message' && entry.message.authorKind === 'agent'" data-author-kind="agent" class="rounded border border-[var(--border-subtle)] px-1 text-[var(--text-secondary)]">Agent</span>
              <strong class="text-[var(--text-primary)]">{{ entry.kind === 'event' ? 'Project event' : entry.message.authorKind === 'human' ? 'Human Operator' : `@${agentName(entry.message.authorId)}` }}</strong>
              <div class="chat-evidence-wrap relative flex items-center gap-1">
                <button type="button" class="chat-evidence-trigger flex h-9 w-9 items-center justify-center rounded focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]" :aria-label="`Routing and delivery evidence for ${entry.kind === 'message' ? entry.message.id : entry.event.id}`" :aria-expanded="evidenceOpen === (entry.kind === 'message' ? entry.message.id : entry.event.id)" @click.stop="openEvidence(entry.kind === 'message' ? entry.message.id : entry.event.id, entry.kind, $event)"><Icon name="info" :size="14" /></button>
                <span class="text-[10px] text-[var(--text-muted)]">{{ time(entry.kind === 'message' ? entry.message.createdAt : entry.event.createdAt) }}</span>
                <div v-if="evidenceOpen === (entry.kind === 'message' ? entry.message.id : entry.event.id)" class="chat-evidence-popup absolute right-0 top-9 z-20 w-72 max-w-[85vw] rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] p-3 shadow-lg" :data-evidence-state="evidence ? currentEvidenceState : 'loading'" role="dialog" aria-label="Routing and delivery evidence" @click.stop>
                  <div class="flex items-center justify-between gap-2"><strong>Routing &amp; Delivery Evidence</strong><button type="button" class="chat-evidence-close flex h-9 w-9 items-center justify-center" aria-label="Close evidence" @click="closeEvidence"><Icon name="close" :size="14" /></button></div>
                  <p v-if="evidenceLoading" role="status">Loading causal evidence…</p>
                  <p v-else-if="!evidence">Routing evidence unavailable. Shown facts may be stale.</p>
                  <template v-else>
                    <p v-if="currentEvidenceState === 'projected'" class="font-bold text-[var(--purple-agent)]">Projected Reply · Non-Routing</p>
                    <p v-if="currentEvidenceState === 'projected'">Assistant output projected on completion cannot trigger downstream wake evaluations.</p>
                    <p v-if="provenance?.runId">Run: <code>{{ provenance.runId }}</code> · {{ provenance.runStatus ?? 'status unavailable' }}</p>
                    <p v-if="currentEvidenceState === 'run-failed'" class="font-bold text-[var(--red-action)]">Run failed. No reply was produced for this message. Reason: {{ provenance?.failureReason ?? 'No error outcome was recorded.' }}</p>
                    <p v-if="provenance?.inputIds.length">Triggered by: <code>{{ provenance.inputIds.join(', ') }}</code></p>
                    <p v-if="currentEvidenceState === 'pending'">Collection window open or frozen; wake-model judgement is pending. No outcome has been selected yet.</p>
                    <p v-if="evidence.window">Window: <code>{{ evidence.window.id }}</code> · {{ evidence.window.status }} · deadline {{ time(evidence.window.deadlineAt) }}</p>
                    <p v-if="currentEvidenceState === 'failed'" class="font-bold text-[var(--red-action)]">Routing failed closed. No Agent was woken by this batch.</p>
                    <p v-if="currentEvidenceState === 'suppressed'">Suppressed — durable decision selected no Agent; this is not a routing failure.</p>
                    <p v-if="currentEvidenceState === 'routed'">Deterministic addressing or model-selected routing admitted a WakeRequest.</p>
                    <p v-if="currentEvidenceState === 'informational'">Informational message persisted without wake under explicit-only policy.</p>
                    <div v-for="wake in [...evidence.deterministicWakes, ...evidence.batches.flatMap((detail) => detail.wakes)]" :key="`${wake.agentId}-${wake.runId}`">@{{ wake.agentId }} · {{ wake.reason }} · {{ wake.status }}<span v-if="wake.runId"> · Run {{ wake.runId }}</span></div>
                    <div v-for="observation in evidence.observations" :key="`${observation.reason}-${observation.agentId}`">{{ observation.status }} · {{ observation.reason }}</div>
                    <button v-for="detail in evidence.batches" :key="detail.batch.id" type="button" class="msg-popup-inspect-btn mt-2 min-h-11 w-full rounded border border-[var(--border-subtle)] px-2 text-left text-[var(--accent-primary)]" @click="inspectBatch(detail.batch.id)">Inspect Causal Routing Chain · {{ detail.batch.id }}</button>
                    <button v-if="provenance?.batchId && !evidence.batches.length" type="button" class="min-h-11 text-[var(--accent-primary)]" @click="inspectBatch(provenance.batchId!)">Inspect Causal Routing Chain · {{ provenance.batchId }}</button>
                  </template>
                </div>
              </div>
            </div>
            <p v-if="entry.kind === 'event'" class="text-[10px] text-[var(--text-muted)]">{{ entry.event.kind }} · {{ entry.event.disposition }}</p>
            <p class="mt-1 whitespace-pre-wrap break-words leading-relaxed text-[var(--text-primary)]">{{ entry.kind === 'message' ? entry.message.body : entry.event.summary }}</p>
            <p v-if="entry.kind === 'event' && (entry.event.kind === 'agent-run-failure' || entry.event.kind === 'agent-run-interruption')" class="mt-1 whitespace-pre-wrap break-words" :class="entry.event.kind === 'agent-run-failure' ? 'text-[var(--red-action)]' : 'text-[var(--text-secondary)]'">{{ entry.event.detail ?? (entry.event.kind === 'agent-run-failure' ? 'No error outcome was recorded.' : 'The interruption outcome is unavailable.') }}</p>
          </div>
          </template>
          </div>
          </div>
          <button v-if="hasNewEntries" type="button" class="chat-jump-latest absolute bottom-3 left-1/2 z-10 min-h-11 -translate-x-1/2 rounded-full border border-[var(--border-strong)] bg-[var(--bg-surface)] px-4 text-xs font-semibold text-[var(--accent-primary)] shadow-sm focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]" @click="jumpToLatest">Jump to latest <span aria-hidden="true">↓</span></button>
        </div>
        <div v-if="activeChatRuns.length" class="chat-run-actions flex flex-col gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] p-3 text-xs">
          <div v-for="run in activeChatRuns" :key="run.id" class="flex items-center justify-end gap-3">
            <!-- Hollow while starting, filled while working; the static ring survives reduced motion. -->
            <span class="chat-run-indicator flex min-w-0 items-center gap-2 text-[var(--text-primary)]"><span class="h-2 w-2 shrink-0 animate-pulse rounded-full ring-2 ring-[var(--accent-primary)] ring-offset-2 ring-offset-[var(--bg-surface-elevated)] motion-reduce:animate-none" :class="run.status === 'running' ? 'bg-[var(--accent-primary)]' : 'bg-transparent'" aria-hidden="true" /><span class="truncate">@{{ agentName(run.agentId) }} · {{ run.status === 'queued' ? 'starting…' : 'working…' }}</span></span>
            <Button variant="secondary" size="sm" class="chat-stop-run min-h-11 shrink-0" :disabled="!presentation.controlAvailable || project?.status !== 'active' || stoppingRunIds.has(run.id)" :aria-label="`Stop @${agentName(run.agentId)}`" @click="stopChatRun(run)">{{ stoppingRunIds.has(run.id) ? 'Stopping…' : 'Stop' }}</Button>
          </div>
        </div>
        <form class="chat-composer flex shrink-0 items-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] p-3" @submit.prevent="sendMessage">
          <input v-model="newMessage" type="text" :disabled="!canEnterText" :aria-label="`Message ${activeScope ? title(activeScope) : 'conversation'}`" :placeholder="activeScope?.kind === 'direct' ? `Message ${title(activeScope)} (deterministic direct wake)…` : activeScope?.kind === 'working-group' || activeScope?.kind === 'task-group' ? `Message ${title(activeScope)}…` : 'Message #general… (Use @agent or @all for immediate wake)'" class="min-h-11 min-w-0 flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 text-base md:text-xs text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]" />
          <Button variant="primary" size="sm" class="min-h-11" type="submit" :disabled="!canSend || !newMessage.trim()">Send</Button>
        </form>
      </section>
    </div>
    <ChatDialog :open="infoOpen" :title="`Conversation Details — ${activeScope ? title(activeScope) : ''}`" description="Scope identity, admission and routing policy" @update:open="infoOpen = $event">
      <div v-if="activeScope" class="space-y-3 text-xs text-[var(--text-secondary)]">
        <div class="rounded border border-[var(--border-subtle)] p-3"><strong class="block text-sm">{{ title(activeScope) }} · {{ kindLabel(activeScope) }}</strong><span>Project: {{ project?.displayName }} · {{ projectId }}</span><p v-if="inspection?.context.workingGroup">Goal: {{ inspection.context.workingGroup.goal }} · Rules: {{ inspection.context.workingGroup.rules.join('; ') }}</p><p v-if="inspection?.context.taskGroup">Task: {{ inspection.context.taskGroup.taskTitle }} · Goal: {{ inspection.context.taskGroup.goal }} · Rules: {{ inspection.context.taskGroup.rules.join('; ') }}<span v-if="inspection.scope.kind === 'task-group' && inspection.scope.status === 'frozen'"> · Frozen, history remains readable</span></p></div>
        <div class="rounded border border-[var(--border-subtle)] p-3"><strong>Project Wake Policy</strong><p>{{ project && currentVersion(project)?.wakePolicy === 'wake-model-assisted' ? 'Wake-Model Assisted (fixed collection window)' : 'Explicit Mentions Only' }}</p><p>Direct messages, exact mentions, and @all use deterministic addressing.</p></div>
        <div class="rounded border border-[var(--border-subtle)] p-3"><strong>Recent routing batches</strong><p v-if="!batches.length">No routing batches recorded for this Project.</p><button v-for="batch in batches" :key="batch.id" class="block min-h-11 text-left text-[var(--accent-primary)]" @click="inspectBatch(batch.id)">Inspect Causal Routing Chain · {{ batch.id }} · {{ batch.status }}</button></div>
        <Button v-if="activeGroup" variant="secondary" size="sm" class="min-h-11" :disabled="!presentation.controlAvailable || project?.status !== 'active' || activeGroup.status !== 'active'" @click="beginEditGroup">Edit Working Group</Button>
      </div>
      <template #footer><Button variant="primary" size="sm" class="close-chat-info-btn min-h-11" @click="infoOpen = false">Close</Button></template>
    </ChatDialog>
    <ChatDialog :open="editGroupOpen" title="Manage Working Group" description="Edit the current group or make its channel read-only without deleting history." @update:open="editGroupOpen = $event; disbandConfirm = false">
      <form class="flex flex-col gap-3 text-xs" @submit.prevent="saveGroup">
        <label for="chat-edit-name">Working Group Name *</label><input id="chat-edit-name" v-model="editName" required class="min-h-11 rounded border p-2" />
        <label for="chat-edit-goal">Goal</label><input id="chat-edit-goal" v-model="editGoal" class="min-h-11 rounded border p-2" />
        <label for="chat-edit-rules">Rules (one per line)</label><textarea id="chat-edit-rules" v-model="editRules" class="min-h-20 rounded border p-2" />
        <fieldset><legend>Agent Members</legend><label v-for="member in activeAgentMembers" :key="member.memberId" class="flex min-h-11 items-center gap-2"><input v-model="editMembers" type="checkbox" :value="member.memberId" />@{{ agentName(member.memberId) }}</label></fieldset>
        <p v-if="actionError" role="alert">{{ actionError }}</p>
        <p v-if="disbandConfirm">Disband this Working Group? Messages and membership history remain available, but the channel becomes read-only.</p>
      </form>
      <template #footer>
        <Button variant="secondary" size="sm" class="min-h-11" @click="editGroupOpen = false; disbandConfirm = false">Cancel</Button>
        <Button v-if="!disbandConfirm" variant="secondary" size="sm" class="min-h-11" :disabled="managingGroup || !presentation.controlAvailable" @click="disbandConfirm = true">Disband Working Group</Button>
        <Button v-if="disbandConfirm" variant="secondary" size="sm" class="min-h-11" :disabled="managingGroup || !presentation.controlAvailable" @click="disbandGroup">Confirm Disband</Button>
        <Button variant="primary" size="sm" class="min-h-11" :disabled="managingGroup || !presentation.controlAvailable || !editName.trim()" @click="saveGroup">Save Changes</Button>
      </template>
    </ChatDialog>
    <ChatDialog :open="createGroupOpen" title="Create Working Group" description="Create a focused Project collaboration channel. The Human creator is included automatically." @update:open="createGroupOpen = $event">
      <form class="flex flex-col gap-3 text-xs" @submit.prevent="createGroup">
        <label for="chat-wg-name" class="font-bold">Working Group Name *</label><input id="chat-wg-name" v-model="groupName" type="text" required class="min-h-11 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3" />
        <label for="chat-wg-goal" class="font-bold">Working Group Goal (Optional)</label><input id="chat-wg-goal" v-model="groupGoal" type="text" class="min-h-11 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3" />
        <fieldset><legend class="font-bold">Initial Agent Members</legend><label v-for="member in activeAgentMembers" :key="member.memberId" class="flex min-h-11 items-center gap-2"><input v-model="groupMembers" type="checkbox" :value="member.memberId" /><span><strong class="block">@{{ agentName(member.memberId) }}</strong><span v-if="member.responsibilities.length" class="block text-[var(--text-muted)]">{{ member.responsibilities.join('; ') }}</span></span></label></fieldset>
        <p v-if="actionError" role="alert">{{ actionError }}</p>
      </form>
      <template #footer><Button variant="secondary" size="sm" class="min-h-11" @click="createGroupOpen = false">Cancel</Button><Button variant="primary" size="sm" class="chat-create-wg-submit min-h-11" :disabled="!groupName.trim() || managingGroup || !presentation.controlAvailable" @click="createGroup">Create Working Group</Button></template>
    </ChatDialog>
  </div>
</template>

<style scoped>
/* A landscape phone can cross md while its keyboard leaves less than 520px.
   Touch devices still need a shrinkable pane and a non-zooming editor. */
@media (pointer: coarse) {
  .chat-layout { min-height: 0; }
  .chat-composer input { font-size: 1rem; }
}
</style>
