import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RoutingEvidenceView } from '../../adapters/routing-api.ts';
import { FixtureChatService } from './adapters/fixture-adapter.ts';
import { evidenceState, readOnlyReason } from './evidence.ts';

test('routing evidence keeps pending, suppressed, fail-closed, deterministic and non-routing replies distinct', async () => {
  const service = new FixtureChatService();
  const cases = [
    ['msg-addressed', 'routed'], ['msg-pending', 'pending'], ['msg-suppressed', 'suppressed'],
    ['msg-failed', 'failed'], ['reply-msg-addressed:programmer', 'projected'], ['msg-dm', 'informational'],
  ] as const;
  const messages = await service.listMessages();
  for (const [id, expected] of cases) {
    const message = messages.find((item) => item.id === id)!;
    assert.equal(evidenceState(await service.messageRouting(id), message), expected, id);
  }
  const eventEvidence = await service.eventRouting('event-review');
  assert.equal(evidenceState(eventEvidence as RoutingEvidenceView), 'informational');
});

test('admission refusals preserve distinct read-only reasons', () => {
  assert.match(readOnlyReason('project-archived'), /archived/);
  assert.match(readOnlyReason('working-group-disbanded'), /disbanded/);
  assert.match(readOnlyReason('membership-ended'), /membership has ended/);
});
