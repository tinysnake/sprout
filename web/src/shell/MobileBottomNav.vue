<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router';
import Icon from '../primitives/Icon.vue';

const route = useRoute();

function isActive(path: string): boolean {
  if (path === '/manage') {
    return route.path.startsWith('/manage');
  }
  return route.path.startsWith(path);
}
</script>

<template>
  <nav
    class="mobile-bottom-nav md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[var(--bg-surface)] border-t border-[var(--border-subtle)] px-2 py-1 flex items-center justify-around select-none shadow-lg"
    aria-label="Mobile Navigation"
  >
    <RouterLink
      to="/feed"
      data-nav="feed"
      class="flex flex-col items-center justify-center flex-1 py-1.5 min-h-[44px] rounded transition-colors focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
      :class="isActive('/feed') ? 'text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
      :aria-current="isActive('/feed') ? 'page' : undefined"
    >
      <Icon name="feed" :size="20" />
      <span class="text-[10px] mt-0.5">Feed</span>
    </RouterLink>

    <RouterLink
      to="/project"
      data-nav="project"
      class="flex flex-col items-center justify-center flex-1 py-1.5 min-h-[44px] rounded transition-colors focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
      :class="isActive('/project') ? 'text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
      :aria-current="isActive('/project') ? 'page' : undefined"
    >
      <Icon name="project" :size="20" />
      <span class="text-[10px] mt-0.5">Project</span>
    </RouterLink>

    <RouterLink
      to="/manage/environments"
      data-nav="manage"
      class="flex flex-col items-center justify-center flex-1 py-1.5 min-h-[44px] rounded transition-colors focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
      :class="isActive('/manage') ? 'text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
      :aria-current="isActive('/manage') ? 'page' : undefined"
    >
      <Icon name="manage" :size="20" />
      <span class="text-[10px] mt-0.5">Manage</span>
    </RouterLink>
  </nav>
</template>
