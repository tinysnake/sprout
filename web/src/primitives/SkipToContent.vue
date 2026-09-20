<script setup lang="ts">
/**
 * A visible-on-focus control that moves keyboard focus to the main content.
 *
 * It is the first focusable element in the Shell, so a keyboard-only operator
 * can skip the sidebar and nested navigation on every page.
 */
import Icon from './Icon.vue';

withDefaults(defineProps<{ targetId?: string; label?: string }>(), {
  targetId: 'sprout-main-content',
  label: 'Skip to main content',
});

function focusTarget(targetId: string) {
  const target = document.getElementById(targetId);
  if (!target) return;
  target.focus();
  // `scrollIntoView` is a no-op in a non-visual environment (jsdom); the focus
  // move is the behaviour that matters and is what the test asserts.
  target.scrollIntoView?.({ block: 'start' });
}
</script>

<template>
  <button
    type="button"
    class="skip-to-content sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-2 focus:left-2 focus:inline-flex focus:items-center focus:gap-1.5 focus:px-3 focus:py-2 focus:rounded-[var(--radius-sm)] focus:bg-[var(--accent-primary)] focus:text-[var(--text-inverse)] focus:text-xs focus:font-bold focus:shadow-lg cursor-pointer min-h-[44px]"
    @click="focusTarget(targetId)"
  >
    <Icon name="chevron-down" :size="14" />
    <span>{{ label }}</span>
  </button>
</template>
