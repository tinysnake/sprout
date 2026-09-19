<script setup lang="ts">
import { onMounted } from 'vue';
import { useAppStore } from '../stores/app.js';
import DesktopSidebar from './DesktopSidebar.vue';
import MobileBottomNav from './MobileBottomNav.vue';
import ReturnContextBanner from './ReturnContextBanner.vue';
import OperatorPill from './OperatorPill.vue';
import Icon from '../primitives/Icon.vue';

const appStore = useAppStore();

onMounted(() => {
  appStore.initTheme();
});
</script>

<template>
  <div class="sprout-app-shell flex h-screen w-full bg-[var(--bg-app)] text-[var(--text-primary)] overflow-hidden font-sans">
    <!-- Desktop Left Sidebar Navigation -->
    <DesktopSidebar />

    <!-- Main Application Canvas -->
    <div class="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
      <!-- Deep-link Return Context Banner -->
      <ReturnContextBanner />

      <!-- Mobile Top Brand & Status Bar (visible only on small screens) -->
      <header class="md:hidden flex items-center justify-between px-4 py-2.5 bg-[var(--bg-surface)] border-b border-[var(--border-subtle)] shrink-0 select-none">
        <div class="flex items-center gap-2">
          <div class="p-1 rounded bg-[var(--accent-bg)] text-[var(--accent-primary)]">
            <Icon name="sprout" :size="16" />
          </div>
          <span class="font-bold text-xs text-[var(--text-primary)]">Sprout</span>
        </div>
        <div class="flex items-center gap-2">
          <OperatorPill />
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

      <!-- Main Scrollable Content Area -->
      <main class="flex-1 overflow-y-auto pb-16 md:pb-0">
        <slot />
      </main>
    </div>

    <!-- Mobile Sticky Bottom Navigation -->
    <MobileBottomNav />
  </div>
</template>
