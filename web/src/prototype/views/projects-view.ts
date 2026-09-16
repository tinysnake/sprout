import { renderIcon } from '../icons.js';
import { stateManager, type PrototypeState } from '../state.js';
import { renderTasksView } from './tasks-view.js';

export function renderProjectsView(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'projects-view';

  const project =
    state.projects.find((p) => p.id === state.selectedProjectId) ?? state.projects[0];
  if (!project) {
    container.innerHTML = `<div class="card"><p>No project selected.</p></div>`;
    return container;
  }

  // Top Project Selector Header
  const projectNav = document.createElement('header');
  projectNav.className = 'project-nav-bar';
  projectNav.innerHTML = `
    <div class="project-selector-row">
      <div class="project-select-wrapper">
        ${renderIcon('folder', 16)}
        <select class="project-dropdown-select" id="project-selector" aria-label="Select Project">
          ${state.projects
            .map(
              (p) => `
            <option value="${p.id}" ${p.id === project.id ? 'selected' : ''}>
              ${p.displayName} (${p.status})
            </option>
          `
            )
            .join('')}
        </select>
      </div>
      <span class="status-pill green">${project.status}</span>
    </div>
  `;

  projectNav.querySelector('#project-selector')?.addEventListener('change', (ev) => {
    const selectedId = (ev.target as HTMLSelectElement).value;
    stateManager.selectProject(selectedId);
  });

  container.appendChild(projectNav);

  // Content Area according to projectTab
  const contentEl = document.createElement('div');
  contentEl.className = 'project-content-area';

  if (state.projectTab === 'tasks') {
    contentEl.appendChild(renderTasksView(state));
  } else if (state.projectTab === 'chat') {
    contentEl.appendChild(renderProjectChat(state, project));
  } else {
    contentEl.appendChild(renderProjectOverview(state, project));
  }

  container.appendChild(contentEl);

  return container;
}

function renderProjectOverview(_state: PrototypeState, project: any): HTMLElement {
  const overviewEl = document.createElement('div');
  overviewEl.className = 'project-overview-container';

  overviewEl.innerHTML = `
    <!-- Project Contract Card -->
    <div class="card">
      <div class="card-header">
        <div>
          <span class="card-title">Project Contract & Purpose</span>
          <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
            Derived from template: <code>${project.templateSource}</code>
          </div>
        </div>
        <span class="status-pill green">Active</span>
      </div>
      <div class="card-body" style="display: flex; flex-direction: column; gap: 10px;">
        <div>
          <div style="font-size: 11px; color: var(--text-muted); font-weight: 600;">GOAL</div>
          <div style="font-size: 13px; font-weight: 500; margin-top: 2px;">${project.goal ?? 'Ship reliable multi-agent implementation'}</div>
        </div>

        <div>
          <div style="font-size: 11px; color: var(--text-muted); font-weight: 600;">PROJECT RULES</div>
          <ul style="margin-left: 18px; margin-top: 4px; font-size: 12px; color: var(--text-secondary); display: flex; flex-direction: column; gap: 2px;">
            ${(project.rules ?? ['Preserve modular seams', 'Verify cross-platform compatibility'])
              .map((r: string) => `<li>${r}</li>`)
              .join('')}
          </ul>
        </div>

        <div style="padding-top: 8px; border-top: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
          <div>
            <div style="font-size: 11px; color: var(--text-muted); font-weight: 600;">WAKE ROUTING POLICY</div>
            <div style="font-size: 12px; margin-top: 2px;">
              <span class="status-pill purple" style="font-size: 11px;">
                ${project.wakePolicy === 'wake-model-assisted' ? 'Wake-Model Assisted (30s batch window)' : 'Explicit Mentions Only'}
              </span>
            </div>
          </div>
          <button class="btn btn-secondary btn-sm toggle-policy-btn">
            Switch to ${project.wakePolicy === 'wake-model-assisted' ? 'Explicit-only' : 'Wake-Model Assisted'}
          </button>
        </div>
      </div>
    </div>

    <!-- Bound Workspaces & Environments -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">Bound Workspaces & Host Environments</span>
        <span class="badge badge-info">${project.boundEnvironmentWorkspaces.length} Bound</span>
      </div>
      <div class="card-body" style="display: flex; flex-direction: column; gap: 8px;">
        ${project.boundEnvironmentWorkspaces
          .map(
            (ws: any) => `
          <div style="background: var(--bg-surface-elevated); padding: 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
            <div>
              <div style="font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 6px;">
                ${renderIcon('server', 14)}
                <span>${ws.environmentId}</span>
              </div>
              <div style="font-size: 11px; color: var(--text-secondary); font-family: var(--font-mono); margin-top: 2px;">
                ${ws.workspaceRoot}/${ws.relativeWorkspacePath}
              </div>
            </div>
            <span class="status-pill ${ws.isPrepared ? 'green' : 'yellow'}">
              ${ws.isPrepared ? 'Prepared' : 'Pending Preparation'}
            </span>
          </div>
        `
          )
          .join('')}
      </div>
    </div>

    <!-- Project Memberships -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">Project Memberships</span>
        <span class="badge badge-purple">${project.memberships.length} Members</span>
      </div>
      <div class="list-group">
        ${project.memberships
          .map(
            (m: any) => `
          <div class="list-item">
            <div class="list-item-leading">
              <div style="width: 32px; height: 32px; border-radius: var(--radius-sm); background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); display: flex; align-items: center; justify-content: center;">
                ${m.memberKind === 'human' ? renderIcon('user', 16) : renderIcon('bot', 16)}
              </div>
            </div>
            <div class="list-item-body">
              <div class="list-item-title">${m.displayName} <span style="font-size: 11px; color: var(--text-muted);">(${m.memberKind})</span></div>
              <div class="list-item-subtitle">${m.responsibilities ?? 'General collaboration'}</div>
            </div>
            <div class="list-item-trailing">
              <span class="status-pill ${m.status === 'active' ? 'green' : 'gray'}">${m.status}</span>
            </div>
          </div>
        `
          )
          .join('')}
      </div>
    </div>
  `;

  overviewEl.querySelector('.toggle-policy-btn')?.addEventListener('click', () => {
    const nextPolicy = project.wakePolicy === 'wake-model-assisted' ? 'explicit-only' : 'wake-model-assisted';
    stateManager.setProjectWakePolicy(project.id, nextPolicy);
  });

  return overviewEl;
}

function renderProjectChat(state: PrototypeState, project: any): HTMLElement {
  const chatEl = document.createElement('div');
  chatEl.className = 'project-chat-container';

  const projectMessages = (state.messages || []).filter((m) => m.projectId === project.id);

  chatEl.innerHTML = `
    <div class="card" style="display: flex; flex-direction: column; min-height: 480px;">
      <div class="card-header">
        <div>
          <span class="card-title">Project Discussion & Channel Timeline</span>
          <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
            Channel: <code>#general</code> · Scope: <code>${project.id}</code>
          </div>
        </div>
        <button class="btn btn-secondary btn-sm open-inspector-btn" title="Inspect Causal Chain">
          ${renderIcon('lightning', 14)} Inspect Routing
        </button>
      </div>

      <!-- Chat Timeline Messages -->
      <div class="chat-messages-body" style="flex: 1; padding: 14px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; max-height: 380px;">
        ${projectMessages
          .map(
            (msg) => `
          <div class="chat-msg ${msg.authorKind === 'human' ? 'msg-me' : 'msg-them'}">
            <div class="msg-author-row" style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 3px;">
              <div style="display: flex; align-items: center; gap: 6px;">
                <span style="font-weight: 700; font-size: 12px;">${msg.authorDisplayName ?? msg.authorId}</span>
                <span class="status-pill neutral" style="font-size: 9px; padding: 1px 5px;">${msg.authorKind}</span>
                ${
                  msg.isProjectedReply
                    ? `<span class="badge badge-purple" style="font-size: 9px; padding: 1px 5px;">Projected Reply</span>`
                    : ''
                }
              </div>
              <span style="font-size: 10px; color: var(--text-muted);">${msg.timestamp}</span>
            </div>
            <div class="msg-text" style="font-size: 13px; line-height: 1.45;">${msg.content}</div>
          </div>
        `
          )
          .join('')}
      </div>

      <!-- Chat Input Composer -->
      <div class="chat-composer" style="padding: 10px 14px; border-top: 1px solid var(--border-subtle); background: var(--bg-surface-elevated); display: flex; gap: 8px; align-items: center;">
        <select class="form-select chat-scope-select" style="font-size: 12px; width: 110px; min-height: 36px;">
          <option value="project">Project #general</option>
          <option value="dm-programmer">DM @programmer</option>
          <option value="dm-reviewer">DM @reviewer</option>
        </select>
        <input type="text" class="form-input chat-input-text" placeholder="Send project message or @agent mention..." style="flex: 1; min-height: 36px;" />
        <button class="btn btn-primary send-msg-btn" style="min-height: 36px;">
          Send
        </button>
      </div>
    </div>
  `;

  chatEl.querySelector('.open-inspector-btn')?.addEventListener('click', () => {
    stateManager.openInspector('routing', 'batch-001');
  });

  const textInput = chatEl.querySelector('.chat-input-text') as HTMLInputElement;
  const scopeSelect = chatEl.querySelector('.chat-scope-select') as HTMLSelectElement;
  const sendBtn = chatEl.querySelector('.send-msg-btn') as HTMLButtonElement;

  const handleSend = () => {
    if (!textInput || !textInput.value.trim()) return;
    const text = textInput.value.trim();
    let scope: any = { kind: 'project-channel', channel: 'general' };

    if (scopeSelect.value === 'dm-programmer') {
      scope = { kind: 'direct-message', recipientId: 'programmer' };
    } else if (scopeSelect.value === 'dm-reviewer') {
      scope = { kind: 'direct-message', recipientId: 'reviewer' };
    }

    stateManager.sendMessage(project.id, scope, text);
    textInput.value = '';
  };

  sendBtn?.addEventListener('click', handleSend);
  textInput?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') handleSend();
  });

  return chatEl;
}
