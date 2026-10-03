<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import type { RunView } from '../../../../../src/web/views.ts';
import { RUN_INSPECTOR } from '../../../adapters/run-api.ts';
import Button from '../../../primitives/Button.vue';

const props = defineProps<{ runId: string }>();
const inspector = inject(RUN_INSPECTOR, undefined);
const expanded = ref(false);
const run = ref<RunView>();
const loading = ref(false);
const error = ref('');
const page = ref(0);
let readGeneration = 0;
// Fixed pages keep the DOM bounded even after reading every event in a long run.
const PAGE_SIZE = 50;
const visibleEvents = computed(() => run.value?.events.slice(page.value * PAGE_SIZE, (page.value + 1) * PAGE_SIZE) ?? []);
const expandedGroups = ref(new Set<number>());
type RunEvent = RunView['events'][number];
type ActivityEntry = { start: number; event: RunEvent } | { start: number; events: RunEvent[] };

function isProminentEvent(event: RunEvent): boolean {
  // Engine messages are assistant output. Notices also include routine reasoning,
  // so only the shipped tool-failure and run-retry warnings stay prominent.
  // Run lifecycle status, final result and failure remain visible below the stream.
  return event.type === 'message' || (event.type === 'notice' && (
    event['text'] === 'tool failed' || (typeof event['text'] === 'string' &&
      /^Engine request failed temporarily; retrying \(attempt \d+ of \d+\)\.$/.test(event['text']))
  ));
}

const activityEntries = computed(() => {
  const entries: ActivityEntry[] = [];
  visibleEvents.value.forEach((event, index) => {
    const start = page.value * PAGE_SIZE + index;
    if (isProminentEvent(event)) entries.push({ start, event });
    else {
      const previous = entries.at(-1);
      if (previous && 'events' in previous) previous.events.push(event);
      else entries.push({ start, events: [event] });
    }
  });
  return entries;
});

function toggleGroup(start: number) {
  if (expandedGroups.value.has(start)) expandedGroups.value.delete(start);
  else expandedGroups.value.add(start);
}

const eventCount = computed(() => run.value?.events.length ?? 0);
const duration = computed(() => {
  const value = run.value;
  if (!value || value.completedAt === undefined) return 'Duration unavailable';
  const seconds = Math.floor(Math.max(0, value.completedAt - value.createdAt) / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
});

async function load() {
  if (loading.value) return;
  if (!inspector) { error.value = 'Run activity is unavailable.'; return; }
  const generation = ++readGeneration;
  loading.value = true;
  error.value = '';
  try {
    const loaded = await inspector.getRun(props.runId);
    // Collapse invalidates the read even if the audit has already reopened.
    if (generation !== readGeneration || !expanded.value) return;
    run.value = loaded;
    page.value = Math.min(page.value, Math.max(0, Math.ceil(run.value.events.length / PAGE_SIZE) - 1));
  } catch {
    if (generation === readGeneration) {
      error.value = 'Unable to load run activity. Retry to read the latest run.';
    }
  } finally {
    if (generation === readGeneration) loading.value = false;
  }
}

function toggle() {
  expanded.value = !expanded.value;
  if (expanded.value) void load();
  else {
    readGeneration += 1;
    loading.value = false;
    run.value = undefined;
    // Recompute cached content now, since the collapsed template no longer reads it.
    void visibleEvents.value;
    void activityEntries.value;
    void resultText.value;
  }
}

function eventTime(event: RunView['events'][number]): string {
  const value = event['time'] ?? event['timestamp'] ?? event['at'];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  // Current engine events do not carry timestamps; never substitute run time.
  return 'time unavailable';
}

function eventText(event: RunView['events'][number]): string {
  const content = ['summary', 'name', 'detail', 'text']
    .map((key) => event[key])
    .filter((value): value is string => typeof value === 'string');
  // Unknown projected event shapes remain inspectable without inferred summaries.
  return content.length ? content.join('\n') : JSON.stringify(event, null, 2);
}

const resultText = computed(() => {
  const result = run.value?.result;
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    const fields = result as Record<string, unknown>;
    const content = ['status', 'text', 'message'].map((key) => fields[key])
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (content.length) return content.join('\n');
  }
  return JSON.stringify(result, null, 2);
});
</script>

<template>
  <div :data-run-audit="runId" class="mt-3 border-t border-[var(--border-subtle)] pt-3">
    <div class="flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="sm" class="min-h-[44px]" :aria-expanded="expanded" :aria-controls="`run-activity-${runId}`" @click="toggle">
        {{ expanded ? 'Hide activity' : 'Show activity' }}
      </Button>
      <p v-if="run" class="text-xs text-[var(--text-secondary)]">
        {{ run.status }} · {{ duration }} · {{ run.tokenUsage ? `${run.tokenUsage.totalTokens.toLocaleString('en-US')} tokens` : 'Tokens unavailable' }}
      </p>
    </div>
    <div v-if="expanded" :id="`run-activity-${runId}`" class="mt-3 flex flex-col gap-3" :aria-busy="loading">
      <p v-if="loading" role="status" class="text-xs text-[var(--text-secondary)]">Loading run activity…</p>
      <div v-if="error" role="alert" class="text-sm text-[var(--text-secondary)]">
        <p>{{ error }}</p>
        <Button v-if="inspector" variant="secondary" size="sm" class="mt-2 min-h-[44px]" :disabled="loading" @click="load">Retry activity</Button>
      </div>
      <template v-if="run">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h4 class="text-xs font-bold">Activity stream</h4>
          <Button variant="ghost" size="sm" class="min-h-[44px]" :disabled="loading" @click="load">Refresh run</Button>
        </div>
        <p v-if="loading || error" class="text-xs text-[var(--text-muted)]">Showing the last loaded run.</p>
        <p v-if="!eventCount" class="text-xs text-[var(--text-muted)]">No activity events recorded.</p>
        <template v-else>
          <p class="text-xs text-[var(--text-muted)]" role="status">Events {{ page * PAGE_SIZE + 1 }}–{{ Math.min((page + 1) * PAGE_SIZE, eventCount) }} of {{ eventCount }} · Recorded order</p>
          <ol class="max-h-80 overflow-y-auto rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 text-xs font-mono" aria-label="Run activity events" tabindex="0">
            <template v-for="entry in activityEntries" :key="entry.start">
              <li v-if="'event' in entry" data-run-event class="border-b border-[var(--border-subtle)] py-2 last:border-0">
                <span class="text-[var(--text-muted)]">[{{ eventTime(entry.event) }}] {{ entry.event.type }}</span>
                <p class="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{{ eventText(entry.event) }}</p>
              </li>
              <li v-else data-run-event-group class="border-b border-[var(--border-subtle)] py-2 last:border-0">
                <Button variant="ghost" size="sm" class="min-h-[44px]" :aria-expanded="expandedGroups.has(entry.start)" :aria-controls="`run-activity-${runId}-group-${entry.start}`" @click="toggleGroup(entry.start)">
                  Supporting activity · {{ entry.events.length }} {{ entry.events.length === 1 ? 'event' : 'events' }} · {{ expandedGroups.has(entry.start) ? 'Hide' : 'Show' }}
                </Button>
                <ol v-if="expandedGroups.has(entry.start)" :id="`run-activity-${runId}-group-${entry.start}`" class="pl-3" aria-label="Supporting activity events">
                  <li v-for="(event, index) in entry.events" :key="entry.start + index" data-run-event class="border-b border-[var(--border-subtle)] py-2 last:border-0">
                    <span class="text-[var(--text-muted)]">[{{ eventTime(event) }}] {{ event.type }}</span>
                    <p class="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{{ eventText(event) }}</p>
                  </li>
                </ol>
              </li>
            </template>
          </ol>
          <div v-if="eventCount > PAGE_SIZE" class="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" class="min-h-[44px]" :disabled="page === 0" @click="page -= 1">Previous events</Button>
            <Button variant="secondary" size="sm" class="min-h-[44px]" :disabled="(page + 1) * PAGE_SIZE >= eventCount" @click="page += 1">Next events</Button>
          </div>
        </template>
        <section data-run-result class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
          <h4 class="text-xs font-bold">Final result</h4>
          <p v-if="resultText" class="mt-2 text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{{ resultText }}</p>
          <p v-else class="mt-2 text-xs text-[var(--text-muted)]">No final result recorded.</p>
          <p v-if="run.failure" class="mt-2 text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere]">Failure: {{ run.failure }}</p>
        </section>
      </template>
    </div>
  </div>
</template>
