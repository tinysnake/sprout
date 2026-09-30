import type { MessageView } from '../../../../src/web/views.ts';
import type { RoutingEvidenceView } from '../../adapters/routing-api.ts';

export type EvidenceState = 'projected' | 'pending' | 'failed' | 'suppressed' | 'routed' | 'informational';

/** Evidence is a server projection; this function only labels its visible state. */
export function evidenceState(evidence: RoutingEvidenceView, message?: MessageView): EvidenceState {
  const empty = !evidence.window && evidence.batches.length === 0 &&
    evidence.deterministicWakes.length === 0 && evidence.observations.length === 0;
  if (message?.authorKind === 'agent' && empty) return 'projected';
  if (evidence.window?.status === 'open' || evidence.batches.some((detail) => detail.batch.status === 'frozen')) return 'pending';
  if (evidence.batches.some((detail) => detail.batch.status === 'failed' || detail.outcomes.some((outcome) => outcome.status === 'failed')) ||
    evidence.observations.some((observation) => observation.status === 'failed')) return 'failed';
  if (evidence.batches.some((detail) => detail.batch.status === 'suppressed' || detail.outcomes.some((outcome) => outcome.status === 'suppressed'))) return 'suppressed';
  if (evidence.deterministicWakes.length || evidence.batches.some((detail) => detail.batch.status === 'routed')) return 'routed';
  return evidence.observations.some((observation) => observation.reason !== 'unaddressed') ? 'suppressed' : 'informational';
}

export function readOnlyReason(reason?: string): string {
  switch (reason) {
    case 'project-archived': return 'Project is archived. All communication is read-only.';
    case 'working-group-disbanded': return 'This Working Group has been disbanded. Conversation history is preserved as read-only.';
    case 'membership-ended': return 'Agent membership has ended in this Project. History is preserved; new messages cannot be sent.';
    case 'not-a-participant': return 'You are not a participant in this conversation. New messages cannot be sent.';
    case 'not-a-member': return 'You are not a current Project member. New messages cannot be sent.';
    default: return 'Conversation admission is unavailable. New messages cannot be sent.';
  }
}
