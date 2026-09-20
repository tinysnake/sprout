<script setup lang="ts">
/**
 * Phone bottom navigation.
 *
 * At a destination root it shows the three destinations. Inside Project or
 * Manage it becomes that destination's nested navigation plus a return control,
 * which is how one phone surface reaches every nested page without a separate
 * mode flag. Every entry is a `RouterLink`, so phone navigation is exactly as
 * URL-addressable as the sidebar.
 */
import { computed } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { buildNavigation, NAVIGATION_ROOT, type NavigationIndicators } from './navigation.js';
import Icon from '../primitives/Icon.vue';
import StatusDot from '../primitives/StatusDot.vue';

const props = withDefaults(
  defineProps<{
    indicators?: NavigationIndicators;
  }>(),
  { indicators: undefined }
);

const route = useRoute();
const router = useRouter();

const navigation = computed(() => buildNavigation(route, props.indicators));
const items = computed(() => (navigation.value.nested.length > 0 ? navigation.value.nested : navigation.value.primary));

function goToRootDestinations() {
  router.push(NAVIGATION_ROOT);
}
</script>

<template>
  <nav
    class="mobile-bottom-nav md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[var(--bg-surface-glass)] backdrop-blur-md border-t border-[var(--border-subtle)] px-2 py-1 flex items-center justify-around select-none shadow-lg"
    aria-label="Primary navigation"
  >
    <!-- Nested destinations: one return control plus that destination's tabs -->
    <button
      v-if="navigation.nested.length > 0"
      type="button"
      class="bottom-nav-item nav-back-btn flex flex-col items-center justify-center py-1 px-2 min-h-[44px] min-w-[44px] rounded border-r border-[var(--border-subtle)] mr-1 text-[var(--accent-primary)] hover:bg-[var(--accent-bg)] transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
      title="Back to main destinations"
      aria-label="Back to main destinations"
      @click="goToRootDestinations"
    >
      <Icon name="chevron-left" :size="18" />
      <span class="text-[9px] font-bold">Back</span>
    </button>

    <RouterLink
      v-for="item in items"
      :key="item.key"
      :to="item.to"
      class="bottom-nav-item flex flex-col items-center justify-center flex-1 py-1.5 min-h-[44px] rounded transition-colors relative focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
      :class="item.current ? 'text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'"
      :data-nav="item.key"
      :aria-current="item.current ? 'page' : undefined"
      :aria-label="item.count > 0 ? `${item.shortLabel}, ${item.count} pending` : item.shortLabel"
    >
      <Icon :name="item.icon" :size="20" />
      <span class="text-[10px] mt-0.5">{{ item.shortLabel }}</span>
      <span
        v-if="item.count > 0"
        class="bottom-nav-badge absolute top-1 right-1/4 px-1 py-0.1 text-[9px] font-bold rounded-full border"
        :class="
          item.indicatorStatus === 'yellow'
            ? 'bg-[var(--yellow-attention)] text-black border-transparent'
            : 'bg-[var(--accent-primary)] text-[var(--text-inverse)] border-transparent'
        "
        aria-hidden="true"
      >
        {{ item.count }}
      </span>
      <StatusDot
        v-else-if="item.alert"
        status="red"
        size="sm"
        class="bottom-nav-dot absolute top-1.5 right-1/4"
      />
    </RouterLink>
  </nav>
</template>
