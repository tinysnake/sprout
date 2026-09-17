import { renderIcon } from '../icons.js';
import { stateManager, type PrototypeState } from '../state.js';

export function renderReviewDrawer(state: PrototypeState): HTMLElement | null {
  if (!state.reviewDrawerOpen) {
    return null;
  }

  const drawer = document.createElement('div');
  drawer.className = 'review-drawer';

  drawer.innerHTML = `
    <div class="review-drawer-header">
      <div style="display: flex; align-items: center; gap: 8px;">
        ${renderIcon('clipboard', 20)}
        <div>
          <strong style="font-size: 14px;">Product Owner Review: Multi-View Project Experience</strong>
          <div style="font-size: 11px; color: var(--text-muted);">Ticket #63 Acceptance Evidence · M2 Operator Experience</div>
        </div>
      </div>
      <button class="btn btn-secondary btn-sm close-review-btn" aria-label="Close review drawer">${renderIcon('close', 12)} Close</button>
    </div>

    <div class="review-drawer-content">
      <!-- Ticket #63 Acceptance Verification Checklist -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--accent-primary);">
          ${renderIcon('check', 16)} Ticket #63 Acceptance Criteria Verification (Multi-View Project Experience)
        </h4>
        <div class="review-checklist">
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Multi-View Project Domain:</strong> Project overview, derived template contract, memberships, bound workspace environments, and communication entry points are bounded and navigable without cramming everything into one flat tab.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Complete Project-Owned Task Operating Loop:</strong> Full interactive support for Task proposal, Human approve-and-begin boundary, autonomous multi-run execution, 2-stage pause (admission hold) and intentional interrupt (agent stop), routable blockers, completion claims & validation, safe Task end, and ordinary recovery.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>3-Part Lifecycle Disambiguation:</strong> Distinct visible representation of <code>Task state · Agent run state · Task lease state</code>. Project-owned Task controls are strictly separated from Environment-level emergency Force Release.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Phone & Desktop Capability Parity:</strong> 100% interactive parity across 390px mobile viewport and desktop multi-column viewports with touch-floor targets and deep link return.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Realistic State Matrix:</strong> Predeclared scenarios exercising active running tasks, validation claims, routable blockers, task proposals, ordinary recovery, archived project, and overview.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Retained Artifact:</strong> Documented in <code>docs/prototype-project-multiview.md</code>.</span>
          </label>
        </div>
      </div>

      <!-- Ticket #62 Feed Baseline Verification Checklist -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--accent-primary);">
          ${renderIcon('check', 16)} Ticket #62 Acceptance Criteria Verification (Feed & Attention)
        </h4>
        <div class="review-checklist">
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Attention vs Ordinary Feed Content:</strong> Concrete separation between prominent Human Attention queue (urgent approvals, blockers, recovery, degraded environments) and chronological Recent Operational Activity stream.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Discovery & Context Boundary:</strong> Feed contextualizes work with disambiguated lifecycle sentences, attribution, and textual reasons, without copying or owning Task, Chat, Environment, Agent, or Usage actions. Deep-links delegate to domain surfaces with <code>← Back to Feed</code> return banner.</span>
          </label>
        </div>
      </div>

      <!-- Ticket #61 Baseline Checklist -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--accent-primary);">
          ${renderIcon('check', 16)} Ticket #61 Acceptance Criteria Verification (Inherited Shared Baseline)
        </h4>
        <div class="review-checklist">
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Visual Language & Responsive Framing:</strong> Color roles, 4px grid, dark/light theme, mobile bottom nav, desktop sidebar, and return/deep-link navigation.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Shared Interaction Primitives & State Language:</strong> Buttons, forms with validation error states, interactive lists, KPI cards, bottom sheets, modals, danger confirmation.</span>
          </label>
        </div>
      </div>

      <!-- 1. Accepted Decisions (#63) -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--green-ready);">
          ${renderIcon('check', 16)} Accepted Baseline Decisions & Project Decisions (#61, #62, #63, ADR-0006, ADR-0008)
        </h4>
        <ul class="review-list">
          <li>
            <strong>Multi-View Navigation Hierarchy:</strong> Rather than a monolithic single screen, Project organizes its concerns into three focused sub-views: <code>Overview</code> (Contract, Memberships, Bound Workspaces, Working Groups), <code>Tasks</code> (Full Operating Loop, Multi-Run Execution, 2-Stage Pause, Blockers, Validation Claims), and <code>Chat</code> (Project & Working Group Streams).
          </li>
          <li>
            <strong>Human Authority Boundary for Task Begin & End:</strong> Proposing a Task holds NO Environment lease and executes NO agent run. Human <strong>Approve & Begin</strong> atomically binds an Environment, acquires its exclusive Task lease, prepares scratch context, and begins execution. Safe Task End recycles scratch context and releases the lease.
          </li>
          <li>
            <strong>Task-Lead Autonomous Multi-Run Coordination:</strong> Within the approved boundary, an Agent Task lead coordinates sequential agent runs without requiring per-run Human approval.
          </li>
          <li>
            <strong>Two-Stage Pause & Intentional Run Interrupt:</strong> Stage 1 (Pause) places an admission hold letting the active run settle naturally; Stage 2 (Interrupt) intentionally stops the running agent, settles the run as <code>stopped</code>, keeps the Task lease held, and pauses the Task.
          </li>
          <li>
            <strong>Routable Task Blockers:</strong> Blockers explicitly capture Reason, Required Next Action, Responsible Actor, and Who Advances When Cleared, preserving lease safety.
          </li>
          <li>
            <strong>Completion Claim & Human Validation:</strong> The Lead Agent submits formal validation evidence, durable changes, and limitations. The Human decides to <strong>Accept & Authorize Safe Task End</strong> or <strong>Require Correction</strong> on the held lease.
          </li>
          <li>
            <strong>Membership & Workspace Historical Preservation:</strong> Ending an agent's project membership or archiving a project preserves all historical messages, attribution, and files on disk.
          </li>
        </ul>
      </div>

      <!-- 2. Rejected Patterns -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--red-action);">
          ${renderIcon('close', 16)} Rejected Patterns
        </h4>
        <ul class="review-list">
          <li>
            <strong>One-Screen Flat Project Tab:</strong> Rejected in #60 & #63; cramming task lists, agent definitions, logs, contract, and chat into one scrollview breaks mobile usability and mixes operating frequencies.
          </li>
          <li>
            <strong>Automatic Task Begin on Proposal:</strong> Rejected in ADR-0006; allows unmonitored acquisition of scarce host environment leases.
          </li>
          <li>
            <strong>Collapsing Task, Run, and Lease into One Status:</strong> Rejected; prevents distinguishing an active task waiting for human input from an actively executing agent run.
          </li>
          <li>
            <strong>Instant Hard Stop on First Pause:</strong> Rejected; destructive when a cooperative turn could complete safely. Two-stage pause provides non-destructive admission hold followed by intentional escalation.
          </li>
          <li>
            <strong>Automatic Terminal Failures on Run Interruption:</strong> Rejected; interrupted runs enter recovery and keep lease locked to prevent work loss.
          </li>
          <li>
            <strong>Hard Deletion of Memberships, Workspaces, or Projects:</strong> Rejected; non-destructive archive, ended membership, and disbanded working groups preserve historical audit trails.
          </li>
        </ul>
      </div>

      <!-- 3. Unresolved Questions & Implementation Notes -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--yellow-attention);">
          ${renderIcon('alert', 16)} Unresolved Questions & Implementation Notes
        </h4>
        <ul class="review-list">
          <li>
            <strong>Multi-Task Concurrency Limit per Environment:</strong> ADR-0005 strictly enforces one active Task lease per Environment instance. Multiple proposals may be queued, but only one can begin on a given Environment at a time.
          </li>
          <li>
            <strong>Working Group Creation Rules:</strong> In M2, any Project member can create a Working Group; the creator is automatically added as its initial member.
          </li>
        </ul>
      </div>

      <!-- 4. Downstream Reuse & Revision Rules -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--purple-agent);">
          ${renderIcon('check', 16)} Reuse & Revision Rules for Later Module Tickets (#64–#68)
        </h4>
        <ul class="review-list">
          <li>
            <strong>Ticket #64 (Chat):</strong> Mounts inside <code>Project &gt; Chat</code>; reuses the accepted message stream, projected reply tag, and routing inspector sheet.
          </li>
          <li>
            <strong>Tickets #65–#68 (Environments, Agents, Usage, Settings):</strong> Mount inside <code>Manage</code> tabs; reuse the accepted health indicators, danger confirmation dialog, and telemetry tables.
          </li>
        </ul>
      </div>
    </div>
  `;

  drawer.querySelector('.close-review-btn')?.addEventListener('click', () => {
    stateManager.toggleReviewDrawer(false);
  });

  return drawer;
}
