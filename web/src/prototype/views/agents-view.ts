import { renderIcon } from '../icons.js';
import { stateManager, type PrototypeState } from '../state.js';

export function renderAgentsView(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'view-container';

  // Section 1: Agents Header
  const agentsHeader = document.createElement('div');
  agentsHeader.className = 'card';
  agentsHeader.innerHTML = `
    <div class="card-header">
      <div>
        <h2 style="font-size: 17px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
          ${renderIcon('agents', 18)}
          <span>Agents & Work Option Preferences</span>
        </h2>
        <p style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
          Agent identity is global and portable across Projects and Environments (ADR-0008).
        </p>
      </div>
      <button class="btn btn-secondary btn-sm new-agent-btn">
        + New Agent
      </button>
    </div>

    <!-- Agent Selector Tabs -->
    <div style="display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px;">
      ${state.agents
        .map(
          (a) => `
        <button class="btn btn-sm agent-tab-btn ${state.selectedAgentId === a.id ? 'btn-primary' : 'btn-secondary'}" data-agent="${a.id}" style="display: inline-flex; align-items: center; gap: 6px;">
          ${renderIcon('bot', 14)}
          <span>${a.displayName}</span>
        </button>
      `
        )
        .join('')}
    </div>
  `;

  agentsHeader.querySelectorAll('.agent-tab-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const agentId = (ev.currentTarget as HTMLElement).getAttribute('data-agent')!;
      stateManager.selectAgent(agentId);
    });
  });

  agentsHeader.querySelector('.new-agent-btn')?.addEventListener('click', () => {
    const name = prompt('Enter Agent Display Name:');
    if (name && name.trim()) {
      const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
      state.agents.push({
        id,
        displayName: name.trim(),
        avatar: name.trim().slice(0, 2).toUpperCase(),
        description: 'Custom specialized agent.',
        status: 'active',
        privateMemoryEntriesCount: 0,
        workOptions: [
          { id: `opt-${id}-1`, engine: 'pi', workModel: 'claude-3-5-sonnet', effort: 'high', isConfigured: true },
          { id: `opt-${id}-2`, engine: 'codex', workModel: 'gpt-4o', effort: 'medium', isConfigured: true },
        ],
      });
      stateManager.selectAgent(id);
    }
  });

  container.appendChild(agentsHeader);

  // Section 2: Selected Agent Detail Card
  const selectedAgent = state.agents.find((a) => a.id === state.selectedAgentId) ?? state.agents[0];
  if (!selectedAgent) {
    container.innerHTML += `<div class="card"><p>No agent selected.</p></div>`;
    return container;
  }

  const detailCard = document.createElement('div');
  detailCard.className = 'card';
  detailCard.innerHTML = `
    <div class="card-header">
      <div style="display: flex; align-items: center; gap: 10px;">
        <div style="width: 36px; height: 36px; border-radius: var(--radius-sm); background: var(--purple-agent-bg); border: 1px solid var(--purple-agent-border); color: var(--purple-agent); display: flex; align-items: center; justify-content: center;">
          ${renderIcon('bot', 20)}
        </div>
        <div>
          <h3 style="font-size: 16px; font-weight: 700;">${selectedAgent.displayName} (<code>${selectedAgent.id}</code>)</h3>
          <p style="font-size: 12px; color: var(--text-secondary);">${selectedAgent.description}</p>
        </div>
      </div>
      <span class="status-pill green">Active</span>
    </div>

    <!-- Standing Instructions -->
    <div style="background: var(--bg-surface-elevated); padding: 10px; border-radius: var(--radius-sm); font-size: 12px;">
      <span style="font-weight: 700; color: var(--text-muted); text-transform: uppercase; font-size: 11px;">Standing Instructions:</span>
      <p style="color: var(--text-primary); margin-top: 4px;">${selectedAgent.standingInstructions ?? 'None'}</p>
    </div>

    <!-- Ordered Work Options -->
    <div style="display: flex; flex-direction: column; gap: 8px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 14px; font-weight: 700; color: var(--text-primary);">
          Ordered Execution Preferences (Work Options)
        </span>
        <span style="font-size: 11px; color: var(--text-muted);">Evaluated at run admission</span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 6px;">
        ${selectedAgent.workOptions
          .map(
            (opt, idx) => `
          <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 10px; display: flex; justify-content: space-between; align-items: center; font-size: 13px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="status-pill neutral" style="font-size: 11px; font-weight: 700;">Priority ${idx + 1}</span>
              <strong>${opt.engine.toUpperCase()}</strong>
              <span style="color: var(--text-secondary);">Model: <code>${opt.workModel}</code></span>
              <span class="status-pill purple" style="font-size: 10px;">Effort: ${opt.effort}</span>
            </div>
            <span class="status-pill ${opt.isConfigured ? 'green' : 'neutral'}" style="font-size: 10px;">
              ${opt.isConfigured ? 'Ready' : 'Not configured'}
            </span>
          </div>
        `
          )
          .join('')}
      </div>
    </div>

    <!-- Environment Compatibility Matrix -->
    <div style="display: flex; flex-direction: column; gap: 8px;">
      <span style="font-size: 14px; font-weight: 700; color: var(--text-primary);">
        Environment Compatibility Matrix
      </span>
      <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 10px; font-size: 12px; display: flex; flex-direction: column; gap: 6px;">
        ${state.environments
          .map((env) => {
            const hasCompatibleOption = selectedAgent.workOptions.some((opt) => {
              const readiness = env.engineReadiness[opt.engine];
              return readiness === 'ready';
            });
            return `
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-subtle); padding-bottom: 4px;">
              <span>${env.displayName} (${env.platform})</span>
              <span class="status-pill ${hasCompatibleOption ? 'green' : 'yellow'}" style="font-size: 11px;">
                ${hasCompatibleOption ? 'Compatible (First option available)' : 'Requires Engine Login / Setup'}
              </span>
            </div>
          `;
          })
          .join('')}
      </div>
    </div>

    <!-- Footer Stats -->
    <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--text-muted); border-top: 1px solid var(--border-subtle); padding-top: 8px;">
      <span>Private Memory Entries: ${selectedAgent.privateMemoryEntriesCount}</span>
      <button class="btn btn-secondary btn-sm archive-agent-btn">
        Archive Agent (Preserve Attribution)
      </button>
    </div>
  `;

  detailCard.querySelector('.archive-agent-btn')?.addEventListener('click', () => {
    alert(`Agent "${selectedAgent.displayName}" archived. Historical messages and runs remain attributable.`);
  });

  container.appendChild(detailCard);

  return container;
}
