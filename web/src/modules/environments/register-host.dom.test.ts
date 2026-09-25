import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

// 1. Initialize JSDOM and globals BEFORE importing any Vue or Vite modules
const initialHtml = await readFile(new URL('../../../app/index.html', import.meta.url), 'utf8');
const initialDom = new JSDOM(initialHtml, {
  url: 'http://sprout-operator.test/app/manage/environments',
  pretendToBeVisual: true,
});

(initialDom.window as Record<string, unknown>).__SPROUT_TEST_MANUAL_MOUNT__ = true;

const replacements: Record<string, unknown> = {
  window: initialDom.window,
  document: initialDom.window.document,
  HTMLElement: initialDom.window.HTMLElement,
  HTMLButtonElement: initialDom.window.HTMLButtonElement,
  HTMLFormElement: initialDom.window.HTMLFormElement,
  HTMLInputElement: initialDom.window.HTMLInputElement,
  HTMLSelectElement: initialDom.window.HTMLSelectElement,
  HTMLTextAreaElement: initialDom.window.HTMLTextAreaElement,
  SVGElement: initialDom.window.SVGElement,
  Element: initialDom.window.Element,
  Document: initialDom.window.Document,
  DocumentFragment: initialDom.window.DocumentFragment,
  location: initialDom.window.location,
  history: initialDom.window.history,
  localStorage: initialDom.window.localStorage,
  navigator: initialDom.window.navigator,
  getComputedStyle: initialDom.window.getComputedStyle,
  Node: initialDom.window.Node,
  Event: initialDom.window.Event,
  MouseEvent: initialDom.window.MouseEvent,
  KeyboardEvent: initialDom.window.KeyboardEvent,
  PointerEvent: initialDom.window.PointerEvent,
  FocusEvent: initialDom.window.FocusEvent,
  TouchEvent: initialDom.window.TouchEvent,
  CustomEvent: initialDom.window.CustomEvent,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 10),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  IntersectionObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  MutationObserver: initialDom.window.MutationObserver,
  NodeFilter: initialDom.window.NodeFilter,
};

for (const [key, value] of Object.entries(replacements)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

// Mock clipboard
let clipboardContent = '';
Object.assign(initialDom.window.navigator, {
  clipboard: {
    writeText: async (text: string) => {
      clipboardContent = text;
    },
    readText: async () => clipboardContent,
  },
});

const { createServer } = await import('vite');
const { default: vue } = await import('@vitejs/plugin-vue');

async function setupDom() {
  const dom = initialDom;
  const vite = await createServer({
    root: new URL('../../..', import.meta.url).pathname,
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
      vue(),
    ],
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
  });

  return {
    dom,
    vite,
    cleanup: async () => {
      await vite.close();
    },
  };
}

test('RegisterHostDialog: full production enrollment ceremony flow with separate secret and human approval', async () => {
  const { dom, vite, cleanup } = await setupDom();
  try {
    const { createApp, ref, h } = await import('vue');
    const RegisterHostDialogModule = (await vite.ssrLoadModule(
      '/src/modules/environments/components/RegisterHostDialog.vue',
    )) as { default: any };
    const RegisterHostDialog = RegisterHostDialogModule.default;

    let requestedEnrollmentCalls: any[] = [];
    let regeneratedSecretCalls: string[] = [];
    let cancelledCalls: string[] = [];
    let approvedCalls: { id: string; perms?: Record<string, boolean> }[] = [];

    let currentEnv: any = null;

    const mockService = {
      supportsEvidenceReconciliation: false,
      listEnvironments: async () => (currentEnv ? [currentEnv] : []),
      getEnvironment: async (id: string) => (currentEnv && currentEnv.id === id ? currentEnv : undefined),
      requestEnrollment: async (input: any) => {
        requestedEnrollmentCalls.push(input);
        const now = Date.now();
        currentEnv = {
          id: 'enroll-mac-1',
          displayName: input.displayName,
          platform: input.platform ?? 'macos',
          trafficLight: 'yellow',
          trafficLightReason: 'Pending worker claim',
          enrollmentStatus: 'pending',
          connectionState: 'never_connected',
          connectionAgeSec: 0,
          lastConfirmedTime: 'never',
          protocolVersion: 'v2.1',
          protocolCompatibility: 'compatible',
          workSafety: 'clear',
          capabilityPermissions: {
            processExecution: false,
            fileReadWrite: false,
            networkAccess: false,
          },
          requestedCapabilities: ['processExecution', 'fileReadWrite', 'networkAccess'],
          engineReadiness: {
            codex: 'ready',
            pi: 'ready',
          },
          engineDetails: {
            codex: { version: '0.154.0', installed: true, authStatus: 'authenticated', models: ['gpt-5-codex'] },
            pi: { version: '1.4.0', installed: true, authStatus: 'authenticated', models: ['claude-3-7-sonnet'] },
          },
          probeHistory: [],
          boundWorkspaces: [],
          identityDigest: '',
          claim: {
            issuedAt: now,
            expiresAt: now + 15 * 60 * 1000,
          },
          decisions: [
            {
              kind: 'requested',
              actor: 'operator',
              at: now,
              reason: 'Pending enrollment created in Web',
            },
          ],
        };
        return {
          enrollment: currentEnv,
          claimSecret: 'claim-secret-unshared-12345',
          claimExpiresAt: currentEnv.claim.expiresAt,
          bootstrapCommand: `sprout worker enroll localhost:41030 ${currentEnv.id}`,
        };
      },
      regenerateClaimSecret: async (id: string) => {
        regeneratedSecretCalls.push(id);
        const now = Date.now();
        currentEnv.claim = {
          issuedAt: now,
          expiresAt: now + 15 * 60 * 1000,
        };
        currentEnv.decisions.push({
          kind: 'secret-regenerated',
          actor: 'operator',
          at: now,
          reason: 'Unused enrollment claim secret regenerated by operator.',
        });
        return {
          claimSecret: 'claim-secret-fresh-99999',
          claimExpiresAt: currentEnv.claim.expiresAt,
        };
      },
      cancelEnrollment: async (id: string, reason?: string) => {
        cancelledCalls.push(id);
        currentEnv.enrollmentStatus = 'revoked';
        currentEnv.decisions.push({
          kind: 'cancelled',
          actor: 'operator',
          at: Date.now(),
          reason: reason ?? 'Pending enrollment cancelled by operator.',
        });
      },
      approveEnrollment: async (id: string, perms?: Record<string, boolean>) => {
        approvedCalls.push({ id, perms });
        currentEnv.enrollmentStatus = 'approved';
        currentEnv.trafficLight = 'green';
        if (perms) {
          currentEnv.capabilityPermissions = { ...perms };
        }
      },
      triggerProbe: async () => ({} as any),
      togglePermission: async () => {},
      unbindWorkspace: async () => {},
      reconcileEvidence: async () => {},
      resumeRecovery: async () => {},
      discardRecovery: async () => {},
      forceRelease: async () => {},
      archiveEnvironment: async () => {},
      restoreEnvironment: async () => {},
      unenrollEnvironment: async () => {},
    };

    const container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);

    const isOpen = ref(true);
    let closedFromEvent = false;
    let enrolledFromEvent = false;
    const app = createApp({
      setup() {
        return () =>
          h(RegisterHostDialog, {
            open: isOpen.value,
            service: mockService,
            onEnrolled: () => {
              enrolledFromEvent = true;
            },
            'onUpdate:open': (val: boolean) => {
              isOpen.value = val;
              if (!val) closedFromEvent = true;
            },
          });
      },
    });

    app.mount(container);
    await new Promise((r) => setTimeout(r, 60));

    const doc = dom.window.document;

    // 1. Initial Configure / Create Phase
    assert.match(doc.body.textContent ?? '', /Register New Host Environment/);
    assert.match(doc.body.textContent ?? '', /Host Display Name/);

    const nameInput = doc.getElementById('register-host-name') as HTMLInputElement;
    assert.ok(nameInput, 'Host display name input found');
    nameInput.value = 'Production Mac Studio';
    nameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    const beginBtn = doc.getElementById('btn-submit-registration') as HTMLButtonElement;
    assert.ok(beginBtn, 'Begin Registration button found');
    beginBtn.click();
    await new Promise((r) => setTimeout(r, 100));

    // 2. Verified submission creates pending enrollment
    assert.equal(requestedEnrollmentCalls.length, 1);
    assert.equal(requestedEnrollmentCalls[0].displayName, 'Production Mac Studio');

    // 3. Active Pending Phase: Public Command vs Secret
    const cmdEl = doc.getElementById('bootstrap-command-text');
    assert.ok(cmdEl, 'Bootstrap command element found');
    const cmdText = cmdEl.textContent ?? '';
    assert.match(cmdText, /^sprout worker enroll \S+ enroll-mac-1$/);

    // CRITICAL: Secret is NEVER embedded in command text
    assert.equal(cmdText.includes('claim-secret'), false, 'Secret must never appear in command text');

    // Test Copy Command button
    const copyCmdBtn = doc.getElementById('btn-copy-command') as HTMLButtonElement;
    assert.ok(copyCmdBtn, 'Copy command button found');
    clipboardContent = '';
    copyCmdBtn.click();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(clipboardContent, cmdText);

    // 4. One-Use Secret is visually and semantically separate
    const secretEl = doc.getElementById('claim-secret-value');
    assert.ok(secretEl, 'One-use secret element found');
    assert.equal(secretEl.textContent?.trim(), 'claim-secret-unshared-12345');

    // Test Copy Secret button
    const copySecretBtn = doc.getElementById('btn-copy-secret') as HTMLButtonElement;
    assert.ok(copySecretBtn, 'Copy secret button found');
    clipboardContent = '';
    copySecretBtn.click();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(clipboardContent, 'claim-secret-unshared-12345');

    // 5. Test State: Connection wait
    assert.match(doc.body.textContent ?? '', /Waiting for host worker to connect and prove identity/);

    // 6. Test State: Unused-secret regeneration
    const regenBtn = doc.querySelector('.regenerate-secret-btn') as HTMLButtonElement | null;
    // Or from the bottom link
    const allButtons = Array.from(doc.querySelectorAll('button'));
    const regenLink = allButtons.find((b) => b.textContent?.includes('Regenerate Secret'));
    assert.ok(regenLink, 'Regenerate secret button found');
    regenLink.click();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(regeneratedSecretCalls.length, 1);
    assert.match(doc.body.textContent ?? '', /Fresh one-use claim secret generated/);

    // 7. Simulate Worker Connect and Proof (Advancing to Review Phase)
    currentEnv.identityDigest = 'a1b2c3d4e5f6g7h8i9j0';
    // Trigger polling check
    await new Promise((r) => setTimeout(r, 1600));

    // 8. Review Phase: Real platform, protocol, capabilities, engines
    assert.match(doc.body.textContent ?? '', /Worker Identity Verified/);
    assert.match(doc.body.textContent ?? '', /macos/);
    assert.match(doc.body.textContent ?? '', /v2\.1/);
    assert.match(doc.body.textContent ?? '', /a1b2c3d4e5f6g7h8/);
    assert.match(doc.body.textContent ?? '', /codex/i);
    assert.match(doc.body.textContent ?? '', /pi/i);
    assert.match(doc.body.textContent ?? '', /gpt-5-codex/);
    assert.match(doc.body.textContent ?? '', /claude-3-7-sonnet/);

    // Check capability checkboxes: Human explicitly checks processExecution
    const execCheckbox = doc.getElementById('perm-processExecution') as HTMLButtonElement | null;
    assert.ok(execCheckbox, 'processExecution checkbox found');
    execCheckbox.click();
    await new Promise((r) => setTimeout(r, 60));

    // 9. Explicit Human Approval with selected permissions
    const approveBtn = doc.getElementById('btn-approve-enrollment') as HTMLButtonElement;
    assert.ok(approveBtn, 'Approve Worker & Permissions button found');
    approveBtn.click();
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(approvedCalls.length, 1);
    assert.equal(approvedCalls[0].id, 'enroll-mac-1');
    assert.ok(approvedCalls[0].perms, 'Human selected permissions recorded');
    // Human explicitly selected processExecution, but left others unchecked
    assert.equal(approvedCalls[0].perms.processExecution, true);
    assert.equal(approvedCalls[0].perms.fileReadWrite, false);
    assert.equal(approvedCalls[0].perms.networkAccess, false);

    // 10. Approved Phase
    assert.match(doc.body.textContent ?? '', /Environment Enrolled Successfully/);

    // Accessibility: Live region is present and announced
    const liveRegion = doc.getElementById('register-host-live-region');
    assert.ok(liveRegion, 'Live region found');
    assert.equal(liveRegion.getAttribute('aria-live'), 'polite');
    assert.equal(liveRegion.getAttribute('role'), 'status');

    // Touch targets: primary buttons have min-h-[44px]
    assert.ok(beginBtn.classList.contains('min-h-[44px]'));
    assert.ok(copySecretBtn.classList.contains('min-h-[44px]'));
    assert.ok(approveBtn.classList.contains('min-h-[44px]'));

    const doneBtn = doc.getElementById('btn-done-enrollment') as HTMLButtonElement;
    assert.ok(doneBtn, 'Done button found');
    assert.ok(doneBtn.classList.contains('min-h-[44px]'));
    doneBtn.click();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(isOpen.value, false, 'Dialog closed on Done');

    // 11. Privacy & URL safety: claim secret is never in URL, search, or history
    assert.equal(dom.window.location.search.includes('claim-secret'), false, 'secret not in query');
    assert.equal(dom.window.location.hash.includes('claim-secret'), false, 'secret not in hash');
    assert.equal(dom.window.location.pathname.includes('claim-secret'), false, 'secret not in path');

    app.unmount();
    container.remove();
  } finally {
    await cleanup();
  }
});

test('RegisterHostDialog: 8 distinct states have decisive text and actions', async () => {
  const { dom, vite, cleanup } = await setupDom();
  try {
    const { createApp, ref, h } = await import('vue');
    const RegisterHostDialogModule = (await vite.ssrLoadModule(
      '/src/modules/environments/components/RegisterHostDialog.vue',
    )) as { default: any };
    const RegisterHostDialog = RegisterHostDialogModule.default;

    let testEnv: any = null;

    const mockService = {
      supportsEvidenceReconciliation: false,
      listEnvironments: async () => (testEnv ? [testEnv] : []),
      getEnvironment: async (id: string) => testEnv,
      requestEnrollment: async () => ({} as any),
      regenerateClaimSecret: async () => ({
        claimSecret: 'fresh-secret',
        claimExpiresAt: Date.now() + 100000,
      }),
      cancelEnrollment: async (_id: string, reason?: string) => {
        testEnv.enrollmentStatus = 'revoked';
        testEnv.decisions.push({ kind: 'cancelled', actor: 'operator', at: Date.now(), reason: reason ?? '' });
      },
      approveEnrollment: async () => {},
      triggerProbe: async () => ({} as any),
      togglePermission: async () => {},
      unbindWorkspace: async () => {},
      reconcileEvidence: async () => {},
      resumeRecovery: async () => {},
      discardRecovery: async () => {},
      forceRelease: async () => {},
      archiveEnvironment: async () => {},
      restoreEnvironment: async () => {},
      unenrollEnvironment: async () => {},
    };

    // Helper to mount dialog with specific testEnv
    async function inspectDialogState(envSetup: any) {
      testEnv = envSetup;
      const container = dom.window.document.createElement('div');
      dom.window.document.body.appendChild(container);

      const isOpen = ref(true);
      const app = createApp({
        render() {
          return h(RegisterHostDialog, {
            open: isOpen.value,
            service: mockService,
            initialEnrollmentId: testEnv.id,
            'onUpdate:open': (val: boolean) => {
              isOpen.value = val;
            },
          });
        },
      });

      app.mount(container);
      await new Promise((r) => setTimeout(r, 80));
      const text = dom.window.document.body.textContent ?? '';
      isOpen.value = false;
      await new Promise((r) => setTimeout(r, 20));
      app.unmount();
      container.remove();
      return text;
    }

    const now = Date.now();

    // State 1: Connection wait
    const textWait = await inspectDialogState({
      id: 'e-wait',
      displayName: 'Wait Host',
      platform: 'macos',
      enrollmentStatus: 'pending',
      identityDigest: '',
      capabilityPermissions: {},
      claim: { issuedAt: now, expiresAt: now + 60000 },
      decisions: [],
    });
    assert.match(textWait, /Waiting for host worker to connect and prove identity\.\.\./);

    // State 2: Expiration
    const textExpired = await inspectDialogState({
      id: 'e-expired',
      displayName: 'Expired Host',
      platform: 'macos',
      enrollmentStatus: 'pending',
      identityDigest: '',
      capabilityPermissions: {},
      claim: { issuedAt: now - 60000, expiresAt: now - 1000 },
      decisions: [],
    });
    assert.match(textExpired, /The one-use enrollment claim secret has expired\. Worker enrollment is blocked until a fresh secret is generated\./);

    // State 3: Already-consumed claim
    const textConsumed = await inspectDialogState({
      id: 'e-consumed',
      displayName: 'Consumed Host',
      platform: 'macos',
      enrollmentStatus: 'pending',
      identityDigest: '',
      capabilityPermissions: {},
      claim: { issuedAt: now - 10000, expiresAt: now + 50000, consumedAt: now - 5000 },
      decisions: [],
    });
    assert.match(textConsumed, /The one-use claim secret has already been consumed and cannot be reused\./);

    // State 4: Cancelled pending enrollment
    const textCancelled = await inspectDialogState({
      id: 'e-cancelled',
      displayName: 'Cancelled Host',
      platform: 'macos',
      enrollmentStatus: 'revoked',
      identityDigest: '',
      capabilityPermissions: {},
      decisions: [{ kind: 'cancelled', actor: 'operator', at: now, reason: 'Pending enrollment cancelled by operator.' }],
    });
    assert.match(textCancelled, /Pending enrollment has been cancelled by operator\./);

    // State 5: Claim/proof failure
    const textFailed = await inspectDialogState({
      id: 'e-failed',
      displayName: 'Failed Host',
      platform: 'macos',
      enrollmentStatus: 'pending',
      identityDigest: '',
      capabilityPermissions: {},
      connectionAttempt: { outcome: 'incompatible', reason: 'invalid proof signature', at: now },
      decisions: [{ kind: 'requested', actor: 'operator', at: now, reason: 'proof signature invalid' }],
    });
    assert.match(textFailed, /Host worker claim or identity proof failed\. The worker connection was refused\./);

    // State 6: Duplicate identity
    const textDuplicate = await inspectDialogState({
      id: 'e-dup',
      displayName: 'Dup Host',
      platform: 'macos',
      enrollmentStatus: 'pending',
      identityDigest: '',
      capabilityPermissions: {},
      decisions: [{ kind: 'duplicate-new-key-refused', actor: 'worker', at: now, reason: 'A different key was presented' }],
    });
    assert.match(textDuplicate, /Duplicate worker identity refused: A different worker key cannot replace an existing binding without an explicit reset\./);

    // State 7: Revoked identity
    const textRevoked = await inspectDialogState({
      id: 'e-revoked',
      displayName: 'Revoked Host',
      platform: 'macos',
      enrollmentStatus: 'revoked',
      identityDigest: 'key-12345',
      capabilityPermissions: {},
      decisions: [{ kind: 'revoked', actor: 'operator', at: now, reason: 'Security compromise' }],
    });
    assert.match(textRevoked, /This environment enrollment is revoked\. Host worker connections are barred\./);
  } finally {
    await cleanup();
  }
});

test('Privacy Boundary: production enrollment route imports no fixture authority and exposes no secrets', async () => {
  // Verify that production files never import fixture-adapter
  const prodAdapterSource = await readFile(new URL('./adapters/production-adapter.ts', import.meta.url), 'utf8');
  assert.equal(/fixture-adapter/.test(prodAdapterSource), false, 'production-adapter must not import fixture-adapter');

  const dialogSource = await readFile(new URL('./components/RegisterHostDialog.vue', import.meta.url), 'utf8');
  assert.equal(/fixture-adapter/.test(dialogSource), false, 'RegisterHostDialog must not import fixture-adapter');

  const viewSource = await readFile(new URL('./views/EnvironmentsView.vue', import.meta.url), 'utf8');
  assert.equal(/fixture-adapter/.test(viewSource), false, 'EnvironmentsView must not import fixture-adapter');

  // Verify the bootstrap command structure contains no secrets
  const { buildBootstrapCommand } = await import('./adapters/production-adapter.ts');
  const command = buildBootstrapCommand('enroll-test-999');
  assert.match(command, /^sprout worker enroll \S+ enroll-test-999$/);
  assert.equal(command.includes('secret'), false);
  assert.equal(command.includes('--private-transport'), false);
});
