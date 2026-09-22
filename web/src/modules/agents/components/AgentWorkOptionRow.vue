<script setup lang="ts">
import { computed, ref } from 'vue';
import type { AgentWorkOptionRow } from '../types.js';
import Badge from '../../../primitives/Badge.vue';
import Button from '../../../primitives/Button.vue';
import Icon from '../../../primitives/Icon.vue';
import { optionStateLabel, optionStateVariant } from '../status.js';

/**
 * One ordered work option row (ADR-0008).
 *
 * Reordering is possible three ways with one result: desktop drag-and-drop,
 * the explicit up/down move buttons (touch), and ArrowUp/ArrowDown on the
 * drag handle or the row itself (keyboard). Every path emits the same
 * `move` event; the page turns it into one append-only configuration version.
 */
const props = defineProps<{
  option: AgentWorkOptionRow;
  index: number;
  total: number;
  /** False for an archived Agent: the row is then read-only. */
  editable?: boolean;
}>();

const emit = defineEmits<{
  (e: 'move', payload: { from: number; to: number }): void;
  (e: 'remove', optionId: string): void;
}>();

const dragged = ref(false);
const dragOver = ref(false);

const isFirst = computed(() => props.index === 0);
const isLast = computed(() => props.index === props.total - 1);
const canRemove = computed(() => props.editable === true && props.total > 1);

function move(to: number) {
  if (props.editable !== true) return;
  if (to < 0 || to >= props.total || to === props.index) return;
  emit('move', { from: props.index, to });
}

function handleDragStart(event: DragEvent) {
  if (props.editable !== true) return;
  dragged.value = true;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(props.index));
  }
}

function handleDragOver(event: DragEvent) {
  if (props.editable !== true) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dragOver.value = true;
}

function handleDragLeave() {
  dragOver.value = false;
}

function handleDrop(event: DragEvent) {
  event.preventDefault();
  dragOver.value = false;
  if (props.editable !== true) return;
  const from = Number(event.dataTransfer?.getData('text/plain') ?? Number.NaN);
  if (Number.isInteger(from) && from >= 0 && from < props.total && from !== props.index) {
    emit('move', { from, to: props.index });
  }
}

function handleDragEnd() {
  dragged.value = false;
  dragOver.value = false;
}

function handleRowKeydown(event: KeyboardEvent) {
  if (props.editable !== true) return;
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    move(props.index - 1);
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    move(props.index + 1);
  }
}
</script>

<template>
  <div
    class="agent-option-row p-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex items-center justify-between gap-3 transition-all select-none"
    :class="[
      props.editable ? 'cursor-grab active:cursor-grabbing' : '',
      dragged ? 'opacity-40 border-dashed border-[var(--accent-primary)] bg-[var(--bg-surface)]' : '',
      dragOver ? 'border-[var(--accent-primary)] bg-[var(--accent-bg)]' : '',
    ]"
    :data-option-id="option.id"
    :data-index="index"
    :draggable="props.editable === true"
    :aria-label="`Work option ${index + 1} of ${total}: ${option.engine} ${option.workModel}`"
    @dragstart="handleDragStart"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
    @dragend="handleDragEnd"
    @keydown="handleRowKeydown"
  >
    <!-- Left: drag handle + option info -->
    <div class="agent-option-info flex items-center gap-2.5 min-w-0 flex-wrap flex-1">
      <div
        v-if="props.editable"
        class="drag-handle-wrap cursor-grab active:cursor-grabbing p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded transition-colors focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
        tabindex="0"
        role="button"
        :title="`Drag or press Up/Down arrows to reorder priority for ${option.engine}`"
        :aria-label="`Reorder priority for ${option.engine} option`"
        @keydown="handleRowKeydown"
      >
        <Icon name="sliders" :size="14" />
      </div>

      <Badge :variant="isFirst ? 'info' : 'secondary'" class="text-[10px] font-bold shrink-0">
        Priority {{ index + 1 }}{{ isFirst ? ' (Primary)' : ' (Fallback)' }}
      </Badge>

      <strong class="text-xs font-bold text-[var(--text-primary)] shrink-0">
        {{ option.engine.toUpperCase() }}
      </strong>

      <span class="text-xs text-[var(--text-secondary)] font-mono truncate">
        Model: <code class="text-[var(--accent-primary)]">{{ option.workModel }}</code>
      </span>

      <span
        class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--purple-agent-bg)] text-[var(--purple-agent)] border border-[var(--purple-agent-border)] shrink-0"
      >
        Effort: {{ option.effort }}
      </span>

      <!-- Compatibility verdict: text + colour, never colour alone (ADR-0009) -->
      <Badge :variant="optionStateVariant(option.compatibility)" class="text-[10px] shrink-0">
        {{ optionStateLabel(option.compatibility) }}
      </Badge>
      <span class="sr-only">{{ option.compatibilityReason }}</span>
    </div>

    <!-- Right: move up / move down / remove (touch and keyboard parity) -->
    <div v-if="props.editable" class="agent-option-actions flex items-center gap-1 shrink-0">
      <Button
        variant="ghost"
        size="xs"
        class="move-opt-up-btn h-7 w-7 p-0"
        :disabled="isFirst"
        title="Move priority up"
        :aria-label="`Move ${option.engine} priority up`"
        @click.stop="move(index - 1)"
      >
        <Icon name="chevron-down" :size="12" class="rotate-180" />
      </Button>

      <Button
        variant="ghost"
        size="xs"
        class="move-opt-down-btn h-7 w-7 p-0"
        :disabled="isLast"
        title="Move priority down"
        :aria-label="`Move ${option.engine} priority down`"
        @click.stop="move(index + 1)"
      >
        <Icon name="chevron-down" :size="12" />
      </Button>

      <Button
        variant="ghost"
        size="xs"
        class="delete-opt-btn h-7 w-7 p-0 text-[var(--text-muted)] hover:text-[var(--red-action)]"
        :disabled="!canRemove"
        :title="canRemove ? 'Remove Option' : 'An Agent must have at least one work option'"
        aria-label="Remove Option"
        @click.stop="canRemove && emit('remove', option.id)"
      >
        <Icon name="trash" :size="12" />
      </Button>
    </div>
  </div>
</template>
