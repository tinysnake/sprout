<script setup lang="ts">
import { computed } from 'vue';
import type { EngineDetailInfo, EngineReadiness, EngineStatus } from '../types.js';
import StatusPill from '../../../primitives/StatusPill.vue';

const props = defineProps<{
  readiness: EngineReadiness;
  details?: Record<string, EngineDetailInfo>;
}>();

function getStatusPill(status: EngineStatus): 'green' | 'yellow' | 'red' | 'neutral' {
  if (status === 'ready') return 'green';
  if (status === 'login-required') return 'yellow';
  if (status === 'missing') return 'red';
  return 'neutral';
}

function engineLabel(engine: string): string {
  if (engine === 'codex') return 'Codex';
  if (engine === 'pi') return 'Pi';
  return engine;
}

/**
 * The rows the page renders, in the prototype's representative order when the
 * canonical engines are present, then any further engine the Worker declared.
 * The quadrant layout is a presentation choice; the rows themselves are the
 * Worker's declared facts, never a fixed schema.
 */
const engineRows = computed(() => {
  const canonical = ['codex', 'pi', 'agy', 'opencode'].filter((engine) => engine in props.readiness);
  const declared = Object.keys(props.readiness).filter((engine) => !canonical.includes(engine));
  return [...canonical, ...declared].map((engine) => ({
    engine,
    label: engineLabel(engine),
    status: props.readiness[engine] ?? 'unknown',
    detail: props.details?.[engine],
  }));
});
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
      <div
        v-for="row in engineRows"
        :key="row.engine"
        class="engine-card p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-1"
        :data-engine="row.engine"
      >
        <div class="flex items-center justify-between">
          <strong class="text-xs font-bold text-[var(--text-primary)]">{{ row.label }}</strong>
          <StatusPill :status="getStatusPill(row.status)" class="text-[9px]">
            {{ row.status.toUpperCase() }}
          </StatusPill>
        </div>
        <div class="text-[10px] text-[var(--text-muted)] flex justify-between">
          <span>{{ row.detail?.version ?? 'installed' }}</span>
          <span>{{ row.detail?.authStatus ?? row.status }}</span>
        </div>
        <div v-if="row.detail?.modelAvailability" class="text-[10px] text-[var(--text-secondary)] font-mono truncate">
          {{ row.detail.modelAvailability }}
        </div>
        <div v-if="row.detail?.notes" class="text-[10px] text-[var(--yellow-attention)] mt-0.5">
          {{ row.detail.notes }}
        </div>
      </div>
    </div>

    <div class="text-[10px] text-[var(--text-muted)] mt-1">
      Safety Guarantee: Host paths, API keys, and credentials remain strictly on the host; Web inspects only neutral readiness facts.
    </div>
  </div>
</template>
