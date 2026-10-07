import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';

// Real ChatView and the production Vite/Tailwind configuration, with only the
// service boundary replaced. No backend or human preview is contacted.
const fixture = `<!doctype html><div id="app"></div><script type="module">
import '/src/tokens/theme.css';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import ChatView from '/src/modules/chat/views/ChatView.vue';
import { CHAT_SERVICE } from '/src/modules/chat/types.ts';
import { PROJECT_SERVICE } from '/src/modules/projects/types.ts';
import { SHELL_CONNECTION_SOURCE } from '/src/shell/use-shell-connection.ts';
const scope = { id: 'channel', projectId: 'project', kind: 'project', createdAt: 1, updatedAt: 1 };
let rows; let pageSize; let olderRequests = 0; let release;
const service = {
  state: () => ({ status: 'online', connection: 'online', loading: false }), subscribeState: () => () => {},
  listScopes: async () => [scope],
  listMessages: async (_id, options) => {
    if (!rows) {
      pageSize = options.limit;
      rows = Array.from({length: pageSize * 3 + 5}, (_, i) => ({ id: 'message-' + String(i + 1).padStart(4, '0'), scopeId: 'channel', projectId: 'project', channel: 'channel', recipients: [], authorId: 'agent', authorKind: 'agent', body: 'Message ' + (i + 1), createdAt: i + 1 }));
    }
    let end = rows.length;
    if (options.before) {
      olderRequests++;
      end = rows.findIndex(row => row.id === options.before);
      if (window.holdOlder) await new Promise(resolve => { release = resolve; });
    }
    return rows.slice(Math.max(0, end - options.limit), end);
  },
  listProjectEvents: async () => ({ events: [], hasOlder: false }), listRoutingBatches: async () => ({ batches: [], windows: [] }), listActiveRuns: async () => [],
  inspectScope: async () => ({ scope, state: { scopeId: scope.id, writable: true }, context: { scopeId: scope.id, projectId: 'project', kind: 'project', project: { contentVersion: 1, goal: '', rules: [] } } }),
  subscribeRunStatuses: () => () => {},
};
const router = createRouter({ history: createMemoryHistory(), routes: [{ name: 'project-chat-scope', path: '/chat/:scopeId', component: ChatView }] });
await router.push('/chat/channel?project=project'); await router.isReady();
const app = createApp(ChatView); app.use(createPinia()); app.use(router);
app.provide(CHAT_SERVICE, service);
app.provide(PROJECT_SERVICE, { listProjects: async () => [{ id: 'project', displayName: 'Project', status: 'active', content: { currentVersion: 1, versions: [{ version: 1, memberships: [], goal: '', rules: [] }] } }] });
app.provide(SHELL_CONNECTION_SOURCE, service); app.mount('#app');
window.snapshot = () => ({ pageSize, olderRequests, count: document.querySelectorAll('.chat-msg').length });
window.releaseOlder = () => { release?.(); };
window.chatReady = true;
</script>`;

class CdpClient {
  nextId = 0;
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  readonly socket: WebSocket;
  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', event => {
      const response = JSON.parse(String(event.data));
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error.message));
      else pending.resolve(response.result);
    });
  }
  async call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression: string): Promise<any> {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(result.exceptionDetails, undefined, 'browser evaluation succeeds');
    return result.result.value;
  }
}
const base = Number(process.env.PORT ?? process.env.DEV_PIPELINE_PORT_BASE ?? 42960);
const browserBinary = process.env.SPROUT_HEADLESS_BROWSER ?? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const browserSkip = existsSync(browserBinary)
  ? false
  : 'Chromium is not installed; run `npx playwright install chromium` and set SPROUT_HEADLESS_BROWSER to its executable path to enable browser checks';
let vite: ViteDevServer;
let browser: ChildProcess;
let profile: string;
let client: CdpClient;
async function until<T>(probe: () => Promise<T>, label: string): Promise<T> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { const result = await probe(); if (result) return result; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
before(async () => {
  if (browserSkip) return;
  vite = await createServer({
    server: { host: '127.0.0.1', port: base, strictPort: true, proxy: {}, hmr: false, ws: false },
    plugins: [{ name: 'chat-motion-fixture', configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/__chat-paging') return next();
        res.setHeader('Content-Type', 'text/html');
        res.end(await server.transformIndexHtml('/__chat-paging', fixture));
      });
    } }],
    logLevel: 'error',
  });
  await vite.listen();
  const endpoint = `http://127.0.0.1:${base}`;
  profile = await mkdtemp(join(tmpdir(), 'sprout-chat-paging-'));
  browser = spawn(browserBinary, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${base + 1}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', timeout: 120000 });
  const pages = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${base + 1}/json/list`);
    return await response.json() as { webSocketDebuggerUrl: string; type: string }[];
  }, 'Chromium');
  const socket = new WebSocket(pages.find(page => page.type === 'page')!.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true }); });
  client = new CdpClient(socket);
  await client.call('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true });
  await client.call('Page.navigate', { url: `${endpoint}/__chat-paging` });
  await until(() => client.evaluate('Boolean(window.chatReady && document.querySelector(".chat-composer"))'), 'real ChatView');
});
after(async () => {
  client?.socket.close();
  if (browser && browser.exitCode === null && browser.signalCode === null) {
    await new Promise<void>(resolve => { browser.once('exit', () => resolve()); browser.kill('SIGKILL'); });
  }
  await vite?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});


async function settleLayout() {
  await client.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
}
test('automatic positioning in Chromium: near-top bottom following and growth issue zero older requests', { skip: browserSkip }, async () => {
  await until(() => client.evaluate('Boolean(document.querySelectorAll(".chat-msg").length)'), 'messages');
  await settleLayout();
  for (const gap of [20, 40, 150, 0, -20]) {
    await client.evaluate(
      '(() => { const el = document.querySelector(".chat-messages-body"); el.style.flex = "none"; el.style.height = (el.scrollHeight - ' + gap + ') + "px"; })()'
    );
    await settleLayout();
    for (let cycle = 0; cycle < 3; cycle++) {
      await client.evaluate('(() => { const el = document.querySelector(".chat-messages-body"); const body = el.firstElementChild; const growth = document.createElement("div"); growth.id="growth"; growth.style.height="27px"; body.append(growth); document.dispatchEvent(new Event("visibilitychange")); })()');
      await settleLayout();
      await client.evaluate('document.getElementById("growth").remove()'); await settleLayout();
      const snapshot = await client.evaluate('window.snapshot()');
      assert.equal(snapshot.olderRequests, 0, 'no input: gap ' + gap);
      assert.equal(snapshot.count, snapshot.pageSize);
    }
  }
});
test('Chromium user wheel pages with loading status and preserves the visible anchor', { skip: browserSkip }, async () => {
  await client.evaluate('(() => { document.querySelector(".chat-messages-body").style.height="200px"; window.holdOlder=true; })()');
  await settleLayout();
  await client.evaluate('(() => { const viewport = document.querySelector(".chat-messages-body"); window.pagingAnchor = null; viewport.addEventListener("scroll", () => { if (window.pagingAnchor || viewport.scrollTop > 40) return; const row = [...viewport.querySelectorAll("[data-message-id], [data-event-id]")].find(item => item.getBoundingClientRect().bottom > viewport.getBoundingClientRect().top); if (row) window.pagingAnchor = { id: row.dataset.messageId || row.dataset.eventId, top: row.getBoundingClientRect().top, scrollTop: viewport.scrollTop }; }, true); })()');
  const rect = await client.evaluate('(() => { const r = document.querySelector(".chat-messages-body").getBoundingClientRect(); return {x:r.x+100,y:r.y+100}; })()');
  await client.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY: -100000 });
  await until(() => client.evaluate('document.querySelector(".chat-messages-body").textContent.includes("Loading older chat rows")'), 'loading older status');
  const anchor = await client.evaluate('window.pagingAnchor');
  assert.ok(anchor, 'scroll capture records the viewport anchor before the paging handler runs');
  const loading = await client.evaluate('(() => { const status = document.querySelector(".chat-older-loading"); const rect = status.getBoundingClientRect(); return { height: rect.height, top: rect.top, scrollTop: document.querySelector(".chat-messages-body").scrollTop }; })()');
  await client.evaluate('window.releaseOlder()');
  await until(() => client.evaluate('window.snapshot().count === window.snapshot().pageSize * 2'), 'older rows');
  await settleLayout();
  const after = await client.evaluate(`(() => { const viewport = document.querySelector(".chat-messages-body"); const row = [...viewport.querySelectorAll("[data-message-id], [data-event-id]")].find(item => item.dataset.messageId === "${anchor.id}" || item.dataset.eventId === "${anchor.id}"); return { top: row?.getBoundingClientRect().top, scrollTop: viewport.scrollTop, loading: Boolean(document.querySelector(".chat-older-loading")) }; })()`);
  assert.ok(Math.abs(after.top - anchor.top) <= 1, `visible row remains anchored (${anchor.id}): ${anchor.top} -> ${after.top}; scrollTop ${anchor.scrollTop} -> ${after.scrollTop}; loading height ${loading.height}; status remains ${after.loading}`);
  assert.equal((await client.evaluate('window.snapshot()')).olderRequests, 1, 'anchor restoration does not cascade');
});
