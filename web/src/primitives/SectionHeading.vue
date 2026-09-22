<script setup lang="ts">
/**
 * A page or section heading with an optional description, trailing actions, and
 * an optional leading icon. The heading level is explicit, so a page's
 * document outline is the author's choice rather than an accident.
 */
import { computed } from 'vue';
import { cn } from '../lib/utils.js';
import Icon from './Icon.vue';

export interface SectionHeadingProps {
  title: string;
  description?: string;
  icon?: string;
  as?: string;
  class?: string;
}

const props = withDefaults(defineProps<SectionHeadingProps>(), {
  description: '',
  icon: '',
  as: 'h2',
  class: '',
});

const classes = computed(() => cn('section-heading flex items-start justify-between gap-3 flex-wrap', props.class));
</script>

<template>
  <div :class="classes">
    <div class="min-w-0">
      <component
        :is="as"
        class="section-heading-title flex items-center gap-2 text-sm sm:text-base font-bold text-[var(--text-primary)]"
      >
        <Icon v-if="icon" :name="icon" :size="18" />
        <span class="truncate">{{ title }}</span>
      </component>
      <p v-if="description" class="section-heading-description text-xs text-[var(--text-secondary)] mt-0.5">
        {{ description }}
      </p>
    </div>
    <div v-if="$slots.actions" class="section-heading-actions flex items-center gap-2 shrink-0">
      <slot name="actions" />
    </div>
  </div>
</template>
