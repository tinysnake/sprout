<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { EnvironmentInstance, ForceReleaseParams } from '../types.js';
import AlertDialog from '../../../primitives/AlertDialog.vue';
import Button from '../../../primitives/Button.vue';
import Input from '../../../primitives/Input.vue';
import Checkbox from '../../../primitives/Checkbox.vue';

const props = defineProps<{
  open: boolean;
  env: EnvironmentInstance;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'confirm', params: ForceReleaseParams): void;
}>();

const operatorReason = ref('Host machine hard rebooted without clean worker exit');
const typedConfirmation = ref('');
const acknowledgedRisks = ref(false);

const unresolvedFacts = computed(() => {
  return (
    props.env.leaseRecovery?.unresolvedFacts ?? [
      'Host worker connection offline: engine process stop unconfirmed over carrier',
      'Temporary task scratch context directory unrecycled on host',
      'Partial run settlement telemetry uncollected from host',
    ]
  );
});

const isFormValid = computed(() => {
  return (
    !props.disabled &&
    typedConfirmation.value.trim() === 'FORCE RELEASE' &&
    acknowledgedRisks.value &&
    operatorReason.value.trim().length > 0
  );
});

watch(
  () => props.open,
  (newOpen) => {
    if (newOpen) {
      typedConfirmation.value = '';
      acknowledgedRisks.value = false;
      operatorReason.value = 'Host machine hard rebooted without clean worker exit';
    }
  }
);

function handleConfirm() {
  if (!isFormValid.value) return;
  emit('confirm', {
    environmentId: props.env.id,
    taskId: props.env.activeLeaseHolder?.holderId ?? '104',
    reason: operatorReason.value.trim(),
    acknowledgedRisks: acknowledgedRisks.value,
  });
  emit('update:open', false);
}
</script>

<template>
  <AlertDialog
    :open="open"
    title="Emergency Force Release"
    description="Human-only override for otherwise unrecoverable state"
    @update:open="(val) => emit('update:open', val)"
  >
    <div class="flex flex-col gap-3">
      <!-- Emergency Warning -->
      <div class="p-3 rounded-[var(--radius-sm)] border border-[var(--red-action)] bg-[var(--red-action-bg)] text-xs text-[var(--text-primary)] leading-relaxed">
        <strong>EMERGENCY OVERRIDE WARNING:</strong><br />
        Force Release bypasses normal worker proof and scratch context cleanup. It permanently marks Task #{{ env.activeLeaseHolder?.holderId ?? '104' }} as cancelled with a permanent forced release disposition, preserves the Project workspace, and makes Environment <strong>{{ env.displayName }}</strong> immediately reassignable.
      </div>

      <!-- Unresolved Operational Facts -->
      <div class="flex flex-col gap-1.5">
        <h4 class="text-xs font-bold text-[var(--text-primary)]">Unresolved Operational Facts</h4>
        <div class="p-2.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)] flex flex-col gap-1">
          <div v-for="fact in unresolvedFacts" :key="fact">• {{ fact }}</div>
        </div>
      </div>

      <!-- Mandatory Operator Reason -->
      <div class="flex flex-col gap-1">
        <label for="force-reason-input" class="text-xs font-bold text-[var(--text-primary)]">
          Mandatory Operator Reason:
        </label>
        <Input
          id="force-reason-input"
          v-model="operatorReason"
          class="force-reason-input"
          placeholder="e.g. Host machine kernel panic; worker cannot reconnect"
        />
      </div>

      <!-- Typed Confirmation Input -->
      <div class="flex flex-col gap-1">
        <label for="force-confirm-typed" class="text-xs font-bold text-[var(--text-primary)]">
          Type <code class="text-[var(--red-action)] font-mono font-bold">FORCE RELEASE</code> to confirm:
        </label>
        <Input
          id="force-confirm-typed"
          v-model="typedConfirmation"
          class="force-confirm-typed"
          placeholder="FORCE RELEASE"
          autocomplete="off"
        />
      </div>

      <!-- Risk Acknowledgement Checkbox -->
      <div class="flex items-start gap-2 pt-1">
        <Checkbox
          id="ack-risks"
          v-model="acknowledgedRisks"
          class="ack-risks-checkbox mt-0.5"
        />
        <label for="ack-risks" class="text-xs text-[var(--text-secondary)] leading-tight cursor-pointer select-none">
          I acknowledge the risks of concurrent execution, missing telemetry, and leftover temporary state, and authorize permanent emergency release.
        </label>
      </div>
    </div>

    <template #footer>
      <Button
        variant="secondary"
        size="sm"
        class="close-sheet-btn"
        @click="emit('update:open', false)"
      >
        Cancel
      </Button>
      <Button
        id="confirm-force-btn"
        variant="danger"
        size="sm"
        class="confirm-force-btn"
        :disabled="!isFormValid"
        @click="handleConfirm"
      >
        Authorize Force Release (Emergency Human Action)
      </Button>
    </template>
  </AlertDialog>
</template>
