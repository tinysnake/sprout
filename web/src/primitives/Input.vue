<script setup lang="ts">
import { computed } from 'vue';
import { cn } from '../lib/utils.js';

export interface InputProps {
  modelValue?: string | number;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  class?: string;
  id?: string;
}

const props = withDefaults(defineProps<InputProps>(), {
  modelValue: '',
  type: 'text',
  placeholder: '',
  disabled: false,
  required: false,
  class: '',
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const classes = computed(() => {
  return cn(
    'flex h-9 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-3 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)] disabled:cursor-not-allowed disabled:opacity-50',
    props.class
  );
});
</script>

<template>
  <input
    :id="id"
    :type="type"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :required="required"
    :class="classes"
    @input="(e) => emit('update:modelValue', (e.target as HTMLInputElement).value)"
  />
</template>
