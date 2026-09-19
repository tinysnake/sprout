<script setup lang="ts">
import { computed } from 'vue';
import { cn } from '../lib/utils.js';

const props = withDefaults(
  defineProps<{
    class?: string;
    as?: string;
  }>(),
  { class: '', as: 'h3' }
);

const classes = computed(() =>
  cn('font-bold text-sm leading-tight text-[var(--text-primary)]', props.class)
);
</script>

<template>
  <component :is="as" :class="classes">
    <slot />
  </component>
</template>
