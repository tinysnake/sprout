<script setup lang="ts">
import type { ActiveLeaseHolder } from '../types.js';
import StatusPill from '../../../primitives/StatusPill.vue';
import Icon from '../../../primitives/Icon.vue';

defineProps<{
  lease: ActiveLeaseHolder;
}>();
</script>

<template>
  <div class="active-lease-box p-3 rounded-[var(--radius-sm)] border border-[var(--purple-agent)] bg-[var(--purple-agent-bg)] flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <strong class="text-xs font-bold text-[var(--text-primary)] flex items-center gap-1.5">
        <Icon name="shield" :size="15" />
        <span>Task-Held Lease Active</span>
      </strong>
      <StatusPill status="purple" class="text-[10px]">
        EXCLUSIVE LEASE
      </StatusPill>
    </div>

    <div class="text-xs text-[var(--text-primary)]">
      Task <strong>#{{ lease.holderId }}</strong> ({{ lease.taskTitle ?? 'Active Task' }}) held by <strong>@{{ lease.leadAgentName ?? 'Lead' }}</strong>
    </div>

    <div class="text-[11px] text-[var(--text-secondary)] font-mono">
      Acquired: <strong>{{ lease.acquiredAt }}</strong> · Project: <code>{{ lease.projectId }}</code>
    </div>

    <div class="text-[10px] text-[var(--text-muted)] pt-1.5 border-t border-[var(--purple-agent-border)]">
      Safety Guarantee: Lease is held continuously from Task begin to end across runs, idle gaps, and human validation. No automatic timeout.
    </div>
  </div>
</template>
