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
        <span style="font-size: 16px;">📝</span>
        <strong style="font-size: 14px;">Product Owner Interactive Review Summary (Ticket #53)</strong>
      </div>
      <button class="btn btn-secondary btn-sm close-review-btn">✕ Close</button>
    </div>
    <div class="review-drawer-content">
      <div style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm);">
        <h4 style="font-weight: 700; color: var(--green-ready); font-size: 13px;">✅ Candidate Accepted Patterns</h4>
        <ul style="margin-left: 18px; margin-top: 4px; display: flex; flex-direction: column; gap: 4px;">
          <li><strong>Attention Hub as Landing Surface:</strong> High-priority Human interventions (validation claims, recovery, blockers, pending enrollments) surfaced upfront.</li>
          <li><strong>3-Lifecycle Distinction Banner:</strong> Distinct visible sentence <code>Task state · Agent run state · Task lease state</code> prevents conflating nested execution with resource ownership.</li>
          <li><strong>Two-Stage Pause & Interrupt:</strong> First stage requests admission hold allowing current run to settle; second stage provides explicit run interrupt settling as <code>stopped</code> with lease held.</li>
          <li><strong>Non-Routing Projected Replies:</strong> Agent replies clearly marked as non-routing to guarantee loop prevention.</li>
          <li><strong>6-Dimension Health with Traffic Light:</strong> Green/Yellow/Red summary always accompanied by decisive text reason and independent health dimensions.</li>
          <li><strong>Emergency Force Release:</strong> Human-only override listing unresolved facts, requiring risk acknowledgement and mandatory reason.</li>
          <li><strong>Truthful Usage & Cost:</strong> Distinguishes API-equivalent USD estimates from unavailable billed costs; separates work-model from wake-model activities.</li>
        </ul>
      </div>

      <div style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm);">
        <h4 style="font-weight: 700; color: var(--red-action); font-size: 13px;">❌ Candidate Rejected Patterns</h4>
        <ul style="margin-left: 18px; margin-top: 4px; display: flex; flex-direction: column; gap: 4px;">
          <li><strong>Read-only mobile fallback:</strong> Rejected in favor of 100% full mobile & desktop capability parity.</li>
          <li><strong>Single collapsed status:</strong> Rejected collapsing Task, Agent run, and Environment lease into one label.</li>
          <li><strong>Automatic lease expiry or preemption:</strong> Rejected releasing leases upon timeout or run completion.</li>
          <li><strong>Treating missing cost as $0.00:</strong> Rejected hiding incomplete telemetry inside zero subtotals.</li>
        </ul>
      </div>

      <div style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm);">
        <h4 style="font-weight: 700; color: var(--yellow-attention); font-size: 13px;">❓ Unresolved Questions & Implementation Guidance</h4>
        <ul style="margin-left: 18px; margin-top: 4px; display: flex; flex-direction: column; gap: 4px;">
          <li>Exact streaming granularity representation on high-latency mobile connections.</li>
          <li>Wake-model concrete telemetry schema once low-cost model providers are benchmarked in M2.</li>
        </ul>
      </div>
    </div>
  `;

  drawer.querySelector('.close-review-btn')?.addEventListener('click', () => {
    stateManager.toggleReviewDrawer(false);
  });

  return drawer;
}
