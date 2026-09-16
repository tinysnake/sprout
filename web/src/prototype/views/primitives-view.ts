import { renderIcon } from '../icons.js';
import { stateManager, type PrototypeState } from '../state.js';

export function renderPrimitivesView(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'primitives-view';

  container.innerHTML = `
    <div class="view-header">
      <div class="view-header-title">
        <h2 style="font-size: 18px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
          ${renderIcon('palette', 20)}
          <span>Shared Style Baseline & Interaction Primitives</span>
        </h2>
        <span class="proto-badge">Ticket #61 Baseline</span>
      </div>
      <p style="font-size: 13px; color: var(--text-secondary); margin-top: 4px;">
        Shared mobile-first design tokens, interaction components, and state language across Feed, Project, and Manage.
      </p>
    </div>

    <!-- Quick Theme & Density Bar inside Primitives View -->
    <div class="primitives-control-strip">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 600; text-transform: uppercase;">Theme:</span>
        <button class="btn btn-secondary btn-sm" id="prim-toggle-theme">
          ${state.theme === 'dark' ? renderIcon('moon', 13) + ' Dark Theme' : renderIcon('sun', 13) + ' Light Theme'} (Toggle)
        </button>
      </div>
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 600; text-transform: uppercase;">Density:</span>
        <button class="btn btn-secondary btn-sm" id="prim-toggle-density">
          ${renderIcon('sliders', 13)} ${state.density === 'comfortable' ? 'Comfortable (44px touch)' : 'Compact'} (Toggle)
        </button>
      </div>
      <button class="btn btn-primary btn-sm" id="prim-open-review">
        ${renderIcon('clipboard', 14)} Open Owner Review
      </button>
    </div>

    <!-- Section Navigation Anchors (clean categories, no enumerated eyebrows) -->
    <div class="primitives-nav-strip">
      <a href="#tokens" class="prim-anchor-link">Tokens</a>
      <a href="#buttons" class="prim-anchor-link">Buttons</a>
      <a href="#forms" class="prim-anchor-link">Forms</a>
      <a href="#lists-cards" class="prim-anchor-link">Cards & Lists</a>
      <a href="#sheets-dialogs" class="prim-anchor-link">Dialogs & Sheets</a>
      <a href="#states" class="prim-anchor-link">State Language</a>
      <a href="#a11y" class="prim-anchor-link">Accessibility</a>
    </div>

    <!-- Color & Design Tokens -->
    <section class="prim-section" id="tokens">
      <div class="prim-section-header">
        <div>
          <h3 class="prim-section-title">Design Tokens: Color Roles & Typography</h3>
          <p class="prim-section-desc">Semantic tokens defined as CSS variables with high-contrast Dark and Light support.</p>
        </div>
      </div>

      <div class="prim-token-grid">
        <div class="token-swatch swatch-base">
          <div class="token-name">--bg-app</div>
          <div class="token-val">Canvas Base</div>
        </div>
        <div class="token-swatch swatch-surface">
          <div class="token-name">--bg-surface</div>
          <div class="token-val">Cards & Headers</div>
        </div>
        <div class="token-swatch swatch-elevated">
          <div class="token-name">--bg-surface-elevated</div>
          <div class="token-val">Modals & Popovers</div>
        </div>
        <div class="token-swatch swatch-accent">
          <div class="token-name">--accent-primary</div>
          <div class="token-val">Interactive Blue</div>
        </div>
        <div class="token-swatch swatch-green">
          <div class="token-name">--green-ready</div>
          <div class="token-val">Healthy / Done</div>
        </div>
        <div class="token-swatch swatch-yellow">
          <div class="token-name">--yellow-attention</div>
          <div class="token-val">Attention / Degraded</div>
        </div>
        <div class="token-swatch swatch-red">
          <div class="token-name">--red-action</div>
          <div class="token-val">Danger / Offline</div>
        </div>
        <div class="token-swatch swatch-purple">
          <div class="token-name">--purple-agent</div>
          <div class="token-val">Validation / Agent</div>
        </div>
      </div>

      <!-- Typography & Spacing -->
      <div class="card" style="margin-top: 12px;">
        <div class="card-header">
          <span class="card-title">Typography Scale & Font Stacks</span>
        </div>
        <div class="card-body" style="display: flex; flex-direction: column; gap: 8px;">
          <div style="font-size: 24px; font-weight: 700;">Heading 1 (24px bold): Platform Operations</div>
          <div style="font-size: 18px; font-weight: 600;">Heading 2 (18px semibold): Project Workspace</div>
          <div style="font-size: 15px; font-weight: 600;">Subheading (15px semibold): Task Context & Lease State</div>
          <div style="font-size: 13px; color: var(--text-primary);">Body Regular (13-14px): Human operator discovery and intervention feed items.</div>
          <div style="font-size: 11px; color: var(--text-secondary);">Caption / Metadata (11-12px): Last heartbeat 4s ago · Protocol v1.2</div>
          <div style="font-family: var(--font-mono); font-size: 12px; background: var(--bg-app); padding: 6px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);">
            <code>Mono Stack: sprout-wk-macstudio-01 (100.64.0.4:5174) · run-817a</code>
          </div>
        </div>
      </div>
    </section>

    <!-- Buttons & Interactive Controls -->
    <section class="prim-section" id="buttons">
      <div class="prim-section-header">
        <div>
          <h3 class="prim-section-title">Buttons & Interactive Controls</h3>
          <p class="prim-section-desc">Consistent interactive weights, active states, loading indicators, and minimum 44px touch targets.</p>
        </div>
      </div>

      <div class="card">
        <div class="card-body" style="display: flex; flex-direction: column; gap: 16px;">
          <!-- Variants -->
          <div>
            <div style="font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 8px; text-transform: uppercase;">Button Variants</div>
            <div style="display: flex; flex-wrap: wrap; gap: 8px;">
              <button class="btn btn-primary">Primary Action</button>
              <button class="btn btn-secondary">Secondary Action</button>
              <button class="btn btn-danger">Destructive Action</button>
              <button class="btn btn-ghost">Ghost Button</button>
              <button class="btn btn-outline">Outline Button</button>
              <button class="btn btn-primary" disabled>Disabled State</button>
            </div>
          </div>

          <!-- Loading & Sizes -->
          <div>
            <div style="font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 8px; text-transform: uppercase;">Sizes & Dynamic Loading State</div>
            <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px;">
              <button class="btn btn-primary btn-sm">Small (32px)</button>
              <button class="btn btn-primary btn-md">Medium (38px)</button>
              <button class="btn btn-primary btn-lg">Large Touch (44px+)</button>
              <button class="btn btn-secondary loading" aria-busy="true">
                <span class="spinner-inline"></span>
                <span>Submitting...</span>
              </button>
              <button class="btn btn-danger btn-sm" id="btn-test-interactive">
                ${renderIcon('lightning', 14)} Click to Test Interactive Feedback
              </button>
            </div>
          </div>

          <!-- Toggles & Switches -->
          <div>
            <div style="font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 8px; text-transform: uppercase;">Toggle Switches & Segmented Controls</div>
            <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 16px;">
              <label class="switch-control">
                <input type="checkbox" checked id="demo-switch-1" />
                <span class="switch-slider"></span>
                <span class="switch-label">Wake-Model Assisted Routing</span>
              </label>

              <label class="switch-control">
                <input type="checkbox" id="demo-switch-2" />
                <span class="switch-slider"></span>
                <span class="switch-label">Show Diagnostic Telemetry</span>
              </label>

              <div class="segmented-control">
                <button class="segmented-btn active">Active Tasks</button>
                <button class="segmented-btn">Completed</button>
                <button class="segmented-btn">Archived</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Form Controls & Validation -->
    <section class="prim-section" id="forms">
      <div class="prim-section-header">
        <div>
          <h3 class="prim-section-title">Form Controls & Validation States</h3>
          <p class="prim-section-desc">Accessible forms with helper hints, inline error messaging, and clear focus styling.</p>
        </div>
      </div>

      <div class="card">
        <div class="card-body" style="display: flex; flex-direction: column; gap: 14px;">
          <!-- Standard & Search Input -->
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px;">
            <div class="form-group">
              <label class="form-label" for="demo-input-1">Project Name <span style="color: var(--red-action)">*</span></label>
              <input type="text" class="form-input" id="demo-input-1" value="O7 Minesweeper Game" />
              <div class="form-helper">Unique human-readable name for this collaboration.</div>
            </div>

            <div class="form-group">
              <label class="form-label" for="demo-search-1">Filter Activities</label>
              <div class="search-input-wrapper">
                <span class="search-icon">🔍</span>
                <input type="text" class="form-input form-input-search" id="demo-search-1" placeholder="Search tasks, agents, errors..." />
                <button class="search-clear-btn" id="demo-search-clear" aria-label="Clear search">✕</button>
              </div>
            </div>
          </div>

          <!-- Select & Error State -->
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px;">
            <div class="form-group">
              <label class="form-label" for="demo-select-1">Primary Engine Work Option</label>
              <select class="form-select" id="demo-select-1">
                <option value="pi-sonnet">Pi · Claude 3.5 Sonnet (High Effort)</option>
                <option value="codex-4o">Codex · GPT-4o (Medium Effort)</option>
                <option value="agy-claude">Agy · Claude 3.5 Sonnet</option>
              </select>
            </div>

            <div class="form-group has-error">
              <label class="form-label" for="demo-input-err">Environment Lease Token <span style="color: var(--red-action)">*</span></label>
              <input type="text" class="form-input" id="demo-input-err" value="invalid-expired-token" />
              <div class="form-error">
                ${renderIcon('warning', 14)}
                <span>Lease token is expired or revoked. Run a live readiness probe.</span>
              </div>
            </div>
          </div>

          <!-- Textarea with Char Count -->
          <div class="form-group">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <label class="form-label" for="demo-textarea">Task Completion Claim & Evidence Note</label>
              <span style="font-size: 11px; color: var(--text-muted);" id="demo-char-count">128 / 500</span>
            </div>
            <textarea class="form-textarea" id="demo-textarea" rows="2">Verified Three.js viewport resize handler and sound toggle state across mobile and desktop.</textarea>
          </div>
        </div>
      </div>
    </section>

    <!-- Cards, Lists & Layout Items -->
    <section class="prim-section" id="lists-cards">
      <div class="prim-section-header">
        <div>
          <h3 class="prim-section-title">Cards, Lists & Interactive Items</h3>
          <p class="prim-section-desc">Responsive card containers, KPI metric blocks, and interactive list rows with chevrons.</p>
        </div>
      </div>

      <!-- KPI Grid -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 12px;">
        <div class="card-kpi">
          <div class="card-kpi-label">Active Tasks</div>
          <div class="card-kpi-value" style="color: var(--accent-primary);">3</div>
          <div class="card-kpi-trend">1 awaiting validation</div>
        </div>
        <div class="card-kpi">
          <div class="card-kpi-label">Connected Workers</div>
          <div class="card-kpi-value" style="color: var(--green-ready);">2 / 3</div>
          <div class="card-kpi-trend">1 reconnecting</div>
        </div>
        <div class="card-kpi">
          <div class="card-kpi-label">Today Telemetry</div>
          <div class="card-kpi-value">$0.42</div>
          <div class="card-kpi-trend">~23.4k tokens (API est.)</div>
        </div>
      </div>

      <!-- Interactive List Item Examples -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Interactive Item List</span>
          <span class="badge badge-info">3 Items</span>
        </div>
        <div class="list-group">
          <div class="list-item list-item-interactive" data-demo-item="1">
            <div class="list-item-leading">
              <span class="status-dot green"></span>
            </div>
            <div class="list-item-body">
              <div class="list-item-title">Task #101: Implement Mobile Touch Zoom Controls</div>
              <div class="list-item-subtitle">Assigned to Programmer · Leased to Mac Studio (held)</div>
            </div>
            <div class="list-item-trailing">
              <span class="badge badge-purple">Claim Submitted</span>
              <span class="list-item-chevron">${renderIcon('chevron-right', 14)}</span>
            </div>
          </div>

          <div class="list-item list-item-interactive" data-demo-item="2">
            <div class="list-item-leading">
              <span class="status-dot yellow"></span>
            </div>
            <div class="list-item-body">
              <div class="list-item-title">Worker: sprout-wk-macair-e018df33</div>
              <div class="list-item-subtitle">Private Overlay · Pending operator capability enrollment</div>
            </div>
            <div class="list-item-trailing">
              <span class="badge badge-yellow">Enrollment Required</span>
              <span class="list-item-chevron">${renderIcon('chevron-right', 14)}</span>
            </div>
          </div>

          <div class="list-item list-item-interactive" data-demo-item="3">
            <div class="list-item-leading">
              <span class="status-dot red"></span>
            </div>
            <div class="list-item-body">
              <div class="list-item-title">Environment: Windows Dev Box (win-dev-box)</div>
              <div class="list-item-subtitle">Heartbeat timed out 8m ago · Retained lease blocked</div>
            </div>
            <div class="list-item-trailing">
              <span class="badge badge-red">Offline</span>
              <span class="list-item-chevron">${renderIcon('chevron-right', 14)}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Sheets, Modals & Danger Confirmations -->
    <section class="prim-section" id="sheets-dialogs">
      <div class="prim-section-header">
        <div>
          <h3 class="prim-section-title">Sheets, Modals & High-Risk Danger Dialogs</h3>
          <p class="prim-section-desc">Mobile bottom sheets, desktop modal dialogs, and explicit two-step danger confirmation patterns.</p>
        </div>
      </div>

      <div class="card">
        <div class="card-body" style="display: flex; flex-wrap: wrap; gap: 10px;">
          <button class="btn btn-secondary" id="trigger-bottom-sheet">
            ${renderIcon('phone', 14)} Open Mobile Bottom Sheet
          </button>
          <button class="btn btn-secondary" id="trigger-modal-dialog">
            ${renderIcon('desktop', 14)} Open Desktop Modal Dialog
          </button>
          <button class="btn btn-danger" id="trigger-danger-confirm">
            ${renderIcon('warning', 14)} Open High-Risk Danger Dialog (Force Release)
          </button>
          <button class="btn btn-primary" id="trigger-slide-inspector">
            ${renderIcon('sliders', 14)} Open Slide-Over Inspector Sheet
          </button>
        </div>
      </div>
    </section>

    <!-- Shared State Language Gallery -->
    <section class="prim-section" id="states">
      <div class="prim-section-header">
        <div>
          <h3 class="prim-section-title">State Language: Health, Lifecycle & Provenance</h3>
          <p class="prim-section-desc">Non-color status cues, traffic lights with textual reasons, and provenance badges.</p>
        </div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 12px;">
        <!-- Traffic-Light Health Indicators with Textual Reason -->
        <div class="card">
          <div class="card-header">
            <span class="card-title">Health Indicators (Traffic Light + Mandatory Textual Reason)</span>
          </div>
          <div class="card-body" style="display: flex; flex-direction: column; gap: 10px;">
            <div class="health-indicator-row">
              <div class="health-dot-pill green">
                <span class="status-dot green"></span>
                <strong>HEALTHY (GREEN)</strong>
              </div>
              <div class="health-reason">All 4 engine readiness probes confirmed · Lease clear · Zero latency warnings</div>
            </div>

            <div class="health-indicator-row">
              <div class="health-dot-pill yellow">
                <span class="status-dot yellow"></span>
                <strong>DEGRADED (YELLOW)</strong>
              </div>
              <div class="health-reason">1/4 engine offline (Codex login-required) · Worker reconnecting (45s since last heartbeat)</div>
            </div>

            <div class="health-indicator-row">
              <div class="health-dot-pill red">
                <span class="status-dot red"></span>
                <strong>OFFLINE (RED)</strong>
              </div>
              <div class="health-reason">Heartbeat timed out 8m ago · Retained task lease held in unconfirmed state</div>
            </div>
          </div>
        </div>

        <!-- Lifecycle State Pills -->
        <div class="card">
          <div class="card-header">
            <span class="card-title">Task & Agent Run Lifecycle State Language</span>
          </div>
          <div class="card-body" style="display: flex; flex-wrap: wrap; gap: 8px;">
            <span class="lifecycle-pill active">
              <span class="pulse-dot blue"></span> Active (running)
            </span>
            <span class="lifecycle-pill idle">
              <span class="status-dot gray"></span> Idle (ready)
            </span>
            <span class="lifecycle-pill paused">
              <span class="status-dot yellow"></span> Paused
            </span>
            <span class="lifecycle-pill blocked">
              <span class="status-dot yellow"></span> Blocked
            </span>
            <span class="lifecycle-pill validation">
              <span class="status-dot purple"></span> Awaiting Validation
            </span>
            <span class="lifecycle-pill completed">
              <span class="status-dot green"></span> Completed
            </span>
            <span class="lifecycle-pill interrupted">
              <span class="status-dot red"></span> Interrupted
            </span>
            <span class="lifecycle-pill failed">
              <span class="status-dot red"></span> Failed
            </span>
          </div>
        </div>

        <!-- Provenance Tags -->
        <div class="card">
          <div class="card-header">
            <span class="card-title">Provenance & Attribution Tags</span>
          </div>
          <div class="card-body" style="display: flex; flex-wrap: wrap; gap: 8px;">
            <span class="provenance-tag operator">
              <span class="prov-icon">${renderIcon('user', 13)}</span>
              <span>Operator (Lead Tech)</span>
            </span>
            <span class="provenance-tag agent">
              <span class="prov-icon">${renderIcon('bot', 13)}</span>
              <span>Programmer (Pi · claude-3-5-sonnet)</span>
            </span>
            <span class="provenance-tag worker">
              <span class="prov-icon">${renderIcon('server', 13)}</span>
              <span>Mac Studio (Overlay)</span>
            </span>
            <span class="provenance-tag time" title="2026-09-16T14:40:00Z">
              <span class="prov-icon">${renderIcon('clock', 13)}</span>
              <span>2m ago</span>
            </span>
          </div>
        </div>

        <!-- Edge States: Stale, Loading, Error, Empty -->
        <div class="card">
          <div class="card-header">
            <span class="card-title">Edge States: Stale, Error, Loading & Empty</span>
          </div>
          <div class="card-body" style="display: flex; flex-direction: column; gap: 12px;">
            <!-- Stale Banner -->
            <div class="state-banner warning">
              ${renderIcon('warning', 18)}
              <div style="flex: 1;">
                <strong>Worker Disconnected (Stale Telemetry):</strong>
                <span>Last confirmed telemetry was recorded 4m ago. Figures may not reflect in-flight changes.</span>
              </div>
              <button class="btn btn-secondary btn-sm" id="btn-reconnect-demo">Re-probe</button>
            </div>

            <!-- Error Banner -->
            <div class="state-banner danger">
              ${renderIcon('alert', 18)}
              <div style="flex: 1;">
                <strong>Lease Conflict (409):</strong>
                <span>Environment mac-1 is retained by Task #104 in recovery state. Generic release refused.</span>
              </div>
              <button class="btn btn-danger btn-sm">Resolve Recovery</button>
            </div>

            <!-- Skeleton Loading Loader -->
            <div style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);">
              <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 8px; font-weight: 600;">SKELETON SHIMMER LOADER</div>
              <div class="skeleton-line" style="width: 60%; height: 14px; margin-bottom: 8px;"></div>
              <div class="skeleton-line" style="width: 90%; height: 12px; margin-bottom: 6px;"></div>
              <div class="skeleton-line" style="width: 40%; height: 12px;"></div>
            </div>

            <!-- Empty State Container -->
            <div class="empty-state-box">
              <div style="color: var(--accent-primary); margin-bottom: 4px;">${renderIcon('check', 28)}</div>
              <h4 style="font-size: 14px; font-weight: 700; margin-top: 6px;">No Attention Items Pending</h4>
              <p style="font-size: 12px; color: var(--text-secondary); max-width: 320px; text-align: center; margin-top: 4px;">
                All agent tasks are running smoothly and environment workers are healthy.
              </p>
              <button class="btn btn-secondary btn-sm" style="margin-top: 10px;">
                View Recent Activity Feed
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Accessibility Floors -->
    <section class="prim-section" id="a11y">
      <div class="prim-section-header">
        <div>
          <h3 class="prim-section-title">Accessibility Floors & Multi-Modal Cues</h3>
          <p class="prim-section-desc">Strict compliance with 44px touch targets, visible focus outlines, and colorblind safety.</p>
        </div>
      </div>

      <div class="card">
        <div class="card-body" style="display: flex; flex-direction: column; gap: 10px;">
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px;">
            <div style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);">
              <div style="font-weight: 700; font-size: 13px; color: var(--green-ready); display: flex; align-items: center; gap: 6px;">
                ${renderIcon('check', 14)} Touch Target Floor
              </div>
              <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
                All mobile buttons, inputs, tabs, and toggles enforce min-height <code>44px</code> and touch padding.
              </div>
            </div>

            <div style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);">
              <div style="font-weight: 700; font-size: 13px; color: var(--accent-primary); display: flex; align-items: center; gap: 6px;">
                ${renderIcon('check', 14)} Visible Focus Rings
              </div>
              <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
                <code>:focus-visible</code> renders a 2px high-contrast sky-blue ring with 2px offset.
              </div>
            </div>

            <div style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);">
              <div style="font-weight: 700; font-size: 13px; color: var(--purple-agent); display: flex; align-items: center; gap: 6px;">
                ${renderIcon('check', 14)} Non-Color State Cues
              </div>
              <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
                No status relies on color alone; every indicator pairs icons, explicit text, and border styling.
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;

  // Attach event listeners for interactive buttons
  container.querySelector('#prim-toggle-theme')?.addEventListener('click', () => {
    stateManager.toggleTheme();
  });

  container.querySelector('#prim-toggle-density')?.addEventListener('click', () => {
    stateManager.toggleDensity();
  });

  container.querySelector('#prim-open-review')?.addEventListener('click', () => {
    stateManager.toggleReviewDrawer(true);
  });

  container.querySelector('#btn-test-interactive')?.addEventListener('click', () => {
    const btn = container.querySelector('#btn-test-interactive') as HTMLButtonElement;
    if (!btn) return;
    btn.innerHTML = `${renderIcon('check', 14)} Click Registered!`;
    btn.classList.remove('btn-danger');
    btn.classList.add('btn-primary');
    setTimeout(() => {
      btn.innerHTML = `${renderIcon('lightning', 14)} Click to Test Interactive Feedback`;
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-danger');
    }, 1500);
  });

  // Search input clear button
  const searchInput = container.querySelector('#demo-search-1') as HTMLInputElement;
  const searchClear = container.querySelector('#demo-search-clear') as HTMLButtonElement;
  searchClear?.addEventListener('click', () => {
    if (searchInput) {
      searchInput.value = '';
      searchInput.focus();
    }
  });

  // Character count live update
  const textarea = container.querySelector('#demo-textarea') as HTMLTextAreaElement;
  const charCount = container.querySelector('#demo-char-count');
  textarea?.addEventListener('input', () => {
    if (charCount) {
      charCount.textContent = `${textarea.value.length} / 500`;
    }
  });

  // Dialog triggers
  container.querySelector('#trigger-bottom-sheet')?.addEventListener('click', () => {
    stateManager.openDialog({
      id: 'demo-bottom-sheet',
      kind: 'bottom-sheet',
      title: 'Mobile Bottom Sheet Component',
      subtitle: 'Slides up smoothly from screen bottom on phone viewports',
      bodyText: 'This bottom sheet is designed for mobile-first interaction with drag handle, scrollable body, and touch-friendly action buttons.',
      confirmLabel: 'Confirm Action',
      cancelLabel: 'Dismiss',
      onConfirm: () => {
        stateManager.closeDialog();
      },
    });
  });

  container.querySelector('#trigger-modal-dialog')?.addEventListener('click', () => {
    stateManager.openDialog({
      id: 'demo-modal-dialog',
      kind: 'modal-dialog',
      title: 'Desktop Modal Dialog Component',
      subtitle: 'Centered accessible dialog for wider viewports',
      bodyText: 'Modal dialogs are used for focused interactions such as creating projects, inviting members, or editing agent work options.',
      confirmLabel: 'Save Changes',
      cancelLabel: 'Cancel',
      onConfirm: () => {
        stateManager.closeDialog();
      },
    });
  });

  container.querySelector('#trigger-danger-confirm')?.addEventListener('click', () => {
    stateManager.openDialog({
      id: 'demo-danger-dialog',
      kind: 'danger-confirm',
      title: 'Emergency Override: Force Release Environment',
      subtitle: 'High-risk action with permanent lease cancellation',
      bodyText: 'Environment win-dev-box is unresponsive. Force Release will permanently sever the lease and cancel in-flight Task #104. This action cannot be undone.',
      confirmLabel: 'Force Release Now',
      cancelLabel: 'Cancel',
      isDestructive: true,
      requireTypedConfirmation: 'FORCE RELEASE',
      onConfirm: () => {
        stateManager.closeDialog();
      },
    });
  });

  container.querySelector('#trigger-slide-inspector')?.addEventListener('click', () => {
    stateManager.openInspector('routing', 'batch-002');
  });

  return container;
}
