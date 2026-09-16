import { renderIcon } from '../icons.js';
import { stateManager, type PrototypeState } from '../state.js';
import type {
  ActivityFeedItem,
  AttentionItem,
  AttentionSeverity,
  FeedLayoutVariant,
  FeedStatePreset,
} from '../types.js';

export function renderFeedView(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'feed-view';

  // 1. Top Header with Title, State Matrix Controls, and Layout Variant Switcher
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

    <!-- State Matrix Preset Quick Bar -->
    <div class="feed-control-strip">
      <div class="feed-control-label">
        ${renderIcon('sliders', 12)}
        <span>State Matrix:</span>
      </div>
      <div class="feed-preset-pills" role="group" aria-label="Feed state presets">
        <button class="feed-pill-btn ${state.feedStatePreset === 'mixed' ? 'active' : ''}" data-preset="mixed" title="Default realistic multi-agent operational state">
          Mixed (Default)
        </button>
        <button class="feed-pill-btn ${state.feedStatePreset === 'empty' ? 'active' : ''}" data-preset="empty" title="All attention cleared and no active work">
          Empty (All Clear)
        </button>
        <button class="feed-pill-btn ${state.feedStatePreset === 'healthy' ? 'active' : ''}" data-preset="healthy" title="Active work progressing with zero blockers">
          Healthy Active
        </button>
        <button class="feed-pill-btn ${state.feedStatePreset === 'stale' ? 'active' : ''}" data-preset="stale" title="Stale telemetry and unconfirmed lease">
          Stale Telemetry
        </button>
        <button class="feed-pill-btn ${state.feedStatePreset === 'pending' ? 'active' : ''}" data-preset="pending" title="Proposed tasks awaiting authorization & pending enrollment">
          Pending Approvals
        </button>
        <button class="feed-pill-btn ${state.feedStatePreset === 'degraded' ? 'active' : ''}" data-preset="degraded" title="Offline worker holding lease & degraded engine">
          Degraded Host
        </button>
        <button class="feed-pill-btn ${state.feedStatePreset === 'intervention' ? 'active' : ''}" data-preset="intervention" title="Active blockers and completion claim validation">
          Intervention
        </button>
      </div>
    </div>

    <!-- Layout Variant Switcher -->
    <div class="feed-variant-strip">
      <div class="feed-control-label">
        ${renderIcon('grid', 12)}
        <span>Layout Paradigm:</span>
      </div>
      <div class="segmented-control" role="group" aria-label="Feed layout variants">
        <button class="segmented-btn ${state.feedLayoutVariant === 'unified' ? 'active' : ''}" data-variant="unified">
          ${renderIcon('layers', 13)} Variant A: Unified Stream
        </button>
        <button class="segmented-btn ${state.feedLayoutVariant === 'split-board' ? 'active' : ''}" data-variant="split-board">
          ${renderIcon('split', 13)} Variant B: Split Board
        </button>
        <button class="segmented-btn ${state.feedLayoutVariant === 'project-grouped' ? 'active' : ''}" data-variant="project-grouped">
          ${renderIcon('project', 13)} Variant C: Project Grouped
        </button>
      </div>
    </div>
  `;

  // Attach Header Preset & Variant listeners
  headerEl.querySelectorAll('.feed-pill-btn[data-preset]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const preset = (ev.currentTarget as HTMLElement).getAttribute('data-preset') as FeedStatePreset;
      stateManager.setFeedStatePreset(preset);
    });
  });

  headerEl.querySelectorAll('.segmented-btn[data-variant]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const variant = (ev.currentTarget as HTMLElement).getAttribute('data-variant') as FeedLayoutVariant;
      stateManager.setFeedLayoutVariant(variant);
    });
  });

  container.appendChild(headerEl);

  // Render appropriate Layout Variant
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

  const attentionCount = state.attentionItems.length;
  const activityCount = state.activityFeedItems.length;

  // Mobile Top Tab Switcher for Split Board
  const mobileTabSwitch = document.createElement('div');
  mobileTabSwitch.className = 'split-board-mobile-tabs';
  mobileTabSwitch.innerHTML = `
    <div class="segmented-control" style="width: 100%; margin-bottom: 12px;">
      <button class="segmented-btn ${state.mobileFeedSplitTab === 'attention' ? 'active' : ''}" id="split-tab-att">
        ${renderIcon('lightning', 14)} Attention Queue (${attentionCount})
      </button>
      <button class="segmented-btn ${state.mobileFeedSplitTab === 'activity' ? 'active' : ''}" id="split-tab-act">
        ${renderIcon('usage', 14)} Live Activity (${activityCount})
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

  const attentionCount = state.attentionItems.length;

  // Global Urgent Alert Banner if attention items exist
  if (attentionCount > 0) {
    const alertBanner = document.createElement('div');
    alertBanner.className = 'feed-global-attention-banner';
    alertBanner.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        ${renderIcon('lightning', 18)}
        <strong>${attentionCount} Cross-Project Attention Items Active</strong>
      </div>
      <span style="font-size: 11px; color: var(--text-secondary);">Review items within project cards below</span>
    `;
    wrapper.appendChild(alertBanner);
  }

  // Render per-project container cards
  for (const project of state.projects) {
    const projectCard = document.createElement('div');
    projectCard.className = 'feed-project-card card';

    const projectAttentions = state.attentionItems.filter((a) => a.projectId === project.id);
    const projectTasks = state.tasks.filter((t) => t.projectId === project.id);
    const activeTask = projectTasks.find((t) => t.lifecycle === 'active' || t.lifecycle === 'awaiting validation' || t.lifecycle === 'blocked');
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
          : ''
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
          ${projectActivities
            .slice(0, 3)
            .map((act) => renderActivityRowHtml(act))
            .join('')}
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

  // Global Infrastructure Card
  const infraAttentions = state.attentionItems.filter((a) => !a.projectId || a.projectName === 'Infrastructure');
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
      <div style="padding: 12px 0; font-size: 12px; color: var(--green-ready); display: flex; align-items: center; gap: 6px;">
        ${renderIcon('check', 14)} All connected workers and engine readiness probes healthy.
      </div>
    `
    }
  `;

  infraCard.querySelector('.btn-open-envs')?.addEventListener('click', () => {
    stateManager.navigateWithReturn({ nav: 'manage', manageTab: 'environments' }, 'Feed');
  });

  attachAttentionCardHandlers(infraCard, state);
  wrapper.appendChild(infraCard);

  return wrapper;
}

// ---------------------------------------------------------------------------
// Section 1: Prominent Human Attention Section
// ---------------------------------------------------------------------------
function renderAttentionSection(state: PrototypeState): HTMLElement {
  const section = document.createElement('section');
  section.className = 'feed-section attention-section';

  const allItems = state.attentionItems;
  const actionReqItems = allItems.filter((i) => i.severity === 'action_required');
  const valItems = allItems.filter((i) => i.category === 'task_validation');
  const blockItems = allItems.filter((i) => i.category === 'task_blocker');
  const recItems = allItems.filter((i) => i.category === 'task_recovery');
  const envItems = allItems.filter((i) => i.category === 'env_enrollment' || i.category === 'env_unhealthy');
  const propItems = allItems.filter((i) => i.category === 'task_proposed');

  // Filter items based on active attention filter
  let displayedItems = allItems;
  if (state.feedAttentionFilter === 'action_required') {
    displayedItems = actionReqItems;
  } else if (state.feedAttentionFilter === 'task_validation') {
    displayedItems = valItems;
  } else if (state.feedAttentionFilter === 'task_blocker') {
    displayedItems = blockItems;
  } else if (state.feedAttentionFilter === 'task_recovery') {
    displayedItems = recItems;
  } else if (state.feedAttentionFilter === 'env_enrollment' || state.feedAttentionFilter === 'env_unhealthy') {
    displayedItems = envItems;
  } else if (state.feedAttentionFilter === 'task_proposed') {
    displayedItems = propItems;
  }

  // Sort displayed items: action_required first, then attention, then info
  displayedItems.sort((a, b) => {
    const score = (s: AttentionSeverity) => (s === 'action_required' ? 3 : s === 'attention' ? 2 : 1);
    return score(b.severity) - score(a.severity);
  });

  section.innerHTML = `
    <!-- Section Header -->
    <div class="section-title-bar">
      <div style="display: flex; align-items: center; gap: 8px;">
        ${renderIcon('lightning', 18)}
        <h3 style="font-size: 15px; font-weight: 700;">Human Attention Required</h3>
        ${
          allItems.length > 0
            ? `<span class="badge ${actionReqItems.length > 0 ? 'badge-red' : 'badge-yellow'}">${allItems.length} Pending</span>`
            : `<span class="badge badge-green">0 Pending</span>`
        }
      </div>
      <span style="font-size: 11px; color: var(--text-muted); display: none; @media (min-width: 600px) { display: inline; }">
        Prioritized by urgency · ADR-0006/0008/0009
      </span>
    </div>

    <!-- Category Filter Chips -->
    <div class="attention-filter-chips" role="group" aria-label="Filter attention items by category">
      <button class="chip-btn ${state.feedAttentionFilter === 'all' ? 'active' : ''}" data-att-filter="all">
        All (${allItems.length})
      </button>
      <button class="chip-btn ${state.feedAttentionFilter === 'action_required' ? 'active' : ''} ${actionReqItems.length > 0 ? 'chip-danger' : ''}" data-att-filter="action_required">
        Action Required (${actionReqItems.length})
      </button>
      <button class="chip-btn ${state.feedAttentionFilter === 'task_validation' ? 'active' : ''}" data-att-filter="task_validation">
        Validation (${valItems.length})
      </button>
      <button class="chip-btn ${state.feedAttentionFilter === 'task_blocker' ? 'active' : ''}" data-att-filter="task_blocker">
        Blockers (${blockItems.length})
      </button>
      <button class="chip-btn ${state.feedAttentionFilter === 'task_recovery' ? 'active' : ''}" data-att-filter="task_recovery">
        Recovery (${recItems.length})
      </button>
      <button class="chip-btn ${state.feedAttentionFilter === 'env_enrollment' ? 'active' : ''}" data-att-filter="env_enrollment">
        Envs (${envItems.length})
      </button>
      <button class="chip-btn ${state.feedAttentionFilter === 'task_proposed' ? 'active' : ''}" data-att-filter="task_proposed">
        Proposed (${propItems.length})
      </button>
    </div>

    <!-- Attention Cards List or Empty State -->
    ${
      displayedItems.length === 0
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
      <div class="attention-items-list" style="display: flex; flex-direction: column; gap: 10px; margin-top: 10px;">
        ${displayedItems.map((item) => renderAttentionCardHtml(item)).join('')}
      </div>
    `
    }
  `;

  // Attach Attention Filter listeners
  section.querySelectorAll('.chip-btn[data-att-filter]').forEach((chip) => {
    chip.addEventListener('click', (ev) => {
      const filter = (ev.currentTarget as HTMLElement).getAttribute('data-att-filter') as any;
      stateManager.setFeedAttentionFilter(filter);
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

  const activeTasks = state.tasks.filter((t) => t.lifecycle === 'active' || t.agentRunLifecycle === 'running');

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
      <div class="card" style="padding: 14px 16px; margin-top: 8px; font-size: 12px; color: var(--text-secondary); text-align: center;">
        No active tasks currently executing. Work is idle or completed.
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
                <span class="provenance-tag active" style="font-size: 11px;">
                  <span class="status-dot pulsing blue"></span> In Progress
                </span>
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

  const allActivities = state.activityFeedItems;
  const tasksActivities = allActivities.filter((a) => a.kind === 'task_lifecycle' || a.kind === 'agent_turn');
  const msgActivities = allActivities.filter((a) => a.kind === 'chat_message' || a.kind === 'routing_batch');
  const envActivities = allActivities.filter((a) => a.kind === 'env_heartbeat');
  const costActivities = allActivities.filter((a) => a.kind === 'usage_milestone');

  let displayed = allActivities;
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
          All (${allActivities.length})
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
          <p style="font-size: 12px; color: var(--text-secondary);">No activity records matching this filter.</p>
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
        <span class="badge ${severityClass}">${severityLabel}</span>
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

      if (item.category === 'task_validation' || item.category === 'task_blocker' || item.category === 'task_recovery' || item.category === 'task_proposed') {
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

      if (item.category === 'task_validation' || item.category === 'task_blocker' || item.category === 'task_recovery' || item.category === 'task_proposed') {
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
