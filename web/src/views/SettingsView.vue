<script setup lang="ts">
import { ref } from 'vue';
import SubNav, { type SubNavItem } from '../primitives/SubNav.vue';
import Icon from '../primitives/Icon.vue';
import Button from '../primitives/Button.vue';
import Badge from '../primitives/Badge.vue';
import StatusDot from '../primitives/StatusDot.vue';

const manageSubNavItems: SubNavItem[] = [
  { to: '/manage/environments', label: 'Environments', icon: 'environments' },
  { to: '/manage/agents', label: 'Agents', icon: 'agents' },
  { to: '/manage/usage', label: 'Usage & Costs', icon: 'usage' },
  { to: '/manage/settings', label: 'Settings', icon: 'settings' },
];

const activeSubTab = ref<'access' | 'system' | 'data'>('access');

const browserSessions = ref([
  { id: 'sess-1', device: 'Desktop Browser (Current Session)', ip: 'Loopback / Private LAN', activeTime: 'Just now', current: true },
  { id: 'sess-2', device: 'Mobile Safari (Phone Viewport)', ip: 'Private LAN', activeTime: '12m ago', current: false },
]);
</script>

<template>
  <div class="settings-view flex flex-col h-full bg-[var(--bg-app)]">
    <!-- Sub navigation -->
    <SubNav :items="manageSubNavItems" />

    <div class="p-4 sm:p-6 max-w-5xl mx-auto w-full flex flex-col gap-5">
      <!-- Status Strip -->
      <div class="p-3.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex items-center justify-between gap-3 flex-wrap">
        <div class="flex items-center gap-3">
          <StatusDot status="green" size="md" />
          <div>
            <strong class="text-xs font-bold text-[var(--text-primary)] block">Local Operator Service Running</strong>
            <span class="text-[11px] text-[var(--text-muted)] font-mono">Carrier TLS/WSS · Protocol v2.1 · Schema v1</span>
          </div>
        </div>
        <Badge variant="success">Online & Authenticated</Badge>
      </div>

      <!-- Settings Sub-Tabs -->
      <div class="flex items-center gap-1 bg-[var(--bg-surface-elevated)] p-1 rounded-md border border-[var(--border-subtle)] w-fit" role="tablist">
        <button
          type="button"
          class="px-3 py-1 rounded text-xs font-semibold cursor-pointer transition-colors"
          :class="activeSubTab === 'access' ? 'bg-[var(--accent-primary)] text-[var(--text-inverse)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
          @click="activeSubTab = 'access'"
        >
          Access & Security
        </button>
        <button
          type="button"
          class="px-3 py-1 rounded text-xs font-semibold cursor-pointer transition-colors"
          :class="activeSubTab === 'system' ? 'bg-[var(--accent-primary)] text-[var(--text-inverse)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
          @click="activeSubTab = 'system'"
        >
          Instance & System
        </button>
        <button
          type="button"
          class="px-3 py-1 rounded text-xs font-semibold cursor-pointer transition-colors"
          :class="activeSubTab === 'data' ? 'bg-[var(--accent-primary)] text-[var(--text-inverse)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
          @click="activeSubTab = 'data'"
        >
          Data & Diagnostics
        </button>
      </div>

      <!-- Content Categories -->
      <!-- 1. Access & Security -->
      <div v-if="activeSubTab === 'access'" class="flex flex-col gap-4">
        <div class="p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-3">
          <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)]">
            Operator Access Boundary
          </h3>
          <p class="text-xs text-[var(--text-secondary)] leading-relaxed">
            Sprout is hosted strictly in the local operator's user environment. Authentication keys never leave the host system.
          </p>
          <div class="flex items-center justify-between pt-2 border-t border-[var(--border-subtle)]">
            <span class="text-xs text-[var(--text-muted)] font-mono">Credential rotation: Host-local risk gated</span>
            <Button variant="secondary" size="xs">Rotate Local Secret Key</Button>
          </div>
        </div>

        <div class="p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-3">
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
              class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex items-center justify-between text-xs"
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
      <div v-else-if="activeSubTab === 'system'" class="flex flex-col gap-4">
        <div class="p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-3 text-xs">
          <h3 class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)]">
            Platform & Protocol Compatibility
          </h3>
          <div class="space-y-2">
            <div class="flex justify-between py-1 border-b border-[var(--border-subtle)]">
              <span class="text-[var(--text-muted)]">Runtime:</span>
              <strong class="text-[var(--text-primary)] font-mono">Node.js v26.7.0 (ES2023)</strong>
            </div>
            <div class="flex justify-between py-1 border-b border-[var(--border-subtle)]">
              <span class="text-[var(--text-muted)]">Worker Protocol:</span>
              <strong class="text-[var(--green-ready)] font-mono">v2.1 (Compatible)</strong>
            </div>
            <div class="flex justify-between py-1 border-b border-[var(--border-subtle)]">
              <span class="text-[var(--text-muted)]">Storage Engine:</span>
              <strong class="text-[var(--text-primary)] font-mono">SQLite (WAL Mode)</strong>
            </div>
            <div class="flex justify-between py-1">
              <span class="text-[var(--text-muted)]">Production Web Foundation:</span>
              <strong class="text-[var(--accent-primary)] font-mono">Vue 3.5 + Tailwind 4 + Reka UI</strong>
            </div>
          </div>
        </div>
      </div>

      <!-- 3. Data & Diagnostics -->
      <div v-else-if="activeSubTab === 'data'" class="flex flex-col gap-4">
        <div class="p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-3 text-xs">
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
