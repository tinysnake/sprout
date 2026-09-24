<script setup lang="ts">
/**
 * One line or two of text with a full-value title, so a clamped label is still
 * readable without changing the visual density of a card or list.
 */
import { computed } from 'vue';
import { cn } from '../lib/utils.js';

export interface ClampedTextProps {
  text: string;
  lines?: 1 | 2 | 3;
  as?: string;
  class?: string;
}

const props = withDefaults(defineProps<ClampedTextProps>(), {
  lines: 2,
  as: 'p',
  class: '',
});

const clampClass = computed(() => {
  if (props.lines === 1) return 'line-clamp-1';
  if (props.lines === 3) return 'line-clamp-3';
  return 'line-clamp-2';
});

const classes = computed(() => cn('clamped-text', clampClass.value, props.class));
</script>

<template>
  <component :is="as" :class="classes" :title="text">{{ text }}</component>
</template>
