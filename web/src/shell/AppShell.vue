<script setup lang="ts">
/**
 * The application Shell: desktop sidebar, phone header, the main content region,
 * the phone bottom navigation, and the one polite live region.
 *
 * It is the only component that owns the page frame and the only one that owns
 * an `aria-live` region. Destinations render inside the main region and announce
 * context changes through the shared channel, so streamed state stays readable
 * instead of being interleaved across several live regions.
 */
import { computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useAppStore } from '../stores/app.js';
import { useShellConnection } from './use-shell-connection.js';
import { buildNavigation, type NavigationIndicators } from './navigation.js';
import { useAnnouncer, useAnnouncerMessage } from '../primitives/announcer.js';
import DesktopSidebar from './DesktopSidebar.vue';
import MobileBottomNav from './MobileBottomNav.vue';
import ReturnContextBanner from './ReturnContextBanner.vue';
import Icon from '../primitives/Icon.vue';
import StatusDot from '../primitives/StatusDot.vue';
import SkipToContent from '../primitives/SkipToContent.vue';

const props = withDefaults(
  defineProps<{
    indicators?: NavigationIndicators;
  }>(),
  { indicators: undefined }
);

const appStore = useAppStore();
const route = useRoute();
const connection = useShellConnection();

const { announcer, message } = { announcer: useAnnouncer(), message: useAnnouncerMessage() };

const presentation = computed(() => connection.presentation.value);
const navigation = computed(() => buildNavigation(route, props.indicators));

// Connection changes are the one shell fact the operator must not be able to
// miss, so they are announced through the shared region rather than a second
// live region beside the status pill.
watch(presentation, (next, previous) => {
  if (previous === undefined || next.label !== previous.label) announcer.announce(next.announce);
});

onMounted(() => {
  appStore.initTheme();
});
</script>

<template>
  <div class="sprout-app-shell flex h-screen w-full bg-[var(--bg-app)] text-[var(--text-primary)] overflow-hidden font-sans">
    <!-- The single live region for the whole product. -->
    <div
      class="shell-announcer sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="shell-announcer"
    >
      {{ message }}
    </div>

    <SkipToContent />

    <DesktopSidebar :indicators="indicators" />

    <div class="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
      <ReturnContextBanner />

      <!-- Phone brand and connection state (visible only below md) -->
      <header class="md:hidden flex items-center justify-between px-4 py-2.5 bg-[var(--bg-surface)] border-b border-[var(--border-subtle)] shrink-0 select-none">
        <div class="flex items-center gap-2">
          <div class="p-1 rounded bg-[var(--accent-bg)] text-[var(--accent-primary)]">
            <Icon name="sprout" :size="16" />
          </div>
          <span class="font-bold text-xs text-[var(--text-primary)]">Sprout</span>
        </div>
        <div class="flex items-center gap-2">
          <div
            class="operator-pill flex items-center gap-1.5 px-2 py-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] text-[10px] font-mono text-[var(--text-secondary)]"
            :title="presentation.announce"
          >
            <StatusDot :status="presentation.status" size="sm" />
            <span>{{ presentation.label }}</span>
          </div>
          <button
            type="button"
            class="p-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
            :title="appStore.theme === 'dark' ? 'Switch to Light' : 'Switch to Dark'"
            :aria-label="appStore.theme === 'dark' ? 'Switch to Light' : 'Switch to Dark'"
            @click="appStore.toggleTheme()"
          >
            <Icon :name="appStore.theme === 'dark' ? 'sun' : 'moon'" :size="14" />
          </button>
        </div>
      </header>

      <!-- Warn before acting on facts that may no longer be live. -->
      <div
        v-if="!presentation.controlAvailable"
        class="shell-connection-banner flex items-center gap-2 px-4 py-1.5 border-b text-[11px] font-semibold"
        :class="
          presentation.status === 'red'
            ? 'bg-[var(--red-action-bg)] border-[var(--red-action-border)] text-[var(--red-action)]'
            : 'bg-[var(--yellow-attention-bg)] border-[var(--yellow-attention-border)] text-[var(--yellow-attention)]'
        "
      >
        <Icon name="warning" :size="13" />
        <span data-testid="shell-connection-notice">{{ presentation.announce }}</span>
      </div>

      <main
        id="sprout-main-content"
        tabindex="-1"
        class="flex-1 overflow-y-auto pb-16 md:pb-0 focus-visible:outline-none"
      >
        <slot />
      </main>
    </div>

    <MobileBottomNav :indicators="indicators" />
  </div>
</template>
