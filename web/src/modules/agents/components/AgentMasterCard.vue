<script setup lang="ts">
import { computed } from 'vue';
import type { AgentInstance } from '../types.js';
import StatusDot from '../../../primitives/StatusDot.vue';
import Badge from '../../../primitives/Badge.vue';
import Card from '../../../primitives/Card.vue';
import { bannerTitle } from '../status.js';

const props = defineProps<{
  agent: AgentInstance;
  selected?: boolean;
}>();

const emit = defineEmits<{
  (e: 'select', id: string): void;
}>();

const trafficLightLabel = computed(() => bannerTitle(props.agent.trafficLight));

const primaryOption = computed(() => props.agent.workOptions[0]);

const versionBadge = computed(() => `v${props.agent.currentVersion}`);

const contextId = computed(() => `agent-master-context-${props.agent.id}`);
</script>

<template>
  <Card
    as="button"
    :interactive="true"
    :selected="selected"
    class="agent-master-card w-full text-left p-3.5 select-none relative"
    :data-agent="agent.id"
    :aria-label="`Open Agent ${agent.displayName}`"
    :aria-describedby="contextId"
    :aria-current="selected ? 'page' : undefined"
    @click="emit('select', agent.id)"
  >
    <!-- Card Header: avatar, identity, and the top-right status dot -->
    <div class="agent-master-card-header flex items-start justify-between gap-2 mb-2">
      <div class="flex items-center gap-2.5 min-w-0">
        <div
          class="agent-avatar-badge flex items-center justify-center w-7 h-7 rounded-full bg-[var(--purple-agent-bg)] border border-[var(--purple-agent-border)] text-[var(--purple-agent)] font-bold text-xs shrink-0"
          aria-hidden="true"
        >
          {{ agent.displayName.slice(0, 2).toUpperCase() }}
        </div>
        <div class="min-w-0 flex-1">
          <strong class="agent-title block text-xs font-bold text-[var(--text-primary)] truncate">
            {{ agent.displayName }}
          </strong>
          <span class="block text-[10px] text-[var(--text-muted)] font-mono truncate">
            {{ agent.id }}
          </span>
        </div>
      </div>

      <StatusDot
        :status="agent.trafficLight"
        size="sm"
        :title="trafficLightLabel"
        :aria-label="trafficLightLabel"
        class="mt-1 shrink-0"
      />
    </div>

    <!-- Decisive Reason Snippet (2-line clamp) -->
    <p class="agent-reason-snippet text-xs text-[var(--text-secondary)] line-clamp-2 leading-relaxed mb-3">
      {{ agent.trafficLightReason }}
    </p>

    <!-- Compact Metric Chips: priority 1 option, option count, version -->
    <div class="agent-card-metrics-row flex items-center gap-1.5 flex-wrap pt-2 border-t border-[var(--border-subtle)]">
      <Badge
        v-if="primaryOption"
        variant="secondary"
      >
        {{ primaryOption.engine.toUpperCase() }}: {{ primaryOption.workModel }}
      </Badge>
      <Badge variant="secondary">
        {{ agent.workOptions.length }} option{{ agent.workOptions.length === 1 ? '' : 's' }}
      </Badge>
      <Badge variant="info">
        {{ versionBadge }}
      </Badge>
      <Badge v-if="agent.status === 'archived'" variant="neutral">
        Archived
      </Badge>
    </div>

    <!-- Screen reader hidden context -->
    <span :id="contextId" class="sr-only">
      Status: {{ trafficLightLabel }}. Decisive reason: {{ agent.trafficLightReason }}.
      Configuration version {{ agent.currentVersion }} with
      {{ agent.workOptions.length }} ordered work option{{ agent.workOptions.length === 1 ? '' : 's' }}.
    </span>
  </Card>
</template>
