<script setup lang="ts">
/**
 * A metric tile: label, value, and optional secondary context.
 *
 * A metric without a value is reported as unavailable rather than as zero, so
 * missing telemetry is never presented as a measured result.
 */
import { computed } from 'vue';
import { cn } from '../lib/utils.js';
import Icon from './Icon.vue';

export interface KpiTileProps {
  label: string;
  value?: string;
  note?: string;
  icon?: string;
  /** True when the underlying measurement is absent rather than zero. */
  unavailable?: boolean;
  severity?: 'neutral' | 'green' | 'yellow' | 'red' | 'accent';
  class?: string;
}

const props = withDefaults(defineProps<KpiTileProps>(), {
  value: '',
  note: '',
  icon: '',
  unavailable: false,
  severity: 'neutral',
  class: '',
});

const tone = computed(() => {
  switch (props.severity) {
    case 'green':
      return 'text-[var(--green-ready)]';
    case 'yellow':
      return 'text-[var(--yellow-attention)]';
    case 'red':
      return 'text-[var(--red-action)]';
    case 'accent':
      return 'text-[var(--accent-primary)]';
    default:
      return 'text-[var(--text-primary)]';
  }
});

const classes = computed(() =>
  cn(
    'card-kpi flex flex-col gap-1 p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-xs',
    props.class
  )
);
</script>

<template>
  <div :class="classes">
    <span class="card-kpi-label flex items-center gap-1.5 text-[10px] uppercase font-bold text-[var(--text-muted)]">
      <Icon v-if="icon" :name="icon" :size="12" />
      <span>{{ label }}</span>
    </span>
    <span class="card-kpi-value text-2xl font-bold" :class="tone">
      <template v-if="unavailable">Unavailable</template>
      <template v-else>{{ value }}</template>
    </span>
    <span v-if="note" class="card-kpi-note text-[10px] text-[var(--text-muted)]">{{ note }}</span>
  </div>
</template>
