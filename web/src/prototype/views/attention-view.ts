import { renderIcon } from "../icons.js";
import { stateManager, type PrototypeState } from '../state.js';

export function renderAttentionView(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'view-container';

  // Section 1: Attention Queue / Action Required
  const attentionHeader = document.createElement('div');
  attentionHeader.className = 'card-header';
  attentionHeader.innerHTML = `
    <div>
      <h2 style="font-size: 18px; font-weight: 700; display: flex; align-items: center; gap: 8px;">${renderIcon("lightning", 18)} Operator Attention Hub</h2>
      <p style="font-size: 13px; color: var(--text-secondary); margin-top: 2px;">
        Fast-intervention items requiring Human authority under ADR-0006 & ADR-0009.
      </p>
    </div>
    <span class="status-pill ${state.attentionItems.length > 0 ? 'red' : 'green'}">
      ${state.attentionItems.length} Action${state.attentionItems.length === 1 ? '' : 's'} Required
    </span>
  `;
  container.appendChild(attentionHeader);

  if (state.attentionItems.length === 0) {
    const emptyCard = document.createElement('div');
    emptyCard.className = 'card';
    emptyCard.innerHTML = `
      <div style="text-align: center; padding: 24px;">
        <div style="color: var(--green-ready); margin-bottom: 6px;">${renderIcon("check", 32)}</div>
        <h3 style="font-weight: 600; margin-top: 8px;">All Systems Clear</h3>
        <p style="font-size: 13px; color: var(--text-secondary); margin-top: 4px;">
          No active blockers, unvalidated claims, recovering leases, or pending enrollments.
        </p>
      </div>
    `;
    container.appendChild(emptyCard);
  } else {
    for (const item of state.attentionItems) {
      const card = document.createElement('div');
      card.className = `card ${item.severity === 'action_required' ? 'border-red' : 'border-yellow'}`;
      card.style.borderLeft = `4px solid ${item.severity === 'action_required' ? 'var(--red-action)' : 'var(--yellow-attention)'}`;

      const icon = item.category === "task_validation" ? renderIcon("check", 16) : item.category === "task_recovery" ? renderIcon("warning", 16) : renderIcon("alert", 16);

      card.innerHTML = `
        <div class="card-header">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 18px;">${icon}</span>
            <span class="card-title">${item.title}</span>
          </div>
          <span class="status-pill ${item.severity === 'action_required' ? 'red' : 'yellow'}">
            ${item.severity === 'action_required' ? 'Human Action Required' : 'Attention'}
          </span>
        </div>
        <p style="font-size: 13px; color: var(--text-secondary); line-height: 1.4;">
          ${item.summary}
        </p>
        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px;">
          <button class="btn btn-primary btn-sm action-btn">
            ${item.actionLabel} →
          </button>
        </div>
      `;

      const btn = card.querySelector('.action-btn');
      btn?.addEventListener('click', () => {
        if (item.category === 'task_validation' || item.category === 'task_blocker' || item.category === 'task_recovery') {
          stateManager.selectTask(item.referenceId);
          stateManager.setActiveTab('tasks');
        } else if (item.category === 'env_enrollment' || item.category === 'env_unhealthy') {
          stateManager.selectEnvironment(item.referenceId);
          stateManager.setActiveTab('environments');
        }
      });

      container.appendChild(card);
    }
  }

  // Section 2: Quick Status Overview Grid
  const overviewCard = document.createElement('div');
  overviewCard.className = 'card';
  overviewCard.innerHTML = `
    <div class="card-header">
      <span class="card-title" style="display: flex; align-items: center; gap: 6px;">${renderIcon("overview", 14)} Operational Overview</span>
      <span style="font-size: 12px; color: var(--text-muted);">Sprout Local Operator MVP</span>
    </div>
    <div class="metrics-grid">
      <div class="metric-tile">
        <span class="metric-label">Active Tasks</span>
        <span class="metric-value">${state.tasks.filter((t) => t.lifecycle === 'active').length}</span>
        <span class="metric-sub">${state.tasks.filter((t) => t.lifecycle === 'awaiting validation').length} awaiting validation</span>
      </div>
      <div class="metric-tile">
        <span class="metric-label">Held Leases</span>
        <span class="metric-value">${state.tasks.filter((t) => t.leaseLifecycle === 'held').length}</span>
        <span class="metric-sub">${state.tasks.filter((t) => t.leaseLifecycle === 'recovering').length} in recovery</span>
      </div>
      <div class="metric-tile">
        <span class="metric-label">Environments</span>
        <span class="metric-value">${state.environments.filter((e) => e.trafficLight === 'green').length} Ready</span>
        <span class="metric-sub">${state.environments.filter((e) => e.trafficLight === 'red').length} unavailable</span>
      </div>
      <div class="metric-tile">
        <span class="metric-label">Observed Cost Today</span>
        <span class="metric-value">$0.38</span>
        <span class="metric-sub">Mixed API-equiv estimate</span>
      </div>
    </div>
  `;
  container.appendChild(overviewCard);

  // Section 3: Recent Operational Events / Activity Feed
  const feedCard = document.createElement('div');
  feedCard.className = 'card';
  feedCard.innerHTML = `
    <div class="card-header">
      <span class="card-title" style="display: flex; align-items: center; gap: 6px;">${renderIcon("clock", 14)} Operational Event Log</span>
      <span style="font-size: 11px; color: var(--text-muted);">Sanitized durable audit</span>
    </div>
    <div class="scenario-feed">
      ${state.scenarioLog.map((log) => `<div>${log}</div>`).join('')}
    </div>
  `;
  container.appendChild(feedCard);

  return container;
}
