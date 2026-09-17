import { renderIcon } from '../icons.js';
import { stateManager, type PrototypeState } from '../state.js';
import type { MessageItem, ProjectItem, RoutingBatch, WorkingGroup } from '../types.js';

/**
 * Renders the Project Chat View (Split-Pane on Desktop / Hierarchical on Mobile)
 */
export function renderProjectChat(
  state: PrototypeState,
  project: ProjectItem,
  rootContainer: HTMLElement
): HTMLElement {
  const chatViewEl = document.createElement('div');
  chatViewEl.className = `project-chat-view ${state.chatViewMode === 'detail' ? 'chat-mode-detail' : 'chat-mode-list'}`;

  // Resolve current active scope identity
  let currentScopeTitle = '#general';
  let isReadOnly = project.status === 'archived';
  let readOnlyReason = project.status === 'archived' ? 'Project is archived. All communication is read-only.' : '';
  let activeWorkingGroup: WorkingGroup | undefined = undefined;
  let activeDirectPeer: ProjectItem['memberships'][0] | undefined = undefined;

  let filteredMessages = (state.messages || []).filter((m) => m.projectId === project.id);

  if (state.selectedScopeKind === 'working-group-channel' && state.selectedWorkingGroupId) {
    activeWorkingGroup = project.workingGroups.find((w) => w.id === state.selectedWorkingGroupId);
    currentScopeTitle = activeWorkingGroup?.displayName || state.selectedWorkingGroupId;
    if (activeWorkingGroup?.status === 'disbanded') {
      isReadOnly = true;
      readOnlyReason = 'This Working Group has been disbanded. Conversation history is preserved as read-only.';
    }
    filteredMessages = filteredMessages.filter(
      (m) =>
        m.scope.kind === 'working-group-channel' &&
        m.scope.workingGroupId === state.selectedWorkingGroupId
    );
  } else if (state.selectedScopeKind === 'direct-message' && state.selectedDirectMessagePeerId) {
    activeDirectPeer = project.memberships.find((m) => m.memberId === state.selectedDirectMessagePeerId);
    const agentDef = state.agents.find((a) => a.id === state.selectedDirectMessagePeerId);
    currentScopeTitle = `@${activeDirectPeer?.displayName || agentDef?.displayName || state.selectedDirectMessagePeerId}`;
    if (activeDirectPeer?.status === 'ended') {
      isReadOnly = true;
      readOnlyReason = `Agent membership for @${activeDirectPeer.displayName} has ended in this project. History is preserved; new messages cannot be sent.`;
    }
    filteredMessages = filteredMessages.filter(
      (m) =>
        m.scope.kind === 'direct-message' &&
        (m.scope.recipientId === state.selectedDirectMessagePeerId ||
          m.authorId === state.selectedDirectMessagePeerId)
    );
  } else {
    // Default #general
    filteredMessages = filteredMessages.filter((m) => m.scope.kind === 'project-channel');
  }

  // Simulated unread message counts per scope
  const unreadMap: Record<string, number> = {
    'project-channel': 2,
    'wg-mechanics': 1,
    'wg-audio': 0,
    programmer: 1,
    reviewer: 0,
    designer: 0,
    planner: 1,
    researcher: 0,
  };

  // Helper to find last message for any scope
  const projectMessages = (state.messages || []).filter((m) => m.projectId === project.id);
  const getLastMessage = (kind: string, id?: string) => {
    let msgs: MessageItem[] = [];
    if (kind === 'project-channel') {
      msgs = projectMessages.filter((m) => m.scope.kind === 'project-channel');
    } else if (kind === 'working-group-channel') {
      msgs = projectMessages.filter(
        (m) => m.scope.kind === 'working-group-channel' && m.scope.workingGroupId === id
      );
    } else if (kind === 'direct-message') {
      msgs = projectMessages.filter(
        (m) =>
          m.scope.kind === 'direct-message' &&
          (m.scope.recipientId === id || m.authorId === id)
      );
    }
    return msgs.length > 0 ? msgs[msgs.length - 1] : null;
  };

  const generalLastMsg = getLastMessage('project-channel');
  const isGeneralActive = state.selectedScopeKind === 'project-channel';

  const workingGroups = project.workingGroups || [];
  const agentMembers = project.memberships.filter((m) => m.memberKind === 'agent');

  // Check for active open collection window in this project under wake-model-assisted policy
  const openBatch = state.routingBatches.find(
    (b) => b.projectId === project.id && (b.status === 'open' || b.status === 'evaluating')
  );

  chatViewEl.innerHTML = `
    <!-- Left Pane: Categorized Chat Cards List -->
    <aside class="chat-list-pane" role="tablist" aria-label="Conversation Scopes">
      
      <!-- 1. Project Channel Section -->
      <div class="chat-section">
        <div class="chat-section-header">
          <span>Project Channels</span>
        </div>
        <div class="chat-cards-list">
          <div class="chat-scope-card ${isGeneralActive ? 'active' : ''}" data-kind="project-channel" role="tab" aria-selected="${isGeneralActive}">
            <div class="chat-card-avatar-wrap">
              <div class="chat-card-avatar icon-avatar">
                ${renderIcon('chat', 16)}
              </div>
            </div>
            <div class="chat-card-main">
              <div class="chat-card-header-row">
                <span class="chat-card-title">#general</span>
                <div class="chat-card-meta-right">
                  ${generalLastMsg?.timestamp ? `<span class="chat-card-timestamp">${generalLastMsg.timestamp}</span>` : ''}
                  ${unreadMap['project-channel'] ? `<span class="unread-badge-dot">${unreadMap['project-channel']}</span>` : ''}
                </div>
              </div>
              <div class="chat-card-preview" title="${generalLastMsg?.content || 'No messages yet'}">
                ${generalLastMsg?.content || 'No messages yet in project channel.'}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Divider -->
      <div class="chat-section-divider"></div>

      <!-- 2. Working Groups Section -->
      <div class="chat-section">
        <div class="chat-section-header">
          <span>Working Groups (${workingGroups.length})</span>
          <button class="btn btn-ghost btn-sm" id="btn-create-wg" title="Create New Working Group" style="font-size: 11px; padding: 2px 6px; height: auto;">
            ${renderIcon('plus', 11)} New WG
          </button>
        </div>
        <div class="chat-cards-list">
          ${
            workingGroups.length === 0
              ? `<div style="font-size: 11px; color: var(--text-muted); padding: 6px 8px;">No working groups yet.</div>`
              : workingGroups
                  .map((w) => {
                    const isActive =
                      state.selectedScopeKind === 'working-group-channel' &&
                      state.selectedWorkingGroupId === w.id;
                    const lastMsg = getLastMessage('working-group-channel', w.id);
                    const unreadCount = unreadMap[w.id] || 0;
                    const isDisbanded = w.status === 'disbanded';
                    return `
                      <div class="chat-scope-card ${isActive ? 'active' : ''} ${isDisbanded ? 'card-disbanded' : ''}" data-kind="working-group-channel" data-id="${w.id}" role="tab" aria-selected="${isActive}">
                        <div class="chat-card-avatar-wrap">
                          <div class="chat-card-avatar icon-avatar ${isDisbanded ? 'avatar-muted' : ''}">
                            ${renderIcon('users', 16)}
                          </div>
                        </div>
                        <div class="chat-card-main">
                          <div class="chat-card-header-row">
                            <span class="chat-card-title">${w.displayName}</span>
                            <div class="chat-card-meta-right">
                              ${lastMsg?.timestamp ? `<span class="chat-card-timestamp">${lastMsg.timestamp}</span>` : ''}
                              ${!isDisbanded && unreadCount > 0 ? `<span class="unread-badge-dot">${unreadCount}</span>` : ''}
                            </div>
                          </div>
                          <div class="chat-card-preview" title="${lastMsg?.content || w.goal || 'No messages yet'}">
                            ${lastMsg?.content || w.goal || 'No messages yet in working group.'}
                          </div>
                        </div>
                      </div>
                    `;
                  })
                  .join('')
          }
        </div>
      </div>

      <!-- Divider -->
      <div class="chat-section-divider"></div>

      <!-- 3. Direct Messages Section -->
      <div class="chat-section">
        <div class="chat-section-header">
          <span>Direct Messages (${agentMembers.length})</span>
        </div>
        <div class="chat-cards-list">
          ${agentMembers
            .map((m) => {
              const isActive =
                state.selectedScopeKind === 'direct-message' &&
                state.selectedDirectMessagePeerId === m.memberId;
              const lastMsg = getLastMessage('direct-message', m.memberId);
              const unreadCount = unreadMap[m.memberId] || 0;
              const isEnded = m.status === 'ended';
              return `
                <div class="chat-scope-card ${isActive ? 'active' : ''} ${isEnded ? 'card-ended' : ''}" data-kind="direct-message" data-id="${m.memberId}" role="tab" aria-selected="${isActive}">
                  <div class="chat-card-avatar-wrap">
                    <div class="chat-card-avatar agent-avatar ${isEnded ? 'avatar-muted' : ''}">
                      ${m.avatar || renderIcon('bot', 16)}
                    </div>
                  </div>
                  <div class="chat-card-main">
                    <div class="chat-card-header-row">
                      <span class="chat-card-title">@${m.displayName}</span>
                      <div class="chat-card-meta-right">
                        ${lastMsg?.timestamp ? `<span class="chat-card-timestamp">${lastMsg.timestamp}</span>` : ''}
                        ${!isEnded && unreadCount > 0 ? `<span class="unread-badge-dot">${unreadCount}</span>` : ''}
                      </div>
                    </div>
                    <div class="chat-card-preview" title="${lastMsg?.content || m.responsibilities || 'No messages yet'}">
                      ${lastMsg?.content || m.responsibilities || 'No messages yet with agent.'}
                    </div>
                  </div>
                </div>
              `;
            })
            .join('')}
        </div>
      </div>

    </aside>

    <!-- Right Pane: Active Conversation Detail -->
    <section class="chat-detail-pane">
      <div class="card" style="display: flex; flex-direction: column; min-height: 520px; height: 100%; position: relative;">
        
        <!-- Conversation Header -->
        <div class="card-header" style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
          <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
            <span class="card-title" style="margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${currentScopeTitle}</span>
          </div>
        </div>

        <!-- Read-Only Banner if applicable -->
        ${
          isReadOnly
            ? `<div class="chat-readonly-banner" style="padding: 8px 14px; background: var(--bg-surface-elevated); border-bottom: 1px solid var(--border-subtle); display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--text-secondary);">
                <div style="display: flex; align-items: center; gap: 6px;">
                  ${renderIcon('alert', 14)}
                  <span>${readOnlyReason}</span>
                </div>
                ${
                  activeWorkingGroup && activeWorkingGroup.status === 'disbanded'
                    ? `<button class="btn btn-secondary btn-sm restore-wg-quick-btn" style="font-size: 11px; padding: 2px 8px;">Restore WG</button>`
                    : ''
                }
              </div>`
            : ''
        }

        <!-- Active 30s Collection Window Banner (when collecting unaddressed messages under wake-model-assisted) -->
        ${
          openBatch && state.selectedScopeKind === 'project-channel'
            ? `<div class="chat-batch-window-banner" style="padding: 8px 14px; background: rgba(88, 101, 242, 0.08); border-bottom: 1px solid rgba(88, 101, 242, 0.25); display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                <div style="display: flex; align-items: center; gap: 8px; font-size: 12px;">
                  <span class="status-dot purple" style="animation: pulse 1.5s infinite;"></span>
                  <span><strong>Active 30s Collection Window</strong>: ~${openBatch.countdownRemainingSec ?? 18}s remaining · <code>${openBatch.inputMessageIds.length}</code> unaddressed input queued</span>
                </div>
                <button class="btn btn-secondary btn-sm inspect-open-batch-btn" data-batch="${openBatch.id}" style="font-size: 10px; padding: 2px 6px; height: auto;">
                  Inspect Open Batch →
                </button>
              </div>`
            : ''
        }

        <!-- Chat Timeline Messages Body -->
        <div class="chat-messages-body" style="flex: 1; padding: 14px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; max-height: 440px;">
          ${
            filteredMessages.length === 0
              ? `<div class="chat-empty-state" style="text-align: center; color: var(--text-muted); font-size: 13px; padding: 40px 16px; display: flex; flex-direction: column; align-items: center; gap: 8px;">
                  <div style="width: 44px; height: 44px; border-radius: 50%; background: var(--bg-surface-elevated); display: flex; align-items: center; justify-content: center; color: var(--text-secondary);">
                    ${renderIcon('chat', 20)}
                  </div>
                  <strong>No messages yet in this conversation scope.</strong>
                  <p style="margin: 0; max-width: 320px; font-size: 12px;">Send a message or @mention a project agent below to begin collaboration.</p>
                </div>`
              : filteredMessages
                  .map((msg) => {
                    const isMe = msg.authorKind === 'human';
                    const isProjected = msg.isProjectedReply;
                    const batch = state.routingBatches.find((b) => b.id === msg.routingCausalChainId);

                    return `
                      <div class="chat-msg ${isMe ? 'msg-me' : 'msg-them'} ${isProjected ? 'msg-projected' : ''}" data-msg-id="${msg.id}">
                        
                        <!-- Author & Timestamp Row -->
                        <div class="msg-author-row" style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 4px;">
                          <div style="display: flex; align-items: center; gap: 6px;">
                            <span class="msg-author-name" style="font-weight: 700; font-size: 12px;">${msg.authorDisplayName || msg.authorId}</span>
                            ${
                              isProjected
                                ? `<span class="badge badge-purple" style="font-size: 9px; padding: 1px 5px;" title="Non-routing projected reply (ADR-0007 loop prevention)">
                                    ${renderIcon('check', 10)} Projected Reply · Non-Routing
                                  </span>`
                                : ''
                            }
                          </div>
                          <span class="msg-time" style="font-size: 10px; color: var(--text-muted);">${msg.timestamp}</span>
                        </div>

                        <!-- Message Content -->
                        <div class="msg-text" style="font-size: 13px; line-height: 1.45; word-break: break-word;">
                          ${renderMessageTextWithMentions(msg.content)}
                        </div>

                        <!-- Projected Reply Provenance & Loop Prevention Card -->
                        ${
                          isProjected && msg.projectedReplyMeta
                            ? `<div class="projected-reply-meta-card" style="margin-top: 6px; padding: 6px 8px; background: rgba(88, 101, 242, 0.07); border-radius: var(--radius-xs); border: 1px solid rgba(88, 101, 242, 0.2); font-size: 11px; color: var(--text-secondary); display: flex; flex-direction: column; gap: 2px;">
                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                  <span><strong>Run:</strong> <code>${msg.projectedReplyMeta.runId}</code> · <strong>Wake:</strong> <code>${msg.projectedReplyMeta.wakeRequestId}</code></span>
                                  <span style="font-size: 9px; color: var(--text-muted); font-style: italic;">Non-routing boundary</span>
                                </div>
                                <div>Triggered by Message: <code>${msg.projectedReplyMeta.triggeringMessageIds.join(', ')}</code></div>
                              </div>`
                            : ''
                        }

                        <!-- Causal Routing Tag / Evidence Badge -->
                        ${
                          msg.routingCausalChainId
                            ? `<div class="msg-routing-tag" data-batch="${msg.routingCausalChainId}" style="margin-top: 5px; font-size: 10px; color: var(--text-muted); display: inline-flex; align-items: center; gap: 4px; cursor: pointer; background: var(--bg-surface-elevated); padding: 2px 7px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle); width: fit-content;" title="Click to inspect causal wake routing chain (ADR-0007)">
                                ${renderIcon('lightning', 11)}
                                <span>Batch: <code>${msg.routingCausalChainId}</code> (${batch?.status ?? msg.disposition})</span>
                              </div>`
                            : msg.disposition === 'addressed'
                              ? `<div style="margin-top: 4px; font-size: 10px; color: var(--text-muted); display: inline-flex; align-items: center; gap: 4px;">
                                  ${renderIcon('lightning', 10)}
                                  <span>Deterministic addressing (bypassed model & window)</span>
                                </div>`
                              : ''
                        }
                      </div>
                    `;
                  })
                  .join('')
          }
        </div>

        <!-- Chat Composer Area -->
        <div class="chat-composer-wrap" style="padding: 10px 14px; border-top: 1px solid var(--border-subtle); background: var(--bg-surface-elevated); display: flex; flex-direction: column; gap: 8px;">
          
          <!-- Live Addressing Feedback Pill -->
          <div class="composer-meta-bar" style="display: flex; align-items: center; justify-content: flex-end; min-height: 18px;">
            <div class="addressing-feedback-pill" id="composer-addressing-pill" style="font-size: 10px; color: var(--text-secondary); display: flex; align-items: center; gap: 4px;">
              ${
                state.selectedScopeKind === 'direct-message'
                  ? `<span>⚡ Direct DM: Deterministic wake (bypasses model)</span>`
                  : project.wakePolicy === 'wake-model-assisted'
                    ? `<span>⏳ Unaddressed input enters 30s batch window</span>`
                    : `<span>ℹ️ Explicit-only policy (persisted without waking)</span>`
              }
            </div>
          </div>

          <!-- Input Row -->
          <div class="composer-input-row" style="display: flex; gap: 8px; align-items: center;">
            <input
              type="text"
              class="form-input chat-input-text"
              id="chat-main-input"
              placeholder="${
                isReadOnly
                  ? readOnlyReason
                  : state.selectedScopeKind === 'direct-message'
                    ? `Message @${activeDirectPeer?.displayName || 'agent'} (Deterministic direct wake)...`
                    : state.selectedScopeKind === 'working-group-channel'
                      ? `Message ${activeWorkingGroup?.displayName || 'Working Group'}...`
                      : `Message #general... (Use @agent or @all for immediate wake)`
              }"
              style="flex: 1; min-height: 38px;"
              ${isReadOnly ? 'disabled' : ''}
            />
            <button
              class="btn btn-primary send-msg-btn"
              id="btn-send-chat-msg"
              style="min-height: 38px; gap: 6px;"
              ${isReadOnly ? 'disabled' : ''}
            >
              ${renderIcon('send', 14)} Send
            </button>
          </div>
        </div>

      </div>
    </section>
  `;

  // --- Attach Event Listeners ---

  // Scope Card Click Listeners (Select Scope / Open Detail)
  chatViewEl.querySelectorAll('.chat-scope-card').forEach((card) => {
    card.addEventListener('click', (ev) => {
      const target = ev.currentTarget as HTMLElement;
      const kind = target.getAttribute('data-kind') as any;
      const id = target.getAttribute('data-id') || undefined;
      stateManager.openChatDetail(kind, id);
    });
  });

  // Create Working Group Button
  chatViewEl.querySelector('#btn-create-wg')?.addEventListener('click', () => {
    renderNewWorkingGroupModal(rootContainer, state, project);
  });

  // Manage Working Group Button
  chatViewEl.querySelector('#chat-manage-wg-btn')?.addEventListener('click', () => {
    if (activeWorkingGroup) {
      renderWorkingGroupDetailsModal(rootContainer, state, project, activeWorkingGroup);
    }
  });

  // Restore WG quick button (in banner)
  chatViewEl.querySelector('.restore-wg-quick-btn')?.addEventListener('click', () => {
    if (activeWorkingGroup) {
      stateManager.restoreWorkingGroup(project.id, activeWorkingGroup.id);
    }
  });

  // Open Batch Button in Window Banner
  chatViewEl.querySelector('.inspect-open-batch-btn')?.addEventListener('click', (ev) => {
    const batchId = (ev.currentTarget as HTMLElement).getAttribute('data-batch') || 'batch-005';
    renderRoutingInspectorModal(rootContainer, state, batchId);
  });

  // Message Routing Tag click listener -> Open Inspector Modal
  chatViewEl.querySelectorAll('.msg-routing-tag').forEach((tag) => {
    tag.addEventListener('click', (ev) => {
      const batchId = (ev.currentTarget as HTMLElement).getAttribute('data-batch') || 'batch-002';
      renderRoutingInspectorModal(rootContainer, state, batchId);
    });
  });

  const inputEl = chatViewEl.querySelector('#chat-main-input') as HTMLInputElement;
  const addressingPill = chatViewEl.querySelector('#composer-addressing-pill') as HTMLElement;

  // Live input feedback handler
  const updateAddressingFeedback = (val: string) => {
    if (!addressingPill) return;
    if (state.selectedScopeKind === 'direct-message') {
      addressingPill.innerHTML = `<span>⚡ Direct DM: Deterministic wake (bypasses model)</span>`;
    } else if (val.includes('@all') || val.includes('@')) {
      addressingPill.innerHTML = `<span style="color: var(--green-ready); font-weight: 600;">⚡ Mention detected: Deterministic wake (bypasses batch window)</span>`;
    } else if (project.wakePolicy === 'wake-model-assisted') {
      addressingPill.innerHTML = `<span>⏳ Unaddressed input enters 30s batch window</span>`;
    } else {
      addressingPill.innerHTML = `<span>ℹ️ Explicit-only policy (persisted without waking)</span>`;
    }
  };

  inputEl?.addEventListener('input', () => {
    updateAddressingFeedback(inputEl.value);
  });

  // Send message handler
  const sendBtn = chatViewEl.querySelector('#btn-send-chat-msg') as HTMLButtonElement;
  const handleSend = () => {
    if (!inputEl || !inputEl.value.trim() || isReadOnly) return;
    const text = inputEl.value.trim();

    let scope: MessageItem['scope'] = { kind: 'project-channel' };
    if (state.selectedScopeKind === 'working-group-channel' && state.selectedWorkingGroupId) {
      scope = { kind: 'working-group-channel', workingGroupId: state.selectedWorkingGroupId };
    } else if (state.selectedScopeKind === 'direct-message' && state.selectedDirectMessagePeerId) {
      scope = { kind: 'direct-message', recipientId: state.selectedDirectMessagePeerId };
    }

    stateManager.sendMessage(project.id, scope, text);
    inputEl.value = '';
    updateAddressingFeedback('');
  };

  sendBtn?.addEventListener('click', handleSend);
  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  });

  return chatViewEl;
}

/**
 * Highlights @mentions in message body text safely
 */
function renderMessageTextWithMentions(content: string): string {
  // Escape HTML first
  const escaped = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Match @all, @Programmer, @Designer, @Planner, @Reviewer, @Researcher, etc.
  return escaped.replace(
    /(@[a-zA-Z0-9_-]+)/g,
    `<span class="mention-tag" style="background: rgba(88, 101, 242, 0.15); color: var(--purple-agent); font-weight: 700; padding: 1px 4px; border-radius: var(--radius-xs);">$1</span>`
  );
}

/**
 * Renders the Chat Information Modal with scope details, group/agent links, and routing inspector entry
 */
export function renderChatInfoModal(
  parentEl: HTMLElement,
  state: PrototypeState,
  project: ProjectItem,
  scopeKind: 'project-channel' | 'working-group-channel' | 'direct-message',
  scopeId?: string
) {
  const modal = document.createElement('div');
  modal.className = 'proto-modal-backdrop';

  let title = '#general';
  let typeLabel = 'Project Broadcast';
  let desc = 'Main broadcast and coordination channel for all project agents and human operator.';
  let targetAgent: any = null;
  let targetWg: WorkingGroup | null = null;

  if (scopeKind === 'working-group-channel' && scopeId) {
    targetWg = project.workingGroups.find((w) => w.id === scopeId) || null;
    title = targetWg?.displayName || scopeId;
    typeLabel = targetWg?.status === 'disbanded' ? 'Working Group (Disbanded)' : 'Working Group';
    desc = targetWg?.goal || 'Focused sub-team working group collaboration.';
  } else if (scopeKind === 'direct-message' && scopeId) {
    const member = project.memberships.find((m) => m.memberId === scopeId);
    targetAgent = state.agents.find((a) => a.id === scopeId);
    title = `@${member?.displayName || targetAgent?.displayName || scopeId}`;
    typeLabel = member?.status === 'ended' ? 'Direct Message (Ended)' : 'Direct Message';
    desc = member?.responsibilities || targetAgent?.description || '1-on-1 direct agent collaboration.';
  }

  modal.innerHTML = `
    <div class="proto-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-info-title" style="max-width: 560px;">
      <div class="proto-modal-header">
        <strong id="chat-info-title" style="font-size: 15px; display: flex; align-items: center; gap: 8px;">
          ${renderIcon('info', 16)} Conversation Information
        </strong>
        <button class="btn btn-ghost btn-sm close-modal-btn" aria-label="Close modal">${renderIcon('close', 12)}</button>
      </div>

      <div class="proto-modal-body" style="display: flex; flex-direction: column; gap: 12px;">
        <!-- 1. Scope Identity -->
        <div class="card" style="padding: 10px 12px; margin: 0; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle);">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 15px; font-weight: 700;">${title}</span>
            <span class="status-pill neutral" style="font-size: 10px;">${typeLabel}</span>
          </div>
          <div style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); margin-top: 2px;">
            Project: <code>${project.displayName}</code> (${project.id})
          </div>
          <div style="font-size: 12px; color: var(--text-secondary); margin-top: 6px; line-height: 1.45;">
            ${desc}
          </div>
        </div>

        <!-- 2. Specific Scope Details -->
        ${
          targetWg
            ? `<div class="card" style="padding: 10px 12px; margin: 0; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle);">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <span style="font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">
                    Working Group Members (${targetWg.memberIds.length})
                  </span>
                  <span class="status-pill ${targetWg.status === 'active' ? 'green' : 'neutral'}" style="font-size: 9px;">${targetWg.status}</span>
                </div>
                <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
                  ${targetWg.memberIds
                    .map((id: string) => {
                      const m = project.memberships.find((mb) => mb.memberId === id);
                      return `<strong>${m?.displayName || id}</strong>`;
                    })
                    .join(', ')}
                </div>
                ${
                  targetWg.rules && targetWg.rules.length > 0
                    ? `<div style="margin-top: 6px; font-size: 11px; color: var(--text-secondary);">
                        <strong>Rules:</strong> ${targetWg.rules.join('; ')}
                      </div>`
                    : ''
                }
              </div>`
            : ''
        }

        ${
          targetAgent
            ? `<div class="card" style="padding: 10px 12px; margin: 0; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle);">
                <div style="font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">
                  Agent Work Options & Engine Readiness
                </div>
                <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px; display: flex; flex-direction: column; gap: 4px;">
                  <div><strong>Primary Work Option:</strong> <code>${targetAgent.workOptions[0]?.engine || 'pi'} / ${targetAgent.workOptions[0]?.workModel || 'claude-3-5-sonnet'}</code> (Effort: ${targetAgent.workOptions[0]?.effort || 'default'})</div>
                  <div><strong>Standing Instructions:</strong> <em>"${targetAgent.standingInstructions || 'None configured'}"</em></div>
                </div>
              </div>`
            : ''
        }

        <!-- 3. Wake Routing Policy & Causal Inspector Entry -->
        <div class="card" style="padding: 10px 12px; margin: 0; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle);">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div style="font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">
              Project Wake Policy (ADR-0007)
            </div>
            <span class="status-pill purple" style="font-size: 10px;">
              ${project.wakePolicy === 'wake-model-assisted' ? 'Wake-Model Assisted (30s batch window)' : 'Explicit Mentions Only'}
            </span>
          </div>
          <div style="margin-top: 8px;">
            <button class="btn btn-secondary btn-sm inspect-routing-btn" style="width: 100%; justify-content: center; gap: 6px;">
              ${renderIcon('lightning', 14)} Inspect Causal Wake Routing Chain (ADR-0007)
            </button>
          </div>
        </div>

        <!-- 4. Direct Navigation / Management Actions -->
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          ${
            targetAgent
              ? `<button class="btn btn-primary btn-sm jump-agent-btn" style="flex: 1; justify-content: center; gap: 6px;">
                  ${renderIcon('bot', 14)} Manage Agent (@${targetAgent.displayName})
                </button>`
              : ''
          }
          ${
            targetWg
              ? `<button class="btn btn-secondary btn-sm manage-wg-dialog-btn" style="flex: 1; justify-content: center; gap: 6px;">
                  ${renderIcon('users', 14)} Edit Working Group
                </button>`
              : ''
          }
        </div>
      </div>
    </div>
  `;

  modal.querySelectorAll('.close-modal-btn').forEach((b) => b.addEventListener('click', () => modal.remove()));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  // Inspect Routing modal opener
  modal.querySelector('.inspect-routing-btn')?.addEventListener('click', () => {
    modal.remove();
    renderRoutingInspectorModal(parentEl, state, 'batch-002');
  });

  // Direct Agent Management jumper
  modal.querySelector('.jump-agent-btn')?.addEventListener('click', () => {
    modal.remove();
    stateManager.setPrimaryNav('manage', undefined, 'agents');
    stateManager.selectAgent(targetAgent.id);
  });

  // Edit Working Group
  modal.querySelector('.manage-wg-dialog-btn')?.addEventListener('click', () => {
    modal.remove();
    if (targetWg) {
      renderWorkingGroupDetailsModal(parentEl, state, project, targetWg);
    }
  });

  parentEl.appendChild(modal);
}

/**
 * Renders the Causal Wake Routing Inspector Modal Dialog with complete ADR-0007 evidence
 */
export function renderRoutingInspectorModal(
  parentEl: HTMLElement,
  state: PrototypeState,
  batchId = 'batch-002'
) {
  const modal = document.createElement('div');
  modal.className = 'proto-modal-backdrop';

  // Find or fallback batch
  const defaultFallbackBatch: RoutingBatch = {
    id: 'batch-002',
    projectId: 'proj-minesweeper',
    openedAt: '25m 00s ago',
    closedAt: '24m 30s ago',
    collectionWindowDurationSec: 30,
    inputMessageIds: ['msg-3'],
    status: 'settled',
    attemptsCount: 1,
    wakeModel: 'gpt-4o-mini',
    frozenContextSummary: {
      tokenCount: 1840,
      projectRulesIncluded: true,
      recentMessagesCount: 4,
      tasksSummariesCount: 2,
      truncated: false,
    },
    decisions: [
      {
        messageId: 'msg-3',
        targetAgentId: 'designer',
        status: 'selected',
        rationale:
          'Message discusses sRGB shader lighting aesthetics which maps directly to Designer responsibility slot.',
      },
    ],
    resultingWakeRequestIds: ['wake-02'],
  };

  let currentBatch: RoutingBatch =
    state.routingBatches.find((b) => b.id === batchId) ??
    state.routingBatches[0] ??
    defaultFallbackBatch;

  const renderContent = (batch: RoutingBatch) => {
    const isSettled = batch.status === 'settled';
    const isSuppressed = batch.status === 'suppressed';
    const isFailedClosed = batch.status === 'failed-closed';

    const statusBadgeClass = isSettled ? 'green' : isFailedClosed ? 'red' : isSuppressed ? 'neutral' : 'blue';

    return `
      <div class="proto-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="routing-modal-title" style="max-width: 620px; max-height: 90vh; display: flex; flex-direction: column;">
        <div class="proto-modal-header">
          <div style="display: flex; align-items: center; gap: 8px;">
            ${renderIcon('lightning', 18)}
            <div>
              <strong id="routing-modal-title" style="font-size: 15px;">Causal Wake Routing Inspector</strong>
              <div style="font-size: 11px; color: var(--text-muted);">ADR-0007 Durable Causal Evidence & Privacy Boundaries</div>
            </div>
          </div>
          <button class="btn btn-ghost btn-sm close-modal-btn" aria-label="Close modal">${renderIcon('close', 12)}</button>
        </div>

        <div class="proto-modal-body" style="display: flex; flex-direction: column; gap: 12px; overflow-y: auto; padding-right: 6px;">
          
          <!-- Batch Switcher Dropdown -->
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; background: var(--bg-surface-elevated); padding: 8px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);">
            <label for="inspector-batch-select" style="font-size: 12px; font-weight: 700; color: var(--text-secondary);">Select Batch:</label>
            <select id="inspector-batch-select" class="form-input" style="font-size: 12px; min-height: 32px; padding: 2px 8px; width: auto; max-width: 320px;">
              ${state.routingBatches
                .map(
                  (b) => `
                <option value="${b.id}" ${b.id === batch.id ? 'selected' : ''}>
                  Batch: ${b.id} (${b.status} · ${b.wakeModel})
                </option>
              `
                )
                .join('')}
            </select>
          </div>

          <!-- 1. Batch Execution Summary & Policy -->
          <div class="card" style="padding: 10px 12px; margin: 0; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 6px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="font-weight: 700; font-size: 13px;">Batch ID: <code>${batch.id}</code></span>
              <span class="status-pill ${statusBadgeClass}" style="font-size: 10px;">${batch.status}</span>
            </div>
            <div style="font-size: 11px; color: var(--text-secondary);">
              <strong>Collection Window:</strong> ${batch.openedAt} → ${batch.closedAt} (${batch.collectionWindowDurationSec ?? 30}s fixed window)
            </div>
            <div style="font-size: 11px; color: var(--text-secondary);">
              <strong>Wake Model:</strong> <code>${batch.wakeModel}</code> · <strong>Attempts:</strong> ${batch.attemptsCount} of 2
            </div>
            <div style="font-size: 11px; color: var(--text-secondary);">
              <strong>Inputs in Batch:</strong> ${batch.inputMessageIds.map((id) => `<code>${id}</code>`).join(', ')}
            </div>
          </div>

          <!-- 2. Bounded Context Manifest & Strict Privacy Guarantees (ADR-0007) -->
          <div class="card" style="padding: 10px 12px; margin: 0; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle);">
            <div style="font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">
              Frozen Context Bounds & Privacy Guarantee
            </div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px; line-height: 1.45;">
              Context Tokens: <strong>${batch.frozenContextSummary.tokenCount}</strong> · Project Rules: <strong>${batch.frozenContextSummary.projectRulesIncluded ? 'Included' : 'Excluded'}</strong> · Recent Messages: <strong>${batch.frozenContextSummary.recentMessagesCount}</strong> · Task Summaries: <strong>${batch.frozenContextSummary.tasksSummariesCount}</strong> · Truncated: <strong>${batch.frozenContextSummary.truncated ? 'Yes (Bounded Excerpt)' : 'No'}</strong>
            </div>

            <!-- Privacy Checklist -->
            <div style="margin-top: 8px; padding: 8px; background: var(--bg-surface); border-radius: var(--radius-xs); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--text-secondary);">
              <div style="font-weight: 700; color: var(--text-primary); margin-bottom: 2px;">Strict ADR-0007 Exclusions:</div>
              <div>• Direct Messages & DMs: <strong>Strictly Excluded</strong></div>
              <div>• Agent Private Memory & Scratchpads: <strong>Strictly Excluded</strong></div>
              <div>• Engine Sessions & Raw Tool Transcripts: <strong>Strictly Excluded</strong></div>
              <div>• Network Credentials & Host Paths: <strong>Strictly Excluded</strong></div>
              <div>• Transient Environment Capacity: <strong>Strictly Excluded</strong> (No silent agent substitution)</div>
            </div>
          </div>

          <!-- 3. Attempt History & Fail-Closed Logic (if attempts > 1 or failed) -->
          ${
            batch.attemptsHistory && batch.attemptsHistory.length > 0
              ? `<div class="card" style="padding: 10px 12px; margin: 0; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle);">
                  <div style="font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">
                    Attempt History & Automatic Retry (${batch.attemptsHistory.length} attempts)
                  </div>
                  <div style="display: flex; flex-direction: column; gap: 6px; margin-top: 6px;">
                    ${batch.attemptsHistory
                      .map(
                        (att) => `
                      <div style="background: var(--bg-surface); padding: 6px 8px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle); font-size: 11px; display: flex; justify-content: space-between; align-items: center;">
                        <div>
                          <strong>Attempt #${att.attemptNumber}</strong> (${att.wakeModel}) · <em>${att.durationMs}ms</em>
                          ${att.errorDetail ? `<div style="color: var(--red-action); font-size: 10px; margin-top: 2px;">${att.errorDetail}</div>` : ''}
                        </div>
                        <span class="status-pill ${att.status === 'success' ? 'green' : 'red'}" style="font-size: 9px;">${att.status}</span>
                      </div>
                    `
                      )
                      .join('')}
                  </div>
                  ${
                    isFailedClosed
                      ? `<div style="margin-top: 6px; font-size: 11px; color: var(--red-action); background: var(--red-action-bg); padding: 6px 8px; border-radius: var(--radius-xs);">
                          <strong>Fail-Closed Outcome:</strong> Second attempt failed validation. Under ADR-0007, Sprout fails closed: zero agents woken, original input preserved with visible failure status, preventing uncontrolled fan-out.
                        </div>`
                      : ''
                  }
                </div>`
              : ''
          }

          <!-- 4. Causal Decisions & Model Rationale -->
          <div class="card" style="padding: 10px 12px; margin: 0; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle);">
            <div style="font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">
              Wake Decisions & Causal Rationale (${batch.decisions.length})
            </div>
            ${
              batch.decisions.length === 0
                ? `<div style="font-size: 12px; color: var(--text-muted); margin-top: 6px; font-style: italic;">
                    Collection window active; wake model evaluation begins when window closes.
                  </div>`
                : `<div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
                    ${batch.decisions
                      .map(
                        (d) => `
                      <div style="background: var(--bg-surface); padding: 8px 10px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle); border-left: 3px solid ${d.status === 'selected' ? 'var(--purple-agent)' : d.status === 'suppressed' ? 'var(--yellow-attention)' : 'var(--red-action)'};">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                          <span style="font-size: 12px; font-weight: 700;">Target Agent: <code>@${d.targetAgentId ?? 'none'}</code></span>
                          <span class="status-pill ${d.status === 'selected' ? 'green' : d.status === 'suppressed' ? 'neutral' : 'red'}" style="font-size: 10px;">${d.status}</span>
                        </div>
                        <div style="font-size: 12px; color: var(--text-primary); margin-top: 4px; line-height: 1.4;">
                          "${d.rationale}"
                        </div>
                        <div style="font-size: 10px; color: var(--text-muted); margin-top: 3px; display: flex; justify-content: space-between;">
                          <span>Input: <code>${d.messageId}</code></span>
                          <span style="font-style: italic;">[Model Judgement, Not Fact]</span>
                        </div>
                      </div>
                    `
                      )
                      .join('')}
                  </div>`
            }
          </div>

          <!-- 5. Resulting WakeRequests & Admission Outcomes -->
          ${
            batch.resultingWakeRequests && batch.resultingWakeRequests.length > 0
              ? `<div class="card" style="padding: 10px 12px; margin: 0; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle);">
                  <div style="font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">
                    Resulting WakeRequests & Run Admission
                  </div>
                  <div style="display: flex; flex-direction: column; gap: 6px; margin-top: 6px;">
                    ${batch.resultingWakeRequests
                      .map(
                        (w) => `
                      <div style="background: var(--bg-surface); padding: 8px 10px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle); font-size: 12px;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                          <strong>WakeRequest: <code>${w.wakeRequestId}</code></strong>
                          <span class="status-pill ${w.admissionStatus === 'admitted' ? 'green' : 'yellow'}" style="font-size: 9px;">${w.admissionStatus}</span>
                        </div>
                        <div style="font-size: 11px; color: var(--text-secondary); margin-top: 3px;">
                          Target Agent: <strong>@${w.targetAgentId}</strong> · Linked Run: <code>${w.linkedRunId ?? 'none'}</code> · Projected Reply: <code>${w.projectedReplyId ?? 'none'}</code>
                        </div>
                        <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">
                          Loop prevention guarantee: Projected replies are marked non-routing and never trigger new wake evaluations.
                        </div>
                      </div>
                    `
                      )
                      .join('')}
                  </div>
                </div>`
              : ''
          }

          <!-- 6. Observational Footnote (No Manual Route-Now Buttons by Design) -->
          <div style="font-size: 10px; color: var(--text-muted); text-align: center; padding: 4px 0;">
            Observational causal evidence under ADR-0007. By design, there are no manual "Route now" or "Retry routing" buttons.
          </div>

        </div>
      </div>
    `;
  };

  modal.innerHTML = renderContent(currentBatch);

  // Wire close buttons
  const wireListeners = () => {
    modal.querySelectorAll('.close-modal-btn').forEach((b) => b.addEventListener('click', () => modal.remove()));
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    const selectEl = modal.querySelector('#inspector-batch-select') as HTMLSelectElement;
    selectEl?.addEventListener('change', (ev) => {
      const selectedId = (ev.target as HTMLSelectElement).value;
      const b = state.routingBatches.find((x) => x.id === selectedId);
      if (b) {
        currentBatch = b;
        modal.innerHTML = renderContent(currentBatch);
        wireListeners();
      }
    });
  };

  wireListeners();
  parentEl.appendChild(modal);
}

/**
 * Renders the modal to create a new Working Group
 */
export function renderNewWorkingGroupModal(
  parentEl: HTMLElement,
  _state: PrototypeState,
  project: ProjectItem
) {
  const modal = document.createElement('div');
  modal.className = 'proto-modal-backdrop';

  const activeAgents = project.memberships.filter((m) => m.memberKind === 'agent' && m.status === 'active');

  modal.innerHTML = `
    <div class="proto-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="create-wg-title" style="max-width: 500px;">
      <div class="proto-modal-header">
        <strong id="create-wg-title" style="font-size: 15px; display: flex; align-items: center; gap: 8px;">
          ${renderIcon('users', 16)} Create Working Group
        </strong>
        <button class="btn btn-ghost btn-sm close-modal-btn" aria-label="Close modal">${renderIcon('close', 12)}</button>
      </div>

      <div class="proto-modal-body" style="display: flex; flex-direction: column; gap: 12px;">
        <div style="font-size: 12px; color: var(--text-secondary);">
          Working groups create a focused collaboration channel within this project. You (the Human Operator) will automatically be included as the creator and initial member.
        </div>

        <div style="display: flex; flex-direction: column; gap: 4px;">
          <label for="wg-name-input" style="font-size: 12px; font-weight: 700;">Working Group Name *</label>
          <input type="text" id="wg-name-input" class="form-input" placeholder="e.g. Shaders & Visual FX WG" required />
        </div>

        <div style="display: flex; flex-direction: column; gap: 4px;">
          <label for="wg-goal-input" style="font-size: 12px; font-weight: 700;">Working Group Goal (Optional)</label>
          <input type="text" id="wg-goal-input" class="form-input" placeholder="e.g. Optimize GPU fragment shader performance on mobile devices" />
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-size: 12px; font-weight: 700;">Initial Agent Members:</label>
          <div style="display: flex; flex-direction: column; gap: 4px; max-height: 140px; overflow-y: auto; background: var(--bg-surface); padding: 8px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle);">
            ${activeAgents
              .map(
                (a) => `
              <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer;">
                <input type="checkbox" class="wg-agent-check" value="${a.memberId}" checked />
                <span>@${a.displayName} <span style="color: var(--text-muted); font-size: 11px;">(${a.responsibilities?.slice(0, 35)}...)</span></span>
              </label>
            `
              )
              .join('')}
          </div>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px;">
          <button class="btn btn-secondary btn-sm close-modal-btn">Cancel</button>
          <button class="btn btn-primary btn-sm" id="btn-submit-create-wg">
            ${renderIcon('plus', 14)} Create Working Group
          </button>
        </div>
      </div>
    </div>
  `;

  modal.querySelectorAll('.close-modal-btn').forEach((b) => b.addEventListener('click', () => modal.remove()));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  const submitBtn = modal.querySelector('#btn-submit-create-wg') as HTMLButtonElement;
  const nameInput = modal.querySelector('#wg-name-input') as HTMLInputElement;
  const goalInput = modal.querySelector('#wg-goal-input') as HTMLInputElement;

  submitBtn?.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }

    const selectedAgentIds: string[] = [];
    modal.querySelectorAll('.wg-agent-check:checked').forEach((chk) => {
      selectedAgentIds.push((chk as HTMLInputElement).value);
    });

    stateManager.createWorkingGroup(project.id, name, selectedAgentIds, goalInput.value.trim() || undefined);
    modal.remove();
  });

  parentEl.appendChild(modal);
}

/**
 * Renders the modal to inspect/edit/disband/restore an existing Working Group
 */
export function renderWorkingGroupDetailsModal(
  parentEl: HTMLElement,
  _state: PrototypeState,
  project: ProjectItem,
  wg: WorkingGroup
) {
  const modal = document.createElement('div');
  modal.className = 'proto-modal-backdrop';

  const isDisbanded = wg.status === 'disbanded';

  modal.innerHTML = `
    <div class="proto-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="manage-wg-title" style="max-width: 520px;">
      <div class="proto-modal-header">
        <strong id="manage-wg-title" style="font-size: 15px; display: flex; align-items: center; gap: 8px;">
          ${renderIcon('users', 16)} Manage Working Group
        </strong>
        <button class="btn btn-ghost btn-sm close-modal-btn" aria-label="Close modal">${renderIcon('close', 12)}</button>
      </div>

      <div class="proto-modal-body" style="display: flex; flex-direction: column; gap: 12px;">
        <div class="card" style="padding: 10px 12px; margin: 0; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle);">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 14px; font-weight: 700;">${wg.displayName}</span>
            <span class="status-pill ${isDisbanded ? 'neutral' : 'green'}" style="font-size: 10px;">${wg.status}</span>
          </div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">
            Created ${wg.createdAt} by <code>${wg.creatorId}</code>
          </div>
          <div style="font-size: 12px; color: var(--text-secondary); margin-top: 6px;">
            <strong>Goal:</strong> ${wg.goal || 'No explicit goal set.'}
          </div>
        </div>

        <div class="card" style="padding: 10px 12px; margin: 0; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle);">
          <div style="font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">
            Working Group Members (${wg.memberIds.length})
          </div>
          <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
            ${wg.memberIds
              .map((id) => {
                const m = project.memberships.find((mb) => mb.memberId === id);
                return `<strong>${m?.displayName || id}</strong>`;
              })
              .join(', ')}
          </div>
        </div>

        <!-- Disband / Restore Action Card -->
        <div class="card" style="padding: 10px 12px; margin: 0; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 6px;">
          <div style="font-size: 12px; font-weight: 700;">Working Group Lifecycle (ADR-0008)</div>
          <div style="font-size: 11px; color: var(--text-secondary);">
            ${
              isDisbanded
                ? 'This working group is currently disbanded. Channel is read-only. Restoring will reactivate the channel for communication.'
                : 'Disbanding a working group is non-destructive. The channel becomes read-only and all configuration, memberships, and messages are preserved for audit and possible restore.'
            }
          </div>
          <div style="margin-top: 4px;">
            ${
              isDisbanded
                ? `<button class="btn btn-primary btn-sm btn-restore-wg" style="gap: 6px;">${renderIcon('refresh', 14)} Restore Working Group</button>`
                : `<button class="btn btn-danger btn-sm btn-disband-wg" style="gap: 6px;">${renderIcon('archive', 14)} Disband Working Group (Read-Only)</button>`
            }
          </div>
        </div>
      </div>
    </div>
  `;

  modal.querySelectorAll('.close-modal-btn').forEach((b) => b.addEventListener('click', () => modal.remove()));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  modal.querySelector('.btn-disband-wg')?.addEventListener('click', () => {
    stateManager.disbandWorkingGroup(project.id, wg.id);
    modal.remove();
  });

  modal.querySelector('.btn-restore-wg')?.addEventListener('click', () => {
    stateManager.restoreWorkingGroup(project.id, wg.id);
    modal.remove();
  });

  parentEl.appendChild(modal);
}
