import { stateManager, type PrototypeState } from '../state.js';

export function renderInspectorSheet(state: PrototypeState): HTMLElement | null {
  if (!state.inspectorSheet.isOpen || state.inspectorSheet.kind === 'none') {
    return null;
  }

  const overlay = document.createElement('div');
  overlay.className = 'inspector-overlay';

  const sheet = document.createElement('div');
  sheet.className = 'inspector-sheet';

  const kind = state.inspectorSheet.kind;
  const entityId = state.inspectorSheet.entityId;

  if (kind === 'routing') {
    const batch = state.routingBatches.find((b) => b.id === entityId) ?? state.routingBatches[0];
    sheet.innerHTML = `
      <div class="inspector-header">
        <div>
          <h3 style="font-size: 16px; font-weight: 700;">🔍 Routing Causal Chain Inspector</h3>
          <p style="font-size: 11px; color: var(--text-secondary);">Durable causal evidence under ADR-0007</p>
        </div>
        <button class="btn btn-secondary btn-sm close-sheet-btn">✕</button>
      </div>
      <div class="inspector-body">
        <div style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm); font-size: 12px; display: flex; flex-direction: column; gap: 6px;">
          <div><strong>Batch ID:</strong> <code>${batch?.id ?? 'batch-001'}</code></div>
          <div><strong>Collection Window:</strong> ${batch?.openedAt} → ${batch?.closedAt} (Fixed 30s)</div>
          <div><strong>Status:</strong> <span class="status-pill green" style="font-size: 10px;">${batch?.status ?? 'settled'}</span></div>
          <div><strong>Wake Model:</strong> <code>${batch?.wakeModel ?? 'gpt-4o-mini'}</code> (Attempt ${batch?.attemptsCount ?? 1} of 2)</div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px;">
          <h4 style="font-size: 13px; font-weight: 700;">Frozen Context Bounds</h4>
          <div style="background: var(--bg-surface-elevated); padding: 10px; border-radius: var(--radius-sm); font-size: 12px; color: var(--text-secondary);">
            Token Count: ${batch?.frozenContextSummary.tokenCount ?? 1840} · Project Rules Included: Yes · Recent Messages: 4 · Truncated: No<br/>
            <em>Private reasoning, engine sessions, and credentials strictly excluded.</em>
          </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px;">
          <h4 style="font-size: 13px; font-weight: 700;">Model Decision & Concise Rationale</h4>
          ${
            batch?.decisions
              .map(
                (d) => `
            <div style="background: var(--bg-surface-elevated); border-left: 3px solid var(--purple-agent); padding: 10px; border-radius: var(--radius-sm); font-size: 12px;">
              <div style="display: flex; justify-content: space-between;">
                <strong>Target: @${d.targetAgentId ?? 'none'}</strong>
                <span class="status-pill ${d.status === 'selected' ? 'green' : 'neutral'}" style="font-size: 10px;">${d.status}</span>
              </div>
              <p style="color: var(--text-primary); margin-top: 4px;">
                <em>"${d.rationale}"</em> <span style="font-size: 10px; color: var(--text-muted);">(Model judgement, not fact)</span>
              </p>
            </div>
          `
              )
              .join('') ?? ''
          }
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px;">
          <h4 style="font-size: 13px; font-weight: 700;">Resulting WakeRequest</h4>
          <div style="background: var(--bg-surface-elevated); padding: 10px; border-radius: var(--radius-sm); font-size: 12px;">
            WakeRequest ID: <code>wake-02</code> · Status: <strong>Admitted</strong> · Linked Agent Run: <code>#run-202</code>
          </div>
        </div>
      </div>
    `;
  } else if (kind === 'force-release') {
    const env = state.environments.find((e) => e.id === entityId) ?? state.environments[1]!;
    const task = state.tasks.find((t) => t.selectedEnvironmentId === env.id && t.lifecycle === 'recovery');

    sheet.innerHTML = `
      <div class="inspector-header" style="border-bottom: 2px solid var(--red-action);">
        <div>
          <h3 style="font-size: 16px; font-weight: 700; color: var(--red-action);">🚨 Emergency Force Release</h3>
          <p style="font-size: 11px; color: var(--text-secondary);">Human-only override for otherwise stuck recovery (ADR-0009)</p>
        </div>
        <button class="btn btn-secondary btn-sm close-sheet-btn">✕</button>
      </div>
      <div class="inspector-body">
        <div style="background: var(--red-action-bg); border: 1px solid var(--red-action); padding: 12px; border-radius: var(--radius-sm); font-size: 12px; color: var(--text-primary);">
          <strong>EMERGENCY OVERRIDE WARNING:</strong><br/>
          Force Release bypasses normal worker proof and scratch context cleanup. It permanently marks Task #${task?.id ?? '104'} as cancelled with a forced release disposition, preserves the Project workspace, and makes the Environment immediately reassignable.
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px;">
          <h4 style="font-size: 13px; font-weight: 700;">Unresolved Operational Facts</h4>
          <div style="background: var(--bg-surface-elevated); padding: 10px; border-radius: var(--radius-sm); font-size: 12px; display: flex; flex-direction: column; gap: 4px;">
            <div>⚠️ Worker connection: Offline for 14m (engine process stop unverified).</div>
            <div>⚠️ Temporary Task context: Unrecycled on host.</div>
            <div>⚠️ Telemetry: Partial run telemetry uncollected.</div>
          </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-size: 12px; font-weight: 700;">Required Reason for Emergency Override:</label>
          <input class="force-reason-input" type="text" placeholder="e.g. Host OS kernel panic; worker cannot reconnect" style="background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); color: var(--text-primary); padding: 8px; border-radius: var(--radius-sm); font-size: 13px;" value="Host machine hard rebooted without clean worker exit" />
        </div>

        <div style="display: flex; align-items: flex-start; gap: 8px; margin-top: 4px;">
          <input type="checkbox" id="ack-risks" style="margin-top: 3px;" />
          <label for="ack-risks" style="font-size: 12px; color: var(--text-secondary);">
            I acknowledge the risks of concurrent execution and leftover temporary state, and authorize permanent emergency release.
          </label>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px;">
          <button class="btn btn-secondary btn-sm close-sheet-btn">Cancel</button>
          <button class="btn btn-danger confirm-force-btn">
            Authorize Force Release (Emergency Human Action)
          </button>
        </div>
      </div>
    `;

    sheet.querySelector('.confirm-force-btn')?.addEventListener('click', () => {
      const ack = (sheet.querySelector('#ack-risks') as HTMLInputElement)?.checked;
      const reason = (sheet.querySelector('.force-reason-input') as HTMLInputElement)?.value;
      if (!ack) {
        alert('You must check the risk acknowledgment checkbox before confirming Force Release.');
        return;
      }
      if (!reason || !reason.trim()) {
        alert('Please provide a reason for the emergency Force Release.');
        return;
      }
      stateManager.emergencyForceRelease(env.id, task?.id ?? 'task-104', reason.trim(), true);
    });
  }

  sheet.querySelectorAll('.close-sheet-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      stateManager.closeInspector();
    });
  });

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) {
      stateManager.closeInspector();
    }
  });

  overlay.appendChild(sheet);
  return overlay;
}
