<script setup lang="ts">
import { computed } from 'vue';
import { cn } from '../lib/utils.js';

export interface TextareaProps {
  modelValue?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  rows?: number;
  class?: string;
  id?: string;
}

const props = withDefaults(defineProps<TextareaProps>(), {
  modelValue: '',
  placeholder: '',
  disabled: false,
  required: false,
  rows: 3,
  class: '',
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const classes = computed(() => {
  return cn(
    'flex w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)] disabled:cursor-not-allowed disabled:opacity-50 resize-y',
    props.class
  );
});
</script>

<template>
  <textarea
    :id="id"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :required="required"
    :rows="rows"
    :class="classes"
    @input="(e) => emit('update:modelValue', (e.target as HTMLTextAreaElement).value)"
  />
</template>
