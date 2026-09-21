<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Dialog from '../../../primitives/Dialog.vue';
import Button from '../../../primitives/Button.vue';
import type { AgentInstance } from '../types.js';

/**
 * The Edit Agent dialog (#91).
 *
 * Editing the display name appends one configuration version — the backend's
 * append-only rule — so past runs keep the version they were admitted under.
 * The stable identity itself is never editable.
 */
const props = defineProps<{
  open: boolean;
  agent?: AgentInstance;
  /** The typed refusal message from the last failed reconfiguration, if any. */
  error?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'confirm', payload: { displayName: string }): void;
}>();

const displayName = ref('');

watch(
  () => [props.open, props.agent] as const,
  ([open, agent]) => {
    if (open && agent !== undefined) displayName.value = agent.displayName;
  }
);

const canSave = computed(
  () => agentIdentityStable() && displayName.value.trim() !== ''
);

function agentIdentityStable(): boolean {
  return props.agent !== undefined;
}

function confirm() {
  if (!canSave.value || props.agent === undefined) return;
  emit('confirm', { displayName: displayName.value.trim() });
}
</script>

<template>
  <Dialog
    :open="open"
    :title="`Edit Agent Identity (${agent?.id ?? ''})`"
    description="Editing Agent facts appends a new configuration version. Past run attributions and active sessions retain their historical versions."
    @update:open="emit('update:open', $event)"
  >
    <div class="flex flex-col gap-3 text-xs text-[var(--text-secondary)]">
      <div class="flex flex-col gap-1">
        <label for="edit-agent-name" class="font-bold text-[var(--text-primary)]">Display Name</label>
        <input
          id="edit-agent-name"
          v-model="displayName"
          type="text"
          required
          class="edit-agent-name-input px-3 py-2 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
        />
      </div>
      <div class="text-[11px] text-[var(--text-muted)]">
        Stable identity <code class="text-[var(--text-secondary)]">{{ agent?.id }}</code> is permanent and never rewritten.
        <template v-if="agent !== undefined">
          This edit creates version v{{ agent.currentVersion + 1 }}.
        </template>
      </div>
      <p v-if="error" class="form-error text-[11px] text-[var(--red-action)]" role="alert">{{ error }}</p>
    </div>

    <template #footer>
      <Button variant="secondary" size="sm" class="cancel-edit-agent-btn" @click="emit('update:open', false)">
        Cancel
      </Button>
      <Button
        variant="primary"
        size="sm"
        class="confirm-edit-agent-btn"
        :disabled="!canSave || disabled"
        @click="confirm"
      >
        Save Changes
      </Button>
    </template>
  </Dialog>
</template>
