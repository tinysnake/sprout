<script setup lang="ts">
import { computed } from 'vue';
import { cn } from '../lib/utils.js';

export interface StatusPillProps {
  status?: 'green' | 'yellow' | 'red' | 'purple' | 'blue' | 'neutral';
  class?: string;
}

const props = withDefaults(defineProps<StatusPillProps>(), {
  status: 'neutral',
  class: '',
});

const classes = computed(() => {
  const base =
    'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold tracking-wide border shrink-0';

  const variants = {
    green: 'bg-[var(--green-ready-bg)] text-[var(--green-ready)] border-[var(--green-ready-border)]',
    yellow: 'bg-[var(--yellow-attention-bg)] text-[var(--yellow-attention)] border-[var(--yellow-attention-border)]',
    red: 'bg-[var(--red-action-bg)] text-[var(--red-action)] border-[var(--red-action-border)]',
    purple: 'bg-[var(--purple-agent-bg)] text-[var(--purple-agent)] border-[var(--purple-agent-border)]',
    blue: 'bg-[var(--accent-bg)] text-[var(--accent-primary)] border-[var(--accent-border)]',
    neutral: 'bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)] border-[var(--border-subtle)]',
  };

  return cn(base, variants[props.status], props.class);
});
</script>

<template>
  <span :class="classes">
    <slot />
  </span>
</template>
