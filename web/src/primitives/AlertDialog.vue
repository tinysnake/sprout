<script setup lang="ts">
import { computed } from 'vue';
import {
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
} from 'reka-ui';
import { cn } from '../lib/utils.js';
import Icon from './Icon.vue';

export interface AlertDialogProps {
  open?: boolean;
  title?: string;
  description?: string;
  class?: string;
}

const props = withDefaults(defineProps<AlertDialogProps>(), {
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
    'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border border-[var(--red-action)] bg-[var(--bg-surface)] p-6 shadow-xl duration-200 rounded-[var(--radius-lg)] sm:max-w-[540px]',
    props.class
  );
});
</script>

<template>
  <AlertDialogRoot :open="open" @update:open="(val) => emit('update:open', val)">
    <AlertDialogPortal>
      <AlertDialogOverlay class="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs transition-opacity" />
      <AlertDialogContent :class="contentClasses">
        <div class="flex items-center justify-between border-b-2 border-[var(--red-action)] pb-3">
          <div>
            <AlertDialogTitle v-if="title" class="text-base font-bold text-[var(--red-action)] flex items-center gap-2">
              <Icon name="warning" :size="18" />
              <span>{{ title }}</span>
            </AlertDialogTitle>
            <AlertDialogDescription v-if="description" class="text-xs text-[var(--text-secondary)] mt-0.5">
              {{ description }}
            </AlertDialogDescription>
          </div>
          <AlertDialogCancel
            class="rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-elevated)] cursor-pointer focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
            aria-label="Close dialog"
            @keydown.enter="emit('update:open', false)"
            @keydown.space.prevent="emit('update:open', false)"
          >
            <Icon name="close" :size="16" />
          </AlertDialogCancel>
        </div>

        <div class="py-2 text-xs text-[var(--text-primary)]">
          <slot />
        </div>

        <div v-if="$slots.footer" class="flex justify-end gap-2 border-t border-[var(--border-subtle)] pt-3">
          <slot name="footer" />
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
