/** Collaboration-owned Human resolution of Feed attention; historical facts stay immutable. */
import { sanitizeIdentifier } from '../environment/privacy.ts';
import type { CollaborationStore } from './store.ts';

export type CollaborationAttentionKind = 'event' | 'wake-input' | 'routing-batch';
export interface CollaborationAttentionResolution {
  readonly projectId: string;
  readonly kind: CollaborationAttentionKind;
  readonly sourceId: string;
  readonly humanId: string;
  readonly resolvedAt: number;
  /** Append-only failure count at resolution; a later failure requires new attention. */
  readonly sourceVersion: number;
}
export interface ResolveCollaborationAttention {
  readonly projectId: string;
  readonly kind: CollaborationAttentionKind;
  readonly sourceId: string;
  readonly actor: { readonly id: string; readonly kind: 'human' | 'agent' | 'system' };
  readonly now: number;
}
/** Safe read model: diagnostic detail and Message content never enter the Feed port. */
export interface FailedWakeInput {
  readonly inputId: string;
  readonly inputKind: 'message' | 'event';
  readonly projectId: string;
  readonly failedTargetCount: number;
  readonly version: number;
  readonly at: number;
}

export class AttentionResolutionError extends Error {
  readonly code: 'human-required' | 'invalid-resolution' | 'unknown-source';
  constructor(code: AttentionResolutionError['code']) {
    super(code === 'human-required' ? 'Only a Human may resolve collaboration Attention.' :
      code === 'unknown-source' ? 'No resolvable Attention source belongs to this Project.' : 'Invalid Attention resolution.');
    this.code = code;
  }
}

/** Shared validation for both stores. No retry, admission, event edit, or domain action. */
export async function validateAttentionResolution(store: CollaborationStore, input: ResolveCollaborationAttention): Promise<CollaborationAttentionResolution> {
  if (input.actor.kind !== 'human') throw new AttentionResolutionError('human-required');
  const humanId = sanitizeIdentifier(input.actor.id, { fallback: '' });
  if (!humanId || !Number.isFinite(input.now) || input.now < 0) throw new AttentionResolutionError('invalid-resolution');
  let valid = false;
  let sourceVersion = 0;
  if (input.kind === 'event') {
    const event = await store.getEvent(input.sourceId);
    valid = event?.projectId === input.projectId && event.disposition === 'human-action-required';
  } else if (input.kind === 'routing-batch') {
    const batch = await store.getRoutingBatch(input.sourceId);
    valid = batch?.projectId === input.projectId && batch.status === 'failed';
  } else if (input.kind === 'wake-input') {
    const failure = (await store.listWakeFailures()).find(f => f.inputId === input.sourceId && f.projectId === input.projectId);
    valid = failure !== undefined;
    sourceVersion = failure?.version ?? 0;
  }
  if (!valid) throw new AttentionResolutionError('unknown-source');
  return { projectId: input.projectId, kind: input.kind, sourceId: input.sourceId, humanId, resolvedAt: input.now, sourceVersion };
}
