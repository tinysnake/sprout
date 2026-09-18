<script setup lang="ts">
import type { ForcedReleaseRecord } from '../types.js';
import StatusPill from '../../../primitives/StatusPill.vue';

defineProps<{
  record: ForcedReleaseRecord;
}>();
</script>

<template>
  <div class="forced-release-audit-box p-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] text-xs flex flex-col gap-1">
    <div class="flex items-center justify-between">
      <strong class="text-xs font-bold text-[var(--text-primary)]">Durable Forced Release Audit Event</strong>
      <StatusPill status="green" class="text-[9px]">
        REASSIGNABLE
      </StatusPill>
    </div>
    <div class="text-[11px] text-[var(--text-secondary)]">
      Authorized by: <strong>{{ record.actor }}</strong> · Time: <strong>{{ record.timestamp }}</strong>
    </div>
    <div class="text-[11px] text-[var(--text-secondary)] italic">
      Reason: "{{ record.reason }}"
    </div>
  </div>
</template>
