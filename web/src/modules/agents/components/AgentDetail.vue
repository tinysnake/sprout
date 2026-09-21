<script setup lang="ts">
import { computed } from 'vue';
import type { AgentInstance, AgentRunAttributionRow } from '../types.js';
import StateBanner from '../../../primitives/StateBanner.vue';
import Badge from '../../../primitives/Badge.vue';
import Button from '../../../primitives/Button.vue';
import Icon from '../../../primitives/Icon.vue';
import Foldable from '../../../primitives/Foldable.vue';
import Card from '../../../primitives/Card.vue';
import AgentWorkOptionRowItem from './AgentWorkOptionRow.vue';

/**
 * The rich Agent detail panel (#91).
 *
 * Content order follows the product prototype: status banner, identity and
 * private-memory metadata grid, standing instructions, ordered work options
 * with the pre-acceptance guarantee notice, the foldable progressive
 * disclosure boxes (Environment compatibility, configuration changelog,
 * historical run attribution), and the operations toolbar (edit, archive or
 * restore). Every section renders read-only for an archived Agent.
 */
const props = defineProps<{
  agent: AgentInstance;
  /** Durable run attribution rows, newest first. */
  attributions: readonly AgentRunAttributionRow[];
  /** True while the connection is unsettled: every control action is refused. */
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'edit', agent: AgentInstance): void;
  (e: 'editInstructions', agent: AgentInstance): void;
  (e: 'addOption', agent: AgentInstance): void;
  (e: 'moveOption', payload: { agent: AgentInstance; from: number; to: number }): void;
  (e: 'removeOption', payload: { agent: AgentInstance; optionId: string }): void;
  (e: 'archive', agent: AgentInstance): void;
  (e: 'restore', agent: AgentInstance): void;
}>();

const isArchived = computed(() => props.agent.status === 'archived');
const editable = computed(() => !isArchived.value && props.disabled !== true);

const bannerTrafficLight = computed(() =>
  props.agent.trafficLight === 'neutral' ? 'yellow' : props.agent.trafficLight
);

function formatTimestamp(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
}

/** The runs attributed to this Agent, newest first (#90 durable facts). */
const agentRuns = computed(() =>
  props.attributions.filter((run) => run.agentId === props.agent.id)
);
</script>

<template>
  <Card class="agent-detail-card p-3.5 sm:p-4 flex flex-col gap-4 shadow-sm">
    <!-- Concise Status Banner: status label + version/state chip only -->
    <div class="agent-status-banner-wrap">
      <StateBanner
        :traffic-light="bannerTrafficLight"
        :reason="agent.trafficLightReason"
        :is-archived="isArchived"
      />
      <div class="sr-only" aria-live="polite">{{ agent.trafficLightReason }}</div>
    </div>

    <!-- Section 1: Agent Identity & Core Metadata (2x2 grid) -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <div class="dimension-item p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex items-center justify-between gap-2">
        <div class="min-w-0">
          <span class="text-xs font-semibold text-[var(--text-primary)] block">Stable Identity</span>
          <span class="text-[10px] text-[var(--text-muted)] font-mono truncate block">
            <code>{{ agent.id }}</code>
          </span>
        </div>
        <Badge variant="secondary">{{ agent.displayName }}</Badge>
      </div>

      <div class="dimension-item p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] flex items-center justify-between gap-2">
        <div>
          <span class="text-xs font-semibold text-[var(--text-primary)] block">Private Memory</span>
          <span class="text-[10px] text-[var(--text-muted)] block">Preserved across projects · engine-native</span>
        </div>
        <Badge variant="info">Metadata only</Badge>
      </div>
    </div>

    <!-- Section 2: Standing Instructions (editable while active) -->
    <div class="agent-instructions-box p-3 rounded bg-[var(--bg-surface-elevated)] border border-[var(--border-subtle)] text-xs flex flex-col gap-1">
      <div class="flex items-center justify-between gap-2">
        <strong class="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-bold">
          Standing Instructions (Optional)
        </strong>
        <Button
          v-if="editable"
          variant="ghost"
          size="xs"
          class="edit-instructions-btn"
          title="Edit Standing Instructions"
          aria-label="Edit Standing Instructions"
          @click="emit('editInstructions', agent)"
        >
          <Icon name="guide" :size="12" />
          <span>Edit</span>
        </Button>
      </div>
      <p v-if="agent.instructions" class="text-[var(--text-primary)] leading-relaxed whitespace-pre-wrap">
        {{ agent.instructions }}
      </p>
      <p v-else class="text-[var(--text-muted)] italic leading-relaxed">
        No standing instructions configured. Standing instructions provide persistent guidance across all projects and tasks.
      </p>
    </div>

    <!-- Section 3: Ordered Work Options (Execution Preferences) -->
    <div class="agent-options-section flex flex-col gap-2.5">
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <strong class="text-xs uppercase tracking-wider text-[var(--text-muted)] font-bold block">
            Ordered Execution Preferences (Work Options)
          </strong>
          <p class="text-[11px] text-[var(--text-muted)] mt-0.5">
            Drag, use the move buttons, or press ArrowUp/ArrowDown to reorder priority. Evaluated at run admission in top-to-bottom order.
          </p>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-[10px] text-[var(--text-muted)]">Minimum 1 option guard</span>
          <Button
            v-if="editable"
            variant="secondary"
            size="xs"
            class="add-option-btn"
            title="Add Work Option"
            aria-label="Add Work Option"
            @click="emit('addOption', agent)"
          >
            <Icon name="plus" :size="12" />
            <span>Add Option</span>
          </Button>
        </div>
      </div>

      <div class="agent-options-drag-list flex flex-col gap-2">
        <AgentWorkOptionRowItem
          v-for="(option, idx) in agent.workOptions"
          :key="option.id"
          :option="option"
          :index="idx"
          :total="agent.workOptions.length"
          :editable="editable"
          @move="(payload) => emit('moveOption', { agent, ...payload })"
          @remove="(optionId) => emit('removeOption', { agent, optionId })"
        />
      </div>

      <!-- Pre-Acceptance Fallback & No-Silent-Replay Guarantee -->
      <div class="agent-fallback-box p-3 rounded-[var(--radius-sm)] border border-[var(--accent-border)] bg-[var(--bg-surface-elevated)] flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
        <div class="flex items-center gap-1.5 text-[var(--accent-primary)] font-bold">
          <Icon name="shield" :size="14" />
          <span>Pre-Acceptance Fallback & No-Silent-Replay Guarantee</span>
        </div>
        <p class="leading-relaxed">
          1. <strong>Pre-Acceptance Fallback</strong>: At run admission, Sprout evaluates the ordered options against the Environment's current observed facts and takes the first compatible one — strictly before any engine accepts the work.
        </p>
        <p class="leading-relaxed">
          2. <strong>No Silent Replay</strong>: Once an engine accepts the run, any later failure reports directly. Sprout <em>never</em> silently replays work through lower-priority options because tools may have already caused irreversible side effects.
        </p>
      </div>
    </div>

    <!-- Section 4: Environment Compatibility (foldable, backend projection) -->
    <Foldable
      class="foldable-env-compat"
      title="Environment Compatibility & Admission Evaluation"
      :subtext="agent.compatibility?.environmentAvailable ? 'A compatible option is available' : 'No compatible option verified'"
    >
      <div class="flex flex-col gap-2">
        <p class="text-[11px] text-[var(--text-muted)] m-0">
          Evaluated at read time from the Environment's current observed engine facts. Host credentials and local paths remain isolated.
        </p>
        <div
          v-for="option in agent.workOptions"
          :key="option.id"
          class="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-1.5 text-xs"
        >
          <strong class="text-[var(--text-primary)] shrink-0">
            P{{ agent.workOptions.indexOf(option) + 1 }}: {{ option.engine.toUpperCase() }}
            <code class="text-[10px] text-[var(--text-muted)]">{{ option.workModel }}</code>
          </strong>
          <span
            class="text-[11px] text-right"
            :class="option.compatibility === 'available' ? 'text-[var(--green-ready)]' : option.compatibility === 'missing' || option.compatibility === 'model-unavailable' ? 'text-[var(--red-action)]' : 'text-[var(--yellow-attention)]'"
          >
            {{ option.compatibilityReason }}
          </span>
        </div>
        <div
          v-if="agent.workOptions.length === 0"
          class="text-xs text-[var(--text-muted)] italic py-2 text-center"
        >
          No work options configured for this Agent.
        </div>
      </div>
    </Foldable>

    <!-- Section 5: Configuration Version Changelog (foldable) -->
    <Foldable
      class="foldable-version-changelog"
      title="Configuration Version Changelog"
      :subtext="`v${agent.currentVersion}`"
    >
      <div class="flex flex-col gap-2">
        <div
          v-for="version in [...agent.versions].reverse()"
          :key="version.version"
          class="agent-version-row flex flex-col gap-0.5 border-b border-[var(--border-subtle)] pb-1.5"
        >
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <Badge variant="info" class="font-bold">v{{ version.version }}</Badge>
              <strong class="text-xs text-[var(--text-primary)]">{{ version.reason }}</strong>
            </div>
            <span class="text-[10px] text-[var(--text-muted)]">{{ formatTimestamp(version.at) }}</span>
          </div>
          <div class="text-[11px] text-[var(--text-muted)]">
            {{ version.options.length }} work option(s) configured
            <template v-if="version.instructions !== undefined"> · standing instructions recorded</template>
          </div>
        </div>
      </div>
    </Foldable>

    <!-- Section 6: Historical Run Attribution & Provenance (foldable) -->
    <Foldable
      class="foldable-attribution-trace"
      title="Historical Run Attribution & Provenance"
      :subtext="`${agentRuns.length} recorded execution fact${agentRuns.length === 1 ? '' : 's'}`"
    >
      <div class="flex flex-col gap-2">
        <p class="text-[11px] text-[var(--text-secondary)] m-0">
          Historical runs permanently retain the exact Agent configuration version, engine, work model, and effort used at execution time. Attribution survives rename and archive.
        </p>
        <div
          v-for="run in agentRuns"
          :key="run.runId"
          class="agent-attribution-row flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-1.5 text-xs"
        >
          <div class="min-w-0">
            <strong class="text-[var(--text-primary)] block truncate">{{ run.runId }}</strong>
            <span class="text-[10px] text-[var(--text-muted)]">
              {{ formatTimestamp(run.createdAt) }} · {{ run.status }}
            </span>
          </div>
          <span v-if="run.engine !== undefined" class="text-[11px] text-[var(--text-secondary)] text-right shrink-0">
            {{ run.engine.toUpperCase() }}
            <template v-if="run.workModel !== undefined"> · <code>{{ run.workModel }}</code></template>
            <template v-if="run.effort !== undefined"> · {{ run.effort }}</template>
            <template v-if="run.configurationVersion !== undefined"> · v{{ run.configurationVersion }}</template>
          </span>
          <span v-else class="text-[11px] text-[var(--text-muted)] text-right shrink-0">
            Attribution not recorded (pre-identity run)
          </span>
        </div>
        <div
          v-if="agentRuns.length === 0"
          class="text-xs text-[var(--text-muted)] italic py-2 text-center"
        >
          No runs have been attributed to this Agent yet.
        </div>
      </div>
    </Foldable>

    <!-- Section 7: Operations Toolbar (edit, archive / restore) -->
    <div class="agent-operations-toolbar flex items-center justify-between gap-2 flex-wrap border-t border-[var(--border-subtle)] pt-3">
      <div class="flex items-center gap-2">
        <Button
          v-if="editable"
          variant="secondary"
          size="sm"
          class="edit-agent-btn"
          title="Edit Agent identity"
          aria-label="Edit Agent identity"
          @click="emit('edit', agent)"
        >
          <Icon name="guide" :size="12" />
          <span>Edit Agent</span>
        </Button>
      </div>
      <div>
        <Button
          v-if="!isArchived"
          variant="secondary"
          size="sm"
          class="archive-agent-btn text-[var(--red-action)] border-[var(--red-action-border)]"
          :disabled="disabled"
          title="Archive Agent (non-destructive)"
          aria-label="Archive Agent"
          @click="emit('archive', agent)"
        >
          <Icon name="archive" :size="12" />
          <span>Archive Agent</span>
        </Button>
        <Button
          v-else
          variant="primary"
          size="sm"
          class="restore-agent-btn"
          :disabled="disabled"
          title="Restore Agent"
          aria-label="Restore Agent"
          @click="emit('restore', agent)"
        >
          <Icon name="refresh" :size="12" />
          <span>Restore Agent</span>
        </Button>
      </div>
    </div>
  </Card>
</template>
