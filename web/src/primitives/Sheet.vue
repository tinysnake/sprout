<script setup lang="ts">
import { computed } from 'vue';
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';
import { cn } from '../lib/utils.js';
import Icon from './Icon.vue';

export interface SheetProps {
  open?: boolean;
  side?: 'bottom' | 'right';
  title?: string;
  description?: string;
  class?: string;
}

const props = withDefaults(defineProps<SheetProps>(), {
  open: false,
  side: 'bottom',
  title: '',
  description: '',
  class: '',
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

const contentClasses = computed(() => {
  const base =
    'fixed z-50 gap-4 bg-[var(--bg-surface)] p-6 shadow-2xl transition ease-in-out border-[var(--border-subtle)]';

  const sides = {
    bottom:
      'inset-x-0 bottom-0 border-t rounded-t-[var(--radius-xl)] max-h-[85vh] overflow-y-auto',
    right:
      'inset-y-0 right-0 h-full w-3/4 border-l max-w-sm sm:max-w-md overflow-y-auto',
  };

  return cn(base, sides[props.side], props.class);
});
</script>

<template>
  <DialogRoot :open="open" @update:open="(val) => emit('update:open', val)">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs" />
      <DialogContent :class="contentClasses">
        <!-- Drag Handle for bottom sheet -->
        <div v-if="side === 'bottom'" class="mx-auto -mt-2 mb-3 h-1.5 w-12 rounded-full bg-[var(--border-strong)]" />

        <div class="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3">
          <div>
            <DialogTitle v-if="title" class="text-base font-bold text-[var(--text-primary)]">
              {{ title }}
            </DialogTitle>
            <DialogDescription v-if="description" class="text-xs text-[var(--text-secondary)] mt-0.5">
              {{ description }}
            </DialogDescription>
          </div>
          <DialogClose
            class="rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-elevated)] cursor-pointer focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
            aria-label="Close sheet"
            @keydown.enter="emit('update:open', false)"
            @keydown.space.prevent="emit('update:open', false)"
          >
            <Icon name="close" :size="16" />
          </DialogClose>
        </div>

        <div class="py-2 text-xs text-[var(--text-primary)]">
          <slot />
        </div>

        <div v-if="$slots.footer" class="flex justify-end gap-2 border-t border-[var(--border-subtle)] pt-3">
          <slot name="footer" />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
