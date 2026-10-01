<script setup lang="ts">
import type { UsageActivityItem } from './types.ts';
import { sanitizeOperatorText } from '../../../../src/environment/privacy.ts';

defineProps<{
  activities: readonly UsageActivityItem[];
  projectNames: Readonly<Record<string, string>>;
  agentNames: Readonly<Record<string, string>>;
  aggregates: readonly { label: string; duration: string; tokens: string; estimate: string; coverage: string; provenance: string }[];
}>();
const dimensions = ['totalInput', 'uncachedInput', 'cachedReads', 'cacheWrite', 'output', 'reasoningOutput', 'total'] as const;
const text = (value: string | undefined) => sanitizeOperatorText(value, { fallback: 'Unavailable', maxLength: 4000 });
const identity = (value: string | undefined) => value && /^(?:act|task|run|att)-[a-z0-9-]+$/i.test(value) ? value : text(value);
const number = (value: number | undefined) => value === undefined ? 'Unavailable' : value.toLocaleString();
const usd = (value: number | undefined) => value === undefined ? 'Unavailable' : `$${(value / 1_000_000).toFixed(4)}`;
</script>

<template>
  <div class="sr-only" role="region" aria-label="Tabular summary for assistive technology">
    <table>
      <caption>Observability telemetry summary backing table</caption>
      <thead><tr><th scope="col">Activity category / scope</th><th scope="col">Duration</th><th scope="col">Known Tokens</th><th scope="col">API-equivalent estimate</th><th scope="col">Coverage</th><th scope="col">API-equivalent estimate provenance</th></tr></thead>
      <tbody><tr v-for="(a, index) in aggregates" :key="index"><th scope="row">{{ a.label }}</th><td>{{ a.duration }}</td><td>{{ a.tokens }}</td><td>{{ a.estimate }}</td><td>{{ a.coverage }}</td><td>{{ a.provenance }}</td></tr></tbody>
    </table>
    <table>
      <caption>Usage constituents, detailed dimensions and append-only observation evidence</caption>
      <thead><tr>
        <th scope="col">Activity</th><th scope="col">Kind</th><th scope="col">Project</th><th scope="col">Task</th><th scope="col">Agent</th>
        <th scope="col">Model identity</th><th scope="col">Settlement range / activity time</th><th scope="col">Outcome / session</th><th scope="col">Provisional state</th>
        <th scope="col">Duration and source</th><th scope="col">Token measurement and source</th>
        <th v-for="dimension in dimensions" :key="dimension" scope="col">{{ dimension }}</th>
        <th scope="col">API-equivalent estimate</th><th scope="col">Provenance / source / version</th><th scope="col">Attributable billed cost</th>
        <th scope="col">Billing basis</th><th scope="col">Coverage / valuation note</th><th scope="col">Observation state / history</th>
      </tr></thead>
      <tbody>
        <tr v-for="a in activities" :key="a.id" :data-usage-backing-activity="a.id">
          <th scope="row">{{ a.id }}</th><td>{{ a.kind === 'agent_run' ? 'Agent run' : 'Routing attempt' }}</td>
          <td>{{ projectNames[a.projectId] ?? identity(a.projectId) }}</td><td>{{ identity(a.taskId) }}</td><td>{{ (a.agentId && agentNames[a.agentId]) || identity(a.agentId) }}</td>
          <td>{{ text(a.engine) }} / {{ text(a.model) }} / {{ text(a.modelIdentity.source) }} / {{ text(a.modelIdentity.provider) }} / {{ text(a.modelIdentity.version) }}</td>
          <td>{{ a.settlementRange }} / {{ text(a.activityTime) }}</td>
          <td>{{ a.outcome }} / {{ a.sessionMode }} / {{ text(a.outcomeReason) }}</td>
          <td>{{ a.outcome === 'ongoing' ? 'Provisional observed so far; excluded from finalized totals' : 'Finalized' }}</td>
          <td>{{ number(a.wallDurationMs) }} ms / {{ a.durationStatus }} / {{ text(a.durationSource) }}; Engine duration {{ number(a.engineDurationMs) }} ms; Task calendar elapsed {{ number(a.taskCalendarElapsedMs) }} ms</td>
          <td>{{ a.tokenDimensions.status }} measurement / {{ text(a.tokenDimensions.source) }}</td>
          <td v-for="dimension in dimensions" :key="dimension" :data-token-dimension="dimension">{{ number(a.tokenDimensions[dimension]) }}</td>
          <td>{{ a.costValuation.apiEquivalentStatus }} / {{ usd(a.costValuation.estimatedUsdMicros) }} API-equivalent</td>
          <td>{{ text(a.costValuation.provenance?.replaceAll('_', ' ')) }} / {{ text(a.costValuation.source) }} / {{ text(a.costValuation.sourceVersion) }}</td>
          <td>{{ a.costValuation.attributableBilledCostStatus === 'unavailable' ? 'Unavailable' : 'Available; inspect provider ledger' }}</td>
          <td>{{ a.costValuation.billingBasis.replaceAll('_', ' ') }}</td>
          <td>{{ text(a.coverageNote) }} / {{ text(a.costValuation.note) }}</td>
          <td>{{ a.observationState }}
            <ul v-if="a.observationHistory?.length"><li v-for="(h, index) in a.observationHistory" :key="index">
              {{ text(h.timestamp) }} / {{ text(h.source) }} / {{ text(h.status) }} / {{ text(h.note) }};
              {{ usd(h.usdMicros) }} API-equivalent; Supersedes {{ text(h.supersedes) }}
            </li></ul>
            <span v-else>No prior observation history</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
