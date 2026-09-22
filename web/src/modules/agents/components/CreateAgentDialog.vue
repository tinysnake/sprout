<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Dialog from '../../../primitives/Dialog.vue';
import Button from '../../../primitives/Button.vue';

/**
 * The Create Agent dialog (#91, ADR-0008).
 *
 * A stable display name, optional standing instructions, and the primary work
 * option (Priority 1) are the minimum identity. The backend owns validation
 * and the privacy boundary; this form only stops the obvious empty submission
 * and renders the backend's typed refusal as inline text.
 */
const props = defineProps<{
  open: boolean;
  /** The typed refusal message from the last failed create, if any. */
  error?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (
    e: 'confirm',
    input: { displayName: string; instructions?: string; workOptions: { engine: string; workModel: string; effort: string }[] }
  ): void;
}>();

const displayName = ref('');
const instructions = ref('');
const engine = ref('pi');
const workModel = ref('');
const effort = ref('high');

watch(
  () => props.open,
  (open) => {
    if (open) {
      displayName.value = '';
      instructions.value = '';
      engine.value = 'pi';
      workModel.value = '';
      effort.value = 'high';
    }
  }
);

const canCreate = computed(() => displayName.value.trim() !== '' && workModel.value.trim() !== '');

function confirm() {
  if (!canCreate.value) return;
  emit('confirm', {
    displayName: displayName.value.trim(),
    ...(instructions.value.trim() !== '' ? { instructions: instructions.value.trim() } : {}),
    workOptions: [
      { engine: engine.value, workModel: workModel.value.trim(), effort: effort.value },
    ],
  });
}
</script>

<template>
  <Dialog
    :open="open"
    title="Create Global Agent Definition"
    description="Agent identity is portable across Projects and Environments. An Agent requires a non-empty display name and at least one ordered work option."
    @update:open="emit('update:open', $event)"
  >
    <div class="flex flex-col gap-3 text-xs text-[var(--text-secondary)]">
      <div class="flex flex-col gap-1">
        <label for="new-agent-name" class="font-bold text-[var(--text-primary)]">Display Name *</label>
        <input
          id="new-agent-name"
          v-model="displayName"
          type="text"
          required
          placeholder="e.g. Security Auditor, Frontend Engineer"
          class="new-agent-name-input px-3 py-2 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
        />
      </div>

      <div class="flex flex-col gap-1">
        <label for="new-agent-instructions" class="font-bold text-[var(--text-primary)]">
          Standing Instructions (Optional)
        </label>
        <textarea
          id="new-agent-instructions"
          v-model="instructions"
          rows="2"
          placeholder="Standing instructions applied across all tasks and projects..."
          class="new-agent-instructions-input px-3 py-2 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
        />
      </div>

      <div class="border-t border-[var(--border-subtle)] pt-2 flex flex-col gap-2">
        <span class="text-xs font-bold text-[var(--text-primary)]">Primary Work Option (Priority 1)</span>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div class="flex flex-col gap-1">
            <label for="new-opt-engine" class="text-[11px] font-semibold text-[var(--text-secondary)]">Engine</label>
            <select
              id="new-opt-engine"
              v-model="engine"
              class="new-opt-engine px-2.5 py-1.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)]"
            >
              <option value="pi">pi</option>
              <option value="codex">codex</option>
              <option value="agy">agy</option>
              <option value="opencode">opencode</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <label for="new-opt-model" class="text-[11px] font-semibold text-[var(--text-secondary)]">Work Model</label>
            <input
              id="new-opt-model"
              v-model="workModel"
              type="text"
              placeholder="e.g. glm-5"
              class="new-opt-model px-2.5 py-1.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
            />
          </div>
          <div class="flex flex-col gap-1">
            <label for="new-opt-effort" class="text-[11px] font-semibold text-[var(--text-secondary)]">Effort</label>
            <select
              id="new-opt-effort"
              v-model="effort"
              class="new-opt-effort px-2.5 py-1.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)]"
            >
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
              <option value="default">default</option>
            </select>
          </div>
        </div>
      </div>

      <p v-if="error" class="form-error text-[11px] text-[var(--red-action)]" role="alert">{{ error }}</p>
    </div>

    <template #footer>
      <Button variant="secondary" size="sm" class="cancel-create-agent-btn" @click="emit('update:open', false)">
        Cancel
      </Button>
      <Button
        variant="primary"
        size="sm"
        class="confirm-create-agent-btn"
        :disabled="!canCreate || disabled"
        @click="confirm"
      >
        Create Agent
      </Button>
    </template>
  </Dialog>
</template>
