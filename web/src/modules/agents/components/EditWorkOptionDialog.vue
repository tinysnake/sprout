<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Dialog from '../../../primitives/Dialog.vue';
import Button from '../../../primitives/Button.vue';
import type { AgentWorkOptionRow } from '../types.js';

/**
 * The Edit Work Option dialog (Spec story 37, #183).
 *
 * Editing happens in place: the option keeps its identity and its priority
 * position, and the page submits the whole ordered list back through the same
 * reconfiguration port the create path uses. That appends exactly one
 * configuration version and rewrites nothing, so every earlier version — and
 * every run admitted under it — keeps the engine, work model, and effort it
 * actually used.
 *
 * Presentation follows the accepted Add Work Option dialog: the same
 * prototype modal primitives, the same three fields, the same inline
 * typed-refusal state (`role="alert"`) instead of a silent failure.
 */
const props = defineProps<{
  open: boolean;
  /** The option being edited; also the source of the prefilled draft. */
  option?: AgentWorkOptionRow;
  /** The 1-based priority of that option, shown in the title. */
  priority?: number;
  /** The typed refusal message from the last failed save, if any. */
  error?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'confirm', payload: { engine: string; workModel: string; effort: string }): void;
}>();

const engine = ref('pi');
const workModel = ref('');
const effort = ref('medium');

// Prefill from the option every time the dialog opens (or a different option
// becomes the target), so the operator edits what is actually stored.
watch(
  [() => props.open, () => props.option?.id],
  ([open]) => {
    if (open && props.option !== undefined) {
      engine.value = props.option.engine;
      workModel.value = props.option.workModel;
      effort.value = props.option.effort;
    }
  },
  { immediate: true }
);

const canSave = computed(() => props.option !== undefined && workModel.value.trim() !== '');

function confirm() {
  if (!canSave.value) return;
  emit('confirm', { engine: engine.value, workModel: workModel.value.trim(), effort: effort.value });
}
</script>

<template>
  <Dialog
    :open="open"
    :title="`Edit Work Option (Priority ${priority ?? 1})`"
    description="Update this option in place: its identity and priority stay the same, the change appends one configuration version, and prior run facts are never rewritten."
    @update:open="emit('update:open', $event)"
  >
    <div class="flex flex-col gap-3 text-xs text-[var(--text-secondary)]">
      <div class="flex flex-col gap-1">
        <label for="edit-opt-engine" class="font-bold text-[var(--text-primary)]">Engine *</label>
        <select
          id="edit-opt-engine"
          v-model="engine"
          class="edit-opt-engine px-2.5 py-1.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)]"
        >
          <option value="pi">pi</option>
          <option value="codex">codex</option>
          <option value="agy">agy</option>
          <option value="opencode">opencode</option>
        </select>
      </div>

      <div class="flex flex-col gap-1">
        <label for="edit-opt-model" class="font-bold text-[var(--text-primary)]">Work Model *</label>
        <input
          id="edit-opt-model"
          v-model="workModel"
          type="text"
          placeholder="e.g. glm-5"
          class="edit-opt-model px-2.5 py-1.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
        />
      </div>

      <div class="flex flex-col gap-1">
        <label for="edit-opt-effort" class="font-bold text-[var(--text-primary)]">Reasoning Effort</label>
        <select
          id="edit-opt-effort"
          v-model="effort"
          class="edit-opt-effort px-2.5 py-1.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)]"
        >
          <option value="high">high</option>
          <option value="medium">medium</option>
          <option value="low">low</option>
          <option value="default">default</option>
        </select>
      </div>

      <p v-if="error" class="form-error text-[11px] text-[var(--red-action)]" role="alert">{{ error }}</p>
    </div>

    <template #footer>
      <Button variant="secondary" size="sm" class="cancel-edit-option-btn" @click="emit('update:open', false)">
        Cancel
      </Button>
      <Button
        variant="primary"
        size="sm"
        class="confirm-edit-option-btn"
        :disabled="!canSave || disabled"
        @click="confirm"
      >
        Save Option
      </Button>
    </template>
  </Dialog>
</template>
