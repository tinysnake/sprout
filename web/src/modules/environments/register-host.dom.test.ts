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
    let approvedCalls: { id: string; perms?: Record<string, boolean>; modelAuths?: Record<string, string[]> }[] = [];

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
          },
          requestedCapabilities: ['processExecution', 'fileReadWrite', 'networkAccess'],
          engineReadiness: {
            codex: 'ready',
            pi: 'ready',
          },
          engineDetails: {
            codex: { version: '0.154.0', installed: true, authStatus: 'authenticated', models: ['gpt-5-codex'], source: 'codex-account-read', observedAt: 1_700_000_000_123 },
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
      approveEnrollment: async (id: string, perms?: Record<string, boolean>, modelAuths?: Record<string, string[]>) => {
        approvedCalls.push({ id, perms, modelAuths });
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

    // The command stays unbroken; the copy action stacks on narrow screens and
    // joins the command in one row on sm+.
    assert.ok(cmdEl.classList.contains('overflow-x-auto'));
    assert.ok(cmdEl.classList.contains('whitespace-pre'));
    assert.equal(cmdEl.classList.contains('break-all'), false);
    const commandLayout = cmdEl.parentElement;
    assert.ok(commandLayout?.classList.contains('flex-col'));
    assert.ok(commandLayout?.classList.contains('sm:flex-row'));
    assert.ok(commandLayout?.classList.contains('sm:items-center'));
    assert.ok(cmdEl.classList.contains('min-w-0'));
    assert.ok(cmdEl.classList.contains('flex-1'));
    const copyCmdBtn = doc.getElementById('btn-copy-command') as HTMLButtonElement;
    assert.ok(copyCmdBtn, 'Copy command button found');
    assert.equal(copyCmdBtn.parentElement, commandLayout);
    assert.equal(copyCmdBtn.classList.contains('absolute'), false);
    assert.ok(copyCmdBtn.classList.contains('w-full'));
    assert.ok(copyCmdBtn.classList.contains('sm:w-auto'));
    assert.ok(copyCmdBtn.classList.contains('shrink-0'));

    // CRITICAL: Secret is NEVER embedded in command text
    assert.equal(cmdText.includes('claim-secret'), false, 'Secret must never appear in command text');

    // Test Copy Command button
    clipboardContent = '';
    copyCmdBtn.click();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(clipboardContent, cmdText);
    assert.equal(copyCmdBtn.textContent?.trim(), 'Copied!', 'Copied feedback is shown after copying');

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
    assert.match(doc.body.textContent ?? '', /Source: codex-account-read/);
    assert.match(doc.body.textContent ?? '', /Observed: .*2023/);
    assert.match(doc.body.textContent ?? '', /Version: 0\.154\.0/);

    // Check capability checkboxes: Human explicitly checks processExecution
    const execCheckbox = doc.getElementById('perm-processExecution') as HTMLButtonElement | null;
    assert.ok(execCheckbox, 'processExecution checkbox found');
    execCheckbox.click();
    await new Promise((r) => setTimeout(r, 60));

    // #138: Check target models section and explicit per-model human authorization
    assert.match(doc.body.textContent ?? '', /Configured Target Models & Entitlement/);
    assert.match(doc.body.textContent ?? '', /Human Authorization Required/);
    assert.match(doc.body.textContent ?? '', /provenance human-approval/);

    const codexModelCheck = doc.getElementById('auth-model-codex-gpt-5-codex') as HTMLButtonElement | null;
    const piModelCheck = doc.getElementById('auth-model-pi-claude-3-7-sonnet') as HTMLButtonElement | null;
    assert.ok(codexModelCheck, 'Codex target model checkbox found');
    assert.ok(piModelCheck, 'Pi target model checkbox found');

    // Controls have accessible aria-labels and keyboard associations
    assert.equal(codexModelCheck.getAttribute('aria-label'), 'Authorize model gpt-5-codex for codex');
    assert.equal(piModelCheck.getAttribute('aria-label'), 'Authorize model claude-3-7-sonnet for pi');

    // Check touch target: row container has min-h-[44px]
    const modelRow = codexModelCheck.closest('div');
    assert.ok(modelRow?.classList.contains('min-h-[44px]'), 'Model authorization row has min-h-[44px] for touch target');

    // Human explicitly authorizes codex:gpt-5-codex, leaves pi unchecked (no default, no implication)
    codexModelCheck.click();
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

    // #138: Only explicitly selected model was authorized; unselected model has no grant
    assert.ok(approvedCalls[0].modelAuths, 'Model authorizations recorded');
    assert.deepEqual(approvedCalls[0].modelAuths.codex, ['gpt-5-codex']);
    assert.equal(approvedCalls[0].modelAuths.pi, undefined, 'Pi model unselected and not authorized');

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

test('RegisterHostDialog: resumed pending enrollment restores public command and rotates secret without persisting it', async () => {
  const { dom, vite, cleanup } = await setupDom();
  try {
    const { createApp, h, ref, nextTick } = await import('vue');
    const { default: RegisterHostDialog } = (await vite.ssrLoadModule(
      '/src/modules/environments/components/RegisterHostDialog.vue',
    )) as { default: any };
    const { buildBootstrapCommand } = (await vite.ssrLoadModule(
      '/src/modules/environments/adapters/production-adapter.ts',
    )) as { buildBootstrapCommand: (id: string) => string };
    const now = Date.now();
    const env: any = {
      id: 'enroll-resumed', enrollmentStatus: 'pending', identityDigest: '',
      capabilityPermissions: {}, requestedCapabilities: [],
      claim: { issuedAt: now, expiresAt: now + 60_000 }, decisions: [],
    };
    let rotations = 0;
    const service = {
      getEnvironment: async () => env,
      // Exercise the production endpoint builder used by the typed service, not a hard-coded test port.
      getBootstrapCommand: buildBootstrapCommand,
      regenerateClaimSecret: async () => {
        rotations++;
        return { claimSecret: 'fresh-only-in-memory', claimExpiresAt: now + 60_000 };
      },
    };
    const container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);
    const isOpen = ref(true);
    const app = createApp({
      setup: () => () => h(RegisterHostDialog, {
        open: isOpen.value, service, initialEnrollmentId: env.id,
        'onUpdate:open': (value: boolean) => { isOpen.value = value; },
      }),
    });
    app.mount(container);
    await new Promise((r) => setTimeout(r, 80));
    const doc = dom.window.document;
    const expected = buildBootstrapCommand(env.id);
    assert.equal(doc.getElementById('bootstrap-command-text')?.textContent, expected);
    assert.equal(doc.getElementById('claim-secret-value'), null, 'the old secret cannot be recovered');
    clipboardContent = '';
    (doc.getElementById('btn-copy-command') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(clipboardContent, expected);
    const rotate = Array.from(doc.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Regenerate Secret');
    assert.ok(rotate);
    rotate.click();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(rotations, 1);
    assert.equal(doc.getElementById('claim-secret-value')?.textContent?.trim(), 'fresh-only-in-memory');
    assert.equal(doc.getElementById('bootstrap-command-text')?.textContent, expected);
    assert.equal(expected.includes('fresh-only-in-memory'), false);
    isOpen.value = false;
    await nextTick();
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
      getBootstrapCommand: (id: string) => `sprout worker enroll sprout-operator.test:80 ${id}`,
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

test('Ticket #147: closing a newly-created pending ceremony reloads the environment list', async () => {
  const { dom, vite, cleanup } = await setupDom();
  try {
    const { createApp, h } = await import('vue');
    const { createMemoryHistory, createRouter } = await import('vue-router');
    const { default: EnvironmentsView } = (await vite.ssrLoadModule(
      '/src/modules/environments/views/EnvironmentsView.vue',
    )) as { default: any };

    const pending: any = {
      id: 'enroll-close-refresh',
      displayName: 'New pending host',
      platform: 'macos',
      enrollmentStatus: 'pending',
      trafficLight: 'yellow',
      trafficLightReason: 'Pending worker claim',
      connectionState: 'never_connected',
      connectionAgeSec: 0,
      lastConfirmedTime: 'never',
      protocolVersion: 'v2.1',
      protocolCompatibility: 'compatible',
      workSafety: 'clear',
      capabilityPermissions: {},
      engineReadiness: {},
      probeHistory: [],
      boundWorkspaces: [],
      identityDigest: '',
      claim: { issuedAt: Date.now(), expiresAt: Date.now() + 60000 },
      decisions: [],
    };
    const existing: any = { ...pending, id: 'existing-host', displayName: 'Existing host' };
    let listed = false;
    let listCalls = 0;
    let releaseRefresh!: () => void;
    let notifyRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { notifyRefreshStarted = resolve; });
    const service = {
      supportsEvidenceReconciliation: false,
      listEnvironments: async () => {
        listCalls++;
        if (listCalls === 2) {
          notifyRefreshStarted();
          await new Promise<void>((resolve) => { releaseRefresh = resolve; });
        }
        return listed ? [existing, pending] : [existing];
      },
      getEnvironment: async () => undefined,
      getBootstrapCommand: () => 'sprout worker enroll token enroll-close-refresh',
      requestEnrollment: async () => { listed = true; return { enrollment: pending, bootstrapCommand: 'sprout worker enroll token enroll-close-refresh', claimSecret: 'secret', claimExpiresAt: pending.claim.expiresAt }; },
      regenerateClaimSecret: async () => ({} as any),
      cancelEnrollment: async () => {},
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
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/app/manage/environments', name: 'environments', component: EnvironmentsView }],
    });
    await router.push('/app/manage/environments');
    await router.isReady();
    const container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);
    const app = createApp({ render: () => h(EnvironmentsView, { service }) });
    // Route composables and router links use the same router instance as the view.
    app.use(router);
    app.mount(container);
    await new Promise((r) => setTimeout(r, 60));

    (dom.window.document.getElementById('btn-register-host') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 40));
    const nameInput = dom.window.document.getElementById('register-host-name') as HTMLInputElement;
    nameInput.value = 'New pending host';
    nameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    (dom.window.document.getElementById('btn-submit-registration') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(listCalls, 1, 'list was loaded on initial view mount');

    const closeButton = [...dom.window.document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Close Dialog (Keep Pending)')) as HTMLButtonElement | undefined;
    assert.ok(closeButton, 'pending ceremony can be closed while keeping the enrollment');
    closeButton.click();
    await refreshStarted;
    assert.ok(container.querySelector('.envs-loading-state') === null, 'background refresh keeps the loaded view mounted');
    assert.match(container.textContent ?? '', /Existing host/, 'existing environment remains visible while refresh is pending');
    releaseRefresh();
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(listCalls > 1, 'closing the ceremony reloads the environment list');
    assert.match(container.textContent ?? '', /New pending host/, 'new pending enrollment appears without manual reload');

    app.unmount();
    container.remove();
  } finally {
    await cleanup();
  }
});

test('Ticket #150 rework: background refresh keeps a complete selected snapshot visible until atomic replacement', async () => {
  const { dom, vite, cleanup } = await setupDom();
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  try {
    const { createApp, h } = await import('vue');
    const { createMemoryHistory, createRouter } = await import('vue-router');
    const { default: EnvironmentsView } = (await vite.ssrLoadModule(
      '/src/modules/environments/views/EnvironmentsView.vue',
    )) as { default: any };
    const row = (displayName: string, reason: string): any => ({
      id: 'stable-env', displayName, platform: 'linux', enrollmentStatus: 'approved',
      trafficLight: 'green', trafficLightReason: reason, connectionState: 'online',
      connectionAgeSec: 0, lastConfirmedTime: 'Just now', protocolVersion: 'v2.1',
      protocolCompatibility: 'compatible', workSafety: 'clear', capabilityPermissions: {},
      engineReadiness: {}, probeHistory: [], boundWorkspaces: [], identityDigest: '', decisions: [],
    });
    const before = row('Stable host', 'All readiness facts are current and verified.');
    const after = row('Updated host', 'Updated facts are now available.');
    let listCalls = 0;
    let releaseRefresh!: (rows: any[]) => void;
    const service = {
      supportsEvidenceReconciliation: false,
      listEnvironments: () => {
        listCalls++;
        if (listCalls === 1) return Promise.resolve([before]);
        return new Promise<any[]>((resolve) => { releaseRefresh = resolve; });
      },
      getEnvironment: async () => before,
      getBootstrapCommand: () => 'sprout worker enroll token stable-env',
      requestEnrollment: async () => ({} as any), regenerateClaimSecret: async () => ({} as any),
      cancelEnrollment: async () => {}, approveEnrollment: async () => {}, triggerProbe: async () => ({} as any),
      togglePermission: async () => {}, unbindWorkspace: async () => {}, reconcileEvidence: async () => {},
      resumeRecovery: async () => {}, discardRecovery: async () => {}, forceRelease: async () => {},
      archiveEnvironment: async () => {}, restoreEnvironment: async () => {}, unenrollEnvironment: async () => {},
    };
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/app/manage/environments', name: 'environments', component: EnvironmentsView }],
    });
    await router.push('/app/manage/environments');
    await router.isReady();
    const container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);
    const app = createApp({ render: () => h(EnvironmentsView, { service }) });
    app.use(router);
    app.mount(container);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const list = container.querySelector('.envs-master-column');
    const detailColumn = container.querySelector('.envs-detail-column');
    const detailCard = container.querySelector('.env-detail-card');
    assert.ok(list && detailColumn && detailCard, 'loaded list and detail are mounted');
    const geometry = (el: Element) => {
      const rect = el.getBoundingClientRect();
      return { y: rect.y, height: rect.height };
    };
    // jsdom has no layout engine; use stable measured boxes for these mounted
    // columns and assert the refresh does not replace or resize their DOM owners.
    const boxes = new Map<Element, { y: number; height: number }>([
      [list, { y: 24, height: 600 }], [detailColumn, { y: 24, height: 600 }], [detailCard, { y: 24, height: 570 }],
    ]);
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
      const box = boxes.get(this);
      return box ? ({ ...box, x: 0, width: 500, top: box.y, left: 0, right: 500, bottom: box.y + box.height, toJSON: () => ({}) } as DOMRect) : originalRect.call(this);
    };
    const initialGeometry = [geometry(list), geometry(detailColumn), geometry(detailCard)];
    (dom.window.document.getElementById('btn-register-host') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const close = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Cancel');
    assert.ok(close, 'registration dialog is open');
    (close as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(listCalls, 2, 'refresh is in flight');
    assert.equal(container.querySelector('.envs-master-column'), list, 'master list remains mounted');
    assert.equal(container.querySelector('.env-detail-card'), detailCard, 'selected detail remains mounted');
    assert.match(container.textContent ?? '', /Stable host/);
    assert.doesNotMatch(container.textContent ?? '', /Updated host/);
    assert.deepEqual([geometry(list), geometry(detailColumn), geometry(detailCard)], initialGeometry,
      'list y and detail y/height stay constant while refresh is pending');

    releaseRefresh([after]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(container.querySelector('.envs-master-column'), list, 'snapshot replaces row data in place');
    assert.equal(container.querySelector('.envs-detail-column'), detailColumn,
      `detail column remains mounted; rendered state: ${(container.textContent ?? '').slice(-400)}`);
    assert.match(container.textContent ?? '', /Updated host/);
    assert.doesNotMatch(container.textContent ?? '', /Stable host/);
    assert.deepEqual([geometry(list), geometry(detailColumn), geometry(container.querySelector('.env-detail-card')!)], initialGeometry,
      'summary text update preserves list/detail geometry');

    dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect;
    app.unmount();
    container.remove();
  } finally {
    dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect;
    await cleanup();
  }
});

test('RegisterHostDialog: dialog width classes compose predictably on sm+ and mobile viewports', async () => {
  const { dom, vite, cleanup } = await setupDom();
  try {
    const { createApp, ref, h } = await import('vue');
    const { default: RegisterHostDialog } = (await vite.ssrLoadModule(
      '/src/modules/environments/components/RegisterHostDialog.vue',
    )) as { default: any };
    const { default: Dialog } = (await vite.ssrLoadModule(
      '/src/primitives/Dialog.vue',
    )) as { default: any };

    const container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);

    // 1. Check RegisterHostDialog width classes
    const isOpen = ref(true);
    const app = createApp({
      setup: () => () => h(RegisterHostDialog, {
        open: isOpen.value,
        service: {
          supportsEvidenceReconciliation: false,
          listEnvironments: async () => [],
          getEnvironment: async () => undefined,
          getBootstrapCommand: () => '',
          requestEnrollment: async () => ({} as any),
          regenerateClaimSecret: async () => ({} as any),
          cancelEnrollment: async () => {},
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
        },
      }),
    });
    app.mount(container);
    await new Promise((r) => setTimeout(r, 60));

    const doc = dom.window.document;
    const dialogEl = doc.querySelector('.register-host-dialog');
    assert.ok(dialogEl, 'RegisterHostDialog element found');

    const classList = Array.from(dialogEl.classList);
    assert.ok(classList.includes('register-host-dialog'), 'includes ceremony marker');
    assert.ok(classList.includes('sm:max-w-2xl'), 'includes sm:max-w-2xl for roomy layout on wide screens');
    assert.equal(classList.includes('sm:max-w-[500px]'), false, 'hardcoded sm:max-w-[500px] does not override wide width');
    assert.ok(classList.includes('w-[calc(100%-2rem)]'), 'responsive full width with margins down to narrow viewports');
    assert.ok(classList.includes('sm:w-full'), 'full width constrained by sm:max-w-2xl on sm+');
    assert.ok(classList.includes('p-4') && classList.includes('sm:p-6'), 'consistent padding rhythm (not p-0)');
    assert.equal(classList.includes('p-0'), false, 'p-0 is removed so header/footer are not flush against edges');

    app.unmount();
    container.innerHTML = '';

    // 2. Check Dialog primitive composition with unscoped max-w-2xl
    const app2 = createApp({
      setup: () => () => h(Dialog, {
        open: true,
        title: 'Custom Width Dialog',
        class: 'max-w-2xl',
      }),
    });
    app2.mount(container);
    await new Promise((r) => setTimeout(r, 60));

    const dialog2El = doc.querySelector('[role="dialog"]');
    assert.ok(dialog2El, 'Dialog with max-w-2xl found');
    const classList2 = Array.from(dialog2El.classList);
    assert.ok(classList2.includes('max-w-2xl'), 'unscoped max-w-2xl applied');
    assert.equal(classList2.includes('sm:max-w-[500px]'), false, 'sm:max-w-[500px] default yielded to caller max-w class');

    app2.unmount();
    container.remove();
  } finally {
    await cleanup();
  }
});

test('RegisterHostDialog: ceremony state resets completely across close and reopen', async () => {
  const { dom, vite, cleanup } = await setupDom();
  try {
    const { createApp, ref, h } = await import('vue');
    const { default: RegisterHostDialog } = (await vite.ssrLoadModule(
      '/src/modules/environments/components/RegisterHostDialog.vue',
    )) as { default: any };

    let currentEnv: any = null;
    const mockService = {
      supportsEvidenceReconciliation: false,
      listEnvironments: async () => (currentEnv ? [currentEnv] : []),
      getEnvironment: async (id: string) => (currentEnv && currentEnv.id === id ? currentEnv : undefined),
      requestEnrollment: async (input: any) => {
        const now = Date.now();
        currentEnv = {
          id: 'enroll-reopen-test',
          displayName: input.displayName,
          platform: input.platform ?? 'macos',
          trafficLight: 'yellow',
          enrollmentStatus: 'pending',
          capabilityPermissions: { processExecution: false },
          requestedCapabilities: ['processExecution'],
          engineReadiness: { codex: 'ready' },
          identityDigest: '',
          claim: { issuedAt: now, expiresAt: now + 60000 },
          decisions: [],
        };
        return {
          enrollment: currentEnv,
          claimSecret: 'secret-to-be-cleared-12345',
          claimExpiresAt: currentEnv.claim.expiresAt,
          bootstrapCommand: `sprout worker enroll localhost:41030 ${currentEnv.id}`,
        };
      },
      approveEnrollment: async (id: string) => {
        currentEnv.enrollmentStatus = 'approved';
        currentEnv.trafficLight = 'green';
      },
      regenerateClaimSecret: async () => ({} as any),
      cancelEnrollment: async () => {},
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
      getBootstrapCommand: (id: string) => `sprout worker enroll localhost:41030 ${id}`,
    };

    const container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);

    const isOpen = ref(true);
    const initialId = ref<string | undefined>(undefined);

    const app = createApp({
      setup: () => () => h(RegisterHostDialog, {
        open: isOpen.value,
        service: mockService,
        initialEnrollmentId: initialId.value,
        'onUpdate:open': (val: boolean) => { isOpen.value = val; },
      }),
    });
    app.mount(container);
    await new Promise((r) => setTimeout(r, 60));

    const doc = dom.window.document;

    // Capture initial instance ID stamp
    const firstInstanceInput = doc.getElementById('register-host-id') as HTMLInputElement;
    assert.ok(firstInstanceInput, 'first instance id input found');
    const firstInstanceId = firstInstanceInput.value;
    assert.match(firstInstanceId, /^env-macos-/);

    // Fill in name and begin registration
    const nameInput = doc.getElementById('register-host-name') as HTMLInputElement;
    nameInput.value = 'Reopen Test Host';
    nameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    const beginBtn = doc.getElementById('btn-submit-registration') as HTMLButtonElement;
    beginBtn.click();
    await new Promise((r) => setTimeout(r, 100));

    // Verify secret and command are visible in active phase
    assert.equal(doc.getElementById('claim-secret-value')?.textContent?.trim(), 'secret-to-be-cleared-12345');
    assert.ok(doc.getElementById('bootstrap-command-text'));

    // Advance to review phase
    currentEnv.identityDigest = 'key-digest-reopen';
    await new Promise((r) => setTimeout(r, 1600));
    assert.match(doc.body.textContent ?? '', /Worker Identity Verified/);

    // Approve enrollment
    const approveBtn = doc.getElementById('btn-approve-enrollment') as HTMLButtonElement;
    approveBtn.click();
    await new Promise((r) => setTimeout(r, 100));
    assert.match(doc.body.textContent ?? '', /Environment Enrolled Successfully/);

    // Close the dialog
    isOpen.value = false;
    await new Promise((r) => setTimeout(r, 80));

    // Reopen without initialEnrollmentId (fresh ceremony)
    isOpen.value = true;
    await new Promise((r) => setTimeout(r, 80));

    // Verify dialog returned to create phase with fresh form
    assert.match(doc.body.textContent ?? '', /Host Display Name/);
    assert.ok(doc.getElementById('btn-submit-registration'), 'Begin Registration button is visible');
    assert.doesNotMatch(doc.body.textContent ?? '', /Environment Enrolled Successfully/, 'approved phase is gone');
    assert.equal(doc.getElementById('claim-secret-value'), null, 'previous claim secret is not visible');
    assert.equal(doc.getElementById('bootstrap-command-text'), null, 'previous bootstrap command is not visible');

    const secondInstanceInput = doc.getElementById('register-host-id') as HTMLInputElement;
    assert.ok(secondInstanceInput);
    const secondInstanceId = secondInstanceInput.value;
    assert.match(secondInstanceId, /^env-macos-/);
    assert.notEqual(secondInstanceId, firstInstanceId, 'reopening creates a fresh instance-id stamp');

    // Wait through polling interval to verify pollStatus does not auto-jump to approved
    await new Promise((r) => setTimeout(r, 1600));
    assert.match(doc.body.textContent ?? '', /Host Display Name/, 'still in create phase after polling tick');
    assert.doesNotMatch(doc.body.textContent ?? '', /Environment Enrolled Successfully/, 'did not jump to approved');

    // Reopen with initialEnrollmentId pointing to the approved enrollment
    initialId.value = 'enroll-reopen-test';
    await new Promise((r) => setTimeout(r, 80));
    assert.match(doc.body.textContent ?? '', /Environment Enrolled Successfully/, 'initialEnrollmentId loads existing approved enrollment');

    app.unmount();
    container.remove();
  } finally {
    await cleanup();
  }
});

test('Ticket #141 (a): only the ceremony offers Cancel Pending Enrollment', async () => {
  const { dom, vite, cleanup } = await setupDom();
  try {
    const { createApp, ref, h } = await import('vue');
    const { default: RegisterHostDialog } = (await vite.ssrLoadModule(
      '/src/modules/environments/components/RegisterHostDialog.vue',
    )) as { default: any };
    const { default: EnvironmentDetail } = (await vite.ssrLoadModule(
      '/src/modules/environments/components/EnvironmentDetail.vue',
    )) as { default: any };
    const { default: EnvironmentMasterCard } = (await vite.ssrLoadModule(
      '/src/modules/environments/components/EnvironmentMasterCard.vue',
    )) as { default: any };

    const now = Date.now();
    const makeEnv = (status: string, overrides: Record<string, unknown> = {}) => ({
      id: `env-${status}`,
      displayName: `Host ${status}`,
      platform: 'macos' as const,
      enrollmentStatus: status as any,
      trafficLight: status === 'approved' ? 'green' as const : 'yellow' as const,
      trafficLightReason: 'Test reason',
      connectionState: 'online' as const,
      connectionAgeSec: 10,
      lastConfirmedTime: '10s ago',
      protocolVersion: 'v2.1',
      protocolCompatibility: 'compatible' as const,
      workSafety: 'clear' as const,
      capabilityPermissions: { processExecution: true },
      engineReadiness: { codex: 'ready' as const },
      probeHistory: [],
      boundWorkspaces: [],
      identityDigest: status === 'approved' ? 'key-approved' : '',
      claim: status === 'pending'
        ? { issuedAt: now, expiresAt: now + 60000 }
        : undefined,
      decisions: status === 'revoked'
        ? [{ kind: 'cancelled', actor: 'operator', at: now, reason: 'Pending enrollment cancelled by operator.' }]
        : [],
      ...overrides,
    });

    const pendingEnv = makeEnv('pending');
    const approvedEnv = makeEnv('approved');
    const revokedEnv = makeEnv('revoked');
    const expiredEnv = makeEnv('pending', {
      id: 'env-expired',
      displayName: 'Host expired',
      identityDigest: '',
      claim: { issuedAt: now - 120000, expiresAt: now - 60000 },
    });
    const archivedEnv = makeEnv('archived');

    // Helper to check button presence in RegisterHostDialog
    async function checkCeremonyCancelBtn(env: any): Promise<boolean> {
      let current = env;
      const mockService = {
        supportsEvidenceReconciliation: false,
        listEnvironments: async () => [current],
        getEnvironment: async () => current,
        getBootstrapCommand: () => '',
        requestEnrollment: async () => ({} as any),
        regenerateClaimSecret: async () => ({} as any),
        cancelEnrollment: async () => {},
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

      const container = dom.window.document.createElement('div');
      dom.window.document.body.appendChild(container);
      const isOpen = ref(true);

      const app = createApp({
        setup: () => () => h(RegisterHostDialog, {
          open: isOpen.value,
          service: mockService,
          initialEnrollmentId: env.id,
        }),
      });
      app.mount(container);
      await new Promise((r) => setTimeout(r, 80));

      const hasBtn = dom.window.document.querySelector('.cancel-enroll-btn') !== null;
      if (env.enrollmentStatus === 'pending') {
        assert.match(dom.window.document.body.textContent ?? '', /Expires at:/, 'pending ceremony keeps claim expiry visible');
      }
      app.unmount();
      container.remove();
      return hasBtn;
    }

    // Helper to check button presence in EnvironmentDetail
    async function checkDetailCancelBtn(env: any): Promise<boolean> {
      const container = dom.window.document.createElement('div');
      dom.window.document.body.appendChild(container);

      const app = createApp({
        setup: () => () => h(EnvironmentDetail, {
          env,
          disabled: false,
        }),
      });
      app.mount(container);
      await new Promise((r) => setTimeout(r, 60));

      const hasBtn = dom.window.document.querySelector('.cancel-enroll-btn') !== null;
      app.unmount();
      container.remove();
      return hasBtn;
    }

    // Helper to check button presence in EnvironmentMasterCard
    async function checkMasterCardCancelBtn(env: any): Promise<boolean> {
      const container = dom.window.document.createElement('div');
      dom.window.document.body.appendChild(container);

      const app = createApp({
        setup: () => () => h(EnvironmentMasterCard, {
          env,
          disabled: false,
          canControl: true,
        }),
      });
      app.mount(container);
      await new Promise((r) => setTimeout(r, 60));

      const hasBtn = dom.window.document.querySelector('.cancel-enroll-btn') !== null;
      app.unmount();
      container.remove();
      return hasBtn;
    }

    // 1. Ceremony context checks
    assert.equal(await checkCeremonyCancelBtn(pendingEnv), true, 'ceremony: pending shows cancel button');
    assert.equal(await checkCeremonyCancelBtn(approvedEnv), false, 'ceremony: approved hides cancel button');
    assert.equal(await checkCeremonyCancelBtn(revokedEnv), false, 'ceremony: revoked hides cancel button');
    assert.equal(await checkCeremonyCancelBtn(expiredEnv), true, 'ceremony: pending with expired claim still shows cancel button');
    assert.equal(await checkCeremonyCancelBtn(archivedEnv), false, 'ceremony: archived hides cancel button');

    // The ceremony is the sole decision surface; list/detail must not duplicate its action.
    assert.equal(await checkDetailCancelBtn(pendingEnv), false, 'detail: pending has no cancel button');
    assert.equal(await checkDetailCancelBtn(approvedEnv), false, 'detail: approved hides cancel button');
    assert.equal(await checkDetailCancelBtn(revokedEnv), false, 'detail: revoked hides cancel button');
    assert.equal(await checkDetailCancelBtn(expiredEnv), false, 'detail: expired hides cancel button');
    assert.equal(await checkDetailCancelBtn(archivedEnv), false, 'detail: archived hides cancel button');

    assert.equal(await checkMasterCardCancelBtn(pendingEnv), false, 'master card: pending has no cancel button');
    assert.equal(await checkMasterCardCancelBtn(approvedEnv), false, 'master-list: approved hides cancel button');
    assert.equal(await checkMasterCardCancelBtn(revokedEnv), false, 'master-list: revoked hides cancel button');
    assert.equal(await checkMasterCardCancelBtn(expiredEnv), false, 'master-list: expired hides cancel button');
    assert.equal(await checkMasterCardCancelBtn(archivedEnv), false, 'master-list: archived hides cancel button');
  } finally {
    await cleanup();
  }
});

test('Ticket #151: pending enrollment has a neutral status in card and detail, distinct from degraded attention', async () => {
  const { dom, vite, cleanup } = await setupDom();
  try {
    const { createApp, h } = await import('vue');
    const { default: EnvironmentDetail } = (await vite.ssrLoadModule(
      '/src/modules/environments/components/EnvironmentDetail.vue',
    )) as { default: any };
    const { default: EnvironmentMasterCard } = (await vite.ssrLoadModule(
      '/src/modules/environments/components/EnvironmentMasterCard.vue',
    )) as { default: any };

    const makeEnv = (id: string, enrollmentStatus: string) => ({
      id,
      displayName: id,
      platform: 'macos' as const,
      enrollmentStatus,
      trafficLight: 'yellow' as const,
      trafficLightReason: 'Test readiness reason',
      connectionState: 'online' as const,
      connectionAgeSec: 10,
      protocolVersion: 'v2.1',
      protocolCompatibility: 'compatible' as const,
      workSafety: 'clear' as const,
      capabilityPermissions: {},
      engineReadiness: {},
      probeHistory: [],
      boundWorkspaces: [],
      decisions: [],
    });
    const pending = makeEnv('Pending host', 'pending');
    const degraded = makeEnv('Degraded host', 'approved');

    const mount = (component: any, env: any) => {
      const container = dom.window.document.createElement('div');
      dom.window.document.body.appendChild(container);
      const app = createApp({ setup: () => () => h(component, { env }) });
      app.mount(container);
      return { app, container };
    };

    const pendingCard = mount(EnvironmentMasterCard, pending);
    const degradedCard = mount(EnvironmentMasterCard, degraded);
    const pendingDetail = mount(EnvironmentDetail, pending);
    const degradedDetail = mount(EnvironmentDetail, degraded);

    const cardPill = pendingCard.container.querySelector('.pending-enrollment-pill');
    assert.ok(cardPill, 'pending master card displays its status pill');
    assert.match(cardPill.textContent ?? '', /PENDING/);
    assert.doesNotMatch(cardPill.textContent ?? '', /ATTENTION/);
    assert.equal(degradedCard.container.querySelector('.pending-enrollment-pill'), null, 'degraded enrolled card has no pending pill');
    assert.equal(degradedCard.container.querySelector('[aria-label="ATTENTION"]') !== null, true, 'degraded enrolled card retains yellow attention dot');

    assert.ok(pendingDetail.container.querySelector('.pending-enrollment-pill'), 'detail header displays pending pill');
    assert.match(pendingDetail.container.querySelector('.env-traffic-light-banner strong')?.textContent ?? '', /Enrollment Pending/);
    assert.equal(degradedDetail.container.querySelector('.pending-enrollment-pill'), null, 'degraded detail has no pending pill');
    assert.match(degradedDetail.container.querySelector('.env-traffic-light-banner strong')?.textContent ?? '', /Attention \/ Degraded/);

    for (const mounted of [pendingCard, degradedCard, pendingDetail, degradedDetail]) {
      mounted.app.unmount();
      mounted.container.remove();
    }
  } finally {
    await cleanup();
  }
});

test('Ticket #149: an expired pending claim remains cancellable and refreshes to revoked', async () => {
  const { dom, vite, cleanup } = await setupDom();
  try {
    const { createApp, ref, h } = await import('vue');
    const { default: RegisterHostDialog } = (await vite.ssrLoadModule(
      '/src/modules/environments/components/RegisterHostDialog.vue',
    )) as { default: any };

    const now = Date.now();
    let currentEnv: any = {
      id: 'enroll-expired-cancel',
      displayName: 'Expired Claim Host',
      platform: 'macos',
      enrollmentStatus: 'pending',
      trafficLight: 'yellow',
      trafficLightReason: 'Enrollment claim expired',
      connectionState: 'never_connected',
      connectionAgeSec: 0,
      lastConfirmedTime: 'never',
      protocolVersion: 'v2.1',
      protocolCompatibility: 'compatible',
      workSafety: 'clear',
      capabilityPermissions: { processExecution: false },
      engineReadiness: { codex: 'ready' },
      probeHistory: [],
      boundWorkspaces: [],
      identityDigest: '',
      claim: { issuedAt: now - 120000, expiresAt: now - 60000 },
      decisions: [],
    };
    let cancelCalls = 0;
    let refreshCalls = 0;
    const mockService = {
      supportsEvidenceReconciliation: false,
      listEnvironments: async () => [currentEnv],
      getEnvironment: async () => { refreshCalls += 1; return currentEnv; },
      getBootstrapCommand: () => '',
      requestEnrollment: async () => ({} as any),
      regenerateClaimSecret: async () => ({} as any),
      cancelEnrollment: async () => {
        cancelCalls += 1;
        currentEnv = {
          ...currentEnv,
          enrollmentStatus: 'revoked',
          trafficLight: 'red',
          trafficLightReason: 'Pending enrollment cancelled by operator',
          claim: undefined,
          decisions: [{ kind: 'cancelled', actor: 'operator', at: Date.now(), reason: 'Cancelled by operator' }],
        };
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
    const container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);
    const app = createApp({
      setup: () => () => h(RegisterHostDialog, {
        open: true,
        service: mockService,
        initialEnrollmentId: currentEnv.id,
      }),
    });
    app.mount(container);
    await new Promise((r) => setTimeout(r, 80));

    const doc = dom.window.document;
    assert.match(doc.body.textContent ?? '', /Enrollment Claim Expired/);
    const cancelBtn = doc.querySelector('.cancel-enroll-btn') as HTMLButtonElement | null;
    assert.ok(cancelBtn, 'expired pending claim still exposes cancellation in the ceremony');
    const initialRefreshCalls = refreshCalls;
    cancelBtn.click();
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(cancelCalls, 1, 'server cancellation is requested');
    assert.ok(refreshCalls > initialRefreshCalls, 'ceremony refreshes facts after cancellation');
    assert.equal(currentEnv.enrollmentStatus, 'revoked');
    assert.equal(doc.querySelector('.cancel-enroll-btn'), null, 'cancel control disappears after refreshed revoked state');
    assert.match(doc.body.textContent ?? '', /Pending enrollment has been cancelled by operator/);

    app.unmount();
    container.remove();
  } finally {
    await cleanup();
  }
});

test('Ticket #147: detail and master card do not expose duplicate pending cancellation controls', async () => {
  const { dom, vite, cleanup } = await setupDom();
  try {
    const { createApp, h } = await import('vue');
    const { default: EnvironmentDetail } = (await vite.ssrLoadModule(
      '/src/modules/environments/components/EnvironmentDetail.vue',
    )) as { default: any };
    const { default: EnvironmentMasterCard } = (await vite.ssrLoadModule(
      '/src/modules/environments/components/EnvironmentMasterCard.vue',
    )) as { default: any };

    const now = Date.now();
    const expiringEnv = {
      id: 'env-expiring-clock-test',
      displayName: 'Expiring Host',
      platform: 'macos' as const,
      enrollmentStatus: 'pending' as const,
      trafficLight: 'yellow' as const,
      trafficLightReason: 'Pending worker claim',
      connectionState: 'online' as const,
      connectionAgeSec: 5,
      lastConfirmedTime: '5s ago',
      protocolVersion: 'v2.1',
      protocolCompatibility: 'compatible' as const,
      workSafety: 'clear' as const,
      capabilityPermissions: { processExecution: true },
      engineReadiness: { codex: 'ready' as const },
      probeHistory: [],
      boundWorkspaces: [],
      identityDigest: '',
      claim: { issuedAt: now - 5000, expiresAt: now + 70 },
      decisions: [],
    };

    const containerDetail = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(containerDetail);
    const appDetail = createApp({
      setup: () => () => h(EnvironmentDetail, { env: expiringEnv, disabled: false }),
    });
    appDetail.mount(containerDetail);

    const containerCard = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(containerCard);
    const appCard = createApp({
      setup: () => () => h(EnvironmentMasterCard, { env: expiringEnv, disabled: false, canControl: true }),
    });
    appCard.mount(containerCard);

    assert.equal(containerDetail.querySelector('.cancel-enroll-btn'), null, 'detail never offers cancellation');
    assert.equal(containerCard.querySelector('.cancel-enroll-btn'), null, 'master card never offers cancellation');

    appDetail.unmount();
    containerDetail.remove();
    appCard.unmount();
    containerCard.remove();
  } finally {
    await cleanup();
  }
});

test('Ticket #141 (b): stale cancel click in ceremony surfaces typed 409 refusal and refreshes facts from server', async () => {
  const { dom, vite, cleanup } = await setupDom();
  try {
    const { createApp, ref, h } = await import('vue');
    const { default: RegisterHostDialog } = (await vite.ssrLoadModule(
      '/src/modules/environments/components/RegisterHostDialog.vue',
    )) as { default: any };

    const now = Date.now();
    let currentEnv: any = {
      id: 'enroll-stale-ceremony',
      displayName: 'Stale Ceremony Host',
      platform: 'macos',
      enrollmentStatus: 'pending',
      trafficLight: 'yellow',
      trafficLightReason: 'Pending worker claim',
      connectionState: 'never_connected',
      connectionAgeSec: 0,
      lastConfirmedTime: 'never',
      protocolVersion: 'v2.1',
      protocolCompatibility: 'compatible',
      workSafety: 'clear',
      capabilityPermissions: { processExecution: false },
      engineReadiness: { codex: 'ready' },
      probeHistory: [],
      boundWorkspaces: [],
      identityDigest: '',
      claim: { issuedAt: now, expiresAt: now + 60000 },
      decisions: [],
    };

    let getEnvironmentCallCount = 0;
    const mockService = {
      supportsEvidenceReconciliation: false,
      listEnvironments: async () => [currentEnv],
      getEnvironment: async (id: string) => {
        getEnvironmentCallCount += 1;
        return currentEnv;
      },
      getBootstrapCommand: () => '',
      requestEnrollment: async () => ({} as any),
      regenerateClaimSecret: async () => ({} as any),
      cancelEnrollment: async (_id: string) => {
        // Mutate currentEnv to simulate concurrent state change on the server
        currentEnv = {
          ...currentEnv,
          enrollmentStatus: 'revoked',
          trafficLight: 'red',
          trafficLightReason: 'Pending enrollment cancelled by operator',
          claim: undefined,
          decisions: [{
            kind: 'cancelled',
            actor: 'operator',
            at: Date.now(),
            reason: 'Cancelled by operator',
          }],
        };
        const error = new Error('Only a pending enrollment can be cancelled.');
        (error as any).code = 'not-pending';
        (error as any).status = 409;
        (error as any).refusal = 'Only a pending enrollment can be cancelled.';
        throw error;
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

    const container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);
    const isOpen = ref(true);
    let updatedId = '';

    const app = createApp({
      setup: () => () => h(RegisterHostDialog, {
        open: isOpen.value,
        service: mockService,
        initialEnrollmentId: currentEnv.id,
        onUpdated: (id: string) => { updatedId = id; },
      }),
    });
    app.mount(container);
    await new Promise((r) => setTimeout(r, 80));

    const doc = dom.window.document;
    const cancelBtn = doc.querySelector('.cancel-enroll-btn') as HTMLButtonElement;
    assert.ok(cancelBtn, 'Cancel Pending Enrollment button rendered before click');

    const initialGetEnvCount = getEnvironmentCallCount;

    // Click cancel button on stale enrollment
    cancelBtn.click();
    await new Promise((r) => setTimeout(r, 100));

    // Verify facts were refreshed from server
    assert.ok(getEnvironmentCallCount > initialGetEnvCount, 'facts were refreshed via getEnvironment');
    assert.equal(updatedId, 'enroll-stale-ceremony', 'updated event was emitted');

    // Verify refusal notice is surfaced
    const bodyText = doc.body.textContent ?? '';
    assert.match(bodyText, /not-pending/, 'refusal code not-pending is rendered');
    assert.match(bodyText, /Only a pending enrollment can be cancelled|no longer pending/i, 'refusal explanation is rendered');
    assert.equal(bodyText.includes('409'), false, 'raw 409 status code is not shown');

    // Verify cancel button is gone and cancelled state is rendered
    assert.equal(doc.querySelector('.cancel-enroll-btn'), null, 'Cancel Pending Enrollment button is hidden after refresh');
    assert.match(bodyText, /Pending enrollment has been cancelled by operator/);

    app.unmount();
    container.remove();
  } finally {
    await cleanup();
  }
});
