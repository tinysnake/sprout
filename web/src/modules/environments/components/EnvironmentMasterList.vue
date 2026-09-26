<script setup lang="ts">
import type { EnvironmentInstance } from '../types.js';
import EnvironmentMasterCard from './EnvironmentMasterCard.vue';
import EmptyState from '../../../primitives/EmptyState.vue';

withDefaults(
  defineProps<{
    environments: EnvironmentInstance[];
    selectedId?: string;
    /** True while the connection is unsettled: the card's own action is refused. */
    disabled?: boolean;
    /** True only when the page can actually carry a control action. */
    canControl?: boolean;
  }>(),
  { selectedId: undefined, disabled: false, canControl: true }
);

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
      :disabled="disabled"
      :can-control="canControl"
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
