<script setup lang="ts">
/**
 * Operator connection state, shown identically on phone and desktop.
 *
 * It reads the one shell connection presentation, so the label, the status
 * colour, and the meaning for control actions cannot disagree between surfaces.
 * Change announcements go through the single shared live region, so this pill is
 * status text rather than another live region.
 */
import { computed } from 'vue';
import { useShellConnection } from './use-shell-connection.js';
import StatusDot from '../primitives/StatusDot.vue';

withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

const connection = useShellConnection();
const presentation = computed(() => connection.presentation.value);
</script>

<template>
  <div
    class="operator-pill flex items-center gap-2 px-2.5 py-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] text-[11px] text-[var(--text-secondary)] select-none"
    :title="presentation.announce"
    :aria-label="`Operator connection: ${presentation.label}`"
  >
    <StatusDot :status="presentation.status" size="sm" />
    <span class="font-medium font-mono truncate">{{ presentation.label }}</span>
  </div>
</template>
