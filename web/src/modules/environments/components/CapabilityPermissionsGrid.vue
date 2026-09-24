<script setup lang="ts">
import { computed } from 'vue';
import type { CapabilityKey, CapabilityPermissions } from '../types.js';
import Button from '../../../primitives/Button.vue';

const props = defineProps<{
  permissions: CapabilityPermissions;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle', cap: CapabilityKey): void;
}>();

function capabilityLabel(cap: string): string {
  if (cap === 'fileReadWrite') return 'File R/W';
  if (cap === 'processExecution') return 'Process Exec';
  if (cap === 'networkAccess') return 'Network';
  if (cap === 'guiAutomation') return 'GUI Auto';
  return cap;
}

/**
 * The rows the enrollment actually declared. The prototype's four canonical
 * capabilities keep their representative order; any further declared capability
 * follows them. A capability with no stored permission renders honestly as
 * Refused, because an ungranted permission grants nothing.
 */
const capabilityRows = computed(() => {
  const canonical = ['fileReadWrite', 'processExecution', 'networkAccess', 'guiAutomation'].filter(
    (cap) => cap in props.permissions,
  );
  const declared = Object.keys(props.permissions).filter((cap) => !canonical.includes(cap));
  return [...canonical, ...declared].map((cap) => ({
    cap,
    label: capabilityLabel(cap),
    allowed: props.permissions[cap] === true,
  }));
});
</script>

<template>
  <div class="capability-permissions-box p-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <strong class="text-xs uppercase tracking-wider text-[var(--text-muted)] font-bold">
        5. Capability Permissions (Host-Enforced, Web-Configured)
      </strong>
    </div>

    <div class="permissions-2x2-grid grid grid-cols-2 sm:grid-cols-4 gap-2">
      <div
        v-for="row in capabilityRows"
        :key="row.cap"
        class="permission-toggle-item p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col justify-between gap-1.5"
      >
        <span class="permission-item-label text-xs font-semibold text-[var(--text-primary)]">{{ row.label }}</span>
        <Button
          size="xs"
          :variant="row.allowed ? 'primary' : 'secondary'"
          class="perm-toggle-btn w-full text-[10px] h-6"
          :class="row.allowed ? 'btn-success bg-[var(--green-ready)] hover:bg-[var(--green-ready)]/90 text-white' : ''"
          :disabled="disabled"
          :data-cap="row.cap"
          @click="emit('toggle', row.cap)"
        >
          {{ row.allowed ? 'Granted' : 'Refused' }}
        </Button>
      </div>
    </div>
  </div>
</template>
