import { renderIcon } from "../icons.js";
import { stateManager, type PrototypeState } from '../state.js';

/**
 * Variant A: "Command & Operations Feed" (Stream & Intervention Centric)
 *
 * Mental Model: A unified operational stream where Attention items, Project messages,
 * Task progress events, and Health alerts flow together chronologically.
 * Pinned high-priority intervention cards at top; quick modal command bar at bottom.
 */
export function renderVariantA(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'view-container variant-a-container';

  // Variant A Header Banner
  const headerCard = document.createElement('div');
  headerCard.className = 'card';
  headerCard.style.borderLeft = '4px solid #38bdf8';
  headerCard.innerHTML = `
    <div class="card-header">
      <div>
        <h2 style="font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px;">${renderIcon("lightning", 18)} Unified Operations & Intervention Stream</h2>
        <p style="font-size: 12px; color: var(--text-secondary);">
          Variant A: Feed-first architecture. Attention items, active tasks, messages, and telemetry in a single stream.
        </p>
      </div>
      <span class="status-pill purple" style="font-size: 11px;">Feed Architecture</span>
    </div>
    <!-- Quick Status Bar -->
    <div style="display: flex; gap: 8px; flex-wrap: wrap; background: var(--bg-surface-elevated); padding: 8px 12px; border-radius: var(--radius-sm); font-size: 12px;">
      <span><strong>${state.attentionItems.length}</strong> Attention</span>
      <span>•</span>
      <span><strong>${state.tasks.filter((t) => t.lifecycle === "active").length}</strong> Active Task</span>
      <span>•</span>
      <span><strong>${state.environments.filter((e) => e.trafficLight === "green").length}/${state.environments.length}</strong> Envs Ready</span>
      <span>•</span>
      <span><strong>$0.38</strong> Observed Today</span>
    </div>
  `;
  container.appendChild(headerCard);

  // Section 1: Pinned Attention Bar (If actions required)
  if (state.attentionItems.length > 0) {
    const pinnedSection = document.createElement('div');
    pinnedSection.style.display = 'flex';
    pinnedSection.style.flexDirection = 'column';
    pinnedSection.style.gap = '8px';

    const pinnedTitle = document.createElement('div');
    pinnedTitle.style.fontSize = '13px';
    pinnedTitle.style.fontWeight = '700';
    pinnedTitle.style.color = 'var(--red-action)';
    pinnedTitle.innerHTML = "PINNED HUMAN ACTIONS (Fast Intervention)";
    pinnedSection.appendChild(pinnedTitle);

    for (const item of state.attentionItems) {
      const itemEl = document.createElement('div');
      itemEl.className = 'card border-red';
      itemEl.style.borderLeft = '4px solid var(--red-action)';
      itemEl.innerHTML = `
        <div class="card-header">
          <span style="font-weight: 700; font-size: 13px;">${item.title}</span>
          <span class="status-pill red" style="font-size: 10px;">Action Required</span>
        </div>
        <p style="font-size: 12px; color: var(--text-secondary);">${item.summary}</p>
        <div style="display: flex; justify-content: flex-end; gap: 6px; margin-top: 4px;">
          <button class="btn btn-primary btn-sm act-btn" style="font-size: 11px; padding: 4px 10px;">
            ${item.actionLabel} →
          </button>
        </div>
      `;

      itemEl.querySelector('.act-btn')?.addEventListener('click', () => {
        if (item.category === 'task_validation') {
          const task = state.tasks.find((t) => t.id === item.referenceId);
          if (task) {
            const decision = confirm(`Accept Task #${task.id} Completion Claim?\n\nOutcome: ${task.pendingCompletionClaim?.outcomeSummary}\n\nClick OK to Accept, Cancel to Require Correction.`);
            if (decision) {
              stateManager.validateTaskCompletion(task.id, 'accept');
            } else {
              const note = prompt('Enter correction instructions:');
              if (note) stateManager.validateTaskCompletion(task.id, 'require_correction', note);
            }
          }
        } else if (item.category === 'task_recovery') {
          stateManager.openInspector('force-release', 'env-recovery');
        } else if (item.category === 'task_blocker') {
          stateManager.resolveBlocker(item.referenceId);
        } else if (item.category === 'env_enrollment') {
          stateManager.approveEnvironmentEnrollment(item.referenceId);
        }
      });

      pinnedSection.appendChild(itemEl);
    }
    container.appendChild(pinnedSection);
  }

  // Section 2: Active Task Live Card (Inline in feed)
  const activeTask = state.tasks.find((t) => t.lifecycle === 'active' || t.lifecycle === 'Task pause requested');
  if (activeTask) {
    const taskCard = document.createElement('div');
    taskCard.className = 'card border-blue';
    taskCard.style.borderLeft = '4px solid var(--accent-primary)';
    taskCard.innerHTML = `
      <div class="card-header">
        <div>
          <span class="status-pill purple" style="font-size: 10px;">Active Task · Lease Held</span>
          <h3 style="font-size: 14px; font-weight: 700; margin-top: 2px;">#${activeTask.id}: ${activeTask.currentVersion.title}</h3>
        </div>
        <span class="status-pill ${activeTask.agentRunLifecycle === 'running' ? 'purple' : 'neutral'}">
          ${activeTask.agentRunLifecycle === 'running' ? 'Agent Running' : 'Idle'}
        </span>
      </div>
      <div style="font-size: 12px; color: var(--text-secondary); background: var(--bg-surface-elevated); padding: 8px; border-radius: var(--radius-sm);">
        <div><strong>Goal:</strong> ${activeTask.currentVersion.goal}</div>
        <div><strong>Lead:</strong> ${activeTask.taskLeadId} · <strong>Env:</strong> ${activeTask.selectedEnvironmentId}</div>
      </div>
      <!-- Fast Touch Action Controls -->
      <div style="display: flex; gap: 6px; margin-top: 4px;">
        ${
          activeTask.agentRunLifecycle === 'running'
            ? activeTask.lifecycle === 'Task pause requested'
              ? `<button class="btn btn-danger btn-sm btn-block stream-interrupt-btn">Interrupt Active Run</button>`
              : `<button class="btn btn-warning btn-sm btn-block stream-pause-btn">Pause Task (Admission Hold)</button>`
            : `<button class="btn btn-primary btn-sm btn-block stream-resume-btn">Resume</button>`
        }
      </div>
    `;

    taskCard.querySelector('.stream-pause-btn')?.addEventListener('click', () => {
      stateManager.pauseTask(activeTask.id);
    });
    taskCard.querySelector('.stream-interrupt-btn')?.addEventListener('click', () => {
      stateManager.interruptActiveRun(activeTask.id);
    });
    taskCard.querySelector('.stream-resume-btn')?.addEventListener('click', () => {
      stateManager.resumeTask(activeTask.id);
    });

    container.appendChild(taskCard);
  }

  // Section 3: Chronological Message & Telemetry Stream
  const streamCard = document.createElement('div');
  streamCard.className = 'card';
  streamCard.innerHTML = `
    <div class="card-header">
      <span class="card-title" style="font-size: 14px; display: flex; align-items: center; gap: 6px;">${renderIcon("chat", 14)} Unified Conversation & Execution Stream</span>
      <span style="font-size: 11px; color: var(--text-muted);">Persistence-before-wake</span>
    </div>
    <div style="display: flex; flex-direction: column; gap: 8px; max-height: 380px; overflow-y: auto;">
      ${state.messages
        .map(
          (msg) => `
        <div class="chat-message ${msg.isProjectedReply ? 'projected-reply' : ''}" style="padding: 10px; font-size: 12px;">
          <div class="msg-header">
            <div class="msg-author">
              <span>${msg.authorAvatar}</span>
              <span>${msg.authorDisplayName}</span>
              ${msg.isProjectedReply ? '<span class="projected-badge" style="font-size: 9px;">Projected Reply</span>' : ''}
            </div>
            <span style="color: var(--text-muted); font-size: 10px;">${msg.timestamp}</span>
          </div>
          <div class="msg-body" style="font-size: 13px; margin-top: 3px;">${msg.content}</div>
        </div>
      `
        )
        .join('')}
    </div>
  `;
  container.appendChild(streamCard);

  // Section 4: Quick Command Input
  const quickInput = document.createElement('div');
  quickInput.className = 'chat-composer';
  quickInput.innerHTML = `
    <input class="chat-input" placeholder="Quick command or message (@all, @Planner, etc.)..." style="min-height: 40px; padding: 8px 12px;" />
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <span style="font-size: 11px; color: var(--text-muted);">Variant A: Stream-First Interaction</span>
      <button class="btn btn-primary btn-sm send-stream-btn">Send</button>
    </div>
  `;

  quickInput.querySelector('.send-stream-btn')?.addEventListener('click', () => {
    const input = quickInput.querySelector('.chat-input') as HTMLInputElement;
    if (input.value.trim()) {
      stateManager.sendMessage(state.selectedProjectId, { kind: 'project-channel' }, input.value.trim());
      input.value = '';
    }
  });

  container.appendChild(quickInput);

  return container;
}
