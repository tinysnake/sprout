<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { RoutingBatchDetailView, RoutingBatchSummaryView } from '../../../adapters/routing-api.ts';
import { BrowserRequestError } from '../../../transport/browser-transport.ts';
import { useShellConnection } from '../../../shell/use-shell-connection.ts';
import { CHAT_SERVICE } from '../types.ts';
import { useAnnouncer } from '../../../primitives/announcer.ts';
import Button from '../../../primitives/Button.vue';
import EmptyState from '../../../primitives/EmptyState.vue';

const service = inject(CHAT_SERVICE, null);
const route = useRoute();
const router = useRouter();
const announcer = useAnnouncer();
const { presentation } = useShellConnection();
const loading = ref(true);
const notFound = ref(false);
const unavailable = ref(false);
const siblingsError = ref(false);
const detail = ref<RoutingBatchDetailView | null>(null);
const siblings = ref<readonly RoutingBatchSummaryView[]>([]);
let generation = 0;
const batchId = computed(() => typeof route.params['batchId'] === 'string' ? route.params['batchId'] as string : '');
const attempt = computed(() => typeof route.query['attempt'] === 'string' ? route.query['attempt'] as string : '');
const selectedAttempt = computed(() => detail.value?.attempts.find((item) => item.id === attempt.value || String(item.attemptNumber) === attempt.value));
const attemptMissing = computed(() => !!attempt.value && !loading.value && !notFound.value && !selectedAttempt.value);
const returnLocation = computed(() => typeof route.query['from'] === 'string' ? { name: 'project-chat-scope', params: { scopeId: route.query['from'] as string }, query: typeof route.query['project'] === 'string' ? { project: route.query['project'] } : {} } : { name: 'project-chat', query: typeof route.query['project'] === 'string' ? { project: route.query['project'] } : {} });
async function load() {
  const token = ++generation;
  loading.value = true;
  notFound.value = false;
  unavailable.value = false;
  siblingsError.value = false;
  detail.value = null;
  if (!service) { unavailable.value = true; loading.value = false; return; }
  if (!batchId.value) { notFound.value = true; loading.value = false; return; }
  try {
    const record = await service.getRoutingBatch(batchId.value);
    if (token !== generation) return;
    // Never substitute the first or most recent batch for the URL's identity.
    if (record.batch.id !== batchId.value) { notFound.value = true; return; }
    detail.value = record;
    try { siblings.value = (await service.listRoutingBatches(record.batch.projectId)).batches; }
    catch { siblings.value = []; siblingsError.value = true; }
    announcer.announce(`Causal routing inspector for ${batchId.value}.`);
  } catch (error) {
    if (token === generation) {
      if (error instanceof BrowserRequestError && error.status === 404) notFound.value = true;
      else unavailable.value = true;
    }
  }
  finally { if (token === generation) { loading.value = false; if (detail.value) await focusTarget(); } }
}
watch(batchId, () => { void load(); }, { immediate: true });
watch(attempt, () => { if (!loading.value) void focusTarget(); });
async function focusTarget() {
  await nextTick();
  const target = selectedAttempt.value
    ? [...document.querySelectorAll<HTMLElement>('[data-attempt-id]')].find((item) => item.dataset['attemptId'] === selectedAttempt.value?.id)
    : attemptMissing.value ? document.querySelector<HTMLElement>('.routing-attempt-not-found') : undefined;
  const focused = target ?? document.querySelector<HTMLElement>('.routing-inspector-heading');
  focused?.focus();
  target?.scrollIntoView?.({ block: 'nearest' });
}
function selectBatch(event: Event) { const id = (event.target as HTMLSelectElement).value; if (id) void router.push({ name: 'project-chat-routing', params: { batchId: id }, query: { ...route.query, attempt: undefined } }); }
function back() { void router.push(returnLocation.value); }
function timestamp(at?: number) { return at ? new Date(at).toLocaleString() : 'not settled'; }
function statusLabel(status: string) { return status === 'failed' ? 'Failed closed — no Agent woken' : status === 'suppressed' ? 'Suppressed — no Agent selected' : status === 'frozen' ? 'Frozen — awaiting judgement' : status === 'routed' ? 'Routed' : status; }
</script>

<template>
  <main class="routing-inspector-view h-full overflow-y-auto bg-[var(--bg-app)] p-3 sm:p-6" :data-inspector-state="loading ? 'loading' : notFound ? 'not-found' : unavailable ? 'unavailable' : attemptMissing ? 'attempt-not-found' : 'ready'">
    <div v-if="loading" role="status" aria-busy="true" class="p-6 text-sm">Loading causal routing evidence…</div>
    <div v-else-if="notFound" class="routing-not-found-state m-auto max-w-xl rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-8 text-center">
      <EmptyState icon="alert" title="Routing Batch Not Found" description="No authoritative routing batch matches this URL. Nothing else has been substituted." />
      <Button variant="primary" size="sm" class="min-h-11" @click="back">Back to Conversations</Button>
    </div>
    <div v-else-if="unavailable" class="routing-unavailable-state m-auto max-w-xl rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-8 text-center" role="status">
      <h1 class="text-base font-bold">Routing Evidence Unavailable</h1><p class="my-3">{{ presentation.label }}. The requested batch could not be verified; it has not been replaced by another batch. Shown facts may be stale.</p>
      <Button variant="secondary" size="sm" class="min-h-11" @click="load">Retry inspection</Button>
    </div>
    <div v-else-if="detail" class="mx-auto flex max-w-3xl flex-col gap-3 text-xs text-[var(--text-secondary)]">
      <header class="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
        <div><h1 tabindex="-1" class="routing-inspector-heading text-base font-bold text-[var(--text-primary)]">Causal Wake Routing Inspector</h1><p>Durable causal evidence &amp; privacy boundaries</p></div>
        <Button variant="secondary" size="sm" class="min-h-11" @click="back">Back to Conversations</Button>
      </header>
      <div v-if="attemptMissing" tabindex="-1" class="routing-attempt-not-found rounded border border-[var(--red-action)] bg-[var(--bg-surface)] p-3" role="alert">Attempt {{ attempt }} was not found in batch {{ detail.batch.id }}. The batch below is shown without substituting another attempt.</div>
      <div v-if="siblings.length" class="flex items-center gap-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3"><label for="routing-batch-select" class="font-bold">Select Batch:</label><select id="routing-batch-select" :value="detail.batch.id" class="min-h-11 min-w-0 flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2" @change="selectBatch"><option v-for="item in siblings" :key="item.id" :value="item.id">{{ item.id }} ({{ statusLabel(item.status) }})</option></select></div>
      <p v-if="siblingsError" role="status" class="rounded border border-[var(--border-subtle)] p-3">The Project batch list is unavailable; this exact batch remains inspectable.</p>
      <section class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4" aria-label="Batch execution summary">
        <h2 class="font-bold text-[var(--text-primary)]">Batch ID: <code>{{ detail.batch.id }}</code></h2>
        <p>Project: <code>{{ detail.batch.projectId }}</code></p>
        <p class="font-semibold">{{ statusLabel(detail.batch.status) }}</p>
        <p>Collection Window: {{ timestamp(detail.window?.openedAt) }} → {{ timestamp(detail.window?.closedAt) }} ({{ detail.window?.intervalMs ?? 0 }} ms fixed window)</p>
        <p>Split {{ detail.batch.splitIndex + 1 }} of {{ detail.batch.splitCount }} · Inputs: {{ detail.inputs.length }} · Attempts: {{ detail.attempts.length }}</p>
        <p v-if="detail.batch.status === 'failed'">Routing failed closed. The original inputs remain durable; no manual retry or wake is offered here.</p>
      </section>
      <section class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4" aria-label="Frozen context bounds and privacy">
        <h2 class="font-bold text-[var(--text-primary)]">Frozen Context Bounds &amp; Privacy Guarantee</h2>
        <p>Context characters: {{ detail.batch.contextChars }} · Input bound: {{ detail.batch.bounds.inputContentChars }} · Recent message bound: {{ detail.batch.bounds.recentContextMessages }} · Total bound: {{ detail.batch.bounds.totalContextChars }}</p>
        <strong>Strict exclusions:</strong><ul class="list-inside list-disc"><li v-for="exclusion in detail.batch.manifest.exclusions" :key="exclusion">{{ exclusion }}</li></ul>
      </section>
      <section class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4" aria-label="Frozen batch inputs"><h2 class="font-bold text-[var(--text-primary)]">Inputs in Batch</h2><div v-for="input in detail.inputs" :key="input.inputId" class="mt-2 rounded border border-[var(--border-subtle)] p-2"><code>{{ input.inputId }}</code> · {{ input.excerptChars }} of {{ input.contentChars }} characters<span v-if="input.truncated"> · Bounded excerpt (truncated)</span><p class="whitespace-pre-wrap break-words">{{ input.excerpt }}</p></div></section>
      <section class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4" aria-label="Attempt history"><h2 class="font-bold text-[var(--text-primary)]">Attempt History &amp; Automatic Retry ({{ detail.attempts.length }})</h2>
        <p v-if="!detail.attempts.length">No judgement attempt has been recorded; this batch is pending.</p>
        <div v-for="item in detail.attempts" :key="item.id" tabindex="-1" :data-attempt-id="item.id" class="mt-2 rounded border p-2" :class="selectedAttempt?.id === item.id ? 'border-[var(--accent-primary)] ring-2 ring-[var(--accent-primary)]' : 'border-[var(--border-subtle)]'">
          <strong>Attempt #{{ item.attemptNumber }} · {{ item.status }}</strong><p>Model: {{ item.modelId }} · {{ timestamp(item.startedAt) }} → {{ timestamp(item.finishedAt) }}</p><p v-if="item.errorKind">{{ item.errorKind }}<span v-if="item.errorDetail"> · {{ item.errorDetail }}</span></p>
        </div>
      </section>
      <section class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4" aria-label="Wake decisions and causal rationale"><h2 class="font-bold text-[var(--text-primary)]">Wake Decisions &amp; Causal Rationale ({{ detail.outcomes.length }})</h2><p v-if="!detail.outcomes.length">Collection window active; wake-model evaluation begins when the window closes.</p>
        <div v-for="outcome in detail.outcomes" :key="outcome.inputId" class="mt-2 rounded border border-[var(--border-subtle)] p-2"><strong>Input: {{ outcome.inputId }} · {{ statusLabel(outcome.status) }}</strong><p v-if="outcome.rationale">{{ outcome.rationale }} <em>[Model judgement, not fact]</em></p><p v-if="outcome.detail">{{ outcome.detail }}</p><p v-for="assignment in outcome.assignments" :key="assignment.agentId">@{{ assignment.agentId }}: {{ assignment.rationale }} <em>[Model judgement, not fact]</em></p></div>
      </section>
      <section class="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4" aria-label="Wake requests and projected replies"><h2 class="font-bold text-[var(--text-primary)]">Resulting WakeRequests &amp; Run Admission</h2><p v-if="!detail.wakes.length">No WakeRequests admitted.</p><p v-for="wake in detail.wakes" :key="`${wake.agentId}-${wake.runId}`">@{{ wake.agentId }} · {{ wake.reason }} · {{ wake.status }} · Run: {{ wake.runId ?? 'none' }}</p><h3 class="mt-2 font-bold">Projected Replies</h3><p v-if="!detail.replies.length">No reply projected for this batch.</p><p v-for="reply in detail.replies" :key="reply.idempotencyKey">Message: <code>{{ reply.messageId }}</code> · Delivery: <code>{{ reply.idempotencyKey }}</code> · Non-routing</p></section>
      <p class="pb-4 text-center text-[var(--text-muted)]">Observational causal evidence only. No manual “Route now” or “Retry routing” controls are available.</p>
    </div>
  </main>
</template>
