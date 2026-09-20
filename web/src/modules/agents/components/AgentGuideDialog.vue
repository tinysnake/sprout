<script setup lang="ts">
import Dialog from '../../../primitives/Dialog.vue';
import Button from '../../../primitives/Button.vue';

/**
 * The Agent Architecture Guide dialog (#91).
 *
 * It states the settled product rules (ADR-0008) in operator-facing language:
 * portable identity, ordered work options with pre-acceptance fallback and the
 * no-replay guarantee, append-only configuration history, and non-destructive
 * archiving. It is information only; it performs no action.
 */
defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();
</script>

<template>
  <Dialog
    :open="open"
    title="Agent Identity & Work Options Architecture"
    description="How portable Agent identities, ordered work options, and archiving work."
    @update:open="emit('update:open', $event)"
  >
    <div class="flex flex-col gap-3 text-xs text-[var(--text-secondary)] leading-relaxed">
      <div>
        <strong class="text-[var(--text-primary)] block mb-0.5">Portable identity</strong>
        An Agent is created independently of any Project or Environment. It has a stable identity, a non-empty display
        name, optional standing instructions, and at least one ordered work option. It names no machine: no host path,
        credential, hostname, or address can enter its identity.
      </div>
      <div>
        <strong class="text-[var(--text-primary)] block mb-0.5">Ordered work options & admission</strong>
        Work options are evaluated in priority order at run admission, against the selected Environment's current
        observed facts, strictly before any engine accepts the work. Once an engine accepts a run, a later failure is
        reported as-is; work is never silently replayed through a lower-priority option.
      </div>
      <div>
        <strong class="text-[var(--text-primary)] block mb-0.5">Append-only configuration history</strong>
        Every edit appends a new configuration version and never rewrites an earlier one. Each run records the actual
        engine, work model, effort, and configuration version it used, so historical attribution is always resolvable.
      </div>
      <div>
        <strong class="text-[var(--text-primary)] block mb-0.5">Non-destructive archiving</strong>
        An Agent cannot be archived while an active run or an open Task assignment depends on it. Archiving bars new
        work while preserving private memory, versions, sessions, and attribution; restoring re-enables new work and
        re-derives compatibility from current Environment facts.
      </div>
      <div>
        <strong class="text-[var(--text-primary)] block mb-0.5">Private memory boundary</strong>
        This page exposes only neutral private-memory metadata. Inspecting, editing, or clearing private-memory content
        remains engine-native and outside this surface.
      </div>
    </div>

    <template #footer>
      <Button variant="primary" size="sm" class="close-agent-guide-btn" @click="emit('update:open', false)">
        Close Guide
      </Button>
    </template>
  </Dialog>
</template>
