import { renderIcon } from "../icons.js";
import { stateManager, type PrototypeState } from '../state.js';

export function renderOnboardingView(_state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'view-container';

  const wizardCard = document.createElement('div');
  wizardCard.className = 'card';
  wizardCard.innerHTML = `
    <div class="card-header">
      <div>
        <h2 style="font-size: 17px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
          ${renderIcon('user', 18)} First-Run Onboarding Wizard
        </h2>
        <p style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
          Web-led bootstrap to establish first Environment, Agent, and Project (ADR-0008).
        </p>
      </div>
      <span class="status-pill purple">5-Step Setup</span>
    </div>

    <div style="display: flex; flex-direction: column; gap: 14px; font-size: 13px;">
      <!-- Step 1: Host Bootstrap -->
      <div style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm); border-left: 3px solid var(--accent-primary);">
        <div style="font-weight: 700; color: var(--accent-primary);">Step 1: Host-Local Worker Bootstrap</div>
        <p style="color: var(--text-secondary); margin-top: 4px;">
          Run on your development host in the user session. Worker generates its private key locally:
        </p>
        <pre style="background: #090c10; padding: 8px; border-radius: 4px; font-size: 11px; margin-top: 6px; overflow-x: auto; color: #38bdf8;">curl -fsSL https://sprout.local/install-worker.sh | sh
sprout-worker init --overlay=100.64.0.4:5174</pre>
      </div>

      <!-- Step 2: Human Approval in Web -->
      <div style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm); border-left: 3px solid var(--yellow-attention);">
        <div style="font-weight: 700; color: var(--yellow-attention);">Step 2: Approve Worker Identity & Capabilities</div>
        <p style="color: var(--text-secondary); margin-top: 4px;">
          Pending worker: <code>sprout-wk-mac-7f89a1c2</code> (macOS). Operator approves file & terminal permissions.
        </p>
        <button class="btn btn-secondary btn-sm" style="margin-top: 6px;" onclick="alert('Worker identity confirmed and capabilities granted.')">
          Approve Worker Permissions
        </button>
      </div>

      <!-- Step 3: Configure Agent -->
      <div style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm); border-left: 3px solid var(--purple-agent);">
        <div style="font-weight: 700; color: var(--purple-agent);">Step 3: Setup First Global Agent</div>
        <p style="color: var(--text-secondary); margin-top: 4px;">
          Prefilled work options: Priority 1: Pi (claude-3-5-sonnet), Priority 2: Codex (gpt-4o).
        </p>
      </div>

      <!-- Step 4: First Project from Template -->
      <div style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm); border-left: 3px solid var(--green-ready);">
        <div style="font-weight: 700; color: var(--green-ready);">Step 4: Create First Project</div>
        <p style="color: var(--text-secondary); margin-top: 4px;">
          Applies the built-in <strong>General Collaboration Template</strong> snapshot: goal guidance, suggested rules, Agent slot bindings, and default workspace root.
        </p>
      </div>
    </div>

    <div style="display: flex; justify-content: flex-end; margin-top: 12px; border-top: 1px solid var(--border-subtle); padding-top: 12px;">
      <button class="btn btn-primary finish-onboarding-btn">
        Complete Onboarding & Enter Project Channel →
      </button>
    </div>
  `;

  wizardCard.querySelector('.finish-onboarding-btn')?.addEventListener('click', () => {
    stateManager.setActiveTab('projects');
  });

  container.appendChild(wizardCard);

  return container;
}
