/** Portable Task proposals. No execution, Environment or lease vocabulary belongs here. */
export interface ProposalActor {
  readonly memberId: string;
  readonly memberKind: 'human' | 'agent';
}
export interface TaskProposalContent {
  readonly title: string;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly validationCriteria: readonly string[];
}
export interface TaskContentVersion extends TaskProposalContent {
  readonly version: number;
  readonly actor: ProposalActor;
  readonly at: number;
  readonly reason: string;
}
export interface TaskProposal {
  readonly id: string;
  readonly projectId: string;
  readonly proposer: ProposalActor;
  readonly status: 'proposed' | 'withdrawn' | 'rejected';
  /** All mutations, including lifecycle decisions, increment this stale-command fence. */
  readonly revision: number;
  readonly currentContentVersion: number;
  readonly versions: readonly TaskContentVersion[];
  readonly lifecycle: readonly {
    readonly action: 'withdraw' | 'reject';
    readonly actor: ProposalActor;
    readonly at: number;
    readonly reason: string;
    readonly contentVersion: number;
  }[];
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface ProposalDecision {
  readonly expectedRevision: number;
  readonly reason: string;
}
export type ReviseTaskProposal = TaskProposalContent & ProposalDecision;
export type ProposalErrorCode = 'invalid-content' | 'unknown-project' | 'unknown-proposal'
  | 'unknown-content-version' | 'membership-required' | 'authority-required'
  | 'project-read-only' | 'proposal-closed' | 'stale-proposal';
export class TaskProposalError extends Error {
  readonly code: ProposalErrorCode;
  constructor(code: ProposalErrorCode, message: string = code) {
    super(message);
    this.code = code;
    this.name = 'TaskProposalError';
  }
}
