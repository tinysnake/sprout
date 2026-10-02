import type { AgentRun } from '../run/model.ts';
import type { PublishEventInput } from './coordinator.ts';

/** Stable event kind for a Human-requested Chat run interruption. */
export const RUN_INTERRUPTION_EVENT_KIND = 'agent-run-interruption';

/** Idempotency: one informational event for one intentionally interrupted run. */
export function runInterruptionDeliveryKey(runId: string): string {
  return `run-interruption:${runId}`;
}

/** Project a Human-requested interruption into safe, product-owned copy. */
export function runInterruptionEventInput(run: AgentRun): PublishEventInput | undefined {
  if (run.status !== 'interrupted' || run.interruptionReason !== 'human-stop' || run.projectId === undefined) {
    return undefined;
  }
  return {
    projectId: run.projectId,
    kind: RUN_INTERRUPTION_EVENT_KIND,
    summary: `Agent run interrupted for ${run.agentId}`,
    detail: `run ${run.id} · agent ${run.agentId} · Reason: stopped by Human`,
    producer: { id: 'sprout', kind: 'system' },
    disposition: 'informational',
    deliveryKey: runInterruptionDeliveryKey(run.id),
    awaitReply: false,
  };
}
