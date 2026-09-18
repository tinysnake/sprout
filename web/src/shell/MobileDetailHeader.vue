<script setup lang="ts">
import { useRouter } from 'vue-router';
import StatusDot from '../primitives/StatusDot.vue';
import Icon from '../primitives/Icon.vue';

export interface MobileDetailHeaderProps {
  title: string;
  trafficLight?: 'green' | 'yellow' | 'red';
  backTo?: string;
  class?: string;
}

const props = withDefaults(defineProps<MobileDetailHeaderProps>(), {
  trafficLight: 'neutral' as any,
  backTo: '/manage/environments',
  class: '',
});

const router = useRouter();

function handleBack() {
  if (props.backTo) {
    router.push(props.backTo);
  } else {
    router.back();
  }
}
</script>

<template>
  <header
    class="mobile-detail-nav-header md:hidden sticky top-0 z-30 flex items-center justify-between px-3 py-2.5 bg-[var(--bg-surface)] border-b border-[var(--border-subtle)]"
    :class="props.class"
  >
    <button
      id="btn-back-to-envs"
      type="button"
      class="back-to-envs-btn flex items-center gap-1 px-2.5 py-1.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-xs font-semibold text-[var(--text-primary)] cursor-pointer min-h-[36px] focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
      title="Back to Environments"
      aria-label="Back to environments list"
      @click="handleBack"
    >
      <Icon name="chevron-left" :size="14" />
      <span class="back-btn-text">Back</span>
    </button>

    <div class="mobile-detail-title-wrap flex items-center gap-2 max-w-[200px] truncate">
      <StatusDot v-if="trafficLight" :status="trafficLight" size="sm" />
      <span class="mobile-detail-title-text text-xs font-bold text-[var(--text-primary)] truncate">
        {{ title }}
      </span>
    </div>

    <div class="w-8" aria-hidden="true" />
  </header>
</template>
