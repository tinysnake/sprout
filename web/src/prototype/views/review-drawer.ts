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
          <strong style="font-size: 14px;">Product Owner Review: Feed & Attention Experience</strong>
          <div style="font-size: 11px; color: var(--text-muted);">Ticket #62 Acceptance Evidence · M2 Operator Experience</div>
        </div>
      </div>
      <button class="btn btn-secondary btn-sm close-review-btn" aria-label="Close review drawer">${renderIcon('close', 12)} Close</button>
    </div>

    <div class="review-drawer-content">
      <!-- Ticket #62 Acceptance Verification Checklist -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--accent-primary);">
          ${renderIcon('check', 16)} Ticket #62 Acceptance Criteria Verification
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
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Phone & Desktop Capability Parity:</strong> 100% interactive parity across 390px mobile viewport and desktop multi-column viewports with touch-floor targets and sticky breadcrumb return.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>7-State Realistic Matrix:</strong> Complete interactive preview of Mixed (Default), Empty (All Clear), Healthy (Active Work), Stale Telemetry, Pending Approvals, Degraded Host, and Intervention Needed.</span>
          </label>
          <label class="review-check-item">
            <input type="checkbox" checked disabled />
            <span><strong>Retained Artifact:</strong> Retained architectural decisions, rejected patterns, and evidence captured in <code>docs/prototype-feed-attention.md</code>.</span>
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

      <!-- 1. Accepted Decisions -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--green-ready);">
          ${renderIcon('check', 16)} Accepted Baseline Decisions (#61) & Feed Decisions (#62)
        </h4>
        <ul class="review-list">
          <li>
            <strong>Strict Discovery & Context Boundary:</strong> Feed surfaces what needs attention and why, but delegates all domain actions (validation decisions, 2-stage pause, force release, enrollment approval, message authoring) to authoritative domain views via deep links.
          </li>
          <li>
            <strong>Three-Tier Feed Structure:</strong>
            <ol style="padding-left: 18px; margin-top: 4px; display: flex; flex-direction: column; gap: 4px;">
              <li><strong>Human Attention Queue (Top):</strong> Prioritized by urgency (Action Required → Attention → Info), with category filter chips.</li>
              <li><strong>Live In-Flight Work Snapshot (Middle):</strong> Pulsing live status of executing tasks and agent runs across environments.</li>
              <li><strong>Recent Operational Activity Stream (Bottom):</strong> Chronological background audit stream with category filters (Tasks, Chat, Envs, Cost).</li>
            </ol>
          </li>
          <li>
            <strong>Multi-Modal Attention Cues:</strong> High-contrast severity borders (Red <code>--red-action</code>, Yellow <code>--yellow-attention</code>, Blue <code>--accent-primary</code>), category icons, disambiguated lifecycle sentences (<code>Task · Run · Lease</code>), and textual "Why attention is needed" reasons.
          </li>
          <li>
            <strong>Deep Linking with Return Breadcrumb:</strong> Clicking any attention item or activity row deep-links directly into <code>Project > Tasks</code>, <code>Project > Chat</code>, or <code>Manage > Environments</code>, activating the sticky <code>← Back to Feed</code> return banner.
          </li>
          <li>
            <strong>Layout Exploration Switcher:</strong>
            Supports <em>Variant A (Unified Stream)</em>, <em>Variant B (Split Board)</em> with 2 desktop columns / mobile tab switch, and <em>Variant C (Project Grouped)</em>.
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
            <strong>Inline Domain Action Execution in Feed:</strong> Rejected; embedding validation claim acceptance buttons, force-release triggers, or task pause buttons directly in Feed risks accidental clicks without inspecting evidence, diffs, or logs.
          </li>
          <li>
            <strong>Single Flat Timeline without Attention Isolation:</strong> Rejected; mixing critical blockers with routine heartbeat logs risks missing human-action-required events.
          </li>
          <li>
            <strong>Color-Only Urgency Signals:</strong> Rejected; attention items must pair color with distinctive category icons, severity badges, and textual reasons.
          </li>
          <li>
            <strong>Standalone Disjoint Attention Destination:</strong> Rejected in #60 & #61; attention belongs prominently within the Feed cross-project landing surface.
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
            <strong>Feed Polling vs Server-Sent Push Rate:</strong> The prototype uses an in-memory reactive state stream; production M2 will settle WebSocket vs SSE subscription rates for low-latency push on mobile.
          </li>
          <li>
            <strong>Attention Item Dismissal / Snooze Policy:</strong> Whether non-critical warnings (e.g. stale telemetry notice) can be temporarily snoozed by the operator or must always remain until underlying health recovers.
          </li>
          <li>
            <strong>Default Feed Layout Variant:</strong> <em>Variant A: Unified Stream</em> is accepted as the primary default; <em>Variant B (Split Board)</em> provides excellent power on widescreen desktop viewports.
          </li>
        </ul>
      </div>

      <!-- 4. Reuse & Revision Rules for Later Module Tickets -->
      <div class="review-card">
        <h4 class="review-section-title" style="color: var(--purple-agent);">
          ${renderIcon('layers', 16)} Reuse & Revision Rules for Later Module Tickets (#63-#68)
        </h4>
        <ul class="review-list">
          <li>
            <strong>#63 (Project View):</strong> Reuses Project container tabs, Task cards, and 2-stage pause/interrupt controls.
          </li>
          <li>
            <strong>#64 (Chat):</strong> Reuses Project chat layout, projected replies, and causal routing inspector.
          </li>
          <li>
            <strong>#65 (Environments):</strong> Reuses Environment traffic lights with mandatory textual reasons and danger Force Release dialog.
          </li>
          <li>
            <strong>#66 (Agents):</strong> Reuses global Agent definitions and work options.
          </li>
          <li>
            <strong>#67 (Usage & Costs):</strong> Reuses 6-view usage matrix and API-equivalent cost telemetry.
          </li>
          <li>
            <strong>#68 (Settings):</strong> Settles final fourth Manage tab label (<code>General</code>, <code>Operator</code>, or <code>Settings</code>).
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
