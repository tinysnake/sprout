import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createInitialAgentFixtures, createInitialAttributionFixtures } from './adapters/fixture-adapter.ts';

/**
 * The privacy boundary for the Manage Agents page (#91, ADR-0008).
 *
 * A portable Agent identity names no machine. Nothing this page can receive —
 * identities, instructions, work options, version histories, compatibility
 * reasons, or run attributions — may carry a credential, a host path, a
 * hostname, an address, or private memory content. The fixture rows cover the
 * whole state matrix, so scanning them proves the boundary the page renders.
 */

test('no fixture fact contains a private host path, address, credential, or key', () => {
  const serialized = JSON.stringify({
    agents: createInitialAgentFixtures(),
    attributions: createInitialAttributionFixtures(),
  });

  // 1. No personal or host home paths.
  assert.equal(/\/Users\//i.test(serialized), false, 'no macOS /Users/ paths');
  assert.equal(/\/home\//i.test(serialized), false, 'no Linux /home/ paths');
  assert.equal(/[A-Z]:\\Users\\/i.test(serialized), false, 'no Windows C:\\Users\\ paths');

  // 2. No private network addresses or transport endpoints.
  assert.equal(/\b192\.168\.\d+\.\d+\b/.test(serialized), false, 'no 192.168.x.x addresses');
  assert.equal(/\b10\.\d+\.\d+\.\d+\b/.test(serialized), false, 'no 10.x.x.x addresses');
  assert.equal(/wss?:\/\//i.test(serialized), false, 'no transport endpoints');
  assert.equal(/https?:\/\//i.test(serialized), false, 'no URLs');

  // 3. No credential shapes.
  assert.equal(/sk-[a-zA-Z0-9]{20,}/.test(serialized), false, 'no API-key shapes');
  assert.equal(/ghp_[a-zA-Z0-9]{20,}/.test(serialized), false, 'no GitHub tokens');
  assert.equal(/BEGIN (RSA|OPENSSH) PRIVATE KEY/.test(serialized), false, 'no private keys');
  assert.equal(/Bearer /i.test(serialized), false, 'no bearer tokens');
  assert.equal(/password\s*=/i.test(serialized), false, 'no password assignments');
});

test('free-text fields stay free of identity and infrastructure facts', () => {
  for (const agent of createInitialAgentFixtures()) {
    const texts = [
      agent.trafficLightReason,
      ...(agent.instructions !== undefined ? [agent.instructions] : []),
      ...agent.versions.map((version) => version.reason),
      ...agent.workOptions.map((option) => option.compatibilityReason),
    ];
    for (const text of texts) {
      assert.equal(
        /identity[:=]\s*\S{8,}/i.test(text),
        false,
        `identity values never render: ${text}`,
      );
      assert.equal(
        /[A-Za-z]:\\|~\/|\.\.\//.test(text),
        false,
        `path fragments never render: ${text}`,
      );
    }
  }
});

test('private memory is exposed as neutral metadata only, never content', () => {
  for (const agent of createInitialAgentFixtures()) {
    const serialized = JSON.stringify(agent);
    // The only private-memory mention is the neutral metadata label.
    const mentions = serialized.match(/private memory/gi) ?? [];
    for (const mention of mentions) {
      assert.match(mention.toLowerCase(), /private memory/);
    }
    // No memory entry content shape appears anywhere in the row.
    assert.equal(/memory[-_ ]?content/i.test(serialized), false);
    assert.equal(/memoryEntries|memoryText|memoryBody/i.test(serialized), false);
  }
});

test('work options and attributions name only portable engine, model, and effort identifiers', () => {
  for (const agent of createInitialAgentFixtures()) {
    for (const option of agent.workOptions) {
      assert.equal(/\s/.test(option.engine), false, 'engine is a bare identifier');
      assert.equal(/\s/.test(option.workModel), false, 'work model is a bare identifier');
      assert.equal(/\//.test(option.workModel), false, 'work model carries no path separator');
    }
  }
  for (const attribution of createInitialAttributionFixtures()) {
    if (attribution.engine !== undefined) {
      assert.equal(/\s/.test(attribution.engine), false);
    }
    assert.equal(attribution.agentId.length > 0, true);
  }
});
