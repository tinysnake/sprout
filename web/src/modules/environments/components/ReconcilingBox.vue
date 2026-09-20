<script setup lang="ts">
import type { EnvironmentInstance } from '../types.js';
import StatusPill from '../../../primitives/StatusPill.vue';
import Icon from '../../../primitives/Icon.vue';

const props = defineProps<{
  env: EnvironmentInstance;
  disabled?: boolean;
  /**
   * True only when the typed authority really reaches a Worker evidence port.
   * Production never does (ADR-0009: retained evidence is a Worker fact), so
   * the box renders read-only with an explicit not-synchronized state instead
   * of offering an operator action that would fabricate the Worker's proof.
   */
  canReconcile?: boolean;
}>();

const emit = defineEmits<{
  (e: 'reconcile', id: string): void;
}>();

const reconcilable = props.canReconcile === true;
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

    <!-- No Worker evidence port is wired: read-only, honestly not synchronized. -->
    <p
      v-if="!reconcilable"
      class="evidence-not-synchronized text-[11px] text-[var(--text-secondary)] leading-relaxed p-2 rounded-[var(--radius-xs)] bg-[var(--bg-surface)] border border-[var(--border-subtle)]"
    >
      <strong class="text-[var(--text-primary)]">Not synchronized yet.</strong>
      Settlement evidence can only be declared by the reconnected Worker itself; no operator action can synchronize it on the Worker's behalf. This box stays read-only until the Worker's retained facts arrive.
    </p>

    <div v-else class="flex justify-end pt-1">
      <button
        type="button"
        class="btn-reconcile-evidence text-xs px-3 py-1.5 rounded-[var(--radius-xs)] font-bold text-[var(--text-primary)]"
        :disabled="disabled"
        @click="emit('reconcile', env.id)"
      >
        Reconcile & Synchronize Evidence
      </button>
    </div>
  </div>
</template>
