<script setup lang="ts">
import { computed } from 'vue';
import { cn } from '../lib/utils.js';
import Icon from './Icon.vue';

export interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  class?: string;
}

const props = withDefaults(defineProps<EmptyStateProps>(), {
  icon: 'environments',
  description: '',
  class: '',
});

const classes = computed(() => {
  return cn(
    'card flex flex-col items-center justify-center p-8 text-center rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-muted)]',
    props.class
  );
});
</script>

<template>
  <div :class="classes">
    <Icon v-if="icon" :name="icon" :size="32" class="text-[var(--text-muted)] mb-2" />
    <strong class="text-sm font-semibold text-[var(--text-primary)] mb-1">{{ title }}</strong>
    <p v-if="description" class="text-xs text-[var(--text-secondary)] max-w-sm">{{ description }}</p>
    <div v-if="$slots.default" class="mt-4">
      <slot />
    </div>
  </div>
</template>
