<script setup lang="ts">
import type { CapabilityKey, CapabilityPermissions } from '../types.js';
import Button from '../../../primitives/Button.vue';

defineProps<{
  permissions: CapabilityPermissions;
}>();

const emit = defineEmits<{
  (e: 'toggle', cap: CapabilityKey): void;
}>();
</script>

<template>
  <div class="capability-permissions-box p-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <strong class="text-xs uppercase tracking-wider text-[var(--text-muted)] font-bold">
        5. Capability Permissions (Host-Enforced, Web-Configured)
      </strong>
      <span class="text-[10px] text-[var(--text-muted)]">ADR-0008</span>
    </div>

    <div class="permissions-2x2-grid grid grid-cols-2 sm:grid-cols-4 gap-2">
      <!-- File Read/Write -->
      <div class="permission-toggle-item p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col justify-between gap-1.5">
        <span class="permission-item-label text-xs font-semibold text-[var(--text-primary)]">File R/W</span>
        <Button
          size="xs"
          :variant="permissions.fileReadWrite ? 'primary' : 'secondary'"
          class="perm-toggle-btn w-full text-[10px] h-6"
          :class="permissions.fileReadWrite ? 'btn-success bg-[var(--green-ready)] hover:bg-[var(--green-ready)]/90 text-white' : ''"
          data-cap="fileReadWrite"
          @click="emit('toggle', 'fileReadWrite')"
        >
          {{ permissions.fileReadWrite ? 'Granted' : 'Refused' }}
        </Button>
      </div>

      <!-- Process Execution -->
      <div class="permission-toggle-item p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col justify-between gap-1.5">
        <span class="permission-item-label text-xs font-semibold text-[var(--text-primary)]">Process Exec</span>
        <Button
          size="xs"
          :variant="permissions.processExecution ? 'primary' : 'secondary'"
          class="perm-toggle-btn w-full text-[10px] h-6"
          :class="permissions.processExecution ? 'btn-success bg-[var(--green-ready)] hover:bg-[var(--green-ready)]/90 text-white' : ''"
          data-cap="processExecution"
          @click="emit('toggle', 'processExecution')"
        >
          {{ permissions.processExecution ? 'Granted' : 'Refused' }}
        </Button>
      </div>

      <!-- Network Access -->
      <div class="permission-toggle-item p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col justify-between gap-1.5">
        <span class="permission-item-label text-xs font-semibold text-[var(--text-primary)]">Network</span>
        <Button
          size="xs"
          :variant="permissions.networkAccess ? 'primary' : 'secondary'"
          class="perm-toggle-btn w-full text-[10px] h-6"
          :class="permissions.networkAccess ? 'btn-success bg-[var(--green-ready)] hover:bg-[var(--green-ready)]/90 text-white' : ''"
          data-cap="networkAccess"
          @click="emit('toggle', 'networkAccess')"
        >
          {{ permissions.networkAccess ? 'Granted' : 'Refused' }}
        </Button>
      </div>

      <!-- GUI Automation -->
      <div class="permission-toggle-item p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col justify-between gap-1.5">
        <span class="permission-item-label text-xs font-semibold text-[var(--text-primary)]">GUI Auto</span>
        <Button
          size="xs"
          :variant="permissions.guiAutomation ? 'primary' : 'secondary'"
          class="perm-toggle-btn w-full text-[10px] h-6"
          :class="permissions.guiAutomation ? 'btn-success bg-[var(--green-ready)] hover:bg-[var(--green-ready)]/90 text-white' : ''"
          data-cap="guiAutomation"
          @click="emit('toggle', 'guiAutomation')"
        >
          {{ permissions.guiAutomation ? 'Granted' : 'Refused' }}
        </Button>
      </div>
    </div>
  </div>
</template>
