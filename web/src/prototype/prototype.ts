import { renderIcon } from './icons.js';
import { activateOnKeyboard } from './keyboard.js';
import { stateManager } from './state.js';
import type { PrimaryNav, ViewportMode, ProjectTab, ManageTab } from './types.js';
import { renderFeedView } from './views/feed-view.js';
import { renderProjectsView } from './views/projects-view.js';
import { renderManageView } from './views/manage-view.js';
import { renderPrimitivesView } from './views/primitives-view.js';
import { renderInspectorSheet } from './views/inspector-view.js';
import { renderReviewDrawer } from './views/review-drawer.js';

export function initPrototype(mountEl: HTMLElement): void {
  function render() {
    if (typeof document === 'undefined' || !document.documentElement || !mountEl.isConnected) {
      return;
    }
    const state = stateManager.getSnapshot();
    mountEl.innerHTML = '';

    // Set global theme and density on root html, body and app container
    document.documentElement.setAttribute('data-theme', state.theme);
    document.body.setAttribute('data-theme', state.theme);

    // Root App Container with theme and density attributes
    const appEl = document.createElement('div');
    appEl.id = 'prototype-app';
    appEl.setAttribute('data-theme', state.theme);
    appEl.setAttribute('data-density', state.density);

    // 1. Top Global Control Bar
    const controlBar = document.createElement('header');
    controlBar.className = 'proto-control-bar';
    controlBar.innerHTML = `
      <div class="proto-brand">
        ${renderIcon('sprout', 20)}
        <span>Sprout Mobile Operator</span>
        <span class="proto-badge">Ticket #61 Baseline</span>
      </div>

      <div class="proto-controls-group">
        <!-- Viewport Switcher -->
        <div class="segmented-control" role="group" aria-label="Viewport switcher">
          <button class="segmented-btn ${state.viewportMode === 'mobile' ? 'active' : ''}" data-mode="mobile" title="Simulated 390px Phone">
            ${renderIcon('phone', 14)} Phone (390px)
          </button>
          <button class="segmented-btn ${state.viewportMode === 'desktop' ? 'active' : ''}" data-mode="desktop" title="Desktop Sidebar Layout">
            ${renderIcon('desktop', 14)} Desktop
          </button>
          <button class="segmented-btn ${state.viewportMode === 'fluid' ? 'active' : ''}" data-mode="fluid" title="Responsive Fluid">
            ${renderIcon('fluid', 14)} Fluid
          </button>
        </div>

        <!-- Theme & Density Quick Toggles -->
        <div class="segmented-control">
          <button class="segmented-btn" id="top-theme-btn" title="Toggle Dark / Light Theme">
            ${state.theme === 'dark' ? renderIcon('moon', 13) + ' Dark' : renderIcon('sun', 13) + ' Light'}
          </button>
          <button class="segmented-btn" id="top-density-btn" title="Toggle Comfortable / Compact Density">
            ${state.density === 'comfortable' ? renderIcon('sliders', 13) + ' Comfortable' : renderIcon('sliders', 13) + ' Compact'}
          </button>
        </div>

        <!-- Operator Pill in Control Bar -->
        <div class="operator-pill" title="Operator Session · ${state.operator.transport}">
          <span class="status-dot ${state.operator.connectionState === 'online' ? 'green' : 'yellow'}"></span>
          <span>${state.operator.name}</span>
        </div>

        <!-- Shared Baseline & Primitives Quick Nav -->
        <button class="btn btn-sm ${state.primaryNav === 'primitives' ? 'btn-primary' : 'btn-secondary'}" id="top-primitives-btn" title="Shared Interaction Primitives & State Language">
          ${renderIcon('palette', 14)} Style Baseline
        </button>

        <button class="review-btn" id="open-review-btn">
          ${renderIcon('clipboard', 14)} Owner Review
        </button>
      </div>
    `;

    // Top control bar event listeners
    controlBar.querySelectorAll('.segmented-btn[data-mode]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        const mode = (ev.currentTarget as HTMLElement).getAttribute('data-mode') as ViewportMode;
        stateManager.setViewportMode(mode);
      });
    });

    controlBar.querySelector('#top-theme-btn')?.addEventListener('click', () => {
      stateManager.toggleTheme();
    });

    controlBar.querySelector('#top-density-btn')?.addEventListener('click', () => {
      stateManager.toggleDensity();
    });

    controlBar.querySelector('#top-primitives-btn')?.addEventListener('click', () => {
      stateManager.setPrimaryNav('primitives');
    });

    controlBar.querySelector('#open-review-btn')?.addEventListener('click', () => {
      stateManager.toggleReviewDrawer(true);
    });

    appEl.appendChild(controlBar);

    // 2. Viewport Stage Area
    const stageEl = document.createElement('div');
    stageEl.className = `viewport-stage mode-${state.viewportMode}`;

    // App Shell Container
    const shellEl = document.createElement('div');
    shellEl.className = 'app-shell';

    // Device notch simulation for mobile phone viewport
    const notchEl = document.createElement('div');
    notchEl.className = 'phone-notch';
    shellEl.appendChild(notchEl);

    // Return Breadcrumb Banner (if deep-linked from Feed)
    if (state.returnContext) {
      const returnBanner = document.createElement('div');
      returnBanner.className = 'return-context-banner';
      returnBanner.innerHTML = `
        <button class="return-context-btn" id="btn-pop-return">
          <span>← Back to ${state.returnContext.fromLabel}</span>
        </button>
        <button class="return-dismiss-btn" id="btn-dismiss-return" title="Dismiss return link" aria-label="Dismiss return link">${renderIcon('close', 12)}</button>
      `;

      returnBanner.querySelector('#btn-pop-return')?.addEventListener('click', () => {
        stateManager.popReturnContext();
      });

      returnBanner.querySelector('#btn-dismiss-return')?.addEventListener('click', () => {
        stateManager.clearReturnContext();
      });

      shellEl.appendChild(returnBanner);
    }

    // App Body (Desktop Sidebar + Main View)
    const appBody = document.createElement('div');
    appBody.className = 'app-body';

    // Desktop Left Sidebar (visible in desktop & wide fluid mode)
    const sidebar = document.createElement('aside');
    sidebar.className = 'desktop-sidebar';

    const feedScenario = state.primaryNav === 'feed' ? state.feedScenarioSnapshot : undefined;
    const attentionCount = feedScenario?.attentionItems.length ?? state.attentionItems.length;
    const activeTasksCount = feedScenario
      ? feedScenario.activeTaskIds.length
      : state.tasks.filter((t) => t.lifecycle === 'active' || t.lifecycle === 'awaiting validation').length;
    const hasDegradedEnv = feedScenario
      ? feedScenario.degradedEnvironmentIds.length > 0
      : state.environments.some((e) => e.trafficLight === 'red' || e.trafficLight === 'yellow');

    sidebar.innerHTML = `
      <div class="sidebar-header">
        <div class="sidebar-logo">
          ${renderIcon('sprout', 18)}
          <span>Sprout MVP</span>
        </div>
        <span class="badge badge-info" style="font-size: 10px;">M2 Operator</span>
      </div>

      <!-- Section: Operations -->
      <div class="sidebar-section-label">OPERATIONS</div>
      <ul class="sidebar-nav">
        <li><button type="button" class="sidebar-nav-item ${state.primaryNav === 'feed' ? 'active' : ''}" data-nav="feed"${state.primaryNav === 'feed' ? ' aria-current="page"' : ''}>
          <div style="display: flex; align-items: center; gap: 8px;">
            ${renderIcon('feed', 16)}
            <span>Feed</span>
          </div>
          ${attentionCount > 0 ? `<span class="nav-badge yellow">${attentionCount}</span>` : ''}
        </button></li>
      </ul>

      <!-- Section: Project -->
      <div class="sidebar-section-label" style="margin-top: 14px;">PROJECT</div>
      <ul class="sidebar-nav">
        <li><button type="button" class="sidebar-nav-item ${state.primaryNav === 'project' && state.projectTab === 'overview' ? 'active' : ''}" data-nav="project" data-project-tab="overview"${state.primaryNav === 'project' && state.projectTab === 'overview' ? ' aria-current="page"' : ''}>
          <div style="display: flex; align-items: center; gap: 8px;">
            ${renderIcon('overview', 16)}
            <span>Overview & Contract</span>
          </div>
        </button></li>
        <li><button type="button" class="sidebar-nav-item ${state.primaryNav === 'project' && state.projectTab === 'tasks' ? 'active' : ''}" data-nav="project" data-project-tab="tasks"${state.primaryNav === 'project' && state.projectTab === 'tasks' ? ' aria-current="page"' : ''}>
          <div style="display: flex; align-items: center; gap: 8px;">
            ${renderIcon('tasks', 16)}
            <span>Tasks & Leases</span>
          </div>
          ${activeTasksCount > 0 ? `<span class="nav-badge ${state.tasks.some((t) => t.lifecycle === 'awaiting validation') ? 'purple' : 'blue'}">${activeTasksCount}</span>` : ''}
        </button></li>
        <li><button type="button" class="sidebar-nav-item ${state.primaryNav === 'project' && state.projectTab === 'chat' ? 'active' : ''}" data-nav="project" data-project-tab="chat"${state.primaryNav === 'project' && state.projectTab === 'chat' ? ' aria-current="page"' : ''}>
          <div style="display: flex; align-items: center; gap: 8px;">
            ${renderIcon('chat', 16)}
            <span>Project Chat</span>
          </div>
        </button></li>
      </ul>

      <!-- Section: Manage (Gear) -->
      <div class="sidebar-section-label" style="margin-top: 14px;">MANAGE</div>
      <ul class="sidebar-nav">
        <li><button type="button" class="sidebar-nav-item ${state.primaryNav === 'manage' && state.manageTab === 'environments' ? 'active' : ''}" data-nav="manage" data-manage-tab="environments"${state.primaryNav === 'manage' && state.manageTab === 'environments' ? ' aria-current="page"' : ''}>
          <div style="display: flex; align-items: center; gap: 8px;">
            ${renderIcon('environments', 16)}
            <span>Environments</span>
          </div>
          <span class="status-dot ${hasDegradedEnv ? 'yellow' : 'green'}"></span>
        </button></li>
        <li><button type="button" class="sidebar-nav-item ${state.primaryNav === 'manage' && state.manageTab === 'agents' ? 'active' : ''}" data-nav="manage" data-manage-tab="agents"${state.primaryNav === 'manage' && state.manageTab === 'agents' ? ' aria-current="page"' : ''}>
          <div style="display: flex; align-items: center; gap: 8px;">
            ${renderIcon('agents', 16)}
            <span>Global Agents</span>
          </div>
          <span class="nav-badge">${state.agents.length}</span>
        </button></li>
        <li><button type="button" class="sidebar-nav-item ${state.primaryNav === 'manage' && state.manageTab === 'usage' ? 'active' : ''}" data-nav="manage" data-manage-tab="usage"${state.primaryNav === 'manage' && state.manageTab === 'usage' ? ' aria-current="page"' : ''}>
          <div style="display: flex; align-items: center; gap: 8px;">
            ${renderIcon('usage', 16)}
            <span>Usage & Costs</span>
          </div>
        </button></li>
        <li><button type="button" class="sidebar-nav-item ${state.primaryNav === 'manage' && state.manageTab === 'settings' ? 'active' : ''}" data-nav="manage" data-manage-tab="settings"${state.primaryNav === 'manage' && state.manageTab === 'settings' ? ' aria-current="page"' : ''}>
          <div style="display: flex; align-items: center; gap: 8px;">
            ${renderIcon('settings', 16)}
            <span>Settings</span>
          </div>
        </button></li>
      </ul>

      <!-- Section: Design Baseline -->
      <div class="sidebar-section-label" style="margin-top: 14px;">DESIGN BASELINE</div>
      <ul class="sidebar-nav">
        <li><button type="button" class="sidebar-nav-item ${state.primaryNav === 'primitives' ? 'active' : ''}" data-nav="primitives"${state.primaryNav === 'primitives' ? ' aria-current="page"' : ''}>
          <div style="display: flex; align-items: center; gap: 8px;">
            ${renderIcon('palette', 16)}
            <span>Interaction Primitives</span>
          </div>
          <span class="nav-badge blue">#61</span>
        </button></li>
      </ul>

      <div class="sidebar-footer">
        <div>Operator: <strong>${state.operator.name}</strong></div>
        <div style="font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); margin-top: 2px;">
          ${state.operator.overlayAddress ?? 'private transport configured'}
        </div>
      </div>
    `;

    sidebar.querySelectorAll('.sidebar-nav-item[data-nav]').forEach((item) => {
      const navigate = () => {
        const target = item as HTMLElement;
        const nav = target.getAttribute('data-nav') as PrimaryNav;
        const projectTab = target.getAttribute('data-project-tab') as ProjectTab | null;
        const manageTab = target.getAttribute('data-manage-tab') as ManageTab | null;
        stateManager.setPrimaryNav(nav, projectTab ?? undefined, manageTab ?? undefined);
      };
      item.addEventListener('click', navigate);
      activateOnKeyboard(item as HTMLElement, navigate);
    });

    appBody.appendChild(sidebar);

    // Render Active Main View Container
    const mainContentArea = document.createElement('main');
    mainContentArea.className = 'main-content-viewport';

    if (state.primaryNav === 'feed') {
      mainContentArea.appendChild(renderFeedView(state));
    } else if (state.primaryNav === 'project') {
      mainContentArea.appendChild(renderProjectsView(state));
    } else if (state.primaryNav === 'manage') {
      mainContentArea.appendChild(renderManageView(state));
    } else if (state.primaryNav === 'primitives') {
      mainContentArea.appendChild(renderPrimitivesView(state));
    } else {
      mainContentArea.appendChild(renderFeedView(state));
    }

    appBody.appendChild(mainContentArea);
    shellEl.appendChild(appBody);

    // Mobile Bottom Navigation Bar (Phone viewports)
    const mobileBottomNav = document.createElement('nav');
    mobileBottomNav.className = 'mobile-bottom-nav';
    mobileBottomNav.setAttribute('aria-label', 'Primary navigation');

    if (state.primaryNav === 'project') {
      // Dynamic Sub-Navigation for Project on Mobile
      mobileBottomNav.classList.add('mode-sub-nav');
      mobileBottomNav.innerHTML = `
        <button type="button" class="bottom-nav-item nav-back-btn" data-action="back-to-root" aria-label="Back to Main" title="Back to Main Destinations">
          <span class="bottom-nav-icon">${renderIcon('chevron-left', 18)}</span>
          <span style="font-size: 9px; font-weight: 700;">Back</span>
        </button>
        <button type="button" class="bottom-nav-item sub-nav-tab ${state.projectTab === 'overview' ? 'active' : ''}" data-project-tab="overview" aria-label="Overview"${state.projectTab === 'overview' ? ' aria-current="page"' : ''}>
          <span class="bottom-nav-icon">${renderIcon('overview', 20)}</span>
          <span>Overview</span>
        </button>
        <button type="button" class="bottom-nav-item sub-nav-tab ${state.projectTab === 'tasks' ? 'active' : ''}" data-project-tab="tasks" aria-label="Tasks"${state.projectTab === 'tasks' ? ' aria-current="page"' : ''}>
          <span class="bottom-nav-icon">${renderIcon('tasks', 20)}</span>
          <span>Tasks</span>
          ${activeTasksCount > 0 ? `<span class="bottom-nav-badge blue">${activeTasksCount}</span>` : ''}
        </button>
        <button type="button" class="bottom-nav-item sub-nav-tab ${state.projectTab === 'chat' ? 'active' : ''}" data-project-tab="chat" aria-label="Chat"${state.projectTab === 'chat' ? ' aria-current="page"' : ''}>
          <span class="bottom-nav-icon">${renderIcon('chat', 20)}</span>
          <span>Chat</span>
        </button>
      `;
    } else if (state.primaryNav === 'manage') {
      // Dynamic Sub-Navigation for Manage on Mobile
      mobileBottomNav.classList.add('mode-sub-nav');
      mobileBottomNav.innerHTML = `
        <button type="button" class="bottom-nav-item nav-back-btn" data-action="back-to-root" aria-label="Back to Main" title="Back to Main Destinations">
          <span class="bottom-nav-icon">${renderIcon('chevron-left', 18)}</span>
          <span style="font-size: 9px; font-weight: 700;">Back</span>
        </button>
        <button type="button" class="bottom-nav-item sub-nav-tab ${state.manageTab === 'environments' ? 'active' : ''}" data-manage-tab="environments" aria-label="Envs"${state.manageTab === 'environments' ? ' aria-current="page"' : ''}>
          <span class="bottom-nav-icon">${renderIcon('environments', 20)}</span>
          <span>Envs</span>
          ${hasDegradedEnv ? `<span class="bottom-nav-dot red"></span>` : ''}
        </button>
        <button type="button" class="bottom-nav-item sub-nav-tab ${state.manageTab === 'agents' ? 'active' : ''}" data-manage-tab="agents" aria-label="Agents"${state.manageTab === 'agents' ? ' aria-current="page"' : ''}>
          <span class="bottom-nav-icon">${renderIcon('agents', 20)}</span>
          <span>Agents</span>
          <span class="bottom-nav-badge">${state.agents.length}</span>
        </button>
        <button type="button" class="bottom-nav-item sub-nav-tab ${state.manageTab === 'usage' ? 'active' : ''}" data-manage-tab="usage" aria-label="Usage"${state.manageTab === 'usage' ? ' aria-current="page"' : ''}>
          <span class="bottom-nav-icon">${renderIcon('usage', 20)}</span>
          <span>Usage</span>
        </button>
        <button type="button" class="bottom-nav-item sub-nav-tab ${state.manageTab === 'settings' ? 'active' : ''}" data-manage-tab="settings" aria-label="Settings"${state.manageTab === 'settings' ? ' aria-current="page"' : ''}>
          <span class="bottom-nav-icon">${renderIcon('settings', 20)}</span>
          <span>Settings</span>
        </button>
      `;
    } else {
      // Root Top-Level Navigation for Feed & Primitives
      mobileBottomNav.innerHTML = `
        <button type="button" class="bottom-nav-item ${state.primaryNav === 'feed' ? 'active' : ''}" data-nav="feed" aria-label="Feed cross-project landing"${state.primaryNav === 'feed' ? ' aria-current="page"' : ''}>
          <span class="bottom-nav-icon">${renderIcon('feed', 20)}</span>
          <span>Feed</span>
          ${attentionCount > 0 ? `<span class="bottom-nav-badge">${attentionCount}</span>` : ''}
        </button>
        <button type="button" class="bottom-nav-item" data-nav="project" aria-label="Project workspace, tasks and chat">
          <span class="bottom-nav-icon">${renderIcon('project', 20)}</span>
          <span>Project</span>
          ${activeTasksCount > 0 ? `<span class="bottom-nav-badge blue">${activeTasksCount}</span>` : ''}
        </button>
        <button type="button" class="bottom-nav-item" data-nav="manage" aria-label="Manage environments, agents, usage and settings">
          <span class="bottom-nav-icon">${renderIcon('manage', 20)}</span>
          <span>Manage</span>
          ${hasDegradedEnv ? `<span class="bottom-nav-dot red"></span>` : ''}
        </button>
      `;
    }

    mobileBottomNav.querySelectorAll('.bottom-nav-item[data-nav]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        const nav = (ev.currentTarget as HTMLElement).getAttribute('data-nav') as PrimaryNav;
        stateManager.setPrimaryNav(nav);
      });
    });

    mobileBottomNav.querySelectorAll('.bottom-nav-item[data-project-tab]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        const tab = (ev.currentTarget as HTMLElement).getAttribute('data-project-tab') as ProjectTab;
        stateManager.setProjectTab(tab);
      });
    });

    mobileBottomNav.querySelectorAll('.bottom-nav-item[data-manage-tab]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        const tab = (ev.currentTarget as HTMLElement).getAttribute('data-manage-tab') as ManageTab;
        stateManager.setManageTab(tab);
      });
    });

    mobileBottomNav.querySelectorAll('.bottom-nav-item[data-action="back-to-root"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        stateManager.setPrimaryNav('feed');
      });
    });

    shellEl.appendChild(mobileBottomNav);
    stageEl.appendChild(shellEl);
    appEl.appendChild(stageEl);

    // 3. Active Dialogs / Bottom Sheets / Danger Confirmation
    if (state.activeDialog) {
      const dialog = state.activeDialog;
      const dialogOverlay = document.createElement('div');
      dialogOverlay.className = 'dialog-overlay';

      if (dialog.kind === 'danger-confirm') {
        const confirmPhrase = dialog.requireTypedConfirmation ?? 'CONFIRM';
        dialogOverlay.innerHTML = `
          <div class="danger-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title">
            <div class="dialog-header danger">
              ${renderIcon('warning', 20)}
              <strong id="dialog-title" style="font-size: 15px;">${dialog.title}</strong>
            </div>
            <div class="dialog-body">
              ${dialog.subtitle ? `<div style="font-weight: 600; color: var(--red-action); margin-bottom: 6px;">${dialog.subtitle}</div>` : ''}
              <p style="font-size: 13px; color: var(--text-secondary); line-height: 1.4;">${dialog.bodyText ?? ''}</p>
              
              <div style="margin-top: 12px; background: var(--bg-app); padding: 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);">
                <label class="form-label" for="danger-confirm-input" style="font-size: 12px;">
                  Type <code>${confirmPhrase}</code> to proceed:
                </label>
                <input type="text" class="form-input" id="danger-confirm-input" placeholder="${confirmPhrase}" autocomplete="off" />
              </div>
            </div>
            <div class="dialog-footer">
              <button class="btn btn-secondary" id="dialog-cancel-btn">${dialog.cancelLabel ?? 'Cancel'}</button>
              <button class="btn btn-danger" id="dialog-confirm-btn" disabled>${dialog.confirmLabel ?? 'Proceed'}</button>
            </div>
          </div>
        `;

        const input = dialogOverlay.querySelector('#danger-confirm-input') as HTMLInputElement;
        const confirmBtn = dialogOverlay.querySelector('#dialog-confirm-btn') as HTMLButtonElement;
        input?.addEventListener('input', () => {
          confirmBtn.disabled = input.value.trim() !== confirmPhrase;
        });

        confirmBtn?.addEventListener('click', () => {
          if (dialog.onConfirm) dialog.onConfirm();
          else stateManager.closeDialog();
        });

        dialogOverlay.querySelector('#dialog-cancel-btn')?.addEventListener('click', () => {
          if (dialog.onCancel) dialog.onCancel();
          else stateManager.closeDialog();
        });
      } else {
        // Standard Bottom Sheet / Modal Dialog
        dialogOverlay.innerHTML = `
          <div class="${state.viewportMode === 'mobile' ? 'bottom-sheet' : 'modal-dialog'}" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
            ${state.viewportMode === 'mobile' ? '<div class="sheet-drag-handle"></div>' : ''}
            <div class="dialog-header">
              <div>
                <strong id="dialog-title" style="font-size: 15px;">${dialog.title}</strong>
                ${dialog.subtitle ? `<div style="font-size: 12px; color: var(--text-secondary);">${dialog.subtitle}</div>` : ''}
              </div>
              <button class="btn btn-ghost btn-sm" id="dialog-close-x" aria-label="Close dialog">${renderIcon('close', 14)}</button>
            </div>
            <div class="dialog-body">
              <p style="font-size: 13px; color: var(--text-secondary); line-height: 1.5;">${dialog.bodyText ?? ''}</p>
            </div>
            <div class="dialog-footer">
              <button class="btn btn-secondary" id="dialog-cancel-btn">${dialog.cancelLabel ?? 'Cancel'}</button>
              <button class="btn btn-primary" id="dialog-confirm-btn">${dialog.confirmLabel ?? 'Confirm'}</button>
            </div>
          </div>
        `;

        dialogOverlay.querySelector('#dialog-close-x')?.addEventListener('click', () => {
          stateManager.closeDialog();
        });
        dialogOverlay.querySelector('#dialog-cancel-btn')?.addEventListener('click', () => {
          if (dialog.onCancel) dialog.onCancel();
          else stateManager.closeDialog();
        });
        dialogOverlay.querySelector('#dialog-confirm-btn')?.addEventListener('click', () => {
          if (dialog.onConfirm) dialog.onConfirm();
          else stateManager.closeDialog();
        });
      }

      // Close on backdrop click
      dialogOverlay.addEventListener('click', (e) => {
        if (e.target === dialogOverlay) {
          stateManager.closeDialog();
        }
      });

      appEl.appendChild(dialogOverlay);
    }

    // 4. Slide-Over Inspector Sheet
    const inspectorEl = renderInspectorSheet(state);
    if (inspectorEl) {
      appEl.appendChild(inspectorEl);
    }

    // 5. Owner Review Drawer
    const reviewDrawerEl = renderReviewDrawer(state);
    if (reviewDrawerEl) {
      appEl.appendChild(reviewDrawerEl);
    }

    mountEl.appendChild(appEl);
  }

  // Subscribe to state changes
  stateManager.subscribe(render);

  // Browser History Navigation (Back/Forward buttons)
  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', (ev) => {
      const state = stateManager.getSnapshot();
      if (ev.state?.page === 'task-detail' && ev.state.taskId) {
        stateManager.openTaskDetail(ev.state.taskId, false);
      } else if (ev.state?.page === 'task-list') {
        stateManager.closeTaskDetail(false);
      } else if (ev.state?.page === 'chat-detail') {
        stateManager.openChatDetail(ev.state.scopeKind, ev.state.scopeId, false);
      } else if (ev.state?.page === 'chat-list') {
        stateManager.closeChatDetail(false);
      } else if (ev.state?.page === 'env-detail' && ev.state.envId) {
        stateManager.openEnvironmentDetail(ev.state.envId, false);
      } else if (ev.state?.page === 'env-list') {
        stateManager.closeEnvironmentDetail(false);
      } else if (ev.state?.page === 'agent-detail' && ev.state.agentId) {
        stateManager.openAgentDetail(ev.state.agentId, false);
      } else if (ev.state?.page === 'agent-list') {
        stateManager.closeAgentDetail(false);
      } else if (state.primaryNav === 'manage' && state.manageTab === 'environments' && state.environmentViewMode === 'detail') {
        stateManager.closeEnvironmentDetail(false);
      } else if (state.primaryNav === 'manage' && state.manageTab === 'agents' && state.agentViewMode === 'detail') {
        stateManager.closeAgentDetail(false);
      } else if (state.primaryNav === 'project' && state.projectTab === 'tasks' && state.taskViewMode === 'detail') {
        stateManager.closeTaskDetail(false);
      } else if (state.primaryNav === 'project' && state.projectTab === 'chat' && state.chatViewMode === 'detail') {
        stateManager.closeChatDetail(false);
      }
    });
  }

  // Initial render
  render();
}
