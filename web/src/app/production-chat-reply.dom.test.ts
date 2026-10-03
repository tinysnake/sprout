/**
 * Production reply-path evidence for #184.
 *
 * Unlike the fixture suites, this file composes the real page against a real
 * Sprout API process: the durable Project authority, conversation scopes, one
 * wake contract, a run over the scripted engine adapter, the operator session,
 * and the production HTTP/SSE transport. The page therefore observes a reply
 * exactly as it does in the product — engine turn → projected reply Message →
 * `GET /api/messages` refreshed by the page's own run follow-up — and the
 * assertions below prove attribution, `inReplyTo` linkage, the story-65
 * projected-evidence affordance, the announcement, the no-reply-yet state, and
 * that a failed or empty run never renders a phantom reply.
 *
 * What each mechanism proves is stated per test; nothing here writes a Message
 * into the page or into the store.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { type ViteDevServer, createServer as createViteServer } from 'vite';

import { buildReplyProjectionApi } from '../../../src/web/api-harness.ts';
import type { ReplyProjectionApi } from '../../../src/web/api-harness.ts';
import {
  REPLY_PROJECTION_AGENT_ID,
  REPLY_PROJECTION_AGENT_NAME,
  REPLY_PROJECTION_PROJECT_ID,
} from '../../../src/web/api-harness.ts';
import { createAgentDirectMessageSender } from '../../../src/collaboration/agent-direct.ts';
import type { ScriptedTurn } from '../../../src/engine/scripted.ts';

const repoRoot = process.cwd();
const html = await readFile(`${repoRoot}/web/app/index.html`, 'utf8');
const PROJECT_ID = REPLY_PROJECTION_PROJECT_ID;
const AGENT_ID = REPLY_PROJECTION_AGENT_ID;
const AGENT_NAME = REPLY_PROJECTION_AGENT_NAME;

const GLOBALS = [
  'HTMLElement', 'HTMLButtonElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLSelectElement',
  'HTMLTextAreaElement', 'SVGElement', 'Element', 'Document', 'DocumentFragment', 'location',
  'history', 'localStorage', 'navigator', 'getComputedStyle', 'Node', 'NodeFilter', 'Event',
  'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'FocusEvent', 'TouchEvent', 'CustomEvent',
] as const;

interface Harness {
  dom: JSDOM;
  doc: Document;
  mount: HTMLElement;
  vite: ViteDevServer;
  cleanup: () => Promise<void>;
}

async function setupHarness(): Promise<Harness> {
  const dom = new JSDOM(html, { url: 'http://sprout-operator.test/app/feed', pretendToBeVisual: true });
  (dom.window as unknown as Record<string, unknown>)['__SPROUT_TEST_MANUAL_MOUNT__'] = true;

  const values: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 10),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  };
  for (const key of GLOBALS) values[key] = (dom.window as unknown as Record<string, unknown>)[key];

  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const { default: vuePlugin } = await import('@vitejs/plugin-vue');
  const vite = await createViteServer({
    root: `${repoRoot}/web`,
    appType: 'custom',
    logLevel: 'error',
    plugins: [
      { name: 'force-client-vue', enforce: 'pre', transform(_code, _id, opt) { if (opt) opt.ssr = false; } },
      vuePlugin(),
    ],
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
  });

  return {
    dom,
    doc: dom.window.document,
    mount: dom.window.document.getElementById('app') as unknown as HTMLElement,
    vite,
    cleanup: async () => {
      await vite.close();
      for (const [key, original] of originals) {
        if (original === undefined) Reflect.deleteProperty(globalThis, key);
        else Object.defineProperty(globalThis, key, original);
      }
      dom.window.close();
    },
  };
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

type Probe<T> = T | undefined | null | false | Promise<T | undefined | null | false>;

async function waitFor<T>(label: string, probe: () => Probe<T>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() > deadline) assert.fail(`${label} was not observed within ${timeoutMs}ms`);
    await settle(40);
  }
}

interface SseObservation {
  runEvents: number;
  runStatuses: string[];
  firstRunEventAt?: number;
}

interface PageOptions {
  readonly beforeMount?: (server: ReplyProjectionApi) => Promise<void>;
  readonly suppressRunEvents?: boolean;
}

interface Page {
  doc: Document;
  dom: JSDOM;
  server: ReplyProjectionApi;
  sse: SseObservation;
  push(path: string): Promise<void>;
  setVisibilityState(state: 'hidden' | 'visible'): void;
  holdPath(path: string): {
    requestCount(): number;
    waitForRequests(count: number): Promise<void>;
    release(): void;
  };
  close(): Promise<void>;
}

/**
 * Boot one production page against one real API process.
 *
 * `fetch` and `EventSource` are the only injected seams: both speak the real
 * HTTP/SSE routes of the running API (Node has no browser cookie jar, so the
 * wrapper attaches the cookie the production sign-in captured).
 */
async function startPage(turns: readonly ScriptedTurn[], options: PageOptions = {}): Promise<Page> {
  const server = await buildReplyProjectionApi({ turns });
  await options.beforeMount?.(server);
  const harness = await setupHarness();
  const sse: SseObservation = { runEvents: 0, runStatuses: [] };
  const requestGates = new Map<string, {
    readonly wait: Promise<void>;
    started(): void;
  }>();
  let cookie = '';

  const sessionFetch: typeof fetch = async (input, init) => {
    const target = typeof input === 'string' && input.startsWith('http') ? input : `${server.base}${String(input)}`;
    const targetUrl = new URL(target);
    const gate = requestGates.get(targetUrl.pathname);
    if ((init?.method ?? 'GET') === 'GET' && gate !== undefined) {
      gate.started();
      await gate.wait;
    }
    const headers = new Headers(init?.headers);
    if (cookie !== '') headers.set('cookie', cookie);
    const response = await globalThis.fetch(target, { ...init, headers });
    const setCookie = response.headers.getSetCookie();
    if (setCookie.length > 0) {
      const pair = setCookie[0]!.split(';', 1)[0]!;
      if (pair !== '') cookie = pair;
    }
    return response;
  };

  const makeEventSource = (path: string) => {
    const controller = new AbortController();
    const listeners = new Map<string, ((event: { data: string; lastEventId: string }) => void)[]>();
    const source = {
      onopen: null as ((event: Event) => void) | null,
      onmessage: null as ((event: MessageEvent<string>) => void) | null,
      onerror: null as ((event: Event) => void) | null,
      addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
        const queue = listeners.get(type) ?? [];
        queue.push(listener as (event: { data: string; lastEventId: string }) => void);
        listeners.set(type, queue);
      },
      close() { controller.abort(); },
    };
    void (async () => {
      try {
        const response = await sessionFetch(`${server.base}${path}`, {
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!response.ok || response.body === null) throw new Error('event stream unavailable');
        source.onopen?.({} as Event);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            let eventName = 'message';
            let data = '';
            let lastEventId = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) eventName = line.slice(7).trim();
              else if (line.startsWith('data: ')) data = line.slice(6);
              else if (line.startsWith('id: ')) lastEventId = line.slice(4);
            }
            if (eventName === 'run') {
              sse.runEvents += 1;
              sse.firstRunEventAt ??= Date.now();
              const status = (JSON.parse(data) as { readonly status?: unknown }).status;
              if (typeof status === 'string') sse.runStatuses.push(status);
              if (!options.suppressRunEvents) {
                for (const listener of listeners.get('run') ?? []) listener({ data, lastEventId });
              }
            } else if (eventName === 'message') {
              source.onmessage?.({ data, lastEventId } as MessageEvent<string>);
            }
            boundary = buffer.indexOf('\n\n');
          }
        }
      } catch {
        if (!controller.signal.aborted) source.onerror?.({} as Event);
      }
    })();
    return source;
  };

  try {
    const transportModule = await harness.vite.ssrLoadModule('/src/transport/browser-transport.ts') as typeof import('../transport/browser-transport.ts');
    const sessionModule = await harness.vite.ssrLoadModule('/src/adapters/operator-session-api.ts') as typeof import('../adapters/operator-session-api.ts');
    const environmentAdapter = await harness.vite.ssrLoadModule('/src/adapters/environment-api.ts') as typeof import('../adapters/environment-api.ts');
    const environmentProduction = await harness.vite.ssrLoadModule('/src/modules/environments/adapters/production-adapter.ts') as typeof import('../modules/environments/adapters/production-adapter.ts');
    const agentAdapter = await harness.vite.ssrLoadModule('/src/adapters/agent-api.ts') as typeof import('../adapters/agent-api.ts');
    const agentProduction = await harness.vite.ssrLoadModule('/src/modules/agents/adapters/production-adapter.ts') as typeof import('../modules/agents/adapters/production-adapter.ts');
    const projectAdapter = await harness.vite.ssrLoadModule('/src/adapters/project-api.ts') as typeof import('../adapters/project-api.ts');
    const projectProduction = await harness.vite.ssrLoadModule('/src/modules/projects/adapters/production-adapter.ts') as typeof import('../modules/projects/adapters/production-adapter');
    const chatProduction = await harness.vite.ssrLoadModule('/src/modules/chat/adapters/production-adapter.ts') as typeof import('../modules/chat/adapters/production-adapter');
    const conversationAdapter = await harness.vite.ssrLoadModule('/src/adapters/conversation-api.ts') as typeof import('../adapters/conversation-api.ts');
    const messageAdapter = await harness.vite.ssrLoadModule('/src/adapters/message-api.ts') as typeof import('../adapters/message-api.ts');
    const routingAdapter = await harness.vite.ssrLoadModule('/src/adapters/routing-api.ts') as typeof import('../adapters/routing-api.ts');
    const runAdapter = await harness.vite.ssrLoadModule('/src/adapters/run-api.ts') as typeof import('../adapters/run-api.ts');
    const mainModule = await harness.vite.ssrLoadModule('/src/app/main.ts') as typeof import('../app/main.ts');

    // The production bootstrap's composition, over the real API process.
    const transport = transportModule.createBrowserTransport({
      fetch: sessionFetch,
      eventSource: makeEventSource,
    });
    const operatorSession = sessionModule.createOperatorSessionBrowserAdapter(transport);
    await operatorSession.signIn(server.credential);
    const environmentService = new environmentProduction.ProductionEnvironmentService(
      environmentAdapter.createEnvironmentEnrollmentBrowserAdapter(transport),
    );
    const agentService = new agentProduction.ProductionAgentService(
      agentAdapter.createAgentBrowserAdapter(transport),
      () => transport.request<{ readonly runs: readonly unknown[] }>('/api/runs')
        .then((body) => body.runs as never),
    );
    const projectService = new projectProduction.ProductionProjectService({
      projects: projectAdapter.createProjectBrowserAdapter(transport),
      access: projectAdapter.createProjectAccessBrowserAdapter(transport),
      agents: agentService,
      environments: environmentService,
    });
    const chatService = new chatProduction.ProductionChatService({
      conversations: conversationAdapter.createConversationBrowserAdapter(transport),
      messages: messageAdapter.createMessageBrowserAdapter(transport),
      routing: routingAdapter.createRoutingBrowserAdapter(transport),
      runs: runAdapter.createRunBrowserAdapter(transport),
    });

    const { app, router } = mainModule.createSproutApp({
      routerBase: '/app/',
      environmentService,
      agentService,
      projectService,
      chatService,
      connectionSource: transport,
      operatorSession,
    });
    await router.push(`/project/chat?project=${PROJECT_ID}`);
    await router.isReady();
    app.mount(harness.mount);
    await settle(300);

    return {
      doc: harness.doc,
      dom: harness.dom,
      server,
      sse,
      async push(path) {
        await router.push(path);
        await settle(200);
      },
      setVisibilityState(state) {
        Object.defineProperty(harness.doc, 'visibilityState', { configurable: true, value: state });
        harness.doc.dispatchEvent(new harness.dom.window.Event('visibilitychange'));
      },
      holdPath(path) {
        let releaseGate!: () => void;
        const wait = new Promise<void>((resolve) => { releaseGate = resolve; });
        let started = 0;
        const waiters = new Set<{ readonly count: number; readonly resolve: () => void }>();
        requestGates.set(path, {
          wait,
          started() {
            started += 1;
            for (const waiter of waiters) {
              if (started >= waiter.count) {
                waiters.delete(waiter);
                waiter.resolve();
              }
            }
          },
        });
        return {
          requestCount: () => started,
          waitForRequests(count) {
            if (started >= count) return Promise.resolve();
            return new Promise<void>((resolve) => waiters.add({ count, resolve }));
          },
          release() {
            requestGates.delete(path);
            releaseGate();
          },
        };
      },
      async close() {
        app.unmount();
        await harness.cleanup();
        await server.api.close();
      },
    };
  } catch (error) {
    await harness.cleanup();
    await server.api.close();
    throw error;
  }
}

/** Wait until the composer admits text input for the active scope. */
async function waitForEnabledComposer(page: Page): Promise<HTMLInputElement> {
  try {
    return await waitFor('an enabled composer', () => {
      const input = page.doc.querySelector('.chat-composer input') as HTMLInputElement | null;
      return input && input.disabled === false ? input : null;
    });
  } catch {
    // Failure diagnostics: the rendered surface, no server data.
    const snapshot = (page.doc.body.textContent ?? '').replace(/\s+/g, ' ').slice(0, 400);
    const reason = page.doc.querySelector('#chat-send-reason')?.textContent ?? '(none)';
    const alert = page.doc.querySelector('[role="alert"]')?.textContent ?? '(none)';
    const banner = page.doc.querySelector('.chat-readonly-banner')?.textContent ?? '(none)';
    const input = page.doc.querySelector('.chat-composer input') as HTMLInputElement | null;
    const button = page.doc.querySelector('.chat-composer button') as HTMLButtonElement | null;
    assert.fail(
      `composer not ready; inputDisabled=${input?.disabled} buttonDisabled=${button?.disabled} ` +
      `reason=${reason} alert=${alert} banner=${banner} rendered: ${snapshot}`,
    );
  }
}

/** Type into the real composer and click Send, the way an operator does. */
async function sendInComposer(page: Page, body: string): Promise<void> {
  const input = page.doc.querySelector('.chat-composer input') as HTMLInputElement | null;
  assert.ok(input, 'the composer exists');
  input.value = body;
  input.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }));
  const button = await waitFor('Send to enable once the draft exists', () => {
    const candidate = page.doc.querySelector('.chat-composer button') as HTMLButtonElement | null;
    return candidate && candidate.disabled === false ? candidate : null;
  });
  button.click();
}

function messageElement(page: Page, bodyFragment: string): HTMLElement | null {
  return [...page.doc.querySelectorAll<HTMLElement>('[data-message-id]')]
    .find((element) => (element.textContent ?? '').includes(bodyFragment)) ?? null;
}

function authorOf(element: HTMLElement): string {
  return element.querySelector('strong')?.textContent?.trim() ?? '';
}

/** Open the story-65 evidence affordance of one message and wait for its popup. */
async function openEvidence(page: Page, element: HTMLElement): Promise<HTMLElement> {
  const trigger = element.querySelector('.chat-evidence-trigger') as HTMLButtonElement | null;
  assert.ok(trigger, 'the evidence trigger exists on the message');
  trigger.click();
  return await waitFor('the evidence popup', () => page.doc.querySelector('.chat-evidence-popup'));
}

/** Record every value the one shell live region receives, in order. */
function recordAnnouncements(page: Page): { readonly values: readonly string[] } {
  const values: string[] = [];
  const region = page.doc.querySelector('.shell-announcer');
  assert.ok(region, 'the shell live region exists');
  const observer = new page.dom.window.MutationObserver(() => values.push(region.textContent ?? ''));
  observer.observe(region, { childList: true, characterData: true, subtree: true });
  return { values };
}

test('a live engine reply renders in the Project channel through the run follow-up, with attribution, inReplyTo linkage, projected evidence, and an announcement', async () => {
  const page = await startPage([
    {
      events: [{ type: 'message', text: 'The reply path is live.', final: true }],
      result: { status: 'completed', text: 'The reply path is live.' },
      // Keeps the run open long enough to observe the no-reply-yet timeline.
      settleAfterMs: 1_800,
    },
  ]);
  try {
    await waitForEnabledComposer(page);
    const announcements = recordAnnouncements(page);

    const sentAt = Date.now();
    await sendInComposer(page, `@${AGENT_ID} summarize the reply path.`);
    const input = await waitFor('the human input in the timeline', () => messageElement(page, 'summarize the reply path'));
    assert.equal(authorOf(input), 'Human Operator', 'the human message is attributed to the Human Operator');

    // sendMessage announces only after its awaited refreshMessages returns.
    // This is a barrier against the send-triggered refresh being the source of
    // the reply: at that point the server run is still open and no reply exists.
    await waitFor('the send refresh to finish', () =>
      announcements.values.some((value) => value.includes('Message sent to')));
    const openRuns = await globalThis.fetch(`${page.server.base}/api/runs`, { headers: { cookie: page.server.cookie } });
    const openBody = await openRuns.json() as { readonly runs: readonly { readonly status: string }[] };
    assert.ok(openBody.runs.some((run) => run.status === 'running'), 'run remains open after the send refresh barrier');
    // No-reply-yet: the engine turn is still open, so the timeline shows the
    // input and no agent-authored message.
    assert.equal(
      messageElement(page, 'The reply path is live.'),
      null,
      'no reply renders while the run is still open',
    );

    // The reply can only arrive through the page's own live machinery: the
    // send-triggered refresh finished while the run was still open, and the first
    // scoped 15s poll is many seconds away.
    const reply = await waitFor('the rendered reply', () => messageElement(page, 'The reply path is live.'));
    const arrivalMs = Date.now() - sentAt;
    assert.ok(arrivalMs < 6_000, `the reply arrived through the run follow-up (${arrivalMs}ms), not the 15s poll`);
    assert.ok(page.sse.runEvents > 0, 'the run follow-up carried run events over the real SSE route');
    assert.equal(reply.querySelector('[data-author-kind="agent"]')?.textContent, 'Agent');
    assert.equal(authorOf(reply), `@${AGENT_NAME}`, 'the reply is attributed to the Agent, by display name');
    await settle(80);
    assert.ok(
      announcements.values.some((value) => /new message/.test(value)),
      `the arrival is announced in the live region (saw: ${JSON.stringify(announcements.values.slice(-5))})`,
    );

    const replyId = reply.getAttribute('data-message-id');
    assert.ok(replyId?.startsWith('reply-'), 'the rendered message is the durable projected reply');
    const humanId = input.getAttribute('data-message-id');
    assert.ok(humanId, 'the human input carries its durable id');

    // Story-65 evidence for the reply: projected, non-routing, and linked back
    // to the input and its run.
    const popup = await openEvidence(page, reply);
    await waitFor('the projected evidence state', () => popup.getAttribute('data-evidence-state') === 'projected' ? true : null);
    assert.match(popup.textContent ?? '', /Projected Reply · Non-Routing/);
    await waitFor('the provenance chain', () => (popup.textContent ?? '').includes('Triggered by:') ? true : null);
    assert.match(popup.textContent ?? '', new RegExp(`Triggered by:\\s*${humanId}`), 'the inReplyTo linkage renders as the triggering input');
    assert.match(popup.textContent ?? '', /Run:\s*\S+\s*·\s*completed/, 'the story-65 chain names the run that produced the reply');
  } finally {
    await page.close();
  }
});

test('a 9-second Chat run appears promptly after admission while message refresh is already in flight', async () => {
  const page = await startPage([
    {
      events: [{ type: 'notice', text: 'PRIVATE_ENGINE_PROGRESS' }],
      result: { status: 'completed', text: 'short run' },
      settleAfterMs: 9_000,
    },
  ], { suppressRunEvents: true });
  let messagesGate: ReturnType<Page['holdPath']> | undefined;
  try {
    await page.push(`/project/chat/${page.server.directScopeId}?project=${PROJECT_ID}`);
    await waitForEnabledComposer(page);

    // Hold the background catch-up inside refreshMessages. When the send's own
    // refresh reaches the same in-flight guard, only a refresh tied directly to
    // postMessage admission can observe the new run before the 15s poll.
    messagesGate = page.holdPath('/api/messages');
    page.setVisibilityState('visible');
    await messagesGate.waitForRequests(1);

    const sentAt = Date.now();
    await sendInComposer(page, 'Start a nine second run while refresh is busy.');
    await waitFor('the admitted Chat run', async () =>
      (await page.server.collaboration.activeChatRunsForScope(page.server.directScopeId)).length ? true : null);
    const status = await waitFor('the working strip after admission', () => {
      const row = page.doc.querySelector('.chat-working-state');
      return row && row.textContent?.includes(AGENT_NAME) ? row : null;
    }, 2_500);

    assert.ok(Date.now() - sentAt < 2_500, 'the strip renders well before the run settles');
    assert.match(status.textContent ?? '', new RegExp(`@${AGENT_NAME} is working`));
    assert.ok(page.doc.querySelector('.chat-stop-run'), 'Stop is available for the active short run');
    assert.equal((page.doc.querySelector('.chat-composer input') as HTMLInputElement).disabled, false,
      'the Human can keep drafting while the active run blocks submission');
    assert.equal((page.doc.querySelector('.chat-composer button') as HTMLButtonElement).disabled, true,
      'Send remains disabled while the admitted run is active');
    assert.equal(page.sse.runEvents > 0, true, 'the server emitted a run event even though this test drops its delivery');
  } finally {
    messagesGate?.release();
    await page.close();
  }
});

test('a newly running Chat run on SSE triggers an active-run refresh independently of message refresh', async () => {
  const page = await startPage([
    {
      events: [{ type: 'notice', text: 'PRIVATE_ENGINE_PROGRESS' }],
      result: { status: 'completed', text: 'SSE run' },
      settleAfterMs: 9_000,
    },
  ]);
  let messagesGate: ReturnType<Page['holdPath']> | undefined;
  let activeRunsGate: ReturnType<Page['holdPath']> | undefined;
  try {
    await page.push(`/project/chat/${page.server.directScopeId}?project=${PROJECT_ID}`);
    await waitForEnabledComposer(page);
    messagesGate = page.holdPath('/api/messages');
    page.setVisibilityState('visible');
    await messagesGate.waitForRequests(1);

    const activeRunsPath = `/api/chat/scopes/${encodeURIComponent(page.server.directScopeId)}/active-runs`;
    activeRunsGate = page.holdPath(activeRunsPath);
    await sendInComposer(page, 'Check the new run SSE refresh.');
    await waitFor('the admitted run event', () => page.sse.runStatuses.includes('running') ? true : null);
    await waitFor('the admission and SSE active-run reads', () => activeRunsGate && activeRunsGate.requestCount() >= 2 ? true : null, 2_500);
    activeRunsGate.release();
    activeRunsGate = undefined;

    const status = await waitFor('the working strip after the run event', () => page.doc.querySelector('.chat-working-state'));
    assert.match(status.textContent ?? '', new RegExp(`@${AGENT_NAME} is working`));
  } finally {
    messagesGate?.release();
    activeRunsGate?.release();
    await page.close();
  }
});

test('Chat shows the active Agent identity, offers Human Stop, accepts the next message, and refreshes on refocus', async () => {
  const page = await startPage([
    {
      events: [{ type: 'notice', text: 'PRIVATE_ENGINE_PROGRESS' }],
      result: { status: 'completed', text: 'first turn' },
      settleAfterMs: 5_000,
    },
    {
      events: [{ type: 'message', text: 'The next message was admitted.', final: true }],
      result: { status: 'completed', text: 'The next message was admitted.' },
    },
    {
      events: [{ type: 'notice', text: 'PRIVATE_ENGINE_PROGRESS' }],
      result: { status: 'completed', text: 'third turn' },
      settleAfterMs: 5_000,
    },
    {
      events: [{ type: 'notice', text: 'PRIVATE_ENGINE_PROGRESS' }],
      result: { status: 'failed', message: 'private engine failure' },
      settleAfterMs: 1_200,
    },
  ]);
  let messagesGate: ReturnType<Page['holdPath']> | undefined;
  let activeRunsGate: ReturnType<Page['holdPath']> | undefined;
  try {
    await page.push(`/project/chat/${page.server.directScopeId}?project=${PROJECT_ID}`);
    await waitForEnabledComposer(page);
    const idleComposer = page.doc.querySelector('.chat-composer');
    assert.ok(idleComposer);
    assert.equal(page.doc.querySelector('.chat-stop-run'), null, 'Stop is hidden before a run starts');
    assert.equal(page.doc.querySelector('.chat-run-actions'), null, 'no empty action bar changes the idle layout');
    assert.ok(idleComposer.previousElementSibling?.querySelector('.chat-messages-body'),
      'the idle composer follows the message area directly');
    await sendInComposer(page, 'Start a long direct chat run.');

    const status = await waitFor('the Agent working indicator', () => {
      const row = page.doc.querySelector('.chat-working-state');
      return row && row.textContent?.includes(AGENT_NAME) ? row : null;
    });
    assert.match(status.textContent ?? '', new RegExp(`@${AGENT_NAME} is working`));
    assert.ok(page.sse.runStatuses.includes('running'), 'the new Chat run reaches the browser stream as running after its queued record');
    assert.equal(page.sse.runStatuses.includes('queued'), false, 'the initial queued admission is not published as an SSE run transition');
    assert.doesNotMatch(status.textContent ?? '', /PRIVATE_ENGINE_PROGRESS|prompt|model|engine/);
    assert.equal((page.doc.querySelector('.chat-composer input') as HTMLInputElement).disabled, false,
      'the Human can continue drafting while an active run blocks submission');
    assert.equal((page.doc.querySelector('.chat-composer button') as HTMLButtonElement).disabled, true,
      'Send is blocked while the conversation has an active Chat run');
    await page.push('/project/feed');
    await page.push(`/project/chat/${page.server.directScopeId}?project=${PROJECT_ID}`);
    const rehydrated = await waitFor('the active Agent indicator after a fresh Chat mount', () => {
      const row = page.doc.querySelector('.chat-working-state');
      return row && row.textContent?.includes(AGENT_NAME) ? row : null;
    });
    assert.match(rehydrated.textContent ?? '', new RegExp(`@${AGENT_NAME} is working`));
    const stop = page.doc.querySelector('.chat-stop-run') as HTMLButtonElement | null;
    assert.ok(stop, 'Human Stop is available on the active Chat run');
    const composer = page.doc.querySelector('.chat-composer');
    assert.ok(composer);
    const actions = stop.closest('.chat-run-actions');
    assert.ok(actions, 'Stop belongs to the composer action bar');
    assert.equal(actions.parentElement, composer.parentElement, 'the action bar and composer share a container');
    assert.equal(composer.previousElementSibling, actions, 'Stop sits immediately above the composer');
    assert.equal(rehydrated.querySelector('.chat-stop-run'), null, 'Stop is removed from the working strip under the title');
    stop.click();

    await waitFor('the working indicator to clear after settlement', () =>
      page.doc.querySelector('.chat-working-state') === null ? true : null);
    await waitFor('the interruption Project event', () =>
      [...page.doc.querySelectorAll('[data-event-id]')].find((row) => (row.textContent ?? '').includes('Agent run interrupted for')));
    assert.equal(page.doc.querySelector('.chat-working-state'), null, 'the indicator clears after settlement');
    assert.equal(page.doc.querySelector('.chat-stop-run'), null, 'Stop clears when no run remains');
    assert.equal(page.doc.querySelector('.chat-run-actions'), null, 'the action bar leaves no idle layout gap');
    assert.equal(page.doc.querySelector('.chat-composer'), composer, 'settlement preserves the composer');
    assert.ok(composer.previousElementSibling?.querySelector('.chat-messages-body'),
      'the composer returns directly below the message area');
    await sendInComposer(page, 'Send the next message immediately.');
    const reply = await waitFor('the reply to the next message', () => messageElement(page, 'The next message was admitted.'));
    assert.equal(authorOf(reply), `@${AGENT_NAME}`);

    await sendInComposer(page, 'Start work before hiding the Chat tab.');
    await waitFor('the second active Agent indicator', () => page.doc.querySelector('.chat-working-state'));
    await settle(200);
    messagesGate = page.holdPath('/api/messages');
    const activeRunsPath = `/api/chat/scopes/${encodeURIComponent(page.server.directScopeId)}/active-runs`;
    activeRunsGate = page.holdPath(activeRunsPath);
    const run = (await page.server.collaboration.activeChatRunsForScope(page.server.directScopeId))[0];
    assert.ok(run, 'the authoritative active Chat run is linked to this conversation');
    page.setVisibilityState('hidden');
    await page.server.orchestrator.interrupt(run.id);
    await messagesGate.waitForRequests(1);
    await activeRunsGate.waitForRequests(1);
    assert.ok(page.doc.querySelector('.chat-working-state'), 'the in-flight reads keep the previous indicator visible');

    const readsBeforeRefocus = activeRunsGate.requestCount();
    page.setVisibilityState('visible');
    await activeRunsGate.waitForRequests(readsBeforeRefocus + 1);
    activeRunsGate.release();
    await waitFor('the stale working indicator to clear on refocus', () =>
      page.doc.querySelector('.chat-working-state') === null ? true : null);
    messagesGate.release();
    messagesGate = undefined;

    await sendInComposer(page, 'Check that run failure clears the indicator.');
    await waitFor('the working indicator before run failure', () => page.doc.querySelector('.chat-working-state'));
    await waitFor('the working indicator to clear after run failure', () =>
      page.doc.querySelector('.chat-working-state') === null ? true : null);
    await waitFor('the safe run failure event', () =>
      [...page.doc.querySelectorAll('[data-event-id]')].find((row) => (row.textContent ?? '').includes('Agent run failed')));
    assert.doesNotMatch(page.doc.body.textContent ?? '', /private engine failure|PRIVATE_ENGINE_PROGRESS/);
  } finally {
    messagesGate?.release();
    activeRunsGate?.release();
    await page.close();
  }
});

test('Human Chat reads an Agent pair with both names and both authors while send remains refused', async () => {
  let scopeId = '';
  const page = await startPage([{ events: [], result: { status: 'completed', text: 'Scout answers Forge.' } }], { beforeMount: async server => {
    const command = async (path: string, body: unknown) => fetch(`${server.base}${path}`, {
      method: 'POST', headers: { cookie: server.cookie, 'x-sprout-csrf': server.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await command('/api/agents', { id: 'forge', displayName: 'Forge', workOptions: [{ engine: 'scripted', workModel: 'scripted-model', effort: 'standard' }] })).status, 201);
    assert.equal((await command(`/api/projects/${PROJECT_ID}/memberships`, { agentId: 'forge' })).status, 200);
    const send = createAgentDirectMessageSender({ run: { agentId: 'forge', projectId: PROJECT_ID }, runs: server.orchestrator, scopes: server.scopes, collaboration: server.collaboration });
    const delivered = await send({ recipientId: AGENT_ID, body: 'Forge asks Scout.', deliveryKey: 'pair-attribution', awaitReply: true });
    scopeId = delivered.scopeId;
  } });
  try {
    await page.push(`/project/chat/${scopeId}?project=${PROJECT_ID}`);
    const input = await waitFor('Agent-authored direct input', () => messageElement(page, 'Forge asks Scout.'));
    const reply = await waitFor('recipient Agent reply', () => messageElement(page, 'Scout answers Forge.'));
    assert.equal(authorOf(input), '@Forge');
    assert.equal(authorOf(reply), `@${AGENT_NAME}`);
    assert.equal(input.querySelector('[data-author-kind="agent"]')?.textContent, 'Agent');
    assert.equal(reply.querySelector('[data-author-kind="agent"]')?.textContent, 'Agent');
    const scopeButton = page.doc.querySelector(`[data-scope-id="${scopeId}"]`);
    assert.match(scopeButton?.textContent ?? '', /@Forge/);
    assert.match(scopeButton?.textContent ?? '', new RegExp(`@${AGENT_NAME}`));
    assert.equal((page.doc.querySelector('.chat-composer button') as HTMLButtonElement).disabled, true);
  } finally { await page.close(); }
});

test('the reply renders with attribution and projected evidence in the Working group and the direct scope', async () => {
  const page = await startPage([
    {
      events: [{ type: 'message', text: 'Working group reply.', final: true }],
      result: { status: 'completed', text: 'Working group reply.' },
    },
    {
      events: [{ type: 'message', text: 'Direct reply.', final: true }],
      result: { status: 'completed', text: 'Direct reply.' },
    },
  ]);
  try {
    const announcements = recordAnnouncements(page);
    // Working group scope.
    await page.push(`/project/chat/${page.server.workingGroupScopeId}?project=${PROJECT_ID}`);
    await waitForEnabledComposer(page);
    await sendInComposer(page, `@${AGENT_ID} review this working group reply.`);
    const groupInput = await waitFor('the working group input', () => messageElement(page, 'review this working group reply'));
    const groupReply = await waitFor('the working group reply', () => messageElement(page, 'Working group reply.'));
    assert.equal(authorOf(groupReply), `@${AGENT_NAME}`, 'the Working group reply is attributed to the Agent');
    const groupPopup = await openEvidence(page, groupReply);
    await waitFor('the Working group projected evidence', () => groupPopup.getAttribute('data-evidence-state') === 'projected' ? true : null);
    await waitFor('the Working group provenance', () => (groupPopup.textContent ?? '').includes('Triggered by:') ? true : null);
    const groupInputId = groupInput.getAttribute('data-message-id');
    assert.ok(groupInputId, 'the Working group input carries its durable id');
    assert.match(
      groupPopup.textContent ?? '',
      new RegExp(`Triggered by:\\s*${groupInputId}`),
      'the Working group reply links to its input',
    );
    assert.match(groupPopup.textContent ?? '', /Run:\s*\S+\s*·\s*completed/);
    await waitFor('the Working group arrival announcement', () =>
      announcements.values.some((value) => /new message/.test(value)));
    page.doc.dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(50);

    // Direct scope: a deterministic direct wake needs no mention.
    await page.push(`/project/chat/${page.server.directScopeId}?project=${PROJECT_ID}`);
    await waitForEnabledComposer(page);
    const beforeDirect = announcements.values.length;
    await sendInComposer(page, 'Answer me directly on the live path.');
    const directInput = await waitFor('the direct input', () => messageElement(page, 'Answer me directly on the live path'));
    const directReply = await waitFor('the direct reply', () => messageElement(page, 'Direct reply.'));
    assert.equal(directReply.querySelector('[data-author-kind="agent"]')?.textContent, 'Agent');
    assert.equal(authorOf(directReply), `@${AGENT_NAME}`, 'the direct reply is attributed to the Agent');
    const directPopup = await openEvidence(page, directReply);
    await waitFor('the direct projected evidence', () => directPopup.getAttribute('data-evidence-state') === 'projected' ? true : null);
    await waitFor('the direct provenance', () => (directPopup.textContent ?? '').includes('Triggered by:') ? true : null);
    const directInputId = directInput.getAttribute('data-message-id');
    assert.ok(directInputId, 'the direct input carries its durable id');
    assert.match(
      directPopup.textContent ?? '',
      new RegExp(`Triggered by:\\s*${directInputId}`),
      'the direct reply links to its input',
    );
    assert.match(directPopup.textContent ?? '', /Run:\s*\S+\s*·\s*completed/);
    await waitFor('the direct arrival announcement', () =>
      announcements.values.slice(beforeDirect).some((value) => /new message/.test(value)));
  } finally {
    await page.close();
  }
});

for (const scenario of [
  { name: 'safe persisted message', result: { status: 'failed', message: 'the engine refused the saved session' } as const, reason: /the engine refused the saved session/ },
  { name: 'message-less error stop', result: { status: 'failed', message: '', stopReason: 'error' } as const, reason: /stopReason: error/ },
]) {
  test(`origin-chat notice and detail explain ${scenario.name}`, async () => {
    const page = await startPage([{ events: [], result: scenario.result }]);
    try {
      await page.push(`/project/chat/${page.server.directScopeId}?project=${PROJECT_ID}`);
      await waitForEnabledComposer(page);
      await sendInComposer(page, 'Explain this failure.');
      const input = await waitFor('the originating input', () => messageElement(page, 'Explain this failure.'));
      const notice = await waitFor('the originating notice', () => page.doc.querySelector<HTMLElement>('[data-event-id]'));
      assert.match(notice.textContent ?? '', scenario.reason);
      const detail = await openEvidence(page, input);
      await waitFor('failed run detail', () => detail.getAttribute('data-evidence-state') === 'run-failed' ? true : null);
      assert.match(detail.textContent ?? '', scenario.reason);
    } finally { await page.close(); }
  });
}

test('an actionable model failure identifies the configured model in the origin notice and evidence', async () => {
  const page = await startPage([{ events: [], result: { status: 'failed',
    message: 'pi turn failed: the engine rejected the model' } }]);
  try {
    await page.push(`/project/chat/${page.server.directScopeId}?project=${PROJECT_ID}`);
    await waitForEnabledComposer(page);
    await sendInComposer(page, 'Identify this rejected model.');
    const input = await waitFor('the model-failure input', () => messageElement(page, 'Identify this rejected model'));
    const notice = await waitFor('the actionable origin notice', () =>
      [...page.doc.querySelectorAll<HTMLElement>('[data-event-id]')]
        .find((entry) => (entry.textContent ?? '').includes('the engine rejected the model')));
    assert.match(notice.textContent ?? '', /pi turn failed for model scripted-model: the engine rejected the model/);
    const detail = await openEvidence(page, input);
    await waitFor('the model-failure evidence', () => detail.getAttribute('data-evidence-state') === 'run-failed' ? true : null);
    assert.match(detail.textContent ?? '', /pi turn failed for model scripted-model: the engine rejected the model/);
  } finally { await page.close(); }
});

test('a failed run and an empty #182-style completion never render a phantom reply in the timeline', async () => {
  const page = await startPage([
    {
      events: [{ type: 'message', text: 'engine refused', final: true }],
      result: { status: 'failed', message: 'arbitrary engine diagnostic MUST NOT SURFACE' },
    },
    {
      events: [],
      result: { status: 'completed', text: '' },
    },
  ]);
  try {
    await page.push(`/project/chat/${page.server.directScopeId}?project=${PROJECT_ID}`);
    await waitForEnabledComposer(page);

    const settledRuns = async (count: number): Promise<boolean> => {
      const response = await globalThis.fetch(`${page.server.base}/api/runs`, { headers: { cookie: page.server.cookie } });
      const body = await response.json() as { readonly runs: readonly { readonly id: string; readonly status: string }[] };
      return body.runs.length >= count &&
        body.runs.every((run) => run.status !== 'queued' && run.status !== 'running');
    };

    // Outcome 1: the engine turn errors and the run settles failed; the
    // failure must not render as a reply anywhere in the conversation.
    await sendInComposer(page, 'This run fails instead of replying.');
    await waitFor('the failing input', () => messageElement(page, 'This run fails instead of replying'));
    await waitFor('the failed run to settle', () => settledRuns(1));
    // The failure notice must be visible without leaving the originating chat.
    const originNotice = await waitFor('failure notice in the originating direct chat', () =>
      page.doc.querySelector<HTMLElement>('[data-event-id]'));
    assert.match(originNotice.textContent ?? '', /Agent run failed/);
    assert.match(originNotice.textContent ?? '', /code: failed.*diagnostic withheld/);
    // The same event remains the durable Project record.
    await page.push(`/project/chat/${page.server.channelScopeId}?project=${PROJECT_ID}`);
    const failureEntry = await waitFor('the #180 failure entry in the Project timeline', () =>
      [...page.doc.querySelectorAll<HTMLElement>('[data-event-id]')]
        .find((entry) => (entry.textContent ?? '').includes('agent-run-failure')));
    assert.match(failureEntry.textContent ?? '', /agent-run-failure · informational/);
    assert.match(failureEntry.textContent ?? '', /Agent run failed \(execution\)/);
    assert.doesNotMatch(failureEntry.textContent ?? '', /MUST NOT SURFACE|arbitrary engine diagnostic/);
    assert.equal(authorOf(failureEntry), 'Project event', 'the failure is not attributed as an Agent reply');
    assert.equal(page.doc.querySelectorAll('[data-message-id]').length, 0, 'the event is not an Agent Message');
    await page.push(`/project/chat/${page.server.directScopeId}?project=${PROJECT_ID}`);
    const directFailedInput = await waitFor('the original failed direct message', () =>
      messageElement(page, 'This run fails instead of replying'));
    const afterFailure = [...page.doc.querySelectorAll<HTMLElement>('[data-message-id]')];
    assert.equal(afterFailure.length, 1, 'after a failed run the timeline still holds only the human input');
    assert.ok(
      afterFailure.every((element) => authorOf(element) === 'Human Operator'),
      'a failed run renders no agent-authored message',
    );

    // The originating message still exposes its story-65 chain — routed to the
    // wake → run — and never claims a projected reply.
    const failureEvidence = await openEvidence(page, directFailedInput);
    await waitFor('the failure evidence state', () => {
      const state = failureEvidence.getAttribute('data-evidence-state');
      return state && state !== 'loading' ? state : null;
    });
    await waitFor('the reply-less input failure chain', () =>
      failureEvidence.getAttribute('data-evidence-state') === 'run-failed' ? true : null);
    assert.match(failureEvidence.textContent ?? '', /Run:\s*\S+\s*·\s*failed/);
    assert.match(failureEvidence.textContent ?? '', /Run failed\. No reply was produced/);
    assert.match(failureEvidence.textContent ?? '', /code: failed.*diagnostic withheld/);
    assert.doesNotMatch(failureEvidence.textContent ?? '', /MUST NOT SURFACE|arbitrary engine diagnostic/);
    assert.doesNotMatch(failureEvidence.textContent ?? '', /Projected Reply/, 'the two outcomes are never conflated');

    // Outcome 2: the #182 shape — a completed run with empty text. It must
    // render no reply either.
    page.doc.dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(50);
    await waitForEnabledComposer(page);
    await sendInComposer(page, 'This run completes with no text.');
    await waitFor('the empty completion to settle', () => settledRuns(2));
    await settle(700);
    const rendered = [...page.doc.querySelectorAll<HTMLElement>('[data-message-id]')]
      .map((element) => authorOf(element));
    assert.equal(rendered.length, 2, 'exactly the two human inputs render — no reply was fabricated');
    const eventsResponse = await globalThis.fetch(`${page.server.base}/api/projects/${PROJECT_ID}/events`,
      { headers: { cookie: page.server.cookie } });
    const eventBody = await eventsResponse.json() as { readonly events: readonly unknown[] };
    assert.equal(eventBody.events.length, 1, 'empty completion adds no failure entry');
    assert.ok(
      rendered.every((author) => author === 'Human Operator'),
      'an empty completion renders no agent-authored message',
    );
    assert.doesNotMatch(
      page.doc.querySelector('.shell-announcer')?.textContent ?? '',
      /new message/,
      'no reply arrival was announced because none happened',
    );
  } finally {
    await page.close();
  }
});
