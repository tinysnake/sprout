import { renderIcon } from '../icons.js';
import { stateManager, type PrototypeState } from '../state.js';

export function renderInspectorSheet(state: PrototypeState): HTMLElement | null {
  if (!state.inspectorSheet.isOpen || state.inspectorSheet.kind === 'none') {
    return null;
  }

  const overlay = document.createElement('div');
  overlay.className = 'inspector-overlay';

  const sheet = document.createElement('div');
  sheet.className = 'inspector-sheet';

  const kind = state.inspectorSheet.kind;
  const entityId = state.inspectorSheet.entityId;

  if (kind === 'routing') {
    const batch = state.routingBatches.find((b) => b.id === entityId) ?? state.routingBatches[0];
    const isSettled = batch?.status === 'settled';
    const isSuppressed = batch?.status === 'suppressed';
    const isFailedClosed = batch?.status === 'failed-closed';
    const statusBadgeClass = isSettled ? 'green' : isFailedClosed ? 'red' : isSuppressed ? 'neutral' : 'blue';

    sheet.innerHTML = `
      <div class="inspector-header">
        <div>
          <h3 style="font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
            ${renderIcon('lightning', 16)}
            <span>Routing Causal Chain Inspector</span>
          </h3>
          <p style="font-size: 11px; color: var(--text-secondary);">Durable causal evidence & privacy boundary under ADR-0007</p>
        </div>
        <button class="btn btn-secondary btn-sm close-sheet-btn" aria-label="Close sheet">${renderIcon('close', 14)}</button>
      </div>
      <div class="inspector-body">
        <!-- 1. Execution Summary -->
        <div style="background: var(--bg-surface-elevated); padding: 12px; border-radius: var(--radius-sm); font-size: 12px; display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--border-subtle);">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <strong>Batch ID: <code>${batch?.id ?? 'batch-001'}</code></strong>
            <span class="status-pill ${statusBadgeClass}" style="font-size: 10px;">${batch?.status ?? 'settled'}</span>
          </div>
          <div><strong>Collection Window:</strong> ${batch?.openedAt} → ${batch?.closedAt} (${batch?.collectionWindowDurationSec ?? 30}s fixed window)</div>
          <div><strong>Wake Evaluation Model:</strong> <code>${batch?.wakeModel ?? 'gpt-4o-mini'}</code> (Attempt ${batch?.attemptsCount ?? 1} of 2)</div>
          <div><strong>Inputs in Batch:</strong> ${batch?.inputMessageIds.map((id) => `<code>${id}</code>`).join(', ') ?? 'none'}</div>
        </div>

        <!-- 2. Frozen Context Bounds & Privacy Exclusions -->
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <h4 style="font-size: 13px; font-weight: 700;">Frozen Context Bounds & Privacy Guarantee</h4>
          <div style="background: var(--bg-surface-elevated); padding: 10px; border-radius: var(--radius-sm); font-size: 12px; color: var(--text-secondary); border: 1px solid var(--border-subtle);">
            Context Tokens: <strong>${batch?.frozenContextSummary.tokenCount ?? 1840}</strong> · Project Rules: <strong>${batch?.frozenContextSummary.projectRulesIncluded ? 'Included' : 'Excluded'}</strong> · Recent Messages: <strong>${batch?.frozenContextSummary.recentMessagesCount ?? 4}</strong> · Task Summaries: <strong>${batch?.frozenContextSummary.tasksSummariesCount ?? 2}</strong> · Truncated: <strong>${batch?.frozenContextSummary.truncated ? 'Yes (Bounded Excerpt)' : 'No'}</strong>
            <div style="margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--border-subtle); font-size: 11px;">
              <strong>Strict ADR-0007 Exclusions:</strong> Direct DMs, Agent private memory, engine-native sessions, raw tool transcripts, credentials, host paths, and transient environment capacity strictly excluded.
            </div>
          </div>
        </div>

        <!-- 3. Attempt History & Fail-Closed -->
        ${
          batch?.attemptsHistory && batch.attemptsHistory.length > 0
            ? `<div style="display: flex; flex-direction: column; gap: 6px;">
                <h4 style="font-size: 13px; font-weight: 700;">Attempt History & Retry</h4>
                <div style="display: flex; flex-direction: column; gap: 4px;">
                  ${batch.attemptsHistory
                    .map(
                      (att) => `
                    <div style="background: var(--bg-surface-elevated); padding: 6px 10px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle); font-size: 11px; display: flex; justify-content: space-between; align-items: center;">
                      <div>
                        <strong>Attempt #${att.attemptNumber}</strong> (${att.wakeModel}) · <em>${att.durationMs}ms</em>
                        ${att.errorDetail ? `<div style="color: var(--red-action); font-size: 10px; margin-top: 2px;">${att.errorDetail}</div>` : ''}
                      </div>
                      <span class="status-pill ${att.status === 'success' ? 'green' : 'red'}" style="font-size: 9px;">${att.status}</span>
                    </div>
                  `
                    )
                    .join('')}
                </div>
                ${
                  isFailedClosed
                    ? `<div style="font-size: 11px; color: var(--red-action); background: var(--red-action-bg); padding: 6px 8px; border-radius: var(--radius-xs);">
                        <strong>Fail-Closed:</strong> 2nd attempt failed validation. Under ADR-0007, Sprout fails closed: zero agents woken, input preserved with durable failure.
                      </div>`
                    : ''
                }
              </div>`
            : ''
        }

        <!-- 4. Model Decision & Rationale -->
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <h4 style="font-size: 13px; font-weight: 700;">Model Decision & Concise Rationale</h4>
          ${
            batch?.decisions && batch.decisions.length > 0
              ? batch.decisions
                  .map(
                    (d) => `
              <div style="background: var(--bg-surface-elevated); border-left: 3px solid ${d.status === 'selected' ? 'var(--purple-agent)' : d.status === 'suppressed' ? 'var(--yellow-attention)' : 'var(--red-action)'}; padding: 10px; border-radius: var(--radius-sm); font-size: 12px; border: 1px solid var(--border-subtle);">
                <div style="display: flex; justify-content: space-between;">
                  <strong>Target: @${d.targetAgentId ?? 'none'}</strong>
                  <span class="status-pill ${d.status === 'selected' ? 'green' : d.status === 'suppressed' ? 'neutral' : 'red'}" style="font-size: 10px;">${d.status}</span>
                </div>
                <p style="color: var(--text-primary); margin-top: 4px; line-height: 1.4;">
                  "${d.rationale}"
                </p>
                <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px; display: flex; justify-content: space-between;">
                  <span>Input: <code>${d.messageId}</code></span>
                  <span style="font-style: italic;">[Model Judgement, Not Fact]</span>
                </div>
              </div>
            `
                  )
                  .join('')
              : `<div style="font-size: 12px; color: var(--text-muted); font-style: italic;">Collection window active; model evaluates upon window close.</div>`
          }
        </div>

        <!-- 5. Resulting WakeRequests & Admission -->
        ${
          batch?.resultingWakeRequests && batch.resultingWakeRequests.length > 0
            ? `<div style="display: flex; flex-direction: column; gap: 6px;">
                <h4 style="font-size: 13px; font-weight: 700;">Resulting WakeRequest & Admission</h4>
                ${batch.resultingWakeRequests
                  .map(
                    (w) => `
                  <div style="background: var(--bg-surface-elevated); padding: 10px; border-radius: var(--radius-sm); font-size: 12px; border: 1px solid var(--border-subtle);">
                    <div style="display: flex; justify-content: space-between;">
                      <strong>WakeRequest: <code>${w.wakeRequestId}</code></strong>
                      <span class="status-pill ${w.admissionStatus === 'admitted' ? 'green' : 'yellow'}" style="font-size: 9px;">${w.admissionStatus}</span>
                    </div>
                    <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
                      Target: <strong>@${w.targetAgentId}</strong> · Linked Run: <code>${w.linkedRunId ?? 'none'}</code> · Projected Reply: <code>${w.projectedReplyId ?? 'none'}</code>
                    </div>
                  </div>
                `
                  )
                  .join('')}
              </div>`
            : ''
        }

        <!-- 6. Human Controls Invariant Footnote -->
        <div style="font-size: 10px; color: var(--text-muted); text-align: center; margin-top: 4px;">
          Observational causal evidence under ADR-0007. No manual "Route now" or "Retry routing" buttons by design.
        </div>
      </div>
    `;
  } else if (kind === 'force-release') {
    const env = state.environments.find((e) => e.id === entityId) ?? state.environments[1]!;
    const task = state.tasks.find((t) => t.selectedEnvironmentId === env.id && t.lifecycle === 'recovery');

    sheet.innerHTML = `
      <div class="inspector-header" style="border-bottom: 2px solid var(--red-action);">
        <div>
          <h3 style="font-size: 16px; font-weight: 700; color: var(--red-action); display: flex; align-items: center; gap: 8px;">
            ${renderIcon('warning', 18)}
            <span>Emergency Force Release</span>
          </h3>
          <p style="font-size: 11px; color: var(--text-secondary);">Human-only override for otherwise stuck recovery (ADR-0009)</p>
        </div>
        <button class="btn btn-secondary btn-sm close-sheet-btn" aria-label="Close sheet">${renderIcon('close', 14)}</button>
      </div>
      <div class="inspector-body">
        <div style="background: var(--red-action-bg); border: 1px solid var(--red-action); padding: 12px; border-radius: var(--radius-sm); font-size: 12px; color: var(--text-primary);">
          <strong>EMERGENCY OVERRIDE WARNING:</strong><br/>
          Force Release bypasses normal worker proof and scratch context cleanup. It permanently marks Task #${task?.id ?? '104'} as cancelled with a forced release disposition, preserves the Project workspace, and makes the Environment immediately reassignable.
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px;">
          <h4 style="font-size: 13px; font-weight: 700;">Unresolved Operational Facts</h4>
          <div style="background: var(--bg-surface-elevated); padding: 10px; border-radius: var(--radius-sm); font-size: 12px; display: flex; flex-direction: column; gap: 4px;">
            <div>• Worker connection: Offline for 14m (engine process stop unverified).</div>
            <div>• Temporary Task context: Unrecycled on host.</div>
            <div>• Telemetry: Partial run telemetry uncollected.</div>
          </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-size: 12px; font-weight: 700;">Required Reason for Emergency Override:</label>
          <input class="force-reason-input" type="text" placeholder="e.g. Host OS kernel panic; worker cannot reconnect" style="background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); color: var(--text-primary); padding: 8px; border-radius: var(--radius-sm); font-size: 13px;" value="Host machine hard rebooted without clean worker exit" />
        </div>

        <div style="display: flex; align-items: flex-start; gap: 8px; margin-top: 4px;">
          <input type="checkbox" id="ack-risks" style="margin-top: 3px;" />
          <label for="ack-risks" style="font-size: 12px; color: var(--text-secondary);">
            I acknowledge the risks of concurrent execution and leftover temporary state, and authorize permanent emergency release.
          </label>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px;">
          <button class="btn btn-secondary btn-sm close-sheet-btn">Cancel</button>
          <button class="btn btn-danger confirm-force-btn">
            Authorize Force Release (Emergency Human Action)
          </button>
        </div>
      </div>
    `;

    sheet.querySelector('.confirm-force-btn')?.addEventListener('click', () => {
      const ack = (sheet.querySelector('#ack-risks') as HTMLInputElement)?.checked;
      if (!ack) {
        alert('You must acknowledge the risks by checking the box before proceeding.');
        return;
      }
      const reason = (sheet.querySelector('.force-reason-input') as HTMLInputElement)?.value;
      stateManager.emergencyForceRelease(env.id, task?.id ?? 'task-104', reason || 'Emergency operator override', ack);
      stateManager.closeInspector();
    });
  }

  sheet.querySelectorAll('.close-sheet-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      stateManager.closeInspector();
    });
  });

  overlay.appendChild(sheet);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      stateManager.closeInspector();
    }
  });

  return overlay;
}
