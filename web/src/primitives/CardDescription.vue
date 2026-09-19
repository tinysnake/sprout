<script setup lang="ts">
import { computed } from 'vue';
import { cn } from '../lib/utils.js';

const props = withDefaults(
  defineProps<{
    class?: string;
  }>(),
  { class: '' }
);

const classes = computed(() =>
  cn('text-xs text-[var(--text-secondary)] leading-normal', props.class)
);
</script>

<template>
  <p :class="classes">
    <slot />
  </p>
</template>
