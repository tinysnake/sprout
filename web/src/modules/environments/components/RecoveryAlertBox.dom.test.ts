import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import type {
  EnvironmentEnrollmentBrowserAdapter,
  EnvironmentFactsView,
  EnvironmentRecoveryView,
} from '../../../adapters/environment-api.ts';
import type { EnvironmentInstance } from '../types.js';
import { ProductionEnvironmentService } from '../adapters/production-adapter.ts';

const initialHtml = await readFile(new URL('../../../../app/index.html', import.meta.url), 'utf8');
const initialDom = new JSDOM(initialHtml, {
  url: 'http://sprout-operator.test/app/manage/environments',
  pretendToBeVisual: true,
});

const replacements: Record<string, unknown> = {
  window: initialDom.window,
  document: initialDom.window.document,
  HTMLElement: initialDom.window.HTMLElement,
  HTMLButtonElement: initialDom.window.HTMLButtonElement,
  SVGElement: initialDom.window.SVGElement,
  Element: initialDom.window.Element,
  Document: initialDom.window.Document,
  DocumentFragment: initialDom.window.DocumentFragment,
  Node: initialDom.window.Node,
  Event: initialDom.window.Event,
  MouseEvent: initialDom.window.MouseEvent,
  CustomEvent: initialDom.window.CustomEvent,
  navigator: initialDom.window.navigator,
  getComputedStyle: initialDom.window.getComputedStyle,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 10),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
for (const [key, value] of Object.entries(replacements)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

function factsWithRemoteProcess(uncertain: boolean): EnvironmentFactsView {
  const recovery = {
    id: 'recovery-1',
    environmentInstanceId: 'instance-1',
    leaseId: 'lease-1',
    holderKind: 'task',
    taskId: 'task-1',
    cause: 'worker-channel-lost',
    phase: 'recovery',
    startedAt: 1,
    updatedAt: 2,
    evidence: {
      retainedEventCount: 1,
      turnSettlementObserved: true,
      terminalStatus: 'interrupted',
      engineSessionStopped: true,
      taskContextRecycled: false,
      taskContextPrepared: true,
    },
    unresolvedFacts: uncertain
      ? ['1 Project MCP process(es) have not been confirmed stopped.']
      : [],
    evidenceSynchronized: true,
    remoteWorkEvidence: { unresolved: uncertain },
    decisions: [],
  } as unknown as EnvironmentRecoveryView;

  return {
    enrollment: {
      id: 'enrollment-1',
      environmentInstanceId: 'instance-1',
      displayName: 'Test Worker',
      status: 'approved',
      platform: 'container',
      identityDigest: 'digest-1',
      capabilityPermissions: { 'agent-run': true },
      createdAt: 1,
      updatedAt: 2,
      decisions: [],
    },
    readiness: {
      environmentInstanceId: 'instance-1',
      summary: { level: 'red', reason: 'Lease recovery is required.' },
      enrollmentStatus: 'approved',
      connection: { state: 'online' },
      compatibility: { state: 'compatible' },
      capabilities: [],
      engines: [],
      workSafety: { state: 'recovery' },
    },
    probes: [],
    recovery: [recovery],
    forceReleases: [],
  };
}

function serviceFor(facts: EnvironmentFactsView): ProductionEnvironmentService {
  const adapter = {
    state: () => ({ status: 'online', connection: 'online', loading: false }),
    subscribeState: () => () => undefined,
    async environmentFacts() { return facts; },
  } as unknown as EnvironmentEnrollmentBrowserAdapter;
  return new ProductionEnvironmentService(adapter);
}

test('RecoveryAlertBox gates ordinary decisions on sanitized remote process-stop evidence', async () => {
  const vite = await (await import('vite')).createServer({
    root: new URL('../../../../', import.meta.url).pathname,
    appType: 'custom',
    logLevel: 'error',
    plugins: [
      {
        name: 'force-client-vue',
        enforce: 'pre',
        transform(_code, _id, opt) {
          if (opt) opt.ssr = false;
        },
      },
      (await import('@vitejs/plugin-vue')).default(),
    ],
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
  });

  try {
    const { createApp, h, nextTick, ref } = await import('vue');
    const component = (await vite.ssrLoadModule(
      '/src/modules/environments/components/RecoveryAlertBox.vue',
    )) as { default: unknown };
    const uncertainEnv = await serviceFor(factsWithRemoteProcess(true)).getEnvironment('enrollment-1');
    const confirmedEnv = await serviceFor(factsWithRemoteProcess(false)).getEnvironment('enrollment-1');
    assert.ok(uncertainEnv);
    assert.ok(confirmedEnv);
    const env = ref(uncertainEnv as EnvironmentInstance);
    const container = initialDom.window.document.createElement('div');
    initialDom.window.document.body.appendChild(container);
    const app = createApp({ render: () => h(component.default as any, { env: env.value }) });
    app.mount(container);

    const alert = container.querySelector('.recovery-alert-box');
    assert.ok(alert);
    assert.match(alert.textContent ?? '', /Remote operation outcomes or Project MCP process stops remain unconfirmed/);
    assert.match(alert.textContent ?? '', /Ordinary recovery remains blocked/);
    assert.doesNotMatch(alert.textContent ?? '', /Ready for Human decision/);
    assert.equal(container.querySelector('.btn-resume-recovery'), null);
    assert.equal(container.querySelector('.btn-discard-recovery'), null);

    env.value = confirmedEnv;
    await nextTick();
    assert.match(alert.textContent ?? '', /Remote operation outcomes and Project MCP process stops are confirmed/);
    assert.match(alert.textContent ?? '', /Ready for Human decision/);
    assert.ok(container.querySelector('.btn-resume-recovery'));
    assert.ok(container.querySelector('.btn-discard-recovery'));
    app.unmount();
  } finally {
    await vite.close();
  }
});
