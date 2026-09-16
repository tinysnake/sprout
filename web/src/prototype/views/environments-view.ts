import { renderIcon } from '../icons.js';
import { stateManager, type PrototypeState } from '../state.js';

export function renderEnvironmentsView(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'view-container';

  // Section 1: Environments Overview Header
  const envHeader = document.createElement('div');
  envHeader.className = 'card';
  envHeader.innerHTML = `
    <div class="card-header">
      <div>
        <h2 style="font-size: 17px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
          ${renderIcon('environments', 18)}
          <span>Environments & Host Workers</span>
        </h2>
        <p style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
          Environment health is an independent multi-dimension model behind a traffic light summary (ADR-0008 & ADR-0009).
        </p>
      </div>
      <button class="btn btn-secondary btn-sm host-guide-btn">
        Host Bootstrap Guide
      </button>
    </div>

    <!-- Quick Environment Tabs -->
    <div style="display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px;">
      ${state.environments
        .map(
          (e) => `
        <button class="btn btn-sm env-tab-btn ${state.selectedEnvironmentId === e.id ? 'btn-primary' : 'btn-secondary'}" data-env="${e.id}">
          <span class="status-dot ${e.trafficLight}"></span> ${e.displayName}
        </button>
      `
        )
        .join('')}
    </div>
  `;

  envHeader.querySelectorAll('.env-tab-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const envId = (ev.currentTarget as HTMLElement).getAttribute('data-env')!;
      stateManager.selectEnvironment(envId);
    });
  });

  envHeader.querySelector('.host-guide-btn')?.addEventListener('click', () => {
    alert(
      'Host Bootstrap Setup (ADR-0009):\n\n1. Install Sprout worker binary on macOS/Windows host.\n2. Configure launchd login item / Scheduled Task.\n3. Worker generates private key on host: private key never leaves host.\n4. Join operator private overlay network (TLS/WSS).\n5. Run engine logins locally (codex login, pi auth).\n6. Operator approves enrollment in Web.'
    );
  });

  container.appendChild(envHeader);

  // Section 2: Selected Environment Detail
  const selectedEnv =
    state.environments.find((e) => e.id === state.selectedEnvironmentId) ?? state.environments[0];
  if (!selectedEnv) {
    container.innerHTML += `<div class="card"><p>No environment selected.</p></div>`;
    return container;
  }

  const detailCard = document.createElement('div');
  detailCard.className = 'card';
  detailCard.innerHTML = `
    <!-- Prominent Traffic Light Summary -->
    <div style="background: ${selectedEnv.trafficLight === 'green' ? 'var(--green-ready-bg)' : selectedEnv.trafficLight === 'yellow' ? 'var(--yellow-attention-bg)' : 'var(--red-action-bg)'}; border: 1px solid ${selectedEnv.trafficLight === 'green' ? 'var(--green-ready)' : selectedEnv.trafficLight === 'yellow' ? 'var(--yellow-attention)' : 'var(--red-action)'}; border-radius: var(--radius-md); padding: 14px; display: flex; flex-direction: column; gap: 6px;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <span style="font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
          <span class="status-dot ${selectedEnv.trafficLight}" style="width: 12px; height: 12px;"></span>
          ${
            selectedEnv.trafficLight === 'green'
              ? 'Green: Ready'
              : selectedEnv.trafficLight === 'yellow'
              ? 'Yellow: Attention'
              : 'Red: Unavailable / Action Required'
          }
        </span>
        <span class="status-pill ${selectedEnv.trafficLight === 'green' ? 'green' : selectedEnv.trafficLight === 'yellow' ? 'yellow' : 'red'}" style="font-size: 11px;">
          ${selectedEnv.platform.toUpperCase()}
        </span>
      </div>
      <div style="font-size: 13px; font-weight: 600; color: var(--text-primary);">
        Decisive Reason: ${selectedEnv.trafficLightReason}
      </div>
    </div>

    <!-- 6 Independent Health Dimensions -->
    <div style="display: flex; flex-direction: column; gap: 10px;">
      <h3 style="font-size: 14px; font-weight: 700; color: var(--text-primary); border-bottom: 1px solid var(--border-subtle); padding-bottom: 6px;">
        6 Independent Health Dimensions (Never collapsed into one boolean)
      </h3>

      <div class="metrics-grid">
        <!-- 1. Enrollment -->
        <div class="metric-tile">
          <span class="metric-label">1. Enrollment</span>
          <span class="metric-value" style="font-size: 13px;">${selectedEnv.enrollmentStatus.toUpperCase()}</span>
          <span class="metric-sub">Key: <code>${selectedEnv.workerIdentityKey.slice(0, 14)}...</code></span>
        </div>

        <!-- 2. Connection -->
        <div class="metric-tile">
          <span class="metric-label">2. Connection</span>
          <span class="metric-value" style="font-size: 13px;">${selectedEnv.connectionState.toUpperCase()}</span>
          <span class="metric-sub">Last confirmed: ${selectedEnv.lastConfirmedTime}</span>
        </div>

        <!-- 3. Compatibility -->
        <div class="metric-tile">
          <span class="metric-label">3. Protocol</span>
          <span class="metric-value" style="font-size: 13px;">${selectedEnv.protocolCompatibility.toUpperCase()}</span>
          <span class="metric-sub">Version: ${selectedEnv.protocolVersion}</span>
        </div>

        <!-- 4. Work Safety -->
        <div class="metric-tile">
          <span class="metric-label">4. Work Safety</span>
          <span class="metric-value" style="font-size: 13px;">${selectedEnv.workSafety.toUpperCase()}</span>
          <span class="metric-sub">${selectedEnv.activeLeaseHolder ? `Lease: ${selectedEnv.activeLeaseHolder.holderId}` : 'No active lease'}</span>
        </div>
      </div>

      <!-- 5. Capability Permissions -->
      <div style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm); font-size: 12px; display: flex; flex-direction: column; gap: 6px;">
        <span style="font-weight: 700; text-transform: uppercase; color: var(--text-muted); font-size: 11px;">5. Capability Permissions</span>
        <div style="display: flex; gap: 12px; flex-wrap: wrap;">
          <span>File R/W: <strong>${selectedEnv.capabilityPermissions.fileReadWrite ? 'Granted' : 'Refused'}</strong></span>
          <span>Process Execution: <strong>${selectedEnv.capabilityPermissions.processExecution ? 'Granted' : 'Refused'}</strong></span>
          <span>Network: <strong>${selectedEnv.capabilityPermissions.networkAccess ? 'Granted' : 'Refused'}</strong></span>
          <span>GUI Automation: <strong>${selectedEnv.capabilityPermissions.guiAutomation ? 'Granted' : 'Refused'}</strong></span>
        </div>
      </div>

      <!-- 6. Engine Readiness -->
      <div style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm); font-size: 12px; display: flex; flex-direction: column; gap: 6px;">
        <span style="font-weight: 700; text-transform: uppercase; color: var(--text-muted); font-size: 11px;">6. Engine Harness Readiness (Host Local)</span>
        <div style="display: flex; gap: 12px; flex-wrap: wrap;">
          <span>Codex: <strong style="color: ${selectedEnv.engineReadiness.codex === 'ready' ? 'var(--green-ready)' : 'var(--yellow-attention)'}">${selectedEnv.engineReadiness.codex}</strong></span>
          <span>Pi: <strong style="color: ${selectedEnv.engineReadiness.pi === 'ready' ? 'var(--green-ready)' : 'var(--yellow-attention)'}">${selectedEnv.engineReadiness.pi}</strong></span>
          <span>agy: <strong>${selectedEnv.engineReadiness.agy}</strong></span>
          <span>opencode: <strong>${selectedEnv.engineReadiness.opencode}</strong></span>
        </div>
      </div>
    </div>

    <!-- Management & Simulation Actions -->
    <div style="display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; border-top: 1px solid var(--border-subtle); padding-top: 12px;">
      ${
        selectedEnv.enrollmentStatus === 'pending'
          ? `<button class="btn btn-primary approve-enroll-btn">Approve Enrollment (Human Action)</button>`
          : ''
      }
      <button class="btn btn-secondary btn-sm run-probe-btn">
        ${renderIcon('lightning', 13)} Request Readiness Probe
      </button>
      <button class="btn btn-warning btn-sm sim-disconnect-btn">
        ${renderIcon('alert', 13)} Simulate Worker Disconnect
      </button>
      ${
        selectedEnv.workSafety === 'recovery'
          ? `<button class="btn btn-danger btn-sm force-release-btn">${renderIcon('warning', 13)} Emergency Force Release</button>`
          : ''
      }
    </div>
  `;

  detailCard.querySelector('.approve-enroll-btn')?.addEventListener('click', () => {
    stateManager.approveEnvironmentEnrollment(selectedEnv.id);
  });

  detailCard.querySelector('.run-probe-btn')?.addEventListener('click', () => {
    stateManager.triggerReadinessProbe(selectedEnv.id);
  });

  detailCard.querySelector('.sim-disconnect-btn')?.addEventListener('click', () => {
    stateManager.triggerSimulatedWorkerDisconnect(selectedEnv.id);
  });

  detailCard.querySelector('.force-release-btn')?.addEventListener('click', () => {
    stateManager.openInspector('force-release', selectedEnv.id);
  });

  container.appendChild(detailCard);

  return container;
}
