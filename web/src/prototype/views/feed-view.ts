import { renderIcon } from '../icons.js';
import { stateManager, type PrototypeState } from '../state.js';

export function renderFeedView(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'feed-view';

  const attentionCount = state.attentionItems.length;

  container.innerHTML = `
    <!-- Feed Top Header -->
    <div class="view-header">
      <div class="view-header-title">
        <h2 style="font-size: 18px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
          ${renderIcon('feed', 20)}
          <span>Operations Feed & Human Attention</span>
        </h2>
        <span class="proto-badge">Cross-Project Landing Surface</span>
      </div>
      <p style="font-size: 13px; color: var(--text-secondary); margin-top: 4px;">
        Central stream for cross-project intervention discovery, pending approvals, and real-time multi-agent activity.
      </p>
    </div>

    <!-- Prominent Attention Section -->
    <section class="feed-section attention-section">
      <div class="section-title-bar">
        <div style="display: flex; align-items: center; gap: 8px;">
          ${renderIcon('lightning', 18)}
          <h3 style="font-size: 15px; font-weight: 700;">Human Attention Required</h3>
          <span class="badge badge-yellow">${attentionCount} Pending</span>
        </div>
        <span style="font-size: 11px; color: var(--text-muted);">Ordered by urgency</span>
      </div>

      ${
        attentionCount === 0
          ? `
        <div class="empty-state-box" style="padding: 24px 16px;">
          <div style="color: var(--accent-primary); margin-bottom: 4px;">${renderIcon('check', 28)}</div>
          <h4 style="font-size: 13px; font-weight: 700; margin-top: 6px;">All Attention Items Cleared</h4>
          <p style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
            No agent validation claims, blocked tasks, or offline workers requiring operator intervention.
          </p>
        </div>
      `
          : `
        <div class="attention-items-list" style="display: flex; flex-direction: column; gap: 10px; margin-top: 8px;">
          ${state.attentionItems
            .map((item) => {
              const severityClass =
                item.severity === 'action_required'
                  ? 'badge-red'
                  : item.severity === 'attention'
                    ? 'badge-yellow'
                    : 'badge-info';

              const severityLabel =
                item.severity === 'action_required'
                  ? 'Action Required'
                  : item.severity === 'attention'
                    ? 'Attention'
                    : 'Info';

              const categoryIcon =
                item.category === 'task_validation'
                  ? renderIcon('check', 14)
                  : item.category === 'task_recovery'
                    ? renderIcon('warning', 14)
                    : item.category === 'task_blocker'
                      ? renderIcon('alert', 14)
                      : item.category === 'env_enrollment'
                        ? renderIcon('user', 14)
                        : renderIcon('warning', 14);

              return `
              <div class="attention-card" data-attention-id="${item.id}" data-ref="${item.referenceId}" data-cat="${item.category}">
                <div class="attention-card-header">
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <span>${categoryIcon}</span>
                    <strong style="font-size: 13px;">${item.title}</strong>
                  </div>
                  <span class="badge ${severityClass}">${severityLabel}</span>
                </div>
                <div class="attention-card-summary">${item.summary}</div>
                <div class="attention-card-footer">
                  <span style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);">Ref: ${item.referenceId}</span>
                  <button class="btn btn-primary btn-sm attention-action-btn" data-attention-id="${item.id}">
                    ${item.actionLabel} →
                  </button>
                </div>
              </div>
            `;
            })
            .join('')}
        </div>
      `
      }
    </section>

    <!-- Recent Operational Activity Stream -->
    <section class="feed-section activity-section" style="margin-top: 20px;">
      <div class="section-title-bar">
        <div style="display: flex; align-items: center; gap: 8px;">
          ${renderIcon('usage', 18)}
          <h3 style="font-size: 15px; font-weight: 700;">Recent Operational Activity</h3>
        </div>
        <div class="segmented-control" style="font-size: 11px;">
          <button class="segmented-btn active" data-filter="all">All</button>
          <button class="segmented-btn" data-filter="tasks">Tasks</button>
          <button class="segmented-btn" data-filter="envs">Workers</button>
        </div>
      </div>

      <div class="activity-stream-list" style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
        <!-- Activity Row 1 -->
        <div class="list-item list-item-interactive" data-feed-item="task-101">
          <div class="list-item-leading">
            <span class="status-dot purple"></span>
          </div>
          <div class="list-item-body">
            <div class="list-item-title">Task #101: Programmer submitted validation claim</div>
            <div class="list-item-subtitle">O7 Minesweeper · Touch zoom controls implemented and tested</div>
          </div>
          <div class="list-item-trailing">
            <span class="provenance-tag time">2m ago</span>
            <span class="list-item-chevron">${renderIcon('chevron-right', 14)}</span>
          </div>
        </div>

        <!-- Activity Row 2 -->
        <div class="list-item list-item-interactive" data-feed-item="env-macair">
          <div class="list-item-leading">
            <span class="status-dot yellow"></span>
          </div>
          <div class="list-item-body">
            <div class="list-item-title">New Worker connected: sprout-wk-macair-e018df33</div>
            <div class="list-item-subtitle">Private Overlay · Requesting operator capability approval</div>
          </div>
          <div class="list-item-trailing">
            <span class="provenance-tag time">5m ago</span>
            <span class="list-item-chevron">${renderIcon('chevron-right', 14)}</span>
          </div>
        </div>

        <!-- Activity Row 3 -->
        <div class="list-item list-item-interactive" data-feed-item="task-102">
          <div class="list-item-leading">
            <span class="status-dot blue"></span>
          </div>
          <div class="list-item-body">
            <div class="list-item-title">Task #102: Designer active turn on Sound FX</div>
            <div class="list-item-subtitle">O7 Minesweeper · Codex GPT-4o run-817a in progress</div>
          </div>
          <div class="list-item-trailing">
            <span class="provenance-tag time">8m ago</span>
            <span class="list-item-chevron">${renderIcon('chevron-right', 14)}</span>
          </div>
        </div>

        <!-- Activity Row 4 -->
        <div class="list-item list-item-interactive" data-feed-item="env-windev">
          <div class="list-item-leading">
            <span class="status-dot red"></span>
          </div>
          <div class="list-item-body">
            <div class="list-item-title">Environment win-dev-box heartbeat timed out</div>
            <div class="list-item-subtitle">Task #104 lease held in unconfirmed state</div>
          </div>
          <div class="list-item-trailing">
            <span class="provenance-tag time">12m ago</span>
            <span class="list-item-chevron">${renderIcon('chevron-right', 14)}</span>
          </div>
        </div>
      </div>
    </section>
  `;

  // Attach event listeners for attention action buttons
  container.querySelectorAll('.attention-action-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const attId = (ev.currentTarget as HTMLElement).getAttribute('data-attention-id');
      const item = state.attentionItems.find((a) => a.id === attId);
      if (!item) return;

      if (item.category === 'task_validation' || item.category === 'task_blocker' || item.category === 'task_recovery') {
        stateManager.navigateWithReturn(
          {
            nav: 'project',
            projectTab: 'tasks',
            taskId: item.referenceId,
          },
          'Feed'
        );
      } else if (item.category === 'env_enrollment' || item.category === 'env_unhealthy') {
        stateManager.navigateWithReturn(
          {
            nav: 'manage',
            manageTab: 'environments',
            envId: item.referenceId,
          },
          'Feed'
        );
      }
    });
  });

  // Clicking an attention card deep links as well
  container.querySelectorAll('.attention-card').forEach((card) => {
    card.addEventListener('click', (ev) => {
      const ref = (ev.currentTarget as HTMLElement).getAttribute('data-ref');
      const cat = (ev.currentTarget as HTMLElement).getAttribute('data-cat');
      if (!ref) return;

      if (cat?.startsWith('task')) {
        stateManager.navigateWithReturn(
          {
            nav: 'project',
            projectTab: 'tasks',
            taskId: ref,
          },
          'Feed'
        );
      } else {
        stateManager.navigateWithReturn(
          {
            nav: 'manage',
            manageTab: 'environments',
            envId: ref,
          },
          'Feed'
        );
      }
    });
  });

  return container;
}
