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
  if (value === undefined) return status === 'partial' ? 'Unavailable observed' : 'Unavailable';
  const seconds = Math.round(value / 1000);
  const suffix = status === 'partial' ? ' observed' : status === 'unavailable' ? ' (incomplete; duration unavailable)' : '';
  if (seconds < 60) return `${seconds}s${suffix}`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${String(remainder).padStart(2, '0')}s${suffix}`;
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

function modelIdentityLabel(activity: UsageActivity): string {
  const identity = activity.modelIdentity;
  return `Source: ${identity.source} / Provider: ${identity.provider} / Version: ${identity.version}`;
}

function modelGroupKey(activity: UsageActivity): string {
  return JSON.stringify([
    activity.kind,
    activity.engine ?? 'wake-model',
    activity.model,
    activity.modelIdentity.source,
    activity.modelIdentity.provider,
    activity.modelIdentity.version,
  ]);
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
            <div><dt>Model source</dt><dd>${escapeHtml(activity.modelIdentity.source)}</dd></div>
            <div><dt>Model provider</dt><dd>${escapeHtml(activity.modelIdentity.provider)}</dd></div>
            <div><dt>Model version</dt><dd>${escapeHtml(activity.modelIdentity.version)}</dd></div>
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
  const duration = sumKnown(activities, (activity) => activity.wallDurationMs);
  const durationStatus =
    activities.length === 0 || duration === undefined
      ? ('unavailable' as const)
      : activities.some((activity) => activity.durationStatus === 'unavailable')
        ? ('unavailable' as const)
        : activities.some((activity) => activity.durationStatus === 'partial')
          ? ('partial' as const)
          : ('complete' as const);
  return {
    duration,
    durationStatus,
    tokens: sumKnown(activities, (activity) => activity.tokenDimensions.total),
    estimate: sumKnown(activities, (activity) =>
      activity.costValuation.apiEquivalentStatus === 'available' ? activity.costValuation.estimatedUsdMicros : undefined
    ),
  };
}

function renderAggregateCoverage(activities: UsageActivity[]): string {
  const tokenComplete = activities.filter((activity) => activity.tokenDimensions.status === 'complete').length;
  const tokenPartial = activities.filter((activity) => activity.tokenDimensions.status === 'partial').length;
  const tokenUnavailable = activities.filter((activity) => activity.tokenDimensions.status === 'unavailable').length;
  const durationKnown = activities.filter(
    (activity) => activity.durationStatus === 'complete' && activity.wallDurationMs !== undefined
  ).length;
  const durationPartial = activities.filter((activity) => activity.durationStatus === 'partial').length;
  const durationUnavailable = activities.filter((activity) => activity.durationStatus === 'unavailable').length;
  const valuationAvailable = activities.filter(
    (activity) => activity.costValuation.apiEquivalentStatus === 'available'
  ).length;
  const valuationPending = activities.filter(
    (activity) => activity.costValuation.apiEquivalentStatus === 'pending'
  ).length;
  const valuationUnavailable = activities.filter(
    (activity) => activity.costValuation.apiEquivalentStatus === 'unavailable'
  ).length;
  const billedReported = activities.filter(
    (activity) => activity.costValuation.attributableBilledCostStatus !== 'unavailable'
  ).length;
  const billedUnavailable = activities.length - billedReported;
  const provenanceCounts = new Map<string, number>();
  activities
    .filter(
      (activity) =>
        activity.costValuation.apiEquivalentStatus === 'available' && activity.costValuation.provenance !== undefined
    )
    .forEach((activity) => {
      const provenance = activity.costValuation.provenance!;
      provenanceCounts.set(provenance, (provenanceCounts.get(provenance) ?? 0) + 1);
    });
  const provenanceLabels: Record<string, string> = {
    provider_estimated: 'provider-estimated',
    harness_calculated: 'harness-calculated',
    locally_estimated: 'locally-estimated',
  };
  const provenanceSummary = [...provenanceCounts.entries()]
    .map(([provenance, count]) => `${provenanceLabels[provenance] ?? provenance} ${count}`)
    .join(' / ');
  const mixedProvenance = provenanceCounts.size > 1;

  return `
    <div class="usage-aggregate-coverage" aria-label="Aggregate coverage and provenance">
      <div class="usage-coverage-summary">
        <span>Token coverage: ${tokenComplete} complete / ${tokenPartial} partial / ${tokenUnavailable} unavailable</span>
        <span>Duration coverage: ${durationKnown} known / ${durationPartial} partial / ${durationUnavailable} unavailable</span>
        <span>API-equivalent valuation: ${valuationAvailable} available estimate / ${valuationPending} pending / ${valuationUnavailable} unavailable</span>
        <span>Attributable billed cost: ${billedReported} reported / ${billedUnavailable} unavailable</span>
      </div>
      <details class="usage-aggregate-coverage-details">
        <summary>Coverage &amp; provenance evidence</summary>
        <div class="usage-aggregate-coverage-detail">
          <span>${mixedProvenance ? 'Mixed-provenance API-equivalent estimate' : 'API-equivalent estimate provenance'}: ${escapeHtml(provenanceSummary || 'none available')}</span>
          <span>Known subtotals exclude pending and unavailable values; unknown values are not zero.</span>
          <span>Attributable billed cost is kept separate from every API-equivalent estimate.</span>
        </div>
      </details>
    </div>
  `;
}

function splitOngoingActivities(activities: UsageActivity[]): { finalized: UsageActivity[]; provisional: UsageActivity[] } {
  return {
    finalized: activities.filter((activity) => activity.outcome !== 'ongoing'),
    provisional: activities.filter((activity) => activity.outcome === 'ongoing'),
  };
}

type AggregateCardOptions = {
  tagName?: 'article' | 'section';
  className?: string;
  attributes?: string;
  afterHeader?: (activities: UsageActivity[], provisional: boolean) => string;
};

function renderAggregateCard(
  title: string,
  subtitle: string,
  activities: UsageActivity[],
  provisional: boolean,
  options: AggregateCardOptions = {}
): string {
  const tagName = options.tagName ?? 'article';
  const className = options.className ?? 'usage-aggregate-row';
  const attributes = options.attributes ? ` ${options.attributes}` : '';
  const afterHeader = options.afterHeader?.(activities, provisional) ?? '';
  return `<${tagName} class="${className}" data-usage-provisional="${provisional}"${attributes}>${renderAggregateHeader(title, subtitle, activities)}${afterHeader}${renderAggregateActivities(activities, provisional)}</${tagName}>`;
}

function renderAggregateVariants(
  title: string,
  subtitle: string,
  activities: UsageActivity[],
  options: AggregateCardOptions = {}
): string {
  const { finalized, provisional } = splitOngoingActivities(activities);
  const cards: string[] = [];
  if (finalized.length > 0) {
    cards.push(
      renderAggregateCard(
        title,
        `${subtitle} Finalized activities only.`,
        finalized,
        false,
        options
      )
    );
  }
  if (provisional.length > 0) {
    cards.push(
      renderAggregateCard(
        `${title} — Provisional observed so far`,
        `${subtitle} Ongoing activity is observed so far and excluded from finalized totals.`,
        provisional,
        true,
        options
      )
    );
  }
  return cards.join('');
}

function renderAggregateHeader(title: string, subtitle: string, activities: UsageActivity[]): string {
  const metrics = aggregateMetrics(activities);
  return `
    <div class="usage-aggregate-header">
      <div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle)}</p></div>
      <div class="usage-aggregate-metrics">
        <span>${escapeHtml(formatDuration(metrics.duration, metrics.durationStatus))} model time</span>
        <span>${escapeHtml(formatNumber(metrics.tokens))} tokens</span>
        <span>${escapeHtml(formatUsd(metrics.estimate))} available estimate</span>
      </div>
    </div>
    ${renderAggregateCoverage(activities)}
  `;
}

function renderAggregateActivities(activities: UsageActivity[], provisional = false): string {
  return `<div class="usage-aggregate-activities"><span>${provisional ? 'Observed activities' : 'Finalized constituent activities'}</span>${activities.map((activity) => renderActivityLink(activity)).join('')}</div>`;
}

function renderRunView(activities: UsageActivity[], state: PrototypeState): string {
  const agentRunActivities = activities.filter((activity) => activity.kind === 'agent_run');
  return `
    <div class="usage-list-section">
      <div class="usage-list-heading"><div><h3>Agent runs</h3><p>Each row is one work-model Agent run only. Project-owned Routing attempts remain in their Project and routing views.</p></div><span>${agentRunActivities.length} shown</span></div>
      ${agentRunActivities.length > 0 ? `<div class="usage-activity-list">${agentRunActivities.map((activity) => renderActivityFoldableRow(activity, state)).join('')}</div>` : renderEmptyState()}
    </div>
  `;
}

function renderActivityFoldableRow(activity: UsageActivity, state: PrototypeState): string {
  const selected = state.usageFilter.selectedActivityId === activity.id;
  return `
    <div class="usage-activity-item ${selected ? 'open' : ''}">
      ${renderActivityRow(activity, state)}
      ${selected ? renderActivityDetail(activity, state) : ''}
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
                  return renderAggregateVariants(`Task ${taskId}`, task?.currentVersion.title ?? 'Nested Agent work', taskActivities, {
                    afterHeader: (variantActivities, provisional) => {
                      const calendar = Math.max(...variantActivities.map((activity) => activity.taskCalendarElapsedMs ?? 0));
                      return `<div class="usage-task-calendar"><strong>Task calendar elapsed${provisional ? ' observed so far' : ''}</strong> ${calendar > 0 ? formatDuration(calendar, 'complete') : 'Unavailable'} / not summed into model time</div>`;
                    },
                  });
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
                  return `<article class="usage-aggregate-row" data-usage-project="${escapeHtml(projectId)}"><div class="usage-aggregate-header"><div><h3>${escapeHtml(projectName(state, projectId))}</h3><p>Project-owned work and routing totals remain separate.</p></div><span class="usage-project-count">${projectActivities.length} activities</span></div><div class="usage-subtotal-grid">${renderProjectKindCard('Work-model Agent runs', 'agent_run', work)}${renderProjectKindCard('Routing-model attempts', 'routing_attempt', routing)}</div></article>`;
                })
                .join('')
            : renderEmptyState()
        }
      </div>
    </div>
  `;
}

function renderProjectKindCard(title: string, kind: UsageActivityKind, activities: UsageActivity[]): string {
  return renderAggregateVariants(title, `${activityKindLabel(kind)} subtotal`, activities, {
    tagName: 'section',
    className: 'usage-subtotal-card',
    attributes: `data-usage-aggregate="true" data-usage-kind="${kind}"`,
  });
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
                .map(([agentId, agentActivities]) => renderAggregateVariants(agentName(state, agentId), 'Grouped by Project, engine, and model', agentActivities, {
                  afterHeader: (variantActivities) => `<div class="usage-subtotal-line">Projects: ${[...new Set(variantActivities.map((activity) => projectName(state, activity.projectId)))].join(', ')}</div>`,
                }))
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
    const key = modelGroupKey(activity);
    groups.set(key, [...(groups.get(key) ?? []), activity]);
  });
  return `
    <div class="usage-list-section">
      <div class="usage-list-heading"><div><h3>Model aggregates</h3><p>Attributes usage to the engine, provider, model, and activity kind actually observed.</p></div><span>${groups.size} model views</span></div>
      <div class="usage-aggregate-list">
        ${
          groups.size > 0
            ? [...groups.entries()]
                .map(([key, modelActivities]) => {
                  const first = modelActivities[0]!;
                  return renderAggregateVariants(modelLabel(first), `${activityKindLabel(first.kind)} / ${first.engine ?? 'wake model'} / ${escapeHtml(modelIdentityLabel(first))}`, modelActivities, {
                    attributes: `data-usage-aggregate="true" data-model-name="${escapeHtml(first.model)}" data-model-key="${escapeHtml(key)}"`,
                  });
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
            .map(([range, rangeActivities]) => {
              const work = rangeActivities.filter((activity) => activity.kind === 'agent_run');
              const routing = rangeActivities.filter((activity) => activity.kind === 'routing_attempt');
              const settlementRange = range as UsageActivity['settlementRange'];
              return `<article class="usage-time-range"><div class="usage-time-range-heading"><h3>${escapeHtml(labels[range] ?? range)}</h3><p>Settlement range; work and routing activity are separate aggregates.</p></div><div class="usage-aggregate-list usage-time-aggregate-list">${renderTimeAggregateCard(settlementRange, 'agent_run', work)}${renderTimeAggregateCard(settlementRange, 'routing_attempt', routing)}</div></article>`;
            })
            .join('') || renderEmptyState()
        }
      </div>
    </div>
  `;
}

function renderTimeAggregateCard(
  range: UsageActivity['settlementRange'],
  kind: UsageActivityKind,
  activities: UsageActivity[]
): string {
  return renderAggregateVariants(
    `${range === 'today' ? 'Today' : range === '7d' ? 'Previous 7 days' : 'Previous 30 days'} — ${kind === 'agent_run' ? 'Work-model Agent runs' : 'Project-owned Routing attempts'}`,
    activityKindLabel(kind),
    activities,
    {
      attributes: `data-usage-aggregate="true" data-usage-range="${range}" data-usage-kind="${kind}"`,
    }
  );
}

function renderEmptyState(): string {
  return `<div class="usage-empty-state"><span class="usage-empty-icon">${renderIcon('search', 18)}</span><strong>No usage activities match these filters.</strong><span>Clear a scope filter or widen the time range. No missing activity is treated as zero.</span><button class="btn btn-secondary btn-sm usage-clear-filters" type="button">Clear filters</button></div>`;
}

function renderUsageSummaryMetric(label: string, value: string, evidence: string): string {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(evidence)}</small></div>`;
}

function renderUsageSummaryKind(kind: UsageActivityKind, activities: UsageActivity[]): string {
  const { finalized, provisional } = splitOngoingActivities(activities);
  const metrics = aggregateMetrics(finalized);
  const kindLabel = kind === 'agent_run' ? 'Work-model Agent runs' : 'Project-owned Routing attempts';
  const provisionalMetrics = aggregateMetrics(provisional);
  return `
    <section class="usage-summary-kind" data-usage-summary-kind="${kind}">
      <div class="usage-summary-kind-heading">
        <strong>${escapeHtml(kindLabel)}</strong>
        <small>${finalized.length} finalized${provisional.length > 0 ? ` / ${provisional.length} provisional` : ''}</small>
      </div>
      <div class="usage-summary-kind-metrics" data-usage-summary-scope="finalized">
        ${renderUsageSummaryMetric('Finalized model activity time', `${formatDuration(metrics.duration, metrics.durationStatus)} model time`, 'Ongoing activity is not included')}
        ${renderUsageSummaryMetric('Finalized known total tokens', `${formatNumber(metrics.tokens)} tokens`, coverageText(finalized))}
        ${renderUsageSummaryMetric('Finalized API-equivalent estimate', `${formatUsd(metrics.estimate)} available estimate`, costCoverageText(finalized))}
      </div>
      ${
        provisional.length > 0
          ? `<div class="usage-summary-kind-provisional" data-usage-summary-scope="provisional"><strong>Provisional observed so far</strong><span>${formatDuration(provisionalMetrics.duration, provisionalMetrics.durationStatus)} model time / ${formatNumber(provisionalMetrics.tokens)} tokens / ${formatUsd(provisionalMetrics.estimate)} available estimate</span><small>${coverageText(provisional)}; excluded from finalized arithmetic and links</small></div>`
          : ''
      }
    </section>
  `;
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
      ${renderUsageSummaryKind('agent_run', activities.filter((activity) => activity.kind === 'agent_run'))}
      ${renderUsageSummaryKind('routing_attempt', activities.filter((activity) => activity.kind === 'routing_attempt'))}
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
      <div><strong>Work-model coverage</strong><span>${escapeHtml(coverageText(activities.filter((activity) => activity.kind === 'agent_run')))} / ${escapeHtml(costCoverageText(activities.filter((activity) => activity.kind === 'agent_run')))}</span></div>
      <div><strong>Routing-attempt coverage</strong><span>${escapeHtml(coverageText(activities.filter((activity) => activity.kind === 'routing_attempt')))} / ${escapeHtml(costCoverageText(activities.filter((activity) => activity.kind === 'routing_attempt')))}</span></div>
      <div><strong>Billed cost</strong><span>Unavailable for ${activities.filter((activity) => activity.kind === 'agent_run').length} work-model / ${activities.filter((activity) => activity.kind === 'routing_attempt').length} routing activities</span></div>
    </section>

    <section class="usage-tab-surface" aria-label="${escapeHtml(tabLabels[state.usageFilter.tab])} view">
      ${renderTabContent(activities, state)}
    </section>
    ${state.usageFilter.tab !== 'run' && activeDetail ? renderActivityDetail(activeDetail, state) : ''}
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
      const currentSelected = state.usageFilter.selectedActivityId;
      const targetId = button.dataset.usageActivity;
      stateManager.setUsageFilter({ selectedActivityId: currentSelected === targetId ? undefined : targetId });
    });
  });

  container.querySelectorAll<HTMLButtonElement>('.usage-clear-filters').forEach((button) => {
    button.addEventListener('click', () => {
      stateManager.setUsageFilter({ timeRange: 'all', projectId: 'all', agentId: 'all', model: 'all', selectedActivityId: undefined });
    });
  });

  return container;
}
