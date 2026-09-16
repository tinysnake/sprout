import { renderIcon } from '../icons.js';
import type { PrototypeState } from '../state.js';

export function renderSettingsView(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'view-container';

  container.innerHTML = `
    <!-- Settings Header -->
    <div class="view-header">
      <div class="view-header-title">
        <h2 style="font-size: 18px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
          ${renderIcon('settings', 18)}
          <span>General & Operator Settings</span>
        </h2>
        <span class="proto-badge">Manage · Settings</span>
      </div>
      <p style="font-size: 13px; color: var(--text-secondary); margin-top: 4px;">
        Operator identity, overlay network transport, session management, and host-local diagnostic tools.
      </p>
    </div>

    <!-- 1. Operator Identity & Active Session -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">Operator Identity & Access Boundary</span>
        <span class="badge badge-green">Connected</span>
      </div>
      <div class="card-body" style="display: flex; flex-direction: column; gap: 10px;">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px;">
          <div>
            <div style="font-size: 11px; color: var(--text-muted); font-weight: 600;">OPERATOR NAME</div>
            <div style="font-size: 14px; font-weight: 600;">${state.operator.name}</div>
          </div>
          <div>
            <div style="font-size: 11px; color: var(--text-muted); font-weight: 600;">OPERATOR ID</div>
            <div style="font-size: 13px; font-family: var(--font-mono);">${state.operator.id}</div>
          </div>
          <div>
            <div style="font-size: 11px; color: var(--text-muted); font-weight: 600;">TRANSPORT TYPE</div>
            <div style="font-size: 13px;">${state.operator.transport === 'private-overlay' ? 'Private Overlay Network' : 'Localhost Loopback'}</div>
          </div>
          <div>
            <div style="font-size: 11px; color: var(--text-muted); font-weight: 600;">OVERLAY BINDING</div>
            <div style="font-size: 13px; font-family: var(--font-mono);">${state.operator.overlayAddress ?? '127.0.0.1:5174'}</div>
          </div>
        </div>

        <div style="margin-top: 6px; padding-top: 10px; border-top: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
          <span style="font-size: 12px; color: var(--text-secondary);">
            Active browser sessions: <strong>${state.operator.sessionCount}</strong> (Shared state synchronized via Server-Sent Events)
          </span>
          <button class="btn btn-secondary btn-sm" id="btn-revoke-other-sessions">
            Revoke Other Sessions
          </button>
        </div>
      </div>
    </div>

    <!-- 2. Sprout Instance & Protocol Information -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">Instance & Protocol Specifications</span>
      </div>
      <div class="card-body" style="display: flex; flex-direction: column; gap: 8px; font-size: 13px;">
        <div style="display: flex; justify-content: space-between; padding-bottom: 6px; border-bottom: 1px solid var(--border-subtle);">
          <span style="color: var(--text-secondary);">Sprout Core Version</span>
          <strong>v0.2.0 (M2 Milestone Prototype)</strong>
        </div>
        <div style="display: flex; justify-content: space-between; padding-bottom: 6px; border-bottom: 1px solid var(--border-subtle);">
          <span style="color: var(--text-secondary);">Worker-Orchestrator Protocol</span>
          <strong>JSON-RPC 2.0 / WebSocket v1.2</strong>
        </div>
        <div style="display: flex; justify-content: space-between; padding-bottom: 6px; border-bottom: 1px solid var(--border-subtle);">
          <span style="color: var(--text-secondary);">Durable Database</span>
          <strong>SQLite3 (WAL Mode · Automatic crash recovery)</strong>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span style="color: var(--text-secondary);">Data Location</span>
          <code>~/.sprout/sprout.db</code>
        </div>
      </div>
    </div>

    <!-- 3. Diagnostics & Host-Local Recovery Guidance -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">Host Diagnostics & Recovery Guidance</span>
      </div>
      <div class="card-body" style="display: flex; flex-direction: column; gap: 10px;">
        <p style="font-size: 12px; color: var(--text-secondary);">
          Sprout enforces privacy and zero secret exfiltration. Private keys and engine credentials remain exclusively on host machines (ADR-0009).
        </p>

        <div style="display: flex; flex-wrap: wrap; gap: 8px;">
          <button class="btn btn-secondary btn-sm" id="btn-export-diagnostics">
            Export Sanitized Diagnostic Bundle
          </button>
          <button class="btn btn-secondary btn-sm" id="btn-host-recovery-guide">
            CLI Unreachable Host Recovery Guide
          </button>
        </div>
      </div>
    </div>
  `;

  // Attach event listeners
  container.querySelector('#btn-revoke-other-sessions')?.addEventListener('click', () => {
    state.operator.sessionCount = 1;
    alert('All other browser sessions have been revoked.');
  });

  container.querySelector('#btn-export-diagnostics')?.addEventListener('click', () => {
    const diagnostic = {
      timestamp: new Date().toISOString(),
      operator: state.operator.id,
      transport: state.operator.transport,
      projectsCount: state.projects.length,
      environmentsCount: state.environments.length,
      tasksCount: state.tasks.length,
      sanitized: true,
    };
    alert(`Sanitized Diagnostic Export:\n\n${JSON.stringify(diagnostic, null, 2)}`);
  });

  container.querySelector('#btn-host-recovery-guide')?.addEventListener('click', () => {
    alert(
      'CLI Host Recovery Guide:\n\nIf a remote host worker is unreachable:\n1. SSH or physical login to the machine.\n2. Check `sprout-worker status`.\n3. Verify Tailscale / overlay mesh connectivity.\n4. Check logs in `~/.sprout/logs/worker.log`.\n5. Restart service: `sprout-worker restart`.'
    );
  });

  return container;
}
