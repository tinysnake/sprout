<script setup lang="ts">
/**
 * A labelled form control with helper and error text.
 *
 * The error is rendered in a live region and linked from the control, so a form
 * failure is announced rather than only shown, and the invalid control carries
 * `aria-invalid`. The control itself is supplied by the caller, keeping Sprout's
 * input chrome separate from field composition.
 */
import { computed, useId } from 'vue';
import { cn } from '../lib/utils.js';
import Icon from './Icon.vue';

export interface FormFieldProps {
  label: string;
  helper?: string;
  error?: string;
  required?: boolean;
  class?: string;
}

const props = withDefaults(defineProps<FormFieldProps>(), {
  helper: '',
  error: '',
  required: false,
  class: '',
});

const baseId = useId();
const controlId = `${baseId}-control`;
const helperId = `${baseId}-helper`;
const errorId = `${baseId}-error`;

const describedBy = computed(() => {
  const ids: string[] = [];
  if (props.helper) ids.push(helperId);
  if (props.error) ids.push(errorId);
  return ids.length > 0 ? ids.join(' ') : undefined;
});

const classes = computed(() => cn('form-field flex flex-col gap-1.5', props.class));
</script>

<template>
  <div :class="classes">
    <label class="form-field-label text-xs font-semibold text-[var(--text-primary)]" :for="controlId">
      {{ label }}
      <span v-if="required" class="text-[var(--red-action)]" aria-hidden="true">*</span>
      <span v-if="required" class="sr-only">(required)</span>
    </label>

    <slot
      :id="controlId"
      :described-by="describedBy"
      :invalid="error ? true : undefined"
    />

    <span v-if="helper" :id="helperId" class="form-helper text-[11px] text-[var(--text-muted)]">
      {{ helper }}
    </span>

    <span
      v-if="error"
      :id="errorId"
      class="form-error flex items-center gap-1.5 text-[11px] font-semibold text-[var(--red-action)]"
      role="alert"
    >
      <Icon name="warning" :size="12" />
      <span>{{ error }}</span>
    </span>
  </div>
</template>
