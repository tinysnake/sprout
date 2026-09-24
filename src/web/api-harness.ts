import assert from 'node:assert/strict';

import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import { AgentRegistry } from '../agent/registry.ts';
import { ProjectRegistry } from '../project/registry.ts';
import { InMemoryRunStore } from '../run/store.ts';
import { RunOrchestrator } from '../run/orchestrator.ts';
import { CollaborationCoordinator } from '../collaboration/coordinator.ts';
import { InMemoryCollaborationStore } from '../collaboration/store.ts';
import { createRunApi } from './api.ts';
import { OperatorSessionService } from '../auth/service.ts';
import { InMemoryOperatorSessionStore } from '../auth/store.ts';
import { randomBytes } from 'node:crypto';

export const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};
export const instance: EnvironmentInstance = { id: 'mac-mini-1', definitionId: 'macos-workstation' };

/** The project that gives Scout its environment access. */
export const projects = new ProjectRegistry([
  {
    id: 'project-sprout',
    goal: 'Ship Sprout',
    rules: [],
    availableEnvironmentInstanceIds: ['mac-mini-1'],
    memberships: [
      { agentId: 'agent-scout', responsibilities: ['Investigate'], collaborationInstructions: '' },
    ],
  },
]);

export function build(options: {
  settleAfterMs?: number;
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
} = {}) {
  const adapter = new ScriptedEngineAdapter({
    turns: [
      {
        events: [
          { type: 'tool-call', name: 'shell', detail: 'echo hi' },
          { type: 'message', text: 'done', final: true },
        ],
        result: {
          status: 'completed',
          text: 'done',
          ...(options.tokenUsage !== undefined ? { tokenUsage: options.tokenUsage } : {}),
        },
        ...(options.settleAfterMs !== undefined ? { settleAfterMs: options.settleAfterMs } : {}),
      },
    ],
  });
  const registry = new AgentRegistry([
    {
      id: 'agent-scout',
      name: 'Scout',
      engine: 'scripted',
      capability: 'agent-run',
      workingDirectory: '/tmp',
    },
  ]);
  const pool = new EnvironmentPool({ definitions: [definition], instances: [instance] });
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: registry,
    projects,
    pool,
    store: new InMemoryRunStore(),
    leaseTtlMs: 60_000,
  });
  const api = createRunApi({ orchestrator, agents: registry });
  return { api, orchestrator, pool };
}

export async function withServer(
  fn: (base: string, context: ReturnType<typeof build>) => Promise<void>,
  options: {
    settleAfterMs?: number;
    tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  } = {},
): Promise<void> {
  const context = build(options);
  const { port } = await context.api.listen(0);
  try {
    await fn(`http://127.0.0.1:${port}`, context);
  } finally {
    await context.api.close();
  }
}

export async function waitForTerminal(base: string, id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${base}/api/runs/${id}`);
    const run = (await response.json()) as Record<string, unknown>;
    if (run.status !== 'running' && run.status !== 'queued') return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('run did not settle');
}

export interface SseRunEvent {
  readonly cursor: string;
  readonly run: { readonly id: string; readonly status: string };
}

export function sseRunEvents(text: string): readonly SseRunEvent[] {
  return [...text.matchAll(/^id: ([^\n]+)\nevent: run\ndata: (.+)$/gm)].map((match) => ({
    cursor: match[1]!,
    run: JSON.parse(match[2]!) as { readonly id: string; readonly status: string },
  }));
}

export async function readSseUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ready: (text: string) => boolean,
): Promise<string> {
  let text = '';
  const decoder = new TextDecoder();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !ready(text)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  assert.ok(ready(text), 'SSE stream did not deliver the expected event before its deadline');
  return text;
}

export function privateInput(): string {
  return randomBytes(32).toString('base64url');
}

export async function protectedApi() {
  const context = build();
  const auth = new OperatorSessionService({ store: new InMemoryOperatorSessionStore() });
  const credential = privateInput();
  await auth.initializeOrRecover(credential);
  const api = createRunApi({
    orchestrator: context.orchestrator,
    agents: new AgentRegistry([
      { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
    ]),
    auth,
  });
  const { port } = await api.listen(0);
  return { api, auth, credential, base: `http://127.0.0.1:${port}` };
}

export async function signIn(base: string, credential: string): Promise<{ readonly cookie: string; readonly csrf: string }> {
  const response = await fetch(`${base}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential }),
  });
  assert.equal(response.status, 201);
  const setCookie = response.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Max-Age=\d+/);
  assert.match(setCookie, /Expires=/);
  assert.equal(setCookie.includes(credential), false);
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  return { cookie: setCookie.split(';', 1)[0]!, csrf: csrfToken };
}


export function buildWithCollaboration(options: { body?: string } = {}, auth?: OperatorSessionService) {
  const adapter = new ScriptedEngineAdapter({
    turns: [
      {
        events: [
          { type: 'tool-output', text: 'TOOL_OUTPUT_MUST_NOT_LEAK' },
          { type: 'message', text: options.body ?? 'Scout: replied.', final: true },
        ],
        result: { status: 'completed', text: options.body ?? 'Scout: replied.' },
      },
    ],
  });
  const registry = new AgentRegistry([
    {
      id: 'agent-scout',
      name: 'Scout',
      engine: 'scripted',
      capability: 'agent-run',
      workingDirectory: '/tmp',
    },
  ]);
  const store = new InMemoryRunStore();
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: registry,
    projects,
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store,
    leaseTtlMs: 60_000,
  });
  const collaboration = new CollaborationCoordinator({
    projects,
    store: new InMemoryCollaborationStore(),
    runs: orchestrator,
  });
  const api = createRunApi({
    orchestrator,
    agents: registry,
    collaboration,
    projects,
    ...(auth !== undefined ? { auth } : {}),
  });
  return { api, orchestrator, collaboration };
}


export function buildObservableCollaboration(options: { settleAfterMs?: number } = {}) {
  const adapter = new ScriptedEngineAdapter({
    turns: [
      {
        events: [{ type: 'message', text: 'Scout: replied.', final: true }],
        result: { status: 'completed', text: 'Scout: replied.' },
        ...(options.settleAfterMs !== undefined ? { settleAfterMs: options.settleAfterMs } : {}),
      },
    ],
  });
  const registry = new AgentRegistry([
    { id: 'agent-scout', name: 'Scout', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
    { id: 'agent-ranger', name: 'Ranger', engine: 'scripted', capability: 'agent-run', workingDirectory: '/tmp' },
  ]);
  const twoMemberProjects = new ProjectRegistry([
    {
      id: 'project-sprout',
      goal: 'Ship Sprout',
      rules: [],
      availableEnvironmentInstanceIds: ['mac-mini-1'],
      memberships: [
        { agentId: 'agent-scout', responsibilities: ['Investigate'], collaborationInstructions: '' },
        { agentId: 'agent-ranger', responsibilities: ['Review'], collaborationInstructions: '' },
      ],
    },
  ]);
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', adapter]]),
    agents: registry,
    projects: twoMemberProjects,
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store: new InMemoryRunStore(),
    leaseTtlMs: 60_000,
  });
  const collaboration = new CollaborationCoordinator({
    projects: twoMemberProjects,
    store: new InMemoryCollaborationStore(),
    runs: orchestrator,
  });
  const api = createRunApi({ orchestrator, agents: registry, collaboration, projects: twoMemberProjects });
  return { api, orchestrator };
}
