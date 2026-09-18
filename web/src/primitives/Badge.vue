<script setup lang="ts">
import { computed } from 'vue';
import { cn } from '../lib/utils.js';

export interface BadgeProps {
  variant?: 'info' | 'green' | 'success' | 'yellow' | 'warning' | 'red' | 'danger' | 'purple' | 'secondary' | 'neutral';
  class?: string;
}

const props = withDefaults(defineProps<BadgeProps>(), {
  variant: 'secondary',
  class: '',
});

const classes = computed(() => {
  const base = 'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide uppercase border shrink-0';

  const variants = {
    info: 'bg-[var(--accent-bg)] text-[var(--accent-primary)] border-[var(--accent-border)]',
    green: 'bg-[var(--green-ready-bg)] text-[var(--green-ready)] border-[var(--green-ready-border)]',
    success: 'bg-[var(--green-ready-bg)] text-[var(--green-ready)] border-[var(--green-ready-border)]',
    yellow: 'bg-[var(--yellow-attention-bg)] text-[var(--yellow-attention)] border-[var(--yellow-attention-border)]',
    warning: 'bg-[var(--yellow-attention-bg)] text-[var(--yellow-attention)] border-[var(--yellow-attention-border)]',
    red: 'bg-[var(--red-action-bg)] text-[var(--red-action)] border-[var(--red-action-border)]',
    danger: 'bg-[var(--red-action-bg)] text-[var(--red-action)] border-[var(--red-action-border)]',
    purple: 'bg-[var(--purple-agent-bg)] text-[var(--purple-agent)] border-[var(--purple-agent-border)]',
    secondary: 'bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)] border-[var(--border-subtle)]',
    neutral: 'bg-[var(--bg-surface-elevated)] text-[var(--text-muted)] border-[var(--border-subtle)]',
  };

  return cn(base, variants[props.variant], props.class);
});
</script>

<template>
  <span :class="classes">
    <slot />
  </span>
</template>
