<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import Icon from '../primitives/Icon.vue';
import StatusDot from '../primitives/StatusDot.vue';

const route = useRoute();
const router = useRouter();

const isProject = computed(() => route.path.startsWith('/project'));
const isManage = computed(() => route.path.startsWith('/manage'));

function isProjectTabActive(tab: 'overview' | 'tasks' | 'chat'): boolean {
  if (tab === 'overview') {
    return route.path === '/project' || route.path === '/project/' || route.path === '/project/overview';
  }
  return route.path.startsWith(`/project/${tab}`);
}

function isManageTabActive(tab: 'environments' | 'agents' | 'usage' | 'settings'): boolean {
  return route.path.startsWith(`/manage/${tab}`);
}

function handleBackToFeed() {
  router.push('/feed');
}
</script>

<template>
  <nav
    class="mobile-bottom-nav md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[var(--bg-surface-glass)] backdrop-blur-md border-t border-[var(--border-subtle)] px-2 py-1 flex items-center justify-around select-none shadow-lg"
    aria-label="Mobile Navigation"
  >
    <!-- 1. Dynamic Project Sub-Navigation -->
    <template v-if="isProject">
      <!-- Back to Main Destinations Button -->
      <button
        type="button"
        class="flex flex-col items-center justify-center py-1 px-2 min-h-[44px] min-w-[44px] rounded border-r border-[var(--border-subtle)] mr-1 text-[var(--accent-primary)] hover:bg-[var(--accent-bg)] transition-colors cursor-pointer"
        title="Back to Feed"
        aria-label="Back to Main Destinations"
        @click="handleBackToFeed"
      >
        <Icon name="chevron-left" :size="18" />
        <span class="text-[9px] font-bold">Back</span>
      </button>

      <!-- Overview Tab -->
      <RouterLink
        to="/project/overview"
        class="flex flex-col items-center justify-center flex-1 py-1 min-h-[44px] rounded transition-colors"
        :class="isProjectTabActive('overview') ? 'text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
        :aria-current="isProjectTabActive('overview') ? 'page' : undefined"
      >
        <Icon name="overview" :size="18" />
        <span class="text-[10px] mt-0.5">Overview</span>
      </RouterLink>

      <!-- Tasks Tab -->
      <RouterLink
        to="/project/tasks"
        class="flex flex-col items-center justify-center flex-1 py-1 min-h-[44px] rounded transition-colors relative"
        :class="isProjectTabActive('tasks') ? 'text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
        :aria-current="isProjectTabActive('tasks') ? 'page' : undefined"
      >
        <Icon name="tasks" :size="18" />
        <span class="text-[10px] mt-0.5">Tasks</span>
        <span class="absolute top-1 right-1/4 px-1 py-0.1 text-[9px] font-bold rounded-full bg-[var(--accent-primary)] text-[var(--text-inverse)]">
          3
        </span>
      </RouterLink>

      <!-- Chat Tab -->
      <RouterLink
        to="/project/chat"
        class="flex flex-col items-center justify-center flex-1 py-1 min-h-[44px] rounded transition-colors"
        :class="isProjectTabActive('chat') ? 'text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
        :aria-current="isProjectTabActive('chat') ? 'page' : undefined"
      >
        <Icon name="chat" :size="18" />
        <span class="text-[10px] mt-0.5">Chat</span>
      </RouterLink>
    </template>

    <!-- 2. Dynamic Manage Sub-Navigation -->
    <template v-else-if="isManage">
      <!-- Back to Main Destinations Button -->
      <button
        type="button"
        class="flex flex-col items-center justify-center py-1 px-2 min-h-[44px] min-w-[44px] rounded border-r border-[var(--border-subtle)] mr-1 text-[var(--accent-primary)] hover:bg-[var(--accent-bg)] transition-colors cursor-pointer"
        title="Back to Feed"
        aria-label="Back to Main Destinations"
        @click="handleBackToFeed"
      >
        <Icon name="chevron-left" :size="18" />
        <span class="text-[9px] font-bold">Back</span>
      </button>

      <!-- Envs Tab -->
      <RouterLink
        to="/manage/environments"
        class="flex flex-col items-center justify-center flex-1 py-1 min-h-[44px] rounded transition-colors relative"
        :class="isManageTabActive('environments') ? 'text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
        :aria-current="isManageTabActive('environments') ? 'page' : undefined"
      >
        <Icon name="environments" :size="18" />
        <span class="text-[10px] mt-0.5">Envs</span>
        <StatusDot status="red" size="sm" class="absolute top-1.5 right-1/4" />
      </RouterLink>

      <!-- Agents Tab -->
      <RouterLink
        to="/manage/agents"
        class="flex flex-col items-center justify-center flex-1 py-1 min-h-[44px] rounded transition-colors relative"
        :class="isManageTabActive('agents') ? 'text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
        :aria-current="isManageTabActive('agents') ? 'page' : undefined"
      >
        <Icon name="agents" :size="18" />
        <span class="text-[10px] mt-0.5">Agents</span>
        <span class="absolute top-1 right-1/4 px-1 py-0.1 text-[9px] font-bold rounded-full bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-muted)]">
          4
        </span>
      </RouterLink>

      <!-- Usage Tab -->
      <RouterLink
        to="/manage/usage"
        class="flex flex-col items-center justify-center flex-1 py-1 min-h-[44px] rounded transition-colors"
        :class="isManageTabActive('usage') ? 'text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
        :aria-current="isManageTabActive('usage') ? 'page' : undefined"
      >
        <Icon name="usage" :size="18" />
        <span class="text-[10px] mt-0.5">Usage</span>
      </RouterLink>

      <!-- Settings Tab -->
      <RouterLink
        to="/manage/settings"
        class="flex flex-col items-center justify-center flex-1 py-1 min-h-[44px] rounded transition-colors"
        :class="isManageTabActive('settings') ? 'text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
        :aria-current="isManageTabActive('settings') ? 'page' : undefined"
      >
        <Icon name="settings" :size="18" />
        <span class="text-[10px] mt-0.5">Settings</span>
      </RouterLink>
    </template>

    <!-- 3. Primary Root Navigation (on /feed) -->
    <template v-else>
      <RouterLink
        to="/feed"
        data-nav="feed"
        class="flex flex-col items-center justify-center flex-1 py-1.5 min-h-[44px] rounded transition-colors relative"
        :class="route.path === '/feed' ? 'text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
        :aria-current="route.path === '/feed' ? 'page' : undefined"
      >
        <Icon name="feed" :size="20" />
        <span class="text-[10px] mt-0.5">Feed</span>
        <span class="absolute top-1 right-1/4 px-1 py-0.1 text-[9px] font-bold rounded-full bg-[var(--yellow-attention)] text-black">
          2
        </span>
      </RouterLink>

      <RouterLink
        to="/project"
        data-nav="project"
        class="flex flex-col items-center justify-center flex-1 py-1.5 min-h-[44px] rounded transition-colors relative"
        :class="isProject ? 'text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
        :aria-current="isProject ? 'page' : undefined"
      >
        <Icon name="project" :size="20" />
        <span class="text-[10px] mt-0.5">Project</span>
        <span class="absolute top-1 right-1/4 px-1 py-0.1 text-[9px] font-bold rounded-full bg-[var(--accent-primary)] text-[var(--text-inverse)]">
          3
        </span>
      </RouterLink>

      <RouterLink
        to="/manage/environments"
        data-nav="manage"
        class="flex flex-col items-center justify-center flex-1 py-1.5 min-h-[44px] rounded transition-colors relative"
        :class="isManage ? 'text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
        :aria-current="isManage ? 'page' : undefined"
      >
        <Icon name="manage" :size="20" />
        <span class="text-[10px] mt-0.5">Manage</span>
        <StatusDot status="red" size="sm" class="absolute top-1.5 right-1/4" />
      </RouterLink>
    </template>
  </nav>
</template>
