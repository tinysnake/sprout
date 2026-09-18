<script setup lang="ts">
import { computed } from 'vue';
import { cn } from '../lib/utils.js';

const props = withDefaults(
  defineProps<{
    class?: string;
  }>(),
  { class: '' }
);

const classes = computed(() => cn('p-4 pt-0', props.class));
</script>

<template>
  <div :class="classes">
    <slot />
  </div>
</template>
