/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';

// Real production routes, shell, adapters and Tailwind; only API wire data is
// simulated. Run with npm run test:layout after npx playwright install chromium.
const fixture = `
import { createSproutApp, createProductionAppOptions } from '/src/app/main.ts';
import { createBrowserTransport } from '/src/transport/browser-transport.ts';
import { journeyWire } from '/src/app/production-journey-wire.ts';
const wire = journeyWire();
const transport = createBrowserTransport({
  fetch: async (input, init) => {
    const path = String(input).split('?')[0];
    if (path === '/api/tasks') return Response.json({ tasks: Array.from({ length: 20 }, (_, i) => ({ ...wire.task, id: 'task-' + i, title: 'Task ' + i })) });
    if (path === '/api/runs/run-a') return Response.json({ id: 'run-a', agentId: 'agent-a', projectId: 'project-a', status: 'completed', createdAt: 1800000000000, completedAt: 1800000001000, events: [] });
    if (path.endsWith('/active-runs')) return Response.json({ runs: [{ id: 'chat-live', agentId: 'agent-a', projectId: 'project-a', scopeId: 'channel-a', status: 'running', createdAt: Date.now() }] });
    return wire.respond(String(input), init);
  },
  eventSource: () => ({ onopen: null, onmessage: null, onerror: null, addEventListener() {}, close() {} }),
});
const { app, router } = createSproutApp({ ...createProductionAppOptions(transport), routerBase: '/app/' });
await router.push('/project/tasks?project=project-a');
await router.isReady();
app.mount('#app');
window.geometryRouter = router;
`;

let vite: ViteDevServer;
let browser: Browser;
let endpoint: string;
before(async () => {
  const port = Number(process.env.PORT ?? process.env.DEV_PIPELINE_PORT_BASE ?? 41010);
  vite = await createServer({
    server: { host: '127.0.0.1', port, strictPort: true, proxy: {}, hmr: false },
    plugins: [{
      name: 'tasks-layout-fixture',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/__layout.html') {
            res.setHeader('Content-Type', 'text/html');
            res.end('<div id="app"></div><script>window.__SPROUT_TEST_MANUAL_MOUNT__=true</script><script type="module" src="/__layout.js"></script>');
          } else if (req.url === '/__layout.js') {
            res.setHeader('Content-Type', 'text/javascript');
            res.end(fixture);
          } else next();
        });
      },
    }],
  });
  await vite.listen();
  endpoint = `http://127.0.0.1:${port}/__layout.html`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await vite?.close();
});

async function openPage(width: number, height: number, safe: number) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(15000);
  // All page services use the wire fixture; an accidental production API
  // request must fail rather than reaching another checkout's runtime.
  await page.route('**/api/**', route => route.abort());
  await page.goto(endpoint);
  await page.locator('[data-record-id="task-19"]').waitFor();
  if (safe) await page.locator('.sprout-app-shell').evaluate((shell, safe) => {
    // Chromium headless has no physical safe area. Preserve the shared inset
    // contract while substituting a measured phone safe-area value.
    (shell as HTMLElement).style.setProperty('--shell-bottom-inset', `calc(var(--mobile-nav-height) + ${safe}px)`);
  }, safe);
  return page;
}

function record(value: unknown) {
  if (process.env.SPROUT_LAYOUT_REPORT) appendFileSync(process.env.SPROUT_LAYOUT_REPORT, JSON.stringify(value) + '\n');
}

async function geometry(page: Page, selector: string) {
  return page.evaluate(({ selector }) => {
    const main = document.querySelector<HTMLElement>('.shell-main')!;
    const tail = document.querySelector<HTMLElement>(selector)!;
    const scroller = tail.closest('[aria-label="Selected Task details"]') ?? tail.parentElement!;
    scroller.scrollTop = scroller.scrollHeight;
    const bounds = (element: Element) => {
      const { top, bottom, height } = element.getBoundingClientRect();
      return { top, bottom, height };
    };
    return {
      tail: bounds(tail), scroller: bounds(scroller), main: bounds(main),
      nav: bounds(document.querySelector('.mobile-bottom-nav')!),
      pad: parseFloat(getComputedStyle(main).paddingBottom),
      navDisplay: getComputedStyle(document.querySelector('.mobile-bottom-nav')!).display,
      mainScrollTop: main.scrollTop, mainScrollHeight: main.scrollHeight, mainClientHeight: main.clientHeight,
    };
  }, { selector });
}

for (const [width, height, safe] of [[390, 667, 0], [390, 844, 0], [390, 667, 34], [1280, 900, 0]] as const) {
  test(`Tasks list and detail tails clear navigation at ${width}×${height}, safe area ${safe}`, async () => {
    const page = await openPage(width, height, safe);
    try {
      const list = await geometry(page, '[data-record-id="task-19"]');
      record({ case: 'tasks-list', width, height, safe, ...list });
      assert.ok(list.tail.top >= list.scroller.top - 1, 'the entire final task row is visible');
      assert.ok(list.tail.bottom <= list.scroller.bottom + 1, 'the final row fits its scroller');
      if (width < 768) {
        assert.equal(list.pad, 64 + safe);
        assert.equal(list.nav.height, list.pad);
        assert.ok(list.tail.bottom <= list.nav.top - 15, 'the final task row retains ordinary page padding above nav');
        assert.equal(list.mainScrollHeight, list.mainClientHeight, 'the list scrolls inside the inset instead of overflowing main');
      } else {
        assert.equal(list.pad, 0);
        assert.equal(list.navDisplay, 'none');
      }
      await page.evaluate(async () => {
        await (window as unknown as { geometryRouter: { push(path: string): Promise<void> } }).geometryRouter.push('/project/tasks/task-a?project=project-a');
      });
      await page.locator('[aria-label="Selected Task details"] [data-task-run-target]').waitFor();
      const audit = page.locator('[data-run-audit="run-a"] > div > button');
      await geometry(page, '[data-run-audit="run-a"] > div > button');
      await audit.click();
      await page.locator('[data-run-result] button').waitFor();
      const detail = await geometry(page, '[data-run-result] button');
      record({ case: 'tasks-detail', width, height, safe, ...detail });
      assert.ok(detail.tail.top >= detail.scroller.top - 1, 'the full final audit action is visible');
      assert.ok(detail.tail.bottom <= detail.scroller.bottom + 1, 'detail audit and actions can be scrolled fully into view');
      await page.locator('[data-run-result] button').click();
      await page.locator('[data-run-result] button[aria-expanded="true"]').waitFor();
      if (width < 768) assert.ok(detail.tail.bottom <= detail.nav.top - 15, 'detail tail clears nav with page padding');
    } finally { await page.close(); }
  });
}

test('active Chat indicator and composer still clear navigation at both phone heights', async () => {
  for (const height of [667, 844]) {
    const page = await openPage(390, height, 0);
    try {
      await page.evaluate(async () => {
        await (window as unknown as { geometryRouter: { push(path: string): Promise<void> } }).geometryRouter.push('/project/chat/channel-a?project=project-a');
      });
      await page.locator('.chat-run-indicator').waitFor();
      await page.locator('.chat-composer input:enabled').waitFor();
      const result = await page.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        return { indicatorBottom: rect('.chat-run-indicator').bottom, actionsBottom: rect('.chat-run-actions').bottom,
          composerTop: rect('.chat-composer').top, composerBottom: rect('.chat-composer').bottom, navTop: rect('.mobile-bottom-nav').top };
      });
      record({ case: 'chat', height, ...result });
      assert.ok(result.indicatorBottom <= result.composerTop);
      assert.ok(result.actionsBottom <= result.composerTop);
      assert.ok(result.composerBottom <= result.navTop - 11);
    } finally { await page.close(); }
  }
});
