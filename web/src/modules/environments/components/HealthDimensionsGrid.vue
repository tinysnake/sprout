<script setup lang="ts">
import type { EnvironmentInstance } from '../types.js';
import Badge from '../../../primitives/Badge.vue';
import Button from '../../../primitives/Button.vue';

defineProps<{
  env: EnvironmentInstance;
}>();

const emit = defineEmits<{
  (e: 'approve', id: string): void;
}>();
</script>

<template>
  <div class="health-dimensions-box p-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <strong class="text-xs uppercase tracking-wider text-[var(--text-muted)] font-bold">
        1–4. Core Operational Status & Safety Dimensions
      </strong>
      <span class="text-[10px] text-[var(--text-muted)]">ADR-0008 & ADR-0009</span>
    </div>

    <div class="dimensions-2x2-grid grid grid-cols-1 sm:grid-cols-2 gap-2">
      <!-- 1. Enrollment -->
      <div class="dimension-item p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col justify-between gap-1.5">
        <div>
          <span class="dimension-item-label block text-xs font-semibold text-[var(--text-primary)]">1. Enrollment</span>
          <span class="dimension-item-sub block text-[10px] text-[var(--text-muted)] font-mono">Opaque identity withheld</span>
        </div>
        <div class="dimension-item-action flex items-center justify-between gap-1 mt-1">
          <Badge :variant="env.enrollmentStatus === 'approved' ? 'success' : env.enrollmentStatus === 'pending' ? 'warning' : 'danger'">
            {{ env.enrollmentStatus.toUpperCase() }}
          </Badge>
          <Button
            v-if="env.enrollmentStatus === 'pending'"
            variant="primary"
            size="xs"
            class="approve-enroll-btn text-[10px] h-6 px-2"
            @click="emit('approve', env.id)"
          >
            Approve
          </Button>
        </div>
      </div>

      <!-- 2. Connection -->
      <div class="dimension-item p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col justify-between gap-1.5">
        <div>
          <span class="dimension-item-label block text-xs font-semibold text-[var(--text-primary)]">2. Connection</span>
          <span class="dimension-item-sub block text-[10px] text-[var(--text-muted)] font-mono">Confirmed: {{ env.lastConfirmedTime }}</span>
        </div>
        <div class="dimension-item-action flex items-center mt-1">
          <Badge :variant="env.connectionState === 'online' ? 'success' : env.connectionState === 'offline' ? 'danger' : 'warning'">
            {{ env.connectionState.toUpperCase() }}
          </Badge>
        </div>
      </div>

      <!-- 3. Protocol Compatibility -->
      <div class="dimension-item p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col justify-between gap-1.5">
        <div>
          <span class="dimension-item-label block text-xs font-semibold text-[var(--text-primary)]">3. Protocol</span>
          <span class="dimension-item-sub block text-[10px] text-[var(--text-muted)] font-mono">Version: {{ env.protocolVersion }} (Req: v2.x)</span>
        </div>
        <div class="dimension-item-action flex items-center mt-1">
          <Badge :variant="env.protocolCompatibility === 'compatible' ? 'success' : 'danger'">
            {{ env.protocolCompatibility.toUpperCase() }}
          </Badge>
        </div>
      </div>

      <!-- 4. Work Safety & Lease -->
      <div class="dimension-item p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col justify-between gap-1.5">
        <div>
          <span class="dimension-item-label block text-xs font-semibold text-[var(--text-primary)]">4. Work Safety</span>
          <span class="dimension-item-sub block text-[10px] text-[var(--text-muted)] font-mono truncate">
            {{ env.activeLeaseHolder ? `Task #${env.activeLeaseHolder.holderId}` : 'No active lease' }}
          </span>
        </div>
        <div class="dimension-item-action flex items-center mt-1">
          <Badge :variant="env.workSafety === 'clear' ? 'success' : env.workSafety === 'reconciling' ? 'warning' : 'danger'">
            {{ env.workSafety.toUpperCase() }}
          </Badge>
        </div>
      </div>
    </div>
  </div>
</template>
