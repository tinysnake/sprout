<script setup lang="ts">
import { computed } from 'vue';
import { cn } from '../lib/utils.js';

export interface CardProps {
  interactive?: boolean;
  selected?: boolean;
  class?: string;
  as?: string;
}

const props = withDefaults(defineProps<CardProps>(), {
  interactive: false,
  selected: false,
  class: '',
  as: 'div',
});

function handleKeyDown(event: KeyboardEvent) {
  if (!props.interactive) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    (event.currentTarget as HTMLElement | null)?.click();
  }
}

const classes = computed(() => {
  return cn(
    'rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-xs transition-colors',
    props.interactive &&
      'cursor-pointer hover:border-[var(--border-strong)] hover:bg-[var(--bg-surface-elevated)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]',
    props.selected &&
      'border-[var(--accent-primary)] bg-[var(--bg-surface-elevated)] ring-1 ring-[var(--accent-primary)]',
    props.class
  );
});
</script>

<template>
  <component
    :is="as"
    :class="classes"
    @keydown="handleKeyDown"
  >
    <slot />
  </component>
</template>
