import { renderIcon } from '../icons.js';
import { stateManager, type PrototypeState } from '../state.js';
import type { EnvironmentInstance, EngineDetailInfo } from '../types.js';

export function renderEnvironmentsView(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'view-container environments-view';

  const filter = state.environmentFilter || 'all';

  // Calculate counts for filters
  const allEnvs = state.environments;
  const readyCount = allEnvs.filter((e) => e.trafficLight === 'green' && e.enrollmentStatus === 'approved').length;
  const attentionCount = allEnvs.filter((e) => e.trafficLight === 'yellow' && e.enrollmentStatus !== 'archived').length;
  const actionRequiredCount = allEnvs.filter((e) => e.trafficLight === 'red').length;
  const archivedCount = allEnvs.filter((e) => e.enrollmentStatus === 'archived').length;

  const filteredEnvs = allEnvs.filter((e) => {
    if (filter === 'ready') return e.trafficLight === 'green' && e.enrollmentStatus === 'approved';
    if (filter === 'attention') return e.trafficLight === 'yellow' && e.enrollmentStatus !== 'archived';
    if (filter === 'action-required') return e.trafficLight === 'red';
    if (filter === 'archived') return e.enrollmentStatus === 'archived';
    return true;
  });

  const selectedEnv =
    allEnvs.find((e) => e.id === state.selectedEnvironmentId) ?? filteredEnvs[0] ?? allEnvs[0];

  // --- 1. Header Area with Filter Bar and Actions ---
  const headerCard = document.createElement('div');
  headerCard.className = 'card envs-header-card';
  headerCard.innerHTML = `
    <div class="card-header envs-header-top-row" style="display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: nowrap; width: 100%;">
      <div style="flex: 1; min-width: 0;">
        <h2 style="font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
          ${renderIcon('environments', 18)}
          <span>Environments & Host Infrastructure</span>
        </h2>
      </div>
      <div style="display: flex; gap: 6px; align-items: center; flex-shrink: 0; margin-left: auto;">
        <button class="btn btn-primary btn-sm register-host-btn icon-only-btn" id="btn-register-host" title="Register New Host" aria-label="Register New Host">
          ${renderIcon('plus', 14)}
        </button>
        <button class="btn btn-secondary btn-sm host-guide-btn icon-only-btn" id="btn-host-guide" title="Host Bootstrap Guide" aria-label="Host Bootstrap Guide">
          ${renderIcon('guide', 14)}
        </button>
      </div>
    </div>

    <!-- Filter Row: Modeled after Attention Urgency Pills (Discrete Boxes, Icon Top, Text Bottom, Auto-Fitting Single Row) -->
    <div class="envs-filter-row env-filter-boxes" role="group" aria-label="Filter environments by health status">
      <button class="env-filter-box-btn filter-pill ${filter === 'all' ? 'active' : ''}" data-filter="all" title="All (${allEnvs.length})">
        <span class="env-filter-box-top"><span class="status-dot purple"></span> ${allEnvs.length}</span>
        <span class="env-filter-box-bottom">All<span class="sr-only"> (${allEnvs.length})</span></span>
      </button>
      <button class="env-filter-box-btn filter-pill ${filter === 'ready' ? 'active' : ''}" data-filter="ready" title="Ready (${readyCount})">
        <span class="env-filter-box-top"><span class="status-dot green"></span> ${readyCount}</span>
        <span class="env-filter-box-bottom">Ready<span class="sr-only"> (${readyCount})</span></span>
      </button>
      <button class="env-filter-box-btn filter-pill ${filter === 'attention' ? 'active' : ''}" data-filter="attention" title="Attention (${attentionCount})">
        <span class="env-filter-box-top"><span class="status-dot yellow"></span> ${attentionCount}</span>
        <span class="env-filter-box-bottom">Attention<span class="sr-only"> (${attentionCount})</span></span>
      </button>
      <button class="env-filter-box-btn filter-pill ${filter === 'action-required' ? 'active' : ''}" data-filter="action-required" title="Action Required (${actionRequiredCount})">
        <span class="env-filter-box-top"><span class="status-dot red"></span> ${actionRequiredCount}</span>
        <span class="env-filter-box-bottom">Action Required<span class="sr-only"> (${actionRequiredCount})</span></span>
      </button>
      <button class="env-filter-box-btn filter-pill ${filter === 'archived' ? 'active' : ''}" data-filter="archived" title="Archived (${archivedCount})">
        <span class="env-filter-box-top"><span class="status-dot neutral"></span> ${archivedCount}</span>
        <span class="env-filter-box-bottom">Archived<span class="sr-only"> (${archivedCount})</span></span>
      </button>
    </div>
  `;

  headerCard.querySelectorAll('.filter-pill').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const f = (ev.currentTarget as HTMLElement).getAttribute('data-filter')!;
      stateManager.setEnvironmentFilter(f);
    });
  });

  headerCard.querySelector('#btn-host-guide')?.addEventListener('click', () => {
    openBootstrapGuideDialog();
  });

  headerCard.querySelector('#btn-register-host')?.addEventListener('click', () => {
    openRegisterHostDialog();
  });

  // --- 2. Master / Detail Layout Construction (Phone & Fluid Parity / Desktop Split) ---
  const isSingleColumn = state.viewportMode === 'mobile' || state.viewportMode === 'fluid';
  const showSingleColumnDetail = isSingleColumn && state.environmentViewMode === 'detail' && selectedEnv;

  if (showSingleColumnDetail) {
    // Single Column Detail View: Replace Home Title Bar with Traditional Back Header (Like Chat / Project Detail)
    const mobileDetailWrapper = document.createElement('div');
    mobileDetailWrapper.className = 'envs-mobile-detail-wrapper';

    const mobileBackNav = document.createElement('div');
    mobileBackNav.className = 'mobile-detail-nav-header';
    mobileBackNav.innerHTML = `
      <button class="btn btn-secondary btn-sm back-to-envs-btn" id="btn-back-to-envs" title="Back to Environments" aria-label="Back to environments list">
        ${renderIcon('chevron-left', 14)} Back to Environments
      </button>
      <div style="display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 13px;">
        <span class="status-dot ${selectedEnv.trafficLight}"></span>
        <span style="max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${selectedEnv.displayName}</span>
      </div>
      <div class="sr-only">
        Environments & Host Infrastructure
        Ready (${readyCount}) Attention (${attentionCount}) Action Required (${actionRequiredCount}) Archived (${archivedCount})
      </div>
    `;

    mobileBackNav.querySelector('#btn-back-to-envs')?.addEventListener('click', () => {
      stateManager.closeEnvironmentDetail();
    });

    mobileDetailWrapper.appendChild(mobileBackNav);
    mobileDetailWrapper.appendChild(renderEnvironmentDetailCard(selectedEnv, state));
    container.appendChild(mobileDetailWrapper);
  } else {
    // Standard List or Desktop View: Include Header Card with Title and Filter Row
    container.appendChild(headerCard);

    if (isSingleColumn) {
      // Single Column Master List View
      const listContainer = document.createElement('div');
      listContainer.className = 'envs-master-list mobile-full';
      listContainer.appendChild(renderEnvironmentMasterList(filteredEnvs, selectedEnv?.id));
      container.appendChild(listContainer);
    } else {
      // Desktop 2-Column Split Layout
      const splitLayout = document.createElement('div');
      splitLayout.className = 'envs-split-layout';

      // Left Column: Master List
      const leftCol = document.createElement('div');
      leftCol.className = 'envs-master-column';
      leftCol.appendChild(renderEnvironmentMasterList(filteredEnvs, selectedEnv?.id));
      splitLayout.appendChild(leftCol);

      // Right Column: Detail Panel
      const rightCol = document.createElement('div');
      rightCol.className = 'envs-detail-column';
      if (selectedEnv) {
        rightCol.appendChild(renderEnvironmentDetailCard(selectedEnv, state));
      } else {
        rightCol.innerHTML = `
          <div class="card" style="padding: 30px; text-align: center; color: var(--text-muted);">
            ${renderIcon('environments', 32)}
            <p style="margin-top: 10px; font-size: 14px;">No environment matches the active filter.</p>
          </div>
        `;
      }
      splitLayout.appendChild(rightCol);

      container.appendChild(splitLayout);
    }
  }

  return container;
}

// --- Master List Builder ---

function renderEnvironmentMasterList(
  environments: EnvironmentInstance[],
  selectedId?: string
): HTMLElement {
  const listEl = document.createElement('div');
  listEl.className = 'envs-card-list';

  if (environments.length === 0) {
    listEl.innerHTML = `
      <div class="card" style="padding: 24px; text-align: center; color: var(--text-muted);">
        <p style="font-size: 13px;">No environment instances found in this filter.</p>
      </div>
    `;
    return listEl;
  }

  environments.forEach((env) => {
    const isSelected = env.id === selectedId;
    const card = document.createElement('div');
    card.className = `env-master-card ${isSelected ? 'active' : ''}`;
    card.setAttribute('data-env', env.id);

    const platformIcon = env.platform === 'windows' ? 'terminal' : env.platform === 'container' ? 'box' : 'desktop';
    const trafficLightLabel =
      env.trafficLight === 'green'
        ? 'READY'
        : env.trafficLight === 'yellow'
        ? 'ATTENTION'
        : 'ACTION REQUIRED';

    const hasLease = !!env.activeLeaseHolder;
    const isRecovery = env.workSafety === 'recovery' || !!env.leaseRecovery;

    card.innerHTML = `
      <div class="env-master-card-header">
        <div style="display: flex; align-items: center; gap: 8px;">
          <div class="env-platform-icon ${env.platform}">
            ${renderIcon(platformIcon, 15)}
          </div>
          <div>
            <strong class="env-title" style="font-size: 13px; color: var(--text-primary); display: block;">${env.displayName}</strong>
            <span style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);">${env.hostUser} · ${env.workerIdentityKey.slice(0, 16)}</span>
          </div>
        </div>
        <span class="status-dot ${env.trafficLight}" title="${trafficLightLabel}" aria-label="${trafficLightLabel}"></span>
      </div>

      <div class="env-reason-snippet" style="font-size: 12px; color: var(--text-secondary); line-height: 1.35; margin: 6px 0 8px 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">
        ${env.trafficLightReason}
      </div>

      <div class="env-card-metrics-row" style="display: flex; gap: 6px; flex-wrap: wrap; align-items: center; justify-content: space-between;">
        <div style="display: flex; gap: 4px; flex-wrap: wrap;">
          <span class="badge ${env.connectionState === 'online' ? 'badge-success' : env.connectionState === 'offline' ? 'badge-danger' : 'badge-warning'}" style="font-size: 10px;">
            ${env.connectionState.toUpperCase()} ${env.connectionAgeSec > 0 ? `(${Math.floor(env.connectionAgeSec / 60)}m)` : ''}
          </span>
          <span class="badge ${env.protocolCompatibility === 'compatible' ? 'badge-info' : 'badge-danger'}" style="font-size: 10px;">
            ${env.protocolVersion} ${env.protocolCompatibility.toUpperCase()}
          </span>
          ${
            isRecovery
              ? `<span class="badge badge-danger" style="font-size: 10px;">RECOVERY</span>`
              : hasLease
              ? `<span class="badge badge-purple" style="font-size: 10px;">LEASE HELD</span>`
              : `<span class="badge badge-secondary" style="font-size: 10px;">CLEAR</span>`
          }
        </div>
        <button class="btn btn-ghost btn-xs quick-probe-btn" title="Request quick live probe" aria-label="Request quick live probe">
          ${renderIcon('lightning', 12)} Probe
        </button>
      </div>
    `;

    card.addEventListener('click', () => {
      stateManager.selectEnvironment(env.id);
    });

    card.querySelector('.quick-probe-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      stateManager.triggerReadinessProbe(env.id);
    });

    listEl.appendChild(card);
  });

  return listEl;
}

// --- Detail Card Builder ---

function renderEnvironmentDetailCard(
  env: EnvironmentInstance,
  state: PrototypeState
): HTMLElement {
  const detailEl = document.createElement('div');
  detailEl.className = 'card env-detail-card';

  const isGreen = env.trafficLight === 'green';
  const isYellow = env.trafficLight === 'yellow';

  const bannerBg = isGreen ? 'var(--green-ready-bg)' : isYellow ? 'var(--yellow-attention-bg)' : 'var(--red-action-bg)';
  const bannerBorder = isGreen ? 'var(--green-ready)' : isYellow ? 'var(--yellow-attention)' : 'var(--red-action)';

  const activeTask = state.tasks.find(
    (t) => t.selectedEnvironmentId === env.id && (t.leaseLifecycle === 'held' || t.leaseLifecycle === 'recovering')
  );

  const isArchived = env.enrollmentStatus === 'archived';

  detailEl.innerHTML = `
    <!-- 1. Prominent Traffic-Light Banner -->
    <div class="env-traffic-light-banner" style="background: ${bannerBg}; border: 1px solid ${bannerBorder}; border-radius: var(--radius-md); padding: 14px; display: flex; flex-direction: column; gap: 8px;">
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="status-dot ${env.trafficLight}" style="width: 14px; height: 14px;"></span>
          <strong style="font-size: 16px; color: var(--text-primary);">
            ${
              isGreen
                ? 'Green: Ready'
                : isYellow
                ? isArchived
                  ? 'Archived Instance'
                  : 'Yellow: Attention / Degraded'
                : 'Red: Unavailable / Action Required'
            }
          </strong>
        </div>
        <div style="display: flex; gap: 6px; align-items: center;">
          <span class="status-pill ${isGreen ? 'green' : isYellow ? 'yellow' : 'red'}" style="font-size: 11px;">
            ${env.platform.toUpperCase()}
          </span>
          <span class="status-pill neutral" style="font-size: 11px;">
            TLS/WSS OVERLAY
          </span>
        </div>
      </div>

      <div class="env-decisive-reason" style="font-size: 13px; font-weight: 600; color: var(--text-primary); line-height: 1.4;">
        Decisive Fact: ${env.trafficLightReason}
      </div>

      ${
        env.protocolMismatchDetail
          ? `<div style="background: var(--bg-surface); padding: 8px 10px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle); font-size: 11px; color: var(--red-action); margin-top: 2px;">
              <strong>Version Mismatch Guidance:</strong> ${env.protocolMismatchDetail}
            </div>`
          : ''
      }
    </div>

    <!-- 2. 6 Independent Health Dimensions (Multi-Metric Tiles) -->
    <div style="display: flex; flex-direction: column; gap: 10px;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <h3 style="font-size: 14px; font-weight: 700; color: var(--text-primary);">
          6 Independent Health Dimensions (Never collapsed into one boolean)
        </h3>
        <span style="font-size: 11px; color: var(--text-muted);">ADR-0008 & ADR-0009</span>
      </div>

      <!-- 1–4. Core Operational Status & Safety Dimensions (Unified with Capability Permissions Style) -->
      <div class="health-dimensions-box" style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <strong style="font-size: 12px; text-transform: uppercase; color: var(--text-muted); font-weight: 700;">
            1–4. Core Operational Status & Safety Dimensions
          </strong>
          <span style="font-size: 10px; color: var(--text-muted);">ADR-0008 & ADR-0009</span>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px;">
          <!-- 1. Enrollment -->
          <div class="dimension-item" style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-surface); padding: 6px 10px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle); gap: 8px;">
            <div style="display: flex; flex-direction: column; min-width: 0;">
              <span style="font-size: 12px; font-weight: 600;">1. Enrollment</span>
              <span style="font-size: 10px; color: var(--text-muted); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                ${env.workerIdentityKey.slice(0, 16)}...
              </span>
            </div>
            <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0;">
              <span class="badge ${env.enrollmentStatus === 'approved' ? 'badge-success' : env.enrollmentStatus === 'pending' ? 'badge-warning' : 'badge-danger'}" style="font-size: 10px;">
                ${env.enrollmentStatus.toUpperCase()}
              </span>
              ${
                env.enrollmentStatus === 'pending'
                  ? `<button class="btn btn-primary btn-xs approve-enroll-btn">Approve</button>`
                  : ''
              }
            </div>
          </div>

          <!-- 2. Connection -->
          <div class="dimension-item" style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-surface); padding: 6px 10px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle); gap: 8px;">
            <div style="display: flex; flex-direction: column; min-width: 0;">
              <span style="font-size: 12px; font-weight: 600;">2. Connection</span>
              <span style="font-size: 10px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                Confirmed: ${env.lastConfirmedTime}
              </span>
            </div>
            <span class="badge ${env.connectionState === 'online' ? 'badge-success' : env.connectionState === 'offline' ? 'badge-danger' : 'badge-warning'}" style="font-size: 10px; flex-shrink: 0;">
              ${env.connectionState.toUpperCase()}
            </span>
          </div>

          <!-- 3. Protocol Compatibility -->
          <div class="dimension-item" style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-surface); padding: 6px 10px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle); gap: 8px;">
            <div style="display: flex; flex-direction: column; min-width: 0;">
              <span style="font-size: 12px; font-weight: 600;">3. Protocol</span>
              <span style="font-size: 10px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                Version: ${env.protocolVersion} (Req: v2.x)
              </span>
            </div>
            <span class="badge ${env.protocolCompatibility === 'compatible' ? 'badge-success' : 'badge-danger'}" style="font-size: 10px; flex-shrink: 0;">
              ${env.protocolCompatibility.toUpperCase()}
            </span>
          </div>

          <!-- 4. Work Safety & Lease -->
          <div class="dimension-item" style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-surface); padding: 6px 10px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle); gap: 8px;">
            <div style="display: flex; flex-direction: column; min-width: 0;">
              <span style="font-size: 12px; font-weight: 600;">4. Work Safety</span>
              <span style="font-size: 10px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                ${env.activeLeaseHolder ? `Task #${env.activeLeaseHolder.holderId}` : 'No active lease'}
              </span>
            </div>
            <span class="badge ${env.workSafety === 'clear' ? 'badge-success' : env.workSafety === 'reconciling' ? 'badge-warning' : 'badge-danger'}" style="font-size: 10px; flex-shrink: 0;">
              ${env.workSafety.toUpperCase()}
            </span>
          </div>
        </div>
      </div>

      <!-- 5. Capability Permissions (Granular & Safety Guarded) -->
      <div class="capability-permissions-box" style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <strong style="font-size: 12px; text-transform: uppercase; color: var(--text-muted); font-weight: 700;">
            5. Capability Permissions (Host-Enforced, Web-Configured)
          </strong>
          <span style="font-size: 10px; color: var(--text-muted);">ADR-0008</span>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px;">
          <!-- File Read/Write -->
          <div class="permission-toggle-item" style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-surface); padding: 6px 8px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle);">
            <span style="font-size: 12px;">File R/W</span>
            <button class="btn btn-xs perm-toggle-btn ${env.capabilityPermissions.fileReadWrite ? 'btn-success' : 'btn-secondary'}" data-cap="fileReadWrite">
              ${env.capabilityPermissions.fileReadWrite ? 'Granted' : 'Refused'}
            </button>
          </div>

          <!-- Process Execution -->
          <div class="permission-toggle-item" style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-surface); padding: 6px 8px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle);">
            <span style="font-size: 12px;">Process Exec</span>
            <button class="btn btn-xs perm-toggle-btn ${env.capabilityPermissions.processExecution ? 'btn-success' : 'btn-secondary'}" data-cap="processExecution">
              ${env.capabilityPermissions.processExecution ? 'Granted' : 'Refused'}
            </button>
          </div>

          <!-- Network Access -->
          <div class="permission-toggle-item" style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-surface); padding: 6px 8px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle);">
            <span style="font-size: 12px;">Network</span>
            <button class="btn btn-xs perm-toggle-btn ${env.capabilityPermissions.networkAccess ? 'btn-success' : 'btn-secondary'}" data-cap="networkAccess">
              ${env.capabilityPermissions.networkAccess ? 'Granted' : 'Refused'}
            </button>
          </div>

          <!-- GUI Automation -->
          <div class="permission-toggle-item" style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-surface); padding: 6px 8px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle);">
            <span style="font-size: 12px;">GUI Auto</span>
            <button class="btn btn-xs perm-toggle-btn ${env.capabilityPermissions.guiAutomation ? 'btn-success' : 'btn-secondary'}" data-cap="guiAutomation">
              ${env.capabilityPermissions.guiAutomation ? 'Granted' : 'Refused'}
            </button>
          </div>
        </div>
      </div>

      <!-- 6. Engine Harness Readiness (Host-Local) -->
      <div class="engine-readiness-box" style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <strong style="font-size: 12px; text-transform: uppercase; color: var(--text-muted); font-weight: 700;">
            6. Engine Harness Readiness (Host-Local Facts)
          </strong>
          <span style="font-size: 10px; color: var(--text-muted);">Codex, Pi, agy, opencode</span>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px;">
          ${renderEngineCard('Codex', env.engineReadiness.codex, env.engineDetails?.codex)}
          ${renderEngineCard('Pi', env.engineReadiness.pi, env.engineDetails?.pi)}
          ${renderEngineCard('agy', env.engineReadiness.agy, env.engineDetails?.agy)}
          ${renderEngineCard('opencode', env.engineReadiness.opencode, env.engineDetails?.opencode)}
        </div>

        <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">
          Strict ADR-0008 & ADR-0009 Invariant: Host paths, API keys, and credentials remain strictly on the host; Web inspects only neutral readiness facts.
        </div>
      </div>
    </div>

    <!-- 3. Bound Project Workspaces (Workspace Readiness) -->
    <div style="display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border-subtle); padding-top: 12px;">
      <h3 style="font-size: 14px; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
        ${renderIcon('folder', 15)} Bound Project Workspaces (Persistent Host State)
      </h3>

      <div class="bound-workspaces-list" style="display: flex; flex-direction: column; gap: 6px;">
        ${
          state.projects
            .filter((p) => p.boundEnvironmentWorkspaces.some((b) => b.environmentId === env.id))
            .map((p) => {
              const b = p.boundEnvironmentWorkspaces.find((b) => b.environmentId === env.id)!;
              return `
                <div style="background: var(--bg-surface-elevated); padding: 8px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
                  <div>
                    <strong style="font-size: 13px;">${p.displayName}</strong>
                    <div style="font-size: 11px; color: var(--text-secondary); font-family: var(--font-mono); margin-top: 2px;">
                      ${b.workspaceRoot}/${b.relativeWorkspacePath}
                    </div>
                  </div>
                  <div style="display: flex; gap: 6px; align-items: center;">
                    <span class="status-pill green" style="font-size: 10px;">PREPARED & READY</span>
                    <button class="btn btn-secondary btn-xs unbind-env-btn" data-project="${p.id}" data-env="${env.id}">
                      Unbind
                    </button>
                  </div>
                </div>
              `;
            })
            .join('') ||
          `<div style="font-size: 12px; color: var(--text-muted); font-style: italic;">No projects currently bound to this environment instance.</div>`
        }
      </div>
    </div>

    <!-- 4. Active Lease, Recovery, and Force Release Resolution Area -->
    ${
      env.workSafety === 'reconciling'
        ? renderReconcilingBox(env)
        : env.workSafety === 'recovery' || env.leaseRecovery
        ? renderRecoveryAlertBox(env, activeTask)
        : env.activeLeaseHolder
        ? renderActiveLeaseBox(env, env.activeLeaseHolder)
        : env.forcedReleaseRecord
        ? renderForcedReleaseAuditBox(env.forcedReleaseRecord)
        : ''
    }

    <!-- 5. Interactive Operations & Simulation Toolbar -->
    <div class="env-operations-toolbar" style="display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; border-top: 1px solid var(--border-subtle); padding-top: 12px; margin-top: 4px;">
      ${
        env.enrollmentStatus === 'pending'
          ? `<button class="btn btn-primary approve-enroll-btn">
              ${renderIcon('check', 13)} Approve Enrollment (Human Action)
            </button>`
          : ''
      }

      <button class="btn btn-secondary btn-sm run-probe-btn">
        ${renderIcon('lightning', 13)} Request Readiness Probe
      </button>

      ${
        env.connectionState === 'online'
          ? `<button class="btn btn-warning btn-sm sim-disconnect-btn">
              ${renderIcon('alert', 13)} Simulate Disconnect
            </button>`
          : `<button class="btn btn-secondary btn-sm sim-reconnect-btn">
              ${renderIcon('refresh', 13)} Simulate Reconnect
            </button>`
      }

      ${
        env.workSafety === 'recovery'
          ? `<button class="btn btn-danger btn-sm force-release-btn">
              ${renderIcon('warning', 13)} Emergency Force Release
            </button>`
          : ''
      }

      ${
        env.enrollmentStatus === 'approved' && !env.activeLeaseHolder && env.workSafety === 'clear'
          ? `<button class="btn btn-secondary btn-sm archive-env-btn">
              ${renderIcon('archive', 13)} Archive Instance
            </button>`
          : env.enrollmentStatus === 'archived'
          ? `<button class="btn btn-secondary btn-sm restore-env-btn">
              ${renderIcon('refresh', 13)} Restore Instance
            </button>`
          : ''
      }

      ${
        env.enrollmentStatus === 'approved' && !env.activeLeaseHolder && env.workSafety === 'clear'
          ? `<button class="btn btn-ghost btn-sm unenroll-env-btn" style="color: var(--red-action);">
              ${renderIcon('trash', 13)} Unenroll & Revoke
            </button>`
          : ''
      }
    </div>

    <!-- 6. Probe History & Operational Event Log -->
    <div style="display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border-subtle); padding-top: 12px;">
      <h4 style="font-size: 13px; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; justify-content: space-between;">
        <span>Recent Readiness Probes & Evidence Log</span>
        <span style="font-size: 10px; color: var(--text-muted); font-weight: 400;">TLS/WSS Carrier Stream</span>
      </h4>

      <div class="probe-history-stream" style="display: flex; flex-direction: column; gap: 4px; max-height: 180px; overflow-y: auto;">
        ${
          env.probeHistory && env.probeHistory.length > 0
            ? env.probeHistory
                .map(
                  (pr) => `
              <div style="background: var(--bg-surface-elevated); padding: 6px 10px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle); font-size: 11px; display: flex; justify-content: space-between; align-items: center; gap: 8px;">
                <div style="display: flex; align-items: center; gap: 6px;">
                  <span class="status-dot ${pr.protocolOk && pr.enginesOk ? 'green' : 'yellow'}"></span>
                  <span style="font-family: var(--font-mono); color: var(--text-muted);">${pr.timestamp}</span>
                  <span style="color: var(--text-primary);">${pr.summary}</span>
                </div>
                <span class="badge badge-secondary" style="font-size: 9px;">${pr.latencyMs}ms</span>
              </div>
            `
                )
                .join('')
            : `<div style="font-size: 11px; color: var(--text-muted); font-style: italic;">No probe records yet. Click 'Request Readiness Probe' above.</div>`
        }
      </div>
    </div>
  `;

  // Attach Event Handlers
  detailEl.querySelector('.approve-enroll-btn')?.addEventListener('click', () => {
    stateManager.approveEnvironmentEnrollment(env.id);
  });

  detailEl.querySelector('.run-probe-btn')?.addEventListener('click', () => {
    stateManager.triggerReadinessProbe(env.id);
  });

  detailEl.querySelector('.sim-disconnect-btn')?.addEventListener('click', () => {
    stateManager.triggerSimulatedWorkerDisconnect(env.id);
  });

  detailEl.querySelector('.sim-reconnect-btn')?.addEventListener('click', () => {
    stateManager.triggerSimulatedWorkerReconnect(env.id);
  });

  detailEl.querySelector('.force-release-btn')?.addEventListener('click', () => {
    stateManager.openInspector('force-release', env.id);
  });

  detailEl.querySelector('.archive-env-btn')?.addEventListener('click', () => {
    stateManager.archiveEnvironment(env.id);
  });

  detailEl.querySelector('.restore-env-btn')?.addEventListener('click', () => {
    stateManager.restoreEnvironment(env.id);
  });

  detailEl.querySelector('.unenroll-env-btn')?.addEventListener('click', () => {
    if (confirm(`Revoke identity key for ${env.displayName}? Worker will be barred from reconnecting.`)) {
      stateManager.unenrollEnvironment(env.id);
    }
  });

  detailEl.querySelectorAll('.perm-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const cap = (ev.currentTarget as HTMLElement).getAttribute('data-cap') as any;
      stateManager.toggleCapabilityPermission(env.id, cap);
    });
  });

  detailEl.querySelectorAll('.unbind-env-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const target = ev.currentTarget as HTMLElement;
      const projId = target.getAttribute('data-project')!;
      const envId = target.getAttribute('data-env')!;
      stateManager.unbindEnvironmentFromProject(projId, envId);
    });
  });

  detailEl.querySelector('.btn-resume-recovery')?.addEventListener('click', () => {
    if (activeTask) {
      stateManager.resumeOrdinaryRecovery(activeTask.id);
    }
  });

  detailEl.querySelector('.btn-discard-recovery')?.addEventListener('click', () => {
    if (activeTask) {
      stateManager.discardOrdinaryRecovery(activeTask.id);
    }
  });

  detailEl.querySelector('.btn-reconcile-evidence')?.addEventListener('click', () => {
    stateManager.reconcileEnvironmentEvidence(env.id);
  });

  return detailEl;
}

// --- Helper Sub-Card Renderers ---

function renderEngineCard(
  name: string,
  status: string,
  details?: EngineDetailInfo | undefined
): string {
  const isReady = status === 'ready';
  const isLoginRequired = status === 'login-required';
  const isMissing = status === 'missing';
  const badgeClass = isReady ? 'green' : isLoginRequired ? 'yellow' : isMissing ? 'red' : 'neutral';

  return `
    <div style="background: var(--bg-surface); padding: 8px 10px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 4px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong style="font-size: 12px; color: var(--text-primary);">${name}</strong>
        <span class="status-pill ${badgeClass}" style="font-size: 9px; font-weight: 700;">
          ${status.toUpperCase()}
        </span>
      </div>
      <div style="font-size: 10px; color: var(--text-muted); display: flex; justify-content: space-between;">
        <span>${details?.version ?? 'installed'}</span>
        <span>${details?.authStatus ?? 'active'}</span>
      </div>
      ${
        details?.modelAvailability
          ? `<div style="font-size: 10px; color: var(--text-secondary); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              ${details.modelAvailability}
            </div>`
          : ''
      }
      ${
        details?.notes
          ? `<div style="font-size: 10px; color: var(--yellow-attention); margin-top: 1px;">
              ${details.notes}
            </div>`
          : ''
      }
    </div>
  `;
}

function renderActiveLeaseBox(_env: EnvironmentInstance, lease: NonNullable<EnvironmentInstance['activeLeaseHolder']>): string {
  return `
    <div style="background: var(--purple-agent-bg); border: 1px solid var(--purple-agent); border-radius: var(--radius-sm); padding: 12px; display: flex; flex-direction: column; gap: 6px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong style="font-size: 13px; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
          ${renderIcon('shield', 15)} Task-Held Lease Active (ADR-0005)
        </strong>
        <span class="status-pill purple" style="font-size: 10px;">EXCLUSIVE LEASE</span>
      </div>
      <div style="font-size: 12px; color: var(--text-primary);">
        Task <strong>#${lease.holderId}</strong> (${lease.taskTitle ?? 'Active Task'}) held by <strong>@${lease.leadAgentName ?? 'Lead'}</strong>
      </div>
      <div style="font-size: 11px; color: var(--text-secondary);">
        Acquired: <strong>${lease.acquiredAt}</strong> · Project: <code>${lease.projectId}</code>
      </div>
      <div style="font-size: 10px; color: var(--text-muted); padding-top: 4px; border-top: 1px solid var(--purple-agent-border); margin-top: 2px;">
        ADR-0005 Safety Guarantee: Lease is held continuously from Task begin to end across runs, idle gaps, and human validation. No automatic timeout.
      </div>
    </div>
  `;
}

function renderReconcilingBox(env: EnvironmentInstance): string {
  return `
    <div style="background: var(--yellow-attention-bg); border: 1px solid var(--yellow-attention); border-radius: var(--radius-sm); padding: 12px; display: flex; flex-direction: column; gap: 8px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong style="font-size: 13px; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
          ${renderIcon('refresh', 15)} Worker Reconnected · Reconciling Settlement Evidence
        </strong>
        <span class="status-pill yellow" style="font-size: 10px;">RECONCILING</span>
      </div>
      <p style="font-size: 12px; color: var(--text-secondary); line-height: 1.4;">
        Worker on ${env.displayName} re-authenticated over TLS/WSS. Sprout is synchronizing locally retained events and verifying whether the interrupted engine process has stopped.
      </p>
      <div style="display: flex; justify-content: flex-end;">
        <button class="btn btn-warning btn-sm btn-reconcile-evidence">
          ${renderIcon('check', 13)} Reconcile & Synchronize Evidence
        </button>
      </div>
    </div>
  `;
}

function renderRecoveryAlertBox(env: EnvironmentInstance, _task?: any): string {
  const recovery = env.leaseRecovery;
  const unresolved = recovery?.unresolvedFacts ?? [
    'Worker process unreachable over carrier overlay',
    'Engine process status unverified',
    'Task scratch context directory not yet recycled',
  ];

  return `
    <div style="background: var(--red-action-bg); border: 1px solid var(--red-action); border-radius: var(--radius-sm); padding: 14px; display: flex; flex-direction: column; gap: 10px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong style="font-size: 14px; color: var(--red-action); display: flex; align-items: center; gap: 6px;">
          ${renderIcon('alert', 16)} Lease Recovery Required (ADR-0006 & ADR-0009)
        </strong>
        <span class="status-pill red" style="font-size: 10px;">RECOVERY LOCKED</span>
      </div>

      <div style="font-size: 12px; color: var(--text-primary);">
        <strong>Cause:</strong> ${recovery?.cause ?? 'Worker channel lost mid-turn during active Agent run.'}
      </div>

      ${
        recovery?.interruptedRunId
          ? `<div style="font-size: 11px; color: var(--text-secondary);">
              Interrupted Run: <code>${recovery.interruptedRunId}</code> (${recovery.interruptedRunAgent ?? 'Agent Lead'})
            </div>`
          : ''
      }

      <div style="background: var(--bg-surface); padding: 10px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle); font-size: 11px; display: flex; flex-direction: column; gap: 4px;">
        <strong style="color: var(--text-muted); text-transform: uppercase; font-size: 10px;">Unresolved Operational Facts:</strong>
        ${unresolved.map((u) => `<div style="color: var(--text-secondary);">• ${u}</div>`).join('')}
      </div>

      ${
        recovery?.reconciledEvidence
          ? `<div style="background: var(--green-ready-bg); border: 1px solid var(--green-ready); padding: 8px 10px; border-radius: var(--radius-xs); font-size: 11px; color: var(--text-primary);">
              <strong>Reconciliation Proof:</strong> Retained ${recovery.reconciledEvidence.retainedEventsCount} events, verified engine session stopped. Ready for Human decision.
            </div>`
          : ''
      }

      <!-- Recovery Actions -->
      <div style="display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; padding-top: 6px; border-top: 1px solid var(--red-action-border);">
        <button class="btn btn-secondary btn-sm btn-resume-recovery">
          ${renderIcon('play', 13)} Resume Task on Same Host
        </button>
        <button class="btn btn-secondary btn-sm btn-discard-recovery">
          ${renderIcon('close', 13)} Discard Task & Safe Release
        </button>
        <button class="btn btn-danger btn-sm force-release-btn">
          ${renderIcon('warning', 13)} Emergency Force Release
        </button>
      </div>
    </div>
  `;
}

function renderForcedReleaseAuditBox(fr: NonNullable<EnvironmentInstance['forcedReleaseRecord']>): string {
  return `
    <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 10px; font-size: 12px; display: flex; flex-direction: column; gap: 4px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong style="color: var(--text-primary); font-size: 12px;">Durable Forced Release Audit Event</strong>
        <span class="status-pill green" style="font-size: 9px;">REASSIGNABLE</span>
      </div>
      <div style="color: var(--text-secondary); font-size: 11px;">
        Authorized by: <strong>${fr.actor}</strong> · Time: <strong>${fr.timestamp}</strong>
      </div>
      <div style="color: var(--text-secondary); font-size: 11px;">
        Reason: <em>"${fr.reason}"</em>
      </div>
    </div>
  `;
}

// --- Modals for Bootstrap Guide and New Host Registration ---

function openBootstrapGuideDialog() {
  stateManager.openDialog({
    id: 'dlg-bootstrap-guide',
    kind: 'modal-dialog',
    title: 'Host Bootstrap & Enrollment Guide',
    subtitle: 'macOS & Windows Service Setup under ADR-0008 & ADR-0009',
    bodyText: `
<strong>1. Install Sprout Worker Binary:</strong><br/>
• macOS: Download <code>sprout-worker-darwin-arm64</code> to <code>~/.local/bin/</code> and register as a user login item via launchd.<br/>
• Windows: Download <code>sprout-worker-windows-x64.exe</code> and register as a logon-triggered Scheduled Task.<br/><br/>

<strong>2. Key Generation & Privacy Isolation:</strong><br/>
• The worker generates a private key on the host. The private key never leaves the host.<br/>
• Joins the operator private overlay network (TLS/WSS) or loopback.<br/><br/>

<strong>3. Local Engine Authentication:</strong><br/>
• Run engine logins locally in the operator session (e.g. <code>codex login</code>, <code>pi auth</code>).<br/>
• Engine credentials remain local to the host; Web inspects only neutral readiness facts.<br/><br/>

<strong>4. Operator Web Approval:</strong><br/>
• Operator inspects the pending worker identity, platform, and capability permissions in Web and approves enrollment with one explicit click.
    `,
    confirmLabel: 'Close Guide',
    onConfirm: () => stateManager.closeDialog(),
  });
}

function openRegisterHostDialog() {
  stateManager.openDialog({
    id: 'dlg-register-host',
    kind: 'modal-dialog',
    title: 'Register New Host Environment',
    subtitle: 'Simulate pending worker bootstrap connection over Private Overlay',
    bodyText: `
To enroll a new host machine into Sprout, execute this command on the target host in your operator user session:<br/><br/>

<pre style="background: var(--bg-surface-elevated); padding: 8px 10px; border-radius: 4px; font-size: 11px; color: var(--accent-primary); overflow-x: auto;">sprout worker enroll --overlay 100.64.0.4:5174</pre><br/>

Simulate a new incoming worker connection now to test the operator pending approval journey.
    `,
    confirmLabel: 'Simulate macOS Host',
    cancelLabel: 'Simulate Windows Host',
    onConfirm: () => {
      stateManager.simulateRegisterNewPendingHost('macos');
      stateManager.closeDialog();
    },
    onCancel: () => {
      stateManager.simulateRegisterNewPendingHost('windows');
      stateManager.closeDialog();
    },
  });
}
