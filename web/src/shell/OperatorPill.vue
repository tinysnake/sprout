<script setup lang="ts">
import { computed } from 'vue';
import { useAppStore } from '../stores/app.js';
import StatusDot from '../primitives/StatusDot.vue';

const appStore = useAppStore();
const isOnline = computed(() => appStore.operatorOnline);
</script>

<template>
  <div
    class="operator-pill flex items-center gap-2 px-2.5 py-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] text-[11px] text-[var(--text-secondary)] select-none"
    :title="isOnline ? 'Operator Connection Online' : 'Operator Disconnected'"
    role="status"
    aria-label="Operator Connection Status"
  >
    <StatusDot :status="isOnline ? 'green' : 'red'" size="sm" />
    <span class="font-medium font-mono">{{ isOnline ? 'Operator Online' : 'Offline' }}</span>
  </div>
</template>
