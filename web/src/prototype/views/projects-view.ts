import { renderIcon } from '../icons.js';
import { stateManager, type PrototypeState } from '../state.js';
import type { ProjectItem } from '../types.js';
import { renderTasksView } from './tasks-view.js';
import {
  renderProjectChat,
  renderChatInfoModal,
  renderRoutingInspectorModal,
} from './chat-view.js';

export { renderChatInfoModal, renderRoutingInspectorModal };

export function renderProjectsView(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'projects-view';

  const project =
    state.projects.find((p) => p.id === state.selectedProjectId) ?? state.projects[0];
  if (!project) {
    container.innerHTML = `<div class="card"><p>No project selected.</p></div>`;
    return container;
  }

  // Calculate project statistics for metadata snapshot
  const projectTasks = state.tasks.filter((t) => t.projectId === project.id);
  const activeTasks = projectTasks.filter(
    (t) => t.lifecycle === 'active' || t.lifecycle === 'Task pause requested'
  );
  const validationTasks = projectTasks.filter((t) => t.lifecycle === 'awaiting validation');
  const blockedTasks = projectTasks.filter((t) => t.lifecycle === 'blocked');
  const recoveryTasks = projectTasks.filter((t) => t.lifecycle === 'recovery');
  const proposedTasks = projectTasks.filter((t) => t.lifecycle === 'proposed');
  const activeMembers = project.memberships.filter((m) => m.status === 'active');

  const isTaskDetailPage =
    state.projectTab === 'tasks' && state.taskViewMode === 'detail' && Boolean(state.selectedTaskId);
  const selectedTask = isTaskDetailPage
    ? projectTasks.find((t) => t.id === state.selectedTaskId) ??
      state.tasks.find((t) => t.id === state.selectedTaskId)
    : undefined;

  const isChatDetailPage =
    state.projectTab === 'chat' && state.chatViewMode === 'detail';

  let activeChatTitle = '#general';
  if (state.selectedScopeKind === 'working-group-channel' && state.selectedWorkingGroupId) {
    const wg = project.workingGroups.find((w) => w.id === state.selectedWorkingGroupId);
    activeChatTitle = wg?.displayName || 'Working Group';
  } else if (state.selectedScopeKind === 'direct-message' && state.selectedDirectMessagePeerId) {
    const peer = project.memberships.find((m) => m.memberId === state.selectedDirectMessagePeerId);
    activeChatTitle = `@${peer?.displayName || state.selectedDirectMessagePeerId}`;
  }

  // Top Project Navigation Bar (App Header Style)
  const projectNav = document.createElement('div');
  projectNav.className = 'project-nav-container';

  if (isTaskDetailPage && selectedTask) {
    // Focused Task Detail App-Header: Only Back Button & Task Title
    projectNav.innerHTML = `
      <header class="project-top-bar">
        <div class="project-selector-row">
          <button class="btn btn-secondary btn-sm back-to-tasks-btn task-select-btn" id="btn-header-back-to-tasks" title="Return to Tasks List">
            ${renderIcon('chevron-left', 16)} Back to Tasks
          </button>
          <div style="font-size: 13px; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
            <span>Task #${selectedTask.id.replace('task-', '')}</span>
            <span class="status-pill neutral" style="font-size: 10px;">v${selectedTask.currentVersion.version}</span>
          </div>
        </div>
      </header>
    `;

    projectNav.querySelector('#btn-header-back-to-tasks')?.addEventListener('click', () => {
      stateManager.closeTaskDetail();
    });
  } else {
    // Standard Project App-Header + Responsive Mobile Chat Back Header
    projectNav.innerHTML = `
      <header class="project-top-bar">
        ${
          isChatDetailPage
            ? `
          <!-- Mobile-only Chat Back Header (Hidden on Wide/Desktop) -->
          <div class="project-selector-row mobile-chat-back-header">
            <button class="btn btn-secondary btn-sm back-to-chats-btn" id="btn-header-back-to-chats" title="Return to Chats List">
              ${renderIcon('chevron-left', 16)} Back to Chats
            </button>
            <div style="font-size: 13px; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
              <span>${activeChatTitle}</span>
            </div>
          </div>
        `
            : ''
        }

        <!-- Standard Project Selector Header (Always visible on Desktop, visible on Mobile when in list mode) -->
        <div class="project-selector-row desktop-project-selector-header ${isChatDetailPage ? 'chat-detail-desktop-row' : ''}">
          <div class="project-selector-left">
            ${renderIcon('folder', 18)}
            <select class="project-dropdown-select" id="project-selector" aria-label="Select Project">
              ${state.projects
                .map(
                  (p) => `
                <option value="${p.id}" ${p.id === project.id ? 'selected' : ''}>
                  ${p.displayName} ${p.status === 'archived' ? '(Archived)' : ''}
                </option>
              `
                )
                .join('')}
            </select>
            ${project.status === 'archived' ? `<span class="status-pill neutral" style="font-size: 10px; flex-shrink: 0;">Archived</span>` : ''}
          </div>

          <div class="project-header-actions">
            <!-- Info Button -->
            <button class="btn btn-secondary btn-sm project-info-btn" id="project-info-btn" title="Project Information & Metadata" aria-label="Project Information & Metadata">
              ${renderIcon('info', 16)}
            </button>

            <!-- + New Project Button -->
            <button class="btn btn-secondary btn-sm new-project-btn" title="Create New Project" aria-label="Create New Project">
              ${renderIcon('plus', 16)}
            </button>
          </div>
        </div>
      </header>
    `;

    // Mobile back-to-chats listener
    projectNav.querySelector('#btn-header-back-to-chats')?.addEventListener('click', () => {
      stateManager.closeChatDetail();
    });

    // Project selector switch listener
    projectNav.querySelector('#project-selector')?.addEventListener('change', (ev) => {
      const selectedId = (ev.target as HTMLSelectElement).value;
      stateManager.selectProject(selectedId);
    });

    // Project info modal listener
    projectNav.querySelector('#project-info-btn')?.addEventListener('click', () => {
      renderProjectInfoModal(
        container,
        state,
        project,
        projectTasks,
        activeTasks,
        validationTasks,
        blockedTasks,
        proposedTasks,
        recoveryTasks,
        activeMembers
      );
    });

    // New Project modal listener
    projectNav.querySelector('.new-project-btn')?.addEventListener('click', () => {
      renderNewProjectModal(container);
    });
  }

  container.appendChild(projectNav);

  // Sub-View Content Area
  const contentEl = document.createElement('div');
  contentEl.className = 'project-content-area';

  if (state.projectTab === 'tasks') {
    contentEl.appendChild(renderTasksView(state));
  } else if (state.projectTab === 'chat') {
    contentEl.appendChild(renderProjectChat(state, project, container));
  } else {
    contentEl.appendChild(renderProjectOverview(state, project));
  }

  container.appendChild(contentEl);

  return container;
}

/**
 * Renders the Project Overview Sub-View (Contract, Memberships, Bound Workspaces)
 */
function renderProjectOverview(state: PrototypeState, project: ProjectItem): HTMLElement {
  const overviewEl = document.createElement('div');
  overviewEl.className = 'project-overview-grid';

  // Check if project has active work preventing archive
  const projectTasks = state.tasks.filter((t) => t.projectId === project.id);
  const activeTask = projectTasks.find(
    (t) =>
      t.agentRunLifecycle === 'running' ||
      t.leaseLifecycle === 'held' ||
      t.leaseLifecycle === 'recovering' ||
      t.lifecycle === 'active' ||
      t.lifecycle === 'awaiting validation' ||
      t.lifecycle === 'recovery' ||
      t.lifecycle === 'Task pause requested'
  );

  overviewEl.innerHTML = `
    <!-- 1. Project Contract & Purpose Card -->
    <div class="card grid-col-full">
      <div class="card-header">
        <span class="card-title">Project Contract & Purpose</span>
        <div style="display: flex; gap: 8px; align-items: center;">
          <span class="status-pill ${project.status === 'active' ? 'green' : 'neutral'}">
            ${project.status === 'active' ? 'Active' : 'Archived'}
          </span>
          <button class="btn btn-secondary btn-sm edit-contract-btn" title="Edit Project Contract" aria-label="Edit Project Contract" style="width: 32px; height: 32px; min-height: 32px; padding: 0; display: inline-flex; align-items: center; justify-content: center;" ${project.status === 'archived' ? 'disabled' : ''}>
            ${renderIcon('edit', 14)}
          </button>
        </div>
      </div>

      <div class="card-body" style="display: flex; flex-direction: column; gap: 12px;">
        <div>
          <div style="font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">Project Goal</div>
          <div style="font-size: 13px; font-weight: 500; margin-top: 4px; line-height: 1.45; color: var(--text-primary);">
            ${project.goal ?? 'No explicit goal defined.'}
          </div>
        </div>

        <div>
          <div style="font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">Project Rules (${(project.rules || []).length})</div>
          <ul style="margin-left: 18px; margin-top: 6px; font-size: 12px; color: var(--text-secondary); display: flex; flex-direction: column; gap: 4px;">
            ${(project.rules && project.rules.length > 0
              ? project.rules
              : ['Preserve modular boundaries and single-context documentation', 'Verify cross-platform compatibility before task completion']
            )
              .map((r: string) => `<li>${r}</li>`)
              .join('')}
          </ul>
        </div>

        <div>
          <div style="font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">Completion & Validation Guidance</div>
          <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px; line-height: 1.4;">
            ${project.completionGuidance ?? 'All completion claims must present checkable verification evidence prior to Human validation.'}
          </div>
        </div>

        <!-- Wake Policy & Archive Section -->
        <div style="padding-top: 10px; border-top: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
          <div>
            <div style="font-size: 11px; color: var(--text-muted); font-weight: 700;">WAKE ROUTING POLICY</div>
            <div style="font-size: 12px; margin-top: 2px; display: flex; align-items: center; gap: 6px;">
              <span class="status-pill purple" style="font-size: 11px;">
                ${project.wakePolicy === 'wake-model-assisted' ? 'Wake-Model Assisted (30s batch window)' : 'Explicit Mentions Only'}
              </span>
              <span style="font-size: 11px; color: var(--text-muted);">(Affects future incoming messages only)</span>
            </div>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button class="btn btn-secondary btn-sm toggle-policy-btn" ${project.status === 'archived' ? 'disabled' : ''}>
              Switch to ${project.wakePolicy === 'wake-model-assisted' ? 'Explicit-only' : 'Wake-Model Assisted'}
            </button>
            ${
              project.status === 'active'
                ? `<button class="btn ${activeTask ? 'btn-secondary' : 'btn-danger'} btn-sm archive-project-btn" ${activeTask ? 'title="Cannot archive while tasks hold leases or runs"' : ''}>
                    ${renderIcon('archive', 14)} Archive Project
                  </button>`
                : `<button class="btn btn-primary btn-sm restore-project-btn">
                    ${renderIcon('refresh', 14)} Restore Project
                  </button>`
            }
          </div>
        </div>

        ${
          activeTask && project.status === 'active'
            ? `<div style="background: var(--bg-surface-elevated); padding: 8px 12px; border-radius: var(--radius-sm); border: 1px solid var(--yellow-attention); font-size: 11px; color: var(--yellow-attention); display: flex; align-items: center; gap: 6px;">
                ${renderIcon('alert', 14)}
                <span><strong>Archive Safely Blocked:</strong> Task #${activeTask.id.replace('task-', '')} (${activeTask.lifecycle}, lease ${activeTask.leaseLifecycle}) is currently active. Settle or discard active work before archiving.</span>
              </div>`
            : ''
        }
      </div>
    </div>

    <!-- 2. Project Memberships & Collaboration Roles Card -->
    <div class="card">
      <div class="card-header">
        <div>
          <span class="card-title">Project Memberships</span>
          <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
            ${project.memberships.filter((m) => m.status === 'active').length} Active · ${project.memberships.filter((m) => m.status === 'ended').length} Ended
          </div>
        </div>
        <button class="btn btn-secondary btn-sm add-member-btn" title="Add Global Agent to Project" aria-label="Add Global Agent to Project" style="width: 32px; height: 32px; min-height: 32px; padding: 0; display: inline-flex; align-items: center; justify-content: center;" ${project.status === 'archived' ? 'disabled' : ''}>
          ${renderIcon('plus', 14)}
        </button>
      </div>

      <div class="list-group">
        ${project.memberships
          .map(
            (m) => `
          <div class="list-item" style="${m.status === 'ended' ? 'opacity: 0.65; background: var(--bg-surface-elevated);' : ''}">
            <div class="list-item-leading">
              <div style="width: 34px; height: 34px; border-radius: var(--radius-sm); background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 11px; color: var(--accent-primary);">
                ${m.avatar || (m.memberKind === 'human' ? 'OP' : 'AG')}
              </div>
            </div>
            <div class="list-item-body">
              <div class="list-item-title" style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                <span>${m.displayName}</span>
                <span class="status-pill neutral" style="font-size: 10px;">${m.memberKind === 'human' ? 'Human Lead' : 'Agent'}</span>
                <span class="status-pill ${m.status === 'active' ? 'green' : 'gray'}" style="font-size: 10px;">${m.status}</span>
              </div>
              <div class="list-item-subtitle" style="margin-top: 2px;">
                <strong>Role:</strong> ${m.responsibilities ?? 'General collaboration'}
              </div>
              ${
                m.collaborationInstructions
                  ? `<div style="font-size: 11px; color: var(--text-muted); margin-top: 2px; font-style: italic;">
                      "${m.collaborationInstructions}"
                    </div>`
                  : ''
              }
            </div>
            <div class="list-item-trailing" style="display: flex; gap: 4px; align-items: center;">
              ${
                m.memberKind === 'agent' && project.status === 'active'
                  ? m.status === 'active'
                    ? `<button class="btn btn-ghost btn-sm edit-member-btn" data-member="${m.memberId}" title="Edit collaboration instructions">${renderIcon('edit', 12)}</button>
                       <button class="btn btn-ghost btn-sm end-member-btn" data-member="${m.memberId}" title="End Project membership (preserves history)">${renderIcon('close', 12)}</button>`
                    : `<button class="btn btn-secondary btn-sm restore-member-btn" data-member="${m.memberId}" title="Restore Agent membership">${renderIcon('refresh', 12)}</button>`
                  : ''
              }
            </div>
          </div>
        `
          )
          .join('')}
      </div>
    </div>

    <!-- 3. Bound Workspaces & Host Environments Card -->
    <div class="card">
      <div class="card-header">
        <div>
          <span class="card-title">Bound Workspaces & Host Environments</span>
          <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
            ${project.boundEnvironmentWorkspaces.length} Host Binding(s)
          </div>
        </div>
        <button class="btn btn-secondary btn-sm bind-env-btn" title="Bind Host Environment" aria-label="Bind Host Environment" style="width: 32px; height: 32px; min-height: 32px; padding: 0; display: inline-flex; align-items: center; justify-content: center;" ${project.status === 'archived' ? 'disabled' : ''}>
          ${renderIcon('plus', 14)}
        </button>
      </div>

      <div class="card-body" style="display: flex; flex-direction: column; gap: 8px;">
        ${project.boundEnvironmentWorkspaces
          .map((ws) => {
            const env = state.environments.find((e) => e.id === ws.environmentId);
            return `
          <div style="background: var(--bg-surface-elevated); padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
            <div>
              <div style="font-weight: 700; font-size: 13px; display: flex; align-items: center; gap: 6px;">
                ${renderIcon(env?.platform === 'windows' ? 'desktop' : 'server', 14)}
                <span>${env?.displayName || ws.environmentId}</span>
                <span class="status-dot ${env?.trafficLight === 'green' ? 'green' : env?.trafficLight === 'yellow' ? 'yellow' : 'red'}"></span>
              </div>
              <div style="font-size: 11px; color: var(--text-secondary); font-family: var(--font-mono); margin-top: 3px;">
                ${ws.workspaceRoot}/${ws.relativeWorkspacePath}
              </div>
              <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">
                ${env?.trafficLightReason || 'Ready'}
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 6px;">
              <span class="status-pill ${ws.isPrepared ? 'green' : 'yellow'}" style="font-size: 11px;">
                ${ws.isPrepared ? 'Prepared' : 'Pending Prep'}
              </span>
              ${
                project.status === 'active'
                  ? `<button class="btn btn-ghost btn-sm switch-ws-btn" data-env="${ws.environmentId}" title="Switch Workspace relative path">${renderIcon('edit', 12)}</button>
                     <button class="btn btn-ghost btn-sm unbind-env-btn" data-env="${ws.environmentId}" title="Unbind Environment">${renderIcon('trash', 12)}</button>`
                  : ''
              }
            </div>
          </div>
        `;
          })
          .join('')}
      </div>
    </div>
  `;

  // --- Event Listeners for Overview ---

  // Contract Editing
  overviewEl.querySelector('.edit-contract-btn')?.addEventListener('click', () => {
    renderEditContractModal(overviewEl, project);
  });

  // Wake policy toggle
  overviewEl.querySelector('.toggle-policy-btn')?.addEventListener('click', () => {
    const nextPolicy =
      project.wakePolicy === 'wake-model-assisted' ? 'explicit-only' : 'wake-model-assisted';
    stateManager.setProjectWakePolicy(project.id, nextPolicy);
  });

  // Archive Project
  overviewEl.querySelector('.archive-project-btn')?.addEventListener('click', () => {
    if (activeTask) {
      alert(
        `Cannot archive project while Task #${activeTask.id.replace('task-', '')} (${activeTask.lifecycle}, lease ${activeTask.leaseLifecycle}) is active.`
      );
      return;
    }
    if (
      confirm(
        `Are you sure you want to archive "${project.displayName}"? Channels will become read-only and tasks paused. Files on disk will be preserved.`
      )
    ) {
      stateManager.archiveProject(project.id);
    }
  });

  // Restore Project
  overviewEl.querySelector('.restore-project-btn')?.addEventListener('click', () => {
    stateManager.restoreProject(project.id);
  });

  // Add Member
  overviewEl.querySelector('.add-member-btn')?.addEventListener('click', () => {
    renderAddMemberModal(overviewEl, state, project);
  });

  // End Membership
  overviewEl.querySelectorAll('.end-member-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const memberId = (ev.currentTarget as HTMLElement).getAttribute('data-member')!;
      if (
        confirm(
          `End membership for ${memberId}? Historical messages and run attribution will be preserved. Active tasks with this lead will be blocked until reassigned.`
        )
      ) {
        stateManager.endProjectMembership(project.id, memberId);
      }
    });
  });

  // Restore Membership
  overviewEl.querySelectorAll('.restore-member-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const memberId = (ev.currentTarget as HTMLElement).getAttribute('data-member')!;
      stateManager.restoreProjectMembership(project.id, memberId);
    });
  });

  // Edit Member Instructions
  overviewEl.querySelectorAll('.edit-member-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const memberId = (ev.currentTarget as HTMLElement).getAttribute('data-member')!;
      const member = project.memberships.find((m) => m.memberId === memberId);
      if (member) {
        const newInstructions = prompt(
          `Update collaboration instructions for ${member.displayName}:`,
          member.collaborationInstructions ?? ''
        );
        if (newInstructions !== null) {
          stateManager.editProjectMembership(
            project.id,
            memberId,
            member.responsibilities,
            newInstructions.trim()
          );
        }
      }
    });
  });

  // Bind Environment
  overviewEl.querySelector('.bind-env-btn')?.addEventListener('click', () => {
    renderBindEnvironmentModal(overviewEl, state, project);
  });

  // Switch Workspace Path
  overviewEl.querySelectorAll('.switch-ws-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const envId = (ev.currentTarget as HTMLElement).getAttribute('data-env')!;
      const ws = project.boundEnvironmentWorkspaces.find((b) => b.environmentId === envId);
      if (ws) {
        const newPath = prompt(
          `Enter new relative workspace path for ${envId}:`,
          ws.relativeWorkspacePath
        );
        if (newPath && newPath.trim()) {
          stateManager.switchProjectWorkspacePath(project.id, envId, newPath.trim());
        }
      }
    });
  });

  // Unbind Environment
  overviewEl.querySelectorAll('.unbind-env-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const envId = (ev.currentTarget as HTMLElement).getAttribute('data-env')!;
      if (
        confirm(
          `Unbind Environment ${envId} from this Project? Files on host will not be deleted.`
        )
      ) {
        stateManager.unbindEnvironmentFromProject(project.id, envId);
      }
    });
  });

  return overviewEl;
}

function renderProjectInfoModal(
  parentEl: HTMLElement,
  state: PrototypeState,
  project: ProjectItem,
  projectTasks: any[],
  activeTasks: any[],
  validationTasks: any[],
  blockedTasks: any[],
  proposedTasks: any[],
  recoveryTasks: any[],
  activeMembers: any[]
) {
  const modal = document.createElement('div');
  modal.className = 'proto-modal-backdrop';

  modal.innerHTML = `
    <div class="proto-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="info-modal-title">
      <div class="proto-modal-header">
        <strong id="info-modal-title" style="font-size: 15px; display: flex; align-items: center; gap: 8px;">
          ${renderIcon('info', 16)} Project Information & Metadata
        </strong>
        <button class="btn btn-ghost btn-sm close-modal-btn" aria-label="Close modal">${renderIcon('close', 12)}</button>
      </div>

      <div class="proto-modal-body" style="display: flex; flex-direction: column; gap: 10px;">
        <!-- 1. Identity & Template -->
        <div class="card" style="padding: 10px 12px; margin: 0; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle);">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 14px; font-weight: 700;">${project.displayName}</span>
            <span class="status-pill ${project.status === 'active' ? 'green' : 'neutral'}">${project.status}</span>
          </div>
          <div style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); margin-top: 2px;">
            ID: <code>${project.id}</code> · Created: ${project.createdAt}
          </div>
          <div style="font-size: 12px; color: var(--text-secondary); margin-top: 6px;">
            <strong>Template Origin:</strong> <code>${project.templateSource}</code>
          </div>
        </div>

        <!-- 2. Bound Host Workspaces -->
        <div class="card" style="padding: 10px 12px; margin: 0; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle);">
          <div style="font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">
            Bound Workspaces & Host Environments (${project.boundEnvironmentWorkspaces.length})
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px; margin-top: 6px;">
            ${project.boundEnvironmentWorkspaces
              .map((ws) => {
                const env = state.environments.find((e) => e.id === ws.environmentId);
                return `
              <div style="font-size: 12px; display: flex; justify-content: space-between; align-items: center; background: var(--bg-surface); padding: 6px 8px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle);">
                <span style="display: inline-flex; align-items: center; gap: 5px;">
                  ${renderIcon(env?.platform === 'windows' ? 'desktop' : 'server', 13)}
                  <strong>${ws.environmentId}</strong>
                </span>
                <span style="font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary);">${ws.relativeWorkspacePath}</span>
              </div>
            `;
              })
              .join('')}
          </div>
        </div>

        <!-- 3. Memberships -->
        <div class="card" style="padding: 10px 12px; margin: 0; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle);">
          <div style="font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">
            Active Project Members (${activeMembers.length})
          </div>
          <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px; line-height: 1.4;">
            ${activeMembers.map((m) => `<strong>${m.displayName}</strong> (${m.memberKind})`).join(', ')}
          </div>
        </div>

        <!-- 4. Tasks Operating Breakdown -->
        <div class="card" style="padding: 10px 12px; margin: 0; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle);">
          <div style="font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">
            Task Operating Status (${projectTasks.length} Total)
          </div>
          <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px;">
            <span class="status-pill green" style="font-size: 10px;">${activeTasks.length} Active</span>
            <span class="status-pill yellow" style="font-size: 10px;">${validationTasks.length} Validation</span>
            <span class="status-pill red" style="font-size: 10px;">${blockedTasks.length} Blocked</span>
            <span class="status-pill yellow" style="font-size: 10px;">${proposedTasks.length} Proposed</span>
            <span class="status-pill red" style="font-size: 10px;">${recoveryTasks.length} Recovery</span>
          </div>
        </div>

        <!-- 5. Wake Routing Policy -->
        <div class="card" style="padding: 10px 12px; margin: 0; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle);">
          <div style="font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">
            Wake Routing Policy
          </div>
          <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
            <span class="status-pill purple" style="font-size: 11px;">
              ${project.wakePolicy === 'wake-model-assisted' ? 'Wake-Model Assisted (30s batch window)' : 'Explicit Mentions Only'}
            </span>
          </div>
        </div>
      </div>
    </div>
  `;

  modal.querySelectorAll('.close-modal-btn').forEach((b) => b.addEventListener('click', () => modal.remove()));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
  parentEl.appendChild(modal);
}

function renderNewProjectModal(parentEl: HTMLElement) {
  const modal = document.createElement('div');
  modal.className = 'proto-modal-backdrop';

  modal.innerHTML = `
    <div class="proto-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="proto-modal-header">
        <strong id="modal-title" style="font-size: 15px; display: flex; align-items: center; gap: 8px;">
          ${renderIcon('folder', 16)} Create New Project
        </strong>
        <button class="btn btn-ghost btn-sm close-modal-btn" aria-label="Close modal">${renderIcon('close', 12)}</button>
      </div>
      <div class="proto-modal-body">
        <div style="background: var(--bg-surface-elevated); padding: 8px 10px; border-radius: var(--radius-sm); font-size: 12px; color: var(--text-secondary);">
          Derived from immutable built-in: <strong>General collaboration template v1.0</strong>.
        </div>
        <div>
          <label style="font-size: 12px; font-weight: 700;">Project Display Name *</label>
          <input type="text" class="form-input new-proj-name" placeholder="e.g. Vulkan Renderer Engine" style="width: 100%; margin-top: 4px;" />
        </div>
        <div>
          <label style="font-size: 12px; font-weight: 700;">Project Goal</label>
          <textarea class="form-textarea new-proj-goal" rows="2" placeholder="State high-level goal..." style="width: 100%; margin-top: 4px;">Deliver verified high-performance implementation.</textarea>
        </div>
        <div>
          <label style="font-size: 12px; font-weight: 700;">Initial Project Rules (one per line)</label>
          <textarea class="form-textarea new-proj-rules" rows="2" style="width: 100%; margin-top: 4px;">Preserve modular boundaries\nVerify all completion claims with tests</textarea>
        </div>
      </div>
      <div class="proto-modal-footer">
        <button class="btn btn-secondary close-modal-btn">Cancel</button>
        <button class="btn btn-primary create-confirm-btn">Create Project</button>
      </div>
    </div>
  `;

  modal.querySelectorAll('.close-modal-btn').forEach((b) => {
    b.addEventListener('click', () => modal.remove());
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  modal.querySelector('.create-confirm-btn')?.addEventListener('click', () => {
    const nameInput = modal.querySelector('.new-proj-name') as HTMLInputElement;
    const goalInput = modal.querySelector('.new-proj-goal') as HTMLTextAreaElement;
    const rulesInput = modal.querySelector('.new-proj-rules') as HTMLTextAreaElement;

    if (!nameInput.value.trim()) {
      alert('Project display name is required.');
      return;
    }

    const rules = rulesInput.value
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean);
    stateManager.createProject(
      nameInput.value.trim(),
      goalInput.value.trim(),
      rules,
      ['programmer', 'reviewer'],
      ['mac-studio-primary']
    );
    modal.remove();
  });

  parentEl.appendChild(modal);
}

function renderEditContractModal(parentEl: HTMLElement, project: ProjectItem) {
  const modal = document.createElement('div');
  modal.className = 'proto-modal-backdrop';

  modal.innerHTML = `
    <div class="proto-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-contract-title">
      <div class="proto-modal-header">
        <strong id="edit-contract-title" style="font-size: 15px;">Edit Project Contract (${project.displayName})</strong>
        <button class="btn btn-ghost btn-sm close-modal-btn" aria-label="Close">${renderIcon('close', 12)}</button>
      </div>
      <div class="proto-modal-body">
        <div>
          <label style="font-size: 12px; font-weight: 700;">Project Goal</label>
          <textarea class="form-textarea edit-goal-input" rows="3" style="width: 100%; margin-top: 4px;">${project.goal || ''}</textarea>
        </div>
        <div>
          <label style="font-size: 12px; font-weight: 700;">Project Rules (one per line)</label>
          <textarea class="form-textarea edit-rules-input" rows="4" style="width: 100%; margin-top: 4px;">${(project.rules || []).join('\n')}</textarea>
        </div>
        <div>
          <label style="font-size: 12px; font-weight: 700;">Completion Guidance</label>
          <textarea class="form-textarea edit-guidance-input" rows="2" style="width: 100%; margin-top: 4px;">${project.completionGuidance || ''}</textarea>
        </div>
      </div>
      <div class="proto-modal-footer">
        <button class="btn btn-secondary close-modal-btn">Cancel</button>
        <button class="btn btn-primary save-contract-btn">Save Contract</button>
      </div>
    </div>
  `;

  modal.querySelectorAll('.close-modal-btn').forEach((b) => b.addEventListener('click', () => modal.remove()));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  modal.querySelector('.save-contract-btn')?.addEventListener('click', () => {
    const goal = (modal.querySelector('.edit-goal-input') as HTMLTextAreaElement).value.trim();
    const rules = (modal.querySelector('.edit-rules-input') as HTMLTextAreaElement).value
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean);
    const guidance = (modal.querySelector('.edit-guidance-input') as HTMLTextAreaElement).value.trim();

    stateManager.updateProjectContract(project.id, goal, rules, guidance);
    modal.remove();
  });

  parentEl.appendChild(modal);
}

function renderAddMemberModal(parentEl: HTMLElement, state: PrototypeState, project: ProjectItem) {
  const modal = document.createElement('div');
  modal.className = 'proto-modal-backdrop';

  const unassignedAgents = state.agents.filter(
    (a) => a.status === 'active' && !project.memberships.some((m) => m.memberId === a.id && m.status === 'active')
  );

  modal.innerHTML = `
    <div class="proto-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="add-member-title">
      <div class="proto-modal-header">
        <strong id="add-member-title" style="font-size: 15px;">Add Global Agent to Project</strong>
        <button class="btn btn-ghost btn-sm close-modal-btn">${renderIcon('close', 12)}</button>
      </div>
      <div class="proto-modal-body">
        ${
          unassignedAgents.length === 0
            ? `<p style="color: var(--text-muted);">All registered global agents are already active members of this project.</p>`
            : `
          <div>
            <label style="font-size: 12px; font-weight: 700;">Select Global Agent *</label>
            <select class="form-select select-agent-input" style="width: 100%; margin-top: 4px;">
              ${unassignedAgents
                .map((a) => `<option value="${a.id}">${a.displayName} (${a.description})</option>`)
                .join('')}
            </select>
          </div>
          <div>
            <label style="font-size: 12px; font-weight: 700;">Project Assigned Responsibilities</label>
            <input type="text" class="form-input member-resp-input" placeholder="e.g. Lead implementation of graphics shader modules" style="width: 100%; margin-top: 4px;" />
          </div>
          <div>
            <label style="font-size: 12px; font-weight: 700;">Collaboration Instructions</label>
            <textarea class="form-textarea member-instr-input" rows="2" placeholder="e.g. Ensure all shader passes compile without warnings" style="width: 100%; margin-top: 4px;"></textarea>
          </div>
        `
        }
      </div>
      <div class="proto-modal-footer">
        <button class="btn btn-secondary close-modal-btn">Cancel</button>
        ${
          unassignedAgents.length > 0
            ? `<button class="btn btn-primary confirm-add-member-btn">Add to Project</button>`
            : ''
        }
      </div>
    </div>
  `;

  modal.querySelectorAll('.close-modal-btn').forEach((b) => b.addEventListener('click', () => modal.remove()));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  modal.querySelector('.confirm-add-member-btn')?.addEventListener('click', () => {
    const agentSelect = modal.querySelector('.select-agent-input') as HTMLSelectElement;
    const respInput = modal.querySelector('.member-resp-input') as HTMLInputElement;
    const instrInput = modal.querySelector('.member-instr-input') as HTMLTextAreaElement;

    if (agentSelect) {
      stateManager.addProjectMembership(
        project.id,
        agentSelect.value,
        respInput.value.trim() || undefined,
        instrInput.value.trim() || undefined
      );
      modal.remove();
    }
  });

  parentEl.appendChild(modal);
}

function renderBindEnvironmentModal(
  parentEl: HTMLElement,
  state: PrototypeState,
  project: ProjectItem
) {
  const modal = document.createElement('div');
  modal.className = 'proto-modal-backdrop';

  const unassignedEnvs = state.environments.filter(
    (e) => !project.boundEnvironmentWorkspaces.some((b) => b.environmentId === e.id)
  );

  modal.innerHTML = `
    <div class="proto-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="bind-env-title">
      <div class="proto-modal-header">
        <strong id="bind-env-title" style="font-size: 15px;">Bind Environment to Project</strong>
        <button class="btn btn-ghost btn-sm close-modal-btn">${renderIcon('close', 12)}</button>
      </div>
      <div class="proto-modal-body">
        ${
          unassignedEnvs.length === 0
            ? `<p style="color: var(--text-muted);">All enrolled host environments are already bound to this project.</p>`
            : `
          <div>
            <label style="font-size: 12px; font-weight: 700;">Select Enrolled Environment *</label>
            <select class="form-select select-env-input" style="width: 100%; margin-top: 4px;">
              ${unassignedEnvs
                .map((e) => `<option value="${e.id}">${e.displayName} (${e.platform}) · ${e.trafficLightReason}</option>`)
                .join('')}
            </select>
          </div>
          <div>
            <label style="font-size: 12px; font-weight: 700;">Relative Workspace Directory Path *</label>
            <input type="text" class="form-input relative-path-input" value="${project.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}" style="width: 100%; margin-top: 4px;" />
            <span style="font-size: 11px; color: var(--text-muted); margin-top: 2px; display: block;">Relative to host worker workspace root directory.</span>
          </div>
        `
        }
      </div>
      <div class="proto-modal-footer">
        <button class="btn btn-secondary close-modal-btn">Cancel</button>
        ${
          unassignedEnvs.length > 0
            ? `<button class="btn btn-primary confirm-bind-env-btn">Bind & Prepare Workspace</button>`
            : ''
        }
      </div>
    </div>
  `;

  modal.querySelectorAll('.close-modal-btn').forEach((b) => b.addEventListener('click', () => modal.remove()));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  modal.querySelector('.confirm-bind-env-btn')?.addEventListener('click', () => {
    const envSelect = modal.querySelector('.select-env-input') as HTMLSelectElement;
    const pathInput = modal.querySelector('.relative-path-input') as HTMLInputElement;

    if (envSelect && pathInput.value.trim()) {
      const env = state.environments.find((e) => e.id === envSelect.value);
      const root =
        env?.workspaceRoots[0] ||
        (env?.platform === 'windows' ? 'C:\\SproutWorkspaces' : '/Users/workspace/sprout-projects');
      stateManager.bindEnvironmentToProject(project.id, envSelect.value, root, pathInput.value.trim());
      modal.remove();
    }
  });

  parentEl.appendChild(modal);
}
