<script setup lang="ts">
import { computed } from 'vue';
import type { EnvironmentInstance } from '../types.js';
import StatusDot from '../../../primitives/StatusDot.vue';
import Badge from '../../../primitives/Badge.vue';
import Button from '../../../primitives/Button.vue';
import Icon from '../../../primitives/Icon.vue';
import { cn } from '../../../lib/utils.js';

const props = defineProps<{
  env: EnvironmentInstance;
  selected?: boolean;
}>();

const emit = defineEmits<{
  (e: 'select', id: string): void;
  (e: 'probe', id: string): void;
}>();

const platformIcon = computed(() => {
  if (props.env.platform === 'windows') return 'terminal';
  if (props.env.platform === 'container') return 'box';
  return 'desktop';
});

const trafficLightLabel = computed(() => {
  if (props.env.trafficLight === 'green') return 'READY';
  if (props.env.trafficLight === 'yellow') return 'ATTENTION';
  return 'ACTION REQUIRED';
});

const hasLease = computed(() => !!props.env.activeLeaseHolder);
const isRecovery = computed(() => props.env.workSafety === 'recovery' || !!props.env.leaseRecovery);

const holderContext = computed(() => {
  if (props.env.activeLeaseHolder) {
    const h = props.env.activeLeaseHolder;
    return `Holder Task #${h.holderId} in project ${h.projectId}${h.leadAgentName ? `, led by ${h.leadAgentName}` : ''}`;
  }
  return 'Holder none';
});

const recoveryContext = computed(() =>
  isRecovery.value ? 'Recovery required; Lease recovery' : 'Recovery clear'
);
const leaseContext = computed(() => (hasLease.value ? 'Lease held' : 'Lease clear'));

const contextId = computed(() => `env-master-context-${props.env.id}`);

const connectionBadgeVariant = computed(() => {
  if (props.env.connectionState === 'online') return 'success';
  if (props.env.connectionState === 'offline') return 'danger';
  return 'warning';
});

const connectionAgeLabel = computed(() => {
  if (props.env.connectionAgeSec >= 60) {
    return `(${Math.floor(props.env.connectionAgeSec / 60)}m)`;
  }
  return `(${props.env.connectionAgeSec}s)`;
});
</script>

<template>
  <div class="env-master-card-shell relative group flex flex-col gap-1 w-full">
    <button
      type="button"
      :class="cn(
        'env-master-card w-full text-left p-3.5 rounded-[var(--radius-md)] border transition-all cursor-pointer select-none relative',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]',
        selected
          ? 'active bg-[var(--bg-surface-elevated)] border-[var(--accent-primary)] ring-1 ring-[var(--accent-primary)] shadow-sm'
          : 'bg-[var(--bg-surface)] border-[var(--border-subtle)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-surface-elevated)]'
      )"
      :data-env="env.id"
      :aria-label="`Open Environment ${env.displayName}`"
      :aria-describedby="contextId"
      :aria-current="selected ? 'page' : undefined"
      @click="emit('select', env.id)"
    >
      <!-- Card Header -->
      <div class="env-master-card-header flex items-start justify-between gap-2 mb-2">
        <div class="flex items-center gap-2.5 min-w-0">
          <div
            class="flex items-center justify-center w-7 h-7 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-secondary)] shrink-0"
            :class="env.platform"
          >
            <Icon :name="platformIcon" :size="15" />
          </div>
          <div class="min-w-0 flex-1">
            <strong class="env-title block text-xs font-bold text-[var(--text-primary)] truncate">
              {{ env.displayName }}
            </strong>
            <span class="block text-[10px] text-[var(--text-muted)] font-mono truncate">
              Local user context · Enrolled identity
            </span>
          </div>
        </div>

        <StatusDot
          :status="env.trafficLight"
          size="sm"
          :title="trafficLightLabel"
          :aria-label="trafficLightLabel"
          class="mt-1 shrink-0"
        />
      </div>

      <!-- Decisive Reason Snippet (2-line clamp) -->
      <p class="env-reason-snippet text-xs text-[var(--text-secondary)] line-clamp-2 leading-relaxed mb-3">
        {{ env.trafficLightReason }}
      </p>

      <!-- Metrics Row -->
      <div class="env-card-metrics-row flex items-center justify-between gap-1 flex-wrap">
        <div class="flex items-center gap-1.5 flex-wrap">
          <Badge :variant="connectionBadgeVariant">
            {{ env.connectionState.toUpperCase() }} {{ connectionAgeLabel }}
          </Badge>

          <Badge :variant="env.protocolCompatibility === 'compatible' ? 'info' : 'danger'">
            {{ env.protocolVersion }} {{ env.protocolCompatibility.toUpperCase() }}
          </Badge>

          <Badge v-if="isRecovery" variant="danger">
            RECOVERY
          </Badge>
          <Badge v-else-if="hasLease" variant="purple">
            LEASE HELD
          </Badge>
          <Badge v-else variant="secondary">
            CLEAR
          </Badge>
        </div>
      </div>

      <!-- Screen reader hidden context -->
      <span :id="contextId" class="sr-only">
        Health: {{ trafficLightLabel }} ({{ env.trafficLight }}). Decisive reason: {{ env.trafficLightReason }}. Connection {{ env.connectionState }}; Protocol {{ env.protocolVersion }} {{ env.protocolCompatibility }}. {{ recoveryContext }}; {{ leaseContext }}; {{ holderContext }}.
      </span>
    </button>

    <!-- Quick Probe Action Button (matched to prototype absolute positioning) -->
    <button
      type="button"
      class="btn btn-ghost btn-xs quick-probe-btn text-[10px] h-6 px-2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      title="Request quick live probe"
      aria-label="Request quick live probe"
      @click.stop="emit('probe', env.id)"
    >
      <Icon name="lightning" :size="12" />
      <span>Probe</span>
    </button>
  </div>
</template>
