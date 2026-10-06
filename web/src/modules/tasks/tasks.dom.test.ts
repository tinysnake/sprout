import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { RunView, TaskView, TaskWithRunsView } from '../../../../src/web/views.ts';
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
  content: { currentVersion: 1, versions: [{ version: 1, rules: [], memberships: [
    { memberId: 'operator', memberKind: 'human', startedAt: time, responsibilities: [], collaborationInstructions: '' },
    { memberId: 'agent-b', memberKind: 'agent', startedAt: time, responsibilities: [], collaborationInstructions: '' },
    { memberId: 'agent-a', memberKind: 'agent', startedAt: time, responsibilities: [], collaborationInstructions: '' },
  ] }] },
};
const overview = {
  project,
  agents: [{ id: 'agent-a', displayName: 'Project Agent', status: 'active' }, { id: 'agent-b', displayName: 'Other Project Agent', status: 'active' }],
  environments: [{ id: 'env-a', environmentInstanceId: 'instance-a', displayName: 'Ready Environment', enrollmentStatus: 'approved', trafficLight: 'green', workSafety: 'clear', connectionState: 'online', protocolCompatibility: 'compatible', capabilityPermissions: { 'agent-run': true } }],
  access: [{ projectId, environmentInstanceId: 'instance-a', status: 'active', startedAt: time, updatedAt: time, current: { bindingId: 'binding-a', workspaceId: 'workspace-a', kind: 'default', boundAt: time }, history: [] }],
  compatibility: [{ agentId: 'agent-a', environmentInstanceId: 'instance-a', available: true }, { agentId: 'agent-b', environmentInstanceId: 'instance-a', available: true }],
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

function appServices(conflictCodes: readonly string[] = [], snapshot = overview) {
  const idle = task('run-idle', 'idle');
  const humanLedIdle = { ...idle, admission: { ...idle.admission!, lead: { memberId: 'operator', memberKind: 'human' as const } } };
  const humanLedRunning = task('run-running', 'running', { activeRunId: 'run-private', status: 'in-progress' });
  const humanLedRunningWithLead = { ...humanLedRunning, admission: { ...humanLedRunning.admission!, lead: { memberId: 'operator', memberKind: 'human' as const } } };
  const agentLedAwaiting = task('agent-led-awaiting', 'awaiting-validation', {
    pendingCompletionClaimId: 'claim-substitute',
    completionClaims: [{
      id: 'claim-substitute', contentVersion: 1, actor: { memberId: 'operator', memberKind: 'human' },
      substitutedFor: { memberId: 'agent-a', memberKind: 'agent' }, at: time,
      outcomeSummary: 'The Agent-led work is ready for review.', validationEvidence: ['Acceptance evidence is available.'],
      durableChanges: ['Task page rendered.'], limitations: [], recommendedDisposition: 'complete',
    }],
    controlHistory: [{
      action: 'completion-claimed', actor: { memberId: 'operator', memberKind: 'human' }, at: time,
      claimId: 'claim-substitute', substitutedFor: { memberId: 'agent-a', memberKind: 'agent' },
    }],
  });
  const allTasks = [
    task('agent-led-idle', 'idle'),
    agentLedAwaiting,
    humanLedRunningWithLead,
    humanLedIdle,
    task('run-not-owned', 'running', { activeRunId: 'run-human-initiated', status: 'in-progress' }),
    task('pause-requested', 'running', { activeRunId: 'run-pausing', pauseState: 'requested' }),
    task('paused', 'idle', { pauseState: 'paused' }),
    task('blocked', 'blocked', { status: 'blocked', blocker: { reason: 'External approval is pending.', requiredAction: 'Record approval.', responsible: { kind: 'external-condition', condition: 'Approval arrives.' }, nextAdvancer: { memberId: 'agent-a', memberKind: 'agent' }, createdBy: { memberId: 'operator', memberKind: 'human' }, createdAt: time } }),
    task('awaiting-validation', 'awaiting-validation', { pendingCompletionClaimId: 'claim-a', completionClaims: [{ id: 'claim-a', contentVersion: 1, actor: { memberId: 'agent-a', memberKind: 'agent' }, at: time, outcomeSummary: 'The validation path is ready.', validationEvidence: ['Acceptance evidence is available.'], durableChanges: ['Task page rendered.'], limitations: [], recommendedDisposition: 'complete' }] }),
    task('ending', 'ending', { endDisposition: 'completed' }),
    task('recovery', 'recovery', { recoveryState: 'blocked', pauseState: 'paused', blocker: { reason: 'Retained blocker while recovery is unresolved.', requiredAction: 'Resolve recovery first.', responsible: { kind: 'human', memberId: 'operator' }, nextAdvancer: { memberId: 'agent-a', memberKind: 'agent' }, createdBy: { memberId: 'operator', memberKind: 'human' }, createdAt: time } }),
    task('recovery-running', 'recovery', { recoveryState: 'running', activeRunId: 'run-recovering', pauseState: 'requested' }),
    task('recovery-ending', 'recovery', { recoveryState: 'ending', endDisposition: 'completed' }),
    task('recovery-cancelled-ending', 'recovery', { recoveryState: 'ending', endDisposition: 'cancelled' }),
    task('completed', 'ended', { status: 'done', endDisposition: 'completed' }),
    task('stopped', 'discarded', { status: 'stopped', forcedRelease: { actor: 'operator', reason: 'Emergency environment recovery', unresolvedFacts: ['Engine stop was not proved.'], at: time } }),
    task('cancelled', 'discarded', { status: 'cancelled', endDisposition: 'cancelled', pauseState: 'paused', blocker: { reason: 'The approval was pending when the Task ended.', requiredAction: 'Record approval.', responsible: { kind: 'external-condition', condition: 'Approval arrives.' }, nextAdvancer: { memberId: 'agent-a', memberKind: 'agent' }, createdBy: { memberId: 'operator', memberKind: 'human' }, createdAt: time } }),
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
  const controlInputs: Array<{ readonly action: 'pause' | 'interrupt'; readonly taskId: string; readonly reason: string }> = [];
  const blockerCalls: TaskBlockerInput[] = [];
  const proposalRows = [proposal];
  const beginInputs: unknown[] = [];
  const api = {
    state: () => ({ status: 'online', connection: 'online', loading: false }),
    subscribeState: () => () => undefined,
    async listProposals() { return proposalRows; },
    async getProposal(id: string) { return proposalRows.find(row => row.id === id)!; },
    async getContentVersion(id: string, version: number) { calls.push(`content-version:${id}:${version}`); return proposalRows.find(row => row.id === id)!.versions[0]!; },
    async validateProposal(_id: string, content: unknown) { calls.push('validate-proposal'); return content; },
    async propose(_id: string, content: TaskProposal['versions'][number]) {
      calls.push('propose');
      const created = { ...proposal, id: 'proposal-new', versions: [{ ...proposal.versions[0]!, ...content }] };
      proposalRows.push(created);
      return created;
    },
    async reviseProposal() { calls.push('revise-proposal'); return proposal; },
    async withdrawProposal() { calls.push('withdraw-proposal'); return proposal; },
    async rejectProposal() { calls.push('reject-proposal'); return proposal; },
    async beginProposal(_id: string, input: unknown) { calls.push('begin'); beginInputs.push(input); return { task: allTasks[0]!, duplicate: false }; },
    async listTasks() { return allTasks; },
    async getTask(id: string) {
      const detail = details.get(id);
      if (!detail) throw new Error('Task not found.');
      return detail;
    },
    async advance(id: string) {
      calls.push(`advance:${id}`);
      const code = conflictCodes[nextConflict++];
      if (code) throw new BrowserRequestError('rejected', 409, { code, message: code === 'terminal-task' ? 'This Task is cancelled; its blocker is historical.' : 'server conflict' });
      return { task: allTasks.find((entry) => entry.id === id)!, runId: 'run-next', advance: { runId: 'run-next', agentId: 'agent-a', sequence: 2, linkedAt: time } };
    },
    async reviseTaskContent() { calls.push('revise-content'); return allTasks[1]!; },
    async pause(id: string, reason: string) { calls.push(`pause:${id}`); controlInputs.push({ action: 'pause', taskId: id, reason }); return allTasks[0]!; },
    async interrupt(id: string, reason: string) { calls.push(`interrupt:${id}`); controlInputs.push({ action: 'interrupt', taskId: id, reason }); return allTasks[0]!; },
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
      const code = conflictCodes[nextConflict++];
      if (code) throw new BrowserRequestError('rejected', 409, {
        code, message: code === 'terminal-task' ? 'This Task is cancelled; its blocker is historical.' : 'server conflict',
      });
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
    async reopen(id: string, reason: string) { calls.push(`reopen:${id}:${reason}`); return allTasks[0]!; },
    async recover(id: string, input: { action: string }) { calls.push(`recover:${id}:${input.action}`); return allTasks[1]!; },
  } as unknown as TaskBrowserAdapter;
  const projects = {
    async listProjects() { return [project]; },
    async loadOverview() { return snapshot; },
  } as unknown as ProjectManagementService;
  return { api, projects, allTasks, calls, controlInputs, blockerCalls, beginInputs };
}

async function mountTasks(vite: { ssrLoadModule: (path: string) => Promise<unknown> }, doc: Document, codes: readonly string[] = [], snapshot = overview, runService?: { getRun(id: string): Promise<RunView> }) {
  const { createSproutApp } = await vite.ssrLoadModule('/src/app/main.ts') as typeof import('../../app/main.ts');
  const { api, projects, calls, controlInputs, blockerCalls, beginInputs } = appServices(codes, snapshot);
  const connectionSource = createShellConnectionController({ status: 'online', connection: 'online', loading: false });
  const { app, router } = createSproutApp({ routerBase: '/app/', taskService: api, projectService: projects, connectionSource, runService });
  await router.push(`/project/tasks?project=${projectId}`);
  await router.isReady();
  app.mount(doc.querySelector('#app')!);
  await settle();
  return { app, router, calls, controlInputs, blockerCalls, beginInputs };
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

test('Project Tasks renders distinct production lifecycle states and keeps activity collapsed initially', async () => {
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
    assert.match(doc.body.textContent ?? '', /Autonomous execution audit/);
    assert.doesNotMatch(doc.body.textContent ?? '', /PRIVATE-RUN-PROMPT|PRIVATE-RUN-EVENT|PRIVATE-RUN-SUMMARY/);
    assert.ok(doc.querySelector('#advance-target-agent') === null, 'a running Task cannot admit another run');
    doc.querySelector<HTMLButtonElement>('[data-record-kind="task"][data-record-id="completed"]')?.click();
    await settle();
    assert.match(doc.body.textContent ?? '', /Run timeline/);
    assert.doesNotMatch(doc.body.textContent ?? '', /PRIVATE-RUN-SUMMARY/, 'settled run activity loads only on expansion');

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

function auditRun(changes: Partial<RunView> = {}): RunView {
  return {
    id: 'run-settled', agentId: 'agent-a', taskId: 'completed', prompt: 'PROMPT-NOT-ACTIVITY',
    status: 'completed', handOffAttached: false, createdAt: time, completedAt: time + 562_000,
    events: [{ type: 'tool-call', name: 'inspect', detail: 'Checked the Task acceptance criteria.' },
      { type: 'tool-output', text: 'Validation passed.', time: '09:22' }],
    result: { status: 'completed', text: 'The requested change is ready.\nEvidence recorded.' },
    tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    ...changes,
  };
}

async function openCompletedAudit(doc: Document) {
  doc.querySelector<HTMLButtonElement>('[data-record-id="completed"]')?.click();
  await settle();
  const audit = doc.querySelector<HTMLElement>('[data-run-audit="run-settled"]');
  assert.ok(audit, 'each Task run has an inline audit');
  clickButton(doc, 'Show activity');
  await settle();
  return audit;
}

function expandEventRows(audit: HTMLElement) {
  for (const button of audit.querySelectorAll<HTMLButtonElement>('[data-run-event] button[aria-expanded="false"]')) button.click();
}

function expandSummaryRows(audit: HTMLElement) {
  for (const button of audit.querySelectorAll<HTMLButtonElement>('[data-run-status] button[aria-expanded="false"], [data-run-result] button[aria-expanded="false"], [data-run-failure] button[aria-expanded="false"]')) button.click();
}

test('Task run expansion loads ordered activity and disclosed result with duration and tokens', async () => {
  const { doc, vite, cleanup } = await setupHarness();
  let app: { unmount(): void } | undefined;
  try {
    const requested: string[] = [];
    ({ app } = await mountTasks(vite, doc, [], overview, { async getRun(id) { requested.push(id); return auditRun(); } }));
    assert.deepEqual(requested, [], 'activity is not eagerly fetched');
    const audit = await openCompletedAudit(doc);
    assert.deepEqual(requested, ['run-settled']);
    assert.equal(audit.querySelectorAll('[data-run-event]').length, 2, 'each event owns a row even when collapsed');
    assert.equal(audit.querySelectorAll('[data-run-event] button[aria-expanded="false"]').length, 2);
    assert.doesNotMatch(audit.textContent ?? '', /Checked the Task|Validation passed|The requested change|9m 22s|150 tokens/);
    expandEventRows(audit);
    expandSummaryRows(audit);
    await settle();
    const lines = [...audit.querySelectorAll('[data-run-event]')].map((line) => line.textContent ?? '');
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /\[time unavailable\].*tool-call/s);
    assert.match(lines[0]!, /inspect.*Checked the Task acceptance criteria\./s);
    assert.match(lines[1]!, /\[09:22\].*Validation passed\./s);
    assert.match(audit.textContent ?? '', /completed.*9m 22s.*150 tokens/s);
    assert.match(audit.textContent ?? '', /The requested change is ready\.\nEvidence recorded\./);
    assert.doesNotMatch(doc.body.textContent ?? '', /PROMPT-NOT-ACTIVITY/);
    const target = doc.querySelector<HTMLAnchorElement>('[data-task-run-target="run-settled"]');
    assert.match(target?.getAttribute('href') ?? '', /manage\/agents\/agent-a\?run=run-settled/);
    clickButton(doc, 'Hide activity');
    await settle();
    assert.equal(audit.querySelector('[data-run-event]'), null, 'collapse removes activity rows');
  } finally { app?.unmount(); await cleanup(); }
});

test('Task run audit discloses every non-reply row independently and never folds assistant replies', async () => {
  const { doc, vite, cleanup } = await setupHarness();
  let app: { unmount(): void } | undefined;
  try {
    const events = [
      { type: 'tool-call', name: 'inspect', detail: 'HIDDEN-CALL' },
      { type: 'tool-output', text: 'HIDDEN-OUTPUT' },
      { type: 'notice', text: 'reasoning' },
      { type: 'message', text: 'ASSISTANT-PROGRESS', final: false },
      { type: 'notice', text: 'Engine request failed temporarily; retrying (attempt 2 of 3).' },
      { type: 'notice', text: 'tool failed' },
      { type: 'notice', text: 'HIDDEN-ROUTINE-NOTICE' },
      { type: 'future-event', text: 'HIDDEN-UNKNOWN' },
      { type: 'message', text: 'ASSISTANT-FINAL', final: true },
    ];
    ({ app } = await mountTasks(vite, doc, [], overview, { async getRun() { return auditRun({ events }); } }));
    const audit = await openCompletedAudit(doc);
    const rows = [...audit.querySelectorAll('[data-run-event]')];
    assert.equal(rows.length, events.length);
    const controls = rows.flatMap(row => [...row.querySelectorAll<HTMLButtonElement>('button')]);
    assert.equal(controls.length, 7, 'all non-reply types, including warning notices, get their own control');
    assert.equal(new Set(controls.map(button => button.getAttribute('aria-controls'))).size, 7);
    for (const button of controls) {
      assert.equal(button.getAttribute('aria-expanded'), 'false');
      const target = doc.getElementById(button.getAttribute('aria-controls')!);
      assert.ok(target?.hidden, 'collapsed controls point to an empty hidden panel');
      assert.equal(target.textContent, '');
      assert.ok(button.className.includes('min-h-[44px]'), 'row toggles remain usable by touch');
    }
    for (const index of [3, 8]) {
      assert.equal(rows[index]!.querySelector('button, [aria-expanded]'), null, 'replies have no disclosure control');
      assert.match(rows[index]!.textContent ?? '', /ASSISTANT-/);
    }
    assert.doesNotMatch(audit.textContent ?? '', /HIDDEN-|reasoning|retrying|tool failed/);
    controls[0]!.click();
    await settle();
    assert.deepEqual(controls.map(button => button.getAttribute('aria-expanded')), ['true', ...Array(6).fill('false')]);
    assert.match(doc.getElementById(controls[0]!.getAttribute('aria-controls')!)?.textContent ?? '', /HIDDEN-CALL/);
    assert.doesNotMatch(audit.textContent ?? '', /HIDDEN-OUTPUT|reasoning|HIDDEN-UNKNOWN/);
    controls[1]!.click();
    await settle();
    controls[0]!.click();
    await settle();
    assert.doesNotMatch(audit.textContent ?? '', /HIDDEN-CALL/);
    assert.match(audit.textContent ?? '', /HIDDEN-OUTPUT.*ASSISTANT-PROGRESS.*ASSISTANT-FINAL/s);
    expandEventRows(audit);
    await settle();
    rows.forEach((row, index) => assert.ok(row.textContent?.includes(events[index]!.text ?? events[index]!.detail!), 'recorded order is unchanged'));
  } finally { app?.unmount(); await cleanup(); }
});

test('Task run audit preserves individual expansion when a refreshed stream grows', async () => {
  const { doc, vite, cleanup } = await setupHarness();
  let app: { unmount(): void } | undefined;
  try {
    let reads = 0;
    ({ app } = await mountTasks(vite, doc, [], overview, { async getRun() {
      reads += 1;
      return auditRun({ events: [
        { type: 'tool-call', name: 'inspect', detail: 'OPEN-ROW' },
        { type: 'message', text: 'ASSISTANT-READ-' + reads, final: false },
        ...Array.from({ length: reads }, (_, index) => ({ type: 'tool-output', text: 'CLOSED-ROW-' + index })),
      ] });
    } }));
    const audit = await openCompletedAudit(doc);
    audit.querySelector<HTMLButtonElement>('[data-run-event] button')!.click();
    expandSummaryRows(audit);
    await settle();
    clickButton(doc, 'Refresh run');
    await settle();
    const buttons = [...audit.querySelectorAll<HTMLButtonElement>('[data-run-event] button')];
    assert.deepEqual(buttons.map(button => button.getAttribute('aria-expanded')), ['true', 'false', 'false']);
    assert.match(audit.textContent ?? '', /OPEN-ROW.*ASSISTANT-READ-2/s);
    assert.doesNotMatch(audit.textContent ?? '', /CLOSED-ROW-/);
    assert.equal(audit.querySelector('[data-run-result] button')?.getAttribute('aria-expanded'), 'true');
    buttons[1]!.click();
    await settle();
    assert.match(audit.textContent ?? '', /CLOSED-ROW-0/);
    assert.doesNotMatch(audit.textContent ?? '', /CLOSED-ROW-1/);
  } finally { app?.unmount(); await cleanup(); }
});

test('Task run audit collapses status, failure and final Result independently of assistant replies', async () => {
  const { doc, vite, cleanup } = await setupHarness();
  let app: { unmount(): void } | undefined;
  try {
    ({ app } = await mountTasks(vite, doc, [], overview, { async getRun() {
      return auditRun({ events: [{ type: 'message', text: 'PINNED-REPLY', final: true }], failure: 'RECORDED-FAILURE' });
    } }));
    const audit = await openCompletedAudit(doc);
    const result = audit.querySelector<HTMLButtonElement>('[data-run-result] button');
    const status = audit.querySelector<HTMLButtonElement>('[data-run-status] button');
    const failure = audit.querySelector<HTMLButtonElement>('[data-run-failure] button');
    assert.ok(result && status && failure);
    assert.equal(result.getAttribute('aria-expanded'), 'false');
    assert.equal(status.getAttribute('aria-expanded'), 'false');
    assert.equal(failure.getAttribute('aria-expanded'), 'false');
    assert.equal(new Set([result, status, failure].map(button => button.getAttribute('aria-controls'))).size, 3);
    assert.doesNotMatch(audit.textContent ?? '', /The requested change|RECORDED-FAILURE|9m 22s/);
    result.click();
    await settle();
    assert.equal(result.getAttribute('aria-expanded'), 'true');
    assert.match(doc.getElementById(result.getAttribute('aria-controls')!)?.textContent ?? '', /The requested change/);
    assert.doesNotMatch(audit.textContent ?? '', /RECORDED-FAILURE/);
    assert.equal(status.getAttribute('aria-expanded'), 'false');
    failure.click();
    await settle();
    assert.match(doc.getElementById(failure.getAttribute('aria-controls')!)?.textContent ?? '', /RECORDED-FAILURE/);
    status.click();
    await settle();
    assert.match(doc.getElementById(status.getAttribute('aria-controls')!)?.textContent ?? '', /completed.*9m 22s.*150 tokens/s);
    result.click();
    await settle();
    assert.equal(result.getAttribute('aria-expanded'), 'false');
    assert.doesNotMatch(audit.textContent ?? '', /The requested change/);
    assert.match(audit.textContent ?? '', /RECORDED-FAILURE/);
    failure.click();
    await settle();
    assert.doesNotMatch(audit.textContent ?? '', /RECORDED-FAILURE/);
    assert.match(audit.textContent ?? '', /PINNED-REPLY/);
    assert.equal(audit.querySelector('[data-run-event] button'), null);
  } finally { app?.unmount(); await cleanup(); }
});

test('Task run audit explains absent events, result, duration and usage when disclosed', async () => {
  const { doc, vite, cleanup } = await setupHarness();
  let app: { unmount(): void } | undefined;
  try {
    ({ app } = await mountTasks(vite, doc, [], overview, { async getRun() {
      return auditRun({ events: [], result: undefined, completedAt: undefined, tokenUsage: undefined, status: 'running' });
    } }));
    const audit = await openCompletedAudit(doc);
    expandSummaryRows(audit);
    await settle();
    assert.match(audit.textContent ?? '', /No activity events recorded/);
    assert.match(audit.textContent ?? '', /No final result recorded/);
    assert.match(audit.textContent ?? '', /Duration unavailable/);
    assert.match(audit.textContent ?? '', /Tokens unavailable/);
  } finally { app?.unmount(); await cleanup(); }
});

test('Task run audit renders hostile event and final result content as text', async () => {
  const { doc, vite, cleanup } = await setupHarness();
  let app: { unmount(): void } | undefined;
  try {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    ({ app } = await mountTasks(vite, doc, [], overview, { async getRun() {
      return auditRun({ events: [{ type: 'tool-call', name: hostile, detail: hostile }, { type: 'notice', text: hostile }], result: { status: 'failed', message: hostile } });
    } }));
    const audit = await openCompletedAudit(doc);
    expandEventRows(audit);
    expandSummaryRows(audit);
    await settle();
    assert.ok(audit.querySelector('[data-run-event]')?.textContent?.includes(hostile));
    assert.ok(audit.querySelector('[data-run-result]')?.textContent?.includes(hostile));
    assert.equal(audit.querySelector('img, script'), null);
  } finally { app?.unmount(); await cleanup(); }
});

test('Task run audit coalesces streamed replies before paging and counts activity entries', async () => {
  const { doc, vite, cleanup } = await setupHarness();
  let app: { unmount(): void } | undefined;
  try {
    const events = Array.from({ length: 18 }, (_, index) => [
      { type: 'message', text: `reply-${index}-` },
      { type: 'message', text: `chunk-${index}` },
      { type: 'tool-call', name: `tool-${index}`, detail: `TOOL-${index}` },
      { type: 'notice', text: `NOTICE-${index}` },
    ]).flat();
    ({ app } = await mountTasks(vite, doc, [], overview, { async getRun() { return auditRun({ events }); } }));
    const audit = await openCompletedAudit(doc);
    let rows = [...audit.querySelectorAll('[data-run-event]')];
    assert.equal(rows.length, 50, 'the first page contains 50 coalesced activity entries');
    assert.match(audit.textContent ?? '', /Entries 1–50 of 54/);
    assert.match(rows[0]!.textContent ?? '', /\[time unavailable\] message.*reply-0-chunk-0/s);
    assert.equal(rows[0]!.querySelector('button'), null, 'merged replies stay visible without a disclosure control');
    assert.match(rows[1]!.textContent ?? '', /tool-call/);
    assert.match(rows[2]!.textContent ?? '', /notice/);
    assert.equal(rows.filter(row => !row.querySelector('button')).length, 17, 'one always-visible reply entry per chunk pair');
    assert.equal(rows.filter(row => row.querySelector('button[aria-expanded="false"]')).length, 33, 'tools and notices retain individual collapsed rows');
    assert.doesNotMatch(audit.textContent ?? '', /NOTICE-16/);

    clickButton(doc, 'Next events');
    await settle();
    rows = [...audit.querySelectorAll('[data-run-event]')];
    assert.equal(rows.length, 4);
    assert.match(audit.textContent ?? '', /Entries 51–54 of 54/);
    assert.match(rows[0]!.textContent ?? '', /notice/);
    assert.match(rows[1]!.textContent ?? '', /reply-17-chunk-17/);
    assert.match(rows[2]!.textContent ?? '', /tool-call/);
    assert.match(rows[3]!.textContent ?? '', /notice/);
    rows[0]!.querySelector<HTMLButtonElement>('button')!.click();
    await settle();
    assert.match(rows[0]!.textContent ?? '', /NOTICE-16/);
  } finally { app?.unmount(); await cleanup(); }
});

test('Task run audit pages 50 rows and restores each row expansion when returning', async () => {
  const { doc, vite, cleanup } = await setupHarness();
  let app: { unmount(): void } | undefined;
  try {
    const events = Array.from({ length: 120 }, (_, index) => ({ type: 'tool-output', text: 'Event ' + index + ': ' + 'x'.repeat(1_500) }));
    assert.ok(JSON.stringify(events).length > 180_000);
    ({ app } = await mountTasks(vite, doc, [], overview, { async getRun() { return auditRun({ events }); } }));
    const audit = await openCompletedAudit(doc);
    assert.equal(audit.querySelectorAll('[data-run-event]').length, 50);
    assert.equal(audit.querySelectorAll('[data-run-event] button[aria-expanded="false"]').length, 50);
    audit.querySelector<HTMLButtonElement>('[data-run-event] button')!.click();
    expandSummaryRows(audit);
    await settle();
    assert.match(audit.textContent ?? '', /Entries 1–50 of 120/);
    assert.match(audit.textContent ?? '', /Event 0:/);
    assert.doesNotMatch(audit.textContent ?? '', /Event 1:|Event 50:/);
    clickButton(doc, 'Next events');
    await settle();
    assert.equal(audit.querySelectorAll('[data-run-event]').length, 50);
    assert.equal(audit.querySelectorAll('[data-run-event] button[aria-expanded="false"]').length, 50);
    audit.querySelector<HTMLButtonElement>('[data-run-event] button')!.click();
    await settle();
    assert.match(audit.textContent ?? '', /Entries 51–100 of 120/);
    assert.match(audit.textContent ?? '', /Event 50:/);
    assert.doesNotMatch(audit.textContent ?? '', /Event 0:|Event 51:/);
    clickButton(doc, 'Next events');
    await settle();
    assert.equal(audit.querySelectorAll('[data-run-event]').length, 20);
    assert.equal(audit.querySelectorAll('[data-run-event] button[aria-expanded="false"]').length, 20);
    expandEventRows(audit);
    await settle();
    assert.match(audit.textContent ?? '', /Event 119:/);
    assert.match(audit.querySelector('[data-run-result]')?.textContent ?? '', /The requested change is ready/);
    clickButton(doc, 'Previous events');
    await settle();
    assert.match(audit.textContent ?? '', /Entries 51–100 of 120/);
    assert.equal(audit.querySelectorAll('[data-run-event] button[aria-expanded="true"]').length, 1);
    assert.match(audit.textContent ?? '', /Event 50:/);
    assert.doesNotMatch(audit.textContent ?? '', /Event 51:/);
  } finally { app?.unmount(); await cleanup(); }
});

function retainedAuditContent(audit: HTMLElement) {
  const component = (audit as HTMLElement & {
    __vueParentComponent?: { setupState: { eventTexts: Map<number, string>; resultText: string } };
  }).__vueParentComponent;
  assert.ok(component, 'inspect cached content because DOM removal cannot prove release');
  return component.setupState;
}

function retainedAuditRun(audit: HTMLElement): RunView | undefined {
  // The audit stays mounted on collapse, so DOM removal cannot prove payload release.
  const component = (audit as HTMLElement & {
    __vueParentComponent?: { setupState: { run?: RunView } };
  }).__vueParentComponent;
  assert.ok(component, 'inspect the mounted audit owner');
  return component.setupState.run;
}

test('Task run audit releases its payload on collapse and reloads the selected page', async () => {
  const { doc, vite, cleanup } = await setupHarness();
  let app: { unmount(): void } | undefined;
  try {
    let reads = 0;
    ({ app } = await mountTasks(vite, doc, [], overview, { async getRun() {
      reads += 1;
      return auditRun({ events: Array.from({ length: 120 }, (_, index) => ({
        type: 'tool-output', text: `Read ${reads}, event ${index}: ${'x'.repeat(1_500)}`,
      })) });
    } }));
    const audit = await openCompletedAudit(doc);
    assert.equal(retainedAuditRun(audit)?.events.length, 120, 'the expanded audit owns the fetched payload');
    clickButton(doc, 'Next events');
    await settle();
    expandEventRows(audit);
    expandSummaryRows(audit);
    await settle();
    const content = retainedAuditContent(audit);
    assert.equal(content.eventTexts.size, 50);
    const rowButton = audit.querySelector<HTMLButtonElement>('[data-run-event] button')!;
    rowButton.click();
    await settle();
    assert.equal(content.eventTexts.has(50), false, 'row collapse frees that formatted payload');
    assert.equal(content.eventTexts.has(51), true, 'other open rows keep their content');
    rowButton.click();
    audit.querySelector<HTMLButtonElement>('[data-run-result] button')!.click();
    await settle();
    assert.equal(content.resultText, '', 'Result collapse releases its formatted payload');
    audit.querySelector<HTMLButtonElement>('[data-run-result] button')!.click();
    await settle();
    clickButton(doc, 'Hide activity');
    await settle();
    assert.ok(retainedAuditRun(audit) === undefined, 'collapse releases the full run, including events and result');
    assert.equal(content.eventTexts.size, 0, 'audit collapse releases every row cache');
    assert.equal(content.resultText, '');
    clickButton(doc, 'Show activity');
    await settle();
    assert.equal(reads, 2, 'expansion fetches a fresh run');
    assert.match(audit.textContent ?? '', /Entries 51–100 of 120/);
    assert.match(audit.textContent ?? '', /Read 2, event 50:/);
    assert.equal(audit.querySelectorAll('[data-run-event]').length, 50);
    assert.match(audit.querySelector('[data-run-result]')?.textContent ?? '', /The requested change is ready/);
  } finally { app?.unmount(); await cleanup(); }
});

test('Task run audit discards a payload that finishes loading after collapse', async () => {
  const { doc, vite, cleanup } = await setupHarness();
  let app: { unmount(): void } | undefined;
  try {
    let finishRead!: (value: RunView) => void;
    let reads = 0;
    ({ app } = await mountTasks(vite, doc, [], overview, { getRun() {
      reads += 1;
      return reads === 1 ? new Promise<RunView>((resolve) => { finishRead = resolve; }) : Promise.resolve(auditRun());
    } }));
    const audit = await openCompletedAudit(doc);
    assert.match(audit.textContent ?? '', /Loading run activity/);
    clickButton(doc, 'Hide activity');
    await settle();
    finishRead(auditRun());
    await settle();
    assert.ok(retainedAuditRun(audit) === undefined, 'a late response must not restore a collapsed payload');
    clickButton(doc, 'Show activity');
    await settle();
    assert.equal(reads, 2);
    expandSummaryRows(audit);
    await settle();
    assert.match(audit.querySelector('[data-run-result]')?.textContent ?? '', /The requested change is ready/);
  } finally { app?.unmount(); await cleanup(); }
});

for (const staleOutcome of ['success', 'failure'] as const) {
  test(`Task run audit ignores stale ${staleOutcome} after collapse and reopen during a read`, async () => {
    const { doc, vite, cleanup } = await setupHarness();
    let app: { unmount(): void } | undefined;
    try {
      const pending: { resolve(value: RunView): void; reject(reason: Error): void }[] = [];
      ({ app } = await mountTasks(vite, doc, [], overview, { getRun() {
        return new Promise<RunView>((resolve, reject) => { pending.push({ resolve, reject }); });
      } }));
      const audit = await openCompletedAudit(doc);
      clickButton(doc, 'Hide activity');
      await settle();
      clickButton(doc, 'Show activity');
      await settle();
      assert.equal(pending.length, 2, 'reopening starts a fresh read before the old one settles');
      if (staleOutcome === 'success') pending[0]!.resolve(auditRun({ result: 'STALE-RESULT' }));
      else pending[0]!.reject(new Error('Stale read failed'));
      await settle();
      assert.ok(retainedAuditRun(audit) === undefined, 'the obsolete request cannot own the reopened audit');
      assert.equal(audit.querySelector('[role="alert"]'), null, 'obsolete errors cannot affect the new read');
      assert.equal(audit.querySelector('[aria-busy]')?.getAttribute('aria-busy'), 'true', 'obsolete completion cannot end the new loading state');
      pending[1]!.resolve(auditRun({ result: 'FRESH-RESULT' }));
      await settle();
      expandSummaryRows(audit);
      await settle();
      assert.match(audit.querySelector('[data-run-result]')?.textContent ?? '', /FRESH-RESULT/);
      assert.doesNotMatch(audit.textContent ?? '', /STALE-RESULT/);
      assert.equal(audit.querySelector('[aria-busy]')?.getAttribute('aria-busy'), 'false');
    } finally { app?.unmount(); await cleanup(); }
  });
}

test('Task run audit retries a failed load and refreshes the run after settlement', async () => {
  const { doc, vite, cleanup } = await setupHarness();
  let app: { unmount(): void } | undefined;
  try {
    let reads = 0;
    ({ app } = await mountTasks(vite, doc, [], overview, { async getRun() {
      reads += 1;
      if (reads === 1) throw new Error('Run read failed');
      return reads === 2 ? auditRun({ status: 'running', result: undefined, completedAt: undefined }) : auditRun();
    } }));
    const audit = await openCompletedAudit(doc);
    assert.match(audit.querySelector('[role="alert"]')?.textContent ?? '', /Unable to load run activity/);
    clickButton(doc, 'Retry activity');
    await settle();
    expandSummaryRows(audit);
    await settle();
    assert.match(audit.textContent ?? '', /running/);
    assert.match(audit.textContent ?? '', /No final result recorded/);
    clickButton(doc, 'Refresh run');
    await settle();
    assert.match(audit.textContent ?? '', /completed.*9m 22s/s);
    assert.match(audit.querySelector('[data-run-result]')?.textContent ?? '', /The requested change is ready/);
  } finally { app?.unmount(); await cleanup(); }
});

test('Project Tasks creates proposals through validation and the production adapter', async () => {
  const { dom, doc, vite, cleanup } = await setupHarness();
  try {
    const { app, calls, router } = await mountTasks(vite, doc);
    const filterSelect = doc.querySelector<HTMLSelectElement>('#task-status-filter');
    if (filterSelect) selectOption(doc, dom, 'task-status-filter', 'active');
    else clickButton(doc, 'active');
    await settle();
    assert.equal(doc.querySelector('[data-record-kind="proposal"]'), null);
    const proposeButton = clickButton(doc, 'Propose Task');
    await settle();
    const backdrop = doc.querySelector<HTMLElement>('.chat-dialog-backdrop');
    const dialog = backdrop?.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    assert.ok(backdrop && dialog, 'proposal form opens in an accessible modal dialog');
    assert.ok(backdrop.classList.contains('fixed') && backdrop.classList.contains('inset-0'), 'the overlay covers the viewport without taking page layout space');
    assert.equal(doc.querySelector('.project-tasks-view #task-proposal-form-heading'), null, 'the proposal form is not rendered in the page layout');
    assert.ok(dialog.getAttribute('aria-labelledby'));
    assert.ok(dialog.getAttribute('aria-describedby'));
    assert.ok(dialog.className.includes('w-full') && dialog.className.includes('overflow-y-auto'), 'the dialog uses a full-width, scrollable mobile layout');
    assert.match(dialog.className, /max-h-/);
    const closeButton = dialog.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]');
    assert.ok(closeButton);
    assert.ok(closeButton.className.includes('h-11') && closeButton.className.includes('w-11'));
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('button')) {
      if (button !== closeButton) assert.ok(button.className.includes('min-h-[44px]'), 'form actions meet the 44px touch target');
    }
    assert.match(doc.querySelector('[data-testid="shell-announcer"]')?.textContent ?? '', /Task proposal form opened/);
    assert.equal(dialog.contains(doc.activeElement), true, 'opening the form moves focus inside the dialog');
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')];
    closeButton.focus();
    closeButton.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(doc.activeElement, focusable.at(-1), 'Shift+Tab wraps focus to the last dialog control');
    assert.match(doc.body.textContent ?? '', /Human approval is required before begin/);
    doc.activeElement?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settle();
    assert.equal(doc.querySelector('[role="dialog"]'), null, 'Escape closes the proposal dialog');
    assert.equal(doc.activeElement, proposeButton, 'closing restores focus to the propose trigger');
    assert.equal(router.currentRoute.value.name, 'project-tasks', 'Escape leaves the page route unchanged');
    clickButton(doc, 'Propose Task');
    await settle();
    const reopenedBackdrop = doc.querySelector<HTMLElement>('.chat-dialog-backdrop');
    const reopenedDialog = reopenedBackdrop?.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    assert.ok(reopenedDialog);
    reopenedBackdrop!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle();
    assert.equal(doc.querySelector('[role="dialog"]'), null, 'backdrop click closes the proposal dialog');
    assert.equal(doc.activeElement?.textContent, 'Propose Task', 'backdrop close restores focus to the trigger');
    clickButton(doc, 'Propose Task');
    await settle();
    clickButton(doc, 'Cancel');
    await settle();
    assert.equal(doc.querySelector('[role="dialog"]'), null, 'Cancel closes the proposal dialog');
    assert.equal(doc.activeElement, proposeButton, 'Cancel restores focus to the propose trigger');
    assert.equal(router.currentRoute.value.name, 'project-tasks', 'Cancel leaves the page route unchanged');
    clickButton(doc, 'Propose Task');
    await settle();
    assert.ok(doc.querySelector('.chat-dialog-backdrop [role="dialog"][aria-modal="true"]'));
    await enterField(doc, dom, 'Title', 'New proposed work');
    await enterField(doc, dom, 'Goal', 'Record a bounded proposal.');
    clickButton(doc, 'Save proposal');
    await settle(180);
    assert.ok(calls.includes('validate-proposal') && calls.includes('propose'), 'proposal creation validates before persistence');
    assert.equal(router.currentRoute.value.name, 'project-task-proposal');
    assert.equal(router.currentRoute.value.params['proposalId'], 'proposal-new');
    assert.match(doc.querySelector('[aria-label="Selected Task details"]')?.textContent ?? '', /New proposed work/);
    assert.equal(doc.activeElement?.textContent, 'New proposed work');
    assert.equal(doc.querySelector('#task-proposal-form-heading'), null);
    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Project Tasks allows an eligible Agent lead despite an unrelated yellow readiness summary', async () => {
  const { dom, doc, vite, cleanup } = await setupHarness();
  const snapshot = { ...overview, environments: overview.environments.map(environment => ({
    ...environment, trafficLight: 'yellow' as const, trafficLightReason: 'An unrelated engine requires login.',
  })) };
  try {
    const { app, router, beginInputs } = await mountTasks(vite, doc, [], snapshot);
    await router.push({ name: 'project-task-proposal', params: { proposalId: 'proposal-a' }, query: { project: projectId } });
    await settle();
    clickButton(doc, 'Approve & Begin');
    await settle();
    const environment = [...doc.querySelectorAll<HTMLSelectElement>('select')].find(select => select.closest('label')?.textContent?.includes('Environment instance'));
    assert.ok(environment);
    assert.equal(environment.querySelector<HTMLOptionElement>('[value="instance-a"]')?.disabled, false);
    assert.equal(environment.value, 'instance-a');
    const lead = selectOption(doc, dom, 'begin-lead', JSON.stringify({ memberId: 'agent-b', memberKind: 'agent' }));
    await settle();
    assert.match(lead.selectedOptions[0]?.textContent ?? '', /Other Project Agent/);
    const beginForm = [...doc.querySelectorAll('form')].find(form => form.textContent?.includes('Confirm approve and begin'));
    assert.ok(beginForm);
    assert.equal([...beginForm.querySelectorAll('label')].some(label => label.textContent?.includes('Approval reason')), false,
      'approve and begin has no approval reason field');
    const confirm = [...beginForm.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Confirm approve and begin'));
    assert.ok(confirm);
    assert.equal(confirm.disabled, false, 'eligible approval no longer depends on an approval reason');
    clickButton(doc, 'Confirm approve and begin');
    await settle(180);
    assert.deepEqual((beginInputs[0] as { lead: unknown }).lead, { memberId: 'agent-b', memberKind: 'agent' });
    assert.equal('reason' in (beginInputs[0] as object), false, 'the client omits approval reason instead of fabricating one');
    app.unmount();
  } finally { await cleanup(); }
});

test('Project Tasks explains unavailable begin resources and never submits a refused selection', async () => {
  const { doc, vite, cleanup } = await setupHarness();
  try {
    for (const entry of [
      { environment: { enrollmentStatus: 'pending' }, compatibility: overview.compatibility, reason: /not approved/ },
      { environment: { trafficLight: 'red', trafficLightReason: 'A required readiness dimension is blocked.' }, compatibility: overview.compatibility, reason: /required readiness dimension is blocked/ },
      { environment: { workSafety: 'recovery' }, compatibility: overview.compatibility, reason: /held for existing work or recovery/ },
      { environment: { connectionState: 'offline' }, compatibility: overview.compatibility, reason: /Worker is not online/ },
      { environment: { protocolCompatibility: 'unknown' }, compatibility: overview.compatibility, reason: /protocol compatibility is not confirmed/ },
      { environment: { capabilityPermissions: { 'agent-run': false } }, compatibility: overview.compatibility, reason: /Agent run capability is not granted/ },
      { environment: {}, compatibility: overview.compatibility.map(row => ({ ...row, available: undefined })), reason: /Agent compatibility has not been confirmed/ },
      { environment: {}, compatibility: overview.compatibility.map(row => ({ ...row, available: false, unavailableReason: 'Selected work model is unavailable.' })), reason: /Selected work model is unavailable/ },
    ]) {
      const snapshot = { ...overview, environments: overview.environments.map(environment => ({ ...environment, ...entry.environment })), compatibility: entry.compatibility } as ProjectOverviewData;
      const { app, router, beginInputs } = await mountTasks(vite, doc, [], snapshot);
      await router.push({ name: 'project-task-proposal', params: { proposalId: 'proposal-a' }, query: { project: projectId } });
      await settle();
      clickButton(doc, 'Approve & Begin');
      await settle();
      const environment = [...doc.querySelectorAll<HTMLSelectElement>('select')].find(select => select.closest('label')?.textContent?.includes('Environment instance'));
      assert.ok(environment);
      assert.equal(environment.querySelector<HTMLOptionElement>('[value="instance-a"]')?.disabled, true);
      assert.match(doc.querySelector('[data-begin-guidance]')?.textContent ?? '', entry.reason);
      assert.match(doc.querySelector('[data-lead-guidance]')?.textContent ?? '', /Select an available Environment to see eligible Agent leads/);
      const confirm = [...doc.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Confirm approve and begin'))!;
      assert.equal(confirm.disabled, true);
      confirm.click();
      assert.deepEqual(beginInputs, []);
      app.unmount();
    }
  } finally { await cleanup(); }
});

test('Project Tasks filters with a dropdown and keeps task switching inside Chat-style scroll panes', async () => {
  const { dom, doc, vite, cleanup } = await setupHarness();
  try {
    const { app, router } = await mountTasks(vite, doc);
    const filter = doc.querySelector<HTMLSelectElement>('#task-status-filter');
    assert.ok(filter);
    assert.equal(doc.querySelector('label[for="task-status-filter"]')?.textContent, 'Filter Project Tasks');
    assert.equal(doc.querySelector('[role="group"][aria-label="Filter Project Tasks"]'), null);
    assert.deepEqual([...filter.options].map(option => option.value), ['all', 'proposed', 'active', 'validation', 'blocked', 'recovery', 'ended', 'stopped', 'cancelled']);
    for (const [value, expected] of [['proposed', 'proposal-a'], ['active', 'run-idle'], ['validation', 'awaiting-validation'], ['blocked', 'blocked'], ['recovery', 'recovery'], ['ended', 'completed'], ['stopped', 'stopped'], ['cancelled', 'cancelled']]) {
      selectOption(doc, dom, 'task-status-filter', value!);
      await settle(30);
      assert.ok(doc.querySelector(`[data-record-id="${expected}"]`));
      if (value !== 'proposed') assert.equal(doc.querySelector('[data-record-kind="proposal"]'), null);
      if (value === 'stopped') assert.equal(doc.querySelector('[data-record-id="cancelled"]'), null);
      if (value === 'cancelled') assert.equal(doc.querySelector('[data-record-id="stopped"]'), null);
    }
    const root = doc.querySelector('.project-tasks-view')!;
    const split = doc.querySelector('[data-task-layout="split"]')!;
    const list = doc.querySelector('aside[aria-label="Project Task list"]')!;
    assert.ok(root.classList.contains('h-full') && root.classList.contains('min-h-0'));
    assert.ok(split.classList.contains('flex-1') && split.classList.contains('min-h-0') && split.classList.contains('overflow-hidden'));
    assert.ok(list.classList.contains('min-h-0'));
    assert.equal(list.classList.contains('border'), false, 'filter and list have no parent container chrome');
    assert.ok(list.querySelector('.overflow-y-auto'));
    const splitClasses = split.className;
    let detailClasses: string | undefined;
    for (const id of ['run-idle', 'awaiting-validation', 'completed']) {
      await openTaskRecord(router, id);
      const detail = doc.querySelector('[aria-label="Selected Task details"]')!;
      assert.ok(detail.classList.contains('min-h-0') && detail.classList.contains('overflow-y-auto'));
      detailClasses ??= detail.className;
      assert.equal(detail.className, detailClasses);
      assert.equal(split.className, splitClasses, 'different detail lengths never change the bounded pane contract');
      assert.equal(doc.querySelector('[data-task-layout="split"]'), split);
    }
    app.unmount();
  } finally { await cleanup(); }
});

test('Project Tasks distinguishes stopped from cancelled in badges, detail copy and status filters', async () => {
  const { dom, doc, vite, cleanup } = await setupHarness();
  try {
    const { app, router } = await mountTasks(vite, doc);
    selectOption(doc, dom, 'task-status-filter', 'stopped');
    await settle(30);
    const stoppedRow = doc.querySelector<HTMLElement>('[data-record-id="stopped"]');
    assert.ok(stoppedRow);
    assert.match(stoppedRow.textContent ?? '', /Stopped/);
    assert.match(stoppedRow.textContent ?? '', /Task stopped · No active Agent run · Lease released/);
    assert.equal(doc.querySelector('[data-record-id="cancelled"]'), null, 'the stopped filter excludes deliberate cancellation');

    await openTaskRecord(router, 'stopped');
    const details = doc.querySelector<HTMLElement>('[aria-label="Selected Task details"]');
    assert.ok(details);
    assert.match(details.textContent ?? '', /Stopped/);
    assert.match(details.textContent ?? '', /Task stopped · No active Agent run · Lease released/);
    assert.ok(doc.querySelector('aside[aria-label="Project Task list"]')?.className.includes('lg:flex'), 'the same status badge renders in the desktop list pane');
    assert.ok(details.querySelector('button.lg\\:hidden'), 'the same status copy renders in the mobile detail pane');

    selectOption(doc, dom, 'task-status-filter', 'cancelled');
    await settle(30);
    assert.ok(doc.querySelector('[data-record-id="cancelled"]'));
    assert.equal(doc.querySelector('[data-record-id="stopped"]'), null, 'the cancelled filter excludes emergency stops');
    app.unmount();
  } finally { await cleanup(); }
});

test('Project Tasks presents typed 409 conflicts with actionable guidance', async () => {
  const codes = [
    'advance-conflict', 'environment-recovering', 'lifecycle-conflict', 'pause-retry-required',
    'stale-proposal', 'project-read-only', 'agent-read-only', 'proposal-closed', 'lead-ineligible', 'environment-ineligible',
    'no-compatible-agent', 'target-ineligible', 'not-awaiting-recovery', 'lease-cannot-resume', 'environment-unavailable',
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
      /Environment could not be reserved.*proposal remains unbegun/,
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

test('Project Tasks renders the server-owned reason for a terminal blocker refusal', async () => {
  const { dom, doc, vite, cleanup } = await setupHarness();
  try {
    const { app, router } = await mountTasks(vite, doc, ['terminal-task']);
    await openTaskRecord(router, 'blocked');
    await enterField(doc, dom, 'Reason for this action', 'The blocker is historical.');
    clickButton(doc, 'Clear blocker');
    await settle(160);
    const alert = doc.querySelector<HTMLElement>('[role="alert"][data-conflict-code="terminal-task"]');
    assert.match(alert?.textContent ?? '', /This Task is cancelled; its blocker is historical\./);
    assert.doesNotMatch(alert?.textContent ?? '', /changed before the action completed|try again/i);
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

test('Project Tasks renders and marks Human-substituted completion claims for Agent-led Tasks', async () => {
  const { dom, doc, vite, cleanup } = await setupHarness();
  try {
    const { app, router } = await mountTasks(vite, doc);
    await openTaskRecord(router, 'agent-led-idle');
    const claimSection = [...doc.querySelectorAll('section')].find((section) =>
      section.querySelector('h3')?.textContent?.includes('Human-substituted completion claim'));
    assert.ok(claimSection, 'an eligible Agent-led Task exposes a Human-substituted claim section');
    assert.match(claimSection.textContent ?? '', /Human may submit a Human-substituted claim on this Agent-led Task/i);

    await openTaskRecord(router, 'agent-led-awaiting');
    assert.match(doc.body.textContent ?? '', /Human-substituted/);
    assert.match(doc.body.textContent ?? '', /Human-substituted completion claim submitted/);
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

test('running Tasks expose a reason-gated, confirmed one-step stop for the active run', async () => {
  const { dom, doc, vite, cleanup } = await setupHarness();
  try {
    const { app, router, calls, controlInputs } = await mountTasks(vite, doc);
    await openTaskRecord(router, 'run-running');
    let stop = [...doc.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Stop active run');
    assert.ok(stop, 'a running Task exposes an active-run stop control');
    assert.equal(stop.disabled, true, 'the stop control requires an action reason');
    assert.match(doc.body.textContent ?? '', /Enter a reason to enable actions that require one/);
    assert.ok([...doc.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent?.trim() === 'Pause Task'));
    assert.equal([...doc.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Interrupt active run'), undefined,
      'the pause-requested Interrupt remains specific to its existing window');

    await enterField(doc, dom, 'Reason for this action', 'Stop the active turn before the review.');
    stop = [...doc.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Stop active run');
    assert.ok(stop && !stop.disabled, 'a reason enables the active-run stop control');
    stop.click();
    await settle();
    const confirmation = doc.querySelector<HTMLElement>('[aria-label="Confirm stop for active Agent run"]');
    assert.ok(confirmation, 'the initial action opens an explicit confirmation');
    assert.match(confirmation.textContent ?? '', /Task remains unfinished and paused/);
    assert.match(confirmation.textContent ?? '', /Environment lease stays held/);
    assert.deepEqual(calls.filter((call) => call.startsWith('pause:') || call.startsWith('interrupt:')), [],
      'opening confirmation does not submit either server action');
    clickButton(doc, 'Cancel stop');
    await settle();
    assert.equal(doc.querySelector('[aria-label="Confirm stop for active Agent run"]'), null);

    clickButton(doc, 'Stop active run');
    await settle();
    clickButton(doc, 'Confirm stop active run');
    await settle(180);
    assert.deepEqual(calls.filter((call) => call.startsWith('pause:') || call.startsWith('interrupt:')),
      ['pause:run-running', 'interrupt:run-running'], 'one confirmation requests Pause then immediately interrupts the current run');
    assert.deepEqual(controlInputs.map(({ action, taskId, reason }) => ({ action, taskId, reason })), [
      { action: 'pause', taskId: 'run-running', reason: 'Stop the active turn before the review.' },
      { action: 'interrupt', taskId: 'run-running', reason: 'Stop the active turn before the review.' },
    ]);
    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Project Tasks exposes authorized proposal, intervention, validation, discard, and recovery actions', async () => {
  const { dom, doc, vite, cleanup } = await setupHarness();
  try {
    const { app, router, calls, beginInputs } = await mountTasks(vite, doc);
    await router.push({ name: 'project-task-proposal', params: { proposalId: 'proposal-a' }, query: { project: projectId } });
    await settle();
    clickButton(doc, 'Approve & Begin');
    await settle();
    const environment = [...doc.querySelectorAll<HTMLSelectElement>('select')].find((select) => select.closest('label')?.textContent?.includes('Environment instance'));
    assert.ok(environment);
    assert.equal(environment.value, 'instance-a');
    const beginForm = [...doc.querySelectorAll('form')].find(form => form.textContent?.includes('Confirm approve and begin'));
    assert.ok(beginForm);
    assert.equal([...beginForm.querySelectorAll('label')].some(label => label.textContent?.includes('Approval reason')), false);
    clickButton(doc, 'Confirm approve and begin');
    await settle(180);
    assert.ok(calls.includes('begin'), 'approve-and-begin uses the proposal admission port');
    assert.equal('reason' in (beginInputs[0] as object), false, 'approval submits no fabricated reason');

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
    assert.equal([...doc.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Stop active run'), undefined,
      'Pause-requested Tasks retain the existing Interrupt control instead of showing a second stop path');
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
    const recoveryBanner = doc.querySelector<HTMLElement>('[aria-labelledby="task-recovery-title"]');
    assert.ok(recoveryBanner, 'recovery banner names the inline recovery controls');
    assert.ok([...recoveryBanner.querySelectorAll('button')].some((button) => button.textContent?.includes('Resume Task recovery')),
      'recovery banner contains its Resume action');
    assert.ok([...recoveryBanner.querySelectorAll('button')].some((button) => button.textContent?.includes('Discard through recovery')),
      'recovery banner contains its Discard action');
    assert.match(recoveryBanner.textContent ?? '', /Use a recovery action below first.*completion claim is available only when the Task is idle and its lead is Human/s);
    assert.match(recoveryBanner.textContent ?? '', /This Task is Agent-led.*completion claim is unavailable; choose Discard below to end it/s);
    assert.equal([...doc.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent?.trim() === 'Resume Task'), false,
      'recovery does not expose the normal paused-Task Resume action');
    assert.equal([...doc.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent?.trim() === 'Clear blocker'), false,
      'recovery does not expose the normal Clear blocker action');
    await openTaskRecord(router, 'recovery-running');
    assert.equal([...doc.querySelectorAll<HTMLButtonElement>('button')].some((button) => ['Pause Task', 'Interrupt active run', 'Stop active run'].includes(button.textContent?.trim() ?? '')), false,
      'recovery does not expose normal controls for an interrupted active run');
    assert.ok(doc.querySelector('[aria-labelledby="task-recovery-title"]'), 'interrupted run remains actionable through recovery controls');
    await openTaskRecord(router, 'recovery');
    assert.ok(doc.querySelector('[aria-labelledby="task-recovery-title"]'));
    await enterField(doc, dom, 'Reason for recovery decision', 'Retry after checking recovery facts.');
    clickButton(doc, 'Resume Task recovery');
    await settle(180);
    assert.ok(calls.includes('recover:recovery:resume'));
    await openTaskRecord(router, 'recovery');
    await enterField(doc, dom, 'Reason for recovery decision', 'Abandon the Task during recovery.');
    clickButton(doc, 'Discard through recovery');
    await settle(180);
    assert.ok(calls.includes('recover:recovery:discard'));

    await openTaskRecord(router, 'recovery-ending');
    const endingRecoveryBanner = doc.querySelector<HTMLElement>('[aria-labelledby="task-recovery-title"]');
    assert.ok(endingRecoveryBanner);
    assert.ok([...endingRecoveryBanner.querySelectorAll('button')].some((button) => button.textContent?.includes('Retry safe Task end')),
      'recovery with an accepted end disposition can retry that safe end');
    assert.equal([...endingRecoveryBanner.querySelectorAll('button')].some((button) => /Resume|Discard/.test(button.textContent ?? '')), false,
      'recovery with an accepted end disposition cannot promise Resume or Discard');
    assert.match(endingRecoveryBanner.textContent ?? '', /finish the recorded completion disposition/);
    await enterField(doc, dom, 'Reason for recovery decision', 'Finish the accepted completion cleanup.');
    clickButton(doc, 'Retry safe Task end');
    await settle(180);
    assert.ok(calls.includes('end:recovery-ending'));

    await openTaskRecord(router, 'recovery-cancelled-ending');
    const cancelledRecoveryBanner = doc.querySelector<HTMLElement>('[aria-labelledby="task-recovery-title"]');
    assert.ok(cancelledRecoveryBanner);
    assert.match(cancelledRecoveryBanner.textContent ?? '', /cancellation cleanup is in progress/);
    assert.ok([...cancelledRecoveryBanner.querySelectorAll('button')].some((button) => button.textContent?.includes('Retry Task discard')),
      'recovery with a cancelled end disposition retries Discard through recovery authority');
    assert.equal([...cancelledRecoveryBanner.querySelectorAll('button')].some((button) => button.textContent?.includes('Retry safe Task end')), false,
      'cancelled disposition does not call the completed-only end command');
    await enterField(doc, dom, 'Reason for recovery decision', 'Retry cancellation cleanup.');
    clickButton(doc, 'Retry Task discard');
    await settle(180);
    assert.ok(calls.includes('recover:recovery-cancelled-ending:discard'));

    await openTaskRecord(router, 'ending');
    await enterField(doc, dom, 'Reason for this action', 'Retry accepted completion cleanup.');
    clickButton(doc, 'Retry safe Task end');
    await settle(180);
    assert.ok(calls.includes('end:ending'));
    await openTaskRecord(router, 'completed');
    const reopen = [...doc.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Reopen Task');
    assert.ok(reopen && !reopen.disabled, 'terminal Tasks expose the deliberate Reopen command');
    assert.equal([...doc.querySelectorAll<HTMLButtonElement>('button')].some((button) => ['Pause Task', 'Resume Task', 'Discard Task'].includes(button.textContent?.trim() ?? '')), false,
      'terminal Tasks do not expose ordinary active lifecycle commands');
    await openTaskRecord(router, 'cancelled');
    assert.equal([...doc.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent?.includes('Clear blocker') && !button.disabled), false,
      'terminal Tasks with historical blockers expose no actionable Clear blocker control');
    assert.equal([...doc.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent?.includes('Resume Task')), false,
      'terminal Tasks do not expose Resume even when a stale pause state is present');
    const masterList = doc.querySelector<HTMLElement>('aside[aria-label="Project Task list"]');
    assert.ok(masterList?.className.includes('hidden') && masterList.className.includes('lg:flex'), 'the master list becomes a desktop pane while detail fills the phone');
    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Project Tasks exposes a confirmed Reopen action with explicit reset and preservation copy', async () => {
  const { dom, doc, vite, cleanup } = await setupHarness();
  try {
    const { app, router, calls } = await mountTasks(vite, doc);
    await openTaskRecord(router, 'stopped');
    clickButton(doc, 'Reopen Task');
    await settle();
    const confirmation = doc.querySelector<HTMLElement>('[aria-label="Confirm Task reopen"]');
    assert.ok(confirmation, 'an ended Task requires explicit confirmation');
    assert.match(confirmation.textContent ?? '', /same Environment/i);
    assert.match(confirmation.textContent ?? '', /fresh Task context/i);
    assert.match(confirmation.textContent ?? '', /does not start a run/i);
    assert.match(confirmation.textContent ?? '', /run history.*control history.*Force Release facts.*Project workspace/i);
    assert.equal(calls.some((call) => call.startsWith('reopen:')), false, 'opening confirmation does not send the command');

    await enterField(doc, dom, 'Reason for this action', 'Continue the unfinished work after review.');
    clickButton(doc, 'Confirm Reopen Task');
    await settle(180);
    assert.ok(calls.includes('reopen:stopped:Continue the unfinished work after review.'));
    app.unmount();
  } finally {
    await cleanup();
  }
});

test('Project Tasks links each authority and browser back restores the selected Task', async () => {
  const { dom, doc, vite, cleanup } = await setupHarness();
  try {
    const { app, router } = await mountTasks(vite, doc);
    doc.querySelector<HTMLButtonElement>('[data-record-kind="task"][data-record-id="run-not-owned"]')?.click();
    await settle();
    assert.equal(router.currentRoute.value.name, 'project-task-detail');
    assert.equal(router.currentRoute.value.params['taskId'], 'run-not-owned');

    const project = doc.querySelector<HTMLAnchorElement>('[data-task-authority="project"]');
    const agent = doc.querySelector<HTMLAnchorElement>('[data-task-authority="agent"]');
    const environment = doc.querySelector<HTMLAnchorElement>('[data-task-authority="environment"]');
    const run = doc.querySelector<HTMLAnchorElement>('[data-task-run-target="run-human-initiated"]');
    assert.ok(project, 'Task exposes its Project authority');
    assert.ok(agent, 'Task exposes its Agent lead authority');
    assert.ok(environment, 'Task resolves its Environment instance to the managed Environment record');
    assert.ok(run, 'Task exposes a run attribution destination');
    for (const link of doc.querySelectorAll<HTMLElement>('[data-task-authority], [data-task-run-target]')) {
      assert.match(link.className, /min-h-\[44px\]/, 'each Task authority link remains touch-sized');
    }

    doc.querySelector<HTMLAnchorElement>('[data-task-authority="project"]')!.click();
    await settle();
    assert.equal(router.currentRoute.value.name, 'project-overview');
    assert.equal(router.currentRoute.value.query['project'], projectId);
    router.back();
    await settle(220);
    assert.equal(router.currentRoute.value.name, 'project-task-detail');
    assert.equal(router.currentRoute.value.params['taskId'], 'run-not-owned');

    doc.querySelector<HTMLAnchorElement>('[data-task-authority="environment"]')!.click();
    await settle();
    assert.equal(router.currentRoute.value.name, 'environment-detail');
    assert.equal(router.currentRoute.value.params['id'], 'env-a');
    router.back();
    await settle(220);
    assert.equal(router.currentRoute.value.name, 'project-task-detail');

    doc.querySelector<HTMLAnchorElement>('[data-task-authority="agent"]')!.click();
    await settle();
    assert.equal(router.currentRoute.value.name, 'agent-detail');
    assert.equal(router.currentRoute.value.params['agentId'], 'agent-a');
    router.back();
    await settle(220);
    assert.equal(router.currentRoute.value.name, 'project-task-detail');

    doc.querySelector<HTMLAnchorElement>('[data-task-run-target="run-human-initiated"]')!.click();
    await settle();
    assert.equal(router.currentRoute.value.name, 'agent-detail');
    assert.equal(router.currentRoute.value.params['agentId'], 'agent-a');
    assert.equal(router.currentRoute.value.query['run'], 'run-human-initiated');
    router.back();
    await settle(220);
    assert.equal(router.currentRoute.value.name, 'project-task-detail');
    assert.equal(router.currentRoute.value.params['taskId'], 'run-not-owned');
    app.unmount();
  } finally {
    await cleanup();
  }
});
