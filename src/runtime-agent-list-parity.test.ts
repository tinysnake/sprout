import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readinessWorkflowHarness } from './runtime-test-harness.ts';

/**
 * List-versus-compatibility parity for an Agent's ordered work options (#173).
 *
 * The list route (`GET /api/agents`) and the compatibility route
 * (`GET /api/agents/:id/compatibility`) are two read projections of the same
 * durable ordered options: the list must show each Agent's declared options
 * and the compatibility route must resolve those same options against current
 * Environment facts. This test runs against the composed production runtime —
 * real HTTP, the real Agent router, and the runtime's own compatibility
 * closure — so it proves what a browser actually receives rather than what a
 * test double would.
 */

test('#173 the Agents list carries the same ordered work options the compatibility route resolves', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sprout-173-list-parity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const h = await readinessWorkflowHarness({
    backend: 'memory',
    directory,
    engineId: 'scripted',
    agents: [],
  });
  try {
    const created = await fetch(`${h.base}/api/agents`, {
      method: 'POST',
      headers: {
        cookie: h.cookie,
        'x-sprout-csrf': h.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: 'dual-option',
        displayName: 'Dual Option',
        workOptions: [
          { id: 'option-codex', engine: 'codex', workModel: 'gpt-5.2-codex', effort: 'high' },
          { id: 'option-pi', engine: 'pi', workModel: 'glm-5', effort: 'medium' },
        ],
      }),
    });
    assert.equal(created.status, 201);

    const listResponse = await fetch(`${h.base}/api/agents`, { headers: { cookie: h.cookie } });
    assert.equal(listResponse.status, 200);
    const listed = (await listResponse.json()) as {
      readonly agents: readonly {
        readonly id: string;
        readonly workOptions?: readonly Record<string, unknown>[];
      }[];
    };
    const row = listed.agents.find((candidate) => candidate.id === 'dual-option');
    assert.ok(row, 'the created Agent is listed');

    const compatibilityResponse = await fetch(`${h.base}/api/agents/dual-option/compatibility`, {
      headers: { cookie: h.cookie },
    });
    assert.equal(compatibilityResponse.status, 200);
    const compatibility = (await compatibilityResponse.json()) as {
      readonly options: readonly { readonly option: Record<string, unknown> }[];
    };

    // Parity: for an Agent with multiple options, the list's `workOptions`
    // are exactly the option values the compatibility projection walks —
    // same order, same ids, same engine/workModel/effort (#173).
    assert.equal(compatibility.options.length, 2, 'the Agent has multiple options');
    assert.deepEqual(
      row.workOptions,
      compatibility.options.map((entry) => entry.option),
      'the list and the compatibility route must agree on the ordered options',
    );

    // Privacy: the projected field carries only the portable option fields.
    // No credential, host path, address, or Environment internal may ride the
    // list row (#173 acceptance 3), so the key set is closed by assertion.
    for (const option of row.workOptions ?? []) {
      assert.deepEqual(Object.keys(option).sort(), ['effort', 'engine', 'id', 'workModel']);
    }
  } finally {
    await h.close();
  }
});
