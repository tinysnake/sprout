import { renderIcon } from '../icons.js';
import { stateManager, type PrototypeState } from '../state.js';
import type { AgentDefinition, EngineKind, EnvironmentInstance } from '../types.js';

export function renderAgentsView(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'view-container agents-view';

  const filter = state.agentFilter || 'all';
  const searchQuery = (state.agentSearchQuery || '').toLowerCase().trim();

  // Helper to determine agent traffic light status
  function getAgentTrafficLight(agent: AgentDefinition, envs: EnvironmentInstance[]): {
    trafficLight: 'green' | 'yellow' | 'red' | 'neutral';
    reason: string;
  } {
    if (agent.status === 'archived') {
      return {
        trafficLight: 'neutral',
        reason: 'Archived Agent · Preserved attribution, private memory, and session slots (ADR-0008)',
      };
    }

    if (agent.workOptions.length === 0) {
      return {
        trafficLight: 'red',
        reason: 'Invalid configuration: Agent has no work options. At least one option required (ADR-0008).',
      };
    }

    // Check availability of options across enrolled ready environments
    const readyEnvs = envs.filter((e) => e.enrollmentStatus === 'approved' && e.connectionState === 'online');
    if (readyEnvs.length === 0) {
      return {
        trafficLight: 'yellow',
        reason: 'Attention: No enrolled online environments available for run admission evaluation.',
      };
    }

    const opt1 = agent.workOptions[0]!;
    const opt1ReadyOnAny = readyEnvs.some((e) => e.engineReadiness[opt1.engine] === 'ready');

    if (opt1ReadyOnAny) {
      const fallbackCount = agent.workOptions.length - 1;
      return {
        trafficLight: 'green',
        reason: `Ready: Priority 1 option (${opt1.engine.toUpperCase()} · ${opt1.workModel} · ${opt1.effort}) is ready on online host(s)${
          fallbackCount > 0 ? ` · ${fallbackCount} fallback option(s) configured` : ''
        }.`,
      };
    }

    // Check if any secondary option is ready (pre-acceptance fallback available)
    const anyFallbackReady = agent.workOptions.slice(1).some((opt) =>
      readyEnvs.some((e) => e.engineReadiness[opt.engine] === 'ready')
    );

    if (anyFallbackReady) {
      return {
        trafficLight: 'yellow',
        reason: `Attention: Priority 1 option (${opt1.engine.toUpperCase()} · ${opt1.workModel}) unavailable; pre-acceptance fallback option available at run admission.`,
      };
    }

    return {
      trafficLight: 'red',
      reason: `Action Required: All configured work options (${agent.workOptions
        .map((o) => o.engine.toUpperCase())
        .join(', ')}) are unauthenticated or missing on current environments (ADR-0008).`,
    };
  }

  // Calculate counts for filters
  const allAgents = state.agents;
  const activeCount = allAgents.filter((a) => a.status === 'active').length;
  const attentionCount = allAgents.filter((a) => {
    if (a.status !== 'active') return false;
    const st = getAgentTrafficLight(a, state.environments);
    return st.trafficLight === 'yellow';
  }).length;
  const unavailableCount = allAgents.filter((a) => {
    if (a.status !== 'active') return false;
    const st = getAgentTrafficLight(a, state.environments);
    return st.trafficLight === 'red';
  }).length;
  const archivedCount = allAgents.filter((a) => a.status === 'archived').length;

  // Filter agents
  const filteredAgents = allAgents.filter((a) => {
    // Filter pill match
    if (filter === 'active') {
      if (a.status !== 'active') return false;
    } else if (filter === 'attention') {
      if (a.status !== 'active') return false;
      const st = getAgentTrafficLight(a, state.environments);
      if (st.trafficLight !== 'yellow') return false;
    } else if (filter === 'unavailable') {
      if (a.status !== 'active') return false;
      const st = getAgentTrafficLight(a, state.environments);
      if (st.trafficLight !== 'red') return false;
    } else if (filter === 'archived') {
      if (a.status !== 'archived') return false;
    }

    // Search query match
    if (searchQuery) {
      const matchName = a.displayName.toLowerCase().includes(searchQuery);
      const matchId = a.id.toLowerCase().includes(searchQuery);
      const matchDesc = a.description.toLowerCase().includes(searchQuery);
      const matchOpt = a.workOptions.some(
        (o) =>
          o.engine.toLowerCase().includes(searchQuery) ||
          o.workModel.toLowerCase().includes(searchQuery)
      );
      if (!matchName && !matchId && !matchDesc && !matchOpt) return false;
    }

    return true;
  });

  const selectedAgent =
    allAgents.find((a) => a.id === state.selectedAgentId) ?? filteredAgents[0] ?? allAgents[0];

  // --- 1. Header Area with Filter Bar and Actions ---
  const headerCard = document.createElement('div');
  headerCard.className = 'agents-header-card';
  headerCard.innerHTML = `
    <div class="agents-header-top-row" style="display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: nowrap; width: 100%;">
      <div style="flex: 1; min-width: 0;">
        <h2 style="font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
          ${renderIcon('agents', 18)}
          <span>Agents & Work Option Preferences</span>
        </h2>
      </div>
      <div style="display: flex; gap: 6px; align-items: center; flex-shrink: 0; margin-left: auto;">
        <button class="btn btn-primary btn-sm new-agent-btn icon-only-btn" id="btn-create-agent" title="Create New Agent" aria-label="Create New Agent">
          ${renderIcon('plus', 14)}
        </button>
        <button class="btn btn-secondary btn-sm agent-guide-btn icon-only-btn" id="btn-agent-guide" title="Agent Architecture Guide (ADR-0008)" aria-label="Agent Architecture Guide">
          ${renderIcon('guide', 14)}
        </button>
      </div>
    </div>

    <!-- Filter Row: Modeled after Attention Urgency & Environment Filter Pills -->
    <div class="agent-filter-boxes" role="group" aria-label="Filter agents by status and readiness">
      <button class="agent-filter-box-btn filter-pill ${filter === 'all' ? 'active' : ''}" data-filter="all" title="All (${allAgents.length})">
        <span class="agent-filter-box-top"><span class="status-dot purple"></span> ${allAgents.length}</span>
        <span class="agent-filter-box-bottom">All<span class="sr-only"> (${allAgents.length})</span></span>
      </button>
      <button class="agent-filter-box-btn filter-pill ${filter === 'active' ? 'active' : ''}" data-filter="active" title="Active (${activeCount})">
        <span class="agent-filter-box-top"><span class="status-dot green"></span> ${activeCount}</span>
        <span class="agent-filter-box-bottom">Active<span class="sr-only"> (${activeCount})</span></span>
      </button>
      <button class="agent-filter-box-btn filter-pill ${filter === 'attention' ? 'active' : ''}" data-filter="attention" title="Attention (${attentionCount})">
        <span class="agent-filter-box-top"><span class="status-dot yellow"></span> ${attentionCount}</span>
        <span class="agent-filter-box-bottom">Attention<span class="sr-only"> (${attentionCount})</span></span>
      </button>
      <button class="agent-filter-box-btn filter-pill ${filter === 'unavailable' ? 'active' : ''}" data-filter="unavailable" title="Unavailable (${unavailableCount})">
        <span class="agent-filter-box-top"><span class="status-dot red"></span> ${unavailableCount}</span>
        <span class="agent-filter-box-bottom">Unavailable<span class="sr-only"> (${unavailableCount})</span></span>
      </button>
      <button class="agent-filter-box-btn filter-pill ${filter === 'archived' ? 'active' : ''}" data-filter="archived" title="Archived (${archivedCount})">
        <span class="agent-filter-box-top"><span class="status-dot neutral"></span> ${archivedCount}</span>
        <span class="agent-filter-box-bottom">Archived<span class="sr-only"> (${archivedCount})</span></span>
      </button>
    </div>

    <!-- Search Input -->
    <div class="search-input-wrapper" style="width: 100%;">
      <span style="color: var(--text-muted); display: flex; align-items: center; margin-left: 8px;">
        ${renderIcon('search', 14)}
      </span>
      <input
        type="text"
        class="form-input agent-search-input"
        placeholder="Filter agents by name, description, engine, or model..."
        value="${state.agentSearchQuery || ''}"
        style="padding-left: 30px; font-size: 13px; height: 34px;"
      />
      ${
        state.agentSearchQuery
          ? `<button class="clear-search-btn" style="position: absolute; right: 8px; background: none; border: none; color: var(--text-muted); cursor: pointer;">✕</button>`
          : ''
      }
    </div>
  `;

  headerCard.querySelectorAll('.filter-pill').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const f = (ev.currentTarget as HTMLElement).getAttribute('data-filter')!;
      stateManager.setAgentFilter(f);
    });
  });

  const searchInput = headerCard.querySelector('.agent-search-input') as HTMLInputElement | null;
  searchInput?.addEventListener('input', (ev) => {
    const val = (ev.target as HTMLInputElement).value;
    stateManager.setAgentSearch(val);
  });

  headerCard.querySelector('.clear-search-btn')?.addEventListener('click', () => {
    stateManager.setAgentSearch('');
  });

  headerCard.querySelector('#btn-agent-guide')?.addEventListener('click', () => {
    openAgentGuideDialog();
  });

  headerCard.querySelector('#btn-create-agent')?.addEventListener('click', () => {
    openCreateAgentDialog();
  });

  // --- 2. Master / Detail Layout Construction (Phone & Fluid Parity / Desktop Split) ---
  const isSingleColumn = state.viewportMode === 'mobile' || state.viewportMode === 'fluid';
  const showSingleColumnDetail = isSingleColumn && state.agentViewMode === 'detail' && selectedAgent;

  if (showSingleColumnDetail) {
    // Single Column Detail View: Replace Home Title Bar with Traditional Back Header
    const mobileDetailWrapper = document.createElement('div');
    mobileDetailWrapper.className = 'agents-mobile-detail-wrapper';

    const st = getAgentTrafficLight(selectedAgent, state.environments);

    const mobileBackNav = document.createElement('div');
    mobileBackNav.className = 'mobile-detail-nav-header';
    mobileBackNav.innerHTML = `
      <button class="btn btn-secondary btn-sm back-to-agents-btn" id="btn-back-to-agents" title="Back to Agents" aria-label="Back to agents list">
        ${renderIcon('chevron-left', 14)} <span class="back-btn-text">Back</span>
      </button>
      <div class="mobile-detail-title-wrap">
        <span class="status-dot ${st.trafficLight}"></span>
        <span class="mobile-detail-title-text">${selectedAgent.displayName}</span>
      </div>
      <div class="sr-only">
        Agents & Work Option Preferences
        Active (${activeCount}) Attention (${attentionCount}) Unavailable (${unavailableCount}) Archived (${archivedCount})
      </div>
    `;

    mobileBackNav.querySelector('#btn-back-to-agents')?.addEventListener('click', () => {
      stateManager.closeAgentDetail();
    });

    mobileDetailWrapper.appendChild(mobileBackNav);
    mobileDetailWrapper.appendChild(renderAgentDetailCard(selectedAgent, state, getAgentTrafficLight));

    container.appendChild(headerCard);
    container.appendChild(mobileDetailWrapper);
    return container;
  }

  // Master / Detail Split for Desktop (or Master List for Mobile List Mode)
  const splitLayout = document.createElement('div');
  splitLayout.className = 'agents-split-layout';

  // Left Master Column
  const masterColumn = document.createElement('div');
  masterColumn.className = 'agents-master-column';

  if (filteredAgents.length === 0) {
    masterColumn.innerHTML = `
      <div class="card" style="padding: 24px 16px; text-align: center; color: var(--text-secondary);">
        <p style="font-size: 13px; margin: 0 0 8px 0;">No agents matching filter "${filter}".</p>
        <button class="btn btn-secondary btn-sm" id="btn-reset-agent-filter">Reset Filters</button>
      </div>
    `;
    masterColumn.querySelector('#btn-reset-agent-filter')?.addEventListener('click', () => {
      stateManager.setAgentFilter('all');
      stateManager.setAgentSearch('');
    });
  } else {
    const cardList = document.createElement('div');
    cardList.className = 'agents-card-list';

    filteredAgents.forEach((agent) => {
      const st = getAgentTrafficLight(agent, state.environments);
      const isSelected = selectedAgent && selectedAgent.id === agent.id;
      const opt1 = agent.workOptions[0];

      // Calculate project memberships count
      const memberProjectsCount = state.projects.filter((p) =>
        p.memberships.some((m) => m.memberId === agent.id && m.status === 'active')
      ).length;

      const card = document.createElement('div');
      card.className = `agent-master-card ${isSelected ? 'active' : ''}`;
      card.setAttribute('data-agent-id', agent.id);

      card.innerHTML = `
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">
          <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
            <div class="agent-avatar-badge">
              ${agent.avatar || agent.displayName.slice(0, 2).toUpperCase()}
            </div>
            <div style="min-width: 0;">
              <div style="display: flex; align-items: center; gap: 6px;">
                <strong style="font-size: 14px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                  ${agent.displayName}
                </strong>
                <code style="font-size: 10px; color: var(--text-muted); background: var(--bg-surface-elevated); padding: 1px 4px; border-radius: var(--radius-xs);">
                  ${agent.id}
                </code>
              </div>
              <p style="font-size: 11px; color: var(--text-secondary); margin: 2px 0 0 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                ${agent.description}
              </p>
            </div>
          </div>
          <span class="status-dot ${st.trafficLight}" title="${st.reason}"></span>
        </div>

        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 4px;">
          ${
            opt1
              ? `<span class="badge" style="font-size: 10px; background: var(--bg-surface-elevated); color: var(--text-primary); border: 1px solid var(--border-subtle);">
                  ${opt1.engine.toUpperCase()}: <code>${opt1.workModel}</code>
                </span>`
              : ''
          }
          <span class="badge" style="font-size: 10px; background: var(--bg-surface-elevated); color: var(--text-secondary);">
            ${agent.workOptions.length} opt${agent.workOptions.length !== 1 ? 's' : ''}
          </span>
          <span class="badge" style="font-size: 10px; background: var(--bg-surface-elevated); color: var(--text-secondary);">
            ${memberProjectsCount} proj${memberProjectsCount !== 1 ? 's' : ''}
          </span>
          <span class="badge" style="font-size: 10px; background: var(--bg-surface-elevated); color: var(--text-muted);">
            v${agent.version || 1}
          </span>
        </div>
      `;

      card.addEventListener('click', () => {
        stateManager.selectAgent(agent.id);
      });

      cardList.appendChild(card);
    });

    masterColumn.appendChild(cardList);
  }

  splitLayout.appendChild(masterColumn);

  // Right Detail Column (Desktop view)
  if (!isSingleColumn && selectedAgent) {
    const detailColumn = document.createElement('div');
    detailColumn.className = 'agents-detail-column';
    detailColumn.appendChild(renderAgentDetailCard(selectedAgent, state, getAgentTrafficLight));
    splitLayout.appendChild(detailColumn);
  }

  container.appendChild(headerCard);
  container.appendChild(splitLayout);

  return container;
}

// --- 3. Render Agent Detail Card ---
function renderAgentDetailCard(
  agent: AgentDefinition,
  state: PrototypeState,
  getTrafficLight: (
    agent: AgentDefinition,
    envs: EnvironmentInstance[]
  ) => { trafficLight: 'green' | 'yellow' | 'red' | 'neutral'; reason: string }
): HTMLElement {
  const detailCard = document.createElement('div');
  detailCard.className = 'agent-detail-card';

  const st = getTrafficLight(agent, state.environments);

  // Project Memberships for this agent
  const activeMemberships = state.projects
    .map((p) => {
      const mem = p.memberships.find((m) => m.memberId === agent.id);
      return mem ? { project: p, membership: mem } : null;
    })
    .filter((item): item is { project: (typeof state.projects)[0]; membership: (typeof state.projects)[0]['memberships'][0] } => item !== null);

  const activeProjectsCount = activeMemberships.filter((m) => m.membership.status === 'active').length;
  const endedProjectsCount = activeMemberships.filter((m) => m.membership.status === 'ended').length;

  detailCard.innerHTML = `
    <!-- Top Summary Banner & Mandatory Decisive Status -->
    <div class="env-traffic-light-banner ${st.trafficLight}" style="margin-bottom: 4px;">
      <div class="env-traffic-light-header">
        <span class="status-dot ${st.trafficLight}"></span>
        <strong style="font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em;">
          ${st.trafficLight === 'green' ? 'Ready' : st.trafficLight === 'yellow' ? 'Attention / Degraded' : st.trafficLight === 'red' ? 'Action Required' : 'Archived'}
        </strong>
      </div>
      <div class="env-traffic-light-fact" style="font-size: 12px; line-height: 1.4; margin-top: 4px;">
        <strong>Decisive Fact:</strong> ${st.reason}
      </div>
    </div>

    <!-- Section 1: Agent Identity & Core Facts (2x2 Grid) -->
    <div style="display: flex; flex-direction: column; gap: 8px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 13px; font-weight: 700; color: var(--text-primary);">
          Agent Identity & Portability Metadata
        </span>
        <span style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);">
          ADR-0008 Portable Boundary
        </span>
      </div>

      <div class="dimensions-2x2-grid">
        <div class="dimension-item">
          <div class="dimension-item-top">
            <span class="dimension-item-label">Stable Identity</span>
            <span class="dimension-item-sub"><code>${agent.id}</code></span>
          </div>
          <div class="dimension-item-action">
            <span class="badge" style="background: var(--bg-surface-elevated); color: var(--text-primary); font-size: 10px;">
              ${agent.displayName}
            </span>
          </div>
        </div>

        <div class="dimension-item">
          <div class="dimension-item-top">
            <span class="dimension-item-label">Status & Version</span>
            <span class="dimension-item-sub">Updated ${agent.updatedAt || 'Recently'}</span>
          </div>
          <div class="dimension-item-action">
            <span class="badge ${agent.status === 'active' ? 'badge-success' : 'badge-neutral'}" style="font-size: 10px;">
              ${agent.status.toUpperCase()} · v${agent.version || 1}
            </span>
          </div>
        </div>

        <div class="dimension-item">
          <div class="dimension-item-top">
            <span class="dimension-item-label">Private Memory</span>
            <span class="dimension-item-sub">Preserved across projects</span>
          </div>
          <div class="dimension-item-action">
            <span class="badge" style="background: var(--bg-surface-elevated); color: var(--text-secondary); font-size: 10px;">
              ${agent.privateMemoryEntriesCount} memory entries
            </span>
          </div>
        </div>

        <div class="dimension-item">
          <div class="dimension-item-top">
            <span class="dimension-item-label">Project Memberships</span>
            <span class="dimension-item-sub">${activeProjectsCount} active / ${endedProjectsCount} ended</span>
          </div>
          <div class="dimension-item-action">
            <span class="badge" style="background: var(--purple-agent-bg); color: var(--purple-agent); font-size: 10px;">
              ${activeProjectsCount} active project(s)
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Section 2: Standing Instructions -->
    <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 12px; display: flex; flex-direction: column; gap: 6px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 12px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em;">
          Standing Instructions (Optional)
        </span>
        ${
          agent.status === 'active'
            ? `<button class="btn btn-ghost btn-sm edit-instructions-btn" id="btn-edit-instructions" style="font-size: 11px; padding: 2px 6px;">
                ${renderIcon('edit', 12)} Edit
              </button>`
            : ''
        }
      </div>
      <p style="font-size: 13px; color: var(--text-primary); line-height: 1.4; margin: 0;">
        ${agent.standingInstructions ? agent.standingInstructions : `<em style="color: var(--text-muted);">No standing instructions configured. Standing instructions provide persistent guidance across all projects and tasks.</em>`}
      </p>
    </div>

    <!-- Section 3: Ordered Work Options (Execution Preferences) -->
    <div style="display: flex; flex-direction: column; gap: 10px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <span style="font-size: 13px; font-weight: 700; color: var(--text-primary);">
            Ordered Execution Preferences (Work Options)
          </span>
          <p style="font-size: 11px; color: var(--text-muted); margin: 2px 0 0 0;">
            Evaluated in priority order at run admission. Sprout chooses the first available option (ADR-0008).
          </p>
        </div>
        ${
          agent.status === 'active'
            ? `<button class="btn btn-secondary btn-sm add-option-btn" id="btn-add-option" style="font-size: 12px;">
                ${renderIcon('plus', 12)} Add Option
              </button>`
            : ''
        }
      </div>

      <!-- Work Options List -->
      <div style="display: flex; flex-direction: column; gap: 6px;">
        ${agent.workOptions
          .map((opt, idx) => {
            const isFirst = idx === 0;
            const isLast = idx === agent.workOptions.length - 1;

            // Check readiness across enrolled environments
            const matchingReadyEnvs = state.environments.filter(
              (e) => e.enrollmentStatus === 'approved' && e.engineReadiness[opt.engine] === 'ready'
            );
            const isReadyOnAny = matchingReadyEnvs.length > 0;

            return `
              <div class="agent-option-row" data-option-id="${opt.id}">
                <div class="agent-option-info">
                  <span class="badge ${isFirst ? 'badge-primary' : 'badge-neutral'}" style="font-size: 10px; font-weight: 700;">
                    Priority ${idx + 1}${isFirst ? ' (Primary)' : ' (Fallback)'}
                  </span>
                  <strong style="font-size: 13px; color: var(--text-primary);">
                    ${opt.engine.toUpperCase()}
                  </strong>
                  <span style="font-size: 12px; color: var(--text-secondary);">
                    Model: <code style="color: var(--accent-primary);">${opt.workModel}</code>
                  </span>
                  <span class="status-pill purple" style="font-size: 10px; padding: 2px 6px;">
                    Effort: ${opt.effort}
                  </span>
                  <span class="badge ${isReadyOnAny ? 'badge-success' : 'badge-warning'}" style="font-size: 10px;">
                    ${isReadyOnAny ? `Ready on ${matchingReadyEnvs.length} host(s)` : 'Unavailable / Login Req'}
                  </span>
                </div>

                ${
                  agent.status === 'active'
                    ? `<div class="agent-option-actions">
                        <button class="btn btn-ghost btn-sm move-up-btn" data-opt="${opt.id}" ${isFirst ? 'disabled' : ''} title="Move Up (Increase Priority)" aria-label="Move Up">
                          ${renderIcon('arrow-up', 12)}
                        </button>
                        <button class="btn btn-ghost btn-sm move-down-btn" data-opt="${opt.id}" ${isLast ? 'disabled' : ''} title="Move Down (Decrease Priority)" aria-label="Move Down">
                          ${renderIcon('arrow-down', 12)}
                        </button>
                        <button class="btn btn-ghost btn-sm delete-opt-btn" data-opt="${opt.id}" ${agent.workOptions.length <= 1 ? 'disabled title="An Agent must have at least one work option (ADR-0008)"' : 'title="Remove Option"'} aria-label="Remove Option">
                          ${renderIcon('trash', 12)}
                        </button>
                      </div>`
                    : ''
                }
              </div>
            `;
          })
          .join('')}
      </div>

      <!-- Pre-Acceptance Fallback & No-Replay Guarantee Invariant Card -->
      <div class="agent-fallback-box">
        <div style="display: flex; align-items: center; gap: 6px; color: var(--accent-primary); font-weight: 700;">
          ${renderIcon('shield', 14)}
          <span>Pre-Acceptance Fallback & No-Silent-Replay Guarantee (ADR-0008)</span>
        </div>
        <p style="margin: 0; color: var(--text-secondary); line-height: 1.4;">
          1. <strong>Pre-Acceptance Fallback</strong>: At run admission, Sprout takes the first configured option permitted and authenticated on the target Environment.
        </p>
        <p style="margin: 0; color: var(--text-secondary); line-height: 1.4;">
          2. <strong>No Silent Replay</strong>: Once an engine accepts the run, any later failure is reported directly as an error. Sprout <em>never</em> silently replays work through lower-priority options because tools may have already caused irreversible side effects.
        </p>
      </div>
    </div>

    <!-- Section 4: Environment Compatibility Matrix & Admission Simulator -->
    <div style="display: flex; flex-direction: column; gap: 8px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 13px; font-weight: 700; color: var(--text-primary);">
          Environment Compatibility & Admission Evaluation
        </span>
        <span style="font-size: 11px; color: var(--text-muted);">Neutral Host Facts</span>
      </div>

      <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 10px; display: flex; flex-direction: column; gap: 6px; font-size: 12px;">
        ${state.environments
          .map((env) => {
            const evalResult = stateManager.evaluateAdmissionFallback(agent.id, env.id);
            const matchedOpt = evalResult?.selectedOption;
            const isCompatible = Boolean(matchedOpt);

            return `
              <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-subtle); padding-bottom: 6px; gap: 8px;">
                <div style="min-width: 0;">
                  <strong style="color: var(--text-primary);">${env.displayName}</strong>
                  <span style="color: var(--text-muted); font-size: 11px;"> (${env.platform} · ${env.connectionState})</span>
                </div>
                <div style="text-align: right; flex-shrink: 0;">
                  ${
                    isCompatible
                      ? `<span class="badge badge-success" style="font-size: 10px;">
                          Admitted via ${matchedOpt?.engine.toUpperCase()} (<code>${matchedOpt?.workModel}</code>)
                        </span>`
                      : `<span class="badge badge-warning" style="font-size: 10px;">
                          No compatible option ready
                        </span>`
                  }
                </div>
              </div>
            `;
          })
          .join('')}

        <!-- Interactive Admission Simulation Row -->
        <div style="margin-top: 6px; padding-top: 6px; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <label for="sim-env-select" style="font-size: 11px; font-weight: 600; color: var(--text-secondary);">Simulate on:</label>
            <select id="sim-env-select" class="form-select" style="font-size: 11px; padding: 2px 6px; height: 26px; width: auto;">
              ${state.environments.map((e) => `<option value="${e.id}">${e.displayName}</option>`).join('')}
            </select>
          </div>
          <button class="btn btn-secondary btn-sm" id="btn-run-simulation" style="font-size: 11px; padding: 3px 8px;">
            ${renderIcon('play', 10)} Test Admission Fallback
          </button>
        </div>

        <!-- Simulation Output Box (populated on test) -->
        <div id="simulation-output-box" style="display: none; margin-top: 6px;"></div>
      </div>
    </div>

    <!-- Section 5: Project Memberships & Responsibilities -->
    <div style="display: flex; flex-direction: column; gap: 8px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 13px; font-weight: 700; color: var(--text-primary);">
          Project Memberships & Responsibilities
        </span>
        <span style="font-size: 11px; color: var(--text-muted);">${activeMemberships.length} Total Binding(s)</span>
      </div>

      <div style="display: flex; flex-direction: column; gap: 6px;">
        ${
          activeMemberships.length === 0
            ? `<div class="card" style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 12px;">
                Agent has not been added to any Project memberships yet. (Add via Project Overview).
              </div>`
            : activeMemberships
                .map(
                  ({ project, membership }) => `
              <div class="agent-membership-row">
                <div class="agent-membership-row-top">
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <strong style="color: var(--text-primary); font-size: 13px;">${project.displayName}</strong>
                    <code style="font-size: 10px; color: var(--text-muted);">${project.id}</code>
                  </div>
                  <span class="badge ${membership.status === 'active' ? 'badge-success' : 'badge-neutral'}" style="font-size: 10px;">
                    ${membership.status.toUpperCase()}
                  </span>
                </div>
                <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
                  <strong>Responsibility:</strong> ${membership.responsibilities || 'General collaboration'}
                </div>
                ${
                  membership.collaborationInstructions
                    ? `<div style="font-size: 11px; color: var(--text-muted);">
                        <strong>Instructions:</strong> ${membership.collaborationInstructions}
                      </div>`
                    : ''
                }
              </div>
            `
                )
                .join('')
        }
      </div>
    </div>

    <!-- Section 6: Configuration History & Versioning -->
    <div style="display: flex; flex-direction: column; gap: 8px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 13px; font-weight: 700; color: var(--text-primary);">
          Configuration Version Changelog
        </span>
        <span style="font-size: 11px; color: var(--text-muted);">Current: v${agent.version || 1}</span>
      </div>

      <div style="display: flex; flex-direction: column; gap: 6px;">
        ${
          (agent.versionHistory && agent.versionHistory.length > 0)
            ? agent.versionHistory
                .map(
                  (v) => `
              <div class="agent-version-row">
                <div class="agent-version-row-top">
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <span class="badge badge-primary" style="font-size: 10px; font-weight: 700;">v${v.version}</span>
                    <strong style="font-size: 12px; color: var(--text-primary);">${v.changeSummary}</strong>
                  </div>
                  <span style="font-size: 10px; color: var(--text-muted);">${v.timestamp}</span>
                </div>
                <div style="font-size: 11px; color: var(--text-muted);">
                  By ${v.author} · ${v.optionsCount} work option(s) configured
                </div>
              </div>
            `
                )
                .join('')
            : `<div class="agent-version-row">
                <div class="agent-version-row-top">
                  <span class="badge badge-primary" style="font-size: 10px;">v1</span>
                  <span style="font-size: 10px; color: var(--text-muted);">${agent.createdAt || 'Initial'}</span>
                </div>
                <div style="font-size: 11px; color: var(--text-muted);">Initial Agent definition created.</div>
              </div>`
        }
      </div>
    </div>

    <!-- Section 7: Attribution Trace & Historical Safety -->
    <div style="display: flex; flex-direction: column; gap: 8px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 13px; font-weight: 700; color: var(--text-primary);">
          Historical Run Attribution & Provenance
        </span>
        <button class="btn btn-ghost btn-sm" id="btn-view-attribution" style="font-size: 11px;">
          ${renderIcon('history', 12)} Full Trace (${agent.attributionHistory?.length || 0})
        </button>
      </div>

      <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 10px; font-size: 12px; color: var(--text-secondary); line-height: 1.4;">
        <p style="margin: 0 0 6px 0;">
          Historical Messages, Task runs, and completion claims permanently retain the exact Agent configuration version, engine, model, and effort used at execution time.
        </p>
        <span class="badge badge-neutral" style="font-size: 10px;">
          ${agent.attributionHistory?.length || 0} recorded execution facts · Attribution survives rename & archive
        </span>
      </div>
    </div>

    <!-- Section 8: Operations Toolbar -->
    <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-subtle); padding-top: 12px; margin-top: 4px; flex-wrap: wrap; gap: 8px;">
      <div style="display: flex; gap: 6px;">
        ${
          agent.status === 'active'
            ? `<button class="btn btn-secondary btn-sm edit-agent-btn" id="btn-edit-agent">
                ${renderIcon('edit', 12)} Edit Agent
              </button>`
            : ''
        }
      </div>
      <div>
        ${
          agent.status === 'active'
            ? `<button class="btn btn-secondary btn-sm archive-agent-btn" id="btn-archive-agent" style="color: var(--red-action); border-color: var(--red-action-border);">
                ${renderIcon('archive', 12)} Archive Agent
              </button>`
            : `<button class="btn btn-primary btn-sm restore-agent-btn" id="btn-restore-agent">
                ${renderIcon('refresh', 12)} Restore Agent
              </button>`
        }
      </div>
    </div>
  `;

  // Attach Event Listeners
  detailCard.querySelector('#btn-edit-instructions')?.addEventListener('click', () => {
    openEditInstructionsDialog(agent);
  });

  detailCard.querySelector('#btn-edit-agent')?.addEventListener('click', () => {
    openEditAgentDialog(agent);
  });

  detailCard.querySelector('#btn-add-option')?.addEventListener('click', () => {
    openAddWorkOptionDialog(agent);
  });

  detailCard.querySelectorAll('.move-up-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const optId = (ev.currentTarget as HTMLElement).getAttribute('data-opt')!;
      stateManager.moveAgentWorkOption(agent.id, optId, 'up');
    });
  });

  detailCard.querySelectorAll('.move-down-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const optId = (ev.currentTarget as HTMLElement).getAttribute('data-opt')!;
      stateManager.moveAgentWorkOption(agent.id, optId, 'down');
    });
  });

  detailCard.querySelectorAll('.delete-opt-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const optId = (ev.currentTarget as HTMLElement).getAttribute('data-opt')!;
      stateManager.removeAgentWorkOption(agent.id, optId);
    });
  });

  detailCard.querySelector('#btn-archive-agent')?.addEventListener('click', () => {
    openArchiveConfirmDialog(agent);
  });

  detailCard.querySelector('#btn-restore-agent')?.addEventListener('click', () => {
    stateManager.restoreAgent(agent.id);
  });

  detailCard.querySelector('#btn-view-attribution')?.addEventListener('click', () => {
    openAttributionHistoryDialog(agent);
  });

  // Admission Fallback Simulation Handler
  const simSelect = detailCard.querySelector('#sim-env-select') as HTMLSelectElement | null;
  const simBtn = detailCard.querySelector('#btn-run-simulation');
  const simOutput = detailCard.querySelector('#simulation-output-box') as HTMLElement | null;

  simBtn?.addEventListener('click', () => {
    if (!simSelect || !simOutput) return;
    const envId = simSelect.value;
    const res = stateManager.evaluateAdmissionFallback(agent.id, envId);
    if (!res) return;

    simOutput.style.display = 'block';
    simOutput.innerHTML = `
      <div class="agent-simulation-result">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <strong style="color: var(--text-primary); font-size: 12px;">Evaluation for ${res.environment.displayName}:</strong>
          <span class="badge ${res.selectedOption ? 'badge-success' : 'badge-danger'}" style="font-size: 10px;">
            ${res.selectedOption ? `Admitted Option: ${res.selectedOption.engine.toUpperCase()}` : 'Admission Refused'}
          </span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 4px;">
          ${res.evaluationSteps
            .map(
              (step) => `
            <div class="agent-sim-step">
              <span class="badge ${step.status === 'selected' ? 'badge-success' : 'badge-neutral'}" style="font-size: 10px; flex-shrink: 0;">
                P${step.priority}: ${step.option.engine.toUpperCase()}
              </span>
              <span style="font-size: 11px; color: ${step.status === 'selected' ? 'var(--green-ready)' : 'var(--text-secondary)'};">
                ${step.reason}
              </span>
            </div>
          `
            )
            .join('')}
        </div>
        <div style="font-size: 10px; color: var(--text-muted); margin-top: 4px; line-height: 1.3;">
          ${res.guaranteeNote}
        </div>
      </div>
    `;
  });

  return detailCard;
}

// --- 4. Interactive Dialogs & Modals ---

function openCreateAgentDialog() {
  const existing = document.getElementById('dialog-create-agent');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'dialog-create-agent';
  overlay.className = 'modal-backdrop';

  overlay.innerHTML = `
    <div class="modal-dialog" style="max-width: 520px; width: 92%;">
      <div class="modal-header">
        <div style="display: flex; align-items: center; gap: 8px;">
          ${renderIcon('bot', 18)}
          <strong style="font-size: 15px;">Create Global Agent Definition</strong>
        </div>
        <button class="btn btn-ghost btn-sm close-modal-btn" aria-label="Close dialog">${renderIcon('close', 14)}</button>
      </div>
      <div class="modal-body" style="display: flex; flex-direction: column; gap: 12px;">
        <p style="font-size: 12px; color: var(--text-secondary); margin: 0;">
          Agent identity is portable across Projects and Environments. An Agent requires a stable identity, non-empty display name, and at least one ordered work option (ADR-0008).
        </p>

        <div style="display: flex; flex-direction: column; gap: 4px;">
          <label class="form-label" for="new-agent-name">Display Name *</label>
          <input type="text" id="new-agent-name" class="form-input" placeholder="e.g. Security Auditor, Frontend Engineer" required />
        </div>

        <div style="display: flex; flex-direction: column; gap: 4px;">
          <label class="form-label" for="new-agent-desc">Description *</label>
          <input type="text" id="new-agent-desc" class="form-input" placeholder="e.g. Vulnerability scanning, dependency audit" required />
        </div>

        <div style="display: flex; flex-direction: column; gap: 4px;">
          <label class="form-label" for="new-agent-instructions">Standing Instructions (Optional)</label>
          <textarea id="new-agent-instructions" class="form-textarea" rows="2" placeholder="Standing instructions applied across all tasks and projects..."></textarea>
        </div>

        <div style="border-top: 1px solid var(--border-subtle); padding-top: 10px; display: flex; flex-direction: column; gap: 8px;">
          <span style="font-size: 12px; font-weight: 700; color: var(--text-primary);">
            Primary Work Option (Priority 1)
          </span>
          <div style="display: grid; grid-template-columns: 1fr 1.5fr 1fr; gap: 8px;">
            <div>
              <label class="form-label" for="new-opt-engine" style="font-size: 11px;">Engine</label>
              <select id="new-opt-engine" class="form-select" style="font-size: 12px;">
                <option value="pi" selected>Pi</option>
                <option value="codex">Codex</option>
                <option value="agy">agy</option>
                <option value="opencode">opencode</option>
              </select>
            </div>
            <div>
              <label class="form-label" for="new-opt-model" style="font-size: 11px;">Work Model</label>
              <input type="text" id="new-opt-model" class="form-input" value="claude-3-5-sonnet" style="font-size: 12px;" />
            </div>
            <div>
              <label class="form-label" for="new-opt-effort" style="font-size: 11px;">Effort</label>
              <select id="new-opt-effort" class="form-select" style="font-size: 12px;">
                <option value="high" selected>high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
                <option value="default">default</option>
              </select>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 8px;">
        <button class="btn btn-secondary btn-sm close-modal-btn">Cancel</button>
        <button class="btn btn-primary btn-sm" id="btn-confirm-create-agent">Create Agent</button>
      </div>
    </div>
  `;

  overlay.querySelectorAll('.close-modal-btn').forEach((btn) => {
    btn.addEventListener('click', () => overlay.remove());
  });

  overlay.querySelector('#btn-confirm-create-agent')?.addEventListener('click', () => {
    const nameInput = overlay.querySelector('#new-agent-name') as HTMLInputElement | null;
    const descInput = overlay.querySelector('#new-agent-desc') as HTMLInputElement | null;
    const instInput = overlay.querySelector('#new-agent-instructions') as HTMLTextAreaElement | null;
    const engineSelect = overlay.querySelector('#new-opt-engine') as HTMLSelectElement | null;
    const modelInput = overlay.querySelector('#new-opt-model') as HTMLInputElement | null;
    const effortSelect = overlay.querySelector('#new-opt-effort') as HTMLSelectElement | null;

    const name = nameInput?.value.trim();
    const desc = descInput?.value.trim() || 'Specialized agent.';
    const instructions = instInput?.value.trim();
    const engine = (engineSelect?.value || 'pi') as EngineKind;
    const model = modelInput?.value.trim() || 'claude-3-5-sonnet';
    const effort = (effortSelect?.value || 'high') as 'low' | 'medium' | 'high' | 'default';

    if (!name) {
      alert('Please enter a display name for the agent.');
      return;
    }

    stateManager.createAgent({
      displayName: name,
      description: desc,
      standingInstructions: instructions,
      workOptions: [
        {
          id: `opt-${Date.now()}-1`,
          engine,
          workModel: model,
          effort,
          isConfigured: true,
        },
      ],
    });

    overlay.remove();
  });

  document.body.appendChild(overlay);
}

function openEditAgentDialog(agent: AgentDefinition) {
  const existing = document.getElementById('dialog-edit-agent');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'dialog-edit-agent';
  overlay.className = 'modal-backdrop';

  overlay.innerHTML = `
    <div class="modal-dialog" style="max-width: 480px; width: 92%;">
      <div class="modal-header">
        <strong style="font-size: 15px;">Edit Agent Identity (${agent.id})</strong>
        <button class="btn btn-ghost btn-sm close-modal-btn" aria-label="Close dialog">${renderIcon('close', 14)}</button>
      </div>
      <div class="modal-body" style="display: flex; flex-direction: column; gap: 12px;">
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <label class="form-label" for="edit-agent-name">Display Name</label>
          <input type="text" id="edit-agent-name" class="form-input" value="${agent.displayName}" required />
        </div>
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <label class="form-label" for="edit-agent-desc">Description</label>
          <input type="text" id="edit-agent-desc" class="form-input" value="${agent.description}" required />
        </div>
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <label class="form-label" for="edit-agent-inst">Standing Instructions</label>
          <textarea id="edit-agent-inst" class="form-textarea" rows="3">${agent.standingInstructions || ''}</textarea>
        </div>
        <div style="font-size: 11px; color: var(--text-muted);">
          Editing agent facts creates version v${(agent.version || 1) + 1}. Past run attributions and active sessions retain their historical versions.
        </div>
      </div>
      <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 8px;">
        <button class="btn btn-secondary btn-sm close-modal-btn">Cancel</button>
        <button class="btn btn-primary btn-sm" id="btn-confirm-save-agent">Save Changes</button>
      </div>
    </div>
  `;

  overlay.querySelectorAll('.close-modal-btn').forEach((btn) => {
    btn.addEventListener('click', () => overlay.remove());
  });

  overlay.querySelector('#btn-confirm-save-agent')?.addEventListener('click', () => {
    const nameInput = overlay.querySelector('#edit-agent-name') as HTMLInputElement | null;
    const descInput = overlay.querySelector('#edit-agent-desc') as HTMLInputElement | null;
    const instInput = overlay.querySelector('#edit-agent-inst') as HTMLTextAreaElement | null;

    const name = nameInput?.value.trim();
    const desc = descInput?.value.trim();
    const instructions = instInput?.value;

    if (!name) {
      alert('Display name cannot be empty.');
      return;
    }

    stateManager.updateAgentIdentity(agent.id, {
      displayName: name,
      description: desc,
      standingInstructions: instructions,
    });

    overlay.remove();
  });

  document.body.appendChild(overlay);
}

function openEditInstructionsDialog(agent: AgentDefinition) {
  const existing = document.getElementById('dialog-edit-inst');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'dialog-edit-inst';
  overlay.className = 'modal-backdrop';

  overlay.innerHTML = `
    <div class="modal-dialog" style="max-width: 480px; width: 92%;">
      <div class="modal-header">
        <strong style="font-size: 15px;">Edit Standing Instructions</strong>
        <button class="btn btn-ghost btn-sm close-modal-btn" aria-label="Close dialog">${renderIcon('close', 14)}</button>
      </div>
      <div class="modal-body" style="display: flex; flex-direction: column; gap: 8px;">
        <p style="font-size: 12px; color: var(--text-secondary); margin: 0;">
          Standing instructions are global to Agent <strong>${agent.displayName}</strong> and apply to all future runs across all Projects.
        </p>
        <textarea id="edit-standing-inst-textarea" class="form-textarea" rows="4" placeholder="Enter standing instructions...">${agent.standingInstructions || ''}</textarea>
      </div>
      <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 8px;">
        <button class="btn btn-secondary btn-sm close-modal-btn">Cancel</button>
        <button class="btn btn-primary btn-sm" id="btn-save-instructions">Save Instructions</button>
      </div>
    </div>
  `;

  overlay.querySelectorAll('.close-modal-btn').forEach((btn) => {
    btn.addEventListener('click', () => overlay.remove());
  });

  overlay.querySelector('#btn-save-instructions')?.addEventListener('click', () => {
    const textarea = overlay.querySelector('#edit-standing-inst-textarea') as HTMLTextAreaElement | null;
    stateManager.updateAgentIdentity(agent.id, {
      standingInstructions: textarea?.value || '',
    });
    overlay.remove();
  });

  document.body.appendChild(overlay);
}

function openAddWorkOptionDialog(agent: AgentDefinition) {
  const existing = document.getElementById('dialog-add-opt');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'dialog-add-opt';
  overlay.className = 'modal-backdrop';

  overlay.innerHTML = `
    <div class="modal-dialog" style="max-width: 440px; width: 92%;">
      <div class="modal-header">
        <strong style="font-size: 15px;">Add Work Option (Priority ${agent.workOptions.length + 1})</strong>
        <button class="btn btn-ghost btn-sm close-modal-btn" aria-label="Close dialog">${renderIcon('close', 14)}</button>
      </div>
      <div class="modal-body" style="display: flex; flex-direction: column; gap: 12px;">
        <p style="font-size: 12px; color: var(--text-secondary); margin: 0;">
          Configure an execution fallback option. Sprout evaluates options in priority order at run admission (ADR-0008).
        </p>

        <div style="display: flex; flex-direction: column; gap: 4px;">
          <label class="form-label" for="add-opt-engine">Engine *</label>
          <select id="add-opt-engine" class="form-select">
            <option value="pi">Pi</option>
            <option value="codex">Codex</option>
            <option value="agy">agy</option>
            <option value="opencode">opencode</option>
          </select>
        </div>

        <div style="display: flex; flex-direction: column; gap: 4px;">
          <label class="form-label" for="add-opt-model">Work Model *</label>
          <input type="text" id="add-opt-model" class="form-input" value="gpt-4o" required />
        </div>

        <div style="display: flex; flex-direction: column; gap: 4px;">
          <label class="form-label" for="add-opt-effort">Reasoning Effort</label>
          <select id="add-opt-effort" class="form-select">
            <option value="high">high</option>
            <option value="medium" selected>medium</option>
            <option value="low">low</option>
            <option value="default">default</option>
          </select>
        </div>
      </div>
      <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 8px;">
        <button class="btn btn-secondary btn-sm close-modal-btn">Cancel</button>
        <button class="btn btn-primary btn-sm" id="btn-confirm-add-option">Add Option</button>
      </div>
    </div>
  `;

  overlay.querySelectorAll('.close-modal-btn').forEach((btn) => {
    btn.addEventListener('click', () => overlay.remove());
  });

  overlay.querySelector('#btn-confirm-add-option')?.addEventListener('click', () => {
    const engineSelect = overlay.querySelector('#add-opt-engine') as HTMLSelectElement | null;
    const modelInput = overlay.querySelector('#add-opt-model') as HTMLInputElement | null;
    const effortSelect = overlay.querySelector('#add-opt-effort') as HTMLSelectElement | null;

    const engine = (engineSelect?.value || 'pi') as EngineKind;
    const model = modelInput?.value.trim() || 'gpt-4o';
    const effort = (effortSelect?.value || 'medium') as 'low' | 'medium' | 'high' | 'default';

    stateManager.addAgentWorkOption(agent.id, {
      engine,
      workModel: model,
      effort,
      isConfigured: true,
    });

    overlay.remove();
  });

  document.body.appendChild(overlay);
}

function openArchiveConfirmDialog(agent: AgentDefinition) {
  const existing = document.getElementById('dialog-archive-agent');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'dialog-archive-agent';
  overlay.className = 'modal-backdrop';

  overlay.innerHTML = `
    <div class="modal-dialog" style="max-width: 460px; width: 92%;">
      <div class="modal-header">
        <div style="display: flex; align-items: center; gap: 8px; color: var(--red-action);">
          ${renderIcon('archive', 18)}
          <strong style="font-size: 15px;">Archive Agent "${agent.displayName}"?</strong>
        </div>
        <button class="btn btn-ghost btn-sm close-modal-btn" aria-label="Close dialog">${renderIcon('close', 14)}</button>
      </div>
      <div class="modal-body" style="display: flex; flex-direction: column; gap: 10px; font-size: 12px; color: var(--text-secondary); line-height: 1.4;">
        <p style="margin: 0;">
          Archiving an Agent is a <strong>non-destructive</strong> operation (ADR-0008):
        </p>
        <ul style="margin: 0; padding-left: 18px;">
          <li>Prevents new project memberships, messages, and task runs.</li>
          <li>Strictly preserves all historical run attributions, messages, private memory, and engine session slots.</li>
          <li>Can be restored at any time by the operator.</li>
        </ul>
        <p style="margin: 0; color: var(--text-muted); font-size: 11px;">
          Safety Guard: An Agent cannot be archived while it has an active run or remains the Task lead of an unfinished Task.
        </p>
      </div>
      <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 8px;">
        <button class="btn btn-secondary btn-sm close-modal-btn">Cancel</button>
        <button class="btn btn-danger btn-sm" id="btn-confirm-archive">Archive Agent</button>
      </div>
    </div>
  `;

  overlay.querySelectorAll('.close-modal-btn').forEach((btn) => {
    btn.addEventListener('click', () => overlay.remove());
  });

  overlay.querySelector('#btn-confirm-archive')?.addEventListener('click', () => {
    const res = stateManager.archiveAgent(agent.id);
    if (res.success) {
      overlay.remove();
    }
  });

  document.body.appendChild(overlay);
}

function openAttributionHistoryDialog(agent: AgentDefinition) {
  const existing = document.getElementById('dialog-attribution-trace');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'dialog-attribution-trace';
  overlay.className = 'modal-backdrop';

  const history = agent.attributionHistory || [];

  overlay.innerHTML = `
    <div class="modal-dialog" style="max-width: 560px; width: 92%; max-height: 85vh; display: flex; flex-direction: column;">
      <div class="modal-header">
        <div style="display: flex; align-items: center; gap: 8px;">
          ${renderIcon('history', 18)}
          <strong style="font-size: 15px;">Run Attribution Trace: ${agent.displayName}</strong>
        </div>
        <button class="btn btn-ghost btn-sm close-modal-btn" aria-label="Close dialog">${renderIcon('close', 14)}</button>
      </div>
      <div class="modal-body" style="display: flex; flex-direction: column; gap: 10px; overflow-y: auto;">
        <p style="font-size: 12px; color: var(--text-secondary); margin: 0;">
          Every completed run, projected message, and validation claim preserves the exact Agent version, engine, model, and effort used at execution time (ADR-0008).
        </p>

        <div style="display: flex; flex-direction: column; gap: 6px;">
          ${
            history.length === 0
              ? `<div class="card" style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 12px;">
                  No historical task runs or messages recorded for this agent yet.
                </div>`
              : history
                  .map(
                    (attr) => `
                <div class="agent-attribution-row">
                  <div class="agent-attribution-row-top">
                    <div style="display: flex; align-items: center; gap: 6px;">
                      <span class="badge ${attr.entityKind === 'task_run' ? 'badge-primary' : 'badge-neutral'}" style="font-size: 10px;">
                        ${attr.entityKind === 'task_run' ? 'Task Run' : 'Message'}
                      </span>
                      <strong style="color: var(--text-primary); font-size: 12px;">${attr.projectName}</strong>
                    </div>
                    <span style="font-size: 10px; color: var(--text-muted);">${attr.timestamp}</span>
                  </div>
                  <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
                    ${attr.summary}
                  </div>
                  <div style="display: flex; gap: 6px; align-items: center; font-size: 10px; color: var(--text-muted); margin-top: 2px;">
                    <span>Used v${attr.configVersionUsed}</span>
                    <span>·</span>
                    <span>${attr.engineUsed.toUpperCase()} (<code>${attr.modelUsed}</code> · ${attr.effortUsed})</span>
                  </div>
                </div>
              `
                  )
                  .join('')
          }
        </div>
      </div>
      <div class="modal-footer" style="display: flex; justify-content: flex-end;">
        <button class="btn btn-secondary btn-sm close-modal-btn">Close</button>
      </div>
    </div>
  `;

  overlay.querySelectorAll('.close-modal-btn').forEach((btn) => {
    btn.addEventListener('click', () => overlay.remove());
  });

  document.body.appendChild(overlay);
}

function openAgentGuideDialog() {
  const existing = document.getElementById('dialog-agent-guide');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'dialog-agent-guide';
  overlay.className = 'modal-backdrop';

  overlay.innerHTML = `
    <div class="modal-dialog" style="max-width: 580px; width: 92%; max-height: 85vh; display: flex; flex-direction: column;">
      <div class="modal-header">
        <div style="display: flex; align-items: center; gap: 8px;">
          ${renderIcon('guide', 18)}
          <strong style="font-size: 15px;">Agent Identity & Work Options Architecture (ADR-0008)</strong>
        </div>
        <button class="btn btn-ghost btn-sm close-modal-btn" aria-label="Close dialog">${renderIcon('close', 14)}</button>
      </div>
      <div class="modal-body" style="display: flex; flex-direction: column; gap: 12px; font-size: 12px; color: var(--text-secondary); line-height: 1.4; overflow-y: auto;">
        <div>
          <h4 style="font-size: 13px; color: var(--text-primary); margin: 0 0 4px 0;">1. Portable Identity Independent of Project & Environment</h4>
          <p style="margin: 0;">
            An Agent is created independently of any Project or Environment. It requires a stable ID, a display name, and at least one ordered work option. Private memory and configuration versions remain with the Agent across projects.
          </p>
        </div>

        <div>
          <h4 style="font-size: 13px; color: var(--text-primary); margin: 0 0 4px 0;">2. Ordered Execution Preferences (Work Options)</h4>
          <p style="margin: 0;">
            Each option contains an engine (Codex, Pi, agy, opencode), work model, and effort. The list may span multiple engines and models.
          </p>
        </div>

        <div>
          <h4 style="font-size: 13px; color: var(--text-primary); margin: 0 0 4px 0;">3. Pre-Acceptance Fallback vs No-Silent-Replay</h4>
          <p style="margin: 0;">
            At run admission, Sprout evaluates the selected Environment and takes the <em>first</em> configured option whose engine is permitted and authenticated and whose model is available. Fallback to a secondary option occurs <strong>strictly before</strong> an engine accepts the run. Once accepted, later failures are reported directly; Sprout <strong>never replays work silently</strong> through lower-priority options because tools may have already produced irreversible host side effects.
          </p>
        </div>

        <div>
          <h4 style="font-size: 13px; color: var(--text-primary); margin: 0 0 4px 0;">4. Project Membership & Responsibility</h4>
          <p style="margin: 0;">
            Project membership references the global Agent identity and adds project-scoped responsibilities and collaboration instructions. Ending a membership stops future runs/messages without erasing historical attribution.
          </p>
        </div>

        <div>
          <h4 style="font-size: 13px; color: var(--text-primary); margin: 0 0 4px 0;">5. Non-Destructive Archive & Restore</h4>
          <p style="margin: 0;">
            Archiving an Agent bars new runs and memberships while preserving private memory, past messages, task records, and session slots. An Agent cannot be archived while leading an unfinished Task.
          </p>
        </div>

        <div>
          <h4 style="font-size: 13px; color: var(--text-primary); margin: 0 0 4px 0;">6. Strict Host Credential & Path Isolation</h4>
          <p style="margin: 0;">
            Agent identities and portable definitions never contain host filesystem paths or engine credentials. Web interacts solely with neutral relative workspace names and public readiness facts.
          </p>
        </div>
      </div>
      <div class="modal-footer" style="display: flex; justify-content: flex-end;">
        <button class="btn btn-secondary btn-sm close-modal-btn">Close</button>
      </div>
    </div>
  `;

  overlay.querySelectorAll('.close-modal-btn').forEach((btn) => {
    btn.addEventListener('click', () => overlay.remove());
  });

  document.body.appendChild(overlay);
}
