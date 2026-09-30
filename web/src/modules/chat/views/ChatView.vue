<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { MessageView, ProjectEventView } from '../../../../../src/web/views.ts';
import type { ConversationScopeView, ScopeInspectionView } from '../../../adapters/conversation-api.ts';
import type { RoutingBatchSummaryView, RoutingEvidenceView } from '../../../adapters/routing-api.ts';
import type { ProjectAuthorityView } from '../../../adapters/project-api.ts';
import { PROJECT_SERVICE } from '../../projects/types.ts';
import { CHAT_SERVICE, type ChatTimelineItem } from '../types.ts';
import { evidenceState, readOnlyReason } from '../evidence.ts';
import { useShellConnection } from '../../../shell/use-shell-connection.ts';
import { useAnnouncer } from '../../../primitives/announcer.ts';
import Icon from '../../../primitives/Icon.vue';
import Button from '../../../primitives/Button.vue';
import ChatDialog from './ChatDialog.vue';
import EmptyState from '../../../primitives/EmptyState.vue';

const route = useRoute();
const router = useRouter();
const service = inject(CHAT_SERVICE, null);
const projectService = inject(PROJECT_SERVICE, null);
const { presentation } = useShellConnection();
const announcer = useAnnouncer();
const projects = ref<readonly ProjectAuthorityView[]>([]);
const scopes = ref<readonly ConversationScopeView[]>([]);
const messages = ref<readonly MessageView[]>([]);
const events = ref<readonly ProjectEventView[]>([]);
const batches = ref<readonly RoutingBatchSummaryView[]>([]);
const inspection = ref<ScopeInspectionView | null>(null);
const loading = ref(true);
const detailLoading = ref(false);
const error = ref('');
const actionError = ref('');
const newMessage = ref('');
let pendingDelivery: { readonly scopeId: string; readonly body: string; readonly deliveryKey: string } | null = null;
const sending = ref(false);
const infoOpen = ref(false);
const createGroupOpen = ref(false);
const groupName = ref('');
const groupGoal = ref('');
const groupMembers = ref<string[]>([]);
const managingGroup = ref(false);
const evidenceOpen = ref<string | null>(null);
const evidence = ref<RoutingEvidenceView | null>(null);
const evidenceLoading = ref(false);
const provenance = ref<{ runId?: string; runStatus?: string; inputIds: readonly string[]; batchId?: string } | null>(null);
const evidenceTrigger = ref<HTMLElement | null>(null);
const seen = new Set<string>();
const unreadVersion = ref(0);
let generation = 0;
let detailGeneration = 0;
let unsubRuns: (() => void) | undefined;
const refreshTimers = new Set<ReturnType<typeof setTimeout>>();
const requestedScopeId = computed(() => typeof route.params['scopeId'] === 'string' ? route.params['scopeId'] as string : '');
const projectId = computed(() => typeof route.query['project'] === 'string' ? route.query['project'] as string : projects.value.find((p) => p.status === 'active')?.id ?? projects.value[0]?.id ?? '');
const project = computed(() => projects.value.find((p) => p.id === projectId.value));
const channelScopes = computed(() => scopes.value.filter((s) => s.kind === 'project'));
const workingGroups = computed(() => scopes.value.filter((s) => s.kind === 'working-group'));
const directScopes = computed(() => scopes.value.filter((s) => s.kind === 'direct'));
const activeAgentMembers = computed(() => project.value && currentVersion(project.value)?.memberships.filter((m) => m.memberKind === 'agent' && m.endedAt === undefined) || []);
const unopenedAgents = computed(() => {
  return activeAgentMembers.value.filter((member) => !directScopes.value.some((scope) => scope.kind === 'direct' && scope.participants.includes(member.memberId)));
});
const missingScope = computed(() => !!requestedScopeId.value && !loading.value && !scopes.value.some((s) => s.id === requestedScopeId.value));
const activeScope = computed(() => requestedScopeId.value ? scopes.value.find((s) => s.id === requestedScopeId.value) : channelScopes.value[0] ?? scopes.value[0]);
const activeMessages = computed(() => messages.value.filter((m) => m.scopeId === activeScope.value?.id));
const timeline = computed<ChatTimelineItem[]>(() => [
  ...activeMessages.value.map((message) => ({ kind: 'message' as const, message })),
  ...(activeScope.value?.kind === 'project' ? events.value.map((event) => ({ kind: 'event' as const, event })) : []),
].sort((a, b) => (a.kind === 'message' ? a.message.createdAt : a.event.createdAt) - (b.kind === 'message' ? b.message.createdAt : b.event.createdAt)));
const canSend = computed(() => !!service && !!activeScope.value && !detailLoading.value && inspection.value?.scope.id === activeScope.value.id && inspection.value.state.writable && presentation.value.controlAvailable && !sending.value);
const unavailableReason = computed(() => !presentation.value.controlAvailable ? `${presentation.value.label}. Shown facts may be stale; control actions are disabled, not queued.` :
  inspection.value && !inspection.value.state.writable ? readOnlyReason(inspection.value.state.reason) : detailLoading.value ? 'Checking conversation admission before sending.' : '');
const currentEvidenceState = computed(() => evidence.value ? evidenceState(evidence.value, evidenceMessage.value ?? undefined) : 'informational');
const evidenceMessage = computed(() => messages.value.find((m) => m.id === evidenceOpen.value));

function currentVersion(p: ProjectAuthorityView) { return p.content.versions.find((v) => v.version === p.content.currentVersion) ?? p.content.versions.at(-1); }
function title(scope: ConversationScopeView): string {
  if (scope.kind === 'project') return '#general';
  if (scope.kind === 'working-group') return scope.content.versions.find((v) => v.version === scope.content.currentVersion)?.displayName ?? scope.id;
  const humanIds = new Set(project.value && currentVersion(project.value)?.memberships.filter((m) => m.memberKind === 'human').map((m) => m.memberId));
  return `@${scope.participants.find((p) => !humanIds.has(p)) ?? scope.participants[1] ?? scope.id}`;
}
function kindLabel(scope: ConversationScopeView) { return scope.kind === 'project' ? 'Project channel' : scope.kind === 'working-group' ? 'Working group' : 'Direct message'; }
function icon(scope: ConversationScopeView) { return scope.kind === 'project' ? 'chat' : scope.kind === 'working-group' ? 'project' : 'agents'; }
function preview(scope: ConversationScopeView) {
  const last = [...messages.value].reverse().find((m) => m.scopeId === scope.id);
  return last?.body ?? (scope.kind === 'working-group' ? scope.content.versions.at(-1)?.goal : undefined) ?? 'No messages yet in this conversation.';
}
function latestTime(scope: ConversationScopeView) { const last = [...messages.value].reverse().find((m) => m.scopeId === scope.id); return last ? time(last.createdAt) : ''; }
function time(at: number) { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function unread(scope: ConversationScopeView) { void unreadVersion.value; return messages.value.filter((m) => m.scopeId === scope.id && !seen.has(m.id) && scope.id !== activeScope.value?.id).length; }
function markVisible() { for (const m of activeMessages.value) seen.add(m.id); unreadVersion.value++; }
function scopeKind(scope: ConversationScopeView) { return scope.kind === 'project' ? 'channel' : scope.kind === 'direct' ? 'direct-message' : 'working-group'; }
function scopePill(scope: ConversationScopeView) { return scope.kind === 'working-group' && scope.status === 'disbanded' ? 'Disbanded' : ''; }
function safeError() { return 'Could not load current Chat facts. Retry when the connection is available.'; }

async function loadProject() {
  if (!service || !projectService) { loading.value = false; error.value = 'Project Chat is unavailable: production authority is not connected.'; return; }
  const token = ++generation;
  loading.value = true;
  error.value = '';
  try {
    const listed = await projectService.listProjects();
    if (token !== generation) return;
    projects.value = listed;
    if (!projectId.value || !listed.some((p) => p.id === projectId.value)) { error.value = 'Project Not Found. Choose a Project from Overview.'; scopes.value = []; return; }
    const [scopeList, allMessages, projectEvents, routing] = await Promise.all([
      service.listScopes(projectId.value), service.listMessages(), service.listProjectEvents(projectId.value), service.listRoutingBatches(projectId.value),
    ]);
    if (token !== generation) return;
    scopes.value = scopeList;
    messages.value = allMessages.filter((m) => m.projectId === projectId.value || scopeList.some((s) => s.id === m.scopeId));
    events.value = projectEvents;
    batches.value = routing.batches;
    for (const m of messages.value) seen.add(m.id); // No server read-marker port: baseline existing history as seen this session.
    unreadVersion.value++;
  } catch { if (token === generation) error.value = safeError(); }
  finally { if (token === generation) loading.value = false; }
}
async function refreshMessages() {
  if (!service || !projectId.value) return;
  const id = projectId.value;
  const token = generation;
  try {
    const [all, projectEvents] = await Promise.all([service.listMessages(), service.listProjectEvents(id)]);
    if (token !== generation || id !== projectId.value) return;
    messages.value = all.filter((m) => m.projectId === id || scopes.value.some((s) => s.id === m.scopeId));
    events.value = projectEvents;
    markVisible();
  } catch { actionError.value = 'Could not refresh the conversation. Shown facts may be stale.'; }
}
async function loadScope() {
  const token = ++detailGeneration;
  inspection.value = null;
  evidenceOpen.value = null;
  if (!service || !activeScope.value || missingScope.value) return;
  detailLoading.value = true;
  markVisible();
  try {
    const inspected = await service.inspectScope(activeScope.value.id);
    if (token === detailGeneration) inspection.value = inspected;
  } catch { if (token === detailGeneration) actionError.value = 'Conversation admission could not be verified. Sending is disabled.'; }
  finally { if (token === detailGeneration) detailLoading.value = false; }
}
async function selectScope(scope: ConversationScopeView) {
  await router.push({ name: 'project-chat-scope', params: { scopeId: scope.id }, query: route.query });
  announcer.announce(`Opened ${title(scope)} conversation.`);
  await nextTick();
  (document.querySelector('.chat-mobile-back') as HTMLElement | null)?.focus();
}
async function openAgentDirect(agentId: string) {
  const humanId = project.value && currentVersion(project.value)?.memberships.find((member) => member.memberKind === 'human' && member.endedAt === undefined)?.memberId;
  if (!service || !presentation.value.controlAvailable || !humanId || !projectId.value) return;
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
  if (!service || !activeScope.value || activeScope.value.kind !== 'working-group' || !presentation.value.controlAvailable || managingGroup.value) return;
  managingGroup.value = true;
  try {
    await service.restoreWorkingGroup(activeScope.value.id);
    scopes.value = await service.listScopes(projectId.value);
    await loadScope();
    announcer.announce('Working Group restored; conversation is writable.');
  } catch { actionError.value = 'Working Group cannot be restored until its members are eligible.'; announcer.announce(actionError.value); }
  finally { managingGroup.value = false; }
}
async function closeScope() {
  const id = activeScope.value?.id;
  await router.push({ name: 'project-chat', query: route.query });
  await nextTick();
  const card = [...document.querySelectorAll<HTMLElement>('[data-scope-id]')].find((el) => el.dataset['scopeId'] === id);
  card?.focus();
}
async function sendMessage() {
  if (!canSend.value || !newMessage.value.trim() || !service || !activeScope.value) return;
  const scopeId = activeScope.value.id;
  const body = newMessage.value.trim();
  // A transport refusal can follow durable delivery. Retrying the unchanged
  // draft uses the same key so the server deduplicates rather than re-waking.
  const deliveryKey = pendingDelivery?.scopeId === scopeId && pendingDelivery.body === body
    ? pendingDelivery.deliveryKey : `web-${crypto.randomUUID()}`;
  pendingDelivery = { scopeId, body, deliveryKey };
  sending.value = true;
  actionError.value = '';
  try {
    await service.postMessage(pendingDelivery);
    pendingDelivery = null;
    newMessage.value = '';
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
  if (!hint) return;
  try {
    let trigger: RoutingEvidenceView | undefined;
    try { trigger = await service.messageRouting(hint); } catch { try { trigger = await service.eventRouting(hint); } catch { /* may name a batch */ } }
    const detail = trigger?.batches.find((item) => item.replies.some((reply) => reply.messageId === message.id));
    let batch = detail;
    if (!batch) { try { batch = await service.getRoutingBatch(hint); } catch { /* not a batch */ } }
    const wake = (batch?.wakes ?? trigger?.deterministicWakes ?? []).find((w) => w.agentId === message.authorId);
    const run = wake?.runId ? await service.getRun(wake.runId).catch(() => undefined) : undefined;
    provenance.value = { inputIds: batch?.inputs.map((item) => item.inputId) ?? (trigger ? [hint] : []), ...(batch ? { batchId: batch.batch.id } : {}), ...(wake?.runId ? { runId: wake.runId } : {}), ...(run ? { runStatus: run.status } : {}) };
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
    if (message && evidenceState(evidence.value, message) === 'projected') void resolveProvenance(message);
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
watch([activeScope, loading], () => { if (!loading.value) void loadScope(); });
watch(activeMessages, markVisible);
onMounted(() => { announcer.announce('Project chat view.'); void loadProject(); document.addEventListener('keydown', onKey); document.addEventListener('click', onDocumentClick);
  unsubRuns = service?.subscribeRuns(() => {
    void refreshMessages();
    // Run settlement can reach the event stream just before its reply projection.
    for (const delay of [400, 1500]) {
      const timer = setTimeout(() => { refreshTimers.delete(timer); void refreshMessages(); }, delay);
      refreshTimers.add(timer);
    }
  }); });
onUnmounted(() => { generation++; detailGeneration++; unsubRuns?.(); for (const timer of refreshTimers) clearTimeout(timer); refreshTimers.clear(); document.removeEventListener('keydown', onKey); document.removeEventListener('click', onDocumentClick); });
</script>

<template>
  <div class="chat-view flex h-full min-h-0 flex-col bg-[var(--bg-app)] p-3 sm:p-5">
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
    <div v-else class="flex min-h-[520px] flex-1 overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-xs md:flex-row" data-chat-layout="split">
      <aside class="w-full shrink-0 flex-col gap-1 overflow-y-auto bg-[var(--bg-surface-elevated)] p-3 md:w-72 md:border-r lg:w-80" :class="requestedScopeId ? 'hidden md:flex' : 'flex'" aria-label="Conversation scopes">
        <div class="flex items-center justify-between px-2 pb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
          <span>Conversations &amp; Groups</span><span>{{ scopes.length }} Scopes</span>
        </div>
        <template v-for="section in [{ label: 'Project Channels', items: channelScopes }, { label: `Working Groups (${workingGroups.length})`, items: workingGroups }, { label: `Direct Messages (${directScopes.length + unopenedAgents.length})`, items: directScopes }]" :key="section.label">
          <div class="chat-section border-t border-[var(--border-subtle)] pt-2">
            <div class="flex items-center justify-between px-2 pb-1"><h2 class="text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">{{ section.label }}</h2><button v-if="section.label.startsWith('Working Groups')" type="button" class="chat-create-wg min-h-11 px-2 text-[11px] font-semibold text-[var(--accent-primary)] disabled:opacity-60" :disabled="!presentation.controlAvailable || project?.status !== 'active'" @click="createGroupOpen = true"><Icon name="plus" :size="12" /> New WG</button></div>
            <p v-if="!section.items.length && !section.label.startsWith('Direct Messages')" class="px-2 py-2 text-xs text-[var(--text-muted)]">No conversations yet.</p>
            <button v-for="scope in section.items" :key="scope.id" type="button" :data-scope-id="scope.id" :data-scope-kind="scopeKind(scope)" :aria-current="activeScope?.id === scope.id ? 'page' : undefined"
              class="chat-scope-card mb-1 flex min-h-[64px] w-full items-start gap-2 rounded border p-2.5 text-left focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
              :class="activeScope?.id === scope.id ? 'border-[var(--accent-primary)] bg-[var(--bg-surface)] ring-1 ring-[var(--accent-primary)]' : 'border-transparent hover:border-[var(--border-strong)]'" @click="selectScope(scope)">
              <span class="rounded bg-[var(--bg-surface)] p-1.5 text-[var(--accent-primary)]"><Icon :name="icon(scope)" :size="17" /></span>
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-1.5"><strong class="truncate text-xs text-[var(--text-primary)]">{{ title(scope) }}</strong><span v-if="scopePill(scope)" class="text-[10px] text-[var(--text-muted)]">{{ scopePill(scope) }}</span><span class="ml-auto shrink-0 text-[10px] text-[var(--text-muted)]">{{ latestTime(scope) }}</span></span>
                <span class="block text-[10px] text-[var(--text-muted)]">{{ kindLabel(scope) }}</span>
                <span class="block truncate text-[11px] text-[var(--text-secondary)]">{{ preview(scope) }}</span>
                <span v-if="unread(scope)" class="chat-unread-badge mt-1 inline-block rounded-full bg-[var(--accent-primary)] px-2 text-[10px] font-bold text-[var(--text-inverse)]">{{ unread(scope) }} new</span>
              </span>
            </button>
            <template v-if="section.label.startsWith('Direct Messages')">
              <button v-for="member in unopenedAgents" :key="member.memberId" type="button" :disabled="!presentation.controlAvailable" class="chat-direct-unopened mb-1 flex min-h-[64px] w-full items-center gap-2 rounded border border-transparent p-2.5 text-left text-xs hover:border-[var(--border-strong)] disabled:opacity-60" @click="openAgentDirect(member.memberId)">
                <Icon name="agents" :size="17" class="text-[var(--accent-primary)]" /><span><strong class="block">@{{ member.memberId }}</strong><span class="block text-[10px] text-[var(--text-muted)]">Direct message · Open conversation</span><span class="block truncate text-[var(--text-secondary)]">{{ member.responsibilities.join('; ') || 'No messages yet with agent.' }}</span></span>
              </button>
            </template>
          </div>
        </template>
      </aside>
      <section class="min-w-0 flex-1 flex-col" :class="requestedScopeId ? 'flex' : 'hidden md:flex'" aria-label="Conversation detail">
        <header class="flex min-h-14 items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3">
          <div class="flex min-w-0 items-center gap-2">
            <button type="button" class="chat-mobile-back min-h-11 rounded px-2 text-xs text-[var(--accent-primary)] md:hidden" @click="closeScope"><Icon name="chevron-left" :size="16" /> Back to Chats</button>
            <Icon v-if="activeScope" :name="icon(activeScope)" :size="16" class="hidden text-[var(--accent-primary)] md:block" />
            <strong class="truncate text-xs text-[var(--text-primary)]">{{ activeScope ? title(activeScope) : 'No conversation selected' }}</strong>
            <span v-if="activeScope" class="hidden text-[10px] text-[var(--text-muted)] sm:inline">{{ kindLabel(activeScope) }}</span>
          </div>
          <Button v-if="activeScope" variant="secondary" size="icon" class="chat-info-btn h-10 w-10 shrink-0" title="Conversation Information" aria-label="Conversation Information" @click="infoOpen = true"><Icon name="info" :size="16" /></Button>
        </header>
        <div v-if="!presentation.controlAvailable" class="chat-offline-banner border-b border-[var(--yellow-attention)] bg-[var(--yellow-attention-bg)] p-3 text-xs" role="status">{{ presentation.label }}. Shown facts may be stale; control actions are disabled, not queued.</div>
        <div v-if="inspection && !inspection.state.writable" class="chat-readonly-banner flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] p-3 text-xs" role="status"><span><Icon name="alert" :size="14" /> {{ readOnlyReason(inspection.state.reason) }}</span><Button v-if="inspection.state.reason === 'working-group-disbanded' && project?.status === 'active'" variant="secondary" size="sm" class="min-h-11 shrink-0" :disabled="!presentation.controlAvailable || managingGroup" @click="restoreGroup">Restore WG</Button></div>
        <div v-if="actionError" class="p-3 text-xs text-[var(--red-action)]" role="alert">{{ actionError }}</div>
        <div class="chat-messages-body flex flex-1 flex-col gap-3 overflow-y-auto p-4" :aria-busy="detailLoading">
          <div v-if="detailLoading" class="chat-detail-loading text-xs text-[var(--text-muted)]" role="status">Checking conversation admission…</div>
          <div v-if="!timeline.length && !detailLoading" class="chat-empty-state m-auto text-center text-xs text-[var(--text-muted)]"><Icon name="chat" :size="22" class="mx-auto mb-2" /><strong class="block">No messages yet in this conversation scope.</strong><p>Send a message or @mention a project agent below to begin collaboration.</p></div>
          <div v-for="entry in timeline" :key="entry.kind === 'message' ? entry.message.id : entry.event.id" :data-message-id="entry.kind === 'message' ? entry.message.id : undefined" :data-event-id="entry.kind === 'event' ? entry.event.id : undefined"
            class="chat-msg max-w-[90%] rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] p-3 text-xs" :class="entry.kind === 'message' && entry.message.authorKind === 'human' ? 'self-end' : 'self-start'">
            <div class="flex items-center justify-between gap-3">
              <strong class="text-[var(--text-primary)]">{{ entry.kind === 'event' ? 'Project event' : entry.message.authorKind === 'human' ? 'Human Operator' : `@${entry.message.authorId}` }}</strong>
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
          </div>
        </div>
        <form class="chat-composer flex items-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] p-3" @submit.prevent="sendMessage">
          <input v-model="newMessage" type="text" :disabled="!canSend" :aria-label="`Message ${activeScope ? title(activeScope) : 'conversation'}`" :placeholder="unavailableReason || (activeScope?.kind === 'direct' ? `Message ${title(activeScope)} (deterministic direct wake)…` : activeScope?.kind === 'working-group' ? `Message ${title(activeScope)}…` : 'Message #general… (Use @agent or @all for immediate wake)')" class="min-h-11 min-w-0 flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 text-xs text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]" />
          <Button variant="primary" size="sm" class="min-h-11" type="submit" :disabled="!canSend || !newMessage.trim()">Send</Button>
        </form>
      </section>
    </div>
    <ChatDialog :open="infoOpen" :title="`Conversation Details — ${activeScope ? title(activeScope) : ''}`" description="Scope identity, admission and routing policy" @update:open="infoOpen = $event">
      <div v-if="activeScope" class="space-y-3 text-xs text-[var(--text-secondary)]">
        <div class="rounded border border-[var(--border-subtle)] p-3"><strong class="block text-sm">{{ title(activeScope) }} · {{ kindLabel(activeScope) }}</strong><span>Project: {{ project?.displayName }} · {{ projectId }}</span><p v-if="inspection?.context.workingGroup">Goal: {{ inspection.context.workingGroup.goal }} · Rules: {{ inspection.context.workingGroup.rules.join('; ') }}</p></div>
        <div class="rounded border border-[var(--border-subtle)] p-3"><strong>Project Wake Policy</strong><p>{{ project && currentVersion(project)?.wakePolicy === 'wake-model-assisted' ? 'Wake-Model Assisted (fixed collection window)' : 'Explicit Mentions Only' }}</p><p>Direct messages, exact mentions, and @all use deterministic addressing.</p></div>
        <div class="rounded border border-[var(--border-subtle)] p-3"><strong>Recent routing batches</strong><p v-if="!batches.length">No routing batches recorded for this Project.</p><button v-for="batch in batches" :key="batch.id" class="block min-h-11 text-left text-[var(--accent-primary)]" @click="inspectBatch(batch.id)">Inspect Causal Routing Chain · {{ batch.id }} · {{ batch.status }}</button></div>
      </div>
      <template #footer><Button variant="primary" size="sm" class="close-chat-info-btn min-h-11" @click="infoOpen = false">Close</Button></template>
    </ChatDialog>
    <ChatDialog :open="createGroupOpen" title="Create Working Group" description="Create a focused Project collaboration channel. The Human creator is included automatically." @update:open="createGroupOpen = $event">
      <form class="flex flex-col gap-3 text-xs" @submit.prevent="createGroup">
        <label for="chat-wg-name" class="font-bold">Working Group Name *</label><input id="chat-wg-name" v-model="groupName" type="text" required class="min-h-11 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3" />
        <label for="chat-wg-goal" class="font-bold">Working Group Goal (Optional)</label><input id="chat-wg-goal" v-model="groupGoal" type="text" class="min-h-11 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3" />
        <fieldset><legend class="font-bold">Initial Agent Members</legend><label v-for="member in activeAgentMembers" :key="member.memberId" class="flex min-h-11 items-center gap-2"><input v-model="groupMembers" type="checkbox" :value="member.memberId" />@{{ member.memberId }} · {{ member.responsibilities.join('; ') }}</label></fieldset>
        <p v-if="actionError" role="alert">{{ actionError }}</p>
      </form>
      <template #footer><Button variant="secondary" size="sm" class="min-h-11" @click="createGroupOpen = false">Cancel</Button><Button variant="primary" size="sm" class="chat-create-wg-submit min-h-11" :disabled="!groupName.trim() || managingGroup || !presentation.controlAvailable" @click="createGroup">Create Working Group</Button></template>
    </ChatDialog>
  </div>
</template>
