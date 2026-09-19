<script setup lang="ts">
import { ref } from 'vue';
import Icon from '../primitives/Icon.vue';
import Badge from '../primitives/Badge.vue';

const activeTab = ref<'run' | 'task' | 'project' | 'agent' | 'model' | 'time'>('project');

const usageItems = ref([
  {
    id: 'u-1',
    category: 'Work Run',
    name: 'Task #101 · Run #2',
    agent: '@Programmer',
    model: 'gemini-2.5-pro (Pi)',
    tokens: '412,850',
    duration: '12m 40s',
    costEstimate: '$1.44',
    provenance: 'provider_estimated',
  },
  {
    id: 'u-2',
    category: 'Work Run',
    name: 'Task #104 · Run #1',
    agent: '@Architect',
    model: 'gpt-5-codex (Codex)',
    tokens: '689,120',
    duration: '24m 10s',
    costEstimate: '$2.41',
    provenance: 'provider_estimated',
  },
  {
    id: 'u-3',
    category: 'Routing Attempt',
    name: 'Routing Batch #42 (Project Sprout M2)',
    agent: 'Wake Model (Claude 3.5 Haiku)',
    model: 'claude-3-5-haiku',
    tokens: '28,400',
    duration: '1m 15s',
    costEstimate: '$0.03',
    provenance: 'harness_calculated',
  },
  {
    id: 'u-4',
    category: 'Routing Attempt',
    name: 'Routing Batch #43 (Project Sprout M2)',
    agent: 'Wake Model (Claude 3.5 Haiku)',
    model: 'claude-3-5-haiku',
    tokens: '14,200',
    duration: '42s',
    costEstimate: '$0.02',
    provenance: 'harness_calculated',
  },
]);
</script>

<template>
  <div class="usage-view flex flex-col h-full bg-[var(--bg-app)]">
    <!-- Main Container (Fluid width, ultra-wide screen adapted) -->
    <div class="p-4 sm:p-6 w-full max-w-[1920px] mx-auto flex flex-col gap-6">
      <!-- Header -->
      <div class="border-b border-[var(--border-subtle)] pb-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 class="text-base font-bold text-[var(--text-primary)] flex items-center gap-2">
            <Icon name="usage" :size="18" />
            <span>Usage & Cost Telemetry (ADR-0010)</span>
          </h2>
          <p class="text-xs text-[var(--text-secondary)] mt-0.5">
            Token telemetry, API equivalent estimations, and truthful duration observability.
          </p>
        </div>
        <Badge variant="warning">Billed cost: Unavailable (Self-hosted)</Badge>
      </div>

      <!-- 6-View Tab Strip (ADR-0010) -->
      <div class="flex items-center gap-1 bg-[var(--bg-surface-elevated)] p-1 rounded-md border border-[var(--border-subtle)] overflow-x-auto w-fit" role="tablist">
        <button
          type="button"
          class="px-3 py-1 rounded text-xs font-semibold whitespace-nowrap cursor-pointer transition-colors"
          :class="activeTab === 'project' ? 'bg-[var(--accent-primary)] text-[var(--text-inverse)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
          @click="activeTab = 'project'"
        >
          Project View
        </button>
        <button
          type="button"
          class="px-3 py-1 rounded text-xs font-semibold whitespace-nowrap cursor-pointer transition-colors"
          :class="activeTab === 'task' ? 'bg-[var(--accent-primary)] text-[var(--text-inverse)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
          @click="activeTab = 'task'"
        >
          Task View
        </button>
        <button
          type="button"
          class="px-3 py-1 rounded text-xs font-semibold whitespace-nowrap cursor-pointer transition-colors"
          :class="activeTab === 'run' ? 'bg-[var(--accent-primary)] text-[var(--text-inverse)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
          @click="activeTab = 'run'"
        >
          Agent Run View
        </button>
        <button
          type="button"
          class="px-3 py-1 rounded text-xs font-semibold whitespace-nowrap cursor-pointer transition-colors"
          :class="activeTab === 'agent' ? 'bg-[var(--accent-primary)] text-[var(--text-inverse)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
          @click="activeTab = 'agent'"
        >
          Agent View
        </button>
        <button
          type="button"
          class="px-3 py-1 rounded text-xs font-semibold whitespace-nowrap cursor-pointer transition-colors"
          :class="activeTab === 'model' ? 'bg-[var(--accent-primary)] text-[var(--text-inverse)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
          @click="activeTab = 'model'"
        >
          Model View
        </button>
        <button
          type="button"
          class="px-3 py-1 rounded text-xs font-semibold whitespace-nowrap cursor-pointer transition-colors"
          :class="activeTab === 'time' ? 'bg-[var(--accent-primary)] text-[var(--text-inverse)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
          @click="activeTab = 'time'"
        >
          Time Range (7d)
        </button>
      </div>

      <!-- KPI Metric Tiles Grid (4-column on wide screens) -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div class="p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-1 shadow-xs">
          <span class="text-[10px] uppercase font-bold text-[var(--text-muted)]">Total Tokens</span>
          <span class="text-2xl font-bold text-[var(--text-primary)]">1,144,570</span>
          <span class="text-[10px] text-[var(--green-ready)]">Across 2 projects</span>
        </div>

        <div class="p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-1 shadow-xs">
          <span class="text-[10px] uppercase font-bold text-[var(--text-muted)]">Model Duration</span>
          <span class="text-2xl font-bold text-[var(--text-primary)]">38m 47s</span>
          <span class="text-[10px] text-[var(--text-muted)]">Active inference time</span>
        </div>

        <div class="p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-1 shadow-xs">
          <span class="text-[10px] uppercase font-bold text-[var(--text-muted)]">API Equivalent Estimate</span>
          <span class="text-2xl font-bold text-[var(--accent-primary)]">$3.90</span>
          <span class="text-[10px] text-[var(--text-muted)]">Commercial pricing basis</span>
        </div>

        <div class="p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-1 shadow-xs">
          <span class="text-[10px] uppercase font-bold text-[var(--text-muted)]">Telemetry Coverage</span>
          <span class="text-2xl font-bold text-[var(--green-ready)]">99.2%</span>
          <span class="text-[10px] text-[var(--text-muted)]">Complete token trace</span>
        </div>
      </div>

      <!-- ADR-0010 Separation Invariant: 2-Column Split on Wide Screens -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- Left 2 Columns: Activity Items Breakdown -->
        <div class="lg:col-span-2 flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <strong class="text-xs uppercase tracking-wider font-bold text-[var(--text-muted)]">
              Activity Items Breakdown (Work Runs & Routing Separate — ADR-0010)
            </strong>
            <span class="text-[10px] text-[var(--text-muted)]">Never merged into one total</span>
          </div>

          <div class="p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-3 shadow-xs">
            <div
              v-for="item in usageItems"
              :key="item.id"
              class="flex items-center justify-between p-3.5 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex-wrap gap-2"
            >
              <div>
                <div class="flex items-center gap-2">
                  <strong class="text-xs font-bold text-[var(--text-primary)]">{{ item.name }}</strong>
                  <Badge :variant="item.category === 'Work Run' ? 'purple' : 'info'">{{ item.category }}</Badge>
                </div>
                <div class="text-[11px] text-[var(--text-secondary)] mt-0.5">
                  {{ item.agent }} · <span class="font-mono text-[var(--text-muted)]">{{ item.model }}</span>
                </div>
              </div>

              <div class="flex items-center gap-4">
                <div class="text-right text-xs">
                  <strong class="text-[var(--text-primary)] block">{{ item.tokens }} toks</strong>
                  <span class="text-[10px] text-[var(--text-muted)] font-mono">{{ item.duration }}</span>
                </div>
                <div class="text-right text-xs">
                  <strong class="text-[var(--accent-primary)] block">{{ item.costEstimate }}</strong>
                  <span class="text-[9px] text-[var(--text-muted)]">{{ item.provenance }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Right 1 Column: Telemetry Invariant & Audit Info -->
        <div class="p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-4 shadow-xs h-fit">
          <div class="flex items-center gap-2">
            <Icon name="shield" :size="16" class="text-[var(--accent-primary)]" />
            <strong class="text-xs font-bold text-[var(--text-primary)]">Telemetry Invariants (ADR-0010)</strong>
          </div>
          <p class="text-xs text-[var(--text-secondary)] leading-relaxed">
            In Sprout M2, Work-model runs represent purposeful agent output (token charges with task attribution).
            Routing attempts represent system dispatch overhead and are strictly separated in audit records.
          </p>
          <div class="p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[11px] flex flex-col gap-1 text-[var(--text-muted)] font-mono">
            <div>Work Runs: 1,101,970 tokens (96.3%)</div>
            <div>Routing Overhead: 42,600 tokens (3.7%)</div>
            <div>Unbilled local execution: $0.00 actual</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
