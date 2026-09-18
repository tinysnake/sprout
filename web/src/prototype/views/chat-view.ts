import { renderIcon } from '../icons.js';
import { getWakeRequestDisplayStatus, stateManager, type PrototypeState } from '../state.js';
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
      const restoreEligibility = stateManager.evaluateWorkingGroupEligibility(
        project.id,
        activeWorkingGroup.id,
        'restore'
      );
      readOnlyReason = restoreEligibility.success
        ? 'This Working Group has been disbanded. Conversation history is preserved as read-only.'
        : restoreEligibility.reason ?? 'This Working Group is unavailable for restoration.';
    } else if (activeWorkingGroup) {
      const messageEligibility = stateManager.evaluateWorkingGroupEligibility(
        project.id,
        activeWorkingGroup.id,
        'message'
      );
      if (!messageEligibility.success) {
        isReadOnly = true;
        readOnlyReason = messageEligibility.reason ?? 'This Working Group is unavailable for new collaboration.';
      }
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
    if (agentDef?.status === 'archived') {
      isReadOnly = true;
      readOnlyReason = `Agent @${agentDef.displayName} is archived. History is preserved for review; restore the Agent before sending new messages.`;
    } else if (activeDirectPeer?.status === 'ended') {
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
  chatViewEl.innerHTML = `
    <!-- Left Pane: Categorized Chat Cards List -->
    <aside class="chat-list-pane" role="tablist" aria-label="Conversation Scopes">
      
      <!-- 1. Project Channel Section -->
      <div class="chat-section">
        <div class="chat-section-header">
          <span>Project Channels</span>
        </div>
        <div class="chat-cards-list">
          <div class="chat-scope-card ${isGeneralActive ? 'active' : ''}" data-kind="project-channel" role="tab" tabindex="0" aria-selected="${isGeneralActive}">
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
          <button class="btn btn-ghost btn-sm" id="btn-create-wg" title="${project.status === 'archived' ? 'Archived Project: Working Group history is read-only' : 'Create New Working Group'}" style="font-size: 11px; padding: 2px 6px; height: auto;" ${project.status === 'archived' ? 'disabled' : ''}>
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
                      <div class="chat-scope-card ${isActive ? 'active' : ''} ${isDisbanded ? 'card-disbanded' : ''}" data-kind="working-group-channel" data-id="${w.id}" role="tab" tabindex="0" aria-selected="${isActive}">
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
              const agent = state.agents.find((candidate) => candidate.id === m.memberId);
              const isArchived = agent?.status === 'archived';
              const isEnded = m.status === 'ended' || isArchived;
              return `
                <div class="chat-scope-card ${isActive ? 'active' : ''} ${isEnded ? 'card-ended' : ''}" data-kind="direct-message" data-id="${m.memberId}" role="tab" tabindex="0" aria-selected="${isActive}">
                  <div class="chat-card-avatar-wrap">
                    <div class="chat-card-avatar agent-avatar ${isEnded ? 'avatar-muted' : ''}">
                      ${m.avatar || renderIcon('bot', 16)}
                    </div>
                  </div>
                  <div class="chat-card-main">
                    <div class="chat-card-header-row">
                      <span class="chat-card-title">@${m.displayName}</span>
                      ${isArchived ? `<span class="status-pill neutral" style="font-size: 9px;">Archived</span>` : ''}
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
            ${state.agents.find((agent) => agent.id === activeDirectPeer?.memberId)?.status === 'archived' ? `<span class="status-pill neutral" style="font-size: 10px;">Archived</span>` : activeDirectPeer?.status === 'ended' ? `<span class="status-pill neutral" style="font-size: 10px;">Ended</span>` : ''}
          </div>
          
          <div style="display: flex; align-items: center; gap: 6px;">
            <button class="btn btn-secondary btn-sm chat-info-btn" id="chat-scope-info-btn" title="Conversation Details & Routing Policy" aria-label="Conversation Details & Routing Policy" style="width: 32px; height: 32px; min-height: 32px; padding: 0; display: inline-flex; align-items: center; justify-content: center;">
              ${renderIcon('info', 16)}
            </button>
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
                    ? (() => {
                        const eligibility = stateManager.evaluateWorkingGroupEligibility(
                          project.id,
                          activeWorkingGroup.id,
                          'restore'
                        );
                        return `<button class="btn btn-secondary btn-sm restore-wg-quick-btn" style="font-size: 11px; padding: 2px 8px;" ${eligibility.success ? '' : 'disabled'} title="${eligibility.success ? 'Restore Working Group' : 'Restore unavailable until all retained members are eligible'}">Restore WG</button>`;
                      })()
                    : ''
                }
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

                    const hasMeta =
                      (isProjected && !!msg.projectedReplyMeta) ||
                      !!msg.routingCausalChainId ||
                      msg.disposition === 'addressed';

                    return `
                      <div class="chat-msg ${isMe ? 'msg-me' : 'msg-them'} ${isProjected ? 'msg-projected' : ''}" data-msg-id="${msg.id}">
                        
                        <!-- Author & Timestamp Row -->
                        <div class="msg-author-row" style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 4px; position: relative;">
                          <div style="display: flex; align-items: center; gap: 6px;">
                            <span class="msg-author-name" style="font-weight: 700; font-size: 12px;">${msg.authorDisplayName || msg.authorId}</span>
                          </div>
                          <div class="msg-meta-actions" style="display: flex; align-items: center; gap: 6px; position: relative;">
                            ${
                              hasMeta
                                ? `<button class="btn btn-ghost btn-sm msg-info-trigger-btn msg-projected-info-btn" data-msg-id="${msg.id}" title="${isProjected ? 'Projected Reply Information' : 'Routing & Delivery Evidence'}" aria-label="${isProjected ? 'Projected Reply Information' : 'Routing & Delivery Evidence'}" style="padding: 0; width: 18px; height: 18px; min-height: 18px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-muted); border-radius: 50%; cursor: pointer;">
                                    ${renderIcon('info', 13)}
                                  </button>`
                                : ''
                            }
                            <span class="msg-time" style="font-size: 10px; color: var(--text-muted);">${msg.timestamp}</span>
                          </div>
                        </div>

                        <!-- Message Content -->
                        <div class="msg-text" style="font-size: 13px; line-height: 1.45; word-break: break-word;">
                          ${renderMessageTextWithMentions(msg.content)}
                        </div>
                      </div>
                    `;
                  })
                  .join('')
          }
        </div>

        <!-- Chat Composer Area -->
        <div class="chat-composer-wrap" style="padding: 10px 14px; border-top: 1px solid var(--border-subtle); background: var(--bg-surface-elevated); display: flex; flex-direction: column; gap: 8px;">
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
    const activateScope = () => {
      const target = card as HTMLElement;
      const kind = target.getAttribute('data-kind') as any;
      const id = target.getAttribute('data-id') || undefined;
      stateManager.openChatDetail(kind, id);
    };
    card.addEventListener('click', activateScope);
    card.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key;
      if (key !== 'Enter' && key !== ' ') return;
      event.preventDefault();
      activateScope();
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
      const result = stateManager.restoreWorkingGroup(project.id, activeWorkingGroup.id);
      if (!result.success && result.reason) window.alert(result.reason);
    }
  });

  // Chat Info Modal Opener
  chatViewEl.querySelector('#chat-scope-info-btn')?.addEventListener('click', () => {
    renderChatInfoModal(
      rootContainer,
      state,
      project,
      state.selectedScopeKind,
      state.selectedScopeKind === 'working-group-channel'
        ? state.selectedWorkingGroupId
        : state.selectedScopeKind === 'direct-message'
          ? state.selectedDirectMessagePeerId
          : undefined
    );
  });

  // Message Info popup opener (Agent Projected Reply or Human Routing Evidence)
  chatViewEl.querySelectorAll('.msg-info-trigger-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const msgId = (ev.currentTarget as HTMLElement).getAttribute('data-msg-id');
      const msg = filteredMessages.find((m) => m.id === msgId);
      if (!msg) return;

      const parentMeta = (ev.currentTarget as HTMLElement).closest('.msg-meta-actions');
      if (!parentMeta) return;

      // Close any existing popups first
      chatViewEl.querySelectorAll('.projected-reply-popup').forEach((p) => p.remove());

      const popup = document.createElement('div');
      popup.className = 'projected-reply-popup card';
      popup.style.cssText =
        'position: absolute; right: 0; top: 22px; z-index: 60; width: 280px; max-width: 85vw; padding: 10px 12px; background: var(--bg-surface-elevated); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); font-size: 11px; display: flex; flex-direction: column; gap: 6px;';

      if (msg.isProjectedReply && msg.projectedReplyMeta) {
        popup.innerHTML = `
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px; border-bottom: 1px solid var(--border-subtle); padding-bottom: 5px;">
            <span class="badge badge-purple" style="font-size: 9px; padding: 1px 5px;" title="Non-routing projected reply (ADR-0007 loop prevention)">
              ${renderIcon('check', 10)} Projected Reply · Non-Routing
            </span>
            <button class="btn btn-ghost btn-sm close-projected-popup-btn" aria-label="Close details" style="padding: 0; width: 18px; height: 18px; min-height: 18px; display: flex; align-items: center; justify-content: center; color: var(--text-muted); cursor: pointer;">
              ${renderIcon('close', 10)}
            </button>
          </div>
          <div class="projected-reply-meta-content" style="display: flex; flex-direction: column; gap: 3px; color: var(--text-secondary); line-height: 1.45;">
            <div><strong>Run:</strong> <code>${msg.projectedReplyMeta.runId}</code> · <strong>Wake:</strong> <code>${msg.projectedReplyMeta.wakeRequestId}</code></div>
            <div><strong>Triggered by:</strong> <code>${msg.projectedReplyMeta.triggeringMessageIds.join(', ')}</code></div>
            <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">
              Non-routing boundary: Assistant output projected upon completion cannot trigger downstream wake evaluations.
            </div>
          </div>
        `;
      } else {
        const batch = state.routingBatches.find((b) => b.id === msg.routingCausalChainId);
        popup.innerHTML = `
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px; border-bottom: 1px solid var(--border-subtle); padding-bottom: 5px;">
            <span style="font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 5px;">
              ${renderIcon('lightning', 12)} Routing & Delivery Evidence
            </span>
            <button class="btn btn-ghost btn-sm close-projected-popup-btn" aria-label="Close details" style="padding: 0; width: 18px; height: 18px; min-height: 18px; display: flex; align-items: center; justify-content: center; color: var(--text-muted); cursor: pointer;">
              ${renderIcon('close', 10)}
            </button>
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px; color: var(--text-secondary); line-height: 1.45;">
            ${
              msg.routingCausalChainId
                ? `
                  <div style="display: flex; align-items: center; justify-content: space-between;">
                    <span>Batch: <code>${msg.routingCausalChainId}</code></span>
                    <span class="status-pill ${batch?.status === 'settled' ? 'green' : batch?.status === 'failed-closed' ? 'red' : 'neutral'}" style="font-size: 9px;">${batch?.status ?? msg.disposition}</span>
                  </div>
                  <div style="font-size: 10px; color: var(--text-muted);">
                    Unaddressed input evaluated under wake-model-assisted policy (30s collection window).
                  </div>
                  ${batch?.failureReason ? `<div style="font-size: 10px; color: var(--red-action);">${batch.failureReason}</div>` : ''}
                  <button class="btn btn-secondary btn-sm msg-popup-inspect-btn msg-routing-tag" data-batch="${msg.routingCausalChainId}" style="width: 100%; justify-content: center; gap: 6px; font-size: 11px; margin-top: 2px; cursor: pointer;">
                    ${renderIcon('lightning', 12)} Inspect Causal Routing Chain
                  </button>
                `
                : msg.disposition === 'addressed'
                  ? `
                    <div style="display: flex; align-items: center; gap: 5px; color: var(--green-ready); font-weight: 600;">
                      ${renderIcon('check', 12)} Deterministic Addressing
                    </div>
                    <div style="font-size: 10px; color: var(--text-muted);">
                      ${msg.deterministicRoutingOutcomes?.some((outcome) => outcome.status === 'cancelled')
                        ? 'Deterministic addressing bypassed wake-model judgement, then archived responsibility cancelled admitted work before reply settlement.'
                        : 'Direct DM, exact @mention, or @all broadcast evaluated immediately, bypassing wake policy and collection windows.'}
                    </div>
                    ${
                      msg.deterministicRoutingOutcomes?.length
                        ? `<div class="deterministic-routing-outcomes" style="display: flex; flex-direction: column; gap: 4px; margin-top: 4px;">
                            ${msg.deterministicRoutingOutcomes
                              .map(
                                (outcome) => `<div style="font-size: 10px; color: ${outcome.status === 'admitted' ? 'var(--green-ready)' : 'var(--red-action)'};">
                                  <strong>@${outcome.targetDisplayName ?? outcome.targetAgentId}</strong> · ${outcome.status === 'admitted' ? 'Admitted' : outcome.status === 'cancelled' ? 'Cancelled' : 'Failed closed'}<br />
                                  <span style="color: var(--text-muted);">${outcome.reason}</span>
                                  ${outcome.terminalResponsibility ? `<br /><span style="color: var(--text-muted);">Responsible ${outcome.terminalResponsibility.kind}: <code>${outcome.terminalResponsibility.id}</code></span>` : ''}
                                </div>`
                              )
                              .join('')}
                          </div>`
                        : ''
                    }
                  `
                  : `
                    <div style="font-size: 10px; color: var(--text-muted);">
                      Informational message persisted without wake under explicit-only policy.
                    </div>
                  `
            }
          </div>
        `;

        popup.querySelector('.msg-popup-inspect-btn')?.addEventListener('click', (inspEv) => {
          inspEv.stopPropagation();
          const batchId = (inspEv.currentTarget as HTMLElement).getAttribute('data-batch') || 'batch-002';
          popup.remove();
          renderRoutingInspectorModal(rootContainer, state, batchId);
        });
      }

      popup.querySelector('.close-projected-popup-btn')?.addEventListener('click', (closeEv) => {
        closeEv.stopPropagation();
        popup.remove();
      });

      parentMeta.appendChild(popup);
    });
  });

  // Click outside listener to dismiss popup
  document.addEventListener('click', () => {
    chatViewEl.querySelectorAll('.projected-reply-popup').forEach((p) => p.remove());
  });

  const inputEl = chatViewEl.querySelector('#chat-main-input') as HTMLInputElement;

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

    const result = stateManager.sendMessage(project.id, scope, text);
    if (result.success) inputEl.value = '';
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
                    Working Group Members (${(targetWg.status === 'disbanded' ? targetWg.retainedMemberIds ?? targetWg.memberIds : targetWg.memberIds).length})
                  </span>
                  <span class="status-pill ${targetWg.status === 'active' ? 'green' : 'neutral'}" style="font-size: 9px;">${targetWg.status}</span>
                </div>
                <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
                  ${(targetWg.status === 'disbanded' ? targetWg.retainedMemberIds ?? targetWg.memberIds : targetWg.memberIds)
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
            ${batch.failureReason ? `<div style="font-size: 11px; color: var(--red-action);"><strong>Terminal outcome:</strong> ${batch.failureReason}</div>` : ''}
            ${batch.terminalResponsibility ? `<div style="font-size: 10px; color: var(--text-muted);"><strong>Responsible ${batch.terminalResponsibility.kind}:</strong> <code>${batch.terminalResponsibility.id}</code></div>` : ''}
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
                      .map((w) => {
                        const status = getWakeRequestDisplayStatus(w);
                        const statusClass = status === 'settled' ? 'green' : status === 'failed' || status === 'cancelled' || status === 'failed-closed' ? 'red' : 'yellow';
                        return `
                      <div style="background: var(--bg-surface); padding: 8px 10px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle); font-size: 12px;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                          <strong>WakeRequest: <code>${w.wakeRequestId}</code></strong>
                          <span class="status-pill ${statusClass}" style="font-size: 9px;">${status}</span>
                        </div>
                        <div style="font-size: 11px; color: var(--text-secondary); margin-top: 3px;">
                          Target Agent: <strong>@${w.targetAgentId}</strong> · Linked Run: <code>${w.linkedRunId ?? 'none'}</code> · Projected Reply: <code>${w.projectedReplyId ?? 'none'}</code>
                        </div>
                        <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">
                          ${w.failureReason ?? w.terminalReason ?? 'Loop prevention guarantee: Projected replies are marked non-routing and never trigger new wake evaluations.'}
                        </div>
                        ${w.terminalResponsibility ? `<div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;"><strong>Responsible ${w.terminalResponsibility.kind}:</strong> <code>${w.terminalResponsibility.id}</code></div>` : ''}
                        ${w.terminalTimestamp ? `<div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;"><strong>Terminal at:</strong> <code>${w.terminalTimestamp}</code></div>` : ''}
                      </div>
                    `;
                      })
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
  state: PrototypeState,
  project: ProjectItem
) {
  const modal = document.createElement('div');
  modal.className = 'proto-modal-backdrop';

  const activeAgents = project.memberships.filter(
    (membership) =>
      membership.memberKind === 'agent' &&
      membership.status === 'active' &&
      state.agents.find((agent) => agent.id === membership.memberId)?.status === 'active'
  );
  const hasArchivedAgent = project.memberships.some(
    (membership) =>
      membership.memberKind === 'agent' &&
      state.agents.find((agent) => agent.id === membership.memberId)?.status === 'archived'
  );

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
            ${
              activeAgents.length === 0
                ? `<span style="font-size: 12px; color: var(--text-muted);">No active Agents are available. Archived Agent history remains review-only.</span>`
                : activeAgents
                    .map(
                      (a) => `
              <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer;">
                <input type="checkbox" class="wg-agent-check" value="${a.memberId}" checked />
                <span>@${a.displayName} <span style="color: var(--text-muted); font-size: 11px;">(${a.responsibilities?.slice(0, 35)}...)</span></span>
              </label>
            `
                    )
                    .join('')
            }
          </div>
          ${
            hasArchivedAgent && activeAgents.length > 0
              ? `<span class="wg-archived-note" style="font-size: 11px; color: var(--text-muted);">Archived Agent history remains review-only.</span>`
              : ''
          }
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

    const result = stateManager.createWorkingGroup(project.id, name, selectedAgentIds, goalInput.value.trim() || undefined);
    if (result.success) modal.remove();
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
  const isProjectArchived = project.status === 'archived';
  const displayedMemberIds = isDisbanded ? wg.retainedMemberIds ?? wg.memberIds : wg.memberIds;
  const restoreEligibility = isDisbanded
    ? stateManager.evaluateWorkingGroupEligibility(project.id, wg.id, 'restore')
    : { success: true as const };

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
            ${isDisbanded ? 'Retained Working Group Members' : 'Working Group Members'} (${displayedMemberIds.length})
          </div>
          <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
            ${displayedMemberIds
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
                ? restoreEligibility.success
                  ? 'This working group is currently disbanded. Channel is read-only. Restoring will reactivate the channel for communication.'
                  : restoreEligibility.reason
                : 'Disbanding a working group is non-destructive. The channel becomes read-only and all configuration, memberships, and messages are preserved for audit and possible restore.'
            }
          </div>
          <div style="margin-top: 4px;">
            ${
              isDisbanded
                ? `<button class="btn btn-primary btn-sm btn-restore-wg" style="gap: 6px;" ${restoreEligibility.success ? '' : 'disabled'}>${renderIcon('refresh', 14)} Restore Working Group</button>`
                : `<button class="btn btn-danger btn-sm btn-disband-wg" style="gap: 6px;" ${isProjectArchived ? 'disabled title="Archived Project: restore the Project before changing Working Group history"' : ''}>${renderIcon('archive', 14)} Disband Working Group (Read-Only)</button>`
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
    const result = stateManager.disbandWorkingGroup(project.id, wg.id);
    if (!result.success && result.reason) window.alert(result.reason);
    else modal.remove();
  });

  modal.querySelector('.btn-restore-wg')?.addEventListener('click', () => {
    const result = stateManager.restoreWorkingGroup(project.id, wg.id);
    if (result.success) modal.remove();
    else if (result.reason) window.alert(result.reason);
  });

  parentEl.appendChild(modal);
}
