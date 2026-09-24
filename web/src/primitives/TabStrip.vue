<script setup lang="ts">
/**
 * A segmented tab strip with real tab semantics.
 *
 * Arrow keys move focus between tabs, Home/End jump to the ends, and the active
 * tab is marked with `aria-selected`. Roving focus comes from Reka UI rather
 * than hand-written key handling, which is the behaviour the prototype only
 * claimed through `role="tablist"`.
 *
 * Every tab is focusable and the active tab is the group's tab stop: Reka marks
 * exactly the item whose `tabStopId` matches `currentTabStopId` as `tabindex="0"`
 * and the rest as `tabindex="-1"`. Marking only the active tab `focusable` would
 * instead mark the others `data-disabled` and drop them from arrow navigation.
 */
import { computed } from 'vue';
import { RovingFocusGroup, RovingFocusItem } from 'reka-ui';
import { cn } from '../lib/utils.js';
import Icon from './Icon.vue';

export interface TabStripItem {
  key: string;
  label: string;
  icon?: string;
}

export interface TabStripProps {
  items: readonly TabStripItem[];
  modelValue: string;
  label: string;
  class?: string;
}

const props = withDefaults(defineProps<TabStripProps>(), { class: '' });

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const classes = computed(() => cn('sub-nav-tabs flex items-center gap-1 p-1 rounded-md', props.class));

function selectTab(key: string) {
  emit('update:modelValue', key);
}
</script>

<template>
  <RovingFocusGroup
    as="div"
    :class="classes"
    role="tablist"
    orientation="horizontal"
    :loop="true"
    :current-tab-stop-id="`sub-nav-tab-${modelValue}`"
    :aria-label="label"
  >
    <RovingFocusItem
      v-for="item in items"
      :key="item.key"
      as="button"
      type="button"
      role="tab"
      :tab-stop-id="`sub-nav-tab-${item.key}`"
      :aria-selected="item.key === modelValue"
      :data-tab="item.key"
      :title="item.label"
      :class="
        cn(
          'sub-nav-tab flex-1 flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 py-2 px-2 rounded-[var(--radius-sm)] text-xs font-semibold cursor-pointer select-none transition-all min-h-[44px]',
          'focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]',
          item.key === modelValue
            ? 'bg-[var(--accent-primary)] text-[var(--text-inverse)] font-bold shadow-xs'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)]'
        )
      "
      @click="selectTab(item.key)"
    >
      <Icon v-if="item.icon" :name="item.icon" :size="15" />
      <span class="truncate">{{ item.label }}</span>
    </RovingFocusItem>
  </RovingFocusGroup>
</template>
