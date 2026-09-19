<script setup lang="ts">
import { computed } from 'vue';
import { CheckboxIndicator, CheckboxRoot } from 'reka-ui';
import { cn } from '../lib/utils.js';
import Icon from './Icon.vue';

export interface CheckboxProps {
  modelValue?: boolean;
  disabled?: boolean;
  id?: string;
  class?: string;
}

const props = withDefaults(defineProps<CheckboxProps>(), {
  modelValue: false,
  disabled: false,
  class: '',
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
}>();

const classes = computed(() => {
  return cn(
    'peer h-4 w-4 shrink-0 rounded border border-[var(--border-strong)] bg-[var(--bg-surface-elevated)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-[var(--accent-primary)] data-[state=checked]:border-[var(--accent-primary)] data-[state=checked]:text-[var(--text-inverse)] flex items-center justify-center cursor-pointer transition-colors',
    props.class
  );
});
</script>

<template>
  <CheckboxRoot
    :id="id"
    :model-value="modelValue"
    :disabled="disabled"
    :class="classes"
    @update:model-value="(val) => emit('update:modelValue', !!val)"
  >
    <CheckboxIndicator class="flex items-center justify-center text-current">
      <Icon name="check" :size="12" />
    </CheckboxIndicator>
  </CheckboxRoot>
</template>
