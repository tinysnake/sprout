<script setup lang="ts">
import { ref } from 'vue';
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from 'reka-ui';
import { cn } from '../lib/utils.js';
import Icon from './Icon.vue';

export interface FoldableProps {
  defaultOpen?: boolean;
  title: string;
  subtext?: string;
  class?: string;
}

const props = withDefaults(defineProps<FoldableProps>(), {
  defaultOpen: false,
  subtext: '',
  class: '',
});

const open = ref(props.defaultOpen);
</script>

<template>
  <CollapsibleRoot
    v-model:open="open"
    :class="cn('rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] overflow-hidden transition-all', props.class)"
  >
    <CollapsibleTrigger
      class="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-surface)] focus-visible:outline-2 focus-visible:outline-[var(--border-focus)] cursor-pointer select-none"
    >
      <div class="flex items-center gap-2">
        <span>{{ title }}</span>
        <span v-if="subtext" class="text-[10px] text-[var(--text-muted)] font-normal">{{ subtext }}</span>
      </div>
      <Icon
        name="chevron-down"
        :size="14"
        :class="cn('text-[var(--text-muted)] transition-transform duration-200', open && 'rotate-180')"
      />
    </CollapsibleTrigger>
    <CollapsibleContent class="px-3 pb-3 pt-1 border-t border-[var(--border-subtle)] text-xs text-[var(--text-secondary)]">
      <slot />
    </CollapsibleContent>
  </CollapsibleRoot>
</template>
