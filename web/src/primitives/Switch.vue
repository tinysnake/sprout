<script setup lang="ts">
import { computed } from 'vue';
import { SwitchRoot, SwitchThumb } from 'reka-ui';
import { cn } from '../lib/utils.js';

export interface SwitchProps {
  modelValue?: boolean;
  disabled?: boolean;
  id?: string;
  class?: string;
  ariaLabel?: string;
}

const props = withDefaults(defineProps<SwitchProps>(), {
  modelValue: false,
  disabled: false,
  class: '',
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
}>();

const rootClasses = computed(() => {
  return cn(
    'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-[var(--green-ready)] data-[state=unchecked]:bg-[var(--border-strong)]',
    props.class
  );
});

const thumbClasses = computed(() => {
  return cn(
    'pointer-events-none block h-4 w-4 rounded-full bg-white shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0'
  );
});
</script>

<template>
  <SwitchRoot
    :id="id"
    :model-value="modelValue"
    :disabled="disabled"
    :class="rootClasses"
    :aria-label="ariaLabel"
    @update:model-value="(val) => emit('update:modelValue', !!val)"
  >
    <SwitchThumb :class="thumbClasses" />
  </SwitchRoot>
</template>
