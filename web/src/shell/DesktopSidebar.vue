<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { useAppStore } from '../stores/app.js';
import Icon from '../primitives/Icon.vue';
import OperatorPill from './OperatorPill.vue';

const route = useRoute();
const appStore = useAppStore();

const isDark = computed(() => appStore.theme === 'dark');

function isActive(path: string): boolean {
  if (path === '/manage/environments') {
    return route.path.startsWith('/manage/environments');
  }
  return route.path.startsWith(path);
}
</script>

<template>
  <aside class="desktop-sidebar hidden md:flex flex-col w-64 bg-[var(--bg-surface)] border-r border-[var(--border-subtle)] shrink-0 h-screen select-none">
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
      <!-- Operations -->
      <div>
        <div class="sidebar-section-label px-3 text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1.5">
          Operations
        </div>
        <div class="space-y-0.5">
          <RouterLink
            to="/feed"
            class="flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
            :class="isActive('/feed') ? 'bg-[var(--accent-bg)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-surface-elevated)] hover:text-[var(--text-primary)]'"
          >
            <Icon name="feed" :size="16" />
            <span>Feed & Attention</span>
          </RouterLink>
        </div>
      </div>

      <!-- Project -->
      <div>
        <div class="sidebar-section-label px-3 text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1.5">
          Project
        </div>
        <div class="space-y-0.5">
          <RouterLink
            to="/project/overview"
            class="flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
            :class="route.path === '/project' || route.path === '/project/' || route.path === '/project/overview' ? 'bg-[var(--accent-bg)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-surface-elevated)] hover:text-[var(--text-primary)]'"
          >
            <Icon name="overview" :size="16" />
            <span>Overview & Contract</span>
          </RouterLink>

          <RouterLink
            to="/project/tasks"
            class="flex items-center justify-between gap-2.5 px-3 py-2 rounded-md text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
            :class="route.path === '/project/tasks' ? 'bg-[var(--accent-bg)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-surface-elevated)] hover:text-[var(--text-primary)]'"
          >
            <div class="flex items-center gap-2.5">
              <Icon name="tasks" :size="16" />
              <span>Tasks & Leases</span>
            </div>
            <span class="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-[var(--accent-bg)] text-[var(--accent-primary)] border border-[var(--accent-border)]">
              3
            </span>
          </RouterLink>

          <RouterLink
            to="/project/chat"
            class="flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
            :class="route.path === '/project/chat' ? 'bg-[var(--accent-bg)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-surface-elevated)] hover:text-[var(--text-primary)]'"
          >
            <Icon name="chat" :size="16" />
            <span>Project Chat</span>
          </RouterLink>
        </div>
      </div>

      <!-- Manage -->
      <div>
        <div class="sidebar-section-label px-3 text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1.5">
          Manage
        </div>
        <div class="space-y-0.5">
          <RouterLink
            to="/manage/environments"
            class="flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
            :class="isActive('/manage/environments') ? 'bg-[var(--accent-bg)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-surface-elevated)] hover:text-[var(--text-primary)]'"
          >
            <Icon name="environments" :size="16" />
            <span>Environments</span>
          </RouterLink>

          <RouterLink
            to="/manage/agents"
            class="flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
            :class="isActive('/manage/agents') ? 'bg-[var(--accent-bg)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-surface-elevated)] hover:text-[var(--text-primary)]'"
          >
            <Icon name="agents" :size="16" />
            <span>Agents</span>
          </RouterLink>

          <RouterLink
            to="/manage/usage"
            class="flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
            :class="isActive('/manage/usage') ? 'bg-[var(--accent-bg)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-surface-elevated)] hover:text-[var(--text-primary)]'"
          >
            <Icon name="usage" :size="16" />
            <span>Usage & Costs</span>
          </RouterLink>

          <RouterLink
            to="/manage/settings"
            class="flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
            :class="isActive('/manage/settings') ? 'bg-[var(--accent-bg)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-surface-elevated)] hover:text-[var(--text-primary)]'"
          >
            <Icon name="settings" :size="16" />
            <span>Settings</span>
          </RouterLink>
        </div>
      </div>
    </nav>

    <!-- Sidebar Footer -->
    <div class="px-4 py-3 border-t border-[var(--border-subtle)] flex items-center justify-between gap-2">
      <OperatorPill />

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
    </div>
  </aside>
</template>
