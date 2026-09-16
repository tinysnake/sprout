import { stateManager, type PrototypeState } from '../state.js';
import type { MessageItem } from '../types.js';

export function renderProjectsView(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'view-container';

  const project = state.projects.find((p) => p.id === state.selectedProjectId) ?? state.projects[0];
  if (!project) {
    container.innerHTML = `<div class="card"><p>No project selected.</p></div>`;
    return container;
  }

  // Project Header & Scope Selector
  const projectHeaderCard = document.createElement('div');
  projectHeaderCard.className = 'card';
  projectHeaderCard.innerHTML = `
    <div class="card-header">
      <div>
        <h2 style="font-size: 17px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
          <span>📁</span> ${project.displayName}
        </h2>
        <p style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
          ${project.templateSource} · ${project.boundEnvironmentWorkspaces.length} bound workspace(s)
        </p>
      </div>
      <span class="status-pill green">Active</span>
    </div>

    <!-- Contract & Wake Policy Details (Collapsible / Summary) -->
    <div style="background: var(--bg-surface-elevated); padding: 10px; border-radius: var(--radius-sm); font-size: 12px; display: flex; flex-direction: column; gap: 6px;">
      <div><strong>Goal:</strong> ${project.goal ?? 'None'}</div>
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
        <div>
          <strong>Wake Policy:</strong> 
          <span class="status-pill purple" style="font-size: 11px;">
            ${project.wakePolicy === 'wake-model-assisted' ? '⚡ Wake-Model Assisted (30s window)' : '🔒 Explicit-only'}
          </span>
        </div>
        <div style="display: flex; gap: 6px;">
          <button class="btn btn-secondary btn-sm toggle-policy-btn">
            Switch to ${project.wakePolicy === 'wake-model-assisted' ? 'Explicit-only' : 'Wake-Model Assisted'}
          </button>
        </div>
      </div>
    </div>

    <!-- Communication Scopes Navigation (Tabs) -->
    <div style="display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px;">
      <button class="btn btn-sm scope-btn ${state.selectedScopeKind === 'project-channel' ? 'btn-primary' : 'btn-secondary'}" data-scope="project-channel">
        #️⃣ Project Channel
      </button>
      ${project.workingGroups
        .map(
          (wg) => `
        <button class="btn btn-sm scope-btn ${state.selectedScopeKind === 'working-group-channel' && state.selectedWorkingGroupId === wg.id ? 'btn-primary' : 'btn-secondary'}" data-scope="working-group-channel" data-id="${wg.id}">
          👥 ${wg.displayName} ${wg.status === 'disbanded' ? '(Read-only)' : ''}
        </button>
      `
        )
        .join('')}
      <button class="btn btn-sm scope-btn ${state.selectedScopeKind === 'direct-message' ? 'btn-primary' : 'btn-secondary'}" data-scope="direct-message" data-id="planner">
        💬 DM: Planner
      </button>
      <button class="btn btn-secondary btn-sm new-wg-btn" style="white-space: nowrap;">
        ➕ New Working Group
      </button>
    </div>
  `;

  // Attach scope toggle listeners
  projectHeaderCard.querySelectorAll('.scope-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement;
      const scopeKind = target.getAttribute('data-scope') as any;
      const id = target.getAttribute('data-id') ?? undefined;
      stateManager.selectScope(scopeKind, id);
    });
  });

  // Attach wake policy toggle listener
  projectHeaderCard.querySelector('.toggle-policy-btn')?.addEventListener('click', () => {
    const nextPolicy = project.wakePolicy === 'wake-model-assisted' ? 'explicit-only' : 'wake-model-assisted';
    stateManager.setProjectWakePolicy(project.id, nextPolicy);
  });

  // Attach new working group button listener
  projectHeaderCard.querySelector('.new-wg-btn')?.addEventListener('click', () => {
    const wgName = prompt('Enter new Working Group name (e.g. "Physics Engine WG"):');
    if (wgName && wgName.trim()) {
      stateManager.createWorkingGroup(project.id, wgName.trim(), ['planner', 'programmer'], 'Specific task focus');
    }
  });

  container.appendChild(projectHeaderCard);

  // Section 2: Conversation Stream & Message List
  const chatCard = document.createElement('div');
  chatCard.className = 'card chat-container';

  let currentScopeLabel = '#️⃣ Project Channel (All Project Members)';
  if (state.selectedScopeKind === 'working-group-channel') {
    const wg = project.workingGroups.find((g) => g.id === state.selectedWorkingGroupId);
    currentScopeLabel = `👥 Working Group: ${wg ? wg.displayName : 'Working Group'} ${wg?.status === 'disbanded' ? '(Disbanded · Read-only)' : ''}`;
  } else if (state.selectedScopeKind === 'direct-message') {
    currentScopeLabel = `💬 Project-Scoped Direct Message with @${state.selectedDirectMessagePeerId ?? 'planner'}`;
  }

  chatCard.innerHTML = `
    <div class="card-header" style="border-bottom: 1px solid var(--border-subtle); padding-bottom: 8px;">
      <span class="card-title" style="font-size: 14px;">${currentScopeLabel}</span>
      <span style="font-size: 11px; color: var(--text-muted);">Persistence-before-wake</span>
    </div>
    <div class="messages-stream" style="display: flex; flex-direction: column; gap: 10px; max-height: 420px; overflow-y: auto;">
    </div>
  `;

  const streamContainer = chatCard.querySelector('.messages-stream')!;

  // Filter messages for current scope
  const filteredMessages = state.messages.filter((m) => {
    if (m.projectId !== project.id) return false;
    if (state.selectedScopeKind === 'project-channel') {
      return m.scope.kind === 'project-channel';
    }
    if (state.selectedScopeKind === 'working-group-channel') {
      return m.scope.kind === 'working-group-channel' && m.scope.workingGroupId === state.selectedWorkingGroupId;
    }
    if (state.selectedScopeKind === 'direct-message') {
      return m.scope.kind === 'direct-message';
    }
    return true;
  });

  if (filteredMessages.length === 0) {
    streamContainer.innerHTML = `<p style="font-size: 13px; color: var(--text-muted); text-align: center; padding: 16px;">No messages in this scope yet.</p>`;
  } else {
    for (const msg of filteredMessages) {
      const msgEl = document.createElement('div');
      msgEl.className = `chat-message ${msg.isProjectedReply ? 'projected-reply' : ''}`;

      let dispositionBadge = '';
      if (msg.disposition === 'addressed') {
        dispositionBadge = `<span class="status-pill purple" style="font-size: 10px;">Deterministic Addressed</span>`;
      } else if (msg.disposition === 'wake-eligible') {
        dispositionBadge = `<span class="status-pill yellow" style="font-size: 10px;">Wake-Eligible (30s batch)</span>`;
      } else if (msg.disposition === 'non-routing') {
        dispositionBadge = `<span class="status-pill neutral" style="font-size: 10px;">Non-Routing (Loop Safe)</span>`;
      }

      msgEl.innerHTML = `
        <div class="msg-header">
          <div class="msg-author">
            <span>${msg.authorAvatar}</span>
            <span>${msg.authorDisplayName}</span>
            ${msg.isProjectedReply ? '<span class="projected-badge">🤖 Projected Reply</span>' : ''}
          </div>
          <div style="display: flex; align-items: center; gap: 6px;">
            ${dispositionBadge}
            <span style="color: var(--text-muted); font-size: 11px;">${msg.timestamp}</span>
          </div>
        </div>
        <div class="msg-body">${msg.content}</div>
        <div style="display: flex; justify-content: flex-end; gap: 6px; margin-top: 4px;">
          ${
            msg.routingCausalChainId
              ? `<button class="btn btn-secondary btn-sm inspect-routing-btn" data-batch="${msg.routingCausalChainId}" style="font-size: 11px; padding: 3px 8px; min-height: 28px;">
                  🔍 Inspect Routing Causal Chain
                </button>`
              : ''
          }
        </div>
      `;

      msgEl.querySelector('.inspect-routing-btn')?.addEventListener('click', (e) => {
        const batchId = (e.currentTarget as HTMLElement).getAttribute('data-batch')!;
        stateManager.openInspector('routing', batchId);
      });

      streamContainer.appendChild(msgEl);
    }
  }

  // Message Composer
  const composer = document.createElement('div');
  composer.className = 'chat-composer';
  composer.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--text-secondary);">
      <span>Quick mentions:</span>
      <div style="display: flex; gap: 4px;">
        <button class="btn btn-secondary btn-sm mention-tag" data-mention="@all" style="padding: 2px 6px; min-height: 24px; font-size: 11px;">@all</button>
        <button class="btn btn-secondary btn-sm mention-tag" data-mention="@Planner" style="padding: 2px 6px; min-height: 24px; font-size: 11px;">@Planner</button>
        <button class="btn btn-secondary btn-sm mention-tag" data-mention="@Programmer" style="padding: 2px 6px; min-height: 24px; font-size: 11px;">@Programmer</button>
        <button class="btn btn-secondary btn-sm mention-tag" data-mention="@Designer" style="padding: 2px 6px; min-height: 24px; font-size: 11px;">@Designer</button>
      </div>
    </div>
    <textarea class="chat-input" placeholder="Type a message or instruction... (Unaddressed will batch under policy)"></textarea>
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <span style="font-size: 11px; color: var(--text-muted);">
        ${
          project.wakePolicy === 'wake-model-assisted'
            ? '⚡ Policy: 30s wake-model collection window'
            : '🔒 Policy: Explicit-only (unaddressed will not wake agents)'
        }
      </span>
      <button class="btn btn-primary send-msg-btn">
        Send Message 🚀
      </button>
    </div>
  `;

  const inputEl = composer.querySelector('.chat-input') as HTMLTextAreaElement;
  composer.querySelectorAll('.mention-tag').forEach((tag) => {
    tag.addEventListener('click', (e) => {
      const mention = (e.currentTarget as HTMLElement).getAttribute('data-mention')!;
      inputEl.value = inputEl.value ? `${inputEl.value} ${mention} ` : `${mention} `;
      inputEl.focus();
    });
  });

  composer.querySelector('.send-msg-btn')?.addEventListener('click', () => {
    const text = inputEl.value.trim();
    if (!text) return;

    let scope: MessageItem['scope'] = { kind: 'project-channel' };
    if (state.selectedScopeKind === 'working-group-channel' && state.selectedWorkingGroupId) {
      scope = { kind: 'working-group-channel', workingGroupId: state.selectedWorkingGroupId };
    } else if (state.selectedScopeKind === 'direct-message') {
      scope = { kind: 'direct-message', recipientId: state.selectedDirectMessagePeerId ?? 'planner' };
    }

    stateManager.sendMessage(project.id, scope, text);
    inputEl.value = '';
  });

  chatCard.appendChild(composer);
  container.appendChild(chatCard);

  return container;
}
