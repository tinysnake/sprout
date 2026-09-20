<script setup lang="ts">
/**
 * The shared card shell: surface, border, radius, shadow, and the interactive
 * affordance (hover elevation, focus ring, Enter/Space activation).
 *
 * It deliberately has no domain `kind`/`variant` prop. Which facts appear on a
 * card, in what order, and with what wording belongs to the domain composition
 * that renders it; a switchable body would carry every domain's rules at once.
 *
 * `as="button"` renders a real button, so activation, focus, and the disabled
 * state all come from the element; it also defaults `type="button"` so a card
 * never submits an enclosing form by accident. The `interactive` keyboard path
 * exists for cards that must stay a non-button element (for example a listbox
 * option): it adds `tabindex="0"` and `role="button"` so the Enter/Space path
 * is actually reachable instead of being unreachable decoration.
 */
import { computed } from 'vue';
import { cn } from '../lib/utils.js';
import type { StatusSeverity } from '../tokens/index.js';

export interface CardProps {
  interactive?: boolean;
  selected?: boolean;
  disabled?: boolean;
  class?: string;
  as?: string;
  /** Optional leading severity accent stripe. */
  accent?: StatusSeverity;
}

const props = withDefaults(defineProps<CardProps>(), {
  interactive: false,
  selected: false,
  disabled: false,
  class: '',
  as: 'div',
  accent: undefined,
});

const ACCENTS: Record<StatusSeverity, string> = {
  green: 'border-l-4 border-l-[var(--green-ready)]',
  yellow: 'border-l-4 border-l-[var(--yellow-attention)]',
  red: 'border-l-4 border-l-[var(--red-action)]',
  purple: 'border-l-4 border-l-[var(--purple-agent)]',
  blue: 'border-l-4 border-l-[var(--accent-primary)]',
  neutral: 'border-l-4 border-l-[var(--border-strong)]',
};

const isButton = computed(() => props.as === 'button');
const isInteractive = computed(() => props.interactive && !props.disabled);
/** A non-button interactive card needs its own focus and activation semantics. */
const needsKeyboardRole = computed(() => isInteractive.value && !isButton.value);

function handleKeyDown(event: KeyboardEvent) {
  if (!isInteractive.value) return;
  if (event.key === 'Enter' || event.key === ' ') {
    // preventDefault suppresses the element's own activation for this key, so an
    // interactive card activates exactly once whether or not it is a real
    // button. Non-button cards additionally carry tabindex/role so this path is
    // actually reachable by keyboard.
    event.preventDefault();
    (event.currentTarget as HTMLElement | null)?.click();
  }
}

const classes = computed(() => {
  return cn(
    'rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-xs transition-colors',
    props.accent !== undefined && ACCENTS[props.accent],
    props.interactive &&
      'cursor-pointer hover:border-[var(--border-strong)] hover:bg-[var(--bg-surface-elevated)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]',
    props.disabled && 'cursor-not-allowed opacity-50',
    props.selected &&
      'border-[var(--accent-primary)] bg-[var(--bg-surface-elevated)] ring-1 ring-[var(--accent-primary)]',
    props.class
  );
});
</script>

<template>
  <component
    :is="as"
    :type="isButton ? 'button' : undefined"
    :disabled="isButton ? disabled : undefined"
    :tabindex="needsKeyboardRole ? 0 : undefined"
    :role="needsKeyboardRole ? 'button' : undefined"
    :aria-disabled="!isButton && disabled ? 'true' : undefined"
    :class="classes"
    @keydown="handleKeyDown"
  >
    <slot />
  </component>
</template>
