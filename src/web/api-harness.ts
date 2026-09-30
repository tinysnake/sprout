import assert from 'node:assert/strict';

import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { ScriptedEngineAdapter } from '../engine/scripted.ts';
import type { ScriptedTurn } from '../engine/scripted.ts';
import { AgentRegistry } from '../agent/registry.ts';
import { AgentService } from '../agent/service.ts';
import { InMemoryAgentStore } from '../agent/store.ts';
import { ProjectRegistry } from '../project/registry.ts';
import { ProjectService } from '../project/authority-service.ts';
import { InMemoryProjectAuthorityStore } from '../project/authority-store.ts';
import { currentProjectContent } from '../project/authority-model.ts';
import { ConversationScopeService } from '../conversation/service.ts';
import type { ConversationProjectPort } from '../conversation/service.ts';
import { InMemoryConversationScopeStore } from '../conversation/store.ts';
import { InMemoryRunStore } from '../run/store.ts';
import { RunOrchestrator } from '../run/orchestrator.ts';
import { CollaborationCoordinator } from '../collaboration/coordinator.ts';
import { InMemoryCollaborationStore } from '../collaboration/store.ts';
import { buildCollaborationScopes } from '../collaboration/scope-harness.ts';
import { createRunApi } from './api.ts';
import type { RunApi } from './api.ts';
import { createProjectRouter } from './project-router.ts';
import { createConversationRouter } from './conversation-router.ts';
import { createAgentRouter } from './agent-router.ts';
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
  keepAliveMs?: number;
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
  const api = createRunApi({ orchestrator, agents: registry, ...(options.keepAliveMs === undefined ? {} : { keepAliveMs: options.keepAliveMs }) });
  return { api, orchestrator, pool };
}

export async function withServer(
  fn: (base: string, context: ReturnType<typeof build>) => Promise<void>,
  options: {
    keepAliveMs?: number;
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


export function buildWithCollaboration(
  options: { body?: string; failing?: boolean; failureMessage?: string } = {},
  auth?: OperatorSessionService,
) {
  const adapter = new ScriptedEngineAdapter({
    turns: options.failing === true
      ? [
          {
            events: [{ type: 'tool-output', text: 'FAILED_RUN_TOOL_OUTPUT_MUST_NOT_LEAK' }],
            result: { status: 'failed', message: options.failureMessage ?? 'engine turn failed' },
          },
        ]
      : [
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
  const scopeHarness = buildCollaborationScopes({ projects });
  const collaboration = new CollaborationCoordinator({
    scopes: scopeHarness.scopes,
    store: new InMemoryCollaborationStore(),
    runs: orchestrator,
  });
  const api = createRunApi({
    orchestrator,
    agents: registry,
    collaboration,
    conversationScopes: scopeHarness.scopes,
    projects,
    ...(auth !== undefined ? { auth } : {}),
  });
  return { api, orchestrator, collaboration, scopes: scopeHarness };
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
  const scopeHarness = buildCollaborationScopes({ projects: twoMemberProjects });
  const collaboration = new CollaborationCoordinator({
    scopes: scopeHarness.scopes,
    store: new InMemoryCollaborationStore(),
    runs: orchestrator,
  });
  const api = createRunApi({
    orchestrator,
    agents: registry,
    collaboration,
    conversationScopes: scopeHarness.scopes,
    projects: twoMemberProjects,
  });
  return { api, orchestrator, collaboration, scopes: scopeHarness };
}

/** Stable identities of the reply-projection composition (server-side facts). */
export const REPLY_PROJECTION_PROJECT_ID = 'project-reply-path';
export const REPLY_PROJECTION_AGENT_ID = 'agent-scout';
export const REPLY_PROJECTION_AGENT_NAME = 'Scout';
export const REPLY_PROJECTION_OPERATOR_ID = 'operator';

export interface ReplyProjectionApi {
  readonly api: RunApi;
  readonly base: string;
  /** The host-supplied operator credential the browser signs in with. */
  readonly credential: string;
  /** The authenticated browser session cookie (test-local, never a real credential). */
  readonly cookie: string;
  readonly csrf: string;
  readonly projectId: string;
  /** The one Project channel scope. */
  readonly channelScopeId: string;
  /** The operator/Agent direct conversation. */
  readonly directScopeId: string;
  /** The Working group channel with the operator and the Agent. */
  readonly workingGroupScopeId: string;
  readonly orchestrator: RunOrchestrator;
  readonly scopes: ConversationScopeService;
  readonly collaboration: CollaborationCoordinator;
  /** One run's durable status, read through the production HTTP route. */
  readRun(runId: string): Promise<{ readonly id: string; readonly status: string }>;
}

/**
 * A production-shaped API composition for reply-rendering evidence (#184).
 *
 * It wires the same Modules the runtime composes — durable Project authority,
 * conversation scopes, the collaboration coordinator's one wake contract, the
 * run orchestrator over a scripted engine, the operator browser session, and
 * the additive Project/conversation/Agent routers — behind the real HTTP/SSE
 * transport, so a page under test observes replies exactly as it would in the
 * product: engine turn → projected reply Message → `GET /api/messages` →
 * `run` events on `/api/events`.
 *
 * The engine is the controlled scripted adapter: this harness proves Sprout's
 * reply path with server-produced run results, never a fabricated Message.
 */
export async function buildReplyProjectionApi(
  options: { readonly turns: readonly ScriptedTurn[] },
): Promise<ReplyProjectionApi> {
  const engine = new ScriptedEngineAdapter({ turns: options.turns });
  const runAgents = new AgentRegistry([
    {
      id: REPLY_PROJECTION_AGENT_ID,
      name: REPLY_PROJECTION_AGENT_NAME,
      engine: 'scripted',
      capability: 'agent-run',
      workingDirectory: '/tmp',
    },
  ]);
  const projectRegistry = new ProjectRegistry([
    {
      id: REPLY_PROJECTION_PROJECT_ID,
      goal: 'Evidence the reply rendering path',
      rules: [],
      availableEnvironmentInstanceIds: [instance.id],
      memberships: [
        {
          agentId: REPLY_PROJECTION_AGENT_ID,
          responsibilities: ['Investigate'],
          collaborationInstructions: '',
        },
      ],
    },
  ]);
  const orchestrator = new RunOrchestrator({
    engines: new Map([['scripted', engine]]),
    agents: runAgents,
    projects: projectRegistry,
    pool: new EnvironmentPool({ definitions: [definition], instances: [instance] }),
    store: new InMemoryRunStore(),
    leaseTtlMs: 60_000,
  });

  const authorityStore = new InMemoryProjectAuthorityStore();
  // The composed Project facts port, mirroring the runtime's projection from
  // the durable authority record (lifecycle, versioned content, membership).
  const conversationProjects: ConversationProjectPort = {
    async projectFacts(projectId) {
      const authority = await authorityStore.get(projectId);
      if (authority === undefined) return undefined;
      const content = currentProjectContent(authority);
      return {
        projectId: authority.id,
        status: authority.status,
        contentVersion: authority.content.currentVersion,
        goal: content.goal,
        rules: [...content.rules],
        wakePolicy: content.wakePolicy,
        routingIntervalMs: content.routingIntervalMs,
        members: content.memberships.map((membership) => ({
          memberId: membership.memberId,
          memberKind: membership.memberKind,
          responsibilities: [...membership.responsibilities],
          collaborationInstructions: membership.collaborationInstructions,
          ...(membership.endedAt !== undefined ? { endedAt: membership.endedAt } : {}),
          ...(membership.endedReason !== undefined ? { endedReason: membership.endedReason } : {}),
        })),
      };
    },
  };
  const scopes = new ConversationScopeService({
    store: new InMemoryConversationScopeStore(),
    projects: conversationProjects,
  });
  const durableAgents = new AgentService({ store: new InMemoryAgentStore() });
  await durableAgents.create({
    id: REPLY_PROJECTION_AGENT_ID,
    displayName: REPLY_PROJECTION_AGENT_NAME,
    workOptions: [{ engine: 'scripted', workModel: 'scripted-model', effort: 'standard' }],
  });
  const projects = new ProjectService({
    store: authorityStore,
    agentAuthority: {
      agentIsActive: async (agentId) => (await durableAgents.get(agentId))?.status === 'active',
    },
    bridge: { prepare: (project) => scopes.prepareProjectChannel(project) },
  });
  const collaboration = new CollaborationCoordinator({
    scopes,
    store: new InMemoryCollaborationStore(),
    runs: orchestrator,
  });
  const auth = new OperatorSessionService({ store: new InMemoryOperatorSessionStore() });
  const credential = privateInput();
  await auth.initializeOrRecover(credential);
  const api = createRunApi({
    orchestrator,
    agents: runAgents,
    collaboration,
    conversationScopes: scopes,
    projects: projectRegistry,
    auth,
    routers: [
      createProjectRouter({ projects }),
      createConversationRouter({ scopes }),
      createAgentRouter({ agents: durableAgents }),
    ],
  });
  const { port } = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;

  const signInResponse = await fetch(`${base}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential }),
  });
  assert.equal(signInResponse.status, 201);
  const cookie = (signInResponse.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
  const { csrfToken } = (await signInResponse.json()) as { csrfToken: string };

  const command = async (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        cookie,
        'x-sprout-csrf': csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  const created = await command('/api/projects', {
    id: REPLY_PROJECTION_PROJECT_ID,
    displayName: 'Reply Path',
    agentMemberships: [
      {
        agentId: REPLY_PROJECTION_AGENT_ID,
        responsibilities: ['Investigate'],
        collaborationInstructions: '',
      },
    ],
  });
  assert.equal(created.status, 201, 'the durable Project (and its one channel) is created over HTTP');

  const channel = await scopes.ensureProjectChannel(REPLY_PROJECTION_PROJECT_ID);
  const direct = await scopes.openDirect({
    projectId: REPLY_PROJECTION_PROJECT_ID,
    participants: [REPLY_PROJECTION_OPERATOR_ID, REPLY_PROJECTION_AGENT_ID],
  });
  const workingGroup = await scopes.createWorkingGroup({
    projectId: REPLY_PROJECTION_PROJECT_ID,
    displayName: 'Reply Review',
    creator: { memberId: REPLY_PROJECTION_OPERATOR_ID, kind: 'human' },
    memberIds: [REPLY_PROJECTION_AGENT_ID],
    goal: 'Review reply evidence',
  });

  return {
    api,
    base,
    credential,
    cookie,
    csrf: csrfToken,
    projectId: REPLY_PROJECTION_PROJECT_ID,
    channelScopeId: channel.id,
    directScopeId: direct.id,
    workingGroupScopeId: workingGroup.id,
    orchestrator,
    scopes,
    collaboration,
    async readRun(runId) {
      const response = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/status`, {
        headers: { cookie },
      });
      assert.equal(response.status, 200, 'the run status route serves the admitted run');
      return await response.json() as { readonly id: string; readonly status: string };
    },
  };
}
