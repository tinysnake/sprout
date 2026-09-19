<script setup lang="ts">
import type { EnvironmentInstance } from '../types.js';
import StatusPill from '../../../primitives/StatusPill.vue';
import Button from '../../../primitives/Button.vue';
import Icon from '../../../primitives/Icon.vue';

defineProps<{
  env: EnvironmentInstance;
}>();

const emit = defineEmits<{
  (e: 'reconcile', id: string): void;
}>();
</script>

<template>
  <div class="reconciling-box p-3 rounded-[var(--radius-sm)] border border-[var(--yellow-attention)] bg-[var(--yellow-attention-bg)] flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <strong class="text-xs font-bold text-[var(--text-primary)] flex items-center gap-1.5">
        <Icon name="refresh" :size="15" />
        <span>Worker Reconnected · Reconciling Settlement Evidence</span>
      </strong>
      <StatusPill status="yellow" class="text-[10px]">
        RECONCILING
      </StatusPill>
    </div>

    <p class="text-xs text-[var(--text-secondary)] leading-relaxed">
      Worker on {{ env.displayName }} re-authenticated over TLS/WSS. Sprout is synchronizing locally retained events and verifying whether the interrupted engine process has stopped.
    </p>

    <div class="flex justify-end pt-1">
      <Button
        variant="warning"
        size="sm"
        class="btn-reconcile-evidence text-xs"
        @click="emit('reconcile', env.id)"
      >
        <Icon name="check" :size="13" />
        <span>Reconcile & Synchronize Evidence</span>
      </Button>
    </div>
  </div>
</template>
