<script setup lang="ts">
import Dialog from '../../../primitives/Dialog.vue';
import Button from '../../../primitives/Button.vue';

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
    title="Register New Host Environment"
    description="Connect worker bootstrap over private transport"
    @update:open="(val) => emit('update:open', val)"
  >
    <div class="space-y-3 text-xs text-[var(--text-secondary)] leading-relaxed">
      <p>To enroll a new host machine into Sprout, execute this command on the target host in your operator user session:</p>
      <pre class="p-2.5 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] font-mono text-[11px] text-[var(--accent-primary)] overflow-x-auto">sprout worker enroll --private-transport</pre>
      <p class="text-[11px] text-[var(--text-muted)]">
        The worker generates a host-local keypair, connects via TLS/WSS, and presents its identity to the operator for approval.
      </p>
    </div>

    <template #footer>
      <Button variant="secondary" size="sm" @click="emit('update:open', false)">
        Cancel
      </Button>
      <Button variant="primary" size="sm" @click="emit('update:open', false)">
        Done
      </Button>
    </template>
  </Dialog>
</template>
