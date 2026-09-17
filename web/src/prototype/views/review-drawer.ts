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
          <strong style="font-size: 14px;">Product Owner Review: Chat Scopes & Wake-Routing Inspection</strong>
          <div style="font-size: 11px; color: var(--text-muted);">Ticket #64 Acceptance Evidence · M2 Operator Experience (ADR-0007, ADR-0008)</div>
        </div>
      </div>
      <button class="btn btn-secondary btn-sm close-review-btn" aria-label="Close review drawer">${renderIcon('close', 12)} Close</button>
    </div>

    <div class="review-drawer-content">
      <!-- Ticket #64 Acceptance Verification Checklist -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--accent-primary);">
          ${renderIcon('check', 16)} Ticket #64 Acceptance Criteria Verification (Chat Scopes & Wake-Routing Inspection)
        </h4>
        <div class="review-checklist">
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Three Conversation Scopes:</strong> Complete interactive support for Project Broadcast (<code>#general</code>), Working Groups (e.g. <code>Core Mechanics WG</code>, <code>WebAudio Effects WG</code>), and Project-Scoped Direct Messages (<code>@agent</code>), with navigation, composition, mention picker, <code>@all</code> quick insert, and recipient rendering.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Inspectable Wake Routing & Policies:</strong> Explicit-only vs Wake-model-assisted (30s collection window) policies, active 30s batch window visualizer, deliberate suppression, automatic retry & fail-closed (2 attempts), WakeRequest admission outcomes, and non-routing projected replies inspectable in detail.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Strict Privacy Boundary Guarantee:</strong> Direct DMs, Agent private memory, engine-native sessions, raw transcripts/tool outputs, credentials, host paths, and transient Environment capacity are strictly excluded from the routing context manifest and presentation.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Phone & Desktop Parity & State Matrix:</strong> 100% interactive parity across 390px mobile viewport (drill-down & header back button) and desktop split-pane layout, covering normal, empty, pending/batching, deliberate suppression, fail-closed, and projected-reply states.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Loop Prevention:</strong> Projected replies from Sprout runs are tagged non-routing and cannot open collection windows or trigger wake evaluations even if containing mentions.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Retained Artifact:</strong> Documented in <code>docs/prototype-chat-routing.md</code> and verified with DOM tests in <code>web/src/prototype/chat.dom.test.ts</code>.</span>
          </label>
        </div>
      </div>

      <!-- Ticket #63 Multi-View Project Checklist -->
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
            <span><strong>3-Part Lifecycle Disambiguation:</strong> Distinct visible representation of <code>Task state · Agent run state · Task lease state</code>.</span>
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
            <span><strong>Attention vs Ordinary Feed Content:</strong> Concrete separation between prominent Human Attention queue and chronological Recent Operational Activity stream.</span>
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

      <!-- 1. Accepted Decisions (#64, #63, #62, ADR-0007, ADR-0008) -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--green-ready);">
          ${renderIcon('check', 16)} Accepted Baseline Decisions & Module Decisions (#61, #62, #63, #64, ADR-0006, ADR-0007, ADR-0008)
        </h4>
        <ul class="review-list">
          <li>
            <strong>Three Distinct Conversation Scopes:</strong> Project Broadcast (<code>#general</code> for all project members), Working Groups (temporary focused sub-teams), and Direct Messages (strictly project-scoped 1-on-1 between operator and agent).
          </li>
          <li>
            <strong>Deterministic Addressing Bypasses Wake Model:</strong> Direct DMs, exact whole-token <code>@agent</code> mentions, <code>@all</code> broadcasts, and assigned project events wake recipients immediately, bypassing wake policy and collection windows.
          </li>
          <li>
            <strong>Fixed 30s Collection Window & Coalescing:</strong> Under wake-model-assisted policy, unaddressed messages enter a fixed 30s window. Evaluation invokes the wake model once per batch and produces at most one <code>WakeRequest</code> per selected agent.
          </li>
          <li>
            <strong>Non-Routing Projected Replies & Loop Prevention:</strong> Sprout projects only completed runs' final assistant text with non-routing disposition; mentions inside projected text cannot open collection windows or trigger wake evaluations.
          </li>
          <li>
            <strong>Automatic Retry & Fail-Closed Fallback:</strong> Transient model failures retry once with identical frozen context; a 2nd failure fails closed (zero agents woken, durable error record, original inputs intact, preventing uncontrolled fan-out).
          </li>
          <li>
            <strong>Observational Causal Evidence (No Manual Route-Now Buttons):</strong> Complete 6-section evidence manifest inspectable in detail without manual "Route now" or "Retry" overrides.
          </li>
          <li>
            <strong>Strict Privacy Boundary Guarantee:</strong> Direct DMs, private memory, sessions, tool transcripts, credentials, host paths, and transient capacity are strictly excluded from routing context.
          </li>
          <li>
            <strong>Non-Destructive Working Group & Membership Lifecycles:</strong> Disbanding a Working Group or ending an agent membership marks the channel/DM read-only and preserves full message history.
          </li>
          <li>
            <strong>Multi-View Navigation Hierarchy:</strong> Rather than a monolithic single screen, Project organizes its concerns into three focused sub-views: <code>Overview</code>, <code>Tasks</code>, and <code>Chat</code>.
          </li>
          <li>
            <strong>Human Authority Boundary for Task Begin & End:</strong> Proposing a Task holds NO Environment lease and executes NO agent run. Human <strong>Approve & Begin</strong> atomically binds an Environment, acquires its exclusive Task lease, prepares scratch context, and begins execution.
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
            <strong>Manual "Route Now" or "Retry Routing" Buttons:</strong> Rejected in ADR-0007; introduces probabilistic operator interference into deterministic batch scheduling.
          </li>
          <li>
            <strong>Fail-Open Fan-Out on Model Failure:</strong> Rejected in ADR-0007; waking all agents on model failure causes uncontrolled operational fan-out and token burn.
          </li>
          <li>
            <strong>Cross-Project Global Direct Messages:</strong> Rejected in ADR-0008; DMs must be project-scoped to maintain clear workspace, membership, and audit boundaries.
          </li>
          <li>
            <strong>Automatic Wake Routing of Projected Replies:</strong> Rejected in ADR-0007; creates recursive infinite wake loops.
          </li>
          <li>
            <strong>Evaluating Every Unaddressed Message Immediately:</strong> Rejected; bursts repeat context and spin up redundant expensive runs.
          </li>
          <li>
            <strong>Debounce Reset-on-Message Window:</strong> Rejected; continuous conversation in active channels would never close its routing window.
          </li>
          <li>
            <strong>Hard-Deleting Disbanded Working Groups or Ended DMs:</strong> Rejected; non-destructive preservation is required for audit integrity.
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
          ${renderIcon('check', 16)} Reuse & Revision Rules for Later Module Tickets (#65–#68)
        </h4>
        <ul class="review-list">
          <li>
            <strong>Tickets #65–#68 (Environments, Agents, Usage, Settings):</strong> Mount inside <code>Manage</code> tabs; reuse the accepted health indicators, danger confirmation dialog, routing inspector patterns, and telemetry tables.
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
            <strong>Working Group Creation Rules:</strong> In M2, any Project member can create a Working Group; the creator is automatically added as its initial member.
          </li>
          <li>
            <strong>Collection Window Duration Tuning:</strong> Fixed at 30 seconds default per ADR-0007, configurable per project template.
          </li>
        </ul>
      </div>

      <!-- 4. Downstream Reuse & Revision Rules -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--purple-agent);">
          ${renderIcon('check', 16)} Reuse & Revision Rules for Later Module Tickets (#65–#68)
        </h4>
        <ul class="review-list">
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
