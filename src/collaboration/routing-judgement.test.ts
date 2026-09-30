/**
 * The frozen routing judgement contract (#97, ADR-0007).
 *
 * Every answer is fully accounted or invalid: omitted inputs, unknown names,
 * contradictions, and malformed text all fail with a specific durable kind,
 * and model rationale is redacted text, never trusted structure.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRoutingJudgement, ROUTING_JUDGEMENT_CONTRACT } from './routing-judgement.ts';

const expectation = {
  inputIds: ['msg-1', 'msg-2'],
  candidatesByInput: new Map([
    ['msg-1', ['scout', 'forge']],
    ['msg-2', ['forge']],
  ]),
};

test('a fully accounted judgement parses into per-input assignments in input order', () => {
  const result = parseRoutingJudgement(
    JSON.stringify({
      selections: [
        { agentId: 'forge', inputIds: ['msg-2'], rationale: 'Build work.' },
        { agentId: 'scout', inputIds: ['msg-1'], rationale: 'Investigation.' },
      ],
      suppressions: [],
    }),
    expectation,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.judgement.selections.map((entry) => entry.inputId),
    ['msg-1', 'msg-2'],
    'output order never leaks into the persisted per-input order',
  );
  assert.equal(result.judgement.selections[1]?.assignments[0]?.agentId, 'forge');
  assert.deepEqual(result.judgement.suppressions, []);
});

test('one selection may cover several inputs and duplicate agents are deduplicated', () => {
  const result = parseRoutingJudgement(
    JSON.stringify({
      selections: [
        { agentId: 'forge', inputIds: ['msg-1', 'msg-2'], rationale: 'Both are build work.' },
        { agentId: 'forge', inputIds: ['msg-2'], rationale: 'Restated.' },
      ],
    }),
    expectation,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const second = result.judgement.selections.find((entry) => entry.inputId === 'msg-2');
  assert.equal(second?.assignments.length, 1, 'the same Agent is assigned once per input');
});

test('an omitted input fails as incomplete — a plausible subset is never salvaged', () => {
  const result = parseRoutingJudgement(
    JSON.stringify({
      selections: [{ agentId: 'scout', inputIds: ['msg-1'], rationale: 'Handle the first.' }],
      suppressions: [],
    }),
    expectation,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, 'incomplete-output');
  assert.match(result.detail, /msg-2/);
});

test('a selection naming a non-candidate fails as unknown-agent', () => {
  const result = parseRoutingJudgement(
    JSON.stringify({
      selections: [{ agentId: 'scout', inputIds: ['msg-1', 'msg-2'], rationale: 'Handle both.' }],
    }),
    expectation,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, 'unknown-agent');
  assert.match(result.detail, /not eligible/);
});

test('a judgement naming a foreign input fails as unknown-input', () => {
  const suppressed = parseRoutingJudgement(
    JSON.stringify({ selections: [], suppressions: [{ inputId: 'msg-ghost', rationale: 'x' }] }),
    expectation,
  );
  assert.equal(suppressed.ok, false);
  if (!suppressed.ok) assert.equal(suppressed.kind, 'unknown-input');

  const selected = parseRoutingJudgement(
    JSON.stringify({
      selections: [{ agentId: 'scout', inputIds: ['msg-ghost'], rationale: 'x' }],
    }),
    expectation,
  );
  assert.equal(selected.ok, false);
  if (!selected.ok) assert.equal(selected.kind, 'unknown-input');
});

test('malformed answers fail as malformed-output without echoing arbitrary output', () => {
  for (const raw of [
    'not json {',
    '"just a string"',
    '[1, 2, 3]',
    '{"selections": "yes"}',
    '{"selections": [{"inputIds": ["msg-1"]}]}',
    '{"selections": [{"agentId": "scout", "inputIds": []}]}',
    '{"selections": [42]}',
    '{"selections": [], "suppressions": [null]}',
  ]) {
    const result = parseRoutingJudgement(raw, expectation);
    assert.equal(result.ok, false, `rejected: ${raw}`);
    if (result.ok) continue;
    assert.equal(result.kind, 'malformed-output', `kind for ${raw}`);
    assert.ok(result.detail.length <= 400, 'failure details stay bounded');
  }
});

test('invalid model output never copies caller-controlled identifiers or parser excerpts into failure evidence', () => {
  const opaque = 'SYNTHETIC_OPAQUE_PROVIDER_VALUE_ABC123';
  for (const raw of [
    `{"selections":${opaque}`,
    JSON.stringify({ selections: [{ agentId: opaque, inputIds: ['msg-1'] }] }),
    JSON.stringify({ selections: [], suppressions: [{ inputId: opaque }] }),
  ]) {
    const result = parseRoutingJudgement(raw, expectation);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(!result.detail.includes(opaque));
  }
});

test('contradictory accounting fails as invalid-output', () => {
  const both = parseRoutingJudgement(
    JSON.stringify({
      selections: [{ agentId: 'scout', inputIds: ['msg-1'], rationale: 'x' }],
      suppressions: [{ inputId: 'msg-1', rationale: 'also this' }],
    }),
    expectation,
  );
  assert.equal(both.ok, false);
  if (!both.ok) assert.equal(both.kind, 'invalid-output');

  const twice = parseRoutingJudgement(
    JSON.stringify({
      selections: [],
      suppressions: [
        { inputId: 'msg-1', rationale: 'x' },
        { inputId: 'msg-1', rationale: 'again' },
      ],
    }),
    expectation,
  );
  assert.equal(twice.ok, false);
  if (!twice.ok) assert.equal(twice.kind, 'invalid-output');
});

test('rationale text is redacted and bounded before it can become evidence', () => {
  const result = parseRoutingJudgement(
    JSON.stringify({
      selections: [
        {
          agentId: 'scout',
          inputIds: ['msg-1'],
          rationale: `reach me at jane.doe@example.com or on /home/jane/notes ${'x'.repeat(500)}`,
        },
      ],
      suppressions: [{ inputId: 'msg-2', rationale: 'ask jane.doe@example.com about it' }],
    }),
    expectation,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const rationale = result.judgement.selections[0]!.assignments[0]!.rationale;
  assert.ok(rationale.length <= 400, 'rationale is bounded');
  assert.ok(!rationale.includes('jane.doe@example.com'), 'identities are redacted');
  assert.ok(!rationale.includes('/home/jane'), 'host paths are redacted');
  const suppression = result.judgement.suppressions[0]!.rationale;
  assert.ok(suppression.length <= 400, 'suppression rationale is bounded');
  assert.ok(
    !suppression.includes('jane.doe@example.com'),
    'suppression rationale passes the same redaction boundary',
  );
});

test('the contract text is self-describing and carries the accounting rule', () => {
  assert.match(ROUTING_JUDGEMENT_CONTRACT, /selections/);
  assert.match(ROUTING_JUDGEMENT_CONTRACT, /suppressions/);
  assert.match(ROUTING_JUDGEMENT_CONTRACT, /exactly once/);
  assert.match(ROUTING_JUDGEMENT_CONTRACT, /deliberate suppression, not failure/);
});
