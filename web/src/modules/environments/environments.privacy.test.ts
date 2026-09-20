import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixtureEnvironmentService } from './adapters/fixture-adapter.ts';

test('Privacy Boundary: fixtures and returned facts contain no private host paths or credentials', async () => {
  const service = new FixtureEnvironmentService();
  const envs = await service.listEnvironments();

  const serialized = JSON.stringify(envs);

  // 1. No personal or host home paths
  assert.equal(
    /\/Users\//i.test(serialized),
    false,
    'Must not contain macOS /Users/ paths'
  );
  assert.equal(
    /\/home\//i.test(serialized),
    false,
    'Must not contain Linux /home/ paths'
  );
  assert.equal(
    /[A-Z]:\\Users\\/i.test(serialized),
    false,
    'Must not contain Windows C:\\Users\\ paths'
  );

  // 2. No private IP addresses or network bindings
  assert.equal(
    /\b192\.168\.\d+\.\d+\b/.test(serialized),
    false,
    'Must not leak private 192.168.x.x addresses'
  );
  assert.equal(
    /\b10\.\d+\.\d+\d+\b/.test(serialized),
    false,
    'Must not leak private 10.x.x.x addresses'
  );

  // 3. No real credentials or API tokens
  assert.equal(
    /sk-[a-zA-Z0-9]{20,}/.test(serialized),
    false,
    'Must not contain OpenAI API key patterns'
  );
  assert.equal(
    /ghp_[a-zA-Z0-9]{20,}/.test(serialized),
    false,
    'Must not contain GitHub personal tokens'
  );
  assert.equal(
    /BEGIN (RSA|OPENSSH) PRIVATE KEY/.test(serialized),
    false,
    'Must not contain private keys'
  );

  // 4. Bound workspaces use neutral relative paths
  for (const env of envs) {
    for (const ws of env.boundWorkspaces) {
      assert.equal(
        ws.workspaceRoot.startsWith('/'),
        false,
        `Workspace root '${ws.workspaceRoot}' should be neutral identifier, not absolute host path`
      );
      assert.equal(
        ws.relativeWorkspacePath.startsWith('/'),
        false,
        `Relative path '${ws.relativeWorkspacePath}' should be relative`
      );
    }
  }

  // 5. Engine readiness exposes only neutral status strings
  const validEngineStatuses = new Set(['ready', 'login-required', 'missing', 'unknown']);
  for (const env of envs) {
    assert.ok(validEngineStatuses.has(env.engineReadiness.codex));
    assert.ok(validEngineStatuses.has(env.engineReadiness.pi));
    assert.ok(validEngineStatuses.has(env.engineReadiness.agy));
    assert.ok(validEngineStatuses.has(env.engineReadiness.opencode));
  }
});

test('Privacy Boundary: display names and reasons stay free of identity and infrastructure facts', async () => {
  const service = new FixtureEnvironmentService();
  const envs = await service.listEnvironments();

  for (const env of envs) {
    // The opaque Worker identity is never displayed; only its presence is.
    assert.equal(
      /identity[:=]\s*\S{8,}/i.test(env.trafficLightReason),
      false,
      `reason must not display an identity value: ${env.trafficLightReason}`,
    );
    for (const probe of env.probeHistory) {
      assert.equal(
        /wss?:\/\/|https?:\/\//i.test(probe.summary),
        false,
        `probe summary must not display a transport address: ${probe.summary}`,
      );
    }
    for (const ws of env.boundWorkspaces) {
      assert.equal(
        /[A-Za-z]:\\|\~\//.test(`${ws.workspaceRoot}/${ws.relativeWorkspacePath}`),
        false,
        `workspace label must stay neutral: ${ws.workspaceRoot}/${ws.relativeWorkspacePath}`,
      );
    }
  }
});
