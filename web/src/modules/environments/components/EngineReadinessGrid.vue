<script setup lang="ts">
import type { EngineDetailInfo, EngineReadiness, EngineStatus } from '../types.js';
import StatusPill from '../../../primitives/StatusPill.vue';

defineProps<{
  readiness: EngineReadiness;
  details?: Record<string, EngineDetailInfo>;
}>();

function getStatusPill(status: EngineStatus): 'green' | 'yellow' | 'red' | 'neutral' {
  if (status === 'ready') return 'green';
  if (status === 'login-required') return 'yellow';
  if (status === 'missing') return 'red';
  return 'neutral';
}
</script>

<template>
  <div class="engine-readiness-box p-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <strong class="text-xs uppercase tracking-wider text-[var(--text-muted)] font-bold">
        6. Engine Harness Readiness (Host-Local Facts)
      </strong>
      <span class="text-[10px] text-[var(--text-muted)]">Codex, Pi, agy, opencode</span>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2">
      <!-- Codex -->
      <div class="engine-card p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-1">
        <div class="flex items-center justify-between">
          <strong class="text-xs font-bold text-[var(--text-primary)]">Codex</strong>
          <StatusPill :status="getStatusPill(readiness.codex)" class="text-[9px]">
            {{ readiness.codex.toUpperCase() }}
          </StatusPill>
        </div>
        <div class="text-[10px] text-[var(--text-muted)] flex justify-between">
          <span>{{ details?.codex?.version ?? 'installed' }}</span>
          <span>{{ details?.codex?.authStatus ?? 'active' }}</span>
        </div>
        <div v-if="details?.codex?.modelAvailability" class="text-[10px] text-[var(--text-secondary)] font-mono truncate">
          {{ details.codex.modelAvailability }}
        </div>
        <div v-if="details?.codex?.notes" class="text-[10px] text-[var(--yellow-attention)] mt-0.5">
          {{ details.codex.notes }}
        </div>
      </div>

      <!-- Pi -->
      <div class="engine-card p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-1">
        <div class="flex items-center justify-between">
          <strong class="text-xs font-bold text-[var(--text-primary)]">Pi</strong>
          <StatusPill :status="getStatusPill(readiness.pi)" class="text-[9px]">
            {{ readiness.pi.toUpperCase() }}
          </StatusPill>
        </div>
        <div class="text-[10px] text-[var(--text-muted)] flex justify-between">
          <span>{{ details?.pi?.version ?? 'installed' }}</span>
          <span>{{ details?.pi?.authStatus ?? 'active' }}</span>
        </div>
        <div v-if="details?.pi?.modelAvailability" class="text-[10px] text-[var(--text-secondary)] font-mono truncate">
          {{ details.pi.modelAvailability }}
        </div>
        <div v-if="details?.pi?.notes" class="text-[10px] text-[var(--yellow-attention)] mt-0.5">
          {{ details.pi.notes }}
        </div>
      </div>

      <!-- agy -->
      <div class="engine-card p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-1">
        <div class="flex items-center justify-between">
          <strong class="text-xs font-bold text-[var(--text-primary)]">agy</strong>
          <StatusPill :status="getStatusPill(readiness.agy)" class="text-[9px]">
            {{ readiness.agy.toUpperCase() }}
          </StatusPill>
        </div>
        <div class="text-[10px] text-[var(--text-muted)] flex justify-between">
          <span>{{ details?.agy?.version ?? 'installed' }}</span>
          <span>{{ details?.agy?.authStatus ?? 'active' }}</span>
        </div>
        <div v-if="details?.agy?.modelAvailability" class="text-[10px] text-[var(--text-secondary)] font-mono truncate">
          {{ details.agy.modelAvailability }}
        </div>
        <div v-if="details?.agy?.notes" class="text-[10px] text-[var(--yellow-attention)] mt-0.5">
          {{ details.agy.notes }}
        </div>
      </div>

      <!-- opencode -->
      <div class="engine-card p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-1">
        <div class="flex items-center justify-between">
          <strong class="text-xs font-bold text-[var(--text-primary)]">opencode</strong>
          <StatusPill :status="getStatusPill(readiness.opencode)" class="text-[9px]">
            {{ readiness.opencode.toUpperCase() }}
          </StatusPill>
        </div>
        <div class="text-[10px] text-[var(--text-muted)] flex justify-between">
          <span>{{ details?.opencode?.version ?? 'installed' }}</span>
          <span>{{ details?.opencode?.authStatus ?? 'active' }}</span>
        </div>
        <div v-if="details?.opencode?.modelAvailability" class="text-[10px] text-[var(--text-secondary)] font-mono truncate">
          {{ details.opencode.modelAvailability }}
        </div>
        <div v-if="details?.opencode?.notes" class="text-[10px] text-[var(--yellow-attention)] mt-0.5">
          {{ details.opencode.notes }}
        </div>
      </div>
    </div>

    <div class="text-[10px] text-[var(--text-muted)] mt-1">
      Safety Guarantee: Host paths, API keys, and credentials remain strictly on the host; Web inspects only neutral readiness facts.
    </div>
  </div>
</template>
