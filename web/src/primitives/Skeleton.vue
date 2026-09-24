<script setup lang="ts">
/**
 * A loading placeholder for a region that has a known shape.
 *
 * `aria-busy` marks the region while it is pending and the visible label is
 * announced, so a pending read is never presented as an empty result.
 */
import { computed } from 'vue';
import { cn } from '../lib/utils.js';

export interface SkeletonProps {
  lines?: number;
  label?: string;
  class?: string;
}

const props = withDefaults(defineProps<SkeletonProps>(), {
  lines: 3,
  label: 'Loading',
  class: '',
});

const classes = computed(() => cn('skeleton flex flex-col gap-2', props.class));
const lineIndexes = computed(() => Array.from({ length: Math.max(1, props.lines) }, (_, index) => index));
</script>

<template>
  <div :class="classes" role="status" aria-busy="true" :aria-label="label">
    <span class="sr-only">{{ label }}</span>
    <span
      v-for="index in lineIndexes"
      :key="index"
      class="skeleton-line block h-3 rounded-[var(--radius-xs)] bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] animate-pulse"
      :class="index === lineIndexes.length - 1 ? 'w-2/3' : 'w-full'"
      aria-hidden="true"
    />
  </div>
</template>
