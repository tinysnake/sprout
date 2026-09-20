<script setup lang="ts">
/**
 * The Deep-link return control.
 *
 * A Feed card navigates to an authoritative domain surface and records where the
 * operator came from, including that page's own filters, so returning restores
 * the context they were operating in rather than a default page. It is a real
 * button with a dismiss control, and it announces itself once.
 */
import { computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useAppStore } from '../stores/app.js';
import { useAnnouncer } from '../primitives/announcer.js';
import Icon from '../primitives/Icon.vue';

const appStore = useAppStore();
const router = useRouter();
const announcer = useAnnouncer();

const context = computed(() => appStore.returnContext);

watch(context, (value) => {
  if (value) announcer.announce(`${value.title} is available.`);
});

function handleReturn() {
  if (!context.value) return;
  const to = context.value.to;
  appStore.clearReturnContext();
  router.push(to);
}
</script>

<template>
  <div
    v-if="context"
    class="return-context-banner flex items-center justify-between px-4 py-2 bg-[var(--accent-bg)] border-b border-[var(--accent-border)] text-xs text-[var(--accent-primary)] font-medium"
  >
    <button
      id="btn-pop-return"
      type="button"
      class="flex items-center gap-1.5 hover:underline cursor-pointer min-h-[32px] focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
      :title="context.title"
      @click="handleReturn"
    >
      <Icon name="chevron-left" :size="14" />
      <span>{{ context.title }}</span>
    </button>
    <button
      type="button"
      class="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
      aria-label="Dismiss return link"
      @click="appStore.clearReturnContext()"
    >
      <Icon name="close" :size="12" />
    </button>
  </div>
</template>
