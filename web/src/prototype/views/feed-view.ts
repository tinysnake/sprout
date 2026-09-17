import { renderIcon } from '../icons.js';
import { stateManager, type PrototypeState } from '../state.js';
import type {
  ActivityFeedItem,
  AttentionItem,
  AttentionSeverity,
} from '../types.js';

export function renderFeedView(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'feed-view';

  // 1. Top Header (Clean Authentic Production UI)
  const headerEl = document.createElement('div');
  headerEl.className = 'view-header feed-header';
  headerEl.innerHTML = `
    <div class="view-header-title">
      <h2 style="font-size: 18px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
        ${renderIcon('feed', 20)}
        <span>Operations Feed & Human Attention</span>
      </h2>
      <span class="proto-badge">Cross-Project Landing Surface</span>
    </div>
    <p style="font-size: 13px; color: var(--text-secondary); margin-top: 4px;">
      Central surface for cross-project discovery, urgent Human interventions, active work telemetry, and background collaboration history.
    </p>

    <!-- Top Scope Selector Dropdown -->
    <div class="feed-scope-filter-bar">
      <div class="feed-scope-dropdown-wrapper">
        <div class="feed-scope-inner">
          <span class="feed-scope-icon">${renderIcon('project', 16)}</span>
          <label for="feed-scope-select" class="feed-scope-label">Scope:</label>
          <select id="feed-scope-select" class="form-select feed-scope-select" aria-label="Select Project Scope">
            ${renderScopeSelectOptions(state)}
          </select>
        </div>
      </div>
    </div>
  `;

  // Attach Scope select listener
  const scopeSelect = headerEl.querySelector('#feed-scope-select') as HTMLSelectElement;
  scopeSelect?.addEventListener('change', (ev) => {
    const val = (ev.target as HTMLSelectElement).value;
    stateManager.setFeedScopeFilter(val);
  });

  container.appendChild(headerEl);

  // Render active layout variant
  if (state.feedLayoutVariant === 'split-board') {
    container.appendChild(renderSplitBoardLayout(state));
  } else if (state.feedLayoutVariant === 'project-grouped') {
    container.appendChild(renderProjectGroupedLayout(state));
  } else {
    container.appendChild(renderUnifiedLayout(state));
  }

  return container;
}

// ---------------------------------------------------------------------------
// Scope Selection & Filter Helpers
// ---------------------------------------------------------------------------

function getScopedAttentionItems(state: PrototypeState): AttentionItem[] {
  const scope = state.feedScopeFilter;
  if (scope === 'all') {
    return state.attentionItems;
  }
  if (scope === 'infrastructure') {
    return state.attentionItems.filter(
      (item) => item.projectName === 'Infrastructure' || item.category.startsWith('env_') || !item.projectId
    );
  }
  // Filter for specific project, including infrastructure items directly blocking/affecting this project (Transcolation rule)
  return state.attentionItems.filter((item) => {
    if (item.projectId === scope) return true;
    if (item.referenceType === 'task') {
      const task = state.tasks.find((t) => t.id === item.referenceId);
      if (task?.projectId === scope) return true;
    }
    return false;
  });
}

function getScopedActiveTasks(state: PrototypeState) {
  const scope = state.feedScopeFilter;
  const activeTasks = state.tasks.filter(
    (t) => t.lifecycle === 'active' || t.agentRunLifecycle === 'running'
  );
  if (scope === 'all') return activeTasks;
  if (scope === 'infrastructure') return [];
  return activeTasks.filter((t) => t.projectId === scope);
}

function getScopedActivities(state: PrototypeState): ActivityFeedItem[] {
  const scope = state.feedScopeFilter;
  if (scope === 'all') return state.activityFeedItems;
  if (scope === 'infrastructure') {
    return state.activityFeedItems.filter(
      (a) => a.projectName === 'Infrastructure' || a.kind === 'env_heartbeat' || !a.projectId
    );
  }
  return state.activityFeedItems.filter((a) => a.projectId === scope);
}

function renderScopeSelectOptions(state: PrototypeState): string {
  const currentScope = state.feedScopeFilter;
  const allAttCount = state.attentionItems.length;

  let optionsHtml = `
    <option value="all" ${currentScope === 'all' ? 'selected' : ''}>
      All Projects (${allAttCount} pending)
    </option>
  `;

  for (const proj of state.projects) {
    const projItems = state.attentionItems.filter(
      (i) =>
        i.projectId === proj.id ||
        (i.referenceType === 'task' &&
          state.tasks.find((t) => t.id === i.referenceId)?.projectId === proj.id)
    );
    optionsHtml += `
      <option value="${proj.id}" ${currentScope === proj.id ? 'selected' : ''}>
        ${proj.displayName} (${projItems.length} pending)
      </option>
    `;
  }

  const infraItems = state.attentionItems.filter(
    (i) => i.projectName === 'Infrastructure' || i.category.startsWith('env_') || !i.projectId
  );
  optionsHtml += `
    <option value="infrastructure" ${currentScope === 'infrastructure' ? 'selected' : ''}>
      Infrastructure (${infraItems.length} pending)
    </option>
  `;

  return optionsHtml;
}

// ---------------------------------------------------------------------------
// Variant A: Unified Urgency-First Layout (Default)
// ---------------------------------------------------------------------------
function renderUnifiedLayout(state: PrototypeState): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'feed-layout-unified';

  wrapper.appendChild(renderAttentionSection(state));
  wrapper.appendChild(renderActiveWorkSection(state));
  wrapper.appendChild(renderActivityStreamSection(state));

  return wrapper;
}

// ---------------------------------------------------------------------------
// Variant B: Split Operator Board Layout (Dual Stream Desktop / Tabbed Mobile)
// ---------------------------------------------------------------------------
function renderSplitBoardLayout(state: PrototypeState): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'feed-layout-split-board';

  const scopedAttentions = getScopedAttentionItems(state);
  const scopedActivities = getScopedActivities(state);

  // Mobile Top Tab Switcher for Split Board
  const mobileTabSwitch = document.createElement('div');
  mobileTabSwitch.className = 'split-board-mobile-tabs';
  mobileTabSwitch.innerHTML = `
    <div class="segmented-control" style="width: 100%; margin-bottom: 12px;">
      <button class="segmented-btn ${state.mobileFeedSplitTab === 'attention' ? 'active' : ''}" id="split-tab-att">
        ${renderIcon('lightning', 14)} Attention Queue (${scopedAttentions.length})
      </button>
      <button class="segmented-btn ${state.mobileFeedSplitTab === 'activity' ? 'active' : ''}" id="split-tab-act">
        ${renderIcon('usage', 14)} Live Activity (${scopedActivities.length})
      </button>
    </div>
  `;

  mobileTabSwitch.querySelector('#split-tab-att')?.addEventListener('click', () => {
    stateManager.setMobileFeedSplitTab('attention');
  });
  mobileTabSwitch.querySelector('#split-tab-act')?.addEventListener('click', () => {
    stateManager.setMobileFeedSplitTab('activity');
  });

  wrapper.appendChild(mobileTabSwitch);

  const columnsContainer = document.createElement('div');
  columnsContainer.className = 'split-board-columns';

  // Left Column: Attention Queue & In-Flight Work
  const leftCol = document.createElement('div');
  leftCol.className = `split-column split-col-left ${state.mobileFeedSplitTab === 'attention' ? 'mobile-visible' : 'mobile-hidden'}`;
  leftCol.appendChild(renderAttentionSection(state));
  leftCol.appendChild(renderActiveWorkSection(state));

  // Right Column: Live Operational Stream
  const rightCol = document.createElement('div');
  rightCol.className = `split-column split-col-right ${state.mobileFeedSplitTab === 'activity' ? 'mobile-visible' : 'mobile-hidden'}`;
  rightCol.appendChild(renderActivityStreamSection(state));

  columnsContainer.appendChild(leftCol);
  columnsContainer.appendChild(rightCol);
  wrapper.appendChild(columnsContainer);

  return wrapper;
}

// ---------------------------------------------------------------------------
// Variant C: Project-Grouped Feed Layout
// ---------------------------------------------------------------------------
function renderProjectGroupedLayout(state: PrototypeState): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'feed-layout-project-grouped';

  const scopedAttentions = getScopedAttentionItems(state);

  // Global Alert Banner if attention items exist
  if (scopedAttentions.length > 0) {
    const alertBanner = document.createElement('div');
    alertBanner.className = 'feed-global-attention-banner';
    alertBanner.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        ${renderIcon('lightning', 18)}
        <strong>${scopedAttentions.length} Attention Items Active in Scope</strong>
      </div>
      <span style="font-size: 11px; color: var(--text-secondary);">Review items within project cards below</span>
    `;
    wrapper.appendChild(alertBanner);
  }

  // Render per-project container cards
  for (const project of state.projects) {
    if (state.feedScopeFilter !== 'all' && state.feedScopeFilter !== project.id) {
      continue;
    }

    const projectCard = document.createElement('div');
    projectCard.className = 'feed-project-card card';

    const projectAttentions = state.attentionItems.filter((a) => a.projectId === project.id);
    const projectTasks = state.tasks.filter((t) => t.projectId === project.id);
    const activeTask = projectTasks.find(
      (t) => t.lifecycle === 'active' || t.lifecycle === 'awaiting validation' || t.lifecycle === 'blocked'
    );
    const projectActivities = state.activityFeedItems.filter((a) => a.projectId === project.id);

    projectCard.innerHTML = `
      <div class="card-header" style="border-bottom: 1px solid var(--border-subtle); padding-bottom: 10px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          ${renderIcon('project', 18)}
          <div>
            <h3 style="font-size: 15px; font-weight: 700;">${project.displayName}</h3>
            <span style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);">${project.templateSource} · ${project.wakePolicy}</span>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          ${projectAttentions.length > 0 ? `<span class="badge badge-yellow">${projectAttentions.length} Attention</span>` : '<span class="badge badge-green">Healthy</span>'}
          <button class="btn btn-outline btn-sm btn-open-project" data-proj-id="${project.id}">
            Open Project →
          </button>
        </div>
      </div>

      <!-- Project Attention Items -->
      ${
        projectAttentions.length > 0
          ? `
        <div style="margin-top: 10px;">
          <div style="font-size: 12px; font-weight: 700; color: var(--yellow-attention); margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
            ${renderIcon('alert', 13)} Project Attention Items:
          </div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            ${projectAttentions.map((item) => renderAttentionCardHtml(item)).join('')}
          </div>
        </div>
      `
          : `
        <div class="project-clear-banner" style="margin-top: 8px;">
          <span class="status-dot green"></span>
          <span>${project.displayName}: All clear, system running autonomously.</span>
        </div>
      `
      }

      <!-- Project Active Task Snapshot -->
      ${
        activeTask
          ? `
        <div style="margin-top: 12px; background: var(--bg-surface-elevated); padding: 10px 12px; border-radius: var(--radius-sm); border-left: 3px solid var(--accent-primary);">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 11px; font-weight: 700; color: var(--accent-primary);">CURRENT TASK</span>
            <span class="badge ${activeTask.lifecycle === 'awaiting validation' ? 'badge-purple' : activeTask.lifecycle === 'blocked' ? 'badge-red' : 'badge-blue'}">${activeTask.lifecycle}</span>
          </div>
          <div style="font-size: 13px; font-weight: 600; margin-top: 2px;">#${activeTask.id}: ${activeTask.currentVersion.title}</div>
          <div style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); margin-top: 2px;">
            Lead: ${activeTask.taskLeadId} · Env: ${activeTask.selectedEnvironmentId}
          </div>
          <button class="btn btn-secondary btn-sm btn-deep-task" data-task-id="${activeTask.id}" style="margin-top: 8px; width: 100%;">
            View Task in Project →
          </button>
        </div>
      `
          : ''
      }

      <!-- Project Recent Activities -->
      <div style="margin-top: 12px;">
        <div style="font-size: 11px; font-weight: 700; color: var(--text-muted); margin-bottom: 6px;">RECENT PROJECT ACTIVITY</div>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          ${
            projectActivities.length === 0
              ? '<div style="font-size: 12px; color: var(--text-muted); padding: 6px 0;">No recent activity in this project.</div>'
              : projectActivities
                  .slice(0, 3)
                  .map((act) => renderActivityRowHtml(act))
                  .join('')
          }
        </div>
      </div>
    `;

    projectCard.querySelector('.btn-open-project')?.addEventListener('click', () => {
      stateManager.selectProject(project.id);
      stateManager.navigateWithReturn({ nav: 'project', projectTab: 'overview' }, 'Feed');
    });

    projectCard.querySelector('.btn-deep-task')?.addEventListener('click', (ev) => {
      const taskId = (ev.currentTarget as HTMLElement).getAttribute('data-task-id');
      if (taskId) {
        stateManager.navigateWithReturn({ nav: 'project', projectTab: 'tasks', taskId }, 'Feed');
      }
    });

    attachAttentionCardHandlers(projectCard, state);
    attachActivityRowHandlers(projectCard);

    wrapper.appendChild(projectCard);
  }

  // Global Infrastructure Card (if all or infrastructure scope)
  if (state.feedScopeFilter === 'all' || state.feedScopeFilter === 'infrastructure') {
    const infraAttentions = state.attentionItems.filter(
      (a) => !a.projectId || a.projectName === 'Infrastructure' || a.category.startsWith('env_')
    );
    const infraCard = document.createElement('div');
    infraCard.className = 'feed-project-card card';
    infraCard.innerHTML = `
      <div class="card-header" style="border-bottom: 1px solid var(--border-subtle); padding-bottom: 10px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          ${renderIcon('environments', 18)}
          <div>
            <h3 style="font-size: 15px; font-weight: 700;">Infrastructure & Environments</h3>
            <span style="font-size: 11px; color: var(--text-muted);">${state.environments.length} Connected Workers · macOS & Windows</span>
          </div>
        </div>
        <button class="btn btn-outline btn-sm btn-open-envs">
          Manage Envs →
        </button>
      </div>

      ${
        infraAttentions.length > 0
          ? `
        <div style="margin-top: 10px;">
          <div style="font-size: 12px; font-weight: 700; color: var(--yellow-attention); margin-bottom: 6px;">
            Infrastructure Interventions:
          </div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            ${infraAttentions.map((item) => renderAttentionCardHtml(item)).join('')}
          </div>
        </div>
      `
          : `
        <div class="project-clear-banner" style="margin-top: 8px;">
          <span class="status-dot green"></span>
          <span>Infrastructure: All connected workers and engine readiness probes healthy.</span>
        </div>
      `
      }
    `;

    infraCard.querySelector('.btn-open-envs')?.addEventListener('click', () => {
      stateManager.navigateWithReturn({ nav: 'manage', manageTab: 'environments' }, 'Feed');
    });

    attachAttentionCardHandlers(infraCard, state);
    wrapper.appendChild(infraCard);
  }

  return wrapper;
}

// ---------------------------------------------------------------------------
// Section 1: Prominent Human Attention Section
// ---------------------------------------------------------------------------
function renderAttentionSection(state: PrototypeState): HTMLElement {
  const section = document.createElement('section');
  section.className = 'feed-section attention-section';

  const scopedItems = getScopedAttentionItems(state);
  const redItems = scopedItems.filter((i) => i.severity === 'action_required');
  const yellowItems = scopedItems.filter((i) => i.severity === 'attention');
  const blueItems = scopedItems.filter((i) => i.severity === 'info');

  // Multi-dimensional filtering: Filter scoped items by selected severity
  let displayedItems = scopedItems;
  if (state.feedAttentionSeverityFilter === 'action_required') {
    displayedItems = redItems;
  } else if (state.feedAttentionSeverityFilter === 'attention') {
    displayedItems = yellowItems;
  } else if (state.feedAttentionSeverityFilter === 'info') {
    displayedItems = blueItems;
  }

  // Sort displayed items: Red (Action Required) first, then Yellow (Attention), then Blue (Info)
  displayedItems.sort((a, b) => {
    const score = (s: AttentionSeverity) => (s === 'action_required' ? 3 : s === 'attention' ? 2 : 1);
    return score(b.severity) - score(a.severity);
  });

  const scopeLabel =
    state.feedScopeFilter === 'all'
      ? 'All Projects'
      : state.feedScopeFilter === 'infrastructure'
        ? 'Infrastructure'
        : state.projects.find((p) => p.id === state.feedScopeFilter)?.displayName ?? 'Project';

  section.innerHTML = `
    <!-- Section Header -->
    <div class="section-title-bar">
      <div style="display: flex; align-items: center; gap: 8px;">
        ${renderIcon('lightning', 18)}
        <h3 style="font-size: 15px; font-weight: 700;">Human Attention Required</h3>
        ${
          scopedItems.length > 0
            ? `<span class="badge ${redItems.length > 0 ? 'badge-red' : 'badge-yellow'}">${scopedItems.length} Pending</span>`
            : `<span class="badge badge-green">0 Pending</span>`
        }
      </div>
      <span style="font-size: 11px; color: var(--text-muted);">
        Urgency prioritized (Red → Yellow → Blue)
      </span>
    </div>

    <!-- 4 Streamlined Urgency Pills (Single Row 4-Column Bar with Top Stat & Bottom Label) -->
    <div class="attention-urgency-pills" role="group" aria-label="Filter attention by urgency tier">
      <button class="urgency-pill-btn ${state.feedAttentionSeverityFilter === 'all' ? 'active' : ''}" data-severity="all" title="All (${scopedItems.length})">
        <span class="urgency-pill-top"><span class="status-dot purple"></span> ${scopedItems.length}</span>
        <span class="urgency-pill-bottom" title="All">All</span>
      </button>
      <button class="urgency-pill-btn pill-danger ${state.feedAttentionSeverityFilter === 'action_required' ? 'active' : ''}" data-severity="action_required" title="Action Required (${redItems.length})">
        <span class="urgency-pill-top"><span class="status-dot red"></span> ${redItems.length}</span>
        <span class="urgency-pill-bottom" title="Action Required">Action Required</span>
      </button>
      <button class="urgency-pill-btn pill-warning ${state.feedAttentionSeverityFilter === 'attention' ? 'active' : ''}" data-severity="attention" title="Attention (${yellowItems.length})">
        <span class="urgency-pill-top"><span class="status-dot yellow"></span> ${yellowItems.length}</span>
        <span class="urgency-pill-bottom" title="Attention">Attention</span>
      </button>
      <button class="urgency-pill-btn pill-info ${state.feedAttentionSeverityFilter === 'info' ? 'active' : ''}" data-severity="info" title="Info & Notices (${blueItems.length})">
        <span class="urgency-pill-top"><span class="status-dot blue"></span> ${blueItems.length}</span>
        <span class="urgency-pill-bottom" title="Info & Notices">Info & Notices</span>
      </button>
    </div>

    <!-- Attention Cards List or Lightweight Clear Banner -->
    ${
      displayedItems.length === 0
        ? state.feedScopeFilter === 'all'
          ? `
        <div class="empty-state-box attention-empty-box" style="padding: 24px 16px; margin-top: 10px;">
          <div style="color: var(--green-ready); margin-bottom: 4px;">${renderIcon('check', 28)}</div>
          <h4 style="font-size: 14px; font-weight: 700; margin-top: 6px;">All Attention Items Cleared</h4>
          <p style="font-size: 12px; color: var(--text-secondary); margin-top: 2px; max-width: 480px; margin-inline: auto;">
            No active blockers, unvalidated completion claims, recovering leases, or degraded workers requiring operator intervention.
          </p>
        </div>
      `
          : `
        <div class="project-clear-banner" style="margin-top: 10px;">
          <span class="status-dot green"></span>
          <span><strong>${scopeLabel}</strong>: No attention items in this category. System running autonomously.</span>
        </div>
      `
        : `
      <div class="attention-items-list" style="display: flex; flex-direction: column; gap: 10px; margin-top: 10px;">
        ${displayedItems.map((item) => renderAttentionCardHtml(item)).join('')}
      </div>
    `
    }
  `;

  // Attach Urgency Pill listeners
  section.querySelectorAll('.urgency-pill-btn[data-severity]').forEach((pill) => {
    pill.addEventListener('click', (ev) => {
      const sev = (ev.currentTarget as HTMLElement).getAttribute('data-severity') as any;
      stateManager.setFeedAttentionSeverityFilter(sev);
    });
  });

  attachAttentionCardHandlers(section, state);

  return section;
}

// ---------------------------------------------------------------------------
// Section 2: Active In-Flight Work Snapshot Section
// ---------------------------------------------------------------------------
function renderActiveWorkSection(state: PrototypeState): HTMLElement {
  const section = document.createElement('section');
  section.className = 'feed-section active-work-section';
  section.style.marginTop = '20px';

  const activeTasks = getScopedActiveTasks(state);

  section.innerHTML = `
    <div class="section-title-bar">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span class="status-dot pulsing blue"></span>
        <h3 style="font-size: 15px; font-weight: 700;">Live In-Flight Work</h3>
        <span class="badge badge-blue">${activeTasks.length} Active</span>
      </div>
      <span style="font-size: 11px; color: var(--text-muted);">Real-time agent execution across environments</span>
    </div>

    ${
      activeTasks.length === 0
        ? `
      <div class="card" style="padding: 12px 14px; margin-top: 8px; font-size: 12px; color: var(--text-secondary); text-align: center;">
        No active tasks currently executing in this scope. Work is idle or completed.
      </div>
    `
        : `
      <div class="active-tasks-grid" style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
        ${activeTasks
          .map((task) => {
            const project = state.projects.find((p) => p.id === task.projectId);
            const activeRun = task.runs.find((r) => r.lifecycle === 'running') ?? task.runs[task.runs.length - 1];

            return `
            <div class="card active-task-card" data-task-id="${task.id}">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
                <div>
                  <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                    <span class="badge badge-info">${project?.displayName ?? 'Project'}</span>
                    <span class="status-pill purple" style="font-size: 10px;">Task active · Run running · Lease held</span>
                  </div>
                  <h4 style="font-size: 14px; font-weight: 700; margin-top: 4px;">
                    #${task.id}: ${task.currentVersion.title}
                  </h4>
                </div>
                <span class="status-dot pulsing blue" title="In Progress"></span>
              </div>

              <div style="margin-top: 8px; font-size: 12px; color: var(--text-secondary); background: var(--bg-surface-elevated); padding: 8px 10px; border-radius: var(--radius-sm); display: flex; flex-direction: column; gap: 4px;">
                <div style="display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px;">
                  <span><strong>Lead:</strong> ${task.taskLeadId} · <strong>Env:</strong> ${task.selectedEnvironmentId}</span>
                  <span><strong>Engine:</strong> ${activeRun ? `${activeRun.engine} (${activeRun.workModel})` : 'Pi'}</span>
                </div>
                <div style="color: var(--text-muted); font-size: 11px;">
                  Goal: ${task.currentVersion.goal}
                </div>
              </div>

              <div style="display: flex; justify-content: flex-end; margin-top: 8px;">
                <button class="btn btn-primary btn-sm btn-view-task" data-task-id="${task.id}">
                  View Task in Project →
                </button>
              </div>
            </div>
          `;
          })
          .join('')}
      </div>
    `
    }
  `;

  section.querySelectorAll('.btn-view-task').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const taskId = (ev.currentTarget as HTMLElement).getAttribute('data-task-id');
      if (taskId) {
        stateManager.navigateWithReturn({ nav: 'project', projectTab: 'tasks', taskId }, 'Feed');
      }
    });
  });

  section.querySelectorAll('.active-task-card').forEach((card) => {
    card.addEventListener('click', (ev) => {
      const taskId = (ev.currentTarget as HTMLElement).getAttribute('data-task-id');
      if (taskId) {
        stateManager.navigateWithReturn({ nav: 'project', projectTab: 'tasks', taskId }, 'Feed');
      }
    });
  });

  return section;
}

// ---------------------------------------------------------------------------
// Section 3: Recent Operational Activity Stream Section
// ---------------------------------------------------------------------------
function renderActivityStreamSection(state: PrototypeState): HTMLElement {
  const section = document.createElement('section');
  section.className = 'feed-section activity-section';
  section.style.marginTop = '20px';

  const scopedActivities = getScopedActivities(state);
  const tasksActivities = scopedActivities.filter((a) => a.kind === 'task_lifecycle' || a.kind === 'agent_turn');
  const msgActivities = scopedActivities.filter((a) => a.kind === 'chat_message' || a.kind === 'routing_batch');
  const envActivities = scopedActivities.filter((a) => a.kind === 'env_heartbeat');
  const costActivities = scopedActivities.filter((a) => a.kind === 'usage_milestone');

  let displayed = scopedActivities;
  if (state.feedActivityFilter === 'tasks') displayed = tasksActivities;
  else if (state.feedActivityFilter === 'messages') displayed = msgActivities;
  else if (state.feedActivityFilter === 'envs') displayed = envActivities;
  else if (state.feedActivityFilter === 'usage') displayed = costActivities;

  section.innerHTML = `
    <div class="section-title-bar">
      <div style="display: flex; align-items: center; gap: 8px;">
        ${renderIcon('usage', 18)}
        <h3 style="font-size: 15px; font-weight: 700;">Recent Operational Activity</h3>
      </div>
      <div class="segmented-control" style="font-size: 11px;" role="group" aria-label="Filter activity stream">
        <button class="segmented-btn ${state.feedActivityFilter === 'all' ? 'active' : ''}" data-act-filter="all">
          All (${scopedActivities.length})
        </button>
        <button class="segmented-btn ${state.feedActivityFilter === 'tasks' ? 'active' : ''}" data-act-filter="tasks">
          Tasks (${tasksActivities.length})
        </button>
        <button class="segmented-btn ${state.feedActivityFilter === 'messages' ? 'active' : ''}" data-act-filter="messages">
          Chat (${msgActivities.length})
        </button>
        <button class="segmented-btn ${state.feedActivityFilter === 'envs' ? 'active' : ''}" data-act-filter="envs">
          Envs (${envActivities.length})
        </button>
        <button class="segmented-btn ${state.feedActivityFilter === 'usage' ? 'active' : ''}" data-act-filter="usage">
          Cost (${costActivities.length})
        </button>
      </div>
    </div>

    <div class="activity-stream-list" style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
      ${
        displayed.length === 0
          ? `
        <div class="empty-state-box" style="padding: 20px;">
          <p style="font-size: 12px; color: var(--text-secondary);">No activity records matching this scope and filter.</p>
        </div>
      `
          : displayed.map((item) => renderActivityRowHtml(item)).join('')
      }
    </div>
  `;

  section.querySelectorAll('.segmented-btn[data-act-filter]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const filter = (ev.currentTarget as HTMLElement).getAttribute('data-act-filter') as any;
      stateManager.setFeedActivityFilter(filter);
    });
  });

  attachActivityRowHandlers(section);

  return section;
}

// ---------------------------------------------------------------------------
// HTML Renderers & Event Handlers
// ---------------------------------------------------------------------------

function renderAttentionCardHtml(item: AttentionItem): string {
  const severityClass =
    item.severity === 'action_required'
      ? 'badge-red'
      : item.severity === 'attention'
        ? 'badge-yellow'
        : 'badge-info';

  const severityLabel =
    item.severity === 'action_required'
      ? 'Action Required'
      : item.severity === 'attention'
        ? 'Attention'
        : 'Info Notice';

  const categoryIcon =
    item.category === 'task_validation'
      ? renderIcon('check', 14)
      : item.category === 'task_recovery'
        ? renderIcon('warning', 14)
        : item.category === 'task_blocker'
          ? renderIcon('alert', 14)
          : item.category === 'task_proposed'
            ? renderIcon('play', 14)
            : item.category === 'env_enrollment'
              ? renderIcon('user', 14)
              : renderIcon('warning', 14);

  const categoryName =
    item.category === 'task_validation'
      ? 'Task Validation'
      : item.category === 'task_recovery'
        ? 'Lease Recovery'
        : item.category === 'task_blocker'
          ? 'Task Blocker'
          : item.category === 'task_proposed'
            ? 'Task Proposed'
            : item.category === 'env_enrollment'
              ? 'Worker Enrollment'
              : item.category === 'env_unhealthy'
                ? 'Worker Health'
                : 'Routing Notice';

  return `
    <div class="attention-card ${item.severity === 'action_required' ? 'severity-action-required' : item.severity === 'attention' ? 'severity-attention' : 'severity-info'}"
         data-attention-id="${item.id}"
         data-ref="${item.referenceId}"
         data-cat="${item.category}"
         data-target-nav="${item.targetNav ?? 'project'}"
         data-target-tab="${item.targetProjectTab ?? item.targetManageTab ?? 'tasks'}">
      
      <div class="attention-card-header">
        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
          <span class="category-icon-pill">${categoryIcon} ${categoryName}</span>
          ${item.projectName ? `<span class="badge badge-info" style="font-size: 10px;">${item.projectName}</span>` : ''}
        </div>
        <span class="status-dot ${item.severity === 'action_required' ? 'red' : item.severity === 'attention' ? 'yellow' : 'blue'}" title="${severityLabel}"></span>
      </div>

      <div style="display: flex; flex-direction: column; gap: 3px; margin-top: 4px;">
        <strong style="font-size: 13px; color: var(--text-primary); line-height: 1.3;">${item.title}</strong>
        ${item.lifecycleSentence ? `<div class="lifecycle-sentence">${item.lifecycleSentence}</div>` : ''}
      </div>

      <div class="attention-card-summary" style="margin-top: 2px;">
        ${item.summary}
      </div>

      <div class="attention-card-footer">
        <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-muted);">
          <span>${item.attribution ?? item.referenceId}</span>
          <span>•</span>
          <span>${item.timestamp}</span>
        </div>
        <button class="btn btn-primary btn-sm attention-action-btn" data-attention-id="${item.id}">
          ${item.actionLabel} →
        </button>
      </div>
    </div>
  `;
}

function renderActivityRowHtml(item: ActivityFeedItem): string {
  return `
    <div class="list-item list-item-interactive activity-feed-row"
         data-act-id="${item.id}"
         data-target-nav="${item.targetNav}"
         data-target-proj-tab="${item.targetProjectTab ?? ''}"
         data-target-manage-tab="${item.targetManageTab ?? ''}"
         data-target-entity="${item.targetEntityId ?? ''}">
      <div class="list-item-leading">
        <span class="status-dot ${item.badgeKind}"></span>
      </div>
      <div class="list-item-body">
        <div class="list-item-title" style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
          <span>${item.title}</span>
          ${item.projectName ? `<span class="badge badge-info" style="font-size: 10px;">${item.projectName}</span>` : ''}
        </div>
        <div class="list-item-subtitle">${item.subtitle}</div>
      </div>
      <div class="list-item-trailing">
        <span class="provenance-tag time" title="${item.timestamp}">${item.relativeTime}</span>
        <span class="list-item-chevron">${renderIcon('chevron-right', 14)}</span>
      </div>
    </div>
  `;
}

function attachAttentionCardHandlers(root: HTMLElement, state: PrototypeState) {
  root.querySelectorAll('.attention-action-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const attId = (ev.currentTarget as HTMLElement).getAttribute('data-attention-id');
      const item = state.attentionItems.find((a) => a.id === attId);
      if (!item) return;

      if (
        item.category === 'task_validation' ||
        item.category === 'task_blocker' ||
        item.category === 'task_recovery' ||
        item.category === 'task_proposed'
      ) {
        stateManager.navigateWithReturn(
          {
            nav: 'project',
            projectTab: 'tasks',
            taskId: item.referenceId,
          },
          'Feed'
        );
      } else if (item.category === 'env_enrollment' || item.category === 'env_unhealthy') {
        stateManager.navigateWithReturn(
          {
            nav: 'manage',
            manageTab: 'environments',
            envId: item.referenceId,
          },
          'Feed'
        );
      } else if (item.category === 'routing_fallback') {
        stateManager.navigateWithReturn(
          {
            nav: 'project',
            projectTab: 'chat',
          },
          'Feed'
        );
      }
    });
  });

  root.querySelectorAll('.attention-card').forEach((card) => {
    card.addEventListener('click', (ev) => {
      const attId = (ev.currentTarget as HTMLElement).getAttribute('data-attention-id');
      const item = state.attentionItems.find((a) => a.id === attId);
      if (!item) return;

      if (
        item.category === 'task_validation' ||
        item.category === 'task_blocker' ||
        item.category === 'task_recovery' ||
        item.category === 'task_proposed'
      ) {
        stateManager.navigateWithReturn(
          {
            nav: 'project',
            projectTab: 'tasks',
            taskId: item.referenceId,
          },
          'Feed'
        );
      } else if (item.category === 'env_enrollment' || item.category === 'env_unhealthy') {
        stateManager.navigateWithReturn(
          {
            nav: 'manage',
            manageTab: 'environments',
            envId: item.referenceId,
          },
          'Feed'
        );
      } else if (item.category === 'routing_fallback') {
        stateManager.navigateWithReturn(
          {
            nav: 'project',
            projectTab: 'chat',
          },
          'Feed'
        );
      }
    });
  });
}

function attachActivityRowHandlers(root: HTMLElement) {
  root.querySelectorAll('.activity-feed-row').forEach((row) => {
    row.addEventListener('click', (ev) => {
      const target = ev.currentTarget as HTMLElement;
      const nav = (target.getAttribute('data-target-nav') as any) || 'project';
      const projTab = target.getAttribute('data-target-proj-tab') as any;
      const manageTab = target.getAttribute('data-target-manage-tab') as any;
      const entityId = target.getAttribute('data-target-entity');

      const navTarget: {
        nav: any;
        projectTab?: any;
        manageTab?: any;
        taskId?: string;
        envId?: string;
      } = { nav };

      if (projTab) navTarget.projectTab = projTab;
      if (manageTab) navTarget.manageTab = manageTab;
      if (nav === 'project' && projTab === 'tasks' && entityId) {
        navTarget.taskId = entityId;
      }
      if (nav === 'manage' && manageTab === 'environments' && entityId) {
        navTarget.envId = entityId;
      }

      stateManager.navigateWithReturn(navTarget, 'Feed');
    });
  });
}
