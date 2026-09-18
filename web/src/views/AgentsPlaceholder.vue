<script setup lang="ts">
import SubNav, { type SubNavItem } from '../primitives/SubNav.vue';
import EmptyState from '../primitives/EmptyState.vue';

const manageSubNavItems: SubNavItem[] = [
  { to: '/manage/environments', label: 'Environments', icon: 'environments' },
  { to: '/manage/agents', label: 'Agents', icon: 'agents' },
  { to: '/manage/usage', label: 'Usage & Costs', icon: 'usage' },
  { to: '/manage/settings', label: 'Settings', icon: 'settings' },
];
</script>

<template>
  <div class="flex flex-col h-full bg-[var(--bg-app)]">
    <SubNav :items="manageSubNavItems" />
    <div class="p-6 max-w-4xl mx-auto flex-1 flex flex-col justify-center">
      <EmptyState
        icon="agents"
        title="Manage / Agents"
        description="Agent profiles, standing instructions, ordered work options, and compatibility checks are scheduled for downstream migration."
      />
    </div>
  </div>
</template>
