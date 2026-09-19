<script setup lang="ts">
import type { EnvironmentInstance } from '../types.js';
import EnvironmentMasterCard from './EnvironmentMasterCard.vue';
import EmptyState from '../../../primitives/EmptyState.vue';

defineProps<{
  environments: EnvironmentInstance[];
  selectedId?: string;
}>();

const emit = defineEmits<{
  (e: 'select', id: string): void;
  (e: 'probe', id: string): void;
}>();
</script>

<template>
  <div class="envs-card-list flex flex-col gap-2.5 w-full">
    <EnvironmentMasterCard
      v-for="env in environments"
      :key="env.id"
      :env="env"
      :selected="env.id === selectedId"
      @select="emit('select', $event)"
      @probe="emit('probe', $event)"
    />

    <EmptyState
      v-if="environments.length === 0"
      icon="environments"
      title="No environments found"
      description="No environment instances match the active health filter."
    />
  </div>
</template>
