import { renderIcon } from '../icons.js';
import { stateManager, type PrototypeState, type SettingsCategoryTab } from '../state.js';
import type { OperatorSettingsModel, SettingsHealthState } from '../types.js';

function badgeClass(state: SettingsHealthState | OperatorSettingsModel['instance']['compatibility']): string {
  if (state === 'normal' || state === 'compatible') return 'badge-green';
  if (state === 'warning') return 'badge-yellow';
  if (state === 'failure') return 'badge-red';
  return 'badge-info';
}

function stateLabel(state: SettingsHealthState): string {
  return state === 'risk' ? 'Risk-bearing' : state[0]!.toUpperCase() + state.slice(1);
}

function renderList(items: string[], className = 'settings-list'): string {
  return `<ul class="${className}">${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
}

export function renderSettingsView(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'view-container settings-view';
  const settings = state.settings;
  const currentCategory: SettingsCategoryTab = state.settingsCategoryTab ?? 'access';
  const activeSessionCount = settings.browserSessions.filter(
    (session) => session.state === 'current' || session.state === 'active'
  ).length;

  container.innerHTML = `
    <header class="settings-page-header">
      <div class="settings-title-row">
        <div>
          <h2 class="settings-page-title">${renderIcon('settings', 19)} <span>General &amp; Operator Settings</span></h2>
          <p class="settings-page-description">Identity, access, compatibility, durable data, and diagnostics for one local technical operator.</p>
        </div>
        <span class="badge badge-info">Manage / Settings</span>
      </div>
      <div class="settings-boundary-note">
        ${renderIcon('shield', 16)}
        <span><strong>Routine operation stays in Web.</strong> Host-owned credentials, installation, startup, network policy, and offline diagnostics stay on the Sprout host.</span>
      </div>
    </header>

    <section class="settings-status-strip" aria-label="Settings status summary">
      <div class="settings-status-item settings-status-normal ${currentCategory === 'access' ? 'is-active-tab' : ''}" data-status-tab="access" role="button" tabindex="0" title="Switch to Access &amp; Security">
        <span class="settings-status-icon">${renderIcon('check', 15)}</span>
        <div><strong>Operator access</strong><span>Authenticated</span></div>
      </div>
      <div class="settings-status-item settings-status-normal ${currentCategory === 'system' ? 'is-active-tab' : ''}" data-status-tab="system" role="button" tabindex="0" title="Switch to Instance &amp; System">
        <span class="settings-status-icon">${renderIcon('server', 15)}</span>
        <div><strong>Instance</strong><span>Compatible</span></div>
      </div>
      <div class="settings-status-item settings-status-warning ${currentCategory === 'system' ? 'is-active-tab' : ''}" data-status-tab="system" role="button" tabindex="0" title="Switch to Instance &amp; System">
        <span class="settings-status-icon">${renderIcon('warning', 15)}</span>
        <div><strong>Migration guard</strong><span>Safety copy retained</span></div>
      </div>
    </section>

    <nav class="settings-sub-tabs" role="tablist" aria-label="Settings categories">
      <button role="tab" class="settings-sub-tab ${currentCategory === 'access' ? 'active' : ''}" data-settings-tab="access" aria-selected="${currentCategory === 'access'}">
        ${renderIcon('shield', 15)} <span>Access &amp; Security</span>
      </button>
      <button role="tab" class="settings-sub-tab ${currentCategory === 'system' ? 'active' : ''}" data-settings-tab="system" aria-selected="${currentCategory === 'system'}">
        ${renderIcon('server', 15)} <span>Instance &amp; System</span>
      </button>
      <button role="tab" class="settings-sub-tab ${currentCategory === 'data' ? 'active' : ''}" data-settings-tab="data" aria-selected="${currentCategory === 'data'}">
        ${renderIcon('box', 15)} <span>Data &amp; Diagnostics</span>
      </button>
    </nav>

    <!-- Category 1: Access & Security -->
    <div class="settings-tab-panel ${currentCategory === 'access' ? 'is-active' : ''}" data-settings-tab-panel="access">
      <section class="card settings-card settings-identity-card" data-settings-section="identity">
        <div class="card-header settings-card-header">
          <div class="settings-card-heading">${renderIcon('shield', 17)}<div><h3 class="card-title">Operator identity and access boundary</h3><p>One Sprout instance has one operator identity. A private network is transport, not authority.</p></div></div>
          <span class="badge badge-green">Authenticated</span>
        </div>
        <div class="card-body settings-card-body">
          <div class="settings-fact-grid">
            <div class="settings-fact"><span class="settings-fact-label">Operator</span><strong>${state.operator.name}</strong><code>${state.operator.id}</code></div>
            <div class="settings-fact"><span class="settings-fact-label">Identity model</span><strong>Single operator</strong><span>Not a team account system</span></div>
            <div class="settings-fact"><span class="settings-fact-label">Browser boundary</span><strong>Loopback or private network</strong><span>Public Internet exposure is unsupported</span></div>
            <div class="settings-fact"><span class="settings-fact-label">Credential access</span><strong>Host-local only</strong><span>Agents and Workers never receive it</span></div>
          </div>

          <div class="settings-section-divider"></div>
          <div class="settings-inline-heading"><div><h4>Browser sessions</h4><p>${activeSessionCount} active session${activeSessionCount === 1 ? '' : 's'} share this operator identity.</p></div><button class="btn btn-secondary btn-sm" id="btn-revoke-other-sessions" ${activeSessionCount <= 1 ? 'disabled' : ''}>Revoke other sessions</button></div>
          <div class="settings-session-list" aria-label="Browser sessions">
            ${settings.browserSessions
              .map(
                (session) => `
                  <div class="settings-session-row ${session.state === 'revoked' ? 'is-revoked' : ''}" data-session-id="${session.id}">
                    <div class="settings-session-icon">${renderIcon(session.deviceLabel.startsWith('Phone') ? 'phone' : 'desktop', 16)}</div>
                    <div class="settings-session-copy"><strong>${session.deviceLabel}</strong><span>${session.browserLabel} · ${session.lastSeen}</span><small>${session.transportLabel}</small></div>
                    <div class="settings-session-action"><span class="badge ${session.state === 'revoked' ? 'badge-red' : session.state === 'current' ? 'badge-green' : 'badge-info'}">${session.state === 'current' ? 'This session' : session.state === 'active' ? 'Active' : 'Revoked'}</span>${session.state === 'active' ? `<button class="btn btn-ghost btn-sm session-revoke-btn" data-session-id="${session.id}">Revoke</button>` : ''}</div>
                  </div>
                `
              )
              .join('')}
          </div>
          <p class="settings-helper">Session revocation blocks future commands from that browser. It does not stop an already admitted Task; inspect its authoritative Project or Environment surface.</p>
        </div>
      </section>

      <section class="card settings-card" data-settings-section="credentials">
        <div class="card-header settings-card-header">
          <div class="settings-card-heading">${renderIcon('key', 17)}<div><h3 class="card-title">Credential recovery and rotation</h3><p>Recovery and rotation change access to this Web boundary. They are not Agent or Worker login controls.</p></div></div>
          <span class="badge ${settings.credentials.state === 'rotation-complete' ? 'badge-yellow' : 'badge-info'}">${settings.credentials.state === 'rotation-complete' ? 'Rotated just now' : 'Host-local recovery'}</span>
        </div>
        <div class="card-body settings-card-body">
          <div class="settings-guidance-grid"><div class="settings-guidance-block"><span class="settings-fact-label">Recovery owner</span><strong>Sprout host operator</strong><p>No default credential exists. Web cannot reveal or reset the secret.</p></div><div class="settings-guidance-block"><span class="settings-fact-label">Last rotation</span><strong>${settings.credentials.lastRotated}</strong><p>Rotation invalidates other browser sessions immediately.</p></div></div>
          <div class="settings-warning-inline">${renderIcon('warning', 15)} <span>${settings.credentials.rotationConsequence}</span></div>
          <button class="btn btn-outline btn-sm" id="btn-show-credential-risk" aria-expanded="false">Review rotation consequences</button>
          <div class="settings-risk-panel" id="credential-risk-panel" hidden>
            <div class="settings-risk-heading">${renderIcon('warning', 16)} <strong>Risk-bearing action</strong></div>
            <p>Rotate only when the current session is known to remain available. Other browsers will need to authenticate again. If this session is lost, recover access on the host before using Web.</p>
            <label class="settings-check-row"><input type="checkbox" id="credential-risk-checkbox" /> <span>I understand that other browser sessions will be revoked.</span></label>
            <label class="form-group"><span class="form-label">Type <code>ROTATE CREDENTIAL</code> to continue</span><input class="form-input" id="credential-risk-confirm" autocomplete="off" /></label>
            <button class="btn btn-danger" id="btn-rotate-credential" disabled>Rotate credential</button>
          </div>
        </div>
      </section>
    </div>

    <!-- Category 2: Instance & System -->
    <div class="settings-tab-panel ${currentCategory === 'system' ? 'is-active' : ''}" data-settings-tab-panel="system">
      <section class="card settings-card" data-settings-section="compatibility">
        <div class="card-header settings-card-header">
          <div class="settings-card-heading">${renderIcon('server', 17)}<div><h3 class="card-title">Sprout instance and compatibility</h3><p>Version facts explain whether routine Web operation is safe to continue.</p></div></div>
          <span class="badge ${badgeClass(settings.instance.compatibility)}">${settings.instance.compatibility === 'compatible' ? 'Compatible' : settings.instance.compatibility}</span>
        </div>
        <div class="card-body settings-card-body">
          <div class="settings-fact-grid settings-fact-grid-4"><div class="settings-fact"><span class="settings-fact-label">Sprout</span><strong>${settings.instance.sproutVersion}</strong><span>Local instance build</span></div><div class="settings-fact"><span class="settings-fact-label">Worker protocol</span><strong>${settings.instance.protocolVersion}</strong><span>Negotiated compatibility</span></div><div class="settings-fact"><span class="settings-fact-label">Durable schema</span><strong>${settings.instance.schemaVersion}</strong><span>Forward migration only</span></div><div class="settings-fact"><span class="settings-fact-label">Supported range</span><strong>${settings.instance.supportedSchemaRange}</strong><span>Outside range is refused</span></div></div>
          <div class="settings-state-line settings-state-line-normal">${renderIcon('check', 14)} <span>${settings.instance.compatibilityReason}</span></div>
          <details class="settings-disclosure"><summary class="settings-disclosure-header"><div class="settings-disclosure-title">${renderIcon('layers', 15)} <span>Migration safety and failure visibility</span></div><div class="settings-disclosure-right"><span class="badge badge-yellow">Safety copy retained</span><span class="foldable-chevron">${renderIcon('chevron-right', 14)}</span></div></summary><div class="settings-disclosure-body"><div class="settings-migration-summary"><strong>${settings.migration.sourceSchema} to ${settings.migration.targetSchema}</strong><span class="badge badge-yellow">${settings.migration.safetyCopyState === 'created' ? 'Safety copy created' : settings.migration.safetyCopyState}</span></div><p>${settings.migration.safetyCopyLabel}</p><p>${settings.migration.hostGuidance}</p><div class="settings-state-example settings-state-failure" data-settings-state="failure"><strong>${renderIcon('alert', 14)} Failure state example</strong><span>If the safety copy cannot be created, including because of insufficient space, migration stops before serving data. The original store and safety copy remain intact.</span></div><div class="settings-state-example settings-state-unavailable" data-settings-state="unavailable"><strong>${renderIcon('server', 14)} Unavailable state example</strong><span>A schema newer than the supported range is refused with host-local update guidance. Web does not guess across an unsupported protocol.</span></div><p class="settings-helper">This safety copy is a migration guard, not a product backup system. Backup, restore, retention, and disaster recovery remain host responsibilities.</p></div></details>
        </div>
      </section>

      <section class="card settings-card" data-settings-section="boundary">
        <div class="card-header settings-card-header"><div class="settings-card-heading">${renderIcon('split', 17)}<div><h3 class="card-title">Web routine operation versus host-local administration</h3><p>Sprout keeps routine product decisions in Web without pretending to manage the host.</p></div></div></div>
        <div class="card-body settings-card-body settings-boundary-grid"><div><h4 class="settings-list-heading settings-list-heading-web">Web can do</h4>${renderList(settings.boundaries.webRoutineOperations)}</div><div><h4 class="settings-list-heading settings-list-heading-host">Host-local only</h4>${renderList(settings.boundaries.hostLocalAdministration)}</div></div>
        <div class="settings-boundary-footer">Environment recovery and Force Release remain in <strong>Manage / Environments</strong>. Settings does not restart Sprout or operate maintenance mode.</div>
      </section>
    </div>

    <!-- Category 3: Data & Diagnostics -->
    <div class="settings-tab-panel ${currentCategory === 'data' ? 'is-active' : ''}" data-settings-tab-panel="data">
      <div class="settings-two-column">
        <section class="card settings-card" data-settings-section="data"><div class="card-header settings-card-header"><div class="settings-card-heading">${renderIcon('box', 17)}<div><h3 class="card-title">Durable data location</h3><p>Use this relative location when configuring host-managed backup.</p></div></div></div><div class="card-body settings-card-body"><div class="settings-location-block"><span class="settings-fact-label">Data root</span><code>${settings.durableData.rootLocation}</code><span>Database: <code>${settings.durableData.databaseLocation}</code></span></div><button class="btn btn-secondary btn-sm" id="btn-copy-data-location">${settings.durableData.copyState === 'copied' ? renderIcon('check', 14) + ' Location copied' : 'Copy relative location'}</button><details class="settings-disclosure"><summary class="settings-disclosure-header"><div class="settings-disclosure-title">${renderIcon('info', 15)} <span>What the host operator should include</span></div><div class="settings-disclosure-right"><span class="foldable-chevron">${renderIcon('chevron-right', 14)}</span></div></summary><div class="settings-disclosure-body">${renderList(settings.durableData.components)}<p class="settings-helper">${settings.durableData.backupBoundary}</p></div></details></div></section>

        <section class="card settings-card" data-settings-section="diagnostics"><div class="card-header settings-card-header"><div class="settings-card-heading">${renderIcon('clipboard', 17)}<div><h3 class="card-title">Sanitized diagnostics</h3><p>Export operational facts without secrets or content.</p></div></div><span class="badge ${settings.diagnostics.state === 'exported' ? 'badge-green' : 'badge-info'}">${settings.diagnostics.state === 'exported' ? 'Prepared' : 'Ready'}</span></div><div class="card-body settings-card-body"><div class="settings-state-line settings-state-line-normal">${renderIcon('check', 14)} <span>${settings.diagnostics.lastExport}</span></div><button class="btn btn-primary btn-sm" id="btn-export-diagnostics">Export sanitized diagnostics</button><details class="settings-disclosure"><summary class="settings-disclosure-header"><div class="settings-disclosure-title">${renderIcon('eye', 15)} <span>Inspect the export boundary</span></div><div class="settings-disclosure-right"><span class="foldable-chevron">${renderIcon('chevron-right', 14)}</span></div></summary><div class="settings-disclosure-body"><strong>Included</strong>${renderList(settings.diagnostics.includedFacts)}<strong>Excluded</strong>${renderList(settings.diagnostics.excludedFacts)}<div class="settings-state-example settings-state-unavailable" data-settings-state="unavailable"><strong>${renderIcon('terminal', 14)} Web unavailable fallback</strong><span>${settings.diagnostics.hostFallback}</span></div></div></details></div></section>
      </div>
    </div>

    <!-- Review & State Coverage Section -->
    <div class="settings-meta-section">
      <details class="card settings-card settings-review-card" data-settings-section="review"><summary class="settings-review-summary"><div class="settings-card-heading">${renderIcon('clipboard', 17)}<div><h3 class="card-title">Human-approved three-category structure</h3><p>Approved owner review evidence and downstream non-goals remain explicit on demand.</p></div></div><div class="settings-disclosure-right"><span class="badge badge-green">Approved owner review</span><span class="foldable-chevron">${renderIcon('chevron-right', 14)}</span></div></summary><div class="settings-card-body settings-review-body"><div class="settings-review-columns"><div><h4 class="settings-list-heading settings-list-heading-web">Accepted inheritance</h4>${renderList(settings.review.acceptedPatterns)}</div><div><h4 class="settings-list-heading settings-list-heading-host">Approved decisions</h4>${renderList(settings.review.approvedDecisions)}</div><div><h4 class="settings-list-heading settings-list-heading-warning">Downstream non-goals</h4>${renderList(settings.review.rejectedPatterns)}</div></div><p class="settings-artifact-note">Retained artifact: <code>${settings.review.artifactPath}</code>. This Human-approved record is authoritative for the prototype.</p></div></details>

      <details class="card settings-card settings-state-card" data-settings-section="states"><summary class="settings-review-summary"><div class="settings-card-heading">${renderIcon('activity', 17)}<div><h3 class="card-title">Settings state coverage</h3><p>Normal, loading, unavailable, failure, warning, and risk-bearing states remain explicit in the model.</p></div></div><div class="settings-disclosure-right"><span class="badge badge-info">${settings.stateMatrix.length} states</span><span class="foldable-chevron">${renderIcon('chevron-right', 14)}</span></div></summary><div class="settings-state-matrix">${settings.stateMatrix.map((item) => `<div class="settings-matrix-row settings-matrix-${item.key}" data-settings-state="${item.key}"><span class="settings-matrix-icon">${renderIcon(item.key === 'normal' ? 'check' : item.key === 'risk' || item.key === 'failure' ? 'warning' : item.key === 'loading' ? 'refresh' : 'info', 14)}</span><strong>${stateLabel(item.key)}</strong><span>${item.summary}</span></div>`).join('')}</div></details>
    </div>
  `;

  // Sub-tabs navigation
  container.querySelectorAll<HTMLButtonElement>('.settings-sub-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      const tab = tabBtn.dataset.settingsTab as SettingsCategoryTab;
      if (tab) stateManager.setSettingsCategoryTab(tab);
    });
  });

  // Status strip shortcuts
  container.querySelectorAll<HTMLElement>('[data-status-tab]').forEach((statusItem) => {
    statusItem.addEventListener('click', () => {
      const tab = statusItem.dataset.statusTab as SettingsCategoryTab;
      if (tab) stateManager.setSettingsCategoryTab(tab);
    });
    statusItem.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const tab = statusItem.dataset.statusTab as SettingsCategoryTab;
        if (tab) stateManager.setSettingsCategoryTab(tab);
      }
    });
  });

  container.querySelector('#btn-revoke-other-sessions')?.addEventListener('click', () => stateManager.revokeOtherBrowserSessions());
  container.querySelectorAll<HTMLButtonElement>('.session-revoke-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const sessionId = button.dataset.sessionId;
      if (sessionId) stateManager.revokeBrowserSession(sessionId);
    });
  });
  container.querySelector('#btn-export-diagnostics')?.addEventListener('click', () => stateManager.exportSanitizedDiagnostics());
  container.querySelector('#btn-copy-data-location')?.addEventListener('click', () => stateManager.markDurableDataLocationCopied());

  const riskToggle = container.querySelector('#btn-show-credential-risk') as HTMLButtonElement | null;
  const riskPanel = container.querySelector('#credential-risk-panel') as HTMLElement | null;
  const riskCheckbox = container.querySelector('#credential-risk-checkbox') as HTMLInputElement | null;
  const riskConfirm = container.querySelector('#credential-risk-confirm') as HTMLInputElement | null;
  const rotateButton = container.querySelector('#btn-rotate-credential') as HTMLButtonElement | null;
  const syncRiskAction = () => {
    if (rotateButton) rotateButton.disabled = !(riskCheckbox?.checked && riskConfirm?.value.trim() === 'ROTATE CREDENTIAL');
  };
  riskToggle?.addEventListener('click', () => {
    if (!riskPanel || !riskToggle) return;
    const isHidden = riskPanel.hidden;
    riskPanel.hidden = !isHidden;
    riskToggle.setAttribute('aria-expanded', String(isHidden));
    if (isHidden) riskCheckbox?.focus();
  });
  riskCheckbox?.addEventListener('change', syncRiskAction);
  riskConfirm?.addEventListener('input', syncRiskAction);
  rotateButton?.addEventListener('click', () => {
    if (!rotateButton.disabled) stateManager.rotateOperatorCredential();
  });

  return container;
}
