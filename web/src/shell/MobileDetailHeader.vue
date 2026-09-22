<script setup lang="ts">
/**
 * The phone drill-down header for a detail record.
 *
 * It replaces the destination header while one record is open, giving the
 * operator a labelled return control and the record's own identity and status.
 * The destination chooses the label and target, so the same component serves
 * every master/detail destination without knowing their domain.
 */
import { useRouter, type RouteLocationRaw } from 'vue-router';
import StatusDot from '../primitives/StatusDot.vue';
import Icon from '../primitives/Icon.vue';

export interface MobileDetailHeaderProps {
  title: string;
  backTo: RouteLocationRaw;
  backLabel?: string;
  backControlId?: string;
  trafficLight?: 'green' | 'yellow' | 'red' | 'neutral';
  class?: string;
}

const props = withDefaults(defineProps<MobileDetailHeaderProps>(), {
  backLabel: 'Back',
  backControlId: 'btn-mobile-detail-back',
  trafficLight: 'neutral',
  class: '',
});

const router = useRouter();

function handleBack() {
  router.push(props.backTo);
}
</script>

<template>
  <header
    class="mobile-detail-nav-header md:hidden sticky top-0 z-30 flex items-center justify-between px-3 py-2.5 bg-[var(--bg-surface)] border-b border-[var(--border-subtle)]"
    :class="props.class"
  >
    <button
      :id="backControlId"
      type="button"
      class="back-to-list-btn flex items-center gap-1 px-2.5 py-1.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-xs font-semibold text-[var(--text-primary)] cursor-pointer min-h-[44px] focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
      :title="backLabel"
      :aria-label="backLabel"
      @click="handleBack"
    >
      <Icon name="chevron-left" :size="14" />
      <span class="back-btn-text">{{ backLabel }}</span>
    </button>

    <div class="mobile-detail-title-wrap flex items-center gap-2 max-w-[60%] truncate">
      <StatusDot :status="trafficLight" size="sm" />
      <span class="mobile-detail-title-text text-xs font-bold text-[var(--text-primary)] truncate">
        {{ title }}
      </span>
    </div>

    <div class="w-8" aria-hidden="true" />
  </header>
</template>
