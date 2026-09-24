import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentRegistry } from '../agent/registry.ts';
import { createRunApi } from './api.ts';
import type { ApiRouter } from './router.ts';

import { build, protectedApi, signIn } from './api-harness.ts';

test('protected API requires a browser session and request-forgery proof for Human commands', async () => {
  const protectedRuntime = await protectedApi();
  try {
    assert.equal((await fetch(`${protectedRuntime.base}/api/runs`)).status, 401);
    assert.equal((await fetch(`${protectedRuntime.base}/api/runs`, { method: 'POST' })).status, 401);

    const browser = await signIn(protectedRuntime.base, protectedRuntime.credential);
    assert.equal((await fetch(`${protectedRuntime.base}/api/runs`, { headers: { cookie: browser.cookie } })).status, 200);
    assert.equal(
      (await fetch(`${protectedRuntime.base}/api/runs`, {
        method: 'POST', headers: { cookie: browser.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'agent-scout', prompt: 'bounded request' }),
      })).status,
      403,
    );
    const submitted = await fetch(`${protectedRuntime.base}/api/runs`, {
      method: 'POST',
      headers: { cookie: browser.cookie, 'x-sprout-csrf': browser.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-scout', prompt: 'bounded request' }),
    });
    assert.equal(submitted.status, 202);
  } finally {
    await protectedRuntime.api.close();
  }
});

test('protected API lists and revokes sessions without exposing bearer values', async () => {
  const protectedRuntime = await protectedApi();
  try {
    const first = await signIn(protectedRuntime.base, protectedRuntime.credential);
    const second = await signIn(protectedRuntime.base, protectedRuntime.credential);
    const list = await fetch(`${protectedRuntime.base}/api/auth/sessions`, { headers: { cookie: first.cookie } });
    assert.equal(list.status, 200);
    const sessions = (await list.json()) as { sessions: { id: string; current: boolean }[] };
    assert.equal(sessions.sessions.length, 2);
    assert.equal(JSON.stringify(sessions).includes('sprout_session'), false);

    const revoked = await fetch(`${protectedRuntime.base}/api/auth/sessions/revoke-others`, {
      method: 'POST', headers: { cookie: first.cookie, 'x-sprout-csrf': first.csrf },
    });
    assert.equal(revoked.status, 200);
    assert.equal(((await revoked.json()) as { revoked: number }).revoked, 1);
    assert.equal((await fetch(`${protectedRuntime.base}/api/runs`, { headers: { cookie: second.cookie } })).status, 401);
  } finally {
    await protectedRuntime.api.close();
  }
});

test('an additive domain router composes without changing preserved M1 routes', async () => {
  const context = build();
  const futureRouter: ApiRouter = {
    name: 'future-domain',
    async handle(request) {
      if (request.method !== 'GET' || request.pathname !== '/api/future') return false;
      const payload = JSON.stringify({ source: 'future-domain' });
      request.response.writeHead(200, { 'content-type': 'application/json' });
      request.response.end(payload);
      return true;
    },
  };
  const api = createRunApi({ orchestrator: context.orchestrator, agents: new AgentRegistry([
    { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
  ]), routers: [futureRouter] });
  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/api/future`)).json(), { source: 'future-domain' });
    assert.equal((await fetch(`${base}/api/runs`)).status, 200, 'the M1 route remains composed after the new domain route');
  } finally {
    await api.close();
  }
});

test('a non-matching router cannot consume the matching router request body', async () => {
  const context = build();
  const inspectingRouter: ApiRouter = {
    name: 'inspecting-non-match',
    async handle(request) {
      await request.readBody();
      return false;
    },
  };
  const matchingRouter: ApiRouter = {
    name: 'matching-domain',
    async handle(request) {
      if (request.method !== 'POST' || request.pathname !== '/api/future-command') return false;
      const body = await request.readBody();
      request.response.writeHead(200, { 'content-type': 'application/json' });
      request.response.end(JSON.stringify(body));
      return true;
    },
  };
  const api = createRunApi({
    orchestrator: context.orchestrator,
    agents: new AgentRegistry([
      { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
    ]),
    routers: [inspectingRouter, matchingRouter],
  });
  const { port } = await api.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/future-command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'preserve-this-payload' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { command: 'preserve-this-payload' });
  } finally {
    await api.close();
  }
});
