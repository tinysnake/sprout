<script setup lang="ts">
import { nextTick, ref, useId, watch } from 'vue';
import Icon from '../../../primitives/Icon.vue';

/** The route-owned dialog keeps its focus context when Chat detail URLs change. */
const props = defineProps<{ readonly open: boolean; readonly title: string; readonly description: string }>();
const emit = defineEmits<{ (event: 'update:open', value: boolean): void }>();
const id = useId();
const panel = ref<HTMLElement | null>(null);
let returnFocus: HTMLElement | null = null;
watch(() => props.open, async (open) => {
  if (open) {
    returnFocus = document.activeElement as HTMLElement | null;
    await nextTick();
    panel.value?.querySelector<HTMLElement>('button, input, select, textarea')?.focus();
  } else if (returnFocus) {
    await nextTick();
    if (returnFocus.isConnected) returnFocus.focus();
    returnFocus = null;
  }
});
function close() { emit('update:open', false); }
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
  if (event.key !== 'Tab' || !panel.value) return;
  const items = [...panel.value.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')];
  if (!items.length) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
</script>

<template>
  <div v-if="open" class="chat-dialog-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3" @click.self="close">
    <div ref="panel" role="dialog" aria-modal="true" :aria-labelledby="`${id}-title`" :aria-describedby="`${id}-description`" class="flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--border-strong)] bg-[var(--bg-surface)] p-4 shadow-lg sm:p-6" @keydown="onKeydown">
      <header class="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] pb-3"><div><h2 :id="`${id}-title`" class="text-base font-bold text-[var(--text-primary)]">{{ title }}</h2><p :id="`${id}-description`" class="text-xs text-[var(--text-secondary)]">{{ description }}</p></div><button type="button" aria-label="Close dialog" class="flex h-11 w-11 shrink-0 items-center justify-center rounded focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]" @click="close"><Icon name="close" :size="16" /></button></header>
      <div class="text-[var(--text-primary)]"><slot /></div>
      <footer v-if="$slots.footer" class="flex justify-end gap-2 border-t border-[var(--border-subtle)] pt-3"><slot name="footer" /></footer>
    </div>
  </div>
</template>
