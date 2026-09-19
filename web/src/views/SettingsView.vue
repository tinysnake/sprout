<script setup lang="ts">
import { ref } from 'vue';
import Icon from '../primitives/Icon.vue';
import Button from '../primitives/Button.vue';
import Badge from '../primitives/Badge.vue';
import StatusDot from '../primitives/StatusDot.vue';

const activeSubTab = ref<'access' | 'system' | 'data'>('access');

const browserSessions = ref([
  { id: 'sess-1', device: 'Desktop Browser (Current Session)', ip: 'Loopback / Private LAN', activeTime: 'Just now', current: true },
  { id: 'sess-2', device: 'Mobile Safari (Phone Viewport)', ip: 'Private LAN', activeTime: '12m ago', current: false },
]);
</script>

<template>
  <div class="settings-view flex flex-col h-full bg-[var(--bg-app)]">
    <div class="p-4 sm:p-6 w-full max-w-[1920px] mx-auto flex flex-col gap-6">
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

      <!-- 2. Status Summary Strip (Prototype .settings-status-strip) -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div class="p-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex items-center gap-2.5 shadow-xs">
          <Icon name="check" :size="16" class="text-[var(--green-ready)] shrink-0" />
          <div>
            <strong class="text-xs text-[var(--text-primary)] block">Operator Access</strong>
            <span class="text-[11px] text-[var(--text-muted)]">Authenticated</span>
          </div>
        </div>
        <div class="p-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex items-center gap-2.5 shadow-xs">
          <Icon name="server" :size="16" class="text-[var(--green-ready)] shrink-0" />
          <div>
            <strong class="text-xs text-[var(--text-primary)] block">Instance & Protocol</strong>
            <span class="text-[11px] text-[var(--text-muted)]">Compatible (v2.1)</span>
          </div>
        </div>
        <div class="p-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex items-center gap-2.5 shadow-xs">
          <Icon name="warning" :size="16" class="text-[var(--yellow-attention)] shrink-0" />
          <div>
            <strong class="text-xs text-[var(--text-primary)] block">Migration Guard</strong>
            <span class="text-[11px] text-[var(--text-muted)]">Safety copy retained</span>
          </div>
        </div>
      </div>

      <!-- 3. Settings Sub-Tabs -->
      <div class="flex items-center gap-1 bg-[var(--bg-surface-elevated)] p-1 rounded-md border border-[var(--border-subtle)] w-fit" role="tablist">
        <button
          type="button"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold cursor-pointer transition-colors"
          :class="activeSubTab === 'access' ? 'bg-[var(--accent-primary)] text-[var(--text-inverse)] font-bold shadow-xs' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
          @click="activeSubTab = 'access'"
        >
          <Icon name="shield" :size="14" />
          <span>Access & Security</span>
        </button>
        <button
          type="button"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold cursor-pointer transition-colors"
          :class="activeSubTab === 'system' ? 'bg-[var(--accent-primary)] text-[var(--text-inverse)] font-bold shadow-xs' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
          @click="activeSubTab === 'system'"
        >
          <Icon name="server" :size="14" />
          <span>Instance & System</span>
        </button>
        <button
          type="button"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold cursor-pointer transition-colors"
          :class="activeSubTab === 'data' ? 'bg-[var(--accent-primary)] text-[var(--text-inverse)] font-bold shadow-xs' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
          @click="activeSubTab = 'data'"
        >
          <Icon name="folder" :size="14" />
          <span>Data & Diagnostics</span>
        </button>
      </div>

      <!-- Content Categories (2-column on wide screens) -->
      <!-- 1. Access & Security -->
      <div v-if="activeSubTab === 'access'" class="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div class="p-4 sm:p-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col justify-between gap-4 shadow-xs">
          <div>
            <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)] mb-2">
              Operator Access Boundary
            </h3>
            <p class="text-xs text-[var(--text-secondary)] leading-relaxed">
              Sprout is hosted strictly in the local operator's user environment. Authentication keys never leave the host system.
            </p>
          </div>
          <div class="flex items-center justify-between pt-3 border-t border-[var(--border-subtle)]">
            <span class="text-xs text-[var(--text-muted)] font-mono">Credential rotation: Host-local risk gated</span>
            <Button variant="secondary" size="xs">Rotate Local Secret Key</Button>
          </div>
        </div>

        <div class="p-4 sm:p-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-4 shadow-xs">
          <div class="flex items-center justify-between">
            <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)]">
              Authorized Browser Sessions
            </h3>
            <Button variant="ghost" size="xs" class="text-[var(--red-action)] hover:bg-[var(--red-action-bg)]">Revoke Others</Button>
          </div>
          <div class="space-y-2">
            <div
              v-for="sess in browserSessions"
              :key="sess.id"
              class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex items-center justify-between text-xs"
            >
              <div>
                <strong class="text-[var(--text-primary)] block">{{ sess.device }}</strong>
                <span class="text-[10px] text-[var(--text-muted)] font-mono">{{ sess.ip }} · Active {{ sess.activeTime }}</span>
              </div>
              <Badge v-if="sess.current" variant="info">Current</Badge>
              <Button v-else variant="secondary" size="xs">Revoke</Button>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. Instance & System -->
      <div v-else-if="activeSubTab === 'system'" class="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div class="p-4 sm:p-5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-4 text-xs shadow-xs">
          <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)]">
            Platform & Protocol Compatibility
          </h3>
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
          <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)]">
            Carrier & Transport Security
          </h3>
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
          <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)]">
            Durable Operational Data
          </h3>
          <p class="text-[var(--text-secondary)]">
            Durable events, projects, and task leases are stored locally in SQLite with strict ACID transactional guarantees.
          </p>
          <div class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] font-mono text-[11px] text-[var(--accent-primary)]">
            Relative root: ~/.sprout/data/ (Neutral operator context)
          </div>
          <div class="flex justify-end pt-2 border-t border-[var(--border-subtle)]">
            <Button variant="secondary" size="xs">Export Sanitized Diagnostics Log</Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
