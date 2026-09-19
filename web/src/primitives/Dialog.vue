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

export interface DialogProps {
  open?: boolean;
  title?: string;
  description?: string;
  class?: string;
}

const props = withDefaults(defineProps<DialogProps>(), {
  open: false,
  title: '',
  description: '',
  class: '',
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

const contentClasses = computed(() => {
  return cn(
    'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border border-[var(--border-strong)] bg-[var(--bg-surface)] p-6 shadow-lg duration-200 rounded-[var(--radius-lg)] sm:max-w-[500px]',
    props.class
  );
});
</script>

<template>
  <DialogRoot :open="open" @update:open="(val) => emit('update:open', val)">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs transition-opacity" />
      <DialogContent :class="contentClasses">
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
            aria-label="Close dialog"
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
