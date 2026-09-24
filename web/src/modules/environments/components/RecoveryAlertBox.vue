<script setup lang="ts">
import { computed } from 'vue';
import type { EnvironmentInstance } from '../types.js';
import StatusPill from '../../../primitives/StatusPill.vue';
import Button from '../../../primitives/Button.vue';
import Icon from '../../../primitives/Icon.vue';

const props = defineProps<{
  env: EnvironmentInstance;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'resume', taskId: string): void;
  (e: 'discard', taskId: string): void;
  (e: 'forceRelease', envId: string): void;
}>();

const recovery = computed(() => props.env.leaseRecovery);
const holder = computed(() => props.env.activeLeaseHolder);
const taskId = computed(() => holder.value?.holderId ?? recovery.value?.leaseId ?? '');
const isRunHolder = computed(() => holder.value?.holderKind === 'run');

/**
 * The ordinary decisions act through the holder, and both need the retained
 * evidence synchronized first (ADR-0009). Force Release is available in
 * `recovery` even before the evidence arrives — it is the emergency escape.
 */
const evidenceReady = computed(() => recovery.value?.evidenceSynchronized === true);
const hasHolder = computed(() => taskId.value !== '');

const unresolvedFacts = computed(() => recovery.value?.unresolvedFacts ?? []);
</script>

<template>
  <div class="recovery-alert-box p-3.5 rounded-[var(--radius-sm)] border border-[var(--red-action)] bg-[var(--red-action-bg)] flex flex-col gap-2.5">
    <div class="flex items-center justify-between">
      <strong class="text-sm font-bold text-[var(--red-action)] flex items-center gap-1.5">
        <Icon name="alert" :size="16" />
        <span>Lease Recovery Required</span>
      </strong>
      <StatusPill status="red" class="text-[10px]">
        RECOVERY LOCKED
      </StatusPill>
    </div>

    <div class="text-xs text-[var(--text-primary)]">
      <strong>Cause:</strong> {{ recovery?.cause ?? 'Worker channel lost mid-turn during active Agent run.' }}
    </div>

    <div v-if="recovery?.interruptedRunId" class="text-[11px] text-[var(--text-secondary)] font-mono">
      Interrupted Run: <code>{{ recovery.interruptedRunId }}</code>
    </div>

    <!-- Unresolved Facts Manifest -->
    <div class="p-2.5 rounded-[var(--radius-xs)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs flex flex-col gap-1">
      <strong class="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-bold">
        Unresolved Operational Facts:
      </strong>
      <div v-for="fact in unresolvedFacts" :key="fact" class="text-[var(--text-secondary)] text-[11px]">
        • {{ fact }}
      </div>
    </div>

    <!-- Reconciled Evidence Proof if present -->
    <div
      v-if="recovery?.reconciledEvidence"
      class="p-2 rounded-[var(--radius-xs)] bg-[var(--green-ready-bg)] border border-[var(--green-ready)] text-xs text-[var(--text-primary)]"
    >
      <strong>Reconciliation Proof:</strong> Retained {{ recovery.reconciledEvidence.retainedEventsCount }} events, verified engine session stopped. Ready for Human decision.
    </div>

    <!-- Action Buttons -->
    <div class="flex items-center justify-end gap-2 pt-2 border-t border-[var(--red-action-border)] flex-wrap">
      <template v-if="evidenceReady && hasHolder && !isRunHolder">
        <Button
          variant="secondary"
          size="sm"
          class="btn-resume-recovery text-xs"
          :disabled="disabled"
          @click="emit('resume', taskId)"
        >
          <Icon name="play" :size="13" />
          <span>Resume Task on Same Host</span>
        </Button>

        <Button
          variant="secondary"
          size="sm"
          class="btn-discard-recovery text-xs"
          :disabled="disabled"
          @click="emit('discard', taskId)"
        >
          <Icon name="close" :size="13" />
          <span>Discard Task & Safe Release</span>
        </Button>
      </template>

      <Button
        variant="danger"
        size="sm"
        class="force-release-btn text-xs"
        :disabled="disabled"
        @click="emit('forceRelease', env.id)"
      >
        <Icon name="warning" :size="13" />
        <span>Emergency Force Release</span>
      </Button>
    </div>
  </div>
</template>
