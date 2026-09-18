<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { cn } from '../lib/utils.js';
import Icon from './Icon.vue';

export interface SubNavItem {
  to: string;
  label: string;
  icon?: string;
  badge?: number | string;
}

export interface SubNavProps {
  items: SubNavItem[];
  class?: string;
}

const props = withDefaults(defineProps<SubNavProps>(), {
  class: '',
});

const route = useRoute();

const classes = computed(() => {
  return cn(
    'sub-nav-tabs flex items-center gap-1 border-b border-[var(--border-subtle)] px-4 bg-[var(--bg-surface)] overflow-x-auto',
    props.class
  );
});

function isActive(to: string): boolean {
  return route.path.startsWith(to);
}
</script>

<template>
  <nav :class="classes" role="tablist" aria-label="Sub navigation">
    <RouterLink
      v-for="item in items"
      :key="item.to"
      :to="item.to"
      role="tab"
      :aria-selected="isActive(item.to)"
      :class="cn(
        'flex items-center gap-2 py-2.5 px-3 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap min-h-[40px]',
        'focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]',
        isActive(item.to)
          ? 'border-[var(--accent-primary)] text-[var(--accent-primary)]'
          : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)]'
      )"
    >
      <Icon v-if="item.icon" :name="item.icon" :size="14" />
      <span>{{ item.label }}</span>
      <span
        v-if="item.badge !== undefined"
        class="ml-1 px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-[var(--bg-surface-elevated)] text-[var(--text-muted)]"
      >
        {{ item.badge }}
      </span>
    </RouterLink>
  </nav>
</template>
