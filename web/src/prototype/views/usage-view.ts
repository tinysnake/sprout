import { renderIcon } from '../icons.js';
import { stateManager, type PrototypeState } from '../state.js';

export function renderUsageView(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'view-container';

  // ADR-0010 Principles Banner
  const principlesCard = document.createElement('div');
  principlesCard.className = 'card';
  principlesCard.style.borderLeft = '4px solid var(--accent-primary)';
  principlesCard.innerHTML = `
    <div class="card-header">
      <h2 style="font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
        ${renderIcon('chart', 18)}
        <span>Usage & Monetary-Cost Observability (ADR-0010)</span>
      </h2>
      <span class="status-pill neutral">Truthful Provenance & Coverage</span>
    </div>
    <p style="font-size: 12px; color: var(--text-secondary); line-height: 1.4;">
      Sprout separates <strong>Attributable Billed Cost</strong> (unavailable for per-run interfaces) from <strong>API-Equivalent USD Estimates</strong>.
      Activities distinguish work-model <em>Agent runs</em> from wake-model <em>Routing attempts</em>. Subscription-inclusive access is never assumed $0.00.
    </p>
  `;
  container.appendChild(principlesCard);

  // Section 2: Aggregated Metrics Grid
  const totalActivities = state.usageActivities.length;
  const agentRunActivities = state.usageActivities.filter((a) => a.kind === 'agent_run');
  const routingActivities = state.usageActivities.filter((a) => a.kind === 'routing_attempt');

  const totalWallDurationSec = state.usageActivities.reduce((acc, a) => acc + a.wallDurationMs / 1000, 0);
  const totalTokens = state.usageActivities.reduce((acc, a) => acc + a.tokenDimensions.total, 0);
  const totalCachedReads = state.usageActivities.reduce((acc, a) => acc + a.tokenDimensions.cachedReads, 0);
  const totalReasoning = state.usageActivities.reduce((acc, a) => acc + a.tokenDimensions.reasoningOutput, 0);

  const totalUsdMicros = state.usageActivities.reduce((acc, a) => acc + a.costValuation.estimatedUsdMicros, 0);
  const totalUsdFormatted = (totalUsdMicros / 1000000).toFixed(4);

  const providerEstimatedUsd = (
    state.usageActivities
      .filter((a) => a.costValuation.provenance === 'provider_estimated')
      .reduce((acc, a) => acc + a.costValuation.estimatedUsdMicros, 0) / 1000000
  ).toFixed(4);

  const harnessCalculatedUsd = (
    state.usageActivities
      .filter((a) => a.costValuation.provenance === 'harness_calculated')
      .reduce((acc, a) => acc + a.costValuation.estimatedUsdMicros, 0) / 1000000
  ).toFixed(4);

  const metricsCard = document.createElement('div');
  metricsCard.className = 'card';
  metricsCard.innerHTML = `
    <div class="metrics-grid">
      <!-- Activity Count -->
      <div class="metric-tile">
        <span class="metric-label">Activities</span>
        <span class="metric-value">${totalActivities}</span>
        <span class="metric-sub">${agentRunActivities.length} runs · ${routingActivities.length} wakes</span>
      </div>

      <!-- Wall Duration -->
      <div class="metric-tile">
        <span class="metric-label">Model Wall Duration</span>
        <span class="metric-value">${(totalWallDurationSec / 60).toFixed(1)}m</span>
        <span class="metric-sub">Across all engine hops</span>
      </div>

      <!-- Total Tokens -->
      <div class="metric-tile">
        <span class="metric-label">Total Tokens</span>
        <span class="metric-value">${totalTokens.toLocaleString()}</span>
        <span class="metric-sub">${totalCachedReads.toLocaleString()} cached · ${totalReasoning.toLocaleString()} reasoning</span>
      </div>

      <!-- API-Equivalent Estimate -->
      <div class="metric-tile">
        <span class="metric-label">API-Equiv Estimate</span>
        <span class="metric-value" style="color: var(--accent-primary);">$${totalUsdFormatted}</span>
        <span class="metric-sub">Mixed Provenance USD</span>
      </div>

      <!-- Provenance Subtotals -->
      <div class="metric-tile">
        <span class="metric-label">Valuation Provenance</span>
        <span class="metric-value" style="font-size: 13px;">Provider: $${providerEstimatedUsd}</span>
        <span class="metric-sub">Harness: $${harnessCalculatedUsd}</span>
      </div>

      <!-- Attributable Billed Cost -->
      <div class="metric-tile">
        <span class="metric-label">Billed Invoice Cost</span>
        <span class="metric-value" style="font-size: 13px; color: var(--text-muted);">Unavailable</span>
        <span class="metric-sub">Per-run interfaces</span>
      </div>
    </div>
  `;
  container.appendChild(metricsCard);

  // Section 3: 6 View Tabs & Cross-Filters
  const viewTabsCard = document.createElement('div');
  viewTabsCard.className = 'card';

  const currentTab = state.usageFilter.tab;
  viewTabsCard.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
      <!-- 6 Settled View Tabs -->
      <div class="segmented-control" style="overflow-x: auto;">
        <button class="segmented-btn ${currentTab === 'run' ? 'active' : ''}" data-tab="run">By Run</button>
        <button class="segmented-btn ${currentTab === 'task' ? 'active' : ''}" data-tab="task">By Task</button>
        <button class="segmented-btn ${currentTab === 'project' ? 'active' : ''}" data-tab="project">By Project</button>
        <button class="segmented-btn ${currentTab === 'agent' ? 'active' : ''}" data-tab="agent">By Agent</button>
        <button class="segmented-btn ${currentTab === 'model' ? 'active' : ''}" data-tab="model">By Model</button>
        <button class="segmented-btn ${currentTab === 'time' ? 'active' : ''}" data-tab="time">By Time Range</button>
      </div>

      <!-- Time Filter Preset -->
      <div style="display: flex; gap: 4px;">
        <button class="btn btn-secondary btn-sm time-filter-btn ${state.usageFilter.timeRange === 'today' ? 'btn-primary' : ''}" data-time="today">Today</button>
        <button class="btn btn-secondary btn-sm time-filter-btn ${state.usageFilter.timeRange === '7d' ? 'btn-primary' : ''}" data-time="7d">7D</button>
        <button class="btn btn-secondary btn-sm time-filter-btn ${state.usageFilter.timeRange === 'all' ? 'btn-primary' : ''}" data-time="all">All</button>
      </div>
    </div>

    <!-- Active Tab Presentation Content -->
    <div class="usage-tab-content" style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px;">
    </div>
  `;

  // Attach tab switch listeners
  viewTabsCard.querySelectorAll('.segmented-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const tab = (ev.currentTarget as HTMLElement).getAttribute('data-tab') as any;
      stateManager.setUsageFilter({ tab });
    });
  });

  viewTabsCard.querySelectorAll('.time-filter-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const timeRange = (ev.currentTarget as HTMLElement).getAttribute('data-time') as any;
      stateManager.setUsageFilter({ timeRange });
    });
  });

  const tabContent = viewTabsCard.querySelector('.usage-tab-content')!;

  // Render view depending on selected tab
  if (currentTab === 'run') {
    // 1. By Agent Run
    tabContent.innerHTML = state.usageActivities
      .map(
        (act) => `
      <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 10px; font-size: 12px; display: flex; flex-direction: column; gap: 4px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 600;">#${act.id}: ${act.kind === 'agent_run' ? `Agent Run: ${act.agentId}` : `Wake Routing: ${act.model}`}</span>
          <span class="status-pill purple" style="font-size: 10px;">${act.engine ?? 'wake-engine'}</span>
        </div>
        <div style="color: var(--text-secondary);">
          Duration: ${(act.wallDurationMs / 1000).toFixed(1)}s · Model: <code>${act.model}</code> · Time: ${act.activityTime}
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap; color: var(--text-muted); font-size: 11px;">
          <span>Uncached: ${act.tokenDimensions.uncachedInput.toLocaleString()}</span>
          <span>Cached Reads: ${act.tokenDimensions.cachedReads.toLocaleString()}</span>
          <span>Output: ${act.tokenDimensions.output.toLocaleString()}</span>
          <span>Reasoning: ${act.tokenDimensions.reasoningOutput.toLocaleString()}</span>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-subtle); padding-top: 4px; font-size: 11px;">
          <span style="color: var(--accent-primary); font-weight: 600;">
            API-Equiv Estimate: $${(act.costValuation.estimatedUsdMicros / 1000000).toFixed(4)} USD
          </span>
          <span class="status-pill neutral" style="font-size: 10px;">Provenance: ${act.costValuation.provenance} (${act.costValuation.billingBasis})</span>
        </div>
      </div>
    `
      )
      .join('');
  } else if (currentTab === 'task') {
    // 2. By Task
    tabContent.innerHTML = `
      <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 12px; font-size: 12px; display: flex; flex-direction: column; gap: 6px;">
        <div style="display: flex; justify-content: space-between;">
          <span style="font-weight: 700; font-size: 13px;">Task #101: 3D Board Grid & Click Reveal</span>
          <span class="status-pill green">Task Subtotal: $0.2310 USD</span>
        </div>
        <div style="color: var(--text-secondary);">
          Sum of Nested Run Wall Durations: <strong>4m 00s</strong> (distinct from Task calendar elapsed time of 35m)
        </div>
        <div style="margin-top: 4px; padding-left: 8px; border-left: 2px solid var(--border-subtle); display: flex; flex-direction: column; gap: 4px;">
          <div>• Run #203 (Programmer / Pi / claude-3-5-sonnet): $0.1420 (harness-calculated) · 2m 22s</div>
          <div>• Run #204 (Reviewer / Codex / gpt-4o): $0.0890 (provider-estimated) · 1m 38s</div>
        </div>
      </div>
    `;
  } else if (currentTab === 'project') {
    // 3. By Project (separate work-model vs routing-model)
    tabContent.innerHTML = `
      <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 12px; font-size: 12px; display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; justify-content: space-between;">
          <span style="font-weight: 700; font-size: 13px;">Project: Three.js Minesweeper Game</span>
          <span class="status-pill purple">Total: $0.3840 USD</span>
        </div>
        <div style="display: flex; gap: 12px; flex-wrap: wrap;">
          <div class="metric-tile" style="flex: 1;">
            <span class="metric-label">Work-Model Agent Runs</span>
            <span class="metric-value">$0.3836</span>
            <span class="metric-sub">14 active turns</span>
          </div>
          <div class="metric-tile" style="flex: 1;">
            <span class="metric-label">Routing-Model Attempts</span>
            <span class="metric-value">$0.0004</span>
            <span class="metric-sub">4 wake batches (gpt-4o-mini)</span>
          </div>
        </div>
      </div>
    `;
  } else if (currentTab === 'agent') {
    // 4. By Agent
    tabContent.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 6px;">
        <div style="background: var(--bg-surface-elevated); padding: 8px 12px; border-radius: var(--radius-sm); display: flex; justify-content: space-between; font-size: 12px;">
          <span style="display: flex; align-items: center; gap: 6px;">${renderIcon('bot', 14)} Programmer (Pi / claude-3-5-sonnet)</span>
          <strong>$0.1420 USD (142s wall)</strong>
        </div>
        <div style="background: var(--bg-surface-elevated); padding: 8px 12px; border-radius: var(--radius-sm); display: flex; justify-content: space-between; font-size: 12px;">
          <span style="display: flex; align-items: center; gap: 6px;">${renderIcon('bot', 14)} Reviewer (Codex / gpt-4o)</span>
          <strong>$0.0890 USD (98s wall)</strong>
        </div>
        <div style="background: var(--bg-surface-elevated); padding: 8px 12px; border-radius: var(--radius-sm); display: flex; justify-content: space-between; font-size: 12px;">
          <span style="display: flex; align-items: center; gap: 6px;">${renderIcon('bot', 14)} Designer (Codex / gpt-4o)</span>
          <strong>$0.0380 USD (34s wall)</strong>
        </div>
      </div>
    `;
  } else if (currentTab === 'model') {
    // 5. By Model
    tabContent.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 6px;">
        <div style="background: var(--bg-surface-elevated); padding: 8px 12px; border-radius: var(--radius-sm); display: flex; justify-content: space-between; font-size: 12px;">
          <span>anthropic/claude-3-5-sonnet (Work Model)</span>
          <strong>$0.1420 USD (61.4k tokens)</strong>
        </div>
        <div style="background: var(--bg-surface-elevated); padding: 8px 12px; border-radius: var(--radius-sm); display: flex; justify-content: space-between; font-size: 12px;">
          <span>openai/gpt-4o (Work Model)</span>
          <strong>$0.1270 USD (57.9k tokens)</strong>
        </div>
        <div style="background: var(--bg-surface-elevated); padding: 8px 12px; border-radius: var(--radius-sm); display: flex; justify-content: space-between; font-size: 12px;">
          <span>openai/gpt-4o-mini (Wake Routing Model)</span>
          <strong>$0.0004 USD (1.9k tokens)</strong>
        </div>
      </div>
    `;
  } else if (currentTab === 'time') {
    // 6. By Time Range
    tabContent.innerHTML = `
      <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 12px; font-size: 12px; display: flex; flex-direction: column; gap: 6px;">
        <div style="font-weight: 700;">Time Window: Today (00:00:00 - 23:59:59 Local Time)</div>
        <div style="color: var(--text-secondary);">Half-open range boundaries. Delayed observations update original settlement window.</div>
        <div style="font-size: 13px; color: var(--accent-primary); margin-top: 4px;">Finalized Aggregates: $0.3840 USD (100% complete token & cost coverage)</div>
      </div>
    `;
  }

  container.appendChild(viewTabsCard);

  return container;
}
