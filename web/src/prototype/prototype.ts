import { stateManager, type ActiveTab, type ViewportMode } from './state.js';
import { renderInspectorSheet } from './views/inspector-view.js';
import { renderReviewDrawer } from './views/review-drawer.js';
import { renderVariantA } from './variants/variant-a.js';
import { renderVariantB } from './variants/variant-b.js';
import { renderVariantC } from './variants/variant-c.js';
import {
  getActiveVariant,
  renderVariantSwitcher,
  setActiveVariant,
  attachVariantKeyboardShortcuts,
  type VariantKey,
} from './components/variant-switcher.js';

export function initPrototype(mountEl: HTMLElement): void {
  function render() {
    const state = stateManager.getSnapshot();
    const activeVariant = getActiveVariant();
    mountEl.innerHTML = '';

    // Root App Container
    const appEl = document.createElement('div');
    appEl.id = 'prototype-app';

    // Top Global Control Bar
    const controlBar = document.createElement('header');
    controlBar.className = 'proto-control-bar';
    controlBar.innerHTML = `
      <div class="proto-brand">
        <span style="font-size: 18px;">🌱</span>
        <span>Sprout M2 Operator Prototype</span>
        <span class="proto-badge">Ticket #53</span>
      </div>

      <div class="proto-controls-group">
        <!-- Variant Switcher in Top Bar -->
        <div class="segmented-control" style="border-color: #38bdf8;">
          <button class="segmented-btn variant-top-btn ${activeVariant === 'A' ? 'active' : ''}" data-variant="A">
            Variant A (Feed)
          </button>
          <button class="segmented-btn variant-top-btn ${activeVariant === 'B' ? 'active' : ''}" data-variant="B">
            Variant B (Hub)
          </button>
          <button class="segmented-btn variant-top-btn ${activeVariant === 'C' ? 'active' : ''}" data-variant="C">
            Variant C (Deck)
          </button>
        </div>

        <!-- Viewport Mode Switcher -->
        <div class="segmented-control">
          <button class="segmented-btn ${state.viewportMode === 'mobile' ? 'active' : ''}" data-mode="mobile">
            📱 Phone (390px)
          </button>
          <button class="segmented-btn ${state.viewportMode === 'desktop' ? 'active' : ''}" data-mode="desktop">
            💻 Desktop Full
          </button>
          <button class="segmented-btn ${state.viewportMode === 'fluid' ? 'active' : ''}" data-mode="fluid">
            ↔️ Fluid
          </button>
        </div>

        <!-- Scenario Jumpers Dropdown -->
        <select class="scenario-select" id="scenario-jumper">
          <option value="" disabled selected>⚡ Jump to Scenario...</option>
          <option value="attention">1. Attention Hub & Action Queue</option>
          <option value="active-task">2. Active Task (2-Stage Pause & Interrupt)</option>
          <option value="validation-claim">3. Task Completion Claim (Validation/Correction)</option>
          <option value="blocker-versioning">4. Task Blocker & Content Versioning</option>
          <option value="ordinary-recovery">5. Worker Disconnect & Ordinary Recovery</option>
          <option value="emergency-force-release">6. Emergency Override (Force Release)</option>
          <option value="wake-routing-batch">7. Wake-Model Assisted Routing & Loops</option>
          <option value="usage-telemetry">8. Usage & Cost Observability (6 Views)</option>
          <option value="first-run-onboarding">9. First-Run Onboarding Wizard</option>
        </select>

        <button class="review-btn" id="open-review-btn">
          <span>📋</span> Owner Review
        </button>
      </div>
    `;

    // Variant button listeners in top bar
    controlBar.querySelectorAll('.variant-top-btn').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        const v = (ev.currentTarget as HTMLElement).getAttribute('data-variant') as VariantKey;
        setActiveVariant(v, render);
      });
    });

    // Viewport button listeners
    controlBar.querySelectorAll('.segmented-btn[data-mode]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        const mode = (ev.currentTarget as HTMLElement).getAttribute('data-mode') as ViewportMode;
        stateManager.setViewportMode(mode);
      });
    });

    // Scenario select listener
    const scenarioSelect = controlBar.querySelector('#scenario-jumper') as HTMLSelectElement;
    scenarioSelect?.addEventListener('change', (ev) => {
      const val = (ev.target as HTMLSelectElement).value;
      if (val) {
        stateManager.loadScenarioPreset(val);
        scenarioSelect.value = '';
      }
    });

    // Review drawer listener
    controlBar.querySelector('#open-review-btn')?.addEventListener('click', () => {
      stateManager.toggleReviewDrawer();
    });

    appEl.appendChild(controlBar);

    // Viewport Stage Area
    const stageEl = document.createElement('div');
    stageEl.className = `viewport-stage mode-${state.viewportMode}`;

    // Inside Stage: App Shell
    const shellEl = document.createElement('div');
    shellEl.className = 'app-shell';

    // Device notch simulation for mobile mode
    const notchEl = document.createElement('div');
    notchEl.className = 'phone-notch';
    shellEl.appendChild(notchEl);

    // App Header
    const appHeader = document.createElement('header');
    appHeader.className = 'app-header';

    let headerTitle = 'Attention Hub';
    if (state.activeTab === 'projects') headerTitle = 'Project Channels & Workspaces';
    if (state.activeTab === 'tasks') headerTitle = 'Task Authority & Lifecycle';
    if (state.activeTab === 'environments') headerTitle = 'Environment Workers & Health';
    if (state.activeTab === 'agents') headerTitle = 'Agent Work Options';
    if (state.activeTab === 'usage') headerTitle = 'Usage & Cost Observability';
    if (state.activeTab === 'onboarding') headerTitle = 'First-Run Onboarding';

    if (activeVariant === 'A') headerTitle = 'Operations & Action Feed';
    if (activeVariant === 'C') headerTitle = 'Task & Lease Kanban Deck';

    appHeader.innerHTML = `
      <div class="app-header-title">
        <span style="font-size: 16px;">🌱</span>
        <span>${headerTitle}</span>
      </div>
      <div class="operator-pill">
        <span class="status-dot ${state.operator.connectionState === 'online' ? 'green' : 'yellow'}"></span>
        <span>${state.operator.name}</span>
      </div>
    `;
    shellEl.appendChild(appHeader);

    // App Body (Desktop Sidebar + Main View)
    const appBody = document.createElement('div');
    appBody.className = 'app-body';

    // Desktop Sidebar (Shown in Variant B & desktop mode)
    if (activeVariant === 'B') {
      const sidebar = document.createElement('aside');
      sidebar.className = 'desktop-sidebar';
      sidebar.innerHTML = `
        <div class="sidebar-header">
          <div class="sidebar-logo">
            <span>🌱</span>
            <span>Sprout MVP</span>
          </div>
        </div>
        <ul class="sidebar-nav">
          <li class="sidebar-nav-item ${state.activeTab === 'attention' ? 'active' : ''}" data-tab="attention">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span>🚨</span>
              <span>Attention Hub</span>
            </div>
            ${state.attentionItems.length > 0 ? `<span class="nav-badge">${state.attentionItems.length}</span>` : ''}
          </li>
          <li class="sidebar-nav-item ${state.activeTab === 'projects' ? 'active' : ''}" data-tab="projects">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span>📁</span>
              <span>Projects & Chat</span>
            </div>
          </li>
          <li class="sidebar-nav-item ${state.activeTab === 'tasks' ? 'active' : ''}" data-tab="tasks">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span>🎯</span>
              <span>Tasks & Leases</span>
            </div>
            <span class="nav-badge yellow">${state.tasks.filter((t) => t.lifecycle === 'active' || t.lifecycle === 'awaiting validation').length}</span>
          </li>
          <li class="sidebar-nav-item ${state.activeTab === 'environments' ? 'active' : ''}" data-tab="environments">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span>🖥️</span>
              <span>Environments</span>
            </div>
            <span class="status-dot ${state.environments.some((e) => e.trafficLight === 'red') ? 'red' : 'green'}"></span>
          </li>
          <li class="sidebar-nav-item ${state.activeTab === 'agents' ? 'active' : ''}" data-tab="agents">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span>🤖</span>
              <span>Global Agents</span>
            </div>
          </li>
          <li class="sidebar-nav-item ${state.activeTab === 'usage' ? 'active' : ''}" data-tab="usage">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span>📊</span>
              <span>Usage & Costs</span>
            </div>
          </li>
          <li class="sidebar-nav-item ${state.activeTab === 'onboarding' ? 'active' : ''}" data-tab="onboarding">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span>🌱</span>
              <span>Onboarding</span>
            </div>
          </li>
        </ul>
        <div class="sidebar-footer">
          <div>Operator Session #1</div>
          <div>Private Overlay: 100.64.0.4</div>
        </div>
      `;

      sidebar.querySelectorAll('.sidebar-nav-item').forEach((item) => {
        item.addEventListener('click', (ev) => {
          const tab = (ev.currentTarget as HTMLElement).getAttribute('data-tab') as ActiveTab;
          stateManager.setActiveTab(tab);
        });
      });

      appBody.appendChild(sidebar);
    }

    // Render Active Variant View
    let activeViewEl: HTMLElement;
    if (activeVariant === 'A') {
      activeViewEl = renderVariantA(state);
    } else if (activeVariant === 'C') {
      activeViewEl = renderVariantC(state);
    } else {
      activeViewEl = renderVariantB(state);
    }
    appBody.appendChild(activeViewEl);

    // Mobile Bottom Navigation Bar (Shown in Variant B)
    if (activeVariant === 'B') {
      const bottomNav = document.createElement('nav');
      bottomNav.className = 'mobile-bottom-nav';
      bottomNav.innerHTML = `
        <button class="bottom-nav-item ${state.activeTab === 'attention' ? 'active' : ''}" data-tab="attention">
          <span class="bottom-nav-icon">🚨</span>
          <span>Attention</span>
          ${state.attentionItems.length > 0 ? `<span class="bottom-nav-badge">${state.attentionItems.length}</span>` : ''}
        </button>
        <button class="bottom-nav-item ${state.activeTab === 'projects' ? 'active' : ''}" data-tab="projects">
          <span class="bottom-nav-icon">📁</span>
          <span>Projects</span>
        </button>
        <button class="bottom-nav-item ${state.activeTab === 'tasks' ? 'active' : ''}" data-tab="tasks">
          <span class="bottom-nav-icon">🎯</span>
          <span>Tasks</span>
        </button>
        <button class="bottom-nav-item ${state.activeTab === 'environments' ? 'active' : ''}" data-tab="environments">
          <span class="bottom-nav-icon">🖥️</span>
          <span>Envs</span>
        </button>
        <button class="bottom-nav-item ${state.activeTab === 'usage' ? 'active' : ''}" data-tab="usage">
          <span class="bottom-nav-icon">📊</span>
          <span>Costs</span>
        </button>
      `;

      bottomNav.querySelectorAll('.bottom-nav-item').forEach((item) => {
        item.addEventListener('click', (ev) => {
          const tab = (ev.currentTarget as HTMLElement).getAttribute('data-tab') as ActiveTab;
          stateManager.setActiveTab(tab);
        });
      });

      shellEl.appendChild(bottomNav);
    }

    shellEl.appendChild(appBody);
    stageEl.appendChild(shellEl);
    appEl.appendChild(stageEl);

    // Inspector Sheet (Modal / Slide-Over)
    const inspectorEl = renderInspectorSheet(state);
    if (inspectorEl) {
      appEl.appendChild(inspectorEl);
    }

    // Owner Review Drawer
    const reviewDrawerEl = renderReviewDrawer(state);
    if (reviewDrawerEl) {
      appEl.appendChild(reviewDrawerEl);
    }

    // Floating Variant Switcher Bar at Bottom Center (Skill UI.md Requirement)
    const floatingSwitcher = renderVariantSwitcher(activeVariant, render);
    appEl.appendChild(floatingSwitcher);

    mountEl.appendChild(appEl);
  }

  // Attach global keyboard shortcuts (Left/Right arrow to cycle variants)
  attachVariantKeyboardShortcuts(render);

  // Subscribe to state changes
  stateManager.subscribe(render);

  // Initial render
  render();
}
