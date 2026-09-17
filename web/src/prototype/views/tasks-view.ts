import { renderIcon } from '../icons.js';
import { stateManager, type PrototypeState } from '../state.js';
import type { NestedAgentRun, ProjectItem, TaskItem } from '../types.js';

export function renderTasksView(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'view-container';

  const project =
    state.projects.find((p) => p.id === state.selectedProjectId) ?? state.projects[0];
  const projectTasks = state.tasks.filter((t) => t.projectId === (project?.id || state.selectedProjectId));

  const selectedTask =
    projectTasks.find((t) => t.id === state.selectedTaskId) ??
    state.tasks.find((t) => t.id === state.selectedTaskId);

  // If in Detail mode and a task is selected, render the dedicated Task Detail Page
  if (state.taskViewMode === 'detail' && selectedTask) {
    return renderTaskDetailPage(container, state, project, selectedTask);
  }

  // Otherwise, render the Task List Page (Grid View with Dropdown Filter)
  return renderTaskListPage(container, state, project, projectTasks);
}

/**
 * Renders the Task List Page with Filter Dropdown and Responsive Grid View
 */
function renderTaskListPage(
  container: HTMLElement,
  state: PrototypeState,
  project: ProjectItem | undefined,
  projectTasks: TaskItem[]
): HTMLElement {
  const currentFilter = state.taskFilter || 'all';

  const activeCount = projectTasks.filter(
    (t) => t.lifecycle === 'active' || t.lifecycle === 'Task pause requested'
  ).length;
  const validationCount = projectTasks.filter((t) => t.lifecycle === 'awaiting validation').length;
  const blockedCount = projectTasks.filter((t) => t.lifecycle === 'blocked').length;
  const proposedCount = projectTasks.filter((t) => t.lifecycle === 'proposed').length;
  const recoveryCount = projectTasks.filter((t) => t.lifecycle === 'recovery').length;
  const completedCount = projectTasks.filter(
    (t) => t.lifecycle === 'completed' || t.lifecycle === 'cancelled'
  ).length;

  const filteredTasks = projectTasks.filter((t) => {
    if (currentFilter === 'active') return t.lifecycle === 'active' || t.lifecycle === 'Task pause requested';
    if (currentFilter === 'validation') return t.lifecycle === 'awaiting validation';
    if (currentFilter === 'blocked') return t.lifecycle === 'blocked';
    if (currentFilter === 'proposed') return t.lifecycle === 'proposed';
    if (currentFilter === 'recovery') return t.lifecycle === 'recovery';
    if (currentFilter === 'completed') return t.lifecycle === 'completed' || t.lifecycle === 'cancelled';
    return true;
  });

  const listCard = document.createElement('div');
  listCard.className = 'card';

  listCard.innerHTML = `
    <!-- Top Header: Title, Filter Dropdown, Propose Button (Item 1 & 2) -->
    <div class="card-header" style="display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;">
      <div>
        <h2 style="font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
          ${renderIcon('tasks', 18)}
          <span>Project Tasks & Operating Loop</span>
        </h2>
        <p style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
          Click any task card to drill down into its full operating controls and run execution timeline.
        </p>
      </div>

      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
        <!-- Single Filter Dropdown (Item 1) -->
        <select class="form-select task-filter-select" id="task-filter-select" aria-label="Filter tasks by status">
          <option value="all" ${currentFilter === 'all' ? 'selected' : ''}>All Tasks (${projectTasks.length})</option>
          <option value="active" ${currentFilter === 'active' ? 'selected' : ''}>Active / Running (${activeCount})</option>
          <option value="validation" ${currentFilter === 'validation' ? 'selected' : ''}>Validation Claims (${validationCount})</option>
          <option value="blocked" ${currentFilter === 'blocked' ? 'selected' : ''}>Blocked (${blockedCount})</option>
          <option value="proposed" ${currentFilter === 'proposed' ? 'selected' : ''}>Proposals (${proposedCount})</option>
          <option value="recovery" ${currentFilter === 'recovery' ? 'selected' : ''}>Recovery (${recoveryCount})</option>
          <option value="completed" ${currentFilter === 'completed' ? 'selected' : ''}>Completed (${completedCount})</option>
        </select>

        <button class="btn btn-primary btn-sm new-proposal-btn" ${project?.status === 'archived' ? 'disabled' : ''}>
          ${renderIcon('plus', 14)} Propose Task
        </button>
      </div>
    </div>

    <!-- Responsive Grid View: 1-col on mobile, 3-4 col on desktop (Item 2) -->
    <div class="card-body">
      ${
        filteredTasks.length === 0
          ? `<div style="text-align: center; color: var(--text-muted); font-size: 13px; padding: 30px 0;">
              No tasks match the selected filter.
            </div>`
          : `<div class="tasks-grid" role="listbox" aria-label="Tasks List">
              ${filteredTasks
                .map((t) => {
                  let statusColor = 'green';
                  let borderClass = 'border-green';
                  if (
                    t.lifecycle === 'awaiting validation' ||
                    t.lifecycle === 'Task pause requested' ||
                    t.lifecycle === 'proposed'
                  ) {
                    statusColor = 'yellow';
                    borderClass = 'border-yellow';
                  } else if (t.lifecycle === 'blocked' || t.lifecycle === 'recovery') {
                    statusColor = 'red';
                    borderClass = 'border-red';
                  } else if (
                    t.lifecycle === 'completed' ||
                    t.lifecycle === 'cancelled' ||
                    t.lifecycle === 'rejected'
                  ) {
                    statusColor = 'neutral';
                    borderClass = 'border-neutral';
                  }

                  return `
                <div class="task-grid-card task-select-btn ${borderClass}" data-task="${t.id}" role="option" tabindex="0">
                  <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
                    <span style="font-family: var(--font-mono); font-size: 12px; font-weight: 700; color: var(--accent-primary);">
                      #${t.id.replace('task-', '')}
                    </span>
                    <span class="status-pill ${statusColor}" style="font-size: 10px; padding: 2px 6px;">
                      ${t.lifecycle}
                    </span>
                  </div>

                  <div class="task-grid-card-title" title="${t.currentVersion.title}">
                    ${t.currentVersion.title}
                  </div>

                  <div class="task-grid-card-goal">
                    ${t.currentVersion.goal}
                  </div>

                  <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px; padding-top: 6px; border-top: 1px solid var(--border-subtle); font-size: 11px; color: var(--text-secondary);">
                    <span>Lead: <strong>${t.taskLeadId}</strong></span>
                    <span>${t.selectedEnvironmentId ? t.selectedEnvironmentId.split('-')[0] : 'No lease'}</span>
                  </div>
                </div>
              `;
                })
                .join('')}
            </div>`
      }
    </div>
  `;

  // Filter dropdown listener
  listCard.querySelector('#task-filter-select')?.addEventListener('change', (ev) => {
    const val = (ev.target as HTMLSelectElement).value;
    stateManager.setTaskFilter(val);
  });

  // Task grid card click listeners (Drill-down to Detail Page)
  listCard.querySelectorAll('.task-grid-card').forEach((card) => {
    card.addEventListener('click', (ev) => {
      const taskId = (ev.currentTarget as HTMLElement).getAttribute('data-task')!;
      stateManager.openTaskDetail(taskId);
    });

    card.addEventListener('keydown', (ev: any) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        const taskId = (ev.currentTarget as HTMLElement).getAttribute('data-task')!;
        stateManager.openTaskDetail(taskId);
      }
    });
  });

  // Propose task button listener
  listCard.querySelector('.new-proposal-btn')?.addEventListener('click', () => {
    if (project) {
      renderNewProposalModal(container, state, project);
    }
  });

  container.appendChild(listCard);
  return container;
}

/**
 * Renders the Dedicated Task Detail Page (Drill-down with Back navigation)
 */
function renderTaskDetailPage(
  container: HTMLElement,
  state: PrototypeState,
  project: ProjectItem | undefined,
  selectedTask: TaskItem
): HTMLElement {
  // 3-Lifecycle Disambiguation Banner (Foldable Box: Default Collapsed)
  const lifecycleCard = document.createElement('div');
  lifecycleCard.className = 'lifecycle-disambiguation-box';

  let lifecycleSentence = `Task ${selectedTask.lifecycle} · No active Agent run · Lease ${selectedTask.leaseLifecycle}`;
  if (selectedTask.agentRunLifecycle === 'running') {
    lifecycleSentence = `Task ${selectedTask.lifecycle} · Agent running · Lease ${selectedTask.leaseLifecycle} (${selectedTask.selectedEnvironmentId || 'held'})`;
  } else if (selectedTask.lifecycle === 'Task pause requested') {
    lifecycleSentence = `Task pause requested · Active run settling · Lease ${selectedTask.leaseLifecycle}`;
  } else if (selectedTask.lifecycle === 'recovery') {
    lifecycleSentence = `Task recovery · Interrupted run recorded · Lease recovering (${selectedTask.selectedEnvironmentId || 'held'})`;
  } else if (selectedTask.lifecycle === 'proposed') {
    lifecycleSentence = `Task proposed · Executes NO run · Holds NO lease`;
  }

  let taskStateColor = 'green';
  if (
    selectedTask.lifecycle === 'awaiting validation' ||
    selectedTask.lifecycle === 'Task pause requested' ||
    selectedTask.lifecycle === 'proposed'
  ) {
    taskStateColor = 'yellow';
  } else if (selectedTask.lifecycle === 'blocked' || selectedTask.lifecycle === 'recovery') {
    taskStateColor = 'red';
  } else if (
    selectedTask.lifecycle === 'completed' ||
    selectedTask.lifecycle === 'cancelled' ||
    selectedTask.lifecycle === 'rejected'
  ) {
    taskStateColor = 'neutral';
  }

  lifecycleCard.innerHTML = `
    <div class="lifecycle-fold-header lifecycle-sentence-row" id="lifecycle-fold-toggle" role="button" aria-expanded="false" title="Click to expand/collapse lifecycle facts">
      <div class="lifecycle-sentence-text">
        ${renderIcon('settings', 14)}
        <span>${lifecycleSentence}</span>
      </div>
      <div class="lifecycle-fold-chevron">
        ${renderIcon('chevron-right', 14)}
      </div>
    </div>

    <div class="lifecycle-details-list" id="lifecycle-details-list">
      <div class="lifecycle-detail-row">
        <span class="lifecycle-detail-label">Task Lifecycle:</span>
        <span class="status-pill ${taskStateColor}">${selectedTask.lifecycle}</span>
      </div>
      <div class="lifecycle-detail-row">
        <span class="lifecycle-detail-label">Agent Run Lifecycle:</span>
        <span class="status-pill ${selectedTask.agentRunLifecycle === 'running' ? 'purple' : 'neutral'}">${selectedTask.agentRunLifecycle}</span>
      </div>
      <div class="lifecycle-detail-row">
        <span class="lifecycle-detail-label">Task Lease State:</span>
        <span class="status-pill ${selectedTask.leaseLifecycle === 'held' ? 'green' : selectedTask.leaseLifecycle === 'recovering' ? 'red' : 'neutral'}">
          ${selectedTask.leaseLifecycle} ${selectedTask.selectedEnvironmentId ? `(${selectedTask.selectedEnvironmentId})` : ''}
        </span>
      </div>
      <div class="lifecycle-detail-row">
        <span class="lifecycle-detail-label">Content Version:</span>
        <span class="status-pill neutral">v${selectedTask.currentVersion.version}</span>
      </div>
      <div class="lifecycle-detail-row">
        <span class="lifecycle-detail-label">Task Lead Agent:</span>
        <span class="status-pill neutral">${selectedTask.taskLeadId}</span>
      </div>
      <div class="lifecycle-detail-row">
        <span class="lifecycle-detail-label">Proposer Attribution:</span>
        <span class="status-pill neutral">${selectedTask.currentVersion.createdBy}</span>
      </div>
    </div>
  `;

  lifecycleCard.querySelector('#lifecycle-fold-toggle')?.addEventListener('click', () => {
    const isExpanded = lifecycleCard.classList.toggle('expanded');
    const toggle = lifecycleCard.querySelector('#lifecycle-fold-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', String(isExpanded));
  });

  container.appendChild(lifecycleCard);

  // STAGE 1: Proposal Authority Card (when proposed)
  if (selectedTask.lifecycle === 'proposed') {
    const proposalCard = document.createElement('div');
    proposalCard.className = 'operating-stage-card border-yellow';
    proposalCard.style.borderLeft = '4px solid var(--yellow-attention)';

    proposalCard.innerHTML = `
      <div class="stage-header">
        <div class="stage-title" style="color: var(--yellow-attention);">
          ${renderIcon('clock', 18)}
          <span>Task Proposal (Awaiting Human Begin Authority)</span>
        </div>
        <span class="status-pill yellow">Holds NO Lease</span>
      </div>

      <div class="stage-body">
        <p style="color: var(--text-secondary);">
          Proposals perform only non-resource non-blocking validation. Human <strong>Approve & Begin</strong> authority selects one Environment instance, acquires its exclusive Task lease, creates the scratch context directory, and begins multi-run execution.
        </p>

        <div style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm); display: flex; flex-direction: column; gap: 8px;">
          <div><strong>Proposed Title:</strong> ${selectedTask.currentVersion.title}</div>
          <div><strong>Proposed Goal:</strong> ${selectedTask.currentVersion.goal}</div>
          <div><strong>Constraints:</strong> ${selectedTask.currentVersion.constraints.join('; ')}</div>
          <div><strong>Validation Criteria:</strong> ${selectedTask.currentVersion.validationCriteria.join('; ')}</div>
          <div><strong>Proposed Lead:</strong> <span class="status-pill purple" style="font-size: 11px;">${selectedTask.currentVersion.taskLeadId}</span></div>
        </div>

        <!-- Environment & Lead Selection for Begin -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 4px;">
          <div>
            <label style="font-size: 12px; font-weight: 700;">Select Bound Host Environment *</label>
            <select class="form-select select-begin-env" style="width: 100%; margin-top: 4px;">
              ${(project?.boundEnvironmentWorkspaces || [])
                .map((ws) => {
                  const env = state.environments.find((e) => e.id === ws.environmentId);
                  const isBusy = env?.activeLeaseHolder !== undefined;
                  return `<option value="${ws.environmentId}" ${isBusy ? 'disabled' : ''}>
                    ${ws.environmentId} (${env?.platform}) ${isBusy ? '· [BUSY LEASE]' : '· Ready'}
                  </option>`;
                })
                .join('')}
            </select>
          </div>
          <div>
            <label style="font-size: 12px; font-weight: 700;">Confirm Task Lead Agent *</label>
            <select class="form-select select-begin-lead" style="width: 100%; margin-top: 4px;">
              ${(project?.memberships || [])
                .filter((m) => m.memberKind === 'agent' && m.status === 'active')
                .map(
                  (m) => `
                <option value="${m.memberId}" ${m.memberId === selectedTask.taskLeadId ? 'selected' : ''}>
                  ${m.displayName} (${m.memberId})
                </option>
              `
                )
                .join('')}
            </select>
          </div>
        </div>
      </div>

      <div class="stage-actions">
        <button class="btn btn-secondary btn-sm reject-proposal-btn">
          ${renderIcon('close', 12)} Reject Proposal
        </button>
        <button class="btn btn-primary approve-begin-btn">
          ${renderIcon('play', 14)} Approve & Begin Task (Human Authority)
        </button>
      </div>
    `;

    proposalCard.querySelector('.approve-begin-btn')?.addEventListener('click', () => {
      const envSelect = proposalCard.querySelector('.select-begin-env') as HTMLSelectElement;
      const leadSelect = proposalCard.querySelector('.select-begin-lead') as HTMLSelectElement;
      if (envSelect && leadSelect) {
        stateManager.approveAndBeginProposal(selectedTask.id, envSelect.value, leadSelect.value);
      }
    });

    proposalCard.querySelector('.reject-proposal-btn')?.addEventListener('click', () => {
      const reason = prompt('Enter rejection reason:') ?? 'Proposal not approved for this roadmap milestone.';
      stateManager.rejectTaskProposal(selectedTask.id, reason);
    });

    container.appendChild(proposalCard);
  }

  // STAGE 2: Completion Claim Validation Card (when awaiting validation)
  if (selectedTask.lifecycle === 'awaiting validation' && selectedTask.pendingCompletionClaim) {
    const claim = selectedTask.pendingCompletionClaim;
    const claimCard = document.createElement('div');
    claimCard.className = 'operating-stage-card border-yellow';
    claimCard.style.borderLeft = '4px solid var(--yellow-attention)';

    claimCard.innerHTML = `
      <div class="stage-header">
        <div class="stage-title" style="color: var(--yellow-attention);">
          ${renderIcon('check', 18)}
          <span>Task Completion Claim Submitted for Human Validation</span>
        </div>
        <span class="status-pill yellow">Lease Held</span>
      </div>

      <div class="stage-body">
        <p style="color: var(--text-secondary);">
          Lead Agent <strong>${selectedTask.taskLeadId}</strong> submitted a formal completion claim. Human validation is required to accept and authorize safe Task end, or require deliberate correction.
        </p>

        <div style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm); display: flex; flex-direction: column; gap: 8px;">
          <div><strong>Outcome Summary:</strong> ${claim.outcomeSummary}</div>
          <div><strong>Validation Evidence:</strong> <code>${claim.validationEvidence}</code></div>
          <div><strong>Durable Changes:</strong> ${claim.durableChanges.map((c) => `<code>${c}</code>`).join(', ')}</div>
          <div><strong>Known Limitations:</strong> ${claim.knownLimitations}</div>
          <div><strong>Recommended Disposition:</strong> <span class="status-pill green" style="font-size: 11px;">${claim.recommendedDisposition}</span></div>
          <div style="font-size: 11px; color: var(--text-muted); border-top: 1px solid var(--border-subtle); padding-top: 4px;">
            Submitted: ${claim.submittedAt} · Evaluated against Task Content Version v${claim.contentVersion}
          </div>
        </div>
      </div>

      <div class="stage-actions">
        <button class="btn btn-warning require-correction-btn">
          ${renderIcon('warning', 14)} Require Correction
        </button>
        <button class="btn btn-primary accept-claim-btn">
          ${renderIcon('check', 14)} Accept & Authorize Safe Task End
        </button>
      </div>
    `;

    claimCard.querySelector('.accept-claim-btn')?.addEventListener('click', () => {
      stateManager.validateTaskCompletion(selectedTask.id, 'accept');
    });

    claimCard.querySelector('.require-correction-btn')?.addEventListener('click', () => {
      const notes = prompt(
        'Enter correction instructions for Lead Agent:',
        'Please refine edge cases and rerun verification.'
      );
      if (notes !== null) {
        stateManager.validateTaskCompletion(selectedTask.id, 'require_correction', notes);
      }
    });

    container.appendChild(claimCard);
  }

  // STAGE 3: Routable Blocker Card (when blocked)
  if (selectedTask.lifecycle === 'blocked' && selectedTask.activeBlocker) {
    const blocker = selectedTask.activeBlocker;
    const blockerCard = document.createElement('div');
    blockerCard.className = 'operating-stage-card border-red';
    blockerCard.style.borderLeft = '4px solid var(--red-action)';

    blockerCard.innerHTML = `
      <div class="stage-header">
        <div class="stage-title" style="color: var(--red-action);">
          ${renderIcon('alert', 18)}
          <span>Routable Task Blocker</span>
        </div>
        <span class="status-pill red">Lease Held</span>
      </div>

      <div class="stage-body">
        <div style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm); display: flex; flex-direction: column; gap: 8px;">
          <div><strong>Reason:</strong> ${blocker.reason}</div>
          <div><strong>Required Next Action:</strong> ${blocker.requiredNextAction}</div>
          <div><strong>Responsible Actor:</strong> <span class="status-pill neutral" style="font-size: 11px;">${blocker.responsibleActor}</span></div>
          <div><strong>Who Advances When Cleared:</strong> <span class="status-pill purple" style="font-size: 11px;">${blocker.whoAdvancesWhenCleared}</span></div>
          <div style="font-size: 11px; color: var(--text-muted); border-top: 1px solid var(--border-subtle); padding-top: 4px;">
            Declared: ${blocker.createdAt} · Task lease remains safely protected against reassignment.
          </div>
        </div>
      </div>

      <div class="stage-actions">
        <button class="btn btn-primary resolve-blocker-btn">
          ${renderIcon('check', 14)} Resolve Blocker & Resume Advance →
        </button>
      </div>
    `;

    blockerCard.querySelector('.resolve-blocker-btn')?.addEventListener('click', () => {
      stateManager.resolveBlocker(selectedTask.id);
    });

    container.appendChild(blockerCard);
  }

  // STAGE 4: Recovery Card (when in recovery)
  if (selectedTask.lifecycle === 'recovery') {
    const recoveryCard = document.createElement('div');
    recoveryCard.className = 'operating-stage-card border-red';
    recoveryCard.style.borderLeft = '4px solid var(--red-action)';

    recoveryCard.innerHTML = `
      <div class="stage-header">
        <div class="stage-title" style="color: var(--red-action);">
          ${renderIcon('warning', 18)}
          <span>Task & Environment Lease in Recovery</span>
        </div>
        <span class="status-pill red">Human Decision Required</span>
      </div>

      <div class="stage-body">
        <p style="color: var(--text-secondary);">
          ${selectedTask.recoveryReason ?? 'Interrupted execution detected. The Environment lease remains protected against reassignment.'}
        </p>

        <div style="background: var(--bg-surface-elevated); padding: 10px 12px; border-radius: var(--radius-sm); font-size: 12px; color: var(--text-muted);">
          <strong>Lease Protection Guarantee (ADR-0005):</strong> Lease remains bound to <code>${selectedTask.selectedEnvironmentId}</code>. Sprout never automatically migrates an interrupted task to another host.
        </div>
      </div>

      <div class="stage-actions">
        <button class="btn btn-secondary btn-sm ordinary-resume-btn">
          ${renderIcon('play', 14)} Ordinary Resume (Deliberate Advance)
        </button>
        <button class="btn btn-warning btn-sm ordinary-discard-btn">
          ${renderIcon('trash', 14)} Discard Task (Safe End)
        </button>
      </div>
    `;

    recoveryCard.querySelector('.ordinary-resume-btn')?.addEventListener('click', () => {
      stateManager.resumeOrdinaryRecovery(selectedTask.id);
    });

    recoveryCard.querySelector('.ordinary-discard-btn')?.addEventListener('click', () => {
      if (
        confirm(
          'Discard this Task in recovery? Task context will be recycled, lease released, and Project workspace preserved.'
        )
      ) {
        stateManager.discardTask(selectedTask.id);
      }
    });

    container.appendChild(recoveryCard);
  }

  // Section 4: Task Content & Versioning Details Card
  const contentCard = document.createElement('div');
  contentCard.className = 'card';

  contentCard.innerHTML = `
    <div class="card-header">
      <div>
        <span class="card-title">Task Content & Specification</span>
        <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
          Current Version: <strong>v${selectedTask.currentVersion.version}</strong> · Edited by: ${selectedTask.currentVersion.createdBy}
        </div>
      </div>
      <button class="btn btn-secondary btn-sm edit-task-content-btn" ${selectedTask.lifecycle === 'completed' || selectedTask.lifecycle === 'cancelled' ? 'disabled' : ''}>
        ${renderIcon('edit', 14)} Edit Specification (Create v${selectedTask.currentVersion.version + 1})
      </button>
    </div>

    <div class="card-body" style="display: flex; flex-direction: column; gap: 10px;">
      <div>
        <div style="font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">Goal</div>
        <div style="font-size: 13px; font-weight: 500; margin-top: 3px; line-height: 1.45;">
          ${selectedTask.currentVersion.goal}
        </div>
      </div>

      <div>
        <div style="font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">Constraints</div>
        <ul style="margin-left: 18px; margin-top: 4px; font-size: 12px; color: var(--text-secondary); display: flex; flex-direction: column; gap: 2px;">
          ${selectedTask.currentVersion.constraints.map((c) => `<li>${c}</li>`).join('')}
        </ul>
      </div>

      <div>
        <div style="font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">Validation Criteria</div>
        <ul style="margin-left: 18px; margin-top: 4px; font-size: 12px; color: var(--text-secondary); display: flex; flex-direction: column; gap: 2px;">
          ${selectedTask.currentVersion.validationCriteria.map((v) => `<li>${v}</li>`).join('')}
        </ul>
      </div>

      ${
        selectedTask.historyVersions.length > 0
          ? `<div style="margin-top: 6px; padding-top: 8px; border-top: 1px solid var(--border-subtle); font-size: 11px; color: var(--text-muted);">
              <strong>Version History:</strong> ${selectedTask.historyVersions.map((h) => `v${h.version} (${h.createdBy})`).join(' → ')} → current v${selectedTask.currentVersion.version}
            </div>`
          : ''
      }
    </div>
  `;

  contentCard.querySelector('.edit-task-content-btn')?.addEventListener('click', () => {
    renderEditTaskVersionModal(container, selectedTask);
  });

  container.appendChild(contentCard);

  // Section 5: Nested Agent Runs Timeline (Autonomous Execution Audit)
  const runsCard = document.createElement('div');
  runsCard.className = 'card';

  runsCard.innerHTML = `
    <div class="card-header">
      <div>
        <span class="card-title">Nested Agent Runs Timeline</span>
        <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
          ${selectedTask.runs.length} Sequential Run(s) coordinated under Task-held Lease
        </div>
      </div>
      ${
        selectedTask.lifecycle === 'active' && selectedTask.leaseLifecycle === 'held'
          ? `<button class="btn btn-secondary btn-sm trigger-advance-btn">
              ${renderIcon('play', 14)} Advance Run
            </button>`
          : ''
      }
    </div>

    <div class="card-body">
      ${
        selectedTask.runs.length === 0
          ? `<div style="text-align: center; color: var(--text-muted); font-size: 12px; padding: 16px 0;">No agent runs have executed in this task yet.</div>`
          : `<div class="runs-timeline-container">
              ${selectedTask.runs.map((run) => renderNestedRunCard(run)).join('')}
            </div>`
      }
    </div>
  `;

  runsCard.querySelector('.trigger-advance-btn')?.addEventListener('click', () => {
    stateManager.simulateLeadAutonomousRun(selectedTask.id);
  });

  container.appendChild(runsCard);

  // Section 6: Live Controls Sticky Action Bar (Two-Stage Pause, Interrupt, Resume, Discard)
  if (
    selectedTask.lifecycle !== 'completed' &&
    selectedTask.lifecycle !== 'cancelled' &&
    selectedTask.lifecycle !== 'proposed' &&
    selectedTask.lifecycle !== 'rejected'
  ) {
    const actionBar = document.createElement('div');
    actionBar.className = 'operating-stage-card';
    actionBar.style.background = 'var(--bg-surface-elevated)';

    if (selectedTask.agentRunLifecycle === 'running') {
      if (selectedTask.lifecycle === 'Task pause requested') {
        actionBar.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
            <div style="font-size: 12px; color: var(--yellow-attention); font-weight: 600;">
              ${renderIcon('pause', 14)} Pause Requested: Admission hold active; run settling naturally.
            </div>
            <button class="btn btn-danger btn-sm interrupt-run-btn">
              ${renderIcon('close', 14)} Interrupt Active Run (Intentional Stop)
            </button>
          </div>
        `;
      } else {
        actionBar.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
            <div style="font-size: 12px; color: var(--accent-primary); font-weight: 600;">
              ${renderIcon('lightning', 14)} Agent run actively executing on host.
            </div>
            <div style="display: flex; gap: 6px;">
              <button class="btn btn-warning btn-sm pause-task-btn">
                ${renderIcon('pause', 14)} Pause Task (Stage 1)
              </button>
              <button class="btn btn-danger btn-sm interrupt-run-btn">
                ${renderIcon('close', 14)} Interrupt (Stage 2)
              </button>
            </div>
          </div>
        `;
      }
    } else if (selectedTask.lifecycle === 'paused') {
      actionBar.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
          <div style="font-size: 12px; color: var(--text-muted); font-weight: 600;">
            ${renderIcon('pause', 14)} Task is Paused · Environment Lease remains held.
          </div>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-primary btn-sm resume-task-btn">
              ${renderIcon('play', 14)} Resume Advancement
            </button>
            <button class="btn btn-danger btn-sm discard-task-btn">
              ${renderIcon('trash', 14)} Discard Task
            </button>
          </div>
        </div>
      `;
    } else if (selectedTask.lifecycle === 'active') {
      actionBar.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
          <div style="font-size: 12px; color: var(--green-ready); font-weight: 600;">
            ${renderIcon('check', 14)} Active Deliberate Advance · Lease Held on ${selectedTask.selectedEnvironmentId || 'Host'}
          </div>
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            <button class="btn btn-secondary btn-sm pause-task-btn">
              ${renderIcon('pause', 14)} Pause Task
            </button>
            <button class="btn btn-secondary btn-sm simulate-run-btn">
              ${renderIcon('play', 14)} Advance Run
            </button>
            <button class="btn btn-warning btn-sm submit-claim-btn">
              ${renderIcon('check', 14)} Submit Claim
            </button>
            <button class="btn btn-danger btn-sm discard-task-btn">
              ${renderIcon('trash', 14)} Discard
            </button>
          </div>
        </div>
      `;
    }

    actionBar.querySelector('.pause-task-btn')?.addEventListener('click', () => {
      stateManager.pauseTask(selectedTask.id);
    });

    actionBar.querySelector('.interrupt-run-btn')?.addEventListener('click', () => {
      stateManager.interruptActiveRun(selectedTask.id);
    });

    actionBar.querySelector('.resume-task-btn')?.addEventListener('click', () => {
      stateManager.resumeTask(selectedTask.id);
    });

    actionBar.querySelector('.simulate-run-btn')?.addEventListener('click', () => {
      stateManager.simulateLeadAutonomousRun(selectedTask.id);
    });

    actionBar.querySelector('.submit-claim-btn')?.addEventListener('click', () => {
      stateManager.submitTaskCompletionClaim(
        selectedTask.id,
        'All implementation criteria satisfied and browser tests verified.',
        'scripts/verify-test.ts passed 100%',
        ['src/main.ts', 'src/board.ts']
      );
    });

    actionBar.querySelector('.discard-task-btn')?.addEventListener('click', () => {
      if (
        confirm(
          'Are you sure you want to discard this Task? Scratch context will be recycled, lease released, and Project workspace preserved.'
        )
      ) {
        stateManager.discardTask(selectedTask.id);
      }
    });

    container.appendChild(actionBar);
  }

  return container;
}

/**
 * Helper to render individual nested agent run card
 */
function renderNestedRunCard(run: NestedAgentRun): string {
  let runStatusColor = 'green';
  if (run.lifecycle === 'running') runStatusColor = 'purple';
  else if (run.lifecycle === 'stopped' || run.lifecycle === 'interrupted' || run.lifecycle === 'failed') runStatusColor = 'red';

  return `
    <div class="nested-run-card">
      <div class="nested-run-header">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-family: var(--font-mono); font-weight: 700; font-size: 12px; color: var(--accent-primary);">
            ${run.id}
          </span>
          <span style="font-weight: 600; font-size: 13px;">${run.agentDisplayName}</span>
          <span class="status-pill ${runStatusColor}" style="font-size: 10px;">${run.lifecycle}</span>
          <span class="status-pill neutral" style="font-size: 10px;">v${run.contentVersionUsed}</span>
        </div>
        <div style="font-size: 11px; color: var(--text-muted);">
          ${run.startedAt} ${run.settledAt ? `· Settled: ${run.settledAt}` : ''}
        </div>
      </div>

      <div style="font-size: 11px; color: var(--text-secondary); display: flex; gap: 12px; flex-wrap: wrap;">
        <span><strong>Engine:</strong> ${run.engine} (${run.workModel})</span>
        <span><strong>Effort:</strong> ${run.effort}</span>
        ${run.wallDurationMs ? `<span><strong>Duration:</strong> ${(run.wallDurationMs / 1000).toFixed(1)}s</span>` : ''}
        ${run.tokenUsage ? `<span><strong>Tokens:</strong> ${run.tokenUsage.total.toLocaleString()}</span>` : ''}
        ${run.monetaryCost?.estimatedUsdMicros ? `<span><strong>Est Cost:</strong> $${(run.monetaryCost.estimatedUsdMicros / 1000000).toFixed(4)}</span>` : ''}
      </div>

      ${
        run.interruptionReason
          ? `<div style="background: rgba(239, 68, 68, 0.1); border: 1px solid var(--red-action); padding: 6px 10px; border-radius: var(--radius-xs); font-size: 11px; color: var(--red-action);">
              <strong>Interruption Reason:</strong> ${run.interruptionReason}
            </div>`
          : ''
      }

      ${
        run.events && run.events.length > 0
          ? `<div class="run-events-stream">
              ${run.events
                .map(
                  (ev) => `
                <div class="run-event-item">
                  <span class="event-time">[${ev.time}]</span>
                  <span class="event-text">${ev.summary}</span>
                </div>
              `
                )
                .join('')}
            </div>`
          : ''
      }

      ${
        run.finalAssistantText
          ? `<div style="font-size: 12px; color: var(--text-primary); font-style: italic; background: var(--bg-surface); padding: 6px 10px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle);">
              "${run.finalAssistantText}"
            </div>`
          : ''
      }
    </div>
  `;
}

// --- Modals for Task Management ---

function renderNewProposalModal(
  parentEl: HTMLElement,
  state: PrototypeState,
  project: ProjectItem
) {
  const modal = document.createElement('div');
  modal.className = 'proto-modal-backdrop';

  const eligibleAgents = project.memberships.filter(
    (m) => m.memberKind === 'agent' && m.status === 'active'
  );

  modal.innerHTML = `
    <div class="proto-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="new-prop-title">
      <div class="proto-modal-header">
        <strong id="new-prop-title" style="font-size: 15px;">Propose New Project Task</strong>
        <button class="btn btn-ghost btn-sm close-modal-btn">${renderIcon('close', 12)}</button>
      </div>
      <div class="proto-modal-body">
        <div>
          <label style="font-size: 12px; font-weight: 700;">Task Title *</label>
          <input type="text" class="form-input new-task-title" placeholder="e.g. Integrate Particle Smoke Effect on Explosion" style="width: 100%; margin-top: 4px;" />
        </div>
        <div>
          <label style="font-size: 12px; font-weight: 700;">Task Goal *</label>
          <textarea class="form-textarea new-task-goal" rows="2" placeholder="Specify objective..." style="width: 100%; margin-top: 4px;">Implement procedural particle smoke burst on mine click.</textarea>
        </div>
        <div>
          <label style="font-size: 12px; font-weight: 700;">Proposed Task Lead Agent *</label>
          <select class="form-select new-task-lead" style="width: 100%; margin-top: 4px;">
            ${eligibleAgents
              .map((a) => `<option value="${a.memberId}">${a.displayName} (${a.memberId})</option>`)
              .join('')}
          </select>
        </div>
        <div>
          <label style="font-size: 12px; font-weight: 700;">Constraints (one per line)</label>
          <textarea class="form-textarea new-task-constraints" rows="2" style="width: 100%; margin-top: 4px;">Particle meshes recycled through object pool\nZero memory allocation during animation loop</textarea>
        </div>
        <div>
          <label style="font-size: 12px; font-weight: 700;">Validation Criteria (one per line)</label>
          <textarea class="form-textarea new-task-criteria" rows="2" style="width: 100%; margin-top: 4px;">Verification script verifies particle count decreases to 0\nFrame rate remains stable above 55 FPS</textarea>
        </div>
      </div>
      <div class="proto-modal-footer">
        <button class="btn btn-secondary close-modal-btn">Cancel</button>
        <button class="btn btn-primary create-prop-confirm-btn">Submit Proposal</button>
      </div>
    </div>
  `;

  modal.querySelectorAll('.close-modal-btn').forEach((b) => b.addEventListener('click', () => modal.remove()));

  modal.querySelector('.create-prop-confirm-btn')?.addEventListener('click', () => {
    const titleInput = modal.querySelector('.new-task-title') as HTMLInputElement;
    const goalInput = modal.querySelector('.new-task-goal') as HTMLTextAreaElement;
    const leadSelect = modal.querySelector('.new-task-lead') as HTMLSelectElement;
    const constraintsInput = modal.querySelector('.new-task-constraints') as HTMLTextAreaElement;
    const criteriaInput = modal.querySelector('.new-task-criteria') as HTMLTextAreaElement;

    if (!titleInput.value.trim()) {
      alert('Task title is required.');
      return;
    }

    const constraints = constraintsInput.value
      .split('\n')
      .map((c) => c.trim())
      .filter(Boolean);
    const criteria = criteriaInput.value
      .split('\n')
      .map((c) => c.trim())
      .filter(Boolean);

    stateManager.createTaskProposal(
      project.id,
      titleInput.value.trim(),
      goalInput.value.trim(),
      constraints,
      criteria,
      leadSelect.value,
      'human',
      state.operator.id
    );

    modal.remove();
  });

  parentEl.appendChild(modal);
}

function renderEditTaskVersionModal(parentEl: HTMLElement, task: TaskItem) {
  const modal = document.createElement('div');
  modal.className = 'proto-modal-backdrop';

  modal.innerHTML = `
    <div class="proto-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-version-title">
      <div class="proto-modal-header">
        <strong id="edit-version-title" style="font-size: 15px;">Edit Specification → Create Version v${task.currentVersion.version + 1}</strong>
        <button class="btn btn-ghost btn-sm close-modal-btn">${renderIcon('close', 12)}</button>
      </div>
      <div class="proto-modal-body">
        <div style="background: var(--bg-surface-elevated); padding: 8px 10px; border-radius: var(--radius-sm); font-size: 11px; color: var(--text-muted);">
          Active runs continue on their admission version (v${task.currentVersion.version}). Future runs and validation claims will use v${task.currentVersion.version + 1}.
        </div>
        <div>
          <label style="font-size: 12px; font-weight: 700;">Task Title</label>
          <input type="text" class="form-input edit-task-title" value="${task.currentVersion.title}" style="width: 100%; margin-top: 4px;" />
        </div>
        <div>
          <label style="font-size: 12px; font-weight: 700;">Goal</label>
          <textarea class="form-textarea edit-task-goal" rows="3" style="width: 100%; margin-top: 4px;">${task.currentVersion.goal}</textarea>
        </div>
        <div>
          <label style="font-size: 12px; font-weight: 700;">Constraints (one per line)</label>
          <textarea class="form-textarea edit-task-constraints" rows="3" style="width: 100%; margin-top: 4px;">${task.currentVersion.constraints.join('\n')}</textarea>
        </div>
        <div>
          <label style="font-size: 12px; font-weight: 700;">Validation Criteria (one per line)</label>
          <textarea class="form-textarea edit-task-criteria" rows="3" style="width: 100%; margin-top: 4px;">${task.currentVersion.validationCriteria.join('\n')}</textarea>
        </div>
      </div>
      <div class="proto-modal-footer">
        <button class="btn btn-secondary close-modal-btn">Cancel</button>
        <button class="btn btn-primary save-version-btn">Save v${task.currentVersion.version + 1}</button>
      </div>
    </div>
  `;

  modal.querySelectorAll('.close-modal-btn').forEach((b) => b.addEventListener('click', () => modal.remove()));

  modal.querySelector('.save-version-btn')?.addEventListener('click', () => {
    const title = (modal.querySelector('.edit-task-title') as HTMLInputElement).value.trim();
    const goal = (modal.querySelector('.edit-task-goal') as HTMLTextAreaElement).value.trim();
    const constraints = (modal.querySelector('.edit-task-constraints') as HTMLTextAreaElement).value
      .split('\n')
      .map((c) => c.trim())
      .filter(Boolean);
    const criteria = (modal.querySelector('.edit-task-criteria') as HTMLTextAreaElement).value
      .split('\n')
      .map((c) => c.trim())
      .filter(Boolean);

    stateManager.updateTaskContentVersion(task.id, title, goal, constraints, criteria, task.taskLeadId);
    modal.remove();
  });

  parentEl.appendChild(modal);
}
