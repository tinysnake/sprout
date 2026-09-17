import { renderIcon } from "../icons.js";
import { stateManager, type PrototypeState } from '../state.js';

/**
 * Variant C: "Task Board & Multi-Agent Deck" (Task & Lease Kanban Centric)
 *
 * Mental Model: Work-centric organization. Everything revolves around Tasks and scarce Environment Leases.
 * Visual Lanes: Proposals -> Active Tasks (Lease Held) -> Validation Queue -> Recovery/Blocked -> Done.
 * Fast Intervention Floating Dock pinned at bottom for instant touch actions.
 */
export function renderVariantC(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'view-container variant-c-container';

  // Variant C Header
  const headerCard = document.createElement('div');
  headerCard.className = 'card';
  headerCard.style.borderLeft = '4px solid var(--purple-agent)';
  headerCard.innerHTML = `
    <div class="card-header">
      <div>
        <h2 style="font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px;">${renderIcon("tasks", 18)} Multi-Agent Task & Lease Deck</h2>
        <p style="font-size: 12px; color: var(--text-secondary);">
          Variant C: Kanban / Work-deck architecture. Tasks hold scarce leases across lifecycle stages.
        </p>
      </div>
      <span class="status-pill purple" style="font-size: 11px;">Deck Architecture</span>
    </div>

    <!-- Quick Environment Traffic Light Ribbon -->
    <div style="display: flex; gap: 8px; overflow-x: auto; font-size: 11px;">
      ${state.environments
        .map(
          (env) => `
        <div style="background: var(--bg-surface-elevated); padding: 4px 8px; border-radius: var(--radius-sm); display: flex; align-items: center; gap: 6px; white-space: nowrap;">
          <span class="status-dot ${env.trafficLight}"></span>
          <strong>${env.displayName.split(' ')[0]}</strong>:
          <span style="color: var(--text-secondary);">${env.activeLeaseHolder ? `Lease #${env.activeLeaseHolder.holderId.replace('task-', '')}` : 'Free'}</span>
        </div>
      `
        )
        .join('')}
    </div>
  `;
  container.appendChild(headerCard);

  // Kanban Stage Deck Columns (Rendered as cards/lanes)
  const lanesContainer = document.createElement('div');
  lanesContainer.style.display = 'flex';
  lanesContainer.style.flexDirection = 'column';
  lanesContainer.style.gap = '12px';

  // Lane 1: Awaiting Validation
  const validationTasks = state.tasks.filter((t) => t.lifecycle === 'awaiting validation');
  if (validationTasks.length > 0) {
    const laneEl = document.createElement('div');
    laneEl.className = 'card border-yellow';
    laneEl.style.borderLeft = '4px solid var(--yellow-attention)';
    laneEl.innerHTML = `
      <div class="card-header">
        <span style="font-weight: 700; font-size: 13px; color: var(--yellow-attention);">VALIDATION QUEUE (${validationTasks.length})</span>
        <span class="status-pill yellow" style="font-size: 10px;">Lease Held</span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        ${validationTasks
          .map(
            (t) => `
          <div style="background: var(--bg-surface-elevated); padding: 10px; border-radius: var(--radius-sm); font-size: 12px; display: flex; flex-direction: column; gap: 6px;">
            <div style="font-weight: 700;">#${t.id}: ${t.currentVersion.title}</div>
            <div style="color: var(--text-secondary);">Claim by Lead <code>${t.taskLeadId}</code>: ${t.pendingCompletionClaim?.outcomeSummary}</div>
            <div style="display: flex; gap: 6px; justify-content: flex-end; margin-top: 4px;">
              <button class="btn btn-warning btn-sm val-correct-btn" data-id="${t.id}" style="font-size: 11px; padding: 3px 8px;">Require Correction</button>
              <button class="btn btn-primary btn-sm val-accept-btn" data-id="${t.id}" style="font-size: 11px; padding: 3px 8px;">Accept & Safe End</button>
            </div>
          </div>
        `
          )
          .join('')}
      </div>
    `;

    laneEl.querySelectorAll('.val-accept-btn').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        const id = (ev.currentTarget as HTMLElement).getAttribute('data-id')!;
        stateManager.validateTaskCompletion(id, 'accept');
      });
    });

    laneEl.querySelectorAll('.val-correct-btn').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        const id = (ev.currentTarget as HTMLElement).getAttribute('data-id')!;
        const note = prompt('Enter correction note for lead agent:');
        if (note) stateManager.validateTaskCompletion(id, 'require_correction', note);
      });
    });

    lanesContainer.appendChild(laneEl);
  }

  // Lane 2: Active Tasks
  const activeTasks = state.tasks.filter((t) => t.lifecycle === 'active' || t.lifecycle === 'Task pause requested' || t.lifecycle === 'paused');
  const activeLane = document.createElement('div');
  activeLane.className = 'card';
  activeLane.innerHTML = `
    <div class="card-header">
      <span style="font-weight: 700; font-size: 13px; color: var(--accent-primary);">ACTIVE TASKS (${activeTasks.length})</span>
      <span class="status-pill purple" style="font-size: 10px;">Lease Held</span>
    </div>
    <div style="display: flex; flex-direction: column; gap: 8px;">
      ${activeTasks
        .map(
          (t) => `
        <div style="background: var(--bg-surface-elevated); padding: 10px; border-radius: var(--radius-sm); font-size: 12px; display: flex; flex-direction: column; gap: 6px;">
          <div style="display: flex; justify-content: space-between;">
            <strong>#${t.id}: ${t.currentVersion.title}</strong>
            <span class="status-pill ${t.agentRunLifecycle === 'running' ? 'purple' : 'neutral'}" style="font-size: 10px;">${t.agentRunLifecycle}</span>
          </div>
          <div style="color: var(--text-secondary);">Lead: <code>${t.taskLeadId}</code> · Env: <code>${t.selectedEnvironmentId}</code></div>
          <div style="display: flex; gap: 6px; justify-content: flex-end; margin-top: 4px;">
            ${
              t.agentRunLifecycle === 'running'
                ? `<button class="btn btn-warning btn-sm pause-t-btn" data-id="${t.id}" style="font-size: 11px; padding: 3px 8px;">Pause</button>
                   <button class="btn btn-danger btn-sm int-t-btn" data-id="${t.id}" style="font-size: 11px; padding: 3px 8px;">Interrupt</button>`
                : `<button class="btn btn-primary btn-sm res-t-btn" data-id="${t.id}" style="font-size: 11px; padding: 3px 8px;">Resume</button>`
            }
          </div>
        </div>
      `
        )
        .join('')}
    </div>
  `;

  activeLane.querySelectorAll('.pause-t-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      stateManager.pauseTask((ev.currentTarget as HTMLElement).getAttribute('data-id')!);
    });
  });
  activeLane.querySelectorAll('.int-t-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      stateManager.interruptActiveRun((ev.currentTarget as HTMLElement).getAttribute('data-id')!);
    });
  });
  activeLane.querySelectorAll('.res-t-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      stateManager.resumeTask((ev.currentTarget as HTMLElement).getAttribute('data-id')!);
    });
  });

  lanesContainer.appendChild(activeLane);

  // Lane 3: Recovery / Blocked
  const recoveryTasks = state.tasks.filter((t) => t.lifecycle === 'recovery' || t.lifecycle === 'blocked');
  if (recoveryTasks.length > 0) {
    const recLane = document.createElement('div');
    recLane.className = 'card border-red';
    recLane.style.borderLeft = '4px solid var(--red-action)';
    recLane.innerHTML = `
      <div class="card-header">
        <span style="font-weight: 700; font-size: 13px; color: var(--red-action);">BLOCKED / RECOVERY LANE (${recoveryTasks.length})</span>
        <span class="status-pill red" style="font-size: 10px;">Action Required</span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        ${recoveryTasks
          .map(
            (t) => `
          <div style="background: var(--bg-surface-elevated); padding: 10px; border-radius: var(--radius-sm); font-size: 12px; display: flex; flex-direction: column; gap: 6px;">
            <div style="font-weight: 700;">#${t.id}: ${t.currentVersion.title}</div>
            <div style="color: var(--text-secondary);">${t.lifecycle === 'blocked' ? `Blocker: ${t.activeBlocker?.reason}` : `Recovery: ${t.recoveryReason}`}</div>
            <div style="display: flex; gap: 6px; justify-content: flex-end; margin-top: 4px;">
              ${
                t.lifecycle === 'blocked'
                  ? `<button class="btn btn-primary btn-sm unblock-btn" data-id="${t.id}" style="font-size: 11px; padding: 3px 8px;">Resolve Blocker</button>`
                  : `<button class="btn btn-secondary btn-sm resume-rec-btn" data-id="${t.id}" style="font-size: 11px; padding: 3px 8px;">Resume</button>
                     <button class="btn btn-danger btn-sm force-btn" data-id="${t.id}" style="font-size: 11px; padding: 3px 8px;">Force Release</button>`
              }
            </div>
          </div>
        `
          )
          .join('')}
      </div>
    `;

    recLane.querySelectorAll('.unblock-btn').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        stateManager.resolveBlocker((ev.currentTarget as HTMLElement).getAttribute('data-id')!);
      });
    });
    recLane.querySelectorAll('.resume-rec-btn').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        stateManager.resumeOrdinaryRecovery((ev.currentTarget as HTMLElement).getAttribute('data-id')!);
      });
    });
    recLane.querySelectorAll('.force-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        stateManager.openInspector('force-release', 'win-dev-box');
      });
    });

    lanesContainer.appendChild(recLane);
  }

  // Lane 4: Task Proposals
  const proposals = state.tasks.filter((t) => t.lifecycle === 'proposed');
  if (proposals.length > 0) {
    const propLane = document.createElement('div');
    propLane.className = 'card';
    propLane.innerHTML = `
      <div class="card-header">
        <span style="font-weight: 700; font-size: 13px;">TASK PROPOSALS (${proposals.length})</span>
        <span class="status-pill neutral" style="font-size: 10px;">No Lease Held</span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        ${proposals
          .map(
            (t) => `
          <div style="background: var(--bg-surface-elevated); padding: 10px; border-radius: var(--radius-sm); font-size: 12px; display: flex; flex-direction: column; gap: 6px;">
            <div style="font-weight: 700;">#${t.id}: ${t.currentVersion.title}</div>
            <div style="color: var(--text-secondary);">${t.currentVersion.goal}</div>
            <div style="display: flex; justify-content: flex-end; margin-top: 4px;">
              <button class="btn btn-primary btn-sm app-begin-btn" data-id="${t.id}" style="font-size: 11px; padding: 3px 8px;">
                Approve & Begin →
              </button>
            </div>
          </div>
        `
          )
          .join('')}
      </div>
    `;

    propLane.querySelectorAll('.app-begin-btn').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        const id = (ev.currentTarget as HTMLElement).getAttribute('data-id')!;
        stateManager.approveAndBeginProposal(id, 'mac-studio-primary', 'designer');
      });
    });

    lanesContainer.appendChild(propLane);
  }

  container.appendChild(lanesContainer);

  return container;
}
