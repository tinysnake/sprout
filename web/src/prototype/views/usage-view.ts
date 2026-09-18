import { renderIcon } from '../icons.js';
import { stateManager, type PrototypeState } from '../state.js';
import type { UsageActivity, UsageActivityKind } from '../types.js';

type UsageTab = PrototypeState['usageFilter']['tab'];

const tabLabels: Record<UsageTab, string> = {
  run: 'Agent run',
  task: 'Task',
  project: 'Project',
  agent: 'Agent',
  model: 'Model',
  time: 'Time range',
};

const rangeRank: Record<UsageActivity['settlementRange'], number> = {
  today: 0,
  '7d': 1,
  '30d': 2,
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character] ?? character;
  });
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? 'Unavailable' : value.toLocaleString();
}

function formatUsd(value: number | undefined): string {
  return value === undefined ? 'Unavailable' : `$${(value / 1_000_000).toFixed(4)}`;
}

function formatDuration(value: number | undefined, status: UsageActivity['durationStatus']): string {
  if (value === undefined || status === 'unavailable') return 'Unavailable';
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s${status === 'partial' ? ' observed' : ''}`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${String(remainder).padStart(2, '0')}s${status === 'partial' ? ' observed' : ''}`;
}

function formatOutcome(activity: UsageActivity): string {
  if (activity.outcome === 'ongoing') return 'Ongoing';
  if (activity.outcome === 'interrupted') return 'Interrupted';
  if (activity.outcome === 'stopped') return 'Stopped';
  if (activity.outcome === 'failed') return 'Failed';
  return 'Completed';
}

function outcomeClass(activity: UsageActivity): string {
  if (activity.outcome === 'completed') return 'green';
  if (activity.outcome === 'ongoing') return 'blue';
  if (activity.outcome === 'stopped' || activity.outcome === 'interrupted') return 'yellow';
  return 'red';
}

function activityKindLabel(kind: UsageActivityKind): string {
  return kind === 'agent_run' ? 'Agent run' : 'Routing attempt';
}

function activityKindClass(kind: UsageActivityKind): string {
  return kind === 'agent_run' ? 'work' : 'routing';
}

function projectName(state: PrototypeState, projectId: string): string {
  return state.projects.find((project) => project.id === projectId)?.displayName ?? projectId;
}

function agentName(state: PrototypeState, agentId: string | undefined): string {
  if (!agentId) return 'No Agent owner';
  return state.agents.find((agent) => agent.id === agentId)?.displayName ?? agentId;
}

function modelLabel(activity: UsageActivity): string {
  return `${activity.provider ? `${activity.provider} / ` : ''}${activity.model}`;
}

function costLabel(activity: UsageActivity): string {
  const valuation = activity.costValuation;
  if (valuation.apiEquivalentStatus === 'available') {
    return `${formatUsd(valuation.estimatedUsdMicros)} API-equivalent`;
  }
  if (valuation.apiEquivalentStatus === 'pending') return 'Pending API-equivalent';
  return 'Unavailable API-equivalent';
}

function tokenSummary(activity: UsageActivity): string {
  const total = activity.tokenDimensions.total;
  if (activity.tokenDimensions.status === 'unavailable') return 'Tokens unavailable';
  if (total !== undefined) {
    return `${formatNumber(total)} tokens${activity.tokenDimensions.status === 'partial' ? ' observed' : ''}`;
  }
  return `${formatNumber(activity.tokenDimensions.totalInput)} input observed`;
}

function sumKnown(activities: UsageActivity[], value: (activity: UsageActivity) => number | undefined): number | undefined {
  const known = activities.map(value).filter((item): item is number => item !== undefined);
  return known.length > 0 ? known.reduce((total, item) => total + item, 0) : undefined;
}

function coverageText(activities: UsageActivity[]): string {
  const complete = activities.filter((activity) => activity.tokenDimensions.status === 'complete').length;
  const partial = activities.filter((activity) => activity.tokenDimensions.status === 'partial').length;
  const unavailable = activities.filter((activity) => activity.tokenDimensions.status === 'unavailable').length;
  return `${complete} complete / ${partial} partial / ${unavailable} unavailable token observations`;
}

function costCoverageText(activities: UsageActivity[]): string {
  const available = activities.filter((activity) => activity.costValuation.apiEquivalentStatus === 'available').length;
  const pending = activities.filter((activity) => activity.costValuation.apiEquivalentStatus === 'pending').length;
  const unavailable = activities.filter((activity) => activity.costValuation.apiEquivalentStatus === 'unavailable').length;
  return `${available} available / ${pending} pending / ${unavailable} unavailable estimates`;
}

function filterActivities(state: PrototypeState): UsageActivity[] {
  const filter = state.usageFilter;
  return state.usageActivities.filter((activity) => {
    const inRange = filter.timeRange === 'all' || rangeRank[activity.settlementRange] <= rangeRank[filter.timeRange as UsageActivity['settlementRange']];
    const inProject = !filter.projectId || filter.projectId === 'all' || activity.projectId === filter.projectId;
    const inAgent = !filter.agentId || filter.agentId === 'all' || activity.agentId === filter.agentId;
    const inModel = !filter.model || filter.model === 'all' || activity.model === filter.model;
    return inRange && inProject && inAgent && inModel;
  });
}

function renderActivityLink(activity: UsageActivity): string {
  return `
    <button class="usage-activity-link" data-usage-activity="${escapeHtml(activity.id)}" type="button">
      <span>${escapeHtml(activity.id)}</span>
      <span>${escapeHtml(activityKindLabel(activity.kind))}</span>
      <span>${escapeHtml(activity.activityTime)}</span>
    </button>
  `;
}

function renderActivityRow(activity: UsageActivity, state: PrototypeState): string {
  const selected = state.usageFilter.selectedActivityId === activity.id;
  const owner = activity.kind === 'agent_run' ? agentName(state, activity.agentId) : 'Project-owned';
  return `
    <button class="usage-activity-row ${selected ? 'selected' : ''}" data-usage-activity="${escapeHtml(activity.id)}" type="button" aria-expanded="${selected}">
      <span class="usage-row-main">
        <span class="usage-row-title">
          <span class="usage-kind-mark ${activityKindClass(activity.kind)}" aria-hidden="true"></span>
          <strong>${escapeHtml(activity.id)}</strong>
          <span class="status-pill ${outcomeClass(activity)}">${escapeHtml(formatOutcome(activity))}</span>
        </span>
        <span class="usage-row-subtitle">${escapeHtml(activityKindLabel(activity.kind))} / ${escapeHtml(owner)} / ${escapeHtml(modelLabel(activity))}</span>
      </span>
      <span class="usage-row-metric"><span>${escapeHtml(tokenSummary(activity))}</span><small>${escapeHtml(formatDuration(activity.wallDurationMs, activity.durationStatus))}</small></span>
      <span class="usage-row-cost"><strong>${escapeHtml(costLabel(activity))}</strong><small>${escapeHtml(activity.costValuation.provenance?.replaceAll('_', ' ') ?? 'No valuation provenance')}</small></span>
      <span class="usage-row-chevron" aria-hidden="true">${renderIcon('chevron-right', 14)}</span>
    </button>
  `;
}

function renderActivityDetail(activity: UsageActivity, state: PrototypeState): string {
  const tokens = activity.tokenDimensions;
  const valuation = activity.costValuation;
  const history = activity.observationHistory ?? [];
  const billedReason = 'No settled per-activity provider invoice is exposed by this interface.';
  return `
    <section class="usage-detail-panel" aria-label="Activity details">
      <div class="usage-detail-header">
        <div>
          <span class="usage-section-kicker">Activity detail</span>
          <h3>${escapeHtml(activity.id)} <span class="status-pill ${outcomeClass(activity)}">${escapeHtml(formatOutcome(activity))}</span></h3>
          <p>${escapeHtml(activityKindLabel(activity.kind))} / ${escapeHtml(projectName(state, activity.projectId))} / ${escapeHtml(activity.activityTime)}</p>
        </div>
        <button class="btn btn-ghost btn-sm usage-close-detail" type="button">Close</button>
      </div>

      <div class="usage-detail-grid">
        <div class="usage-detail-block">
          <h4>Attribution</h4>
          <dl class="usage-fact-list">
            <div><dt>Activity kind</dt><dd>${escapeHtml(activityKindLabel(activity.kind))}</dd></div>
            <div><dt>Project</dt><dd>${escapeHtml(projectName(state, activity.projectId))}</dd></div>
            <div><dt>Task</dt><dd>${escapeHtml(activity.taskId ?? 'Not applicable')}</dd></div>
            <div><dt>Agent</dt><dd>${escapeHtml(agentName(state, activity.agentId))}</dd></div>
            <div><dt>Model</dt><dd>${escapeHtml(modelLabel(activity))}</dd></div>
            <div><dt>Session</dt><dd>${activity.sessionMode === 'resumed' ? 'Resumed invocation' : 'New invocation'}</dd></div>
          </dl>
        </div>

        <div class="usage-detail-block">
          <h4>Duration and outcome</h4>
          <dl class="usage-fact-list">
            <div><dt>Model activity duration</dt><dd>${escapeHtml(formatDuration(activity.wallDurationMs, activity.durationStatus))}</dd></div>
            <div><dt>Duration source</dt><dd>${escapeHtml(activity.durationSource)}</dd></div>
            <div><dt>Engine duration</dt><dd>${escapeHtml(activity.engineDurationMs === undefined ? 'Not reported' : formatDuration(activity.engineDurationMs, 'complete'))}</dd></div>
            <div><dt>Outcome</dt><dd>${escapeHtml(formatOutcome(activity))}</dd></div>
            <div><dt>Outcome note</dt><dd>${escapeHtml(activity.outcomeReason ?? 'No additional outcome note.')}</dd></div>
          </dl>
        </div>

        <div class="usage-detail-block">
          <h4>Token dimensions</h4>
          <p class="usage-source-note">${escapeHtml(tokens.source)} / ${escapeHtml(tokens.status)} measurement; provider or engine fact, not a local estimate</p>
          <dl class="usage-fact-list token-facts">
            <div><dt>Total input</dt><dd>${formatNumber(tokens.totalInput)}</dd></div>
            <div><dt>Uncached input</dt><dd>${formatNumber(tokens.uncachedInput)}</dd></div>
            <div><dt>Cached reads</dt><dd>${formatNumber(tokens.cachedReads)}</dd></div>
            <div><dt>Cache write</dt><dd>${formatNumber(tokens.cacheWrite)}</dd></div>
            <div><dt>Output</dt><dd>${formatNumber(tokens.output)}</dd></div>
            <div><dt>Reasoning output</dt><dd>${formatNumber(tokens.reasoningOutput)} <small>subset of output</small></dd></div>
            <div><dt>Provider or engine total</dt><dd>${formatNumber(tokens.total)}</dd></div>
          </dl>
        </div>

        <div class="usage-detail-block">
          <h4>Cost facts</h4>
          <dl class="usage-fact-list">
            <div><dt>Attributable billed cost</dt><dd class="unavailable-value">Unavailable</dd></div>
            <div><dt>Why billed cost is unavailable</dt><dd>${billedReason}</dd></div>
            <div><dt>API-equivalent estimate</dt><dd>${escapeHtml(costLabel(activity))}</dd></div>
            <div><dt>Valuation provenance</dt><dd>${escapeHtml(valuation.provenance?.replaceAll('_', ' ') ?? 'Unavailable')}</dd></div>
            <div><dt>Billing basis</dt><dd>${escapeHtml(valuation.billingBasis.replaceAll('_', ' '))}</dd></div>
            <div><dt>Valuation source</dt><dd>${escapeHtml(valuation.source ?? 'Unavailable')}</dd></div>
            <div><dt>Coverage</dt><dd>${escapeHtml(valuation.note)}</dd></div>
          </dl>
        </div>
      </div>

      <div class="usage-detail-footer">
        <strong>Measurement coverage</strong>
        <span>${escapeHtml(activity.coverageNote)}</span>
        <span class="usage-state-label ${activity.observationState}">${escapeHtml(activity.observationState)}</span>
      </div>

      ${
        history.length > 0
          ? `<details class="usage-history-details">
              <summary>Observation history and corrections (${history.length})</summary>
              <div class="usage-history-list">
                ${history
                  .map(
                    (entry) => `
                    <div class="usage-history-entry">
                      <div><strong>${escapeHtml(entry.status)}</strong> / ${escapeHtml(entry.timestamp)}</div>
                      <div>${escapeHtml(entry.source)}</div>
                      <small>${escapeHtml(entry.note)}${entry.supersedes ? ` Supersedes ${escapeHtml(entry.supersedes)}.` : ''}</small>
                      ${entry.usdMicros !== undefined ? `<span>${formatUsd(entry.usdMicros)} API-equivalent</span>` : '<span>Value unavailable</span>'}
                    </div>
                  `
                  )
                  .join('')}
              </div>
            </details>`
          : ''
      }
    </section>
  `;
}

function aggregateMetrics(activities: UsageActivity[]) {
  return {
    duration: sumKnown(activities, (activity) => activity.wallDurationMs),
    tokens: sumKnown(activities, (activity) => activity.tokenDimensions.total),
    estimate: sumKnown(activities, (activity) =>
      activity.costValuation.apiEquivalentStatus === 'available' ? activity.costValuation.estimatedUsdMicros : undefined
    ),
  };
}

function renderAggregateHeader(title: string, subtitle: string, activities: UsageActivity[]): string {
  const metrics = aggregateMetrics(activities);
  return `
    <div class="usage-aggregate-header">
      <div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle)}</p></div>
      <div class="usage-aggregate-metrics">
        <span>${escapeHtml(formatDuration(metrics.duration, metrics.duration === undefined ? 'unavailable' : 'complete'))} model time</span>
        <span>${escapeHtml(formatNumber(metrics.tokens))} tokens</span>
        <span>${escapeHtml(formatUsd(metrics.estimate))} available estimate</span>
      </div>
    </div>
  `;
}

function renderAggregateActivities(activities: UsageActivity[]): string {
  return `<div class="usage-aggregate-activities"><span>Constituent activities</span>${activities.map((activity) => renderActivityLink(activity)).join('')}</div>`;
}

function renderRunView(activities: UsageActivity[], state: PrototypeState): string {
  return `
    <div class="usage-list-section">
      <div class="usage-list-heading"><div><h3>Activities</h3><p>Each row is one work-model Agent run or Project-owned Routing attempt.</p></div><span>${activities.length} shown</span></div>
      ${activities.length > 0 ? `<div class="usage-activity-list">${activities.map((activity) => renderActivityRow(activity, state)).join('')}</div>` : renderEmptyState()}
    </div>
  `;
}

function renderTaskView(activities: UsageActivity[], state: PrototypeState): string {
  const workActivities = activities.filter((activity) => activity.kind === 'agent_run');
  const groups = new Map<string, UsageActivity[]>();
  workActivities.forEach((activity) => {
    const key = activity.taskId ?? 'unassigned';
    groups.set(key, [...(groups.get(key) ?? []), activity]);
  });
  return `
    <div class="usage-list-section">
      <div class="usage-list-heading"><div><h3>Task aggregates</h3><p>Nested Agent runs only. Task calendar time stays separate from model activity duration.</p></div><span>${groups.size} tasks</span></div>
      <div class="usage-aggregate-list">
        ${
          groups.size > 0
            ? [...groups.entries()]
                .map(([taskId, taskActivities]) => {
                  const task = state.tasks.find((candidate) => candidate.id === taskId);
                  const calendar = Math.max(...taskActivities.map((activity) => activity.taskCalendarElapsedMs ?? 0));
                  return `<article class="usage-aggregate-row">${renderAggregateHeader(`Task ${taskId}`, task?.currentVersion.title ?? 'Nested Agent work', taskActivities)}<div class="usage-task-calendar"><strong>Task calendar elapsed</strong> ${calendar > 0 ? formatDuration(calendar, 'complete') : 'Unavailable'} / not summed into model time</div>${renderAggregateActivities(taskActivities)}</article>`;
                })
                .join('')
            : renderEmptyState()
        }
      </div>
      <div class="usage-boundary-note"><strong>Routing attempts excluded.</strong> Wake-model activity belongs to its Project and never to a Task or Agent.</div>
    </div>
  `;
}

function renderProjectView(activities: UsageActivity[], state: PrototypeState): string {
  const groups = new Map<string, UsageActivity[]>();
  activities.forEach((activity) => groups.set(activity.projectId, [...(groups.get(activity.projectId) ?? []), activity]));
  return `
    <div class="usage-list-section">
      <div class="usage-list-heading"><div><h3>Project aggregates</h3><p>Work-model and routing-model activity stay visible as separate subtotals.</p></div><span>${groups.size} projects</span></div>
      <div class="usage-aggregate-list">
        ${
          groups.size > 0
            ? [...groups.entries()]
                .map(([projectId, projectActivities]) => {
                  const work = projectActivities.filter((activity) => activity.kind === 'agent_run');
                  const routing = projectActivities.filter((activity) => activity.kind === 'routing_attempt');
                  return `<article class="usage-aggregate-row">${renderAggregateHeader(projectName(state, projectId), 'Project total with distinct activity kinds', projectActivities)}<div class="usage-subtotal-grid"><div><span>Work-model Agent runs</span><strong>${work.length} / ${formatUsd(aggregateMetrics(work).estimate)}</strong><small>${coverageText(work)}</small></div><div><span>Routing-model attempts</span><strong>${routing.length} / ${formatUsd(aggregateMetrics(routing).estimate)}</strong><small>${coverageText(routing)}</small></div></div>${renderAggregateActivities(projectActivities)}</article>`;
                })
                .join('')
            : renderEmptyState()
        }
      </div>
    </div>
  `;
}

function renderAgentView(activities: UsageActivity[], state: PrototypeState): string {
  const workActivities = activities.filter((activity) => activity.kind === 'agent_run');
  const groups = new Map<string, UsageActivity[]>();
  workActivities.forEach((activity) => {
    if (!activity.agentId) return;
    groups.set(activity.agentId, [...(groups.get(activity.agentId) ?? []), activity]);
  });
  return `
    <div class="usage-list-section">
      <div class="usage-list-heading"><div><h3>Agent aggregates</h3><p>Runs attributed to a persistent Agent across Projects. Routing attempts are not absorbed.</p></div><span>${groups.size} Agents</span></div>
      <div class="usage-aggregate-list">
        ${
          groups.size > 0
            ? [...groups.entries()]
                .map(([agentId, agentActivities]) => `<article class="usage-aggregate-row">${renderAggregateHeader(agentName(state, agentId), 'Grouped by Project, engine, and model', agentActivities)}<div class="usage-subtotal-line">Projects: ${[...new Set(agentActivities.map((activity) => projectName(state, activity.projectId)))].join(', ')}</div>${renderAggregateActivities(agentActivities)}</article>`)
                .join('')
            : renderEmptyState()
        }
      </div>
      <div class="usage-boundary-note"><strong>Routing attempts excluded.</strong> They have no Agent owner by design.</div>
    </div>
  `;
}

function renderModelView(activities: UsageActivity[]): string {
  const groups = new Map<string, UsageActivity[]>();
  activities.forEach((activity) => {
    const key = `${activity.kind}:${activity.engine ?? 'wake'}:${activity.model}`;
    groups.set(key, [...(groups.get(key) ?? []), activity]);
  });
  return `
    <div class="usage-list-section">
      <div class="usage-list-heading"><div><h3>Model aggregates</h3><p>Attributes usage to the engine, provider, model, and activity kind actually observed.</p></div><span>${groups.size} model views</span></div>
      <div class="usage-aggregate-list">
        ${
          groups.size > 0
            ? [...groups.entries()]
                .map(([, modelActivities]) => {
                  const first = modelActivities[0]!;
                  return `<article class="usage-aggregate-row">${renderAggregateHeader(modelLabel(first), `${activityKindLabel(first.kind)} / ${first.engine ?? 'wake model'}`, modelActivities)}${renderAggregateActivities(modelActivities)}</article>`;
                })
                .join('')
            : renderEmptyState()
        }
      </div>
    </div>
  `;
}

function renderTimeView(activities: UsageActivity[]): string {
  const groups = new Map<string, UsageActivity[]>();
  activities.forEach((activity) => groups.set(activity.settlementRange, [...(groups.get(activity.settlementRange) ?? []), activity]));
  const labels: Record<string, string> = { today: 'Today', '7d': 'Previous 7 days', '30d': 'Previous 30 days' };
  return `
    <div class="usage-list-section">
      <div class="usage-list-heading"><div><h3>Settlement ranges</h3><p>Settled activities belong to the range containing terminal settlement. Ongoing work is provisional.</p></div><span>Half-open boundaries</span></div>
      <div class="usage-aggregate-list">
        ${
          [...groups.entries()]
            .sort(([left], [right]) => rangeRank[left as UsageActivity['settlementRange']] - rangeRank[right as UsageActivity['settlementRange']])
            .map(([range, rangeActivities]) => `<article class="usage-aggregate-row">${renderAggregateHeader(labels[range] ?? range, 'Delayed observations update the original settlement range', rangeActivities)}<div class="usage-time-coverage"><span>${coverageText(rangeActivities)}</span><span>${costCoverageText(rangeActivities)}</span><span>${rangeActivities.some((activity) => activity.outcome === 'ongoing') ? 'Ongoing activity shown separately from finalized totals' : 'Finalized activities only'}</span></div>${renderAggregateActivities(rangeActivities)}</article>`)
            .join('') || renderEmptyState()
        }
      </div>
    </div>
  `;
}

function renderEmptyState(): string {
  return `<div class="usage-empty-state"><span class="usage-empty-icon">${renderIcon('search', 18)}</span><strong>No usage activities match these filters.</strong><span>Clear a scope filter or widen the time range. No missing activity is treated as zero.</span><button class="btn btn-secondary btn-sm usage-clear-filters" type="button">Clear filters</button></div>`;
}

function renderTabContent(activities: UsageActivity[], state: PrototypeState): string {
  switch (state.usageFilter.tab) {
    case 'task':
      return renderTaskView(activities, state);
    case 'project':
      return renderProjectView(activities, state);
    case 'agent':
      return renderAgentView(activities, state);
    case 'model':
      return renderModelView(activities);
    case 'time':
      return renderTimeView(activities);
    default:
      return renderRunView(activities, state);
  }
}

export function renderUsageView(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'view-container usage-view';
  const activities = filterActivities(state);
  const activeDetail = activities.find((activity) => activity.id === state.usageFilter.selectedActivityId);
  const availableEstimate = sumKnown(activities, (activity) =>
    activity.costValuation.apiEquivalentStatus === 'available' ? activity.costValuation.estimatedUsdMicros : undefined
  );
  const knownTokens = sumKnown(activities, (activity) => activity.tokenDimensions.total);
  const modelDuration = sumKnown(activities, (activity) => activity.wallDurationMs);
  const projects = state.projects.filter((project) => state.usageActivities.some((activity) => activity.projectId === project.id));
  const models = [...new Set(state.usageActivities.map((activity) => activity.model))];

  container.innerHTML = `
    <header class="usage-page-header">
      <div>
        <h1>Usage &amp; Costs</h1>
        <p>Observe model activity with enough context to distinguish usage, estimates, bills, and gaps.</p>
      </div>
    </header>

    <section class="usage-reading-note" aria-label="Usage semantics">
      <div class="usage-reading-icon">${renderIcon('chart', 18)}</div>
      <div><strong>Known values stay useful without pretending to be complete.</strong><span>Attributable billed cost is unavailable for these per-activity interfaces. API-equivalent estimates name their provenance. Pending and unavailable observations remain visible.</span></div>
    </section>

    <section class="usage-summary-band" aria-label="Usage summary">
      <div><span>Activities</span><strong>${activities.length}</strong><small>${activities.filter((activity) => activity.kind === 'agent_run').length} Agent runs / ${activities.filter((activity) => activity.kind === 'routing_attempt').length} Routing attempts</small></div>
      <div><span>Model activity time</span><strong>${escapeHtml(formatDuration(modelDuration, modelDuration === undefined ? 'unavailable' : 'complete'))}</strong><small>Task calendar time is separate</small></div>
      <div><span>Known total tokens</span><strong>${escapeHtml(formatNumber(knownTokens))}</strong><small>${escapeHtml(coverageText(activities))}</small></div>
      <div><span>API-equivalent estimate</span><strong>${escapeHtml(formatUsd(availableEstimate))}</strong><small>${escapeHtml(costCoverageText(activities))}</small></div>
    </section>

    <section class="usage-controls" aria-label="Usage views and filters">
      <div class="usage-view-tabs" role="tablist" aria-label="Usage view">
        ${Object.entries(tabLabels)
          .map(([tab, label]) => `<button class="usage-view-tab ${state.usageFilter.tab === tab ? 'active' : ''}" data-usage-tab="${tab}" type="button" role="tab" aria-selected="${state.usageFilter.tab === tab}">${escapeHtml(label)}</button>`)
          .join('')}
      </div>
      <div class="usage-filter-row">
        <label>Time range<select class="usage-filter-select" data-usage-filter="timeRange"><option value="today" ${state.usageFilter.timeRange === 'today' ? 'selected' : ''}>Today</option><option value="7d" ${state.usageFilter.timeRange === '7d' ? 'selected' : ''}>Previous 7 days</option><option value="30d" ${state.usageFilter.timeRange === '30d' ? 'selected' : ''}>Previous 30 days</option><option value="all" ${state.usageFilter.timeRange === 'all' ? 'selected' : ''}>All retained activity</option></select></label>
        <label>Project<select class="usage-filter-select" data-usage-filter="projectId"><option value="all">All Projects</option>${projects.map((project) => `<option value="${escapeHtml(project.id)}" ${state.usageFilter.projectId === project.id ? 'selected' : ''}>${escapeHtml(project.displayName)}</option>`).join('')}</select></label>
        <label>Agent<select class="usage-filter-select" data-usage-filter="agentId"><option value="all">All Agents</option>${state.agents.map((agent) => `<option value="${escapeHtml(agent.id)}" ${state.usageFilter.agentId === agent.id ? 'selected' : ''}>${escapeHtml(agent.displayName)}</option>`).join('')}</select></label>
        <label>Model<select class="usage-filter-select" data-usage-filter="model"><option value="all">All Models</option>${models.map((model) => `<option value="${escapeHtml(model)}" ${state.usageFilter.model === model ? 'selected' : ''}>${escapeHtml(model)}</option>`).join('')}</select></label>
        <button class="btn btn-ghost btn-sm usage-clear-filters" type="button">Clear filters</button>
      </div>
    </section>

    <section class="usage-coverage-strip" aria-label="Telemetry coverage">
      <div><strong>Coverage</strong><span>${escapeHtml(coverageText(activities))}</span></div>
      <div><strong>Valuation</strong><span>${escapeHtml(costCoverageText(activities))}</span></div>
      <div><strong>Billed cost</strong><span>Unavailable for ${activities.length} of ${activities.length} activities</span></div>
    </section>

    <section class="usage-tab-surface" aria-label="${escapeHtml(tabLabels[state.usageFilter.tab])} view">
      ${renderTabContent(activities, state)}
    </section>
    ${activeDetail ? renderActivityDetail(activeDetail, state) : '<div class="usage-detail-hint">Select an activity or an aggregate constituent to inspect tokens, duration, billing basis, provenance, coverage, and history.</div>'}
  `;

  container.querySelectorAll<HTMLButtonElement>('[data-usage-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      stateManager.setUsageFilter({ tab: button.dataset.usageTab as UsageTab, selectedActivityId: undefined });
    });
  });

  container.querySelectorAll<HTMLSelectElement>('[data-usage-filter]').forEach((select) => {
    select.addEventListener('change', () => {
      const key = select.dataset.usageFilter as 'timeRange' | 'projectId' | 'agentId' | 'model';
      stateManager.setUsageFilter({ [key]: select.value, selectedActivityId: undefined });
    });
  });

  container.querySelectorAll<HTMLButtonElement>('[data-usage-activity]').forEach((button) => {
    button.addEventListener('click', () => {
      stateManager.setUsageFilter({ selectedActivityId: button.dataset.usageActivity });
    });
  });

  container.querySelectorAll<HTMLButtonElement>('.usage-clear-filters').forEach((button) => {
    button.addEventListener('click', () => {
      stateManager.setUsageFilter({ timeRange: 'all', projectId: 'all', agentId: 'all', model: 'all', selectedActivityId: undefined });
    });
  });

  container.querySelector('.usage-close-detail')?.addEventListener('click', () => {
    stateManager.setUsageFilter({ selectedActivityId: undefined });
  });

  return container;
}
