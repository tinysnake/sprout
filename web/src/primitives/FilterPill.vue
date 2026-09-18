<script setup lang="ts">
import { computed } from 'vue';
import { cn } from '../lib/utils.js';
import StatusDot from './StatusDot.vue';

export interface FilterPillProps {
  active?: boolean;
  filterKey: string;
  label: string;
  count: number;
  status?: 'green' | 'yellow' | 'red' | 'purple' | 'neutral';
  class?: string;
}

const props = withDefaults(defineProps<FilterPillProps>(), {
  active: false,
  status: 'neutral',
  class: '',
});

const emit = defineEmits<{
  (e: 'click', key: string): void;
}>();

const classes = computed(() => {
  return cn(
    'env-filter-box-btn filter-pill flex flex-col items-center justify-center p-2 rounded-[var(--radius-sm)] border text-center transition-all cursor-pointer select-none min-h-[44px] flex-1 min-w-[70px]',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]',
    props.active
      ? 'bg-[var(--accent-bg)] border-[var(--accent-primary)] text-[var(--text-primary)] font-bold ring-1 ring-[var(--accent-primary)]'
      : 'bg-[var(--bg-surface-elevated)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-surface)]',
    props.class
  );
});
</script>

<template>
  <button
    type="button"
    :class="classes"
    :data-filter="filterKey"
    :aria-pressed="active"
    :title="`${label} (${count})`"
    @click="emit('click', filterKey)"
  >
    <span class="env-filter-box-top flex items-center justify-center gap-1.5 text-xs font-semibold">
      <StatusDot :status="status" size="sm" />
      <span>{{ count }}</span>
    </span>
    <span class="env-filter-box-bottom text-[11px] mt-0.5 whitespace-nowrap">
      {{ label }}<span class="sr-only"> ({{ count }})</span>
    </span>
  </button>
</template>
