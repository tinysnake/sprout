import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
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
let runs = [];
let listener;
const service = {
  state: () => ({ status: 'online', connection: 'online', loading: false }),
  subscribeState: () => () => {},
  listScopes: async () => [scope], listMessages: async () => [], listProjectEvents: async () => [],
  listRoutingBatches: async () => ({ batches: [], windows: [] }), listActiveRuns: async () => runs,
  inspectScope: async () => ({ scope, state: { scopeId: scope.id, writable: true }, context: { scopeId: scope.id, projectId: 'project', kind: 'project', project: { contentVersion: 1, goal: '', rules: [] } } }),
  subscribeRunStatuses: callback => { listener = callback; return () => { listener = undefined; }; },
};
const router = createRouter({ history: createMemoryHistory(), routes: [{ name: 'project-chat-scope', path: '/chat/:scopeId', component: ChatView }] });
await router.push('/chat/channel?project=project');
await router.isReady();
const app = createApp(ChatView);
app.use(createPinia()); app.use(router);
app.provide(CHAT_SERVICE, service);
app.provide(PROJECT_SERVICE, { listProjects: async () => [{ id: 'project', displayName: 'Project', status: 'active', content: { currentVersion: 1, versions: [{ version: 1, memberships: [], goal: '', rules: [] }] } }] });
app.provide(SHELL_CONNECTION_SOURCE, service);
app.mount('#app');
window.setRunStatus = async status => {
  runs = status === 'completed' ? [] : [{ id: 'chat-run', agentId: 'agent', status }];
  listener?.({ id: 'chat-run', status });
  for (let i = 0; i < 15; i++) { await Promise.resolve(); await nextTick(); }
};
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
  vite = await createServer({
    server: { host: '127.0.0.1', port: base, strictPort: true, proxy: {}, hmr: false, ws: false },
    plugins: [{ name: 'chat-motion-fixture', configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/__chat-motion') return next();
        res.setHeader('Content-Type', 'text/html');
        res.end(await server.transformIndexHtml('/__chat-motion', fixture));
      });
    } }],
    logLevel: 'error',
  });
  await vite.listen();
  const endpoint = `http://127.0.0.1:${base}`;
  const js = await (await fetch(`${endpoint}/src/modules/chat/views/ChatView.vue`)).text();
  const css = await (await fetch(`${endpoint}/src/tokens/theme.css?direct`)).text();
  assert.ok(js.includes('animate-pulse') && js.includes('motion-reduce:animate-none'), 'dev-served ChatView carries motion classes');
  assert.ok(css.includes('@keyframes pulse') && css.includes('prefers-reduced-motion'), 'dev-served CSS contains pulse and reduced-motion rules');
  profile = await mkdtemp(join(tmpdir(), 'sprout-chat-motion-'));
  browser = spawn(process.env.SPROUT_HEADLESS_BROWSER ?? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', [
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
  await client.call('Page.navigate', { url: `${endpoint}/__chat-motion` });
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

for (const motion of ['no-preference', 'reduce']) {
  test(`dev CSS preserves truthful run state with ${motion} motion`, async () => {
    await client.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] });
    await client.evaluate('window.setRunStatus("completed")');
    assert.equal(await client.evaluate('document.querySelector(".chat-run-indicator") !== null'), false);
    for (const status of ['queued', 'running']) {
      await client.evaluate(`window.setRunStatus(${JSON.stringify(status)})`);
      await client.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const snapshot = await client.evaluate(`(() => {
        const indicator = document.querySelector('.chat-run-indicator');
        const dot = indicator.querySelector('[aria-hidden="true"]');
        const style = getComputedStyle(dot);
        const animation = dot.getAnimations()[0];
        let opacitySamples = [];
        if (animation) { animation.pause(); for (const time of [0, 1000]) { animation.currentTime = time; opacitySamples.push(getComputedStyle(dot).opacity); } animation.play(); }
        return { label: indicator.textContent.trim(), animation: style.animationName, opacitySamples, background: style.backgroundColor, shadow: style.boxShadow, width: dot.getBoundingClientRect().width, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches };
      })()`);
      if (process.env.SPROUT_CHAT_MOTION_EVIDENCE) {
        await appendFile(process.env.SPROUT_CHAT_MOTION_EVIDENCE, `${JSON.stringify({ motion, status, ...snapshot })}\n`);
      }
      assert.equal(snapshot.label, `@agent · ${status === 'queued' ? 'starting…' : 'working…'}`);
      assert.equal(snapshot.reduced, motion === 'reduce');
      assert.equal(snapshot.animation, motion === 'reduce' ? 'none' : 'pulse');
      if (motion === 'no-preference') assert.deepEqual(snapshot.opacitySamples, ['1', '0.5'], 'real pulse changes dot opacity');
      else assert.deepEqual(snapshot.opacitySamples, [], 'reduced motion has no animation');
      assert.notEqual(snapshot.shadow, 'none', 'active state retains a visible accent ring without animation');
      assert.equal(snapshot.background === 'rgba(0, 0, 0, 0)', status === 'queued', 'queued is hollow and running is filled in both motion modes');
      assert.equal(snapshot.width, 8, 'static ring preserves the original dot layout box');
      assert.equal(await client.evaluate(`(() => {
        const stop = document.querySelector('.chat-stop-run');
        const indicator = document.querySelector('.chat-run-indicator');
        return stop.getBoundingClientRect().right <= innerWidth && indicator.getBoundingClientRect().right <= stop.getBoundingClientRect().left && document.documentElement.scrollWidth <= innerWidth;
      })()`), true, 'status and Stop fit a narrow phone viewport');
    }
    await client.evaluate('window.setRunStatus("completed")');
    assert.equal(await client.evaluate('document.querySelector(".chat-run-actions") !== null'), false);
  });
}
