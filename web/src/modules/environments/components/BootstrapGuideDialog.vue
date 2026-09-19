<script setup lang="ts">
import Sheet from '../../../primitives/Sheet.vue';
import Button from '../../../primitives/Button.vue';

defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();
</script>

<template>
  <Sheet
    :open="open"
    side="bottom"
    title="Host Bootstrap & Enrollment Guide"
    description="macOS & Windows Service Setup and Security Guidelines"
    @update:open="(val) => emit('update:open', val)"
  >
    <div class="space-y-3 text-xs text-[var(--text-secondary)] leading-relaxed">
      <div>
        <strong class="text-[var(--text-primary)] block mb-0.5">1. Install Sprout Worker Binary:</strong>
        <p>• macOS: Install the worker using the host's supported package method and register it as a user login item.</p>
        <p>• Windows: Install the worker using the host's supported package method and register it as a logon-triggered task.</p>
      </div>

      <div>
        <strong class="text-[var(--text-primary)] block mb-0.5">2. Key Generation & Privacy Isolation:</strong>
        <p>• The worker generates a private key on the host. The private key never leaves the host.</p>
        <p>• Joins the operator private overlay network (TLS/WSS) or loopback.</p>
      </div>

      <div>
        <strong class="text-[var(--text-primary)] block mb-0.5">3. Local Engine Authentication:</strong>
        <p>• Run engine logins locally in the operator session (e.g. <code class="font-mono text-[var(--accent-primary)]">codex login</code>, <code class="font-mono text-[var(--accent-primary)]">pi auth</code>).</p>
        <p>• Engine credentials remain local to the host; Web inspects only neutral readiness facts.</p>
      </div>

      <div>
        <strong class="text-[var(--text-primary)] block mb-0.5">4. Operator Web Approval:</strong>
        <p>• Operator inspects the pending worker identity, platform, and capability permissions in Web and approves enrollment with one explicit click.</p>
      </div>
    </div>

    <template #footer>
      <Button variant="primary" size="sm" class="close-guide-btn" @click="emit('update:open', false)">
        Close Guide
      </Button>
    </template>
  </Sheet>
</template>
