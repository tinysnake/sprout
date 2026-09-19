<script setup lang="ts">
import { computed } from 'vue';
import { cn } from '../lib/utils.js';

const props = withDefaults(
  defineProps<{
    class?: string;
  }>(),
  { class: '' }
);

const classes = computed(() => cn('flex flex-col space-y-1.5 p-4', props.class));
</script>

<template>
  <div :class="classes">
    <slot />
  </div>
</template>
