<script setup lang="ts">
/**
 * Desktop sidebar: the three destinations grouped as Operations, Project, and
 * Manage. Every entry is a `RouterLink`, so navigation is URL-addressable and
 * browser history, refresh, and a pasted deep link all agree with the sidebar.
 *
 * The grouping, section labels, and current-destination marking follow the
 * retained structural baseline; the item model comes from one shared
 * `buildNavigation` result so this and the phone navigation cannot drift.
 */
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { buildNavigation, type NavigationIndicators } from './navigation.js';
import { useShellConnection } from './use-shell-connection.js';
import { useAppStore } from '../stores/app.js';
import Icon from '../primitives/Icon.vue';
import StatusDot from '../primitives/StatusDot.vue';

const props = withDefaults(
  defineProps<{
    indicators?: NavigationIndicators;
  }>(),
  { indicators: undefined }
);

const route = useRoute();
const appStore = useAppStore();
const connection = useShellConnection();

const navigation = computed(() => buildNavigation(route, props.indicators));
const isDark = computed(() => appStore.theme === 'dark');
const presentation = computed(() => connection.presentation.value);
</script>

<template>
  <aside
    class="desktop-sidebar hidden md:flex flex-col w-64 bg-[var(--bg-surface)] border-r border-[var(--border-subtle)] shrink-0 h-screen select-none"
    aria-label="Primary"
  >
    <!-- Brand Header -->
    <div class="flex items-center gap-2.5 px-5 py-4 border-b border-[var(--border-subtle)]">
      <div class="p-1.5 rounded-md bg-[var(--accent-bg)] border border-[var(--accent-border)] text-[var(--accent-primary)]">
        <Icon name="sprout" :size="20" />
      </div>
      <div>
        <h1 class="font-bold text-sm text-[var(--text-primary)] leading-none">Sprout</h1>
        <span class="text-[10px] text-[var(--text-muted)] font-mono">Local Operator</span>
      </div>
    </div>

    <!-- Navigation Sections -->
    <nav class="flex-1 overflow-y-auto px-3 py-4 space-y-5" aria-label="Main Navigation">
      <div v-for="section in navigation.sections" :key="section.label">
        <div class="sidebar-section-label px-3 text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1.5">
          {{ section.label }}
        </div>
        <div class="space-y-0.5">
          <RouterLink
            v-for="item in section.items"
            :key="item.key"
            :to="item.to"
            class="sidebar-nav-item flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
            :class="
              item.current
                ? 'bg-[var(--accent-bg)] text-[var(--accent-primary)] font-bold'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-surface-elevated)] hover:text-[var(--text-primary)]'
            "
            :data-nav="item.key"
            :aria-current="item.current ? 'page' : undefined"
          >
            <Icon :name="item.icon" :size="16" />
            <span class="flex-1 truncate">{{ item.label }}</span>
            <span
              v-if="item.count > 0"
              class="px-1.5 py-0.2 rounded-full text-[10px] font-bold border"
              :class="
                item.indicatorStatus === 'blue'
                  ? 'bg-[var(--accent-bg)] text-[var(--accent-primary)] border-[var(--accent-border)]'
                  : item.indicatorStatus === 'yellow'
                    ? 'bg-[var(--yellow-attention-bg)] text-[var(--yellow-attention)] border-[var(--yellow-attention-border)]'
                    : 'bg-[var(--red-action-bg)] text-[var(--red-action)] border-[var(--red-action-border)]'
              "
              :aria-label="`${item.count} ${item.label}`"
            >
              {{ item.count }}
            </span>
            <StatusDot
              v-else-if="item.alert"
              status="red"
              size="sm"
              :class="'sidebar-nav-alert'"
            />
          </RouterLink>
        </div>
      </div>
    </nav>

    <!-- Sidebar Footer -->
    <div class="px-4 py-3 border-t border-[var(--border-subtle)] flex flex-col gap-2">
      <div
        class="operator-pill flex items-center gap-2 px-2.5 py-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] text-[11px] text-[var(--text-secondary)]"
        :title="presentation.announce"
      >
        <StatusDot :status="presentation.status" size="sm" />
        <span class="font-medium font-mono truncate">{{ presentation.label }}</span>
      </div>

      <div class="flex items-center justify-between gap-2">
        <button
          id="top-theme-btn"
          type="button"
          class="p-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] cursor-pointer focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
          :title="isDark ? 'Switch to Light Theme' : 'Switch to Dark Theme'"
          :aria-label="isDark ? 'Switch to Light Theme' : 'Switch to Dark Theme'"
          @click="appStore.toggleTheme()"
        >
          <Icon :name="isDark ? 'sun' : 'moon'" :size="14" />
        </button>
        <span class="text-[10px] text-[var(--text-muted)] font-mono truncate">{{ presentation.label }}</span>
      </div>
    </div>
  </aside>
</template>
