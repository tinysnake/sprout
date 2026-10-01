import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { TaskView, TaskWithRunsView } from '../../../../src/web/views.ts';
import type { TaskProposal } from '../../../../src/task/proposal-model.ts';
import { BrowserRequestError } from '../../transport/browser-transport.ts';
import type { TaskBlockerInput, TaskBrowserAdapter } from '../../adapters/task-api.ts';
import type { ProjectManagementService, ProjectOverviewData } from '../projects/types.ts';
import { createShellConnectionController } from '../../shell/connection.ts';

const GLOBALS = [
  'HTMLElement', 'HTMLButtonElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement',
  'SVGElement', 'Element', 'Document', 'DocumentFragment', 'location', 'history', 'localStorage', 'navigator',
  'getComputedStyle', 'Node', 'NodeFilter', 'Event', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'FocusEvent',
  'TouchEvent', 'CustomEvent',
] as const;

async function setupHarness() {
  const html = await readFile(`${process.cwd()}/web/app/index.html`, 'utf8');
  const dom = new JSDOM(html, { url: 'http://sprout-operator.test/app/project/tasks', pretendToBeVisual: true });
  (dom.window as unknown as Record<string, unknown>).__SPROUT_TEST_MANUAL_MOUNT__ = true;
  const values: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 10),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  };
  for (const key of GLOBALS) values[key] = (dom.window as unknown as Record<string, unknown>)[key];
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const [{ createServer }, { default: vuePlugin }] = await Promise.all([import('vite'), import('@vitejs/plugin-vue')]);
  const vite = await createServer({
    root: `${process.cwd()}/web`, appType: 'custom', logLevel: 'error',
    plugins: [{ name: 'force-client-vue', enforce: 'pre', transform(_code, _id, options) { if (options) options.ssr = false; } }, vuePlugin()],
    server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true },
  });
  const mount = dom.window.document.querySelector('#app');
  assert.ok(mount);
  return {
    dom,
    doc: dom.window.document,
    vite,
    mount: (app: { mount: (element: Element) => unknown }) => app.mount(mount),
    async cleanup() {
      await vite.close();
      for (const [key, descriptor] of originals) {
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
        else Object.defineProperty(globalThis, key, descriptor);
      }
      dom.window.close();
    },
  };
}

const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
const time = 1_800_000_100_000;
const projectId = 'project-tasks-test';
const project = {
  id: projectId,
  displayName: 'Task Test Project',
  status: 'active',
  content: { currentVersion: 1, versions: [{ version: 1, memberships: [
    { memberId: 'operator', memberKind: 'human', startedAt: time, responsibilities: [], collaborationInstructions: '' },
    { memberId: 'agent-a', memberKind: 'agent', startedAt: time, responsibilities: [], collaborationInstructions: '' },
  ] }] },
};
const overview = {
  project,
  agents: [{ id: 'agent-a', displayName: 'Project Agent', status: 'active' }],
  environments: [{ id: 'env-a', environmentInstanceId: 'instance-a', displayName: 'Ready Environment', enrollmentStatus: 'approved', trafficLight: 'green', workSafety: 'clear' }],
  access: [{ projectId, environmentInstanceId: 'instance-a', status: 'active', startedAt: time, updatedAt: time, current: { bindingId: 'binding-a', workspaceId: 'workspace-a', kind: 'default', boundAt: time }, history: [] }],
  compatibility: [{ agentId: 'agent-a', environmentInstanceId: 'instance-a', available: true }],
} as unknown as ProjectOverviewData;

function task(id: string, state: string, changes: Partial<TaskView> = {}): TaskView {
  return {
    id, projectId, title: id, goal: `Goal for ${id}`, constraints: [], status: 'in-progress',
    admission: { proposalId: 'proposal-a', proposalRevision: 1, contentVersion: 1, validationCriteria: ['Evidence is recorded.'], lead: { memberId: 'agent-a', memberKind: 'agent' }, contextAgentId: 'agent-a', approvedBy: { memberId: 'operator', memberKind: 'human' }, approvedAt: time, approvalReason: 'Approved for bounded work.' },
    environmentInstanceId: 'instance-a', environmentLeaseId: `lease-${id}`, environmentLifecycleState: state,
    taskContextState: state === 'recovery' ? 'recovery-retained' : state === 'ending' ? 'cleanup-in-progress' : 'ready',
    createdAt: time, updatedAt: time,
    ...changes,
  };
}

function taskDetail(value: TaskView, runs: TaskWithRunsView['runs'] = []): TaskWithRunsView {
  return { task: value, runs };
}

const proposal: TaskProposal = {
  id: 'proposal-a', projectId, proposer: { memberId: 'operator', memberKind: 'human' }, origin: null,
  status: 'proposed', revision: 1, currentContentVersion: 1,
  versions: [{ version: 1, actor: { memberId: 'operator', memberKind: 'human' }, at: time, reason: 'Proposed by Human.', title: 'Proposed Task', goal: 'Validate the Task operating path.', constraints: ['Keep changes bounded.'], validationCriteria: ['Evidence remains inspectable.'] }],
  lifecycle: [], createdAt: time, updatedAt: time,
};

function appServices(conflictCodes: readonly string[] = []) {
  const idle = task('run-idle', 'idle');
  const humanLedIdle = { ...idle, admission: { ...idle.admission!, lead: { memberId: 'operator', memberKind: 'human' as const } } };
  const humanLedRunning = task('run-running', 'running', { activeRunId: 'run-private', status: 'in-progress' });
  const humanLedRunningWithLead = { ...humanLedRunning, admission: { ...humanLedRunning.admission!, lead: { memberId: 'operator', memberKind: 'human' as const } } };
  const allTasks = [
    humanLedRunningWithLead,
    humanLedIdle,
    task('run-not-owned', 'running', { activeRunId: 'run-human-initiated', status: 'in-progress' }),
    task('pause-requested', 'running', { activeRunId: 'run-pausing', pauseState: 'requested' }),
    task('paused', 'idle', { pauseState: 'paused' }),
    task('blocked', 'blocked', { status: 'blocked', blocker: { reason: 'External approval is pending.', requiredAction: 'Record approval.', responsible: { kind: 'external-condition', condition: 'Approval arrives.' }, nextAdvancer: { memberId: 'agent-a', memberKind: 'agent' }, createdBy: { memberId: 'operator', memberKind: 'human' }, createdAt: time } }),
    task('awaiting-validation', 'awaiting-validation', { pendingCompletionClaimId: 'claim-a', completionClaims: [{ id: 'claim-a', contentVersion: 1, actor: { memberId: 'agent-a', memberKind: 'agent' }, at: time, outcomeSummary: 'The validation path is ready.', validationEvidence: ['Acceptance evidence is available.'], durableChanges: ['Task page rendered.'], limitations: [], recommendedDisposition: 'complete' }] }),
    task('ending', 'ending', { endDisposition: 'completed' }),
    task('recovery', 'recovery', { recoveryState: 'idle' }),
    task('completed', 'ended', { status: 'done', endDisposition: 'completed' }),
    task('cancelled', 'discarded', { status: 'cancelled', endDisposition: 'cancelled' }),
  ];
  const details = new Map(allTasks.map((entry) => [entry.id, taskDetail(entry,
    entry.activeRunId ? [{ runId: entry.activeRunId, agentId: 'agent-a', sequence: 1, linkedAt: time, contentVersion: 1,
      actor: entry.id === 'run-running' ? { memberId: 'operator', memberKind: 'human' as const }
        : entry.id === 'run-not-owned' ? { memberId: 'operator', memberKind: 'human' as const }
          : { memberId: 'agent-a', memberKind: 'agent' as const } }] : entry.id === 'completed'
      ? [{ runId: 'run-settled', agentId: 'agent-a', sequence: 1, linkedAt: time, contentVersion: 1, summary: { status: 'completed', summary: 'PRIVATE-RUN-SUMMARY', recordedAt: time } }]
      : [],
  )]));
  let nextConflict = 0;
  const calls: string[] = [];
  const blockerCalls: TaskBlockerInput[] = [];
  const api = {
    state: () => ({ status: 'online', connection: 'online', loading: false }),
    subscribeState: () => () => undefined,
    async listProposals() { return [proposal]; },
    async getProposal() { return proposal; },
    async getContentVersion(id: string, version: number) { calls.push(`content-version:${id}:${version}`); return proposal.versions[0]!; },
    async validateProposal(_id: string, content: unknown) { calls.push('validate-proposal'); return content; },
    async propose() { calls.push('propose'); return proposal; },
    async reviseProposal() { calls.push('revise-proposal'); return proposal; },
    async withdrawProposal() { calls.push('withdraw-proposal'); return proposal; },
    async rejectProposal() { calls.push('reject-proposal'); return proposal; },
    async beginProposal() { calls.push('begin'); return { task: allTasks[0]!, duplicate: false }; },
    async listTasks() { return allTasks; },
    async getTask(id: string) {
      const detail = details.get(id);
      if (!detail) throw new Error('Task not found.');
      return detail;
    },
    async advance(id: string) {
      calls.push(`advance:${id}`);
      const code = conflictCodes[nextConflict++];
      if (code) throw new BrowserRequestError('rejected', 409, { code, message: 'server conflict' });
      return { task: allTasks.find((entry) => entry.id === id)!, runId: 'run-next', advance: { runId: 'run-next', agentId: 'agent-a', sequence: 2, linkedAt: time } };
    },
    async reviseTaskContent() { calls.push('revise-content'); return allTasks[1]!; },
    async pause(id: string) { calls.push(`pause:${id}`); return allTasks[0]!; },
    async interrupt(id: string) { calls.push(`interrupt:${id}`); return allTasks[0]!; },
    async stopSubordinate(id: string, input: { runId: string }) {
      calls.push(`stop-subordinate:${id}:${input.runId}`);
      const detail = details.get(id);
      assert.ok(detail);
      const { activeRunId: _activeRunId, ...rest } = detail.task;
      const updatedTask: TaskView = { ...rest, environmentLifecycleState: 'idle' };
      details.set(id, taskDetail(updatedTask, detail.runs.map((run) => run.runId === input.runId
        ? { ...run, summary: { status: 'stopped', summary: 'Stopped', recordedAt: time } }
        : run)));
      return updatedTask;
    },
    async resume(id: string) { calls.push(`resume:${id}`); return allTasks[0]!; },
    async raiseBlocker(id: string, input: TaskBlockerInput) {
      calls.push('raise-blocker');
      blockerCalls.push(input);
      const detail = details.get(id);
      assert.ok(detail);
      const updatedTask: TaskView = {
        ...detail.task, status: 'blocked', environmentLifecycleState: 'blocked',
        blocker: { ...input, createdBy: { memberId: 'operator', memberKind: 'human' }, createdAt: time },
      };
      details.set(id, taskDetail(updatedTask, detail.runs));
      return updatedTask;
    },
    async clearBlocker(id: string) {
      calls.push('clear-blocker');
      const detail = details.get(id);
      assert.ok(detail);
      const { blocker: _blocker, ...rest } = detail.task;
      const updatedTask: TaskView = { ...rest, status: 'in-progress', environmentLifecycleState: 'idle' };
      details.set(id, taskDetail(updatedTask, detail.runs));
      return updatedTask;
    },
    async submitCompletionClaim(id: string) { calls.push(`completion-claim:${id}`); return allTasks[1]!; },
    async validate(id: string, input: { decision: string }) { calls.push(`validate:${id}:${input.decision}`); return allTasks[1]!; },
    async end(id: string) { calls.push(`end:${id}`); return allTasks[1]!; },
    async discard(id: string) { calls.push(`discard:${id}`); return allTasks[1]!; },
    async recover(id: string, input: { action: string }) { calls.push(`recover:${id}:${input.action}`); return allTasks[1]!; },
  } as unknown as TaskBrowserAdapter;
  const projects = {
    async listProjects() { return [project]; },
    async loadOverview() { return overview; },
  } as unknown as ProjectManagementService;
  return { api, projects, allTasks, calls, blockerCalls };
}

async function mountTasks(vite: { ssrLoadModule: (path: string) => Promise<unknown> }, doc: Document, codes: readonly string[] = []) {
  const { createSproutApp } = await vite.ssrLoadModule('/src/app/main.ts') as typeof import('../../app/main.ts');
  const { api, projects, calls, blockerCalls } = appServices(codes);
  const connectionSource = createShellConnectionController({ status: 'online', connection: 'online', loading: false });
  const { app, router } = createSproutApp({ routerBase: '/app/', taskService: api, projectService: projects, connectionSource });
  await router.push(`/project/tasks?project=${projectId}`);
  await router.isReady();
  app.mount(doc.querySelector('#app')!);
  await settle();
  return { app, router, calls, blockerCalls };
}

async function enterField(doc: Document, dom: JSDOM, labelText: string, value: string): Promise<void> {
  const field = [...doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')]
    .find((element) => element.closest('label')?.textContent?.includes(labelText));
  assert.ok(field, `field labelled ${labelText} exists; rendered text: ${doc.body.textContent ?? ''}`);
  field.value = value;
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await settle(30);
}

function selectOption(doc: Document, dom: JSDOM, id: string, value: string): HTMLSelectElement {
  const field = doc.querySelector<HTMLSelectElement>(`#${id}`);
  assert.ok(field, `select #${id} exists`);
  field.value = value;
  field.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  return field;
}

function clickButton(doc: Document, text: string): HTMLButtonElement {
  const button = [...doc.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.includes(text));
  assert.ok(button, `button ${text} exists`);
  assert.equal(button.disabled, false, `button ${text} is available in this Task state`);
  button.click();
  return button;
}

test('Project Tasks renders distinct production lifecycle states and withholds run summaries', async () => {
  const { doc, vite, mount, cleanup } = await setupHarness();
  try {
    const { app, router, calls } = await mountTasks(vite, doc);
    const text = doc.body.textContent ?? '';
    for (const state of ['Proposed', 'Active · run running', 'Active · run idle', 'Task pause requested', 'Paused', 'Blocked', 'Awaiting validation', 'Ending', 'Recovery', 'Completed', 'Cancelled']) {
      assert.ok(text.includes(state), `renders ${state}`);
    }
    assert.match(text, /No Environment lease/);
    assert.equal(doc.querySelector('main main'), null, 'Task details do not nest the Shell main landmark');

    doc.querySelector<HTMLButtonElement>('[data-record-kind="task"][data-record-id="run-running"]')?.click();
    await settle();
    assert.match(doc.body.textContent ?? '', /Run timeline/);
    assert.match(doc.body.textContent ?? '', /Curated run facts only/);
    assert.doesNotMatch(doc.body.textContent ?? '', /PRIVATE-RUN-PROMPT|PRIVATE-RUN-EVENT|PRIVATE-RUN-SUMMARY/);
    assert.ok(doc.querySelector('#advance-target-agent') === null, 'a running Task cannot admit another run');
    doc.querySelector<HTMLButtonElement>('[data-record-kind="task"][data-record-id="completed"]')?.click();
    await settle();
    assert.match(doc.body.textContent ?? '', /Run timeline/);
    assert.doesNotMatch(doc.body.textContent ?? '', /PRIVATE-RUN-SUMMARY/, 'settled run summaries stay outside the Task page');

    await router.push({ name: 'project-task-proposal', params: { proposalId: 'proposal-a' }, query: { project: projectId } });
    await settle();
    assert.match(doc.body.textContent ?? '', /Human authorization/);
    assert.match(doc.body.textContent ?? '', /Approve & Begin/);
    assert.match(doc.body.textContent ?? '', /No Agent run · No Environment lease/);
    assert.ok(calls.includes('content-version:proposal-a:1'), 'proposal detail loads the current content through the version endpoint');
    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Project Tasks creates proposals through validation and the production adapter', async () => {
  const { dom, doc, vite, cleanup } = await setupHarness();
  try {
    const { app, calls } = await mountTasks(vite, doc);
    clickButton(doc, 'Propose Task');
    await settle();
    assert.match(doc.querySelector('[data-testid="shell-announcer"]')?.textContent ?? '', /Task proposal form opened/);
    assert.equal(doc.activeElement?.textContent, 'Propose a Task', 'opening the form moves focus to its heading');
    assert.match(doc.body.textContent ?? '', /Human approval is required before begin/);
    await enterField(doc, dom, 'Title', 'New proposed work');
    await enterField(doc, dom, 'Goal', 'Record a bounded proposal.');
    clickButton(doc, 'Save proposal');
    await settle(180);
    assert.ok(calls.includes('validate-proposal') && calls.includes('propose'), 'proposal creation validates before persistence');
    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Project Tasks presents typed 409 conflicts with actionable guidance', async () => {
  const codes = [
    'advance-conflict', 'environment-recovering', 'lifecycle-conflict', 'pause-retry-required',
    'stale-proposal', 'project-read-only', 'agent-read-only', 'proposal-closed', 'lead-ineligible', 'environment-ineligible',
    'no-compatible-agent', 'target-ineligible', 'not-awaiting-recovery', 'lease-cannot-resume',
  ];
  const { dom, doc, vite, cleanup } = await setupHarness();
  try {
    const { app } = await mountTasks(vite, doc, codes);
    doc.querySelector<HTMLButtonElement>('[data-record-kind="task"][data-record-id="run-idle"]')?.click();
    await settle();
    const select = doc.querySelector<HTMLSelectElement>('#advance-target-agent');
    assert.ok(select);
    select.value = 'agent-a';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const reason = [...doc.querySelectorAll<HTMLInputElement>('input')].find((input) => input.parentElement?.textContent?.includes('Reason for this action'));
    assert.ok(reason);
    reason.value = 'Continue the approved work.';
    reason.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await settle();
    assert.equal(select.value, 'agent-a');
    assert.equal(reason.value, 'Continue the approved work.');
    const initialAdvance = [...doc.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Advance Task lead work'));
    assert.ok(initialAdvance);
    assert.equal(initialAdvance.disabled, false, 'the selected Project Agent and reason enable Task advance');
    const expectedMessages = [
      /Another Task action changed this Task/,
      /Environment is recovering/,
      /This Task changed before the action completed/,
      /Task advancement is still gated.*Human must retry or cancel the pause request/i,
      /proposal changed before the decision completed/,
      /Project is read-only/,
      /Agent no longer has writable Project access/,
      /proposal is no longer open/,
      /Task lead is no longer eligible/,
      /Environment is no longer available/,
      /No current Project Agent/,
      /selected Agent is no longer eligible/,
      /no longer awaiting recovery/,
      /lease could not be resumed/,
    ];
    for (let index = 0; index < codes.length; index += 1) {
      const advance = [...doc.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Advance Task lead work'));
      assert.ok(advance);
      advance.click();
      await settle(160);
      const alert = doc.querySelector<HTMLElement>('[role="alert"][data-conflict-code]');
      assert.equal(alert?.dataset['conflictCode'], codes[index], doc.body.textContent ?? 'Task page did not render an action state.');
      assert.match(alert?.textContent ?? '', expectedMessages[index]!);
    }
    app.unmount();
  } finally {
    await cleanup();
  }
});

async function openTaskRecord(router: { push: (location: unknown) => Promise<unknown> }, id: string): Promise<void> {
  await router.push({ name: 'project-task-detail', params: { taskId: id }, query: { project: projectId } });
  await settle();
}

test('Project Tasks confirms a Task lead stop only for a run attributed to that lead', async () => {
  const { dom, doc, vite, cleanup } = await setupHarness();
  try {
    const { app, router, calls } = await mountTasks(vite, doc);
    await openTaskRecord(router, 'run-running');
    await enterField(doc, dom, 'Reason for this action', 'Stop the delegated run after review.');
    clickButton(doc, 'Stop run');
    await settle();
    assert.match(doc.body.textContent ?? '', /The Task and its Environment lease stay active/);
    clickButton(doc, 'Confirm stop run');
    await settle(180);
    assert.ok(calls.includes('stop-subordinate:run-running:run-private'));
    assert.match(doc.body.textContent ?? '', /Run 1 · stopped/);

    await openTaskRecord(router, 'run-not-owned');
    assert.equal(doc.querySelector('[data-action="stop-subordinate"]'), null,
      'a run initiated by someone other than the Task lead has no stop control');
    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Project Tasks creates and renders each blocker responsibility kind', async () => {
  const { dom, doc, vite, cleanup } = await setupHarness();
  try {
    const { app, router, blockerCalls } = await mountTasks(vite, doc);
    const cases = [
      { kind: 'human', member: JSON.stringify({ memberId: 'operator', memberKind: 'human' }), responsible: { kind: 'human', memberId: 'operator' }, rendered: 'Responsible: You' },
      { kind: 'agent', member: JSON.stringify({ memberId: 'agent-a', memberKind: 'agent' }), responsible: { kind: 'agent', memberId: 'agent-a' }, rendered: 'Responsible: Project Agent' },
      { kind: 'recovery', value: 'Environment cleanup worker', responsible: { kind: 'recovery', mechanism: 'Environment cleanup worker' }, rendered: 'Responsible: Recovery mechanism · Environment cleanup worker' },
      { kind: 'external-condition', value: 'Approval arrives', responsible: { kind: 'external-condition', condition: 'Approval arrives' }, rendered: 'Responsible: External condition · Approval arrives' },
    ];
    for (const [index, entry] of cases.entries()) {
      await openTaskRecord(router, 'run-idle');
      clickButton(doc, 'Record blocker');
      await settle();
      await enterField(doc, dom, 'Blocker reason', `Waiting for responsibility case ${index}.`);
      await enterField(doc, dom, 'Required next action', 'Complete the named action.');
      selectOption(doc, dom, 'blocker-responsible-kind', entry.kind);
      await settle();
      if ('member' in entry) selectOption(doc, dom, 'blocker-responsible-member', entry.member);
      else await enterField(doc, dom, entry.kind === 'recovery' ? 'Recovery mechanism' : 'External condition', entry.value);
      await settle();
      clickButton(doc, 'Save blocker');
      await settle(180);
      assert.deepEqual(blockerCalls.at(-1)?.responsible, entry.responsible);
      assert.match(doc.body.textContent ?? '', new RegExp(entry.rendered));
      if (entry.kind === 'recovery') assert.doesNotMatch(doc.body.textContent ?? '', /Unknown actor/);
      await enterField(doc, dom, 'Reason for this action', 'The blocker is resolved.');
      clickButton(doc, 'Clear blocker');
      await settle(180);
    }
    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Project Tasks exposes authorized proposal, intervention, validation, discard, and recovery actions', async () => {
  const { dom, doc, vite, cleanup } = await setupHarness();
  try {
    const { app, router, calls } = await mountTasks(vite, doc);
    await router.push({ name: 'project-task-proposal', params: { proposalId: 'proposal-a' }, query: { project: projectId } });
    await settle();
    clickButton(doc, 'Approve & Begin');
    await settle();
    const environment = [...doc.querySelectorAll<HTMLSelectElement>('select')].find((select) => select.closest('label')?.textContent?.includes('Environment instance'));
    assert.ok(environment);
    assert.equal(environment.value, 'instance-a');
    await enterField(doc, dom, 'Approval reason', 'Authorize this bounded Task.');
    clickButton(doc, 'Confirm approve and begin');
    await settle(180);
    assert.ok(calls.includes('begin'), 'approve-and-begin uses the proposal admission port');

    await openTaskRecord(router, 'run-running');
    assert.match(doc.body.textContent ?? '', /Pause Task/);
    assert.equal(doc.activeElement?.textContent?.includes('run-running'), true, 'route detail receives focus after drill-down');
    assert.match(doc.querySelector('[data-testid="shell-announcer"]')?.textContent ?? '', /Task details opened/);
    const pause = [...doc.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Pause Task'));
    assert.ok(pause?.className.includes('min-h-[44px]'), 'phone and touch control target meets the 44px minimum');
    await enterField(doc, dom, 'Reason for this action', 'Hold future Task runs.');
    clickButton(doc, 'Pause Task');
    await settle(180);
    assert.ok(calls.includes('pause:run-running'));

    await openTaskRecord(router, 'pause-requested');
    await enterField(doc, dom, 'Reason for this action', 'The active run must stop now.');
    clickButton(doc, 'Interrupt active run');
    await settle(180);
    assert.ok(calls.includes('interrupt:pause-requested'));

    await openTaskRecord(router, 'paused');
    await enterField(doc, dom, 'Reason for this action', 'Resume after review.');
    clickButton(doc, 'Resume Task');
    await settle(180);
    assert.ok(calls.includes('resume:paused'));

    await openTaskRecord(router, 'awaiting-validation');
    await enterField(doc, dom, 'Validation reason', 'Request one correction.');
    clickButton(doc, 'Request correction');
    await settle(180);
    await openTaskRecord(router, 'awaiting-validation');
    await enterField(doc, dom, 'Validation reason', 'The evidence satisfies the criteria.');
    clickButton(doc, 'Accept and safely end Task');
    await settle(180);
    assert.ok(calls.includes('validate:awaiting-validation:correct'));
    assert.ok(calls.includes('validate:awaiting-validation:accept'));

    await openTaskRecord(router, 'run-idle');
    await enterField(doc, dom, 'Outcome summary', 'The bounded outcome is ready for review.');
    await enterField(doc, dom, 'Validation evidence', 'The agreed checks passed.');
    clickButton(doc, 'Submit completion claim');
    await settle(180);
    assert.ok(calls.includes('completion-claim:run-idle'));

    await openTaskRecord(router, 'run-idle');
    clickButton(doc, 'Revise content');
    await settle();
    await enterField(doc, dom, 'Title', 'Revised bounded Task');
    await enterField(doc, dom, 'Goal', 'Update the Task content version.');
    await enterField(doc, dom, 'Revision reason', 'Clarify the expected output.');
    clickButton(doc, 'Save content version');
    await settle(180);
    assert.ok(calls.includes('revise-content'));

    await openTaskRecord(router, 'run-idle');
    clickButton(doc, 'Record blocker');
    await settle();
    await enterField(doc, dom, 'Blocker reason', 'Waiting for an external approval.');
    await enterField(doc, dom, 'Required next action', 'Record the approval outcome.');
    await enterField(doc, dom, 'External condition', 'Approval arrives.');
    clickButton(doc, 'Save blocker');
    await settle(180);
    assert.ok(calls.includes('raise-blocker'));

    await openTaskRecord(router, 'blocked');
    await enterField(doc, dom, 'Reason for this action', 'The approval arrived.');
    clickButton(doc, 'Clear blocker');
    await settle(180);
    assert.ok(calls.includes('clear-blocker'));

    await openTaskRecord(router, 'run-idle');
    await enterField(doc, dom, 'Reason for this action', 'Abandon the unfinished work.');
    clickButton(doc, 'Discard Task');
    await settle(180);
    assert.ok(calls.includes('discard:run-idle'));

    await openTaskRecord(router, 'recovery');
    await enterField(doc, dom, 'Reason for this action', 'Retry after checking recovery facts.');
    clickButton(doc, 'Resume Task recovery');
    await settle(180);
    assert.ok(calls.includes('recover:recovery:resume'));
    await openTaskRecord(router, 'recovery');
    await enterField(doc, dom, 'Reason for this action', 'Abandon the Task during recovery.');
    clickButton(doc, 'Discard through recovery');
    await settle(180);
    assert.ok(calls.includes('recover:recovery:discard'));

    await openTaskRecord(router, 'ending');
    await enterField(doc, dom, 'Reason for this action', 'Retry accepted completion cleanup.');
    clickButton(doc, 'Retry safe Task end');
    await settle(180);
    assert.ok(calls.includes('end:ending'));
    await openTaskRecord(router, 'completed');
    const ended = [...doc.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Task ended'));
    assert.ok(ended?.disabled, 'terminal Tasks expose no new lifecycle command');
    const masterList = doc.querySelector<HTMLElement>('aside[aria-label="Project Task list"]');
    assert.ok(masterList?.className.includes('hidden') && masterList.className.includes('lg:flex'), 'the master list becomes a desktop pane while detail fills the phone');
    app.unmount();
  } finally {
    await cleanup();
  }
});
