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
          <strong style="font-size: 14px;">Product Owner Review: Environment Management & Recovery</strong>
          <div style="font-size: 11px; color: var(--text-muted);">Ticket #65 Acceptance Evidence · M2 Operator Experience (ADR-0005, ADR-0008, ADR-0009)</div>
        </div>
      </div>
      <button class="btn btn-secondary btn-sm close-review-btn" aria-label="Close review drawer">${renderIcon('close', 12)} Close</button>
    </div>

    <div class="review-drawer-content">
      <!-- Ticket #65 Acceptance Verification Checklist -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--accent-primary);">
          ${renderIcon('check', 16)} Ticket #65 Acceptance Criteria Verification (Environment Management & Recovery)
        </h4>
        <div class="review-checklist">
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Multi-Dimension Health Model:</strong> 6 independent health dimensions (Enrollment, Connection, Protocol Compatibility, Work Safety/Lease, Capability Permissions, Engine Harness Readiness) never collapsed into a single boolean; prominent Traffic-Light summary with mandatory bold textual explanation.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Disconnect, Reconnect & Reconciliation:</strong> Live worker disconnect detection moves active lease to recovery (preventing automatic reassignment); reconnect over TLS/WSS automatically authenticates, checks protocol compatibility, synchronizes locally retained events, and proves engine process stop before human decision.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Task-Held Lease Safety & Safe Task End:</strong> Task lease is retained continuously across runs, idle gaps, and human validation (ADR-0005); safe Task End recycles scratch context via worker while strictly preserving the persistent Project workspace.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Human-Only Emergency Force Release:</strong> Available strictly when lease is in recovery; requires explicit risk acknowledgement checkbox, operator reason, and typed confirmation (<code>FORCE RELEASE</code>); marks Task cancelled with permanent forced release disposition and frees Environment without deleting Project workspace.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Strict Privacy & Neutral Host Facts:</strong> No user home paths (<code>/Users/...</code>, <code>C:\\Users\\...</code>), host private keys, or API credentials appear in portable identity or Web UI; displays neutral relative paths, opaque fingerprints, and model readiness.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Phone & Desktop Parity & State Matrix:</strong> 100% interactive parity across 390px mobile viewport (drill-down & header back button) and desktop split-pane layout, covering Ready, Pending, Degraded, Offline, Reconciling, Recovery, and Archived states.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Retained Artifact:</strong> Documented in <code>docs/prototype-environments-recovery.md</code> and verified with DOM tests in <code>web/src/prototype/environments.dom.test.ts</code>.</span>
          </label>
        </div>
      </div>

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

      <!-- 1. Accepted Decisions (#65, #64, #63, #62, ADR-0005, ADR-0008, ADR-0009) -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--green-ready);">
          ${renderIcon('check', 16)} Accepted Baseline Decisions & Module Decisions (#61, #62, #63, #64, #65, ADR-0005, ADR-0006, ADR-0007, ADR-0008, ADR-0009)
        </h4>
        <ul class="review-list">
          <li>
            <strong>Independent Health Dimensions:</strong> Health is never collapsed into a single boolean. Web exposes enrollment, connection state, protocol compatibility, work safety/lease status, capability permissions, and engine harness readiness independently, with a textual traffic light summary.
          </li>
          <li>
            <strong>Task-Held Lease Exclusivity (ADR-0005):</strong> A Task holds an exclusive lease on an Environment from begin to end across multiple runs, idle periods, and human validation gaps. Timeout or worker disconnect never silently reassigns an unfinished Task's environment.
          </li>
          <li>
            <strong>Disconnect Moves Lease to Recovery:</strong> Channel loss moves the lease into recovery. Reconnect automatically authenticates over TLS/WSS, verifies protocol compatibility, synchronizes locally retained evidence, and verifies engine process cessation before presenting Resume or Discard options to the operator.
          </li>
          <li>
            <strong>Safe Task End vs Project Workspace Preservation:</strong> Task end recycles only Sprout scratch context directories via the host worker; persistent Project workspaces, git repos, and build artifacts are strictly preserved.
          </li>
          <li>
            <strong>Human-Only Emergency Force Release (ADR-0009):</strong> Emergency escape hatch available only in recovery. Requires explicit risk acknowledgement, operator reason, and typed confirmation (<code>FORCE RELEASE</code>). Permanently cancels Task with forced release disposition and frees Environment without deleting Project workspace.
          </li>
          <li>
            <strong>Host Credential & Path Isolation:</strong> Engine API keys, private keys, and host filesystem absolute paths remain on the host; Web operates with neutral relative paths and public fingerprints.
          </li>
          <li>
            <strong>Non-Destructive Archive & Security Unenrollment:</strong> Archiving preserves enrollment and history while barring new project bindings; unenrollment revokes worker identity. Both operations require that no active lease is held.
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
            <strong>Automatic Timeout-Driven Lease Release:</strong> Rejected in ADR-0005; silently releasing an idle or blocked Task's environment causes catastrophic loss of uncommitted state in scarce host environments.
          </li>
          <li>
            <strong>Automatic Emergency Force-Release:</strong> Rejected in ADR-0009; emergency override must be an explicit Human decision with acknowledged risks, never automated by timeouts or watchdog scripts.
          </li>
          <li>
            <strong>Collapsing Multi-Dimension Health into One Boolean:</strong> Rejected in ADR-0009; masks critical distinctions between carrier disconnect, protocol version mismatch, missing engine login, and lease recovery.
          </li>
          <li>
            <strong>Automatic Run Replay on Worker Reconnect:</strong> Rejected in ADR-0009; tool invocations may have already produced irreversible side-effects on host; evidence is synchronized for human-directed Resume or Discard.
          </li>
          <li>
            <strong>Deleting Project Workspace on Task End:</strong> Rejected in ADR-0005; would destroy repository and build assets; only per-task scratch context is recycled.
          </li>
          <li>
            <strong>Storing Host Paths or Credentials in Portable Identity:</strong> Rejected in ADR-0008; compromises security and breaks portability across hosts.
          </li>
          <li>
            <strong>Preempting Active Clean Leases with Force Release:</strong> Rejected in ADR-0009; Force Release is strictly barred on clean active leases and is accessible only when an environment is in recovery.
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
            <strong>Carrier Transport Strategy:</strong> M2 specifies authenticated TLS/WSS over private overlay (or loopback). Public internet exposure is unsupported.
          </li>
          <li>
            <strong>Cross-Environment Task Migration:</strong> Moving an in-progress Task across environments is deferred post-M2; Task begin binds the Task to one Environment instance for its entire lifecycle.
          </li>
        </ul>
      </div>

      <!-- 4. Downstream Reuse & Revision Rules -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--purple-agent);">
          ${renderIcon('check', 16)} Reuse & Revision Rules for Later Module Tickets (#66–#68)
        </h4>
        <ul class="review-list">
          <li>
            <strong>Tickets #66–#68 (Agents, Usage, Settings):</strong> Mount inside <code>Manage</code> tabs; reuse the accepted health indicators, danger confirmation dialog, routing inspector patterns, and telemetry tables.
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
