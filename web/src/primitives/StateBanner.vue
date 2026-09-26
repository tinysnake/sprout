<script setup lang="ts">
import { computed } from 'vue';
import { cn } from '../lib/utils.js';
import StatusDot from './StatusDot.vue';
import StatusPill from './StatusPill.vue';
import Icon from './Icon.vue';

export interface StateBannerProps {
  trafficLight: 'green' | 'yellow' | 'red';
  title?: string;
  reason: string;
  platform?: string;
  protocolMismatchDetail?: string;
  isArchived?: boolean;
  isPending?: boolean;
  class?: string;
}

const props = withDefaults(defineProps<StateBannerProps>(), {
  title: '',
  platform: '',
  isArchived: false,
  isPending: false,
  class: '',
});

const isGreen = computed(() => props.trafficLight === 'green');
const isYellow = computed(() => props.trafficLight === 'yellow');

const computedTitle = computed(() => {
  if (props.title) return props.title;
  if (props.isPending) return 'Enrollment Pending';
  if (props.isArchived) return 'Archived Instance';
  if (isGreen.value) return 'Green: Ready';
  if (isYellow.value) return 'Yellow: Attention / Degraded';
  return 'Red: Unavailable / Action Required';
});

const bannerStyles = computed(() => {
  if (props.isPending) {
    return {
      background: 'var(--bg-surface-elevated)',
      borderColor: 'var(--border-subtle)',
    };
  }
  if (isGreen.value) {
    return {
      background: 'var(--green-ready-bg)',
      borderColor: 'var(--green-ready)',
    };
  }
  if (isYellow.value) {
    return {
      background: 'var(--yellow-attention-bg)',
      borderColor: 'var(--yellow-attention)',
    };
  }
  return {
    background: 'var(--red-action-bg)',
    borderColor: 'var(--red-action)',
  };
});
</script>

<template>
  <div
    class="env-traffic-light-banner flex flex-col gap-2 p-3.5 rounded-[var(--radius-md)] border text-[var(--text-primary)] shadow-xs transition-colors"
    :style="bannerStyles"
    :class="props.class"
  >
    <div class="flex items-center justify-between flex-wrap gap-2">
      <div class="flex items-center gap-2">
        <StatusDot :status="trafficLight" :label="isPending ? 'PENDING' : undefined" size="lg" />
        <strong class="text-sm sm:text-base font-bold text-[var(--text-primary)]">
          {{ computedTitle }}
        </strong>
      </div>
      <div class="flex items-center gap-1.5">
        <StatusPill v-if="platform" :status="isPending ? 'neutral' : trafficLight">
          {{ platform.toUpperCase() }}
        </StatusPill>
        <StatusPill v-if="isPending" status="neutral" class="pending-enrollment-pill">
          <span class="inline-flex items-center gap-1"><Icon name="clock" :size="12" />PENDING</span>
        </StatusPill>
        <StatusPill status="neutral">
          TLS/WSS OVERLAY
        </StatusPill>
      </div>
    </div>

    <div class="env-decisive-reason min-h-8 text-xs sm:text-sm font-semibold text-[var(--text-primary)] leading-snug">
      Decisive Fact: {{ reason }}
    </div>

    <div
      v-if="protocolMismatchDetail"
      class="protocol-mismatch-guidance mt-0.5 p-2 rounded-[var(--radius-xs)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[11px] text-[var(--red-action)] font-medium"
    >
      <strong>Version Mismatch Guidance:</strong> {{ protocolMismatchDetail }}
    </div>
  </div>
</template>
