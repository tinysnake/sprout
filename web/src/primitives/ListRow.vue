<script setup lang="ts">
/**
 * A row in a list: leading slot, title plus optional subtitle, trailing slot.
 *
 * It is presentation only. When a row is actionable the caller renders the
 * `ListRow` inside a real `<button>` or `RouterLink`, so activation, focus, and
 * keyboard behaviour come from the element rather than a simulated role.
 */
import { computed } from 'vue';
import { cn } from '../lib/utils.js';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  class?: string;
}

const props = withDefaults(defineProps<ListRowProps>(), {
  subtitle: '',
  class: '',
});

const classes = computed(() =>
  cn(
    'list-row flex w-full items-center gap-3 p-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] text-left',
    props.class
  )
);
</script>

<template>
  <div :class="classes">
    <span v-if="$slots.leading" class="list-row-leading shrink-0">
      <slot name="leading" />
    </span>
    <span class="list-row-body flex-1 min-w-0">
      <strong class="list-row-title block text-xs font-bold text-[var(--text-primary)] truncate">{{ title }}</strong>
      <span v-if="subtitle" class="list-row-subtitle block text-[11px] text-[var(--text-secondary)] truncate">{{ subtitle }}</span>
    </span>
    <span v-if="$slots.trailing" class="list-row-trailing shrink-0">
      <slot name="trailing" />
    </span>
  </div>
</template>
