<script setup lang="ts">
import { ref } from 'vue';
import Icon from '../primitives/Icon.vue';
import Button from '../primitives/Button.vue';
import Badge from '../primitives/Badge.vue';
import StatusDot from '../primitives/StatusDot.vue';
import Dialog from '../primitives/Dialog.vue';

const activeSubTab = ref<'access' | 'system' | 'data'>('access');
const isRotateSecretDialogOpen = ref(false);
const rotateSecretConfirmation = ref('');
const isSecretRotated = ref(false);
const isExportToastVisible = ref(false);

const browserSessions = ref([
  { id: 'sess-1', device: 'Desktop Browser (Current Session)', ip: 'Loopback / Private LAN', activeTime: 'Just now', current: true },
  { id: 'sess-2', device: 'Mobile Safari (Phone Viewport)', ip: 'Private LAN', activeTime: '12m ago', current: false },
]);

function revokeOtherSessions() {
  browserSessions.value = browserSessions.value.filter((s) => s.current);
}

function handleRotateSecret() {
  if (rotateSecretConfirmation.value === 'ROTATE CREDENTIAL') {
    isSecretRotated.value = true;
    isRotateSecretDialogOpen.value = false;
    rotateSecretConfirmation.value = '';
    revokeOtherSessions();
  }
}

function handleExportDiagnostics() {
  isExportToastVisible.value = true;
  setTimeout(() => {
    isExportToastVisible.value = false;
  }, 3000);
}
</script>

<template>
  <div class="settings-view flex flex-col min-h-full bg-[var(--bg-app)]">
    <div class="p-4 sm:p-6 pb-28 md:pb-16 w-full max-w-[1920px] mx-auto flex flex-col gap-6">
      <!-- 1. Header & Boundary Note (Prototype .settings-page-header) -->
      <div class="border-b border-[var(--border-subtle)] pb-4 flex flex-col gap-2.5">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <h2 class="text-base sm:text-lg font-bold text-[var(--text-primary)] flex items-center gap-2">
            <Icon name="settings" :size="19" />
            <span>General & Operator Settings</span>
          </h2>
          <Badge variant="info">Manage / Settings</Badge>
        </div>
        <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          <Icon name="shield" :size="15" class="text-[var(--green-ready)] shrink-0" />
          <span><strong>Routine operation stays in Web.</strong> Host-owned credentials, installation, startup, network policy, and offline diagnostics stay on the Sprout host.</span>
        </div>
      </div>

      <!-- 2. Status Summary Strip (Prototype .settings-status-strip, interactive tab switches) -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3" aria-label="Settings status summary">
        <button
          type="button"
          class="settings-status-card text-left p-3 rounded-[var(--radius-sm)] border transition-all cursor-pointer shadow-xs flex items-center gap-2.5 select-none"
          :class="activeSubTab === 'access' ? 'border-[var(--accent-primary)] bg-[var(--bg-surface-elevated)] ring-1 ring-[var(--accent-primary)]' : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)]'"
          title="Switch to Access & Security"
          @click="activeSubTab = 'access'"
        >
          <Icon name="check" :size="16" class="text-[var(--green-ready)] shrink-0" />
          <div class="min-w-0">
            <strong class="text-xs text-[var(--text-primary)] block truncate">Operator Access</strong>
            <span class="text-[11px] text-[var(--text-muted)] block truncate">Authenticated</span>
          </div>
        </button>

        <button
          type="button"
          class="settings-status-card text-left p-3 rounded-[var(--radius-sm)] border transition-all cursor-pointer shadow-xs flex items-center gap-2.5 select-none"
          :class="activeSubTab === 'system' ? 'border-[var(--accent-primary)] bg-[var(--bg-surface-elevated)] ring-1 ring-[var(--accent-primary)]' : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)]'"
          title="Switch to Instance & System"
          @click="activeSubTab = 'system'"
        >
          <Icon name="server" :size="16" class="text-[var(--green-ready)] shrink-0" />
          <div class="min-w-0">
            <strong class="text-xs text-[var(--text-primary)] block truncate">Instance & Protocol</strong>
            <span class="text-[11px] text-[var(--text-muted)] block truncate">Compatible (v2.1)</span>
          </div>
        </button>

        <button
          type="button"
          class="settings-status-card text-left p-3 rounded-[var(--radius-sm)] border transition-all cursor-pointer shadow-xs flex items-center gap-2.5 select-none"
          :class="activeSubTab === 'system' ? 'border-[var(--accent-primary)] bg-[var(--bg-surface-elevated)] ring-1 ring-[var(--accent-primary)]' : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)]'"
          title="Switch to Instance & System"
          @click="activeSubTab = 'system'"
        >
          <Icon name="warning" :size="16" class="text-[var(--yellow-attention)] shrink-0" />
          <div class="min-w-0">
            <strong class="text-xs text-[var(--text-primary)] block truncate">Migration Guard</strong>
            <span class="text-[11px] text-[var(--text-muted)] block truncate">Safety copy retained</span>
          </div>
        </button>
      </div>

      <!-- 3. Settings Sub-Tabs (Responsive 3-column segmented bar, no overflow) -->
      <div
        class="settings-sub-tabs flex items-center gap-1 sm:gap-2 bg-[var(--bg-surface-elevated)] p-1 rounded-md border border-[var(--border-subtle)] w-full max-w-2xl shadow-xs"
        role="tablist"
        aria-label="Settings categories"
      >
        <button
          type="button"
          role="tab"
          :aria-selected="activeSubTab === 'access'"
          class="settings-tab-access flex-1 flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 py-2 sm:py-2.5 px-2 rounded-[var(--radius-sm)] text-xs font-semibold cursor-pointer select-none transition-all min-h-[44px]"
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
          class="settings-tab-system flex-1 flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 py-2 sm:py-2.5 px-2 rounded-[var(--radius-sm)] text-xs font-semibold cursor-pointer select-none transition-all min-h-[44px]"
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
          class="settings-tab-data flex-1 flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 py-2 sm:py-2.5 px-2 rounded-[var(--radius-sm)] text-xs font-semibold cursor-pointer select-none transition-all min-h-[44px]"
          :class="activeSubTab === 'data' ? 'bg-[var(--accent-primary)] text-[var(--text-inverse)] font-bold shadow-xs' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)]'"
          @click="activeSubTab = 'data'"
        >
          <Icon name="folder" :size="15" />
          <span class="truncate">Data & Diagnostics</span>
        </button>
      </div>

      <!-- Content Categories (2-column on wide screens) -->
      <!-- 1. Access & Security -->
      <div v-if="activeSubTab === 'access'" class="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <!-- Card 1: Operator Access Boundary -->
        <div class="p-4 sm:p-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col justify-between gap-4 shadow-xs">
          <div>
            <div class="flex items-center justify-between gap-2 mb-2">
              <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)] flex items-center gap-1.5">
                <Icon name="shield" :size="14" class="text-[var(--green-ready)]" />
                <span>Operator Access Boundary</span>
              </h3>
              <Badge variant="success">Authenticated</Badge>
            </div>
            <p class="text-xs text-[var(--text-secondary)] leading-relaxed mb-3">
              Sprout is hosted strictly in the local operator's user environment. Authentication keys never leave the host system.
            </p>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                <span class="text-[10px] uppercase font-bold text-[var(--text-muted)] block">Operator</span>
                <strong class="text-[var(--text-primary)]">Local Operator</strong>
                <span class="block text-[10px] font-mono text-[var(--text-muted)]">local-operator-1</span>
              </div>
              <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                <span class="text-[10px] uppercase font-bold text-[var(--text-muted)] block">Identity Model</span>
                <strong class="text-[var(--text-primary)]">Single Operator</strong>
                <span class="block text-[10px] text-[var(--text-muted)]">Private authority</span>
              </div>
              <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                <span class="text-[10px] uppercase font-bold text-[var(--text-muted)] block">Browser Boundary</span>
                <strong class="text-[var(--text-primary)]">Loopback / LAN</strong>
                <span class="block text-[10px] text-[var(--text-muted)]">No public exposure</span>
              </div>
              <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)]">
                <span class="text-[10px] uppercase font-bold text-[var(--text-muted)] block">Credential Access</span>
                <strong class="text-[var(--text-primary)]">Host-local only</strong>
                <span class="block text-[10px] text-[var(--text-muted)]">Zero remote leakage</span>
              </div>
            </div>
          </div>

          <div class="flex items-center justify-between pt-3 border-t border-[var(--border-subtle)] flex-wrap gap-2">
            <span class="text-xs text-[var(--text-muted)] font-mono">Credential status: {{ isSecretRotated ? 'Rotated just now' : 'Host-local recovery' }}</span>
            <Button variant="secondary" size="xs" class="rotate-secret-btn" @click="isRotateSecretDialogOpen = true">
              <Icon name="key" :size="12" />
              <span>Rotate Local Secret Key</span>
            </Button>
          </div>
        </div>

        <!-- Card 2: Authorized Browser Sessions -->
        <div class="p-4 sm:p-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-4 shadow-xs">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)] flex items-center gap-1.5">
                <Icon name="desktop" :size="14" />
                <span>Authorized Browser Sessions</span>
              </h3>
              <span class="text-[11px] text-[var(--text-secondary)]">
                {{ browserSessions.length }} active session(s) share this operator identity.
              </span>
            </div>
            <Button
              variant="ghost"
              size="xs"
              class="revoke-others-btn text-[var(--red-action)] hover:bg-[var(--red-action-bg)]"
              :disabled="browserSessions.length <= 1"
              @click="revokeOtherSessions"
            >
              Revoke Others
            </Button>
          </div>

          <div class="space-y-2">
            <div
              v-for="sess in browserSessions"
              :key="sess.id"
              class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex items-center justify-between gap-3 text-xs"
            >
              <div class="min-w-0">
                <strong class="text-[var(--text-primary)] block truncate">{{ sess.device }}</strong>
                <span class="text-[10px] text-[var(--text-muted)] font-mono block truncate">{{ sess.ip }} · Active {{ sess.activeTime }}</span>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <Badge v-if="sess.current" variant="info">Current</Badge>
                <Button
                  v-else
                  variant="secondary"
                  size="xs"
                  class="revoke-session-btn"
                  @click="browserSessions = browserSessions.filter((s) => s.id !== sess.id)"
                >
                  Revoke
                </Button>
              </div>
            </div>
          </div>

          <p class="text-[11px] text-[var(--text-muted)] leading-relaxed pt-2 border-t border-[var(--border-subtle)]">
            Session revocation blocks future commands from that browser. It does not stop an already admitted Task; inspect its authoritative Project or Environment surface.
          </p>
        </div>
      </div>

      <!-- 2. Instance & System -->
      <div v-else-if="activeSubTab === 'system'" class="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div class="p-4 sm:p-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-4 text-xs shadow-xs">
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)] flex items-center gap-1.5">
              <Icon name="server" :size="14" />
              <span>Platform & Protocol Compatibility</span>
            </h3>
            <Badge variant="success">Compatible</Badge>
          </div>

          <div class="space-y-2">
            <div class="flex justify-between py-1.5 border-b border-[var(--border-subtle)]">
              <span class="text-[var(--text-muted)]">Runtime:</span>
              <strong class="text-[var(--text-primary)] font-mono">Node.js v26.7.0 (ES2023)</strong>
            </div>
            <div class="flex justify-between py-1.5 border-b border-[var(--border-subtle)]">
              <span class="text-[var(--text-muted)]">Worker Protocol:</span>
              <strong class="text-[var(--green-ready)] font-mono">v2.1 (Compatible)</strong>
            </div>
            <div class="flex justify-between py-1.5 border-b border-[var(--border-subtle)]">
              <span class="text-[var(--text-muted)]">Storage Engine:</span>
              <strong class="text-[var(--text-primary)] font-mono">SQLite (WAL Mode)</strong>
            </div>
            <div class="flex justify-between py-1.5">
              <span class="text-[var(--text-muted)]">Operator Console:</span>
              <strong class="text-[var(--accent-primary)] font-mono">Sprout Modern Web UI</strong>
            </div>
          </div>
        </div>

        <div class="p-4 sm:p-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-4 text-xs shadow-xs">
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)] flex items-center gap-1.5">
              <Icon name="shield" :size="14" />
              <span>Carrier & Transport Security</span>
            </h3>
            <Badge variant="info">Active TLS</Badge>
          </div>
          <p class="text-xs text-[var(--text-secondary)] leading-relaxed">
            Worker daemons connect over authenticated TLS/WSS streams. Local processes use unix domain sockets with strict permissions.
          </p>
          <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] font-mono text-[11px] text-[var(--text-muted)]">
            Status: Active · Peer verification: Enforced · Latency: ~14ms
          </div>
        </div>
      </div>

      <!-- 3. Data & Diagnostics -->
      <div v-else-if="activeSubTab === 'data'" class="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div class="p-4 sm:p-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-4 text-xs shadow-xs">
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)] flex items-center gap-1.5">
              <Icon name="folder" :size="14" />
              <span>Durable Operational Data</span>
            </h3>
            <Badge variant="info">Local Storage</Badge>
          </div>
          <p class="text-[var(--text-secondary)]">
            Durable events, projects, and task leases are stored locally in SQLite with strict ACID transactional guarantees.
          </p>
          <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] font-mono text-[11px] text-[var(--accent-primary)]">
            Relative root: ~/.sprout/data/ (Neutral operator context)
          </div>
          <div class="flex justify-end pt-2 border-t border-[var(--border-subtle)]">
            <Button variant="secondary" size="xs" @click="handleExportDiagnostics">Export Sanitized Diagnostics Log</Button>
          </div>
          <div v-if="isExportToastVisible" class="p-2 rounded bg-[var(--green-ready-bg)] border border-[var(--green-ready-border)] text-[var(--green-ready)] text-xs font-semibold">
            ✓ Diagnostics package exported to ~/.sprout/diagnostics/
          </div>
        </div>
      </div>
    </div>

    <!-- Rotate Secret Key Dialog -->
    <Dialog
      :open="isRotateSecretDialogOpen"
      title="Rotate Local Operator Secret"
      description="Risk-bearing action: Rotating the local secret key will immediately invalidate other browser sessions."
      @update:open="isRotateSecretDialogOpen = $event"
    >
      <div class="flex flex-col gap-3 text-xs text-[var(--text-secondary)]">
        <div class="p-3 rounded bg-[var(--yellow-attention-bg)] border border-[var(--yellow-attention-border)] text-[var(--yellow-attention)] flex flex-col gap-1">
          <strong class="flex items-center gap-1.5 text-xs font-bold">
            <Icon name="warning" :size="14" />
            <span>Risk-Bearing Action</span>
          </strong>
          <p class="text-[11px]">
            Rotate only when the current session is known to remain available. If this session is lost, recover access directly on the host.
          </p>
        </div>

        <div class="flex flex-col gap-1.5">
          <label class="text-xs font-semibold text-[var(--text-primary)]">
            Type <code class="font-mono text-[var(--accent-primary)] font-bold">ROTATE CREDENTIAL</code> to confirm:
          </label>
          <input
            v-model="rotateSecretConfirmation"
            type="text"
            placeholder="ROTATE CREDENTIAL"
            class="rotate-secret-confirm-input w-full px-3 py-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] text-[var(--text-primary)] font-mono text-xs focus:border-[var(--border-focus)] outline-none"
          />
        </div>
      </div>

      <template #footer>
        <Button variant="secondary" size="sm" class="cancel-rotate-secret-btn" @click="isRotateSecretDialogOpen = false">
          Cancel
        </Button>
        <Button
          variant="danger"
          size="sm"
          class="confirm-rotate-secret-btn"
          :disabled="rotateSecretConfirmation !== 'ROTATE CREDENTIAL'"
          @click="handleRotateSecret"
        >
          Confirm Rotation
        </Button>
      </template>
    </Dialog>
  </div>
</template>
