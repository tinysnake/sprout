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
          <strong style="font-size: 14px;">Product Owner Review: Shared Shell & Baseline</strong>
          <div style="font-size: 11px; color: var(--text-muted);">Ticket #61 Acceptance Evidence · M2 Operator Experience</div>
        </div>
      </div>
      <button class="btn btn-secondary btn-sm close-review-btn" aria-label="Close review drawer">${renderIcon('close', 12)} Close</button>
    </div>

    <div class="review-drawer-content">
      <!-- Ticket #61 Acceptance Verification Checklist -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--accent-primary);">
          <span>✓</span> Ticket #61 Acceptance Criteria Verification
        </h4>
        <div class="review-checklist">
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Visual Language Settled:</strong> Color roles, typography scale, 4px spacing grid, radii, dark/light theme, and icon styles.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Responsive Framing Settled:</strong> Mobile bottom nav (Feed, Project, Manage) and desktop sidebar with phone/desktop parity and return/deep-link navigation.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Shared Interaction Primitives:</strong> Buttons (sizes/states/loading), forms with validation error states, interactive lists, KPI cards, bottom sheets, modals, danger confirmation.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>State Language Settled:</strong> Loading shimmer, empty states, error banners, stale warnings, lifecycle pills, traffic lights with textual reasons, and provenance tags.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Accessibility Floor:</strong> 44px minimum touch targets, visible focus rings, multi-modal cues (color + icon + text), and keyboard navigation.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Neutral Placeholders:</strong> Does not prematurely decide module internals for #62-#68.</span>
          </label>
        </div>
      </div>

      <!-- 1. Accepted Baseline Decisions -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--green-ready);">
          <span>✓</span> Accepted Baseline Decisions (#60, #61)
        </h4>
        <ul class="review-list">
          <li>
            <strong>3-Tier Operating Hierarchy:</strong> Primary destinations are ordered by operator frequency:
            <code>Feed</code> (cross-project landing), <code>Project</code> (workspace, tasks, chat), and <code>Manage</code> (gear control).
          </li>
          <li>
            <strong>Prominent Attention in Feed:</strong> High-priority Human interventions (validation claims, recovery, blockers, pending enrollments) are surfaced upfront inside Feed, not as a disjoint top-level destination.
          </li>
          <li>
            <strong>Phone & Desktop Capability Parity:</strong> Mobile viewports have 100% full interactive power (bottom sheet controls, danger confirmation, deep link return) rather than a degraded read-only view.
          </li>
          <li>
            <strong>Traffic Light with Mandatory Textual Reason:</strong> Green/Yellow/Red status indicators must ALWAYS be accompanied by a concrete, independent textual explanation.
          </li>
          <li>
            <strong>3-Part Disambiguated Lifecycle Sentence:</strong> <code>Task state · Agent run state · Task lease state</code> prevents conflating nested agent execution with environment resource ownership.
          </li>
          <li>
            <strong>Deep Linking & Return Breadcrumb:</strong> Navigating from Feed into a Project task or Environment detail provides a clear <code>← Back to Feed</code> breadcrumb to preserve operator context.
          </li>
        </ul>
      </div>

      <!-- 2. Rejected Patterns -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--red-action);">
          <span>✕</span> Rejected Patterns
        </h4>
        <ul class="review-list">
          <li>
            <strong>7-Tab Flat Navigation:</strong> Rejected in #60 grilling; flatter tabs flatten operational hierarchy and clutter mobile navigation.
          </li>
          <li>
            <strong>Dedicated Onboarding Module in M2:</strong> Rejected in #60; routine management of Environments, Agents, and Projects happens in standard Manage/Project views.
          </li>
          <li>
            <strong>One-Shot Monolithic Review:</strong> Rejected in favor of sequential focused reviews (#61 through #68).
          </li>
          <li>
            <strong>Color-Only Status Signals:</strong> Rejected; status must never rely on color alone without icons and text labels.
          </li>
          <li>
            <strong>Silent Style Forking:</strong> Modules may not create ad-hoc colors or component styles outside the shared baseline.
          </li>
        </ul>
      </div>

      <!-- 3. Unresolved Questions -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--yellow-attention);">
          <span>?</span> Unresolved Questions & Implementation Notes
        </h4>
        <ul class="review-list">
          <li>
            <strong>Manage Fourth Tab Naming:</strong> The fourth tab of Manage is currently labeled <code>Settings</code>; Ticket #68 will formally settle between <code>General</code>, <code>Operator</code>, or <code>Settings</code>.
          </li>
          <li>
            <strong>Default Mobile Density:</strong> Mobile defaults to <code>Comfortable</code> density (44px touch targets); a user density toggle is available in the top bar.
          </li>
        </ul>
      </div>

      <!-- 4. Downstream Reuse & Revision Rules -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--purple-agent);">
          <span>ℹ</span> Reuse & Revision Rules for Later Module Tickets (#62-#68)
        </h4>
        <ul class="review-list">
          <li>
            <strong>Ticket #62 (Feed):</strong> Mounts inside <code>Feed</code> container; uses the accepted Attention list item primitives and deep-link return patterns.
          </li>
          <li>
            <strong>Ticket #63 (Project View):</strong> Mounts inside <code>Project</code> container; reuses the accepted segmented tab bar and task lifecycle cards.
          </li>
          <li>
            <strong>Ticket #64 (Chat):</strong> Mounts inside <code>Project &gt; Chat</code>; reuses the accepted message stream, projected reply tag, and routing inspector sheet.
          </li>
          <li>
            <strong>Tickets #65-#68 (Environments, Agents, Usage, Settings):</strong> Mount inside <code>Manage</code> tabs; reuse the accepted health indicators, danger confirmation dialog, and telemetry tables.
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
