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
// Recorded positions are stable across refreshes of the append-only event stream.
// Retain only disclosure keys here, never event payloads.
const expandedRows = ref(new Set<number>());
const statusExpanded = ref(false);
const resultExpanded = ref(false);
const failureExpanded = ref(false);
const eventTexts = computed(() => {
  const texts = new Map<number, string>();
  visibleEvents.value.forEach((event, index) => {
    const position = page.value * PAGE_SIZE + index;
    if (event.type === 'message' || expandedRows.value.has(position)) texts.set(position, eventText(event));
  });
  return texts;
});

function toggleRow(position: number) {
  if (expandedRows.value.has(position)) expandedRows.value.delete(position);
  else expandedRows.value.add(position);
  // Evict collapsed row content even before the template updates.
  void eventTexts.value;
}

function toggleResult() {
  resultExpanded.value = !resultExpanded.value;
  void resultText.value;
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
    void eventTexts.value;
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
  if (!resultExpanded.value) return '';
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
    </div>
    <div v-if="expanded" :id="`run-activity-${runId}`" class="mt-3 flex flex-col gap-3" :aria-busy="loading">
      <p v-if="loading" role="status" class="text-xs text-[var(--text-secondary)]">Loading run activity…</p>
      <div v-if="error" role="alert" class="text-sm text-[var(--text-secondary)]">
        <p>{{ error }}</p>
        <Button v-if="inspector" variant="secondary" size="sm" class="mt-2 min-h-[44px]" :disabled="loading" @click="load">Retry activity</Button>
      </div>
      <template v-if="run">
        <section data-run-status class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
          <Button variant="ghost" size="sm" class="min-h-[44px]" :aria-expanded="statusExpanded" :aria-controls="`run-activity-${runId}-status`" @click="statusExpanded = !statusExpanded">
            Run status · {{ statusExpanded ? 'Hide' : 'Show' }}
          </Button>
          <div :id="`run-activity-${runId}-status`" :hidden="!statusExpanded">
            <p v-if="statusExpanded" class="mt-2 text-xs text-[var(--text-secondary)]">
              {{ run.status }} · {{ duration }} · {{ run.tokenUsage ? `${run.tokenUsage.totalTokens.toLocaleString('en-US')} tokens` : 'Tokens unavailable' }}
            </p>
          </div>
        </section>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h4 class="text-xs font-bold">Activity stream</h4>
          <Button variant="ghost" size="sm" class="min-h-[44px]" :disabled="loading" @click="load">Refresh run</Button>
        </div>
        <p v-if="loading || error" class="text-xs text-[var(--text-muted)]">Showing the last loaded run.</p>
        <p v-if="!eventCount" class="text-xs text-[var(--text-muted)]">No activity events recorded.</p>
        <template v-else>
          <p class="text-xs text-[var(--text-muted)]" role="status">Events {{ page * PAGE_SIZE + 1 }}–{{ Math.min((page + 1) * PAGE_SIZE, eventCount) }} of {{ eventCount }} · Recorded order</p>
          <ol class="max-h-80 overflow-y-auto rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 text-xs font-mono" aria-label="Run activity events" tabindex="0">
            <li v-for="(event, index) in visibleEvents" :key="page * PAGE_SIZE + index" data-run-event class="border-b border-[var(--border-subtle)] py-2 last:border-0">
              <template v-if="event.type === 'message'">
                <span class="text-[var(--text-muted)]">[{{ eventTime(event) }}] {{ event.type }}</span>
                <p class="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{{ eventTexts.get(page * PAGE_SIZE + index) }}</p>
              </template>
              <template v-else>
                <Button variant="ghost" size="sm" class="min-h-[44px] max-w-full whitespace-normal text-left [overflow-wrap:anywhere]" :aria-expanded="expandedRows.has(page * PAGE_SIZE + index)" :aria-controls="`run-activity-${runId}-event-${page * PAGE_SIZE + index}`" @click="toggleRow(page * PAGE_SIZE + index)">
                  [{{ eventTime(event) }}] {{ event.type }} · {{ expandedRows.has(page * PAGE_SIZE + index) ? 'Hide' : 'Show' }}
                </Button>
                <div :id="`run-activity-${runId}-event-${page * PAGE_SIZE + index}`" :hidden="!expandedRows.has(page * PAGE_SIZE + index)">
                  <p v-if="expandedRows.has(page * PAGE_SIZE + index)" class="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{{ eventTexts.get(page * PAGE_SIZE + index) }}</p>
                </div>
              </template>
            </li>
          </ol>
          <div v-if="eventCount > PAGE_SIZE" class="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" class="min-h-[44px]" :disabled="page === 0" @click="page -= 1">Previous events</Button>
            <Button variant="secondary" size="sm" class="min-h-[44px]" :disabled="(page + 1) * PAGE_SIZE >= eventCount" @click="page += 1">Next events</Button>
          </div>
        </template>
        <section data-run-result class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
          <Button variant="ghost" size="sm" class="min-h-[44px]" :aria-expanded="resultExpanded" :aria-controls="`run-activity-${runId}-result`" @click="toggleResult">
            Final result · {{ resultExpanded ? 'Hide' : 'Show' }}
          </Button>
          <div :id="`run-activity-${runId}-result`" :hidden="!resultExpanded">
            <template v-if="resultExpanded">
              <p v-if="resultText" class="mt-2 text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{{ resultText }}</p>
              <p v-else class="mt-2 text-xs text-[var(--text-muted)]">No final result recorded.</p>
            </template>
          </div>
        </section>
        <section v-if="run.failure" data-run-failure class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
          <Button variant="ghost" size="sm" class="min-h-[44px]" :aria-expanded="failureExpanded" :aria-controls="`run-activity-${runId}-failure`" @click="failureExpanded = !failureExpanded">
            Failure · {{ failureExpanded ? 'Hide' : 'Show' }}
          </Button>
          <div :id="`run-activity-${runId}-failure`" :hidden="!failureExpanded">
            <p v-if="failureExpanded" class="mt-2 text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{{ run.failure }}</p>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>
