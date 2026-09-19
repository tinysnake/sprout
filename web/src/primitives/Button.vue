<script setup lang="ts">
import { computed } from 'vue';
import { cn } from '../lib/utils.js';

export interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline' | 'warning';
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'icon';
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  class?: string;
}

const props = withDefaults(defineProps<ButtonProps>(), {
  variant: 'secondary',
  size: 'sm',
  disabled: false,
  type: 'button',
  class: '',
});

const emit = defineEmits<{
  (e: 'click', event: MouseEvent): void;
}>();

const classes = computed(() => {
  const base =
    'inline-flex items-center justify-center font-medium rounded transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)] disabled:opacity-50 disabled:pointer-events-none select-none cursor-pointer shrink-0';

  const variants = {
    primary:
      'bg-[var(--accent-primary)] text-[var(--text-inverse)] hover:bg-[var(--accent-primary-hover)] border border-transparent shadow-xs',
    secondary:
      'bg-[var(--bg-surface-elevated)] text-[var(--text-primary)] hover:bg-[var(--border-subtle)] border border-[var(--border-subtle)] shadow-xs',
    danger:
      'bg-[var(--red-action)] text-white hover:opacity-90 border border-transparent shadow-xs',
    warning:
      'bg-[var(--yellow-attention)] text-white hover:opacity-90 border border-transparent shadow-xs',
    ghost:
      'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--accent-primary)] border border-transparent',
    outline:
      'bg-transparent text-[var(--text-primary)] border border-[var(--border-strong)] hover:bg-[var(--bg-surface-elevated)]',
  };

  const sizes = {
    xs: 'text-xs h-7 px-2 gap-1 min-h-[28px]',
    sm: 'text-xs h-8 px-3 gap-1.5 min-h-[32px]',
    md: 'text-sm h-10 px-4 gap-2 min-h-[40px]',
    lg: 'text-base h-11 px-5 gap-2.5 min-h-[44px]',
    icon: 'h-8 w-8 p-0 min-h-[32px] min-w-[32px]',
  };

  return cn(base, variants[props.variant], sizes[props.size], props.class);
});
</script>

<template>
  <button
    :type="type"
    :disabled="disabled"
    :class="classes"
    @click="(ev) => emit('click', ev)"
  >
    <slot />
  </button>
</template>
