import { renderIcon } from '../icons.js';
import { stateManager, type PrototypeState } from '../state.js';
import type { NestedAgentRun, TaskItem } from '../types.js';

export function renderTasksView(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'view-container';

  // Section 1: Tasks Navigation / Filter Header
  const tasksHeader = document.createElement('div');
  tasksHeader.className = 'card';
  tasksHeader.innerHTML = `
    <div class="card-header">
      <div>
        <h2 style="font-size: 17px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
          ${renderIcon('tasks', 18)}
          <span>Tasks & Lifecycle Control</span>
        </h2>
        <p style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
          Human authority governs Task begin/end; Task lead coordinates multi-run execution under Task-held lease (ADR-0006).
        </p>
      </div>
      <button class="btn btn-secondary btn-sm new-proposal-btn">
        + Propose Task
      </button>
    </div>

    <!-- Horizontal Task Selector Carousel/Pills -->
    <div style="display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px;">
      ${state.tasks
        .map(
          (t) => `
        <button class="btn btn-sm task-select-btn ${state.selectedTaskId === t.id ? 'btn-primary' : 'btn-secondary'}" data-task="${t.id}" style="white-space: nowrap; display: inline-flex; align-items: center; gap: 4px;">
          ${
            t.lifecycle === 'awaiting validation'
              ? renderIcon('check', 12)
              : t.lifecycle === 'active'
              ? renderIcon('lightning', 12)
              : t.lifecycle === 'blocked'
              ? renderIcon('alert', 12)
              : t.lifecycle === 'recovery'
              ? renderIcon('warning', 12)
              : t.lifecycle === 'proposed'
              ? renderIcon('clock', 12)
              : renderIcon('check', 12)
          }
          <span>#${t.id.replace('task-', '')}: ${t.currentVersion.title.slice(0, 20)}...</span>
        </button>
      `
        )
        .join('')}
    </div>
  `;

  tasksHeader.querySelectorAll('.task-select-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const taskId = (e.currentTarget as HTMLElement).getAttribute('data-task')!;
      stateManager.selectTask(taskId);
    });
  });

  tasksHeader.querySelector('.new-proposal-btn')?.addEventListener('click', () => {
    const title = prompt('Enter Task Title:');
    if (title && title.trim()) {
      const goal = prompt('Enter Task Goal:') ?? 'Accomplish feature goal.';
      const newProp: TaskItem = {
        id: `task-${Date.now().toString().slice(-3)}`,
        projectId: state.selectedProjectId,
        proposerId: state.operator.id,
        proposerKind: 'human',
        createdAt: 'Just now',
        taskLeadId: 'programmer',
        lifecycle: 'proposed',
        agentRunLifecycle: 'none',
        leaseLifecycle: 'none',
        currentVersion: {
          version: 1,
          createdAt: 'Just now',
          createdBy: 'Operator (Human)',
          title: title.trim(),
          goal,
          constraints: ['Follow project rules.'],
          validationCriteria: ['Verification script passes.'],
          taskLeadId: 'programmer',
        },
        historyVersions: [],
        runs: [],
      };
      state.tasks.unshift(newProp);
      stateManager.selectTask(newProp.id);
    }
  });

  container.appendChild(tasksHeader);

  // Section 2: Selected Task Detail Card
  const selectedTask = state.tasks.find((t) => t.id === state.selectedTaskId) ?? state.tasks[0];
  if (!selectedTask) {
    container.innerHTML += `<div class="card"><p>No task found.</p></div>`;
    return container;
  }

  // 3-Lifecycle Distinction Banner
  const lifecycleCard = document.createElement('div');
  lifecycleCard.className = 'lifecycle-banner';

  let lifecycleSentence = `Task ${selectedTask.lifecycle} · No active Agent run · Lease ${selectedTask.leaseLifecycle}`;
  if (selectedTask.agentRunLifecycle === 'running') {
    lifecycleSentence = `Task ${selectedTask.lifecycle} · Agent running · Lease ${selectedTask.leaseLifecycle}`;
  } else if (selectedTask.lifecycle === 'Task pause requested') {
    lifecycleSentence = `Task pause requested · Active run settling · Lease ${selectedTask.leaseLifecycle}`;
  } else if (selectedTask.lifecycle === 'recovery') {
    lifecycleSentence = `Task recovery · Interrupted run recorded · Lease recovering`;
  }

  let taskStateColor = 'green';
  if (selectedTask.lifecycle === 'awaiting validation' || selectedTask.lifecycle === 'Task pause requested' || selectedTask.lifecycle === 'proposed') {
    taskStateColor = 'yellow';
  } else if (selectedTask.lifecycle === 'blocked' || selectedTask.lifecycle === 'recovery') {
    taskStateColor = 'red';
  } else if (selectedTask.lifecycle === 'completed' || selectedTask.lifecycle === 'cancelled') {
    taskStateColor = 'neutral';
  }

  lifecycleCard.innerHTML = `
    <div class="lifecycle-sentence">
      ${renderIcon('settings', 14)}
      <span>${lifecycleSentence}</span>
    </div>
    <div class="lifecycle-pills-row">
      <span class="status-pill ${taskStateColor}">
        <strong>Task:</strong> ${selectedTask.lifecycle}
      </span>
      <span class="status-pill ${selectedTask.agentRunLifecycle === 'running' ? 'purple' : 'neutral'}">
        <strong>Agent Run:</strong> ${selectedTask.agentRunLifecycle}
      </span>
      <span class="status-pill ${selectedTask.leaseLifecycle === 'held' ? 'green' : selectedTask.leaseLifecycle === 'recovering' ? 'red' : 'neutral'}">
        <strong>Task Lease:</strong> ${selectedTask.leaseLifecycle} ${selectedTask.selectedEnvironmentId ? `(${selectedTask.selectedEnvironmentId})` : ''}
      </span>
      <span class="status-pill neutral">
        <strong>Content Version:</strong> v${selectedTask.currentVersion.version}
      </span>
      <span class="status-pill neutral">
        <strong>Lead:</strong> ${selectedTask.taskLeadId}
      </span>
    </div>
  `;
  container.appendChild(lifecycleCard);

  // Proposal Authority Card (if proposed)
  if (selectedTask.lifecycle === 'proposed') {
    const proposalCard = document.createElement('div');
    proposalCard.className = 'card border-yellow';
    proposalCard.style.borderLeft = '4px solid var(--yellow-attention)';
    proposalCard.innerHTML = `
      <div class="card-header">
        <span class="card-title">Task Proposal (Awaiting Human Approval)</span>
        <span class="status-pill yellow">Holds No Lease</span>
      </div>
      <p style="font-size: 13px; color: var(--text-secondary);">
        Proposals perform only non-resource validation. Approve-and-Begin selects an Environment, acquires its Task lease, creates the scratch context directory, and begins multi-run execution.
      </p>
      <div style="background: var(--bg-surface-elevated); padding: 10px; border-radius: var(--radius-sm); font-size: 13px; display: flex; flex-direction: column; gap: 6px;">
        <div><strong>Proposed Lead:</strong> ${selectedTask.currentVersion.taskLeadId}</div>
        <div><strong>Goal:</strong> ${selectedTask.currentVersion.goal}</div>
        <div><strong>Constraints:</strong> ${selectedTask.currentVersion.constraints.join('; ')}</div>
      </div>
      <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px;">
        <button class="btn btn-secondary btn-sm reject-prop-btn">Reject Proposal</button>
        <button class="btn btn-primary approve-begin-btn">
          Approve & Begin Task (Human Authority)
        </button>
      </div>
    `;

    proposalCard.querySelector('.approve-begin-btn')?.addEventListener('click', () => {
      stateManager.approveAndBeginProposal(selectedTask.id, 'mac-studio-primary', selectedTask.currentVersion.taskLeadId);
    });

    proposalCard.querySelector('.reject-prop-btn')?.addEventListener('click', () => {
      prompt('Enter rejection reason:');
      selectedTask.lifecycle = 'rejected';
      stateManager.selectTask(selectedTask.id);
    });

    container.appendChild(proposalCard);
  }

  // Completion Claim Review Card (if awaiting validation)
  if (selectedTask.lifecycle === 'awaiting validation' && selectedTask.pendingCompletionClaim) {
    const claim = selectedTask.pendingCompletionClaim;
    const claimCard = document.createElement('div');
    claimCard.className = 'card border-yellow';
    claimCard.style.borderLeft = '4px solid var(--yellow-attention)';
    claimCard.innerHTML = `
      <div class="card-header">
        <div style="display: flex; align-items: center; gap: 8px;">
          ${renderIcon('check', 18)}
          <span class="card-title">Task Completion Claim Submitted for Human Validation</span>
        </div>
        <span class="status-pill yellow">Lease Held</span>
      </div>
      <div style="font-size: 13px; display: flex; flex-direction: column; gap: 8px; background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm);">
        <div><strong>Outcome Summary:</strong> ${claim.outcomeSummary}</div>
        <div><strong>Validation Evidence:</strong> <code>${claim.validationEvidence}</code></div>
        <div><strong>Durable Changes:</strong> ${claim.durableChanges.map((c) => `<code>${c}</code>`).join(', ')}</div>
        <div><strong>Known Limitations:</strong> ${claim.knownLimitations}</div>
        <div><strong>Recommended Disposition:</strong> <span class="status-pill green" style="font-size: 11px;">${claim.recommendedDisposition}</span></div>
      </div>
      <div style="display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; margin-top: 6px;">
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
      const notes = prompt('Enter correction instructions for Lead Agent:') ?? 'Please fix remaining issues.';
      stateManager.validateTaskCompletion(selectedTask.id, 'require_correction', notes);
    });

    container.appendChild(claimCard);
  }

  // Blocker Card (if blocked)
  if (selectedTask.lifecycle === 'blocked' && selectedTask.activeBlocker) {
    const blocker = selectedTask.activeBlocker;
    const blockerCard = document.createElement('div');
    blockerCard.className = 'card border-red';
    blockerCard.style.borderLeft = '4px solid var(--red-action)';
    blockerCard.innerHTML = `
      <div class="card-header">
        <div style="display: flex; align-items: center; gap: 8px;">
          ${renderIcon('alert', 18)}
          <span class="card-title">Routable Task Blocker</span>
        </div>
        <span class="status-pill red">Lease Held</span>
      </div>
      <div style="font-size: 13px; display: flex; flex-direction: column; gap: 6px; background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm);">
        <div><strong>Reason:</strong> ${blocker.reason}</div>
        <div><strong>Required Action:</strong> ${blocker.requiredNextAction}</div>
        <div><strong>Responsible Actor:</strong> <span class="status-pill neutral" style="font-size: 11px;">${blocker.responsibleActor}</span></div>
        <div><strong>Who Advances When Cleared:</strong> <span class="status-pill purple" style="font-size: 11px;">${blocker.whoAdvancesWhenCleared}</span></div>
      </div>
      <div style="display: flex; justify-content: flex-end; margin-top: 6px;">
        <button class="btn btn-primary resolve-blocker-btn">
          Resolve Blocker & Resume Advance →
        </button>
      </div>
    `;

    blockerCard.querySelector('.resolve-blocker-btn')?.addEventListener('click', () => {
      stateManager.resolveBlocker(selectedTask.id);
    });

    container.appendChild(blockerCard);
  }

  // Recovery Card (if in recovery)
  if (selectedTask.lifecycle === 'recovery') {
    const recoveryCard = document.createElement('div');
    recoveryCard.className = 'card border-red';
    recoveryCard.style.borderLeft = '4px solid var(--red-action)';
    recoveryCard.innerHTML = `
      <div class="card-header">
        <div style="display: flex; align-items: center; gap: 8px;">
          ${renderIcon('warning', 18)}
          <span class="card-title">Task & Environment Lease in Recovery</span>
        </div>
        <span class="status-pill red">Human Recovery Decision Required</span>
      </div>
      <p style="font-size: 13px; color: var(--text-secondary);">
        ${selectedTask.recoveryReason ?? 'Interrupted execution detected. The Environment lease remains protected against reassignment.'}
      </p>
      <div style="display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; margin-top: 8px;">
        <button class="btn btn-secondary btn-sm ordinary-resume-btn">
          Ordinary Resume (Deliberate Advance)
        </button>
        <button class="btn btn-warning btn-sm ordinary-discard-btn">
          Discard Task (Safe End)
        </button>
        <button class="btn btn-danger btn-sm force-release-btn">
          Emergency Force Release
        </button>
      </div>
    `;

    recoveryCard.querySelector('.ordinary-resume-btn')?.addEventListener('click', () => {
      stateManager.resumeOrdinaryRecovery(selectedTask.id);
    });

    recoveryCard.querySelector('.ordinary-discard-btn')?.addEventListener('click', () => {
      stateManager.discardTask(selectedTask.id);
    });

    recoveryCard.querySelector('.force-release-btn')?.addEventListener('click', () => {
      stateManager.openInspector('force-release', selectedTask.selectedEnvironmentId);
    });

    container.appendChild(recoveryCard);
  }

  // Section 3: Task Content & Versioning Details
  const contentCard = document.createElement('div');
  contentCard.className = 'card';
  contentCard.innerHTML = `
    <div class="card-header">
      <span class="card-title">Task Goal, Constraints & Criteria</span>
      <button class="btn btn-secondary btn-sm edit-version-btn">
        Edit / Create Content Version
      </button>
    </div>
    <div style="font-size: 13px; display: flex; flex-direction: column; gap: 8px;">
      <div><strong>Goal:</strong> ${selectedTask.currentVersion.goal}</div>
      <div><strong>Constraints:</strong>
        <ul style="margin-left: 18px; margin-top: 4px;">
          ${selectedTask.currentVersion.constraints.map((c) => `<li>${c}</li>`).join('')}
        </ul>
      </div>
      <div><strong>Validation Criteria:</strong>
        <ul style="margin-left: 18px; margin-top: 4px;">
          ${selectedTask.currentVersion.validationCriteria.map((v) => `<li>${v}</li>`).join('')}
        </ul>
      </div>
      <div style="font-size: 11px; color: var(--text-muted); border-top: 1px solid var(--border-subtle); padding-top: 6px;">
        Active runs execute against their admission version; new edits immediately create v${selectedTask.currentVersion.version + 1} for future runs.
      </div>
    </div>
  `;

  contentCard.querySelector('.edit-version-btn')?.addEventListener('click', () => {
    const newGoal = prompt('Update Goal for new Version:', selectedTask.currentVersion.goal);
    if (newGoal && newGoal.trim()) {
      stateManager.updateTaskContentVersion(
        selectedTask.id,
        selectedTask.currentVersion.title,
        newGoal.trim(),
        selectedTask.currentVersion.constraints,
        selectedTask.currentVersion.validationCriteria,
        selectedTask.taskLeadId
      );
    }
  });

  container.appendChild(contentCard);

  // Section 4: Live Controls Sticky Action Bar (Two-Stage Pause, Interrupt, Resume, Discard)
  if (selectedTask.lifecycle !== 'completed' && selectedTask.lifecycle !== 'cancelled' && selectedTask.lifecycle !== 'proposed') {
    const actionBar = document.createElement('div');
    actionBar.className = 'mobile-action-bar';

    if (selectedTask.agentRunLifecycle === 'running') {
      if (selectedTask.lifecycle === 'Task pause requested') {
        actionBar.innerHTML = `
          <button class="btn btn-danger btn-block interrupt-run-btn">
            Interrupt Active Run (Intentional Stop)
          </button>
        `;
      } else {
        actionBar.innerHTML = `
          <button class="btn btn-warning btn-block pause-task-btn">
            Pause Task (Admission Hold)
          </button>
        `;
      }
    } else if (selectedTask.lifecycle === 'paused') {
      actionBar.innerHTML = `
        <button class="btn btn-primary btn-block resume-task-btn">
          Resume Task Advancement
        </button>
        <button class="btn btn-danger btn-sm discard-task-btn">
          Discard
        </button>
      `;
    } else if (selectedTask.lifecycle === 'active') {
      actionBar.innerHTML = `
        <button class="btn btn-secondary btn-block pause-task-btn">
          Pause Task
        </button>
        <button class="btn btn-secondary btn-sm simulate-run-btn">
          Next Agent Run
        </button>
        <button class="btn btn-danger btn-sm discard-task-btn">
          Discard
        </button>
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

    actionBar.querySelector('.discard-task-btn')?.addEventListener('click', () => {
      if (confirm('Are you sure you want to discard this Task? Scratch context will be recycled, lease released, and Project workspace preserved.')) {
        stateManager.discardTask(selectedTask.id);
      }
    });

    actionBar.querySelector('.simulate-run-btn')?.addEventListener('click', () => {
      const newRunId = `run-${Date.now().toString().slice(-3)}`;
      const newRun: NestedAgentRun = {
        id: newRunId,
        taskId: selectedTask.id,
        agentId: 'programmer',
        agentDisplayName: 'Programmer',
        engine: 'pi',
        workModel: 'claude-3-5-sonnet',
        effort: 'high',
        contentVersionUsed: selectedTask.currentVersion.version,
        lifecycle: 'running',
        startedAt: 'Just now',
        events: [
          { time: 'Just now', kind: 'status_change', summary: 'Run admitted under Task-held lease' },
          { time: 'Just now', kind: 'tool_call', summary: 'read templates/o7-minesweeper/src/board.js' },
        ],
      };
      selectedTask.runs.unshift(newRun);
      selectedTask.activeRunId = newRunId;
      selectedTask.agentRunLifecycle = 'running';
      stateManager.selectTask(selectedTask.id);
    });

    container.appendChild(actionBar);
  }

  // Section 5: Nested Agent Runs Timeline
  const runsCard = document.createElement('div');
  runsCard.className = 'card';
  runsCard.innerHTML = `
    <div class="card-header">
      <span class="card-title">Nested Agent Runs (${selectedTask.runs.length})</span>
      <span style="font-size: 11px; color: var(--text-muted);">Reuses Task-held lease</span>
    </div>
    <div style="display: flex; flex-direction: column; gap: 10px;">
      ${
        selectedTask.runs.length === 0
          ? '<p style="font-size: 13px; color: var(--text-muted);">No runs in this Task yet.</p>'
          : selectedTask.runs
              .map(
                (r) => `
          <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 10px; font-size: 12px; display: flex; flex-direction: column; gap: 6px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="font-weight: 600;">#${r.id}: ${r.agentDisplayName} (${r.engine} / ${r.workModel})</span>
              <span class="status-pill ${r.lifecycle === 'completed' ? 'green' : r.lifecycle === 'running' ? 'purple' : r.lifecycle === 'stopped' ? 'yellow' : 'red'}" style="font-size: 10px;">
                ${r.lifecycle}
              </span>
            </div>
            <div style="color: var(--text-secondary);">
              Started: ${r.startedAt} ${r.wallDurationMs ? `· Duration: ${(r.wallDurationMs / 1000).toFixed(1)}s` : ''} · Version used: v${r.contentVersionUsed}
            </div>
            ${
              r.tokenUsage
                ? `<div style="display: flex; gap: 8px; font-size: 11px; color: var(--text-muted);">
                    <span>Total Tokens: ${r.tokenUsage.total.toLocaleString()}</span>
                    <span>Cached Reads: ${r.tokenUsage.cachedReads.toLocaleString()}</span>
                    <span>Reasoning: ${r.tokenUsage.reasoningOutput.toLocaleString()}</span>
                  </div>`
                : ''
            }
            ${
              r.monetaryCost?.estimatedUsdMicros
                ? `<div style="font-size: 11px; color: var(--accent-primary);">
                    API-Equiv Estimate: $${(r.monetaryCost.estimatedUsdMicros / 1000000).toFixed(4)} (${r.monetaryCost.provenance})
                  </div>`
                : ''
            }
            <div style="border-top: 1px solid var(--border-subtle); padding-top: 4px; display: flex; flex-direction: column; gap: 3px;">
              ${r.events.map((e) => `<div style="font-size: 11px; color: var(--text-secondary);">[${e.time}] ${e.summary}</div>`).join('')}
            </div>
          </div>
        `
              )
              .join('')
      }
    </div>
  `;

  container.appendChild(runsCard);

  return container;
}
