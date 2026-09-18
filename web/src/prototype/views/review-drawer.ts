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
          <strong style="font-size: 14px;">Product Owner Review: Chat Scopes, Environments & Operating Baseline</strong>
          <div style="font-size: 11px; color: var(--text-muted);">M2 Interactive Prototype Acceptance Evidence (Tickets #61–#65 · ADR-0005, ADR-0007, ADR-0008, ADR-0009)</div>
        </div>
      </div>
      <button class="btn btn-secondary btn-sm close-review-btn" aria-label="Close review drawer">${renderIcon('close', 12)} Close</button>
    </div>

    <div class="review-drawer-content">
      <!-- Ticket #68 Acceptance Verification Checklist -->
      <div class="review-card settings-review-drawer-card">
        <h4 class="review-section-title" style="color: var(--accent-primary);">
          ${renderIcon('check', 16)} Ticket #68 General / Operator Settings: First Implementation Review
        </h4>
        <div class="review-checklist">
          <label class="review-check-item"><input type="checkbox" checked disabled /><span><strong>Operator access boundary:</strong> One operator identity, session inspection and revocation, host-local credential recovery, rotation consequences, and no credential delivery to Agents or Workers.</span></label>
          <label class="review-check-item"><input type="checkbox" checked disabled /><span><strong>Compatibility and migration:</strong> Sprout, protocol, schema, supported range, safety-copy, transactional failure, startup blocking, and host-local recovery guidance are represented without Web migration orchestration.</span></label>
          <label class="review-check-item"><input type="checkbox" checked disabled /><span><strong>Durability and diagnostics:</strong> Relative durable-data location, migration guard versus backup boundary, sanitized export exclusions, and host-local fallback are visible.</span></label>
          <label class="review-check-item"><input type="checkbox" checked disabled /><span><strong>Boundary and state coverage:</strong> Web routine operation is separated from host administration; normal, loading, warning, unavailable, failure, and risk-bearing states remain inspectable on phone and desktop.</span></label>
          <label class="review-check-item"><input type="checkbox" checked disabled /><span><strong>Retained artifact and owner decisions:</strong> Accepted inheritance, rejected scope, and unresolved owner preferences are recorded in <code>docs/prototype-settings-operator.md</code>. Review is pending and no preference is silently accepted.</span></label>
        </div>
        <details class="settings-review-drawer-details">
          <summary>Show accepted, rejected, and unresolved patterns</summary>
          <div class="review-list settings-review-drawer-lists">
            <div><strong>Accepted inheritance</strong><ul><li>#61 shell, tokens, touch floor, semantic states, and Manage hierarchy</li><li>#62 to #66 low-density hierarchy and details-on-demand</li><li>Environment recovery and Force Release remain in Environments</li></ul></div>
            <div><strong>Rejected scope</strong><ul><li>Web restart, maintenance, backup, restore, onboarding, and public governance controls</li><li>Multi-Human authorization and raw diagnostic export</li></ul></div>
            <div><strong>Unresolved preferences</strong><ul><li>Final fourth-tab label</li><li>Default visibility of state-coverage evidence</li><li>Credential rotation confirmation wording</li></ul></div>
          </div>
        </details>
      </div>

      <!-- Ticket #66 Acceptance Verification Checklist -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--accent-primary);">
          ${renderIcon('check', 16)} Ticket #66 Acceptance Criteria Verification (Agent Identity & Work Options)
        </h4>
        <div class="review-checklist">
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Portable Agent Identity & Standing Instructions:</strong> Agent is defined independently of any Project or Environment; requires a stable identity, non-empty display name, and at least one ordered work option; optional standing instructions and description.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Ordered Work Options & Run Admission Fallback:</strong> Work options specify engine (Codex, Pi, agy, opencode), work model, and effort; evaluated in strict priority order at run admission to select the first available option.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Pre-Acceptance Fallback vs No-Silent-Replay Guarantee (ADR-0008):</strong> Fallback between options occurs strictly before an engine accepts the run; once accepted, later failures are reported directly rather than silently replaying work through lower-priority options.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Project Membership & Responsibility Separation:</strong> Project membership references global Agent identity, adding project-scoped responsibilities and collaboration instructions; ending membership stops new runs/messages without erasing historical attribution.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Strict Privacy Boundary & Neutral Host Facts:</strong> No host credentials, API keys, private keys, or absolute user home paths (/Users/..., C:\\Users\\...) appear in Agent identity; displays neutral relative paths and public engine auth facts.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Non-Destructive Archive & Historical Attribution:</strong> Archiving bars new runs and memberships while preserving private memory, past messages, task records, and session slots; safety guard prevents archiving an Agent leading an unfinished Task.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Phone & Desktop Responsive Parity & State Matrix:</strong> 100% interactive parity across 390px mobile viewport (drill-down & top back nav) and desktop split-pane layout, covering Healthy/Ready, Attention/Degraded, Unavailable, Empty, and Archived states.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Retained Artifact:</strong> Documented in <code>docs/prototype-agent-identity.md</code> and verified with DOM tests in <code>web/src/prototype/agents.dom.test.ts</code>.</span>
          </label>
        </div>
      </div>

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
            <span><strong>Three Conversation Scopes & Navigation:</strong> Complete interactive support for Project Broadcast (<code>#general</code>), Working Groups (e.g. <code>Core Mechanics WG</code>, <code>WebAudio Effects WG</code>), and Project-Scoped Direct Messages (<code>@agent</code>), with navigation, composition, mention picker, <code>@all</code> quick insert, and recipient rendering.</span>
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
            <span><strong>Retained Artifact & Owner Review:</strong> Documented in <code>docs/prototype-chat-routing.md</code> and verified with DOM tests in <code>web/src/prototype/chat.dom.test.ts</code>, recording accepted/rejected/unresolved Chat patterns.</span>
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
            <strong>Three Distinct Conversation Scopes (ADR-0008):</strong> Project Broadcast (<code>#general</code> for all project members), Working Groups (temporary focused sub-teams), and Direct Messages (strictly project-scoped 1-on-1 between operator and agent).
          </li>
          <li>
            <strong>Deterministic Addressing Precedence (ADR-0007):</strong> Direct DMs, exact whole-token <code>@agent</code> mentions, <code>@all</code> broadcasts, and assigned project events wake recipients immediately, bypassing wake policy and collection windows.
          </li>
          <li>
            <strong>Fixed 30s Collection Window & Coalescing (ADR-0007):</strong> Under wake-model-assisted policy, unaddressed messages enter a fixed 30s window (avoiding debounce starvation). Evaluation invokes the wake model once per batch and produces at most one <code>WakeRequest</code> per selected agent.
          </li>
          <li>
            <strong>Non-Routing Projected Replies & Loop Prevention (ADR-0007):</strong> Sprout projects only completed runs' final assistant text with non-routing disposition; mentions inside projected text cannot open collection windows or trigger wake evaluations.
          </li>
          <li>
            <strong>Automatic Retry & Fail-Closed Fallback (ADR-0007):</strong> Transient model failures retry once with identical frozen context; a 2nd failure fails closed (zero agents woken, durable error record, original inputs intact, preventing uncontrolled fan-out).
          </li>
          <li>
            <strong>Observational Causal Evidence (No Manual Route-Now Buttons):</strong> Complete 6-section evidence manifest inspectable in detail without manual "Route now" or "Retry" overrides.
          </li>
          <li>
            <strong>Strict Routing Privacy Boundary Guarantee:</strong> Direct DMs, private memory, sessions, tool transcripts, credentials, host paths, and transient capacity are strictly excluded from routing context.
          </li>
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
            <strong>Portable Agent Identity Independent of Project & Environment (ADR-0008):</strong> Agents are global, portable definitions that can be assigned to multiple projects and run on heterogeneous environments without copying or embedding host paths/secrets.
          </li>
          <li>
            <strong>Ordered Execution Preferences & Pre-Acceptance Fallback (ADR-0008):</strong> Work options (engine, model, effort) are evaluated at run admission; Sprout takes the first available option. Fallback occurs only before run acceptance.
          </li>
          <li>
            <strong>Post-Acceptance No-Silent-Replay Guarantee (ADR-0008):</strong> Once an engine accepts a run, tool invocations may produce irreversible side effects; later failures are surfaced directly rather than silently replayed through lower-priority options.
          </li>
          <li>
            <strong>Non-Destructive Agent Archiving (ADR-0008):</strong> Archiving an Agent preserves all private memory, past messages, task records, and session slots for permanent attribution, while barring new work. Restoring re-enables active assignment.
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
            <strong>Manual "Route Now" or "Retry Routing" Buttons:</strong> Rejected in ADR-0007; invites operator micro-management into deterministic scheduling.
          </li>
          <li>
            <strong>Fail-Open Fan-Out to All Agents on Routing Failure:</strong> Rejected in ADR-0007; model failure must fail closed to prevent massive agent fan-out and token burn.
          </li>
          <li>
            <strong>Global Cross-Project Direct Messages:</strong> Rejected in ADR-0008; violates project contract and audit boundaries.
          </li>
          <li>
            <strong>Automatic Wake Routing of Projected Replies:</strong> Rejected in ADR-0007; causes infinite wake loops.
          </li>
          <li>
            <strong>Debounce Reset-on-Message Window:</strong> Rejected in ADR-0007; starves active channels indefinitely.
          </li>
          <li>
            <strong>Hard Deletion of Groups or DMs:</strong> Rejected in ADR-0008; damages historical traceability.
          </li>
          <li>
            <strong>Permanent Quick-Mention Chips & In-Composer Addressing Pills:</strong> Rejected per owner review in favor of a clean, uncluttered composer; deterministic addressing and collection windows remain governed by ADR-0007 invariants.
          </li>
          <li>
            <strong>Intrusive In-Chat Collection Window Countdown Banners:</strong> Rejected per owner review in favor of a clean conversation flow; routing batches remain inspectable via message tags and conversation details without interrupting active chat.
          </li>
          <li>
            <strong>Permanent In-Message Display of Routing Tags, Badges & Provenance Cards:</strong> Rejected per owner review in favor of an on-demand popup triggered by an <code>i</code> button to the left of the message timestamp on both human and agent messages, avoiding visual clutter in conversation flow.
          </li>
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
          <li>
            <strong>Automatic Post-Acceptance Fallback & Silent Replay:</strong> Rejected in ADR-0008; tools may produce irreversible host side-effects (git commits, file mutations, network requests); execution failures after engine acceptance must be reported as errors.
          </li>
          <li>
            <strong>Binding Agents Directly to Specific Environments or Projects:</strong> Rejected in ADR-0008; violates the core portable worker identity boundary.
          </li>
          <li>
            <strong>Hard Deletion of Archived Agents:</strong> Rejected in ADR-0008; would destroy historical Message, Task run, and cost attribution records.
          </li>
          <li>
            <strong>Storing Host Credentials or Absolute Paths in Agent Identity:</strong> Rejected in ADR-0008; violates security and breaks portability across machines.
          </li>
          <li>
            <strong>Allowing Agents with Zero Work Options:</strong> Rejected in ADR-0008; an Agent must have at least one ordered work option.
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
            <strong>Working Group Creation Authority:</strong> In M2, any Project member can create a Working Group; the creator is automatically added as its initial member.
          </li>
          <li>
            <strong>Collection Window Duration Tuning:</strong> Defaulted to 30 seconds per ADR-0007; configurable per project template.
          </li>
          <li>
            <strong>Multi-Task Concurrency Limit per Environment:</strong> ADR-0005 strictly enforces one active Task lease per Environment instance. Multiple proposals may be queued, but only one can begin on a given Environment at a time.
          </li>
          <li>
            <strong>Carrier Transport Strategy:</strong> M2 specifies authenticated TLS/WSS over private overlay (or loopback). Public internet exposure is unsupported.
          </li>
          <li>
            <strong>Cross-Environment Task Migration:</strong> Moving an in-progress Task across environments is deferred post-M2; Task begin binds the Task to one Environment instance for its entire lifecycle.
          </li>
          <li>
            <strong>Feed Visibility for Degraded Agents (#66 Fog):</strong> When an engine or model is degraded across all enrolled environments, whether the Agent should surface in cross-project Feed attention or remain scoped to Manage &gt; Agents.
          </li>
          <li>
            <strong>Private Memory Operator Management (#66 Fog):</strong> Whether the Local Operator should be able to inspect or clear Agent private-memory entries in M2, or whether memory lifecycle remains engine-native and read-only.
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
