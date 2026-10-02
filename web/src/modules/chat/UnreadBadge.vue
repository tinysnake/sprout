<script setup lang="ts">
defineProps<{ count: number }>();
</script>
<template>
  <span v-if="Number.isSafeInteger(count) && count > 0" class="unread-badge-dot chat-unread-badge inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--red-action)] px-[5px] text-[10px] font-bold text-white" :data-unread-count="count" :aria-label="`${count} unread messages`">{{ count }}</span>
</template>
