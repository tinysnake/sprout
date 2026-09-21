<script setup lang="ts">
import type { AgentInstance } from '../types.js';
import AgentMasterCard from './AgentMasterCard.vue';
import EmptyState from '../../../primitives/EmptyState.vue';

withDefaults(
  defineProps<{
    agents: readonly AgentInstance[];
    selectedId?: string;
  }>(),
  { selectedId: undefined }
);

const emit = defineEmits<{
  (e: 'select', id: string): void;
}>();
</script>

<template>
  <div class="agents-card-list flex flex-col gap-2.5 w-full" role="list" aria-label="Agents">
    <div v-for="agent in agents" :key="agent.id" role="listitem">
      <AgentMasterCard
        :agent="agent"
        :selected="agent.id === selectedId"
        @select="emit('select', $event)"
      />
    </div>

    <EmptyState
      v-if="agents.length === 0"
      icon="agents"
      title="No agents found"
      description="No Agent matches the active status filter."
    />
  </div>
</template>
