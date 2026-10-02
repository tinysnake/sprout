<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, inject, watch } from 'vue';
import Icon from '../primitives/Icon.vue';
import Button from '../primitives/Button.vue';
import Badge from '../primitives/Badge.vue';
import Dialog from '../primitives/Dialog.vue';
import EmptyState from '../primitives/EmptyState.vue';
import { SETTINGS_SERVICE, type SettingsService, type SettingsCategoryTab } from '../modules/settings/ports.js';
import { RouterLink, useRouter } from 'vue-router';
import { EVENT_STATES, isDiagnosticTarget, projectDiagnosticCorrelation, type OperatorSettings, type WebDiagnostic } from '../../../src/operations/contract.ts';
import type { BrowserSessionView } from '../adapters/operator-session-api.js';
import type { BrowserTransportState } from '../transport/browser-transport.js';

const props = defineProps<{
  service?: SettingsService;
}>();

const injectedService = inject<SettingsService | undefined>(SETTINGS_SERVICE, undefined);
const activeService = computed(() => props.service ?? injectedService);
const hasAuthority = computed(() => activeService.value !== undefined);

const activeSubTab = ref<SettingsCategoryTab>('access');
const isLoading = ref(true);
const isStale = ref(false);
const failureMessage = ref<string | null>(null);
const readFailed = ref(false);
const exportSuccessMessage = ref<string | null>(null);
const copySuccess = ref(false);

// Distinct risk-bearing session revocation dialog states
const isRevokeOneDialogOpen = ref(false);
const sessionToRevoke = ref<BrowserSessionView | null>(null);
const isRevokingOne = ref(false);

const isRevokeOthersDialogOpen = ref(false);
const isRevokingOthers = ref(false);

// Operational data
const settingsData = ref<OperatorSettings | null>(null);
const sessionsData = ref<readonly BrowserSessionView[]>([]);
const diagnosticsData = ref<WebDiagnostic | null>(null);
const router = useRouter();
const diagnosticEvents = computed(() => (diagnosticsData.value?.events ?? []).filter(event =>
  Number.isSafeInteger(event.sequence) && event.sequence > 0 &&
  Object.hasOwn(EVENT_STATES, event.kind) && (EVENT_STATES[event.kind] as readonly string[]).includes(event.state),
).slice(-50).map(event => {
  const date = new Date(event.at);
  const validTime = Number.isSafeInteger(event.at) && event.at >= 0 && !Number.isNaN(date.getTime());
  const target = isDiagnosticTarget(event.target) ? event.target : undefined;
  const resolved = target ? router.resolve(target.path) : undefined;
  const destination = target && resolved?.matched.length
    ? { path: resolved.path, query: { ...resolved.query, ...(target.projectId ? { project: target.projectId } : {}) } }
    : undefined;
  return {
    sequence: event.sequence, kind: event.kind, state: event.state,
    correlation: projectDiagnosticCorrelation(event.correlation ?? {}), destination,
    datetime: validTime ? date.toISOString() : undefined,
    time: validTime ? date.toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Time unavailable',
  };
}));

let unsubscribeTransport: (() => void) | null = null;

function syncTransportState(state: BrowserTransportState) {
  isStale.value = state.connection !== 'online';
  if (state.connection === 'offline' && !settingsData.value) {
    isLoading.value = false;
  }
}

async function loadData() {
  if (!activeService.value) {
    isLoading.value = false;
    return;
  }

  isLoading.value = true;
  failureMessage.value = null;

  try {
    const service = activeService.value;
    syncTransportState(service.state());

    const [settings, sessions, diag] = await Promise.all([
      service.loadSettings(),
      service.loadSessions(),
      service.loadDiagnostics(),
    ]);

    settingsData.value = settings;
    sessionsData.value = sessions;
    diagnosticsData.value = diag;
    readFailed.value = false;
  } catch (err) {
    readFailed.value = true;
    failureMessage.value = err instanceof Error ? err.message : 'Failed to load operator settings';
  } finally {
    isLoading.value = false;
  }
}

onMounted(() => {
  if (activeService.value) {
    unsubscribeTransport = activeService.value.subscribeState(syncTransportState);
    loadData();
  } else {
    isLoading.value = false;
  }
});

watch(activeService, (newService) => {
  if (unsubscribeTransport) {
    unsubscribeTransport();
    unsubscribeTransport = null;
  }
  if (newService) {
    unsubscribeTransport = newService.subscribeState(syncTransportState);
    loadData();
  } else {
    isLoading.value = false;
  }
});

onUnmounted(() => {
  if (unsubscribeTransport) {
    unsubscribeTransport();
    unsubscribeTransport = null;
  }
});

const activeSessions = computed(() => sessionsData.value);
const activeSessionCount = computed(() => activeSessions.value.length);
const canMutateSessions = computed(() => hasAuthority.value && !isStale.value && !isLoading.value && !readFailed.value);
const canRevokeOthers = computed(() => activeSessionCount.value > 1 && canMutateSessions.value);

// A dialog can outlive its live transport snapshot. Never submit or queue offline.
function hasLiveMutationAuthority() {
  const service = activeService.value;
  if (!service) return false;
  syncTransportState(service.state());
  return canMutateSessions.value;
}

// Time formatter (relative and fallback timestamp)
function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return 'Unknown';
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return 'Just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Revoke One Session flow
function promptRevokeSession(session: BrowserSessionView) {
  if (session.current || !hasLiveMutationAuthority()) return;
  sessionToRevoke.value = session;
  isRevokeOneDialogOpen.value = true;
}

async function confirmRevokeSession() {
  if (!sessionToRevoke.value || !hasLiveMutationAuthority() || isRevokingOne.value) return;
  isRevokingOne.value = true;
  failureMessage.value = null;
  try {
    await activeService.value!.revokeSession(sessionToRevoke.value.id);
    isRevokeOneDialogOpen.value = false;
    sessionToRevoke.value = null;
    await loadData();
  } catch (err) {
    failureMessage.value = err instanceof Error ? err.message : 'Failed to revoke browser session';
  } finally {
    isRevokingOne.value = false;
  }
}

// Revoke All Others flow
function promptRevokeOthers() {
  if (!hasLiveMutationAuthority() || !canRevokeOthers.value) return;
  isRevokeOthersDialogOpen.value = true;
}

async function confirmRevokeOthers() {
  if (!hasLiveMutationAuthority() || !canRevokeOthers.value || isRevokingOthers.value) return;
  isRevokingOthers.value = true;
  failureMessage.value = null;
  try {
    await activeService.value!.revokeOtherSessions();
    isRevokeOthersDialogOpen.value = false;
    await loadData();
  } catch (err) {
    failureMessage.value = err instanceof Error ? err.message : 'Failed to revoke other browser sessions';
  } finally {
    isRevokingOthers.value = false;
  }
}

// Export Sanitized Diagnostics flow
async function handleExportDiagnostics() {
  if (!activeService.value) return;
  failureMessage.value = null;
  exportSuccessMessage.value = null;

  try {
    const diagnostic = await activeService.value.exportDiagnostics();

    // Trigger browser download of ONLY the sanitized contract JSON
    const jsonStr = JSON.stringify(diagnostic, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sprout-diagnostics.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    exportSuccessMessage.value = '✓ Sanitized diagnostics contract downloaded (JSON)';
    setTimeout(() => {
      exportSuccessMessage.value = null;
    }, 5000);
  } catch (err) {
    failureMessage.value = err instanceof Error ? err.message : 'Failed to export sanitized diagnostics';
  }
}

// Copy durable data location to clipboard
async function handleCopyLocation() {
  const relativeLocation = '~/.sprout/data/';
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(relativeLocation);
    }
    copySuccess.value = true;
    setTimeout(() => {
      copySuccess.value = false;
    }, 3000);
  } catch {
    copySuccess.value = true;
  }
}

// Keyboard navigation on status summary cards
function handleStatusKey(e: KeyboardEvent, tab: SettingsCategoryTab) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    activeSubTab.value = tab;
  }
}
</script>

<template>
  <div class="settings-view flex flex-col min-h-full bg-[var(--bg-app)]">
    <div class="p-4 sm:p-6 pb-28 md:pb-16 w-full max-w-[1920px] mx-auto flex flex-col gap-6">

      <!-- 1. Header & Boundary Note (Authoritative Product Prototype IA) -->
      <header class="settings-page-header border-b border-[var(--border-subtle)] pb-4 flex flex-col gap-2.5">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 class="settings-page-title text-base sm:text-lg font-bold text-[var(--text-primary)] flex items-center gap-2">
              <Icon name="settings" :size="19" />
              <span>General & Operator Settings</span>
            </h2>
            <p class="settings-page-description text-xs text-[var(--text-secondary)] mt-0.5">
              Identity, access, compatibility, durable data, and diagnostics for one local technical operator.
            </p>
          </div>
          <Badge variant="info">Manage / Settings</Badge>
        </div>
        <div class="settings-boundary-note p-3 rounded-[var(--radius-sm)] bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          <Icon name="shield" :size="16" class="text-[var(--green-ready)] shrink-0" />
          <span><strong>Routine operation stays in Web.</strong> Host-owned credentials, installation, startup, network policy, and offline diagnostics stay on the Sprout host.</span>
        </div>
      </header>

      <!-- Failure state alert banner -->
      <div
        v-if="failureMessage"
        class="settings-failure-alert p-3 rounded-[var(--radius-sm)] bg-[var(--red-action-bg)] border border-[var(--red-action-border)] text-[var(--red-action)] text-xs flex items-center justify-between gap-2"
        role="alert"
      >
        <div class="flex items-center gap-2">
          <Icon name="alert" :size="16" class="shrink-0" />
          <span><strong>Operation failed:</strong> {{ failureMessage }}</span>
        </div>
        <Button variant="ghost" size="xs" class="min-h-[44px] text-xs" @click="failureMessage = null">Dismiss</Button>
      </div>

      <!-- Stale connection state banner -->
      <div
        v-if="isStale"
        class="settings-stale-notice p-3 rounded-[var(--radius-sm)] bg-[var(--yellow-attention-bg)] border border-[var(--yellow-attention-border)] text-[var(--yellow-attention)] text-xs flex items-center gap-2"
        role="status"
      >
        <Icon name="warning" :size="16" class="shrink-0" />
        <span><strong>Connection is stale:</strong> Transport is reconnecting or disconnected. Showing cached operational facts. Session revocation is disabled until a live connection is re-established.</span>
      </div>

      <!-- Export success toast/banner -->
      <div
        v-if="exportSuccessMessage"
        class="p-3 rounded-[var(--radius-sm)] bg-[var(--green-ready-bg)] border border-[var(--green-ready-border)] text-[var(--green-ready)] text-xs font-semibold flex items-center gap-2"
      >
        <Icon name="check" :size="16" />
        <span>{{ exportSuccessMessage }}</span>
      </div>

      <!-- Unavailable State: when no authority/service is wired -->
      <div v-if="!hasAuthority" class="settings-unavailable-state flex items-center justify-center p-8 h-full">
        <EmptyState
          icon="settings"
          title="Settings Authority Unavailable"
          description="Web cannot reach Sprout or no settings authority is configured. No command is queued offline. If Web is unavailable, run the host-local diagnostic command in the Sprout user session: sprout worker status --diagnostics."
        />
      </div>

      <!-- Loading State -->
      <div v-else-if="isLoading" class="settings-loading-state flex flex-col items-center justify-center p-12 text-center h-64 gap-3">
        <Icon name="refresh" class="animate-spin text-[var(--accent-primary)]" :size="28" />
        <span class="text-sm font-semibold text-[var(--text-primary)]">Loading Operator Settings</span>
        <span class="text-xs text-[var(--text-muted)]">Querying session authority, compatibility facts, and diagnostic status...</span>
      </div>

      <div v-else-if="readFailed" class="settings-read-unavailable p-8" role="status">
        <EmptyState
          icon="warning"
          title="Operator Settings Could Not Be Loaded"
          description="Operational facts are unavailable because a required read failed. No command is queued. Use host-local diagnostics if Web remains unavailable."
        />
        <Button variant="secondary" class="min-h-[44px] mt-4" @click="loadData">Retry reads</Button>
      </div>

      <!-- Normal / Live Content Layout -->
      <template v-else>
        <!-- 2. Status Summary Strip (Interactive 3-item strip with touch floor & keyboard navigation) -->
        <section class="settings-status-strip grid grid-cols-1 sm:grid-cols-3 gap-3" aria-label="Settings status summary">
          <button
            type="button"
            class="settings-status-card text-left p-3.5 rounded-[var(--radius-sm)] border transition-all cursor-pointer shadow-xs flex items-center gap-2.5 select-none min-h-[44px]"
            :class="activeSubTab === 'access' ? 'border-[var(--accent-primary)] bg-[var(--bg-surface-elevated)] ring-1 ring-[var(--accent-primary)]' : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)]'"
            data-status-tab="access"
            title="Switch to Access & Security"
            @click="activeSubTab = 'access'"
            @keydown="handleStatusKey($event, 'access')"
          >
            <Icon name="check" :size="16" class="text-[var(--green-ready)] shrink-0" />
            <div class="min-w-0">
              <strong class="text-xs text-[var(--text-primary)] block truncate">Operator Access</strong>
              <span class="text-[11px] text-[var(--text-muted)] block truncate">Authenticated</span>
            </div>
          </button>

          <button
            type="button"
            class="settings-status-card text-left p-3.5 rounded-[var(--radius-sm)] border transition-all cursor-pointer shadow-xs flex items-center gap-2.5 select-none min-h-[44px]"
            :class="activeSubTab === 'system' ? 'border-[var(--accent-primary)] bg-[var(--bg-surface-elevated)] ring-1 ring-[var(--accent-primary)]' : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)]'"
            data-status-tab="system"
            title="Switch to Instance & System"
            @click="activeSubTab = 'system'"
            @keydown="handleStatusKey($event, 'system')"
          >
            <Icon name="server" :size="16" class="text-[var(--text-muted)] shrink-0" />
            <div class="min-w-0">
              <strong class="text-xs text-[var(--text-primary)] block truncate">Instance & Protocol</strong>
              <span class="text-[11px] text-[var(--text-muted)] block truncate">Supported protocol majors: {{ settingsData?.versions.workerProtocol.minMajor ?? 'Unknown' }}–{{ settingsData?.versions.workerProtocol.maxMajor ?? 'Unknown' }}</span>
            </div>
          </button>

          <button
            type="button"
            class="settings-status-card text-left p-3.5 rounded-[var(--radius-sm)] border transition-all cursor-pointer shadow-xs flex items-center gap-2.5 select-none min-h-[44px]"
            :class="activeSubTab === 'system' ? 'border-[var(--accent-primary)] bg-[var(--bg-surface-elevated)] ring-1 ring-[var(--accent-primary)]' : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)]'"
            data-status-tab="system"
            title="Switch to Instance & System"
            @click="activeSubTab = 'system'"
            @keydown="handleStatusKey($event, 'system')"
          >
            <Icon name="warning" :size="16" class="text-[var(--yellow-attention)] shrink-0" />
            <div class="min-w-0">
              <strong class="text-xs text-[var(--text-primary)] block truncate">Migration Guard</strong>
              <span class="text-[11px] text-[var(--text-muted)] block truncate">Verify safety copy on host</span>
            </div>
          </button>
        </section>

        <!-- 3. Sub-tabs Navigation (Responsive 3-column segmented bar, 44px min touch target) -->
        <nav
          class="settings-sub-tabs flex items-center gap-1 sm:gap-2 bg-[var(--bg-surface-elevated)] p-1 rounded-md border border-[var(--border-subtle)] w-full max-w-2xl shadow-xs"
          role="tablist"
          aria-label="Settings categories"
        >
          <button
            type="button"
            role="tab"
            :aria-selected="activeSubTab === 'access'"
            data-settings-tab="access"
            class="settings-tab-access flex-1 flex flex-col sm:flex-row items-center justify-center gap-1.5 py-2.5 px-3 rounded-[var(--radius-sm)] text-xs font-semibold cursor-pointer select-none transition-all min-h-[44px]"
            :class="activeSubTab === 'access' ? 'bg-[var(--accent-primary)] text-[var(--text-inverse)] font-bold shadow-xs' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)]'"
            @click="activeSubTab = 'access'"
          >
            <Icon name="shield" :size="15" />
            <span class="truncate">Access & Security</span>
          </button>

          <button
            type="button"
            role="tab"
            :aria-selected="activeSubTab === 'system'"
            data-settings-tab="system"
            class="settings-tab-system flex-1 flex flex-col sm:flex-row items-center justify-center gap-1.5 py-2.5 px-3 rounded-[var(--radius-sm)] text-xs font-semibold cursor-pointer select-none transition-all min-h-[44px]"
            :class="activeSubTab === 'system' ? 'bg-[var(--accent-primary)] text-[var(--text-inverse)] font-bold shadow-xs' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)]'"
            @click="activeSubTab = 'system'"
          >
            <Icon name="server" :size="15" />
            <span class="truncate">Instance & System</span>
          </button>

          <button
            type="button"
            role="tab"
            :aria-selected="activeSubTab === 'data'"
            data-settings-tab="data"
            class="settings-tab-data flex-1 flex flex-col sm:flex-row items-center justify-center gap-1.5 py-2.5 px-3 rounded-[var(--radius-sm)] text-xs font-semibold cursor-pointer select-none transition-all min-h-[44px]"
            :class="activeSubTab === 'data' ? 'bg-[var(--accent-primary)] text-[var(--text-inverse)] font-bold shadow-xs' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)]'"
            @click="activeSubTab = 'data'"
          >
            <Icon name="box" :size="15" />
            <span class="truncate">Data & Diagnostics</span>
          </button>
        </nav>

        <!-- Content Area: 3 Category Views -->

        <!-- Category 1: Access & Security -->
        <div v-if="activeSubTab === 'access'" class="grid grid-cols-1 lg:grid-cols-2 gap-5" data-settings-tab-panel="access">
          <!-- Card 1: Operator identity and access boundary -->
          <section class="card settings-card p-4 sm:p-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col justify-between gap-4 shadow-xs" data-settings-section="identity">
            <div>
              <div class="flex items-center justify-between gap-2 mb-2">
                <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)] flex items-center gap-1.5">
                  <Icon name="shield" :size="14" class="text-[var(--green-ready)]" />
                  <span>Operator identity and access boundary</span>
                </h3>
                <Badge variant="success">Authenticated</Badge>
              </div>
              <p class="text-xs text-[var(--text-secondary)] leading-relaxed mb-3">
                Operator Access Boundary: One Sprout instance has one operator identity. A private network is transport, not authority.
              </p>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                  <span class="text-[10px] uppercase font-bold text-[var(--text-muted)] block">Operator</span>
                  <strong class="text-[var(--text-primary)]">Local Operator</strong>
                  <span class="block text-[10px] font-mono text-[var(--text-muted)]">local-operator-1</span>
                </div>
                <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                  <span class="text-[10px] uppercase font-bold text-[var(--text-muted)] block">Identity Model</span>
                  <strong class="text-[var(--text-primary)]">Single operator</strong>
                  <span class="block text-[10px] text-[var(--text-muted)]">Private authority</span>
                </div>
                <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                  <span class="text-[10px] uppercase font-bold text-[var(--text-muted)] block">Browser Boundary</span>
                  <strong class="text-[var(--text-primary)]">Loopback or private network</strong>
                  <span class="block text-[10px] text-[var(--text-muted)]">Public Internet exposure is unsupported</span>
                </div>
                <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                  <span class="text-[10px] uppercase font-bold text-[var(--text-muted)] block">Credential Access</span>
                  <strong class="text-[var(--text-primary)]">Host-local only</strong>
                  <span class="block text-[10px] text-[var(--text-muted)]">Agents and Workers never receive it</span>
                </div>
              </div>
            </div>

            <!-- Browser Sessions Section -->
            <div class="pt-4 border-t border-[var(--border-subtle)] flex flex-col gap-3">
              <div class="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <h4 class="text-xs uppercase tracking-wider font-bold text-[var(--text-primary)] flex items-center gap-1.5">
                    <Icon name="desktop" :size="14" />
                    <span>Authorized Browser Sessions</span>
                  </h4>
                  <span class="text-[11px] text-[var(--text-secondary)]">
                    {{ activeSessionCount }} active session{{ activeSessionCount === 1 ? '' : 's' }} share this operator identity.
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  class="revoke-others-btn min-h-[44px] text-xs text-[var(--red-action)] hover:bg-[var(--red-action-bg)]"
                  :disabled="!canRevokeOthers"
                  @click="promptRevokeOthers"
                >
                  Revoke other sessions
                </Button>
              </div>

              <div class="space-y-2" aria-label="Browser sessions">
                <div
                  v-for="sess in activeSessions"
                  :key="sess.id"
                  class="settings-session-row p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex items-center justify-between gap-3 text-xs"
                  :data-session-id="sess.id"
                >
                  <div class="flex items-center gap-2.5 min-w-0">
                    <div class="settings-session-icon shrink-0 text-[var(--text-muted)]">
                      <Icon :name="sess.current ? 'desktop' : 'phone'" :size="16" />
                    </div>
                    <div class="min-w-0">
                      <strong class="text-[var(--text-primary)] block truncate">
                        {{ sess.current ? 'Desktop Browser (Current Session)' : 'Mobile Browser (Phone Viewport)' }}
                      </strong>
                      <span class="text-[10px] text-[var(--text-muted)] block truncate">
                        Private network or loopback · Active {{ formatRelativeTime(sess.lastSeenAt) }}
                      </span>
                    </div>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <Badge v-if="sess.current" variant="success">This session</Badge>
                    <template v-else>
                      <Badge variant="info">Active</Badge>
                      <Button
                        variant="secondary"
                        size="sm"
                        class="session-revoke-btn min-h-[44px] text-xs"
                        :data-session-id="sess.id"
                        :disabled="!canMutateSessions"
                        @click="promptRevokeSession(sess)"
                      >
                        Revoke
                      </Button>
                    </template>
                  </div>
                </div>
              </div>

              <p class="text-[11px] text-[var(--text-muted)] leading-relaxed pt-1">
                Session revocation blocks future commands from that browser. It does not stop an already admitted Task; inspect its authoritative Project or Environment surface.
              </p>
            </div>
          </section>

          <!-- Card 2: Credential recovery and rotation -->
          <section class="card settings-card p-4 sm:p-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col justify-between gap-4 shadow-xs" data-settings-section="credentials">
            <div>
              <div class="flex items-center justify-between gap-2 mb-2">
                <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)] flex items-center gap-1.5">
                  <Icon name="key" :size="14" />
                  <span>Credential recovery and rotation</span>
                </h3>
                <Badge variant="info">Host-local recovery</Badge>
              </div>
              <p class="text-xs text-[var(--text-secondary)] leading-relaxed mb-3">
                Recovery and rotation change access to this Web boundary. They are not Agent or Worker login controls.
              </p>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs mb-3">
                <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                  <span class="text-[10px] uppercase font-bold text-[var(--text-muted)] block">Recovery owner</span>
                  <strong class="text-[var(--text-primary)]">Sprout host operator</strong>
                  <p class="text-[10px] text-[var(--text-muted)] mt-0.5">No default credential exists. Web cannot reveal or reset the secret.</p>
                </div>
                <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                  <span class="text-[10px] uppercase font-bold text-[var(--text-muted)] block">Host-local rotation</span>
                  <strong class="text-[var(--text-primary)]">Set SPROUT_OPERATOR_CREDENTIAL on host</strong>
                  <p class="text-[10px] text-[var(--text-muted)] mt-0.5">Rotation invalidates other browser sessions immediately.</p>
                </div>
              </div>

              <div class="p-2.5 rounded bg-[var(--yellow-attention-bg)] border border-[var(--yellow-attention-border)] text-[var(--yellow-attention)] text-xs flex items-center gap-2 mb-3">
                <Icon name="warning" :size="15" class="shrink-0" />
                <span>Host-local recovery or rotation invalidates every other browser session. Agents and Workers never receive this credential.</span>
              </div>

              <!-- Explanatory copy: unsupported host action explained rather than simulated -->
              <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] flex flex-col gap-1.5 leading-relaxed">
                <strong class="text-[var(--text-primary)] flex items-center gap-1">
                  <Icon name="info" :size="14" />
                  <span>Host-Local Administration</span>
                </strong>
                <p>
                  Rotate Local Secret Key is a host-only action: Web cannot reveal, reset, or rotate the operator secret. Recovery and rotation require setting <code>SPROUT_OPERATOR_CREDENTIAL</code> in the host environment and restarting Sprout. If this session is lost, recover access directly on the host.
                </p>
              </div>
            </div>

            <!-- Rotation consequences disclosure -->
            <details class="settings-disclosure rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] text-xs">
              <summary class="settings-disclosure-header p-3 font-semibold cursor-pointer select-none flex items-center justify-between hover:bg-[var(--bg-surface)] min-h-[44px]">
                <div class="flex items-center gap-2">
                  <Icon name="warning" :size="14" class="text-[var(--yellow-attention)]" />
                  <span>Review rotation consequences</span>
                </div>
                <Icon name="chevron-down" :size="14" class="text-[var(--text-muted)]" />
              </summary>
              <div class="p-3 border-t border-[var(--border-subtle)] text-[var(--text-secondary)] leading-relaxed space-y-1.5">
                <p><strong>Risk-bearing action:</strong> Rotate only when the current session is known to remain available. Other browsers will need to authenticate again. If this session is lost, recover access on the host before using Web.</p>
                <p class="text-[11px] text-[var(--text-muted)]">Web manages browser sessions; credential secrets remain host-local only.</p>
              </div>
            </details>
          </section>
        </div>

        <!-- Category 2: Instance & System -->
        <div v-else-if="activeSubTab === 'system'" class="grid grid-cols-1 lg:grid-cols-2 gap-5" data-settings-tab-panel="system">
          <!-- Card 1: Sprout instance and compatibility -->
          <section class="card settings-card p-4 sm:p-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-4 shadow-xs" data-settings-section="compatibility">
            <div class="flex items-center justify-between gap-2">
              <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)] flex items-center gap-1.5">
                <Icon name="server" :size="14" />
                <span>Sprout instance and compatibility</span>
              </h3>
              <Badge variant="info">Version facts</Badge>
            </div>
            <p class="text-xs text-[var(--text-secondary)] leading-relaxed">
              Platform & Protocol Compatibility: installed version facts and the supported protocol range are shown below. Worker compatibility is a separate Environment fact, not an assurance inferred from these versions.
            </p>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                <span class="text-[10px] uppercase font-bold text-[var(--text-muted)] block">Sprout</span>
                <strong class="text-[var(--text-primary)] font-mono">{{ settingsData?.versions.sprout ?? 'Unknown' }}</strong>
                <span class="block text-[10px] text-[var(--text-muted)]">Local instance build</span>
              </div>
              <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                <span class="text-[10px] uppercase font-bold text-[var(--text-muted)] block">Worker protocol</span>
                <strong class="text-[var(--text-primary)] font-mono">{{ settingsData?.versions.workerProtocol.minMajor ?? 'Unknown' }}–{{ settingsData?.versions.workerProtocol.maxMajor ?? 'Unknown' }}</strong>
                <span class="block text-[10px] text-[var(--text-muted)]">Supported protocol majors (inclusive)</span>
              </div>
              <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                <span class="text-[10px] uppercase font-bold text-[var(--text-muted)] block">Durable schema</span>
                <strong class="text-[var(--text-primary)] font-mono">{{ diagnosticsData?.schema == null ? 'Unknown' : `schema ${diagnosticsData.schema}` }}</strong>
                <span class="block text-[10px] text-[var(--text-muted)]">Forward migration only</span>
              </div>
              <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                <span class="text-[10px] uppercase font-bold text-[var(--text-muted)] block">Schema support range</span>
                <strong class="text-[var(--text-primary)]">Not reported by Web</strong>
                <span class="block text-[10px] text-[var(--text-muted)]">Check host-local upgrade guidance</span>
              </div>
            </div>

            <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-xs flex items-center gap-2">
              <Icon name="info" :size="14" class="text-[var(--text-muted)] shrink-0" />
              <span>Inspect each Worker’s authoritative compatibility in Manage / Environments. Installed versions alone do not establish compatibility.</span>
            </div>

            <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-xs flex flex-col gap-1">
              <strong class="text-[var(--text-primary)] flex items-center gap-1.5">
                <Icon name="info" :size="14" />
                <span>Worker connection facts</span>
              </strong>
              <p class="text-[var(--text-secondary)] text-[11px] leading-relaxed">
                Web diagnostics report Worker connection and reachability states. Transport carrier and socket permissions are not reported.
              </p>
            </div>

            <!-- Migration safety and failure visibility disclosure -->
            <details class="settings-disclosure rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] text-xs">
              <summary class="settings-disclosure-header p-3 font-semibold cursor-pointer select-none flex items-center justify-between hover:bg-[var(--bg-surface)] min-h-[44px]">
                <div class="flex items-center gap-2">
                  <Icon name="layers" :size="15" />
                  <span>Migration safety and failure visibility</span>
                </div>
                <div class="flex items-center gap-2">
                  <Badge variant="warning">Host verification required</Badge>
                  <Icon name="chevron-down" :size="14" class="text-[var(--text-muted)]" />
                </div>
              </summary>
              <div class="p-3 border-t border-[var(--border-subtle)] text-[var(--text-secondary)] leading-relaxed space-y-2">
                <p>Safety-copy status is not available in Web. Verify the local pre-migration safety copy on the host; a migration event alone does not establish that a copy is retained.</p>
                <p>Migration runs on the stopped host. Web does not restore, downgrade, or serve partially migrated state.</p>
                <div class="p-2.5 rounded bg-[var(--red-action-bg)] border border-[var(--red-action-border)] text-[var(--red-action)] text-[11px]">
                  <strong>Failure state example:</strong> If the safety copy cannot be created, including because of insufficient space, migration stops before serving data. The original store is preserved; do not assume a safety copy exists.
                </div>
                <div class="p-2.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-muted)] text-[11px]">
                  <strong>Unavailable state example:</strong> A schema newer than the supported range is refused with host-local update guidance. Web does not guess across an unsupported protocol.
                </div>
                <p class="text-[10px] text-[var(--text-muted)]">This safety copy is a migration guard, not a product backup system. Backup, restore, retention, and disaster recovery remain host responsibilities.</p>
              </div>
            </details>
          </section>

          <!-- Card 2: Web routine operation versus host-local administration -->
          <section class="card settings-card p-4 sm:p-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col justify-between gap-4 shadow-xs" data-settings-section="boundary">
            <div>
              <div class="flex items-center justify-between gap-2 mb-2">
                <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)] flex items-center gap-1.5">
                  <Icon name="split" :size="14" />
                  <span>Web routine operation versus host-local administration</span>
                </h3>
              </div>
              <p class="text-xs text-[var(--text-secondary)] leading-relaxed mb-3">
                Sprout keeps routine product decisions in Web without pretending to manage the host.
              </p>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                  <h4 class="font-bold text-[var(--text-primary)] mb-1.5 flex items-center gap-1">
                    <Icon name="check" :size="13" class="text-[var(--green-ready)]" />
                    <span>Web can do</span>
                  </h4>
                  <ul class="space-y-1 text-[11px] text-[var(--text-secondary)]">
                    <li>• Inspect health and compatibility</li>
                    <li>• Manage Projects, Agents, Tasks, Messages, and leases</li>
                    <li>• Approve or revoke Environment enrollment</li>
                    <li>• Inspect diagnostics and choose normal recovery outcomes</li>
                  </ul>
                </div>
                <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                  <h4 class="font-bold text-[var(--text-primary)] mb-1.5 flex items-center gap-1">
                    <Icon name="terminal" :size="13" class="text-[var(--accent-primary)]" />
                    <span>Host-local only</span>
                  </h4>
                  <ul class="space-y-1 text-[11px] text-[var(--text-secondary)]">
                    <li>• Install, update, or remove Sprout and Workers</li>
                    <li>• Recover or rotate the operator credential</li>
                    <li>• Log Codex or Pi in and out</li>
                    <li>• Configure startup, workspace, firewall, or Worker identity</li>
                    <li>• Run diagnostics while Web is unreachable</li>
                  </ul>
                </div>
              </div>
            </div>

            <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)] leading-relaxed">
              Environment recovery and Force Release remain in <strong>Manage / Environments</strong>. Settings does not restart Sprout or operate maintenance mode.
            </div>
          </section>
        </div>

        <!-- Category 3: Data & Diagnostics -->
        <div v-else-if="activeSubTab === 'data'" class="grid grid-cols-1 lg:grid-cols-2 gap-5" data-settings-tab-panel="data">
          <!-- Card 1: Durable data location -->
          <section class="card settings-card p-4 sm:p-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col justify-between gap-4 shadow-xs" data-settings-section="data">
            <div>
              <div class="flex items-center justify-between gap-2 mb-2">
                <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)] flex items-center gap-1.5">
                  <Icon name="box" :size="14" />
                  <span>Durable data location</span>
                </h3>
                <Badge variant="info">Local Storage</Badge>
              </div>
              <p class="text-xs text-[var(--text-secondary)] leading-relaxed mb-3">
                Durable Operational Data: Use this relative location when configuring host-managed backup.
              </p>

              <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-xs flex flex-col gap-1.5 font-mono mb-3">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-[10px] uppercase font-bold text-[var(--text-muted)]">Relative Data Root:</span>
                  <code class="text-[var(--accent-primary)] font-bold">~/.sprout/data/</code>
                </div>
                <div class="flex items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
                  <span>Database:</span>
                  <code>sprout.db</code>
                </div>
              </div>

              <div class="flex items-center justify-between gap-2 flex-wrap">
                <Button
                  variant="secondary"
                  size="sm"
                  class="copy-location-btn min-h-[44px] text-xs"
                  @click="handleCopyLocation"
                >
                  <Icon :name="copySuccess ? 'check' : 'clipboard'" :size="14" />
                  <span>{{ copySuccess ? 'Location copied' : 'Copy relative location' }}</span>
                </Button>
                <span v-if="copySuccess" class="text-xs text-[var(--green-ready)] font-semibold">✓ Copied to clipboard</span>
              </div>
            </div>

            <!-- Host backup disclosure -->
            <details class="settings-disclosure rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] text-xs">
              <summary class="settings-disclosure-header p-3 font-semibold cursor-pointer select-none flex items-center justify-between hover:bg-[var(--bg-surface)] min-h-[44px]">
                <div class="flex items-center gap-2">
                  <Icon name="info" :size="14" />
                  <span>What the host operator should include</span>
                </div>
                <Icon name="chevron-down" :size="14" class="text-[var(--text-muted)]" />
              </summary>
              <div class="p-3 border-t border-[var(--border-subtle)] text-[var(--text-secondary)] leading-relaxed space-y-1.5">
                <ul class="space-y-1 text-[11px]">
                  <li>• SQLite database file (<code>sprout.db</code>)</li>
                  <li>• WAL and shared-memory files (<code>-wal</code>, <code>-shm</code>)</li>
                  <li>• Migration safety copy archives</li>
                  <li>• Host-local troubleshooting logs</li>
                </ul>
                <p class="text-[11px] text-[var(--text-muted)] pt-1">
                  This location is guidance for host-managed backup. It is not a Web backup or restore workflow.
                </p>
              </div>
            </details>
          </section>

          <!-- Card 2: Sanitized diagnostics -->
          <section class="card settings-card p-4 sm:p-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col justify-between gap-4 shadow-xs" data-settings-section="diagnostics">
            <div>
              <div class="flex items-center justify-between gap-2 mb-2">
                <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)] flex items-center gap-1.5">
                  <Icon name="clipboard" :size="14" />
                  <span>Sanitized diagnostics</span>
                </h3>
                <Badge variant="success">Ready</Badge>
              </div>
              <p class="text-xs text-[var(--text-secondary)] leading-relaxed mb-3">
                Export operational facts without secrets, credentials, or private message content.
              </p>

              <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-xs flex items-center justify-between gap-2 mb-3">
                <div class="flex items-center gap-2">
                  <Icon name="check" :size="14" class="text-[var(--green-ready)]" />
                  <span>Sanitized export contract ready</span>
                </div>
                <span class="text-[11px] text-[var(--text-muted)] font-mono">Format v1 (Web DTO)</span>
              </div>

              <Button
                variant="primary"
                size="sm"
                class="export-diagnostics-btn min-h-[44px] text-xs w-full sm:w-auto"
                @click="handleExportDiagnostics"
              >
                <Icon name="clipboard" :size="14" />
                <span>Export sanitized diagnostics</span>
              </Button>

              <div class="mt-4 border-t border-[var(--border-subtle)] pt-3" aria-label="Operational events">
                <h4 class="text-xs font-semibold text-[var(--text-primary)]">Operational events</h4>
                <p class="mt-1 text-[11px] text-[var(--text-muted)]">{{ diagnosticEvents.length }} events shown · latest 50 journal entries · local time</p>
                <ol v-if="diagnosticEvents.length" class="mt-2 divide-y divide-[var(--border-subtle)]">
                  <li v-for="event in diagnosticEvents" :key="event.sequence" :data-diagnostic-event="event.sequence" class="py-3 text-xs flex flex-col gap-1.5">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <strong class="text-[var(--text-primary)]">{{ event.kind }} · {{ event.state }}</strong>
                      <time v-if="event.datetime" :datetime="event.datetime" class="text-[11px] text-[var(--text-muted)]">{{ event.time }}</time>
                      <span v-else class="text-[11px] text-[var(--text-muted)]">{{ event.time }}</span>
                    </div>
                    <div class="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--text-secondary)]">
                      <span>Event #{{ event.sequence }}</span>
                      <span v-if="event.correlation?.runId" class="break-all">Run {{ event.correlation.runId }}</span>
                      <span v-if="event.correlation?.taskId" class="break-all">Task {{ event.correlation.taskId }}</span>
                    </div>
                    <RouterLink v-if="event.destination" :to="event.destination" :aria-label="`Open owning surface for event #${event.sequence}`" class="min-h-[44px] inline-flex items-center text-[var(--accent-primary)] underline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]">Open owning surface</RouterLink>
                  </li>
                </ol>
                <p v-else class="mt-2 text-xs text-[var(--text-muted)]">No operational events recorded.</p>
              </div>
            </div>

            <!-- Export boundary disclosure -->
            <details class="settings-disclosure rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] text-xs">
              <summary class="settings-disclosure-header p-3 font-semibold cursor-pointer select-none flex items-center justify-between hover:bg-[var(--bg-surface)] min-h-[44px]">
                <div class="flex items-center gap-2">
                  <Icon name="eye" :size="14" />
                  <span>Inspect the export boundary</span>
                </div>
                <Icon name="chevron-down" :size="14" class="text-[var(--text-muted)]" />
              </summary>
              <div class="p-3 border-t border-[var(--border-subtle)] text-[var(--text-secondary)] leading-relaxed space-y-2">
                <div>
                  <strong class="text-[var(--text-primary)] block text-[11px]">Included in Export:</strong>
                  <p class="text-[10px] text-[var(--text-muted)]">Sprout, Worker, protocol, and schema versions; migration outcome and timestamps; connection, compatibility, readiness, Task, run, lease, and recovery facts; durable correlation identifiers.</p>
                </div>
                <div>
                  <strong class="text-[var(--text-primary)] block text-[11px]">Excluded from Export:</strong>
                  <p class="text-[10px] text-[var(--text-muted)]">Credentials, tokens, account identity, hostnames, network addresses, absolute paths; Message content, prompts, private reasoning, commands, tool output, and raw stderr.</p>
                </div>
                <div class="p-2.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)]">
                  <strong>Web unavailable fallback:</strong> If Web is unavailable, run the host-local diagnostic command in the Sprout user session: <code>sprout worker status --diagnostics</code>. It checks service registration, durable-data access, Worker state, reachability, and engine readiness.
                </div>
              </div>
            </details>
          </section>
        </div>
      </template>
    </div>

    <!-- Dialog 1: Distinct Risk-Bearing Revoke One Session Dialog -->
    <Dialog
      :open="isRevokeOneDialogOpen"
      class="revoke-one-dialog max-w-md"
      title="Revoke Browser Session"
      description="Risk-bearing action: Invalidate access from this browser."
      @update:open="isRevokeOneDialogOpen = $event"
    >
      <div class="flex flex-col gap-3 text-xs text-[var(--text-secondary)]">
        <div class="p-3 rounded bg-[var(--yellow-attention-bg)] border border-[var(--yellow-attention-border)] text-[var(--yellow-attention)] flex flex-col gap-1">
          <strong class="flex items-center gap-1.5 text-xs font-bold">
            <Icon name="warning" :size="14" />
            <span>Risk-Bearing Action</span>
          </strong>
          <p class="text-[11px] leading-relaxed">
            Revoking this session will immediately invalidate access from that browser. Future commands will be blocked. Active Tasks in progress will not be stopped.
          </p>
        </div>
        <p class="text-[11px]">
          Target session: <code class="font-mono text-[var(--text-primary)]">{{ sessionToRevoke?.id }}</code>
        </p>
      </div>

      <template #footer>
        <Button
          variant="secondary"
          size="sm"
          class="cancel-revoke-one-btn min-h-[44px] text-xs"
          @click="isRevokeOneDialogOpen = false"
        >
          Cancel
        </Button>
        <Button
          variant="danger"
          size="sm"
          class="confirm-revoke-one-btn min-h-[44px] text-xs"
          :disabled="isRevokingOne || !canMutateSessions"
          @click="confirmRevokeSession"
        >
          Confirm Revocation
        </Button>
      </template>
    </Dialog>

    <!-- Dialog 2: Distinct Risk-Bearing Revoke All Other Sessions Dialog -->
    <Dialog
      :open="isRevokeOthersDialogOpen"
      class="revoke-others-dialog max-w-md"
      title="Revoke All Other Browser Sessions"
      description="Risk-bearing action: Invalidate all other active sessions."
      @update:open="isRevokeOthersDialogOpen = $event"
    >
      <div class="flex flex-col gap-3 text-xs text-[var(--text-secondary)]">
        <div class="p-3 rounded bg-[var(--yellow-attention-bg)] border border-[var(--yellow-attention-border)] text-[var(--yellow-attention)] flex flex-col gap-1">
          <strong class="flex items-center gap-1.5 text-xs font-bold">
            <Icon name="warning" :size="14" />
            <span>Risk-Bearing Action</span>
          </strong>
          <p class="text-[11px] leading-relaxed">
            Revoking all other browser sessions will immediately invalidate access for every other browser ({{ activeSessionCount - 1 }} other session(s)). Only this current browser session will remain authenticated. Other browsers will need to authenticate again. Active Tasks in progress will continue.
          </p>
        </div>
        <p class="text-[11px] text-[var(--text-muted)]">
          This action takes effect immediately and cannot be undone.
        </p>
      </div>

      <template #footer>
        <Button
          variant="secondary"
          size="sm"
          class="cancel-revoke-others-btn min-h-[44px] text-xs"
          @click="isRevokeOthersDialogOpen = false"
        >
          Cancel
        </Button>
        <Button
          variant="danger"
          size="sm"
          class="confirm-revoke-others-btn min-h-[44px] text-xs"
          :disabled="isRevokingOthers || !canRevokeOthers"
          @click="confirmRevokeOthers"
        >
          Confirm Revoke Others
        </Button>
      </template>
    </Dialog>
  </div>
</template>
