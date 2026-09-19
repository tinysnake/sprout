<script setup lang="ts">
import { computed } from 'vue';
import { cn } from '../lib/utils.js';

export interface StatusDotProps {
  status?: 'green' | 'yellow' | 'red' | 'purple' | 'neutral';
  size?: 'sm' | 'md' | 'lg';
  label?: string;
  class?: string;
}

const props = withDefaults(defineProps<StatusDotProps>(), {
  status: 'neutral',
  size: 'sm',
  class: '',
});

const defaultLabels = {
  green: 'READY',
  yellow: 'ATTENTION',
  red: 'ACTION REQUIRED',
  purple: 'ACTIVE',
  neutral: 'UNKNOWN',
};

const computedLabel = computed(() => props.label ?? defaultLabels[props.status]);

const classes = computed(() => {
  const base = 'inline-block rounded-full shrink-0';

  const sizes = {
    sm: 'w-2 h-2',
    md: 'w-2.5 h-2.5',
    lg: 'w-3.5 h-3.5',
  };

  const colors = {
    green: 'bg-[var(--green-ready)]',
    yellow: 'bg-[var(--yellow-attention)]',
    red: 'bg-[var(--red-action)]',
    purple: 'bg-[var(--purple-agent)]',
    neutral: 'bg-[var(--text-muted)]',
  };

  return cn(base, sizes[props.size], colors[props.status], props.class);
});
</script>

<template>
  <span
    :class="classes"
    :title="computedLabel"
    :aria-label="computedLabel"
    role="img"
  />
</template>
