<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import Icon from '../primitives/Icon.vue';
import UsageBackingTable from '../modules/usage/UsageBackingTable.vue';
import Badge from '../primitives/Badge.vue';
import EmptyState from '../primitives/EmptyState.vue';
import {
  USAGE_SERVICE,
  type UsageManagementService,
  type UsageActivityItem,
  type UsageTab,
  type UsageSettlementRange,
  type UsageProjectOption,
  type UsageAgentOption,
} from '../modules/usage/types.ts';
import '../modules/usage/usage.css';
import { emptyUsageAggregate, type UsageAggregate } from '../../../src/usage/model.ts';
import type { UsageAggregateFilter } from '../../../src/usage/store.ts';
import { mapObservationToItem } from '../modules/usage/adapters/production-adapter.ts';
import { sanitizeOperatorText } from '../../../src/environment/privacy.ts';

// Escape markup via Vue and redact operator/telemetry prose at the display boundary.
// Keep query identities untouched: presentation redaction must not change attribution.
function displayText(value: unknown): string {
  return sanitizeOperatorText(value == null ? '' : String(value), { fallback: '', maxLength: 4000 });
}

const props = defineProps<{
  service?: UsageManagementService;
}>();

const injectedService = inject<UsageManagementService | undefined>(USAGE_SERVICE, undefined);
const activeService = computed(() => props.service ?? injectedService);

const route = useRoute();

const activeTab = ref<UsageTab>('run');
const timeRangeFilter = ref<UsageSettlementRange>('all');
const projectFilter = ref<string>('all');
const agentFilter = ref<string>('all');
const modelFilter = ref<string>('all');
const selectedActivityId = ref<string | undefined>(undefined);

const activities = ref<readonly UsageActivityItem[]>([]);
const projects = ref<readonly UsageProjectOption[]>([]);
const agents = ref<readonly UsageAgentOption[]>([]);
const models = ref<readonly string[]>([]);
// DOM option values are opaque indexes; raw model telemetry stays in query state only.
const modelSelection = computed({
  get: () => modelFilter.value === 'all' ? 'all' : String(models.value.indexOf(modelFilter.value)),
  set: (value: string) => { modelFilter.value = value === 'all' ? 'all' : models.value[Number(value)] ?? 'all'; },
});
const isLoading = ref(true);
const queryError = ref(false);
const listIncomplete = ref(false);
const authoritativeActivities = ref(new Map<string, UsageAggregate>());
const scopedActivityIds = ref(new Set<string>());
let loadGeneration = 0;

const tabLabels: Record<UsageTab, string> = {
  run: 'Agent run',
  task: 'Task',
  project: 'Project',
  agent: 'Agent',
  model: 'Model',
  time: 'Time range',
};

const rangeRank: Record<string, number> = {
  today: 0,
  '7d': 1,
  '30d': 2,
  all: 3,
};

async function loadData() {
  const service = activeService.value;
  if (!service) {
    isLoading.value = false;
    return;
  }

  const generation = ++loadGeneration;
  isLoading.value = true;
  queryError.value = false;
  activities.value = [];
  authoritativeActivities.value = new Map();
  const to = Date.now() + 1;
  const days = { today: 1, '7d': 7, '30d': 30 };
  const filter: UsageAggregateFilter = {
    projectId: projectFilter.value === 'all' ? undefined : projectFilter.value,
    agentId: agentFilter.value === 'all' ? undefined : agentFilter.value,
    model: modelFilter.value === 'all' ? undefined : modelFilter.value,
    timeZone: 'UTC',
    ...(timeRangeFilter.value === 'all' ? {} : { from: to - days[timeRangeFilter.value] * 86400000, to }),
  };
  try {
    const [overview, scope, fetchedActivities, fetchedProjects, fetchedAgents, fetchedModels] = await Promise.all([
      service.getAggregate(filter),
      service.getAggregate({ ...filter,
        kind: ['run', 'task', 'agent'].includes(activeTab.value) ? 'agent_run' : undefined,
        groupBy: activeTab.value === 'time' ? undefined : activeTab.value,
      }),
      service.listActivities(filter),
      service.listProjects(), service.listAgents(), service.listModels(),
    ]);
    // The aggregate's identities, not a potentially paginated list, define the constituents.
    const identities = [...overview.activityIdentities, ...(overview.provisionalTotals?.activityIdentities ?? [])];
    const items = new Map(fetchedActivities.map(item => [item.id, item]));
    const missing = identities.filter(identity => !items.has(identity.activityId));
    const recovered = await Promise.all(missing.map(async identity => {
      const detail = await service.getActivityDetail(identity.activityId);
      return detail ? mapObservationToItem(detail.activity, detail.effectiveObservation, detail.supersessionHistory) : undefined;
    }));
    if (recovered.some(item => !item)) throw new Error('Aggregate constituent detail unavailable');
    recovered.forEach(item => { if (item) items.set(item.id, item); });
    const totals = await Promise.all(identities.map(async identity => {
      // Per-constituent authority preserves full model identity when a model-name aggregate mixes sources.
      const identityFilter = identity.kind === 'agent_run'
        ? { runId: identity.runId } : { attemptId: identity.attemptId };
      if (!identityFilter.runId && !('attemptId' in identityFilter && identityFilter.attemptId)) {
        throw new Error('Aggregate constituent lacks a query identity');
      }
      const aggregate = await service.getAggregate({ ...filter, ...identityFilter, kind: identity.kind, provisional: identity.status === 'active' });
      return [identity.activityId, aggregate] as const;
    }));
    if (generation !== loadGeneration) return;
    scopedActivityIds.value = new Set([...scope.activityIdentities, ...(scope.provisionalTotals?.activityIdentities ?? [])].map(identity => identity.activityId));
    listIncomplete.value = missing.length > 0;
    activities.value = identities.flatMap(identity => items.has(identity.activityId) ? [items.get(identity.activityId)!] : []);
    authoritativeActivities.value = new Map(totals);
    projects.value = fetchedProjects;
    agents.value = fetchedAgents;
    models.value = fetchedModels;
  } catch {
    if (generation === loadGeneration) queryError.value = true;
  } finally {
    if (generation === loadGeneration) isLoading.value = false;
  }
}

onMounted(() => {
  loadData();
});

watch([activeService, activeTab, timeRangeFilter, projectFilter, agentFilter, modelFilter], () => {
  loadData();
});

// Formatters matching product prototype
function formatNumber(value: number | undefined): string {
  return value === undefined ? 'Unavailable' : value.toLocaleString();
}

function formatUsd(value: number | undefined): string {
  return value === undefined ? 'Unavailable' : `$${(value / 1_000_000).toFixed(4)}`;
}

function formatDuration(value: number | undefined, status: 'complete' | 'partial' | 'unavailable'): string {
  if (value === undefined) return status === 'partial' ? 'Unavailable observed' : 'Unavailable';
  const seconds = Math.round(value / 1000);
  const suffix = status === 'partial' ? ' observed' : status === 'unavailable' ? ' (incomplete; duration unavailable)' : '';
  if (seconds < 60) return `${seconds}s${suffix}`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${String(remainder).padStart(2, '0')}s${suffix}`;
}

function formatOutcome(activity: UsageActivityItem): string {
  if (activity.outcome === 'ongoing') return 'Ongoing';
  if (activity.outcome === 'interrupted') return 'Interrupted';
  if (activity.outcome === 'stopped') return 'Stopped';
  if (activity.outcome === 'failed') return 'Failed';
  return 'Completed';
}

function outcomeClass(activity: UsageActivityItem): string {
  if (activity.outcome === 'completed') return 'green';
  if (activity.outcome === 'ongoing') return 'blue';
  if (activity.outcome === 'stopped' || activity.outcome === 'interrupted') return 'yellow';
  return 'red';
}

function activityKindLabel(kind: UsageActivityItem['kind']): string {
  return kind === 'agent_run' ? 'Agent run' : 'Routing attempt';
}

function activityKindClass(kind: UsageActivityItem['kind']): string {
  return kind === 'agent_run' ? 'work' : 'routing';
}

function projectName(projectId: string): string {
  return displayText(projects.value.find((project) => project.id === projectId)?.displayName ?? projectId);
}

function agentName(agentId: string | undefined): string {
  if (!agentId) return 'No Agent owner';
  return displayText(agents.value.find((agent) => agent.id === agentId)?.displayName ?? agentId);
}

function modelLabel(activity: UsageActivityItem): string {
  return `${activity.provider ? `${displayText(activity.provider)} / ` : ''}${displayText(activity.model)}`;
}

function modelIdentityLabel(activity: UsageActivityItem): string {
  const identity = activity.modelIdentity;
  return `Source: ${displayText(identity.source)} / Provider: ${displayText(identity.provider)} / Version: ${displayText(identity.version)}`;
}

function modelGroupKey(activity: UsageActivityItem): string {
  return JSON.stringify([
    activity.kind,
    activity.engine ?? 'wake-model',
    activity.model,
    activity.modelIdentity.source,
    activity.modelIdentity.provider,
    activity.modelIdentity.version,
  ]);
}

function costLabel(activity: UsageActivityItem): string {
  const valuation = activity.costValuation;
  if (valuation.apiEquivalentStatus === 'available') {
    return `${formatUsd(valuation.estimatedUsdMicros)} API-equivalent`;
  }
  if (valuation.apiEquivalentStatus === 'pending') return 'Pending API-equivalent';
  return 'Unavailable API-equivalent';
}

function tokenSummary(activity: UsageActivityItem): string {
  const total = activity.tokenDimensions.total;
  if (activity.tokenDimensions.status === 'unavailable') return 'Tokens unavailable';
  if (total !== undefined) {
    return `${formatNumber(total)} tokens${activity.tokenDimensions.status === 'partial' ? ' observed' : ''}`;
  }
  return `${formatNumber(activity.tokenDimensions.totalInput)} input observed`;
}

function aggregateFor(acts: readonly UsageActivityItem[]): UsageAggregate {
  const totals = acts.map(item => authoritativeActivities.value.get(item.id)).filter((a): a is UsageAggregate => !!a);
  const sum = (values: (number | undefined)[]) => values.every(v => v === undefined) ? undefined : values.reduce<number>((n, v) => n + (v ?? 0), 0);
  const result = emptyUsageAggregate();
  const tokenCoverage = { complete: 0, partial: 0, unavailable: 0 };
  const costCoverage = { available: 0, pending: 0, unavailable: 0 };
  const byProvenance: UsageAggregate['cost']['byProvenance'] = {};
  for (const a of totals) {
    for (const key of ['complete', 'partial', 'unavailable'] as const) tokenCoverage[key] += a.tokenCoverage[key];
    for (const key of ['available', 'pending', 'unavailable'] as const) costCoverage[key] += a.costCoverage[key];
    for (const key of ['provider_estimated', 'harness_calculated', 'locally_estimated'] as const) {
      const value = a.cost.byProvenance[key];
      if (value !== undefined) byProvenance[key] = (byProvenance[key] ?? 0) + value;
    }
  }
  return {
    ...result, totalActivities: totals.reduce((n, a) => n + a.totalActivities, 0), tokenCoverage, costCoverage,
    totalSproutWallDurationMs: sum(totals.map(a => a.totalSproutWallDurationMs)),
    tokens: { totalTokens: sum(totals.map(a => a.tokens.totalTokens)), status: tokenCoverage.partial || tokenCoverage.unavailable ? 'observed_incomplete' : totals.length ? 'complete' : 'unavailable' },
    cost: { apiEquivalentUsdMicros: sum(totals.map(a => a.cost.apiEquivalentUsdMicros)), byProvenance, status: Object.keys(byProvenance).length > 1 ? 'mixed_provenance' : costCoverage.available ? 'single_provenance' : 'unavailable' },
  };
}

function coverageText(acts: readonly UsageActivityItem[]): string {
  const { complete, partial, unavailable } = aggregateFor(acts).tokenCoverage;
  return `${complete} complete / ${partial} partial / ${unavailable} unavailable token observations`;
}

function costCoverageText(acts: readonly UsageActivityItem[]): string {
  const { available, pending, unavailable } = aggregateFor(acts).costCoverage;
  return `${available} available / ${pending} pending / ${unavailable} unavailable estimates`;
}

const filteredActivities = computed(() => {
  return activities.value.filter((activity) => {
    const inRange =
      timeRangeFilter.value === 'all' ||
      (rangeRank[activity.settlementRange] ?? 99) <= (rangeRank[timeRangeFilter.value] ?? 99);
    const inProject = projectFilter.value === 'all' || activity.projectId === projectFilter.value;
    const inAgent = agentFilter.value === 'all' || activity.agentId === agentFilter.value;
    const inModel = modelFilter.value === 'all' || activity.model === modelFilter.value;
    return inRange && inProject && inAgent && inModel;
  });
});

const activeDetail = computed(() => {
  if (!selectedActivityId.value) return undefined;
  return activities.value.find((activity) => activity.id === selectedActivityId.value);
});

function toggleActivity(id: string) {
  selectedActivityId.value = selectedActivityId.value === id ? undefined : id;
}

function onTabKey(event: KeyboardEvent, tab: UsageTab) {
  const tabs = Object.keys(tabLabels) as UsageTab[];
  const current = tabs.indexOf(tab);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : event.key === 'ArrowRight' ? (current + 1) % tabs.length
    : event.key === 'ArrowLeft' ? (current + tabs.length - 1) % tabs.length : undefined;
  if (next === undefined) return;
  event.preventDefault();
  activeTab.value = tabs[next]!;
  selectedActivityId.value = undefined;
  const tablist = (event.currentTarget as HTMLElement).closest('[role="tablist"]');
  tablist?.querySelector<HTMLButtonElement>(`[data-usage-tab="${tabs[next]}"]`)?.focus();
}

function clearFilters() {
  timeRangeFilter.value = 'all';
  projectFilter.value = 'all';
  agentFilter.value = 'all';
  modelFilter.value = 'all';
  selectedActivityId.value = undefined;
}

function aggregateMetrics(acts: readonly UsageActivityItem[]) {
  const authority = aggregateFor(acts);
  const duration = authority.totalSproutWallDurationMs;
  const durationStatus =
    acts.length === 0 || duration === undefined
      ? ('unavailable' as const)
      : acts.some((activity) => activity.durationStatus === 'unavailable')
        ? ('unavailable' as const)
        : acts.some((activity) => activity.durationStatus === 'partial')
          ? ('partial' as const)
          : ('complete' as const);
  return {
    duration,
    durationStatus,
    tokens: authority.tokens.totalTokens,
    estimate: authority.cost.apiEquivalentUsdMicros,
  };
}

function splitOngoing(acts: readonly UsageActivityItem[]) {
  return {
    finalized: acts.filter((activity) => activity.outcome !== 'ongoing'),
    provisional: acts.filter((activity) => activity.outcome === 'ongoing'),
  };
}

function aggregateCoverageDetails(acts: readonly UsageActivityItem[]) {
  const authority = aggregateFor(acts);
  const { complete: tokenComplete, partial: tokenPartial, unavailable: tokenUnavailable } = authority.tokenCoverage;
  const durationKnown = acts.filter(
    (activity) => activity.durationStatus === 'complete' && activity.wallDurationMs !== undefined
  ).length;
  const durationPartial = acts.filter((activity) => activity.durationStatus === 'partial').length;
  const durationUnavailable = acts.filter((activity) => activity.durationStatus === 'unavailable').length;
  const { available: valuationAvailable, pending: valuationPending, unavailable: valuationUnavailable } = authority.costCoverage;
  const billedReported = acts.filter(
    (activity) => activity.costValuation.attributableBilledCostStatus !== 'unavailable'
  ).length;
  const billedUnavailable = acts.length - billedReported;

  const provenanceCounts = new Map(Object.entries(authority.cost.byProvenance));

  const provenanceLabels: Record<string, string> = {
    provider_estimated: 'provider-estimated',
    harness_calculated: 'harness-calculated',
    locally_estimated: 'locally-estimated',
  };
  const provenanceSummary = [...provenanceCounts.entries()]
    .map(([provenance, value]) => `${provenanceLabels[provenance] ?? provenance} ${formatUsd(value)} API-equivalent`)
    .join(' / ');
  const mixedProvenance = provenanceCounts.size > 1;

  return {
    tokenComplete,
    tokenPartial,
    tokenUnavailable,
    durationKnown,
    durationPartial,
    durationUnavailable,
    valuationAvailable,
    valuationPending,
    valuationUnavailable,
    billedReported,
    billedUnavailable,
    provenanceSummary: provenanceSummary || 'none available',
    mixedProvenance,
  };
}

// Work-model vs Routing attempt split
const workActivities = computed(() => filteredActivities.value.filter((a) => a.kind === 'agent_run'));
const routingActivities = computed(() => filteredActivities.value.filter((a) => a.kind === 'routing_attempt'));

// Scope-query constituents drive each tab; summary kinds remain separate across all retained activity.
const scopedActivities = computed(() => filteredActivities.value.filter(a => scopedActivityIds.value.has(a.id)));
const scopedWorkActivities = computed(() => scopedActivities.value.filter(a => a.kind === 'agent_run'));

// Groupings for views
const taskGroups = computed(() => {
  const groups = new Map<string, UsageActivityItem[]>();
  for (const activity of scopedWorkActivities.value) {
    const key = activity.taskId ?? 'unassigned';
    groups.set(key, [...(groups.get(key) ?? []), activity]);
  }
  return groups;
});

const projectGroups = computed(() => {
  const groups = new Map<string, UsageActivityItem[]>();
  for (const activity of scopedActivities.value) {
    groups.set(activity.projectId, [...(groups.get(activity.projectId) ?? []), activity]);
  }
  return groups;
});

const agentGroups = computed(() => {
  const groups = new Map<string, UsageActivityItem[]>();
  for (const activity of scopedWorkActivities.value) {
    if (!activity.agentId) continue;
    groups.set(activity.agentId, [...(groups.get(activity.agentId) ?? []), activity]);
  }
  return groups;
});

const modelGroups = computed(() => {
  const groups = new Map<string, UsageActivityItem[]>();
  for (const activity of scopedActivities.value) {
    const key = modelGroupKey(activity);
    groups.set(key, [...(groups.get(key) ?? []), activity]);
  }
  return groups;
});

const timeGroups = computed(() => {
  const groups = new Map<string, UsageActivityItem[]>();
  for (const activity of scopedActivities.value) {
    groups.set(activity.settlementRange, [...(groups.get(activity.settlementRange) ?? []), activity]);
  }
  return [...groups.entries()].sort(([a], [b]) => (rangeRank[a] ?? 99) - (rangeRank[b] ?? 99));
});

const backingActivities = computed(() => scopedActivities.value);
const backingAggregates = computed(() => {
  const entries: { label: string; acts: readonly UsageActivityItem[] }[] = [
    { label: 'Work-model Agent runs', acts: workActivities.value },
    { label: 'Project-owned Routing attempts', acts: routingActivities.value },
  ];
  const groups = activeTab.value === 'task' ? taskGroups.value
    : activeTab.value === 'project' ? projectGroups.value
    : activeTab.value === 'agent' ? agentGroups.value
    : activeTab.value === 'model' ? modelGroups.value
    : activeTab.value === 'time' ? new Map(timeGroups.value) : new Map<string, UsageActivityItem[]>();
  for (const [key, acts] of groups) {
    for (const kind of ['agent_run', 'routing_attempt'] as const) {
      const subset = acts.filter(a => a.kind === kind);
      if (subset.length) entries.push({ label: `${activeTab.value} ${displayText(key)} / ${activityKindLabel(kind)}`, acts: subset });
    }
  }
  return entries.flatMap(({ label, acts }) => [false, true].map(provisional => {
    const subset = provisional ? splitOngoing(acts).provisional : splitOngoing(acts).finalized;
    const metrics = aggregateMetrics(subset);
    return {
      label: `${label} — ${provisional ? 'Provisional observed so far' : 'Finalized'}`,
      duration: formatDuration(metrics.duration, metrics.durationStatus), tokens: formatNumber(metrics.tokens),
      estimate: `${formatUsd(metrics.estimate)} API-equivalent`,
      coverage: `Token coverage: ${coverageText(subset)}; ${costCoverageText(subset)}; Attributable billed cost: Unavailable`,
      provenance: aggregateCoverageDetails(subset).provenanceSummary,
    };
  }));
});

const timeRangeLabels: Record<string, string> = {
  today: 'Today',
  '7d': 'Previous 7 days',
  '30d': 'Previous 30 days',
  older: 'Earlier retained activity (beyond 30 days)',
};
</script>

<template>
  <div class="usage-view flex flex-col min-h-full bg-[var(--bg-app)]">
    <div class="p-4 sm:p-6 pb-28 md:pb-16 w-full max-w-[1920px] mx-auto flex flex-col gap-6 min-w-0">
      <!-- 1. Header (matches prototype & routes expectations) -->
      <header class="usage-page-header">
        <div>
          <h1>Usage &amp; Costs</h1>
          <p>Observe model activity with enough context to distinguish usage, estimates, bills, and gaps. Usage &amp; Cost Telemetry.</p>
        </div>
      </header>

      <!-- 2. Reading Note -->
      <section class="usage-reading-note" aria-label="Usage semantics">
        <div class="usage-reading-icon">
          <Icon name="chart" :size="18" />
        </div>
        <div>
          <strong class="text-[var(--text-primary)]">Known values stay useful without pretending to be complete.</strong>
          <span>Attributable billed cost is unavailable for these local interfaces. API-equivalent estimates name their provenance. Pending and unavailable observations remain visible.</span>
        </div>
      </section>

      <!-- Unavailable State when no authority is injected -->
      <div v-if="!activeService" class="usage-unavailable-state p-8 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col items-center justify-center gap-3 text-center">
        <Icon name="usage" :size="32" class="text-[var(--yellow-attention)]" />
        <strong class="text-base text-[var(--text-primary)]">Usage Service Unavailable</strong>
        <p class="text-xs text-[var(--text-secondary)] max-w-md">No authoritative usage service is connected. Production wiring provides a live usage adapter over the transport; tests inject an explicit authority.</p>
      </div>

      <template v-else>
      <p v-if="queryError" role="alert">Usage query unavailable. No local totals substituted.</p>
      <p v-if="isLoading" role="status">Loading authoritative usage…</p>
      <p v-if="listIncomplete" role="status">Activity list incomplete; totals use authoritative aggregate constituents, not the truncated list.</p>
      <p class="usage-boundary-note">Settlement ranges use UTC and half-open instant bounds. Known subtotals are observed, incomplete when coverage has gaps.</p>
      <!-- 3. Summary Band (Work-model Agent runs & Project-owned Routing attempts separate) -->
      <section class="usage-summary-band" aria-label="Usage summary">
        <!-- Work-model Agent runs -->
        <section class="usage-summary-kind" data-usage-summary-kind="agent_run">
          <div class="usage-summary-kind-heading">
            <strong>Work-model Agent runs</strong>
            <small>
              {{ splitOngoing(workActivities).finalized.length }} finalized
              <template v-if="splitOngoing(workActivities).provisional.length > 0">
                / {{ splitOngoing(workActivities).provisional.length }} provisional
              </template>
            </small>
          </div>
          <div class="usage-summary-kind-metrics" data-usage-summary-scope="finalized">
            <div>
              <span>Finalized model activity time</span>
              <strong>{{ formatDuration(aggregateMetrics(splitOngoing(workActivities).finalized).duration, aggregateMetrics(splitOngoing(workActivities).finalized).durationStatus) }} model time</strong>
              <small>Ongoing activity is not included</small>
            </div>
            <div>
              <span>Finalized known total tokens</span>
              <strong>{{ formatNumber(aggregateMetrics(splitOngoing(workActivities).finalized).tokens) }} tokens</strong>
              <small>{{ coverageText(splitOngoing(workActivities).finalized) }}</small>
            </div>
            <div>
              <span>Finalized API-equivalent estimate</span>
              <strong>{{ formatUsd(aggregateMetrics(splitOngoing(workActivities).finalized).estimate) }} available estimate</strong>
              <small>{{ costCoverageText(splitOngoing(workActivities).finalized) }}</small>
            </div>
          </div>
          <div
            v-if="splitOngoing(workActivities).provisional.length > 0"
            class="usage-summary-kind-provisional"
            data-usage-summary-scope="provisional"
          >
            <strong>Provisional observed so far</strong>
            <span>
              {{ formatDuration(aggregateMetrics(splitOngoing(workActivities).provisional).duration, aggregateMetrics(splitOngoing(workActivities).provisional).durationStatus) }} model time /
              {{ formatNumber(aggregateMetrics(splitOngoing(workActivities).provisional).tokens) }} tokens /
              {{ formatUsd(aggregateMetrics(splitOngoing(workActivities).provisional).estimate) }} available estimate
            </span>
            <small>{{ coverageText(splitOngoing(workActivities).provisional) }}; excluded from finalized arithmetic and links</small>
          </div>
        </section>

        <!-- Project-owned Routing attempts -->
        <section class="usage-summary-kind" data-usage-summary-kind="routing_attempt">
          <div class="usage-summary-kind-heading">
            <strong>Project-owned Routing attempts</strong>
            <small>
              {{ splitOngoing(routingActivities).finalized.length }} finalized
              <template v-if="splitOngoing(routingActivities).provisional.length > 0">
                / {{ splitOngoing(routingActivities).provisional.length }} provisional
              </template>
            </small>
          </div>
          <div class="usage-summary-kind-metrics" data-usage-summary-scope="finalized">
            <div>
              <span>Finalized model activity time</span>
              <strong>{{ formatDuration(aggregateMetrics(splitOngoing(routingActivities).finalized).duration, aggregateMetrics(splitOngoing(routingActivities).finalized).durationStatus) }} model time</strong>
              <small>Ongoing activity is not included</small>
            </div>
            <div>
              <span>Finalized known total tokens</span>
              <strong>{{ formatNumber(aggregateMetrics(splitOngoing(routingActivities).finalized).tokens) }} tokens</strong>
              <small>{{ coverageText(splitOngoing(routingActivities).finalized) }}</small>
            </div>
            <div>
              <span>Finalized API-equivalent estimate</span>
              <strong>{{ formatUsd(aggregateMetrics(splitOngoing(routingActivities).finalized).estimate) }} available estimate</strong>
              <small>{{ costCoverageText(splitOngoing(routingActivities).finalized) }}</small>
            </div>
          </div>
          <div
            v-if="splitOngoing(routingActivities).provisional.length > 0"
            class="usage-summary-kind-provisional"
            data-usage-summary-scope="provisional"
          >
            <strong>Provisional observed so far</strong>
            <span>
              {{ formatDuration(aggregateMetrics(splitOngoing(routingActivities).provisional).duration, aggregateMetrics(splitOngoing(routingActivities).provisional).durationStatus) }} model time /
              {{ formatNumber(aggregateMetrics(splitOngoing(routingActivities).provisional).tokens) }} tokens /
              {{ formatUsd(aggregateMetrics(splitOngoing(routingActivities).provisional).estimate) }} available estimate
            </span>
            <small>{{ coverageText(splitOngoing(routingActivities).provisional) }}; excluded from finalized arithmetic and links</small>
          </div>
        </section>
      </section>

      <!-- 4. Controls: 6-View Tabs and Filter Row -->
      <section class="usage-controls" aria-label="Usage views and filters">
        <div class="usage-view-tabs" role="tablist" aria-label="Usage view">
          <button
            v-for="(label, tab) in tabLabels"
            :key="tab"
            type="button"
            role="tab"
            class="usage-view-tab"
            :class="{ active: activeTab === tab }"
            :data-usage-tab="tab"
            :id="`usage-tab-${tab}`"
            :aria-selected="activeTab === tab"
            :tabindex="activeTab === tab ? 0 : -1"
            aria-controls="usage-tab-panel"
            @keydown="onTabKey($event, tab)"
            @click="activeTab = tab; selectedActivityId = undefined"
          >
            {{ label }}
          </button>
        </div>

        <div class="usage-filter-row">
          <label>
            Time range
            <select
              v-model="timeRangeFilter"
              class="usage-filter-select"
              data-usage-filter="timeRange"
              @change="selectedActivityId = undefined"
            >
              <option value="today">Today</option>
              <option value="7d">Previous 7 days</option>
              <option value="30d">Previous 30 days</option>
              <option value="all">All retained activity</option>
            </select>
          </label>

          <label>
            Project
            <select
              v-model="projectFilter"
              class="usage-filter-select"
              data-usage-filter="projectId"
              @change="selectedActivityId = undefined"
            >
              <option value="all">All Projects</option>
              <option v-for="p in projects" :key="p.id" :value="p.id">{{ displayText(p.displayName) }}</option>
            </select>
          </label>

          <label>
            Agent
            <select
              v-model="agentFilter"
              class="usage-filter-select"
              data-usage-filter="agentId"
              @change="selectedActivityId = undefined"
            >
              <option value="all">All Agents</option>
              <option v-for="a in agents" :key="a.id" :value="a.id">{{ displayText(a.displayName) }}</option>
            </select>
          </label>

          <label>
            Model
            <select
              v-model="modelSelection"
              class="usage-filter-select"
              data-usage-filter="model"
              @change="selectedActivityId = undefined"
            >
              <option value="all">All Models</option>
              <option v-for="(m, index) in models" :key="index" :value="String(index)">{{ displayText(m) }}</option>
            </select>
          </label>

          <button
            type="button"
            class="usage-clear-filters px-3 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] cursor-pointer"
            @click="clearFilters"
          >
            Clear filters
          </button>
        </div>
      </section>

      <!-- 5. Coverage Strip -->
      <section class="usage-coverage-strip" aria-label="Telemetry coverage">
        <div>
          <strong>Work-model coverage</strong>
          <span>{{ coverageText(workActivities) }} / {{ costCoverageText(workActivities) }}</span>
        </div>
        <div>
          <strong>Routing-attempt coverage</strong>
          <span>{{ coverageText(routingActivities) }} / {{ costCoverageText(routingActivities) }}</span>
        </div>
        <div>
          <strong>Billed cost</strong>
          <span>Unavailable for {{ workActivities.length }} work-model / {{ routingActivities.length }} routing activities</span>
        </div>
      </section>

      <!-- 6. Tab Surfaces -->
      <section id="usage-tab-panel" class="usage-tab-surface" role="tabpanel" :aria-labelledby="`usage-tab-${activeTab}`" :aria-label="`${tabLabels[activeTab]} view`">
        <!-- 6a. Empty State -->
        <div v-if="filteredActivities.length === 0" class="usage-empty-state">
          <span class="usage-empty-icon">
            <Icon name="search" :size="24" />
          </span>
          <strong>No usage activities match these filters.</strong>
          <span>Clear a scope filter or widen the time range. No missing activity is treated as zero.</span>
          <button
            type="button"
            class="usage-clear-filters mt-2 px-3 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] text-xs font-semibold text-[var(--text-primary)] cursor-pointer"
            @click="clearFilters"
          >
            Clear filters
          </button>
        </div>

        <!-- 6b. Run View: Agent runs only -->
        <div v-else-if="activeTab === 'run'" class="usage-list-section">
          <div class="usage-list-heading">
            <div>
              <h3>Agent runs</h3>
              <p>Each row is one work-model Agent run only. Project-owned Routing attempts remain in their Project and routing views.</p>
            </div>
            <span>{{ workActivities.length }} shown</span>
          </div>

          <div v-if="workActivities.length === 0" class="usage-empty-state">
            <strong>No Agent run activities match these filters.</strong>
            <button type="button" class="usage-clear-filters mt-2" @click="clearFilters">Clear filters</button>
          </div>

          <div v-else class="usage-activity-list" role="table" aria-label="Agent runs usage table">
            <div
              v-for="activity in scopedWorkActivities"
              :key="activity.id"
              class="usage-activity-item"
              :class="{ open: selectedActivityId === activity.id }"
              role="row"
            >
              <button
                type="button"
                class="usage-activity-row"
                :class="{ selected: selectedActivityId === activity.id }"
                :data-usage-activity="activity.id"
                :aria-expanded="selectedActivityId === activity.id"
                @click="toggleActivity(activity.id)"
              >
                <span class="usage-row-main">
                  <span class="usage-row-title">
                    <span class="usage-kind-mark" :class="activityKindClass(activity.kind)" aria-hidden="true" />
                    <strong>{{ activity.id }}</strong>
                    <span class="status-pill" :class="outcomeClass(activity)">{{ formatOutcome(activity) }}</span>
                  </span>
                  <span class="usage-row-subtitle">
                    {{ activityKindLabel(activity.kind) }} / {{ agentName(activity.agentId) }} / {{ modelLabel(activity) }}
                  </span>
                </span>
                <span class="usage-row-metric">
                  <span>{{ tokenSummary(activity) }}</span>
                  <small>{{ formatDuration(activity.wallDurationMs, activity.durationStatus) }}</small>
                </span>
                <span class="usage-row-cost">
                  <strong>{{ costLabel(activity) }}</strong>
                  <small>{{ displayText(activity.costValuation.provenance?.replaceAll('_', ' ') ?? 'No valuation provenance') }}</small>
                </span>
                <span class="usage-row-chevron" aria-hidden="true">
                  <Icon name="chevron-right" :size="14" />
                </span>
              </button>

              <!-- Inline foldable detail panel -->
              <div v-if="selectedActivityId === activity.id" class="usage-detail-panel" aria-label="Activity details">
                <div class="usage-detail-header">
                  <div>
                    <span class="usage-section-kicker">Activity detail</span>
                    <h3>
                      {{ activity.id }}
                      <span class="status-pill" :class="outcomeClass(activity)">{{ formatOutcome(activity) }}</span>
                    </h3>
                    <p>{{ activityKindLabel(activity.kind) }} / {{ projectName(activity.projectId) }} / {{ displayText(activity.activityTime) }}</p>
                  </div>
                </div>

                <div class="usage-detail-grid">
                  <div class="usage-detail-block">
                    <h4>Attribution</h4>
                    <dl class="usage-fact-list">
                      <div><dt>Activity kind</dt><dd>{{ activityKindLabel(activity.kind) }}</dd></div>
                      <div><dt>Project</dt><dd>{{ projectName(activity.projectId) }}</dd></div>
                      <div><dt>Task</dt><dd>{{ displayText(activity.taskId ?? 'Not applicable') }}</dd></div>
                      <div><dt>Agent</dt><dd>{{ agentName(activity.agentId) }}</dd></div>
                      <div><dt>Model</dt><dd>{{ modelLabel(activity) }}</dd></div>
                      <div><dt>Model source</dt><dd>{{ displayText(activity.modelIdentity.source) }}</dd></div>
                      <div><dt>Model provider</dt><dd>{{ displayText(activity.modelIdentity.provider) }}</dd></div>
                      <div><dt>Model version</dt><dd>{{ displayText(activity.modelIdentity.version) }}</dd></div>
                      <div><dt>Session</dt><dd>{{ displayText(activity.sessionMode === 'resumed' ? 'Resumed invocation' : 'New invocation') }}</dd></div>
                    </dl>
                  </div>

                  <div class="usage-detail-block">
                    <h4>Duration and outcome</h4>
                    <dl class="usage-fact-list">
                      <div><dt>Model activity duration</dt><dd>{{ formatDuration(activity.wallDurationMs, activity.durationStatus) }}</dd></div>
                      <div><dt>Duration source</dt><dd>{{ displayText(activity.durationSource) }}</dd></div>
                      <div><dt>Engine duration</dt><dd>{{ displayText(activity.engineDurationMs === undefined ? 'Not reported' : formatDuration(activity.engineDurationMs, 'complete')) }}</dd></div>
                      <div><dt>Outcome</dt><dd>{{ formatOutcome(activity) }}</dd></div>
                      <div><dt>Outcome note</dt><dd>{{ displayText(activity.outcomeReason ?? 'No additional outcome note.') }}</dd></div>
                    </dl>
                  </div>

                  <div class="usage-detail-block">
                    <h4>Token dimensions</h4>
                    <p class="usage-source-note">{{ displayText(activity.tokenDimensions.source) }} / {{ displayText(activity.tokenDimensions.status) }} measurement; provider or engine fact, not a local estimate</p>
                    <dl class="usage-fact-list token-facts">
                      <div><dt>Total input</dt><dd>{{ formatNumber(activity.tokenDimensions.totalInput) }}</dd></div>
                      <div><dt>Uncached input</dt><dd>{{ formatNumber(activity.tokenDimensions.uncachedInput) }}</dd></div>
                      <div><dt>Cached reads</dt><dd>{{ formatNumber(activity.tokenDimensions.cachedReads) }}</dd></div>
                      <div><dt>Cache write</dt><dd>{{ formatNumber(activity.tokenDimensions.cacheWrite) }}</dd></div>
                      <div><dt>Output</dt><dd>{{ formatNumber(activity.tokenDimensions.output) }}</dd></div>
                      <div><dt>Reasoning output</dt><dd>{{ formatNumber(activity.tokenDimensions.reasoningOutput) }} <small>subset of output</small></dd></div>
                      <div><dt>Provider or engine total</dt><dd>{{ formatNumber(activity.tokenDimensions.total) }}</dd></div>
                    </dl>
                  </div>

                  <div class="usage-detail-block">
                    <h4>Cost facts</h4>
                    <dl class="usage-fact-list">
                      <div><dt>Attributable billed cost</dt><dd class="unavailable-value">Unavailable</dd></div>
                      <div><dt>Why billed cost is unavailable</dt><dd>No settled per-activity provider invoice is exposed by this interface.</dd></div>
                      <div><dt>API-equivalent estimate</dt><dd>{{ costLabel(activity) }}</dd></div>
                      <div><dt>Valuation provenance</dt><dd>{{ displayText(activity.costValuation.provenance?.replaceAll('_', ' ') ?? 'Unavailable') }}</dd></div>
                      <div><dt>Billing basis</dt><dd>{{ displayText(activity.costValuation.billingBasis.replaceAll('_', ' ')) }}</dd></div>
                      <div><dt>Valuation source</dt><dd>{{ displayText(activity.costValuation.source ?? 'Unavailable') }}</dd></div>
                      <div><dt>Coverage</dt><dd>{{ displayText(activity.costValuation.note) }}</dd></div>
                    </dl>
                  </div>
                </div>

                <div class="usage-detail-footer">
                  <strong>Measurement coverage</strong>
                  <span>{{ displayText(activity.coverageNote) }}</span>
                  <span class="usage-state-label" :class="activity.observationState">{{ displayText(activity.observationState) }}</span>
                </div>

                <details v-if="activity.observationHistory && activity.observationHistory.length > 0" class="usage-history-details">
                  <summary>Observation history and corrections ({{ activity.observationHistory.length }})</summary>
                  <div class="usage-history-list">
                    <div v-for="(entry, idx) in activity.observationHistory" :key="idx" class="usage-history-entry">
                      <div><strong>{{ displayText(entry.status) }}</strong> / {{ displayText(entry.timestamp) }}</div>
                      <div>{{ displayText(entry.source) }}</div>
                      <small>{{ displayText(entry.note) }}<template v-if="entry.supersedes"> Supersedes {{ displayText(entry.supersedes) }}.</template></small>
                      <span v-if="entry.usdMicros !== undefined">{{ formatUsd(entry.usdMicros) }} API-equivalent</span>
                      <span v-else>Value unavailable</span>
                    </div>
                  </div>
                </details>
              </div>
            </div>
          </div>
        </div>

        <!-- 6c. Task View -->
        <div v-else-if="activeTab === 'task'" class="usage-list-section">
          <div class="usage-list-heading">
            <div>
              <h3>Task aggregates</h3>
              <p>Nested Agent runs only. Task calendar time stays separate from model activity duration.</p>
            </div>
            <span>{{ taskGroups.size }} tasks</span>
          </div>

          <div class="usage-aggregate-list">
            <template v-for="[taskId, taskActs] in taskGroups.entries()" :key="taskId">
              <!-- Finalized Card -->
              <article
                v-if="splitOngoing(taskActs).finalized.length > 0"
                class="usage-aggregate-row"
                data-usage-provisional="false"
              >
                <div class="usage-aggregate-header">
                  <div>
                    <h3>Task {{ taskId }}</h3>
                    <p>Nested Agent work Finalized activities only.</p>
                  </div>
                  <div class="usage-aggregate-metrics">
                    <span>{{ formatDuration(aggregateMetrics(splitOngoing(taskActs).finalized).duration, aggregateMetrics(splitOngoing(taskActs).finalized).durationStatus) }} model time</span>
                    <span>{{ formatNumber(aggregateMetrics(splitOngoing(taskActs).finalized).tokens) }} tokens</span>
                    <span>{{ formatUsd(aggregateMetrics(splitOngoing(taskActs).finalized).estimate) }} available estimate</span>
                  </div>
                </div>

                <div class="usage-aggregate-coverage" aria-label="Aggregate coverage and provenance">
                  <div class="usage-coverage-summary">
                    <span>Token coverage: {{ aggregateCoverageDetails(splitOngoing(taskActs).finalized).tokenComplete }} complete / {{ aggregateCoverageDetails(splitOngoing(taskActs).finalized).tokenPartial }} partial / {{ aggregateCoverageDetails(splitOngoing(taskActs).finalized).tokenUnavailable }} unavailable</span>
                    <span>Duration coverage: {{ aggregateCoverageDetails(splitOngoing(taskActs).finalized).durationKnown }} known / {{ aggregateCoverageDetails(splitOngoing(taskActs).finalized).durationPartial }} partial / {{ aggregateCoverageDetails(splitOngoing(taskActs).finalized).durationUnavailable }} unavailable</span>
                    <span>API-equivalent valuation: {{ aggregateCoverageDetails(splitOngoing(taskActs).finalized).valuationAvailable }} available estimate / {{ aggregateCoverageDetails(splitOngoing(taskActs).finalized).valuationPending }} pending / {{ aggregateCoverageDetails(splitOngoing(taskActs).finalized).valuationUnavailable }} unavailable</span>
                    <span>Attributable billed cost: {{ aggregateCoverageDetails(splitOngoing(taskActs).finalized).billedReported }} reported / {{ aggregateCoverageDetails(splitOngoing(taskActs).finalized).billedUnavailable }} unavailable</span>
                  </div>
                  <details class="usage-aggregate-coverage-details">
                    <summary>Coverage &amp; provenance evidence</summary>
                    <div class="usage-aggregate-coverage-detail">
                      <span>{{ aggregateCoverageDetails(splitOngoing(taskActs).finalized).mixedProvenance ? 'Mixed-provenance API-equivalent estimate' : 'API-equivalent estimate provenance' }}: {{ aggregateCoverageDetails(splitOngoing(taskActs).finalized).provenanceSummary }}</span>
                      <span>Known subtotals exclude pending and unavailable values; unknown values are not zero.</span>
                      <span>Attributable billed cost is kept separate from every API-equivalent estimate.</span>
                    </div>
                  </details>
                </div>

                <div class="usage-task-calendar">
                  <strong>Task calendar elapsed</strong>
                  {{ displayText(Math.max(...splitOngoing(taskActs).finalized.map((a) => a.taskCalendarElapsedMs ?? 0)) > 0 ? formatDuration(Math.max(...splitOngoing(taskActs).finalized.map((a) => a.taskCalendarElapsedMs ?? 0)), 'complete') : 'Unavailable') }} / not summed into model time
                </div>

                <div class="usage-aggregate-activities">
                  <span>Finalized constituent activities</span>
                  <button
                    v-for="act in splitOngoing(taskActs).finalized"
                    :key="act.id"
                    type="button"
                    class="usage-activity-link"
                    :data-usage-activity="act.id"
                    @click="toggleActivity(act.id)"
                  >
                    <span>{{ act.id }}</span>
                    <span>{{ activityKindLabel(act.kind) }}</span>
                    <span>{{ displayText(act.activityTime) }}</span>
                  </button>
                </div>
              </article>

              <!-- Provisional Card -->
              <article
                v-if="splitOngoing(taskActs).provisional.length > 0"
                class="usage-aggregate-row"
                data-usage-provisional="true"
              >
                <div class="usage-aggregate-header">
                  <div>
                    <h3>Task {{ taskId }} — Provisional observed so far</h3>
                    <p>Nested Agent work Ongoing activity is observed so far and excluded from finalized totals.</p>
                  </div>
                  <div class="usage-aggregate-metrics">
                    <span>{{ formatDuration(aggregateMetrics(splitOngoing(taskActs).provisional).duration, aggregateMetrics(splitOngoing(taskActs).provisional).durationStatus) }} model time</span>
                    <span>{{ formatNumber(aggregateMetrics(splitOngoing(taskActs).provisional).tokens) }} tokens</span>
                    <span>{{ formatUsd(aggregateMetrics(splitOngoing(taskActs).provisional).estimate) }} available estimate</span>
                  </div>
                </div>

                <div class="usage-aggregate-coverage" aria-label="Aggregate coverage and provenance">
                  <div class="usage-coverage-summary">
                    <span>Token coverage: {{ aggregateCoverageDetails(splitOngoing(taskActs).provisional).tokenComplete }} complete / {{ aggregateCoverageDetails(splitOngoing(taskActs).provisional).tokenPartial }} partial / {{ aggregateCoverageDetails(splitOngoing(taskActs).provisional).tokenUnavailable }} unavailable</span>
                    <span>Duration coverage: {{ aggregateCoverageDetails(splitOngoing(taskActs).provisional).durationKnown }} known / {{ aggregateCoverageDetails(splitOngoing(taskActs).provisional).durationPartial }} partial / {{ aggregateCoverageDetails(splitOngoing(taskActs).provisional).durationUnavailable }} unavailable</span>
                    <span>API-equivalent valuation: {{ aggregateCoverageDetails(splitOngoing(taskActs).provisional).valuationAvailable }} available estimate / {{ aggregateCoverageDetails(splitOngoing(taskActs).provisional).valuationPending }} pending / {{ aggregateCoverageDetails(splitOngoing(taskActs).provisional).valuationUnavailable }} unavailable</span>
                    <span>Attributable billed cost: {{ aggregateCoverageDetails(splitOngoing(taskActs).provisional).billedReported }} reported / {{ aggregateCoverageDetails(splitOngoing(taskActs).provisional).billedUnavailable }} unavailable</span>
                  </div>
                </div>

                <div class="usage-task-calendar">
                  <strong>Task calendar elapsed observed so far</strong>
                  {{ displayText(Math.max(...splitOngoing(taskActs).provisional.map((a) => a.taskCalendarElapsedMs ?? 0)) > 0 ? formatDuration(Math.max(...splitOngoing(taskActs).provisional.map((a) => a.taskCalendarElapsedMs ?? 0)), 'complete') : 'Unavailable') }} / not summed into model time
                </div>

                <div class="usage-aggregate-activities">
                  <span>Observed activities</span>
                  <button
                    v-for="act in splitOngoing(taskActs).provisional"
                    :key="act.id"
                    type="button"
                    class="usage-activity-link"
                    :data-usage-activity="act.id"
                    @click="toggleActivity(act.id)"
                  >
                    <span>{{ act.id }}</span>
                    <span>{{ activityKindLabel(act.kind) }}</span>
                    <span>{{ displayText(act.activityTime) }}</span>
                  </button>
                </div>
              </article>
            </template>
          </div>

          <div class="usage-boundary-note">
            <strong>Routing attempts excluded.</strong> Wake-model activity belongs to its Project and never to a Task or Agent.
          </div>
        </div>

        <!-- 6d. Project View -->
        <div v-else-if="activeTab === 'project'" class="usage-list-section">
          <div class="usage-list-heading">
            <div>
              <h3>Project aggregates</h3>
              <p>Work-model and routing-model activity stay visible as separate subtotals.</p>
            </div>
            <span>{{ projectGroups.size }} projects</span>
          </div>

          <div class="usage-aggregate-list">
            <article
              v-for="[projectId, projectActs] in projectGroups.entries()"
              :key="projectId"
              class="usage-aggregate-row"
              :data-usage-project="projectId"
            >
              <div class="usage-aggregate-header">
                <div>
                  <h3>{{ projectName(projectId) }}</h3>
                  <p>Project-owned work and routing totals remain separate.</p>
                </div>
                <span class="usage-project-count">{{ projectActs.length }} activities</span>
              </div>

              <div class="usage-subtotal-grid">
                <!-- Work-model card -->
                <div class="flex flex-col gap-2">
                  <template v-for="isProv in [false, true]" :key="String(isProv)">
                    <section
                      v-if="(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).finalized).length > 0"
                      class="usage-subtotal-card"
                      data-usage-aggregate="true"
                      data-usage-kind="agent_run"
                      :data-usage-provisional="isProv"
                    >
                      <div class="usage-aggregate-header">
                        <div>
                          <h3>{{ isProv ? 'Work-model Agent runs — Provisional observed so far' : 'Work-model Agent runs' }}</h3>
                          <p>{{ isProv ? 'Agent run subtotal Ongoing activity is observed so far and excluded from finalized totals.' : 'Agent run subtotal Finalized activities only.' }}</p>
                        </div>
                        <div class="usage-aggregate-metrics">
                          <span>{{ formatDuration(aggregateMetrics(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).finalized).duration, aggregateMetrics(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).finalized).durationStatus) }} model time</span>
                          <span>{{ formatNumber(aggregateMetrics(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).finalized).tokens) }} tokens</span>
                          <span>{{ formatUsd(aggregateMetrics(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).finalized).estimate) }} available estimate</span>
                        </div>
                      </div>

                      <div class="usage-aggregate-coverage" aria-label="Aggregate coverage and provenance">
                        <div class="usage-coverage-summary">
                          <span>Token coverage: {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).finalized).tokenComplete }} complete / {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).finalized).tokenPartial }} partial / {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).finalized).tokenUnavailable }} unavailable</span>
                          <span>Duration coverage: {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).finalized).durationKnown }} known / {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).finalized).durationPartial }} partial / {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).finalized).durationUnavailable }} unavailable</span>
                          <span>API-equivalent valuation: {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).finalized).valuationAvailable }} available estimate / {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).finalized).valuationPending }} pending / {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).finalized).valuationUnavailable }} unavailable</span>
                          <span>Attributable billed cost: {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).finalized).billedReported }} reported / {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).finalized).billedUnavailable }} unavailable</span>
                        </div>
                        <details class="usage-aggregate-coverage-details">
                          <summary>Coverage &amp; provenance evidence</summary>
                          <div class="usage-aggregate-coverage-detail">
                            <span>{{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).finalized).mixedProvenance ? 'Mixed-provenance API-equivalent estimate' : 'API-equivalent estimate provenance' }}: {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).finalized).provenanceSummary }}</span>
                            <span>Known subtotals exclude pending and unavailable values; unknown values are not zero.</span>
                            <span>Attributable billed cost is kept separate from every API-equivalent estimate.</span>
                          </div>
                        </details>
                      </div>

                      <div class="usage-aggregate-activities">
                        <span>{{ isProv ? 'Observed activities' : 'Finalized constituent activities' }}</span>
                        <button
                          v-for="act in (isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'agent_run')).finalized)"
                          :key="act.id"
                          type="button"
                          class="usage-activity-link"
                          :data-usage-activity="act.id"
                          @click="toggleActivity(act.id)"
                        >
                          <span>{{ act.id }}</span>
                          <span>{{ activityKindLabel(act.kind) }}</span>
                          <span>{{ displayText(act.activityTime) }}</span>
                        </button>
                      </div>
                    </section>
                  </template>
                </div>

                <!-- Routing-model card -->
                <div class="flex flex-col gap-2">
                  <template v-for="isProv in [false, true]" :key="String(isProv)">
                    <section
                      v-if="(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).finalized).length > 0"
                      class="usage-subtotal-card"
                      data-usage-aggregate="true"
                      data-usage-kind="routing_attempt"
                      :data-usage-provisional="isProv"
                    >
                      <div class="usage-aggregate-header">
                        <div>
                          <h3>{{ isProv ? 'Routing-model attempts — Provisional observed so far' : 'Routing-model attempts' }}</h3>
                          <p>{{ isProv ? 'Routing attempt subtotal Ongoing activity is observed so far and excluded from finalized totals.' : 'Routing attempt subtotal Finalized activities only.' }}</p>
                        </div>
                        <div class="usage-aggregate-metrics">
                          <span>{{ formatDuration(aggregateMetrics(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).finalized).duration, aggregateMetrics(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).finalized).durationStatus) }} model time</span>
                          <span>{{ formatNumber(aggregateMetrics(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).finalized).tokens) }} tokens</span>
                          <span>{{ formatUsd(aggregateMetrics(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).finalized).estimate) }} available estimate</span>
                        </div>
                      </div>

                      <div class="usage-aggregate-coverage" aria-label="Aggregate coverage and provenance">
                        <div class="usage-coverage-summary">
                          <span>Token coverage: {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).finalized).tokenComplete }} complete / {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).finalized).tokenPartial }} partial / {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).finalized).tokenUnavailable }} unavailable</span>
                          <span>Duration coverage: {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).finalized).durationKnown }} known / {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).finalized).durationPartial }} partial / {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).finalized).durationUnavailable }} unavailable</span>
                          <span>API-equivalent valuation: {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).finalized).valuationAvailable }} available estimate / {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).finalized).valuationPending }} pending / {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).finalized).valuationUnavailable }} unavailable</span>
                          <span>Attributable billed cost: {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).finalized).billedReported }} reported / {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).finalized).billedUnavailable }} unavailable</span>
                        </div>
                        <details class="usage-aggregate-coverage-details">
                          <summary>Coverage &amp; provenance evidence</summary>
                          <div class="usage-aggregate-coverage-detail">
                            <span>{{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).finalized).mixedProvenance ? 'Mixed-provenance API-equivalent estimate' : 'API-equivalent estimate provenance' }}: {{ aggregateCoverageDetails(isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).finalized).provenanceSummary }}</span>
                            <span>Known subtotals exclude pending and unavailable values; unknown values are not zero.</span>
                            <span>Attributable billed cost is kept separate from every API-equivalent estimate.</span>
                          </div>
                        </details>
                      </div>

                      <div class="usage-aggregate-activities">
                        <span>{{ isProv ? 'Observed activities' : 'Finalized constituent activities' }}</span>
                        <button
                          v-for="act in (isProv ? splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(projectActs.filter((a) => a.kind === 'routing_attempt')).finalized)"
                          :key="act.id"
                          type="button"
                          class="usage-activity-link"
                          :data-usage-activity="act.id"
                          @click="toggleActivity(act.id)"
                        >
                          <span>{{ act.id }}</span>
                          <span>{{ activityKindLabel(act.kind) }}</span>
                          <span>{{ displayText(act.activityTime) }}</span>
                        </button>
                      </div>
                    </section>
                  </template>
                </div>
              </div>
            </article>
          </div>
        </div>

        <!-- 6e. Agent View -->
        <div v-else-if="activeTab === 'agent'" class="usage-list-section">
          <div class="usage-list-heading">
            <div>
              <h3>Agent aggregates</h3>
              <p>Runs attributed to a persistent Agent across Projects. Routing attempts are not absorbed.</p>
            </div>
            <span>{{ agentGroups.size }} Agents</span>
          </div>

          <div class="usage-aggregate-list">
            <template v-for="[agentId, agentActs] in agentGroups.entries()" :key="agentId">
              <article
                v-for="isProv in [false, true]"
                :key="String(isProv)"
                v-show="(isProv ? splitOngoing(agentActs).provisional : splitOngoing(agentActs).finalized).length > 0"
                class="usage-aggregate-row"
                :data-usage-provisional="isProv"
              >
                <div class="usage-aggregate-header">
                  <div>
                    <h3>{{ isProv ? `${agentName(agentId)} — Provisional observed so far` : agentName(agentId) }}</h3>
                    <p>{{ isProv ? 'Grouped by Project, engine, and model Ongoing activity is observed so far and excluded from finalized totals.' : 'Grouped by Project, engine, and model Finalized activities only.' }}</p>
                  </div>
                  <div class="usage-aggregate-metrics">
                    <span>{{ formatDuration(aggregateMetrics(isProv ? splitOngoing(agentActs).provisional : splitOngoing(agentActs).finalized).duration, aggregateMetrics(isProv ? splitOngoing(agentActs).provisional : splitOngoing(agentActs).finalized).durationStatus) }} model time</span>
                    <span>{{ formatNumber(aggregateMetrics(isProv ? splitOngoing(agentActs).provisional : splitOngoing(agentActs).finalized).tokens) }} tokens</span>
                    <span>{{ formatUsd(aggregateMetrics(isProv ? splitOngoing(agentActs).provisional : splitOngoing(agentActs).finalized).estimate) }} available estimate</span>
                  </div>
                </div>

                <div class="usage-aggregate-coverage" aria-label="Aggregate coverage and provenance">
                  <div class="usage-coverage-summary">
                    <span>Token coverage: {{ aggregateCoverageDetails(isProv ? splitOngoing(agentActs).provisional : splitOngoing(agentActs).finalized).tokenComplete }} complete / {{ aggregateCoverageDetails(isProv ? splitOngoing(agentActs).provisional : splitOngoing(agentActs).finalized).tokenPartial }} partial / {{ aggregateCoverageDetails(isProv ? splitOngoing(agentActs).provisional : splitOngoing(agentActs).finalized).tokenUnavailable }} unavailable</span>
                    <span>Duration coverage: {{ aggregateCoverageDetails(isProv ? splitOngoing(agentActs).provisional : splitOngoing(agentActs).finalized).durationKnown }} known / {{ aggregateCoverageDetails(isProv ? splitOngoing(agentActs).provisional : splitOngoing(agentActs).finalized).durationPartial }} partial / {{ aggregateCoverageDetails(isProv ? splitOngoing(agentActs).provisional : splitOngoing(agentActs).finalized).durationUnavailable }} unavailable</span>
                    <span>API-equivalent valuation: {{ aggregateCoverageDetails(isProv ? splitOngoing(agentActs).provisional : splitOngoing(agentActs).finalized).valuationAvailable }} available estimate / {{ aggregateCoverageDetails(isProv ? splitOngoing(agentActs).provisional : splitOngoing(agentActs).finalized).valuationPending }} pending / {{ aggregateCoverageDetails(isProv ? splitOngoing(agentActs).provisional : splitOngoing(agentActs).finalized).valuationUnavailable }} unavailable</span>
                    <span>Attributable billed cost: {{ aggregateCoverageDetails(isProv ? splitOngoing(agentActs).provisional : splitOngoing(agentActs).finalized).billedReported }} reported / {{ aggregateCoverageDetails(isProv ? splitOngoing(agentActs).provisional : splitOngoing(agentActs).finalized).billedUnavailable }} unavailable</span>
                  </div>
                </div>

                <div class="usage-subtotal-line">
                  Projects: {{ displayText([...new Set((isProv ? splitOngoing(agentActs).provisional : splitOngoing(agentActs).finalized).map((a) => projectName(a.projectId)))].join(', ')) }}
                </div>

                <div class="usage-aggregate-activities">
                  <span>{{ isProv ? 'Observed activities' : 'Finalized constituent activities' }}</span>
                  <button
                    v-for="act in (isProv ? splitOngoing(agentActs).provisional : splitOngoing(agentActs).finalized)"
                    :key="act.id"
                    type="button"
                    class="usage-activity-link"
                    :data-usage-activity="act.id"
                    @click="toggleActivity(act.id)"
                  >
                    <span>{{ act.id }}</span>
                    <span>{{ activityKindLabel(act.kind) }}</span>
                    <span>{{ displayText(act.activityTime) }}</span>
                  </button>
                </div>
              </article>
            </template>
          </div>

          <div class="usage-boundary-note">
            <strong>Routing attempts excluded.</strong> They have no Agent owner by design.
          </div>
        </div>

        <!-- 6f. Model View -->
        <div v-else-if="activeTab === 'model'" class="usage-list-section">
          <div class="usage-list-heading">
            <div>
              <h3>Model aggregates</h3>
              <p>Attributes usage to the engine, provider, model, and activity kind actually observed.</p>
            </div>
            <span>{{ modelGroups.size }} model views</span>
          </div>

          <div class="usage-aggregate-list">
            <template v-for="[key, mActs] in modelGroups.entries()" :key="key">
              <template v-for="isProv in [false, true]" :key="String(isProv)">
                <article
                  v-if="(isProv ? splitOngoing(mActs).provisional : splitOngoing(mActs).finalized).length > 0"
                  class="usage-aggregate-row"
                  data-usage-aggregate="true"
                  :data-model-name="displayText(mActs[0]?.model)"
                  :data-model-key="displayText(key)"
                  :data-usage-provisional="isProv"
                >
                  <div class="usage-aggregate-header">
                    <div>
                      <h3>{{ isProv ? `${modelLabel(mActs[0]!)} — Provisional observed so far` : modelLabel(mActs[0]!) }}</h3>
                      <p>{{ activityKindLabel(mActs[0]!.kind) }} / {{ displayText(mActs[0]!.engine ?? 'wake model') }} / {{ modelIdentityLabel(mActs[0]!) }} {{ isProv ? 'Ongoing activity is observed so far and excluded from finalized totals.' : 'Finalized activities only.' }}</p>
                    </div>
                    <div class="usage-aggregate-metrics">
                      <span>{{ formatDuration(aggregateMetrics(isProv ? splitOngoing(mActs).provisional : splitOngoing(mActs).finalized).duration, aggregateMetrics(isProv ? splitOngoing(mActs).provisional : splitOngoing(mActs).finalized).durationStatus) }} model time</span>
                      <span>{{ formatNumber(aggregateMetrics(isProv ? splitOngoing(mActs).provisional : splitOngoing(mActs).finalized).tokens) }} tokens</span>
                      <span>{{ formatUsd(aggregateMetrics(isProv ? splitOngoing(mActs).provisional : splitOngoing(mActs).finalized).estimate) }} available estimate</span>
                    </div>
                  </div>

                  <div class="usage-aggregate-coverage" aria-label="Aggregate coverage and provenance">
                    <div class="usage-coverage-summary">
                      <span>Token coverage: {{ aggregateCoverageDetails(isProv ? splitOngoing(mActs).provisional : splitOngoing(mActs).finalized).tokenComplete }} complete / {{ aggregateCoverageDetails(isProv ? splitOngoing(mActs).provisional : splitOngoing(mActs).finalized).tokenPartial }} partial / {{ aggregateCoverageDetails(isProv ? splitOngoing(mActs).provisional : splitOngoing(mActs).finalized).tokenUnavailable }} unavailable</span>
                      <span>Duration coverage: {{ aggregateCoverageDetails(isProv ? splitOngoing(mActs).provisional : splitOngoing(mActs).finalized).durationKnown }} known / {{ aggregateCoverageDetails(isProv ? splitOngoing(mActs).provisional : splitOngoing(mActs).finalized).durationPartial }} partial / {{ aggregateCoverageDetails(isProv ? splitOngoing(mActs).provisional : splitOngoing(mActs).finalized).durationUnavailable }} unavailable</span>
                      <span>API-equivalent valuation: {{ aggregateCoverageDetails(isProv ? splitOngoing(mActs).provisional : splitOngoing(mActs).finalized).valuationAvailable }} available estimate / {{ aggregateCoverageDetails(isProv ? splitOngoing(mActs).provisional : splitOngoing(mActs).finalized).valuationPending }} pending / {{ aggregateCoverageDetails(isProv ? splitOngoing(mActs).provisional : splitOngoing(mActs).finalized).valuationUnavailable }} unavailable</span>
                      <span>Attributable billed cost: {{ aggregateCoverageDetails(isProv ? splitOngoing(mActs).provisional : splitOngoing(mActs).finalized).billedReported }} reported / {{ aggregateCoverageDetails(isProv ? splitOngoing(mActs).provisional : splitOngoing(mActs).finalized).billedUnavailable }} unavailable</span>
                    </div>
                    <details class="usage-aggregate-coverage-details">
                      <summary>Coverage &amp; provenance evidence</summary>
                      <div class="usage-aggregate-coverage-detail">
                        <span>{{ aggregateCoverageDetails(isProv ? splitOngoing(mActs).provisional : splitOngoing(mActs).finalized).mixedProvenance ? 'Mixed-provenance API-equivalent estimate' : 'API-equivalent estimate provenance' }}: {{ aggregateCoverageDetails(isProv ? splitOngoing(mActs).provisional : splitOngoing(mActs).finalized).provenanceSummary }}</span>
                        <span>Known subtotals exclude pending and unavailable values; unknown values are not zero.</span>
                        <span>Attributable billed cost is kept separate from every API-equivalent estimate.</span>
                      </div>
                    </details>
                  </div>

                  <div class="usage-aggregate-activities">
                    <span>{{ isProv ? 'Observed activities' : 'Finalized constituent activities' }}</span>
                    <button
                      v-for="act in (isProv ? splitOngoing(mActs).provisional : splitOngoing(mActs).finalized)"
                      :key="act.id"
                      type="button"
                      class="usage-activity-link"
                      :data-usage-activity="act.id"
                      @click="toggleActivity(act.id)"
                    >
                      <span>{{ act.id }}</span>
                      <span>{{ activityKindLabel(act.kind) }}</span>
                      <span>{{ displayText(act.activityTime) }}</span>
                    </button>
                  </div>
                </article>
              </template>
            </template>
          </div>
        </div>

        <!-- 6g. Time View -->
        <div v-else-if="activeTab === 'time'" class="usage-list-section">
          <div class="usage-list-heading">
            <div>
              <h3>Settlement ranges</h3>
              <p>Settled activities belong to the range containing terminal settlement. Ongoing work is provisional.</p>
            </div>
            <span>Half-open boundaries</span>
          </div>

          <div class="usage-aggregate-list">
            <article
              v-for="[range, rActs] in timeGroups"
              :key="range"
              class="usage-time-range"
            >
              <div class="usage-time-range-heading">
                <h3>{{ timeRangeLabels[range] ?? range }}</h3>
                <p>Settlement range; work and routing activity are separate aggregates.</p>
              </div>

              <div class="usage-aggregate-list usage-time-aggregate-list">
                <!-- Work-model Card -->
                <template v-for="isProv in [false, true]" :key="'work-' + String(isProv)">
                  <article
                    v-if="(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).finalized).length > 0"
                    class="usage-aggregate-row"
                    data-usage-aggregate="true"
                    :data-usage-range="range"
                    data-usage-kind="agent_run"
                    :data-usage-provisional="isProv"
                  >
                    <div class="usage-aggregate-header">
                      <div>
                        <h3>{{ displayText((timeRangeLabels[range] ?? range)) }} — Work-model Agent runs{{ isProv ? ' — Provisional observed so far' : '' }}</h3>
                        <p>Agent run{{ isProv ? ' Ongoing activity is observed so far and excluded from finalized totals.' : ' Finalized activities only.' }}</p>
                      </div>
                      <div class="usage-aggregate-metrics">
                        <span>{{ formatDuration(aggregateMetrics(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).finalized).duration, aggregateMetrics(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).finalized).durationStatus) }} model time</span>
                        <span>{{ formatNumber(aggregateMetrics(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).finalized).tokens) }} tokens</span>
                        <span>{{ formatUsd(aggregateMetrics(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).finalized).estimate) }} available estimate</span>
                      </div>
                    </div>

                    <div class="usage-aggregate-coverage" aria-label="Aggregate coverage and provenance">
                      <div class="usage-coverage-summary">
                        <span>Token coverage: {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).finalized).tokenComplete }} complete / {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).finalized).tokenPartial }} partial / {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).finalized).tokenUnavailable }} unavailable</span>
                        <span>Duration coverage: {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).finalized).durationKnown }} known / {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).finalized).durationPartial }} partial / {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).finalized).durationUnavailable }} unavailable</span>
                        <span>API-equivalent valuation: {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).finalized).valuationAvailable }} available estimate / {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).finalized).valuationPending }} pending / {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).finalized).valuationUnavailable }} unavailable</span>
                        <span>Attributable billed cost: {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).finalized).billedReported }} reported / {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).finalized).billedUnavailable }} unavailable</span>
                      </div>
                      <details class="usage-aggregate-coverage-details">
                        <summary>Coverage &amp; provenance evidence</summary>
                        <div class="usage-aggregate-coverage-detail">
                          <span>{{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).finalized).mixedProvenance ? 'Mixed-provenance API-equivalent estimate' : 'API-equivalent estimate provenance' }}: {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).finalized).provenanceSummary }}</span>
                          <span>Known subtotals exclude pending and unavailable values; unknown values are not zero.</span>
                          <span>Attributable billed cost is kept separate from every API-equivalent estimate.</span>
                        </div>
                      </details>
                    </div>

                    <div class="usage-aggregate-activities">
                      <span>{{ isProv ? 'Observed activities' : 'Finalized constituent activities' }}</span>
                      <button
                        v-for="act in (isProv ? splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'agent_run')).finalized)"
                        :key="act.id"
                        type="button"
                        class="usage-activity-link"
                        :data-usage-activity="act.id"
                        @click="toggleActivity(act.id)"
                      >
                        <span>{{ act.id }}</span>
                        <span>{{ activityKindLabel(act.kind) }}</span>
                        <span>{{ displayText(act.activityTime) }}</span>
                      </button>
                    </div>
                  </article>
                </template>

                <!-- Routing-model Card -->
                <template v-for="isProv in [false, true]" :key="'routing-' + String(isProv)">
                  <article
                    v-if="(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).finalized).length > 0"
                    class="usage-aggregate-row"
                    data-usage-aggregate="true"
                    :data-usage-range="range"
                    data-usage-kind="routing_attempt"
                    :data-usage-provisional="isProv"
                  >
                    <div class="usage-aggregate-header">
                      <div>
                        <h3>{{ displayText((timeRangeLabels[range] ?? range)) }} — Project-owned Routing attempts{{ isProv ? ' — Provisional observed so far' : '' }}</h3>
                        <p>Routing attempt{{ isProv ? ' Ongoing activity is observed so far and excluded from finalized totals.' : ' Finalized activities only.' }}</p>
                      </div>
                      <div class="usage-aggregate-metrics">
                        <span>{{ formatDuration(aggregateMetrics(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).finalized).duration, aggregateMetrics(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).finalized).durationStatus) }} model time</span>
                        <span>{{ formatNumber(aggregateMetrics(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).finalized).tokens) }} tokens</span>
                        <span>{{ formatUsd(aggregateMetrics(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).finalized).estimate) }} available estimate</span>
                      </div>
                    </div>

                    <div class="usage-aggregate-coverage" aria-label="Aggregate coverage and provenance">
                      <div class="usage-coverage-summary">
                        <span>Token coverage: {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).finalized).tokenComplete }} complete / {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).finalized).tokenPartial }} partial / {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).finalized).tokenUnavailable }} unavailable</span>
                        <span>Duration coverage: {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).finalized).durationKnown }} known / {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).finalized).durationPartial }} partial / {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).finalized).durationUnavailable }} unavailable</span>
                        <span>API-equivalent valuation: {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).finalized).valuationAvailable }} available estimate / {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).finalized).valuationPending }} pending / {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).finalized).valuationUnavailable }} unavailable</span>
                        <span>Attributable billed cost: {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).finalized).billedReported }} reported / {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).finalized).billedUnavailable }} unavailable</span>
                      </div>
                      <details class="usage-aggregate-coverage-details">
                        <summary>Coverage &amp; provenance evidence</summary>
                        <div class="usage-aggregate-coverage-detail">
                          <span>{{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).finalized).mixedProvenance ? 'Mixed-provenance API-equivalent estimate' : 'API-equivalent estimate provenance' }}: {{ aggregateCoverageDetails(isProv ? splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).finalized).provenanceSummary }}</span>
                          <span>Known subtotals exclude pending and unavailable values; unknown values are not zero.</span>
                          <span>Attributable billed cost is kept separate from every API-equivalent estimate.</span>
                        </div>
                      </details>
                    </div>

                    <div class="usage-aggregate-activities">
                      <span>{{ isProv ? 'Observed activities' : 'Finalized constituent activities' }}</span>
                      <button
                        v-for="act in (isProv ? splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).provisional : splitOngoing(rActs.filter((a) => a.kind === 'routing_attempt')).finalized)"
                        :key="act.id"
                        type="button"
                        class="usage-activity-link"
                        :data-usage-activity="act.id"
                        @click="toggleActivity(act.id)"
                      >
                        <span>{{ act.id }}</span>
                        <span>{{ activityKindLabel(act.kind) }}</span>
                        <span>{{ displayText(act.activityTime) }}</span>
                      </button>
                    </div>
                  </article>
                </template>
              </div>
            </article>
          </div>
        </div>
      </section>

      <!-- 7. Selected Detail in non-run views -->
      <div v-if="activeTab !== 'run' && activeDetail" class="usage-detail-panel" aria-label="Activity details">
        <div class="usage-detail-header">
          <div>
            <span class="usage-section-kicker">Activity detail</span>
            <h3>
              {{ activeDetail.id }}
              <span class="status-pill" :class="outcomeClass(activeDetail)">{{ formatOutcome(activeDetail) }}</span>
            </h3>
            <p>{{ activityKindLabel(activeDetail.kind) }} / {{ projectName(activeDetail.projectId) }} / {{ displayText(activeDetail.activityTime) }}</p>
          </div>
        </div>

        <div class="usage-detail-grid">
          <div class="usage-detail-block">
            <h4>Attribution</h4>
            <dl class="usage-fact-list">
              <div><dt>Activity kind</dt><dd>{{ activityKindLabel(activeDetail.kind) }}</dd></div>
              <div><dt>Project</dt><dd>{{ projectName(activeDetail.projectId) }}</dd></div>
              <div><dt>Task</dt><dd>{{ displayText(activeDetail.taskId ?? 'Not applicable') }}</dd></div>
              <div><dt>Agent</dt><dd>{{ agentName(activeDetail.agentId) }}</dd></div>
              <div><dt>Model</dt><dd>{{ modelLabel(activeDetail) }}</dd></div>
              <div><dt>Model source</dt><dd>{{ displayText(activeDetail.modelIdentity.source) }}</dd></div>
              <div><dt>Model provider</dt><dd>{{ displayText(activeDetail.modelIdentity.provider) }}</dd></div>
              <div><dt>Model version</dt><dd>{{ displayText(activeDetail.modelIdentity.version) }}</dd></div>
              <div><dt>Session</dt><dd>{{ displayText(activeDetail.sessionMode === 'resumed' ? 'Resumed invocation' : 'New invocation') }}</dd></div>
            </dl>
          </div>

          <div class="usage-detail-block">
            <h4>Duration and outcome</h4>
            <dl class="usage-fact-list">
              <div><dt>Model activity duration</dt><dd>{{ formatDuration(activeDetail.wallDurationMs, activeDetail.durationStatus) }}</dd></div>
              <div><dt>Duration source</dt><dd>{{ displayText(activeDetail.durationSource) }}</dd></div>
              <div><dt>Engine duration</dt><dd>{{ displayText(activeDetail.engineDurationMs === undefined ? 'Not reported' : formatDuration(activeDetail.engineDurationMs, 'complete')) }}</dd></div>
              <div><dt>Outcome</dt><dd>{{ formatOutcome(activeDetail) }}</dd></div>
              <div><dt>Outcome note</dt><dd>{{ displayText(activeDetail.outcomeReason ?? 'No additional outcome note.') }}</dd></div>
            </dl>
          </div>

          <div class="usage-detail-block">
            <h4>Token dimensions</h4>
            <p class="usage-source-note">{{ displayText(activeDetail.tokenDimensions.source) }} / {{ displayText(activeDetail.tokenDimensions.status) }} measurement; provider or engine fact, not a local estimate</p>
            <dl class="usage-fact-list token-facts">
              <div><dt>Total input</dt><dd>{{ formatNumber(activeDetail.tokenDimensions.totalInput) }}</dd></div>
              <div><dt>Uncached input</dt><dd>{{ formatNumber(activeDetail.tokenDimensions.uncachedInput) }}</dd></div>
              <div><dt>Cached reads</dt><dd>{{ formatNumber(activeDetail.tokenDimensions.cachedReads) }}</dd></div>
              <div><dt>Cache write</dt><dd>{{ formatNumber(activeDetail.tokenDimensions.cacheWrite) }}</dd></div>
              <div><dt>Output</dt><dd>{{ formatNumber(activeDetail.tokenDimensions.output) }}</dd></div>
              <div><dt>Reasoning output</dt><dd>{{ formatNumber(activeDetail.tokenDimensions.reasoningOutput) }} <small>subset of output</small></dd></div>
              <div><dt>Provider or engine total</dt><dd>{{ formatNumber(activeDetail.tokenDimensions.total) }}</dd></div>
            </dl>
          </div>

          <div class="usage-detail-block">
            <h4>Cost facts</h4>
            <dl class="usage-fact-list">
              <div><dt>Attributable billed cost</dt><dd class="unavailable-value">Unavailable</dd></div>
              <div><dt>Why billed cost is unavailable</dt><dd>No settled per-activity provider invoice is exposed by this interface.</dd></div>
              <div><dt>API-equivalent estimate</dt><dd>{{ costLabel(activeDetail) }}</dd></div>
              <div><dt>Valuation provenance</dt><dd>{{ displayText(activeDetail.costValuation.provenance?.replaceAll('_', ' ') ?? 'Unavailable') }}</dd></div>
              <div><dt>Billing basis</dt><dd>{{ displayText(activeDetail.costValuation.billingBasis.replaceAll('_', ' ')) }}</dd></div>
              <div><dt>Valuation source</dt><dd>{{ displayText(activeDetail.costValuation.source ?? 'Unavailable') }}</dd></div>
              <div><dt>Coverage</dt><dd>{{ displayText(activeDetail.costValuation.note) }}</dd></div>
            </dl>
          </div>
        </div>

        <div class="usage-detail-footer">
          <strong>Measurement coverage</strong>
          <span>{{ displayText(activeDetail.coverageNote) }}</span>
          <span class="usage-state-label" :class="activeDetail.observationState">{{ displayText(activeDetail.observationState) }}</span>
        </div>

        <details v-if="activeDetail.observationHistory && activeDetail.observationHistory.length > 0" class="usage-history-details">
          <summary>Observation history and corrections ({{ activeDetail.observationHistory.length }})</summary>
          <div class="usage-history-list">
            <div v-for="(entry, idx) in activeDetail.observationHistory" :key="idx" class="usage-history-entry">
              <div><strong>{{ displayText(entry.status) }}</strong> / {{ displayText(entry.timestamp) }}</div>
              <div>{{ displayText(entry.source) }}</div>
              <small>{{ displayText(entry.note) }}<template v-if="entry.supersedes"> Supersedes {{ displayText(entry.supersedes) }}.</template></small>
              <span v-if="entry.usdMicros !== undefined">{{ formatUsd(entry.usdMicros) }} API-equivalent</span>
              <span v-else>Value unavailable</span>
            </div>
          </div>
        </details>
      </div>

      <!-- All visual aggregates and constituent evidence have semantic table equivalents. -->
      <UsageBackingTable :activities="backingActivities" :aggregates="backingAggregates" />
      </template>
    </div>
  </div>
</template>
