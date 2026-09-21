<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Dialog from '../../../primitives/Dialog.vue';
import Button from '../../../primitives/Button.vue';
import type { AgentInstance } from '../types.js';

/**
 * The Edit Standing Instructions dialog (#91).
 *
 * Saving appends one configuration version with the new instructions; an
 * emptied field clears them explicitly. The backend's privacy boundary redacts
 * credentials, host paths, and addresses before anything becomes durable.
 */
const props = defineProps<{
  open: boolean;
  agent?: AgentInstance;
  /** The typed refusal message from the last failed save, if any. */
  error?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'confirm', payload: { instructions: string | null }): void;
}>();

const instructions = ref('');

watch(
  () => [props.open, props.agent] as const,
  ([open, agent]) => {
    if (open && agent !== undefined) instructions.value = agent.instructions ?? '';
  }
);

const canSave = computed(() => props.agent !== undefined);

function confirm() {
  if (!canSave.value || props.agent === undefined) return;
  const text = instructions.value.trim();
  emit('confirm', { instructions: text === '' ? null : text });
}
</script>

<template>
  <Dialog
    :open="open"
    :title="`Edit Standing Instructions (${agent?.id ?? ''})`"
    description="Standing instructions are woven into every project contract this Agent works under. Saving appends a new configuration version."
    @update:open="emit('update:open', $event)"
  >
    <div class="flex flex-col gap-3 text-xs text-[var(--text-secondary)]">
      <div class="flex flex-col gap-1">
        <label for="edit-agent-instructions" class="font-bold text-[var(--text-primary)]">
          Standing Instructions
        </label>
        <textarea
          id="edit-agent-instructions"
          v-model="instructions"
          rows="4"
          placeholder="Persistent guidance applied across all tasks and projects..."
          class="edit-agent-instructions-input px-3 py-2 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
        />
      </div>
      <div class="text-[11px] text-[var(--text-muted)]">
        Clearing the field removes the instructions from later versions; earlier versions and past run attributions keep theirs.
        Credentials, host paths, and addresses are redacted before storage.
      </div>
      <p v-if="error" class="form-error text-[11px] text-[var(--red-action)]" role="alert">{{ error }}</p>
    </div>

    <template #footer>
      <Button variant="secondary" size="sm" class="cancel-edit-instructions-btn" @click="emit('update:open', false)">
        Cancel
      </Button>
      <Button
        variant="primary"
        size="sm"
        class="confirm-edit-instructions-btn"
        :disabled="!canSave || disabled"
        @click="confirm"
      >
        Save Instructions
      </Button>
    </template>
  </Dialog>
</template>
