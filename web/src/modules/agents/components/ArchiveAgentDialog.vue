<script setup lang="ts">
import { computed } from 'vue';
import AlertDialog from '../../../primitives/AlertDialog.vue';
import Button from '../../../primitives/Button.vue';
import type { AgentInstance } from '../types.js';

/**
 * The Archive Agent confirmation dialog (#91, ADR-0008).
 *
 * Archiving is non-destructive: it bars new memberships, messages, and runs
 * while preserving private memory, version history, sessions, and every past
 * run's attribution. It is refused by the backend while an active run or an
 * open Task assignment depends on the Agent; the typed refusal renders here.
 */
const props = defineProps<{
  open: boolean;
  agent?: AgentInstance;
  /** The typed refusal message from the last failed archive attempt, if any. */
  error?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'confirm', agent: AgentInstance): void;
}>();

const canConfirm = computed(
  () => props.agent !== undefined && props.error === undefined || props.error === ''
);
</script>

<template>
  <AlertDialog
    :open="open"
    title="Archive this Agent?"
    :description="`Archiving ${agent?.displayName ?? 'this Agent'} bars new Project memberships, messages, and runs. Nothing is deleted: private memory, configuration versions, sessions, and historical attribution are preserved, and Restore is always available.`"
    @update:open="emit('update:open', $event)"
  >
    <div class="flex flex-col gap-2 text-xs text-[var(--text-secondary)]">
      <p>
        The backend refuses this action while an active run or an open Task assignment depends on the Agent; the refusal is
        reported verbatim and nothing changes.
      </p>
      <p v-if="error" class="form-error text-[11px] text-[var(--red-action)]" role="alert">{{ error }}</p>
    </div>

    <template #footer>
      <Button variant="secondary" size="sm" class="cancel-archive-agent-btn" @click="emit('update:open', false)">
        Cancel
      </Button>
      <Button
        variant="danger"
        size="sm"
        class="confirm-archive-agent-btn"
        :disabled="!canConfirm || disabled"
        @click="agent !== undefined && emit('confirm', agent)"
      >
        Archive Agent
      </Button>
    </template>
  </AlertDialog>
</template>
