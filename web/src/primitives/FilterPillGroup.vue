<script setup lang="ts">
import { computed } from 'vue';
import { cn } from '../lib/utils.js';

export interface FilterPillGroupProps {
  label?: string;
  class?: string;
}

const props = withDefaults(defineProps<FilterPillGroupProps>(), {
  label: 'Filter environments by health status',
  class: '',
});

const classes = computed(() => {
  return cn(
    'env-filter-boxes flex items-center gap-1.5 overflow-x-auto w-full py-1',
    props.class
  );
});
</script>

<template>
  <div
    role="group"
    :aria-label="label"
    :class="classes"
  >
    <slot />
  </div>
</template>
