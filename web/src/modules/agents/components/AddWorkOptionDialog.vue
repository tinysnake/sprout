<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Dialog from '../../../primitives/Dialog.vue';
import Button from '../../../primitives/Button.vue';
import type { AgentInstance } from '../types.js';

/**
 * The Add Work Option dialog (#91, ADR-0008).
 *
 * A new option joins the end of the ordered list; reordering happens on the
 * rows afterwards. Saving appends one configuration version.
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
  (e: 'confirm', payload: { engine: string; workModel: string; effort: string }): void;
}>();

const engine = ref('pi');
const workModel = ref('');
const effort = ref('medium');

watch(
  () => props.open,
  (open) => {
    if (open) {
      engine.value = 'pi';
      workModel.value = '';
      effort.value = 'medium';
    }
  }
);

const nextPriority = computed(() => (props.agent?.workOptions.length ?? 0) + 1);
const canAdd = computed(() => props.agent !== undefined && workModel.value.trim() !== '');

function confirm() {
  if (!canAdd.value) return;
  emit('confirm', { engine: engine.value, workModel: workModel.value.trim(), effort: effort.value });
}
</script>

<template>
  <Dialog
    :open="open"
    :title="`Add Work Option (Priority ${nextPriority})`"
    description="Configure an execution fallback option. Sprout evaluates options in priority order at run admission, before any engine accepts the work."
    @update:open="emit('update:open', $event)"
  >
    <div class="flex flex-col gap-3 text-xs text-[var(--text-secondary)]">
      <div class="flex flex-col gap-1">
        <label for="add-opt-engine" class="font-bold text-[var(--text-primary)]">Engine *</label>
        <select
          id="add-opt-engine"
          v-model="engine"
          class="add-opt-engine px-2.5 py-1.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)]"
        >
          <option value="pi">pi</option>
          <option value="codex">codex</option>
          <option value="agy">agy</option>
          <option value="opencode">opencode</option>
        </select>
      </div>

      <div class="flex flex-col gap-1">
        <label for="add-opt-model" class="font-bold text-[var(--text-primary)]">Work Model *</label>
        <input
          id="add-opt-model"
          v-model="workModel"
          type="text"
          placeholder="e.g. glm-5"
          class="add-opt-model px-2.5 py-1.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
        />
      </div>

      <div class="flex flex-col gap-1">
        <label for="add-opt-effort" class="font-bold text-[var(--text-primary)]">Reasoning Effort</label>
        <select
          id="add-opt-effort"
          v-model="effort"
          class="add-opt-effort px-2.5 py-1.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)]"
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
      <Button variant="secondary" size="sm" class="cancel-add-option-btn" @click="emit('update:open', false)">
        Cancel
      </Button>
      <Button
        variant="primary"
        size="sm"
        class="confirm-add-option-btn"
        :disabled="!canAdd || disabled"
        @click="confirm"
      >
        Add Option
      </Button>
    </template>
  </Dialog>
</template>
