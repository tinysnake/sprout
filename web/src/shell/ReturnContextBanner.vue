<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAppStore } from '../stores/app.js';
import Icon from '../primitives/Icon.vue';

const appStore = useAppStore();
const router = useRouter();

const context = computed(() => appStore.returnContext);

function handleReturn() {
  if (context.value) {
    const to = context.value.to;
    appStore.clearReturnContext();
    router.push(to);
  }
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
      class="flex items-center gap-1.5 hover:underline cursor-pointer focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
      @click="handleReturn"
    >
      <Icon name="chevron-left" :size="14" />
      <span>{{ context.title }}</span>
    </button>
    <button
      type="button"
      class="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
      aria-label="Dismiss return banner"
      @click="appStore.clearReturnContext()"
    >
      <Icon name="close" :size="12" />
    </button>
  </div>
</template>
