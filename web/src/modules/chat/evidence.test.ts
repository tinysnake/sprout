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

test('a reply-less direct message with a failed run labels the run outcome, not an inference', async () => {
  const service = new FixtureChatService();
  const message = (await service.listMessages()).find((item) => item.id === 'msg-dm-failed')!;
  const evidence = await service.messageRouting('msg-dm-failed');

  // Without a run outcome the durable wake still reads as routed…
  assert.equal(evidenceState(evidence, message), 'routed');
  // …and the server's `{id,status}` projection makes the failed run decisive.
  assert.equal(evidenceState(evidence, message, 'failed'), 'run-failed');
  assert.equal(evidenceState(evidence, message, 'running'), 'routed', 'a live run is not a failure');
  assert.equal(evidence.deterministicWakes[0]?.runId, 'run-failed', 'the WakeRequest links the durable run');
});

test('admission refusals preserve distinct read-only reasons', () => {
  assert.match(readOnlyReason('project-archived'), /archived/);
  assert.match(readOnlyReason('working-group-disbanded'), /disbanded/);
  assert.match(readOnlyReason('membership-ended'), /membership has ended/);
});
