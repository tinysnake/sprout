/**
 * Render the actual index markup and execute the production entry point through
 * a stateful network boundary.  These tests deliberately click the controls
 * rather than invoking presentation helpers or main.ts internals.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

interface TaskView {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  constraints: string[];
  status: string;
  taskContextState: string;
  assignedAgentId?: string;
  environmentInstanceId?: string;
  environmentLeaseId?: string;
  environmentLifecycleState?: string;
  recoveryState?: string;
  activeRunId?: string;
}

interface TaskFixture {
  task: TaskView;
  runs: Array<{ runId: string; agentId: string; sequence: number; summary?: { status: string; summary: string } }>;
}

interface FetchCall {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

class TestEventSource {
  static latest: TestEventSource | undefined;
  readonly #listeners = new Map<string, Array<(event: { data: string }) => void>>();

  constructor(_url: string) {
    TestEventSource.latest = this;
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  emit(type: string, value: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(value) });
    }
  }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fixture(id: string, title: string, fields: Partial<TaskView> = {}): TaskFixture {
  return {
    task: {
      id,
      projectId: 'project-sprout',
      title,
      goal: `${title} goal`,
      constraints: [],
      status: 'todo',
      taskContextState: 'not-created',
      ...fields,
    },
    runs: [],
  };
}

async function eventually(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`timed out waiting for ${description}`);
}

function card(document: Document, taskId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-task="${taskId}"]`);
  assert.ok(element, `Task card ${taskId} is rendered`);
  return element;
}

function taskText(document: Document, taskId: string): string {
  return card(document, taskId).textContent ?? '';
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent === label);
  assert.ok(found, `${label} button is rendered`);
  return found;
}

test('the rendered client drives Task lifecycle controls through the fetch boundary', async () => {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), {
    url: 'http://sprout.test/',
  });
  const { document } = dom.window;
  const tasks = new Map<string, TaskFixture>([
    ['task-unbegun', fixture('task-unbegun', 'Unbegun Task')],
    ['task-stop', fixture('task-stop', 'Stopped run holder', {
      status: 'in-progress',
      taskContextState: 'ready',
      assignedAgentId: 'pi-agent',
      environmentInstanceId: 'mac-1',
      environmentLeaseId: 'lease-stop',
      environmentLifecycleState: 'running',
      activeRunId: 'run-stop',
    })],
    ['task-conflict', fixture('task-conflict', 'Conflicting begin')],
    ['task-resume', fixture('task-resume', 'Resume recovery', {
      status: 'blocked',
      taskContextState: 'recovery-retained',
      assignedAgentId: 'pi-agent',
      environmentInstanceId: 'mac-2',
      environmentLeaseId: 'lease-resume',
      environmentLifecycleState: 'recovery',
      recoveryState: 'running',
    })],
    ['task-discard', fixture('task-discard', 'Discard recovery', {
      status: 'blocked',
      taskContextState: 'cleanup-needs-recovery',
      assignedAgentId: 'pi-agent',
      environmentInstanceId: 'mac-3',
      environmentLeaseId: 'lease-discard',
      environmentLifecycleState: 'recovery',
      recoveryState: 'ending',
    })],
    ['task-cleanup', fixture('task-cleanup', 'Cleanup failure', {
      status: 'in-progress',
      taskContextState: 'ready',
      assignedAgentId: 'pi-agent',
      environmentInstanceId: 'mac-4',
      environmentLeaseId: 'lease-cleanup',
      environmentLifecycleState: 'idle',
    })],
    ['task-end', fixture('task-end', 'Successful end', {
      status: 'in-progress',
      taskContextState: 'ready',
      assignedAgentId: 'pi-agent',
      environmentInstanceId: 'mac-5',
      environmentLeaseId: 'lease-end',
      environmentLifecycleState: 'idle',
    })],
  ]);
  tasks.get('task-stop')!.runs.push({ runId: 'run-stop', agentId: 'pi-agent', sequence: 1 });

  const requests: FetchCall[] = [];
  let conflictResponse: Response | undefined;
  const leases = () => [...tasks.values()]
    .filter(({ task }) => task.environmentLeaseId !== undefined && !['ended', 'discarded'].includes(task.environmentLifecycleState ?? ''))
    .map(({ task }) => ({
      id: task.environmentLeaseId!,
      instanceId: task.environmentInstanceId!,
      capability: 'agent-run',
      holderId: task.id,
      holderKind: 'task',
      state: task.environmentLifecycleState === 'recovery' ? 'recovering' : 'active',
    }));

  const fetchBoundary: typeof fetch = async (input, init) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ path, method, body });

    if (path === '/api/agents') return response({ agents: [
      { id: 'pi-agent', name: 'Pi' },
      { id: 'codex-agent', name: 'Codex' },
      { id: 'outside-agent', name: 'Outside' },
    ] });
    if (path === '/api/projects') return response({ projects: [{ id: 'project-sprout', goal: 'Ship', memberIds: ['pi-agent', 'codex-agent'] }] });
    if (path === '/api/leases') return response({ leases: leases() });
    if (path === '/api/messages') return response({ messages: [] });
    if (path === '/api/tasks') return response({ tasks: [...tasks.values()].map(({ task }) => task) });

    const detail = /^\/api\/tasks\/([^/]+)$/.exec(path);
    if (detail && method === 'GET') {
      const found = tasks.get(detail[1]!);
      return found ? response(found) : response({ error: `unknown task: ${detail[1]}` }, 404);
    }

    if (path === '/api/runs/run-stop/stop' && method === 'POST') {
      const stopped = tasks.get('task-stop')!.task;
      stopped.environmentLifecycleState = 'blocked';
      stopped.taskContextState = 'ready';
      delete stopped.activeRunId;
      return response({ id: 'run-stop', status: 'stopped' });
    }
    if (path === '/api/tasks/task-stop/runs' && method === 'POST') {
      return response({ task: tasks.get('task-stop')!.task, runId: 'run-corrected' }, 202);
    }
    if (path === '/api/tasks/task-conflict/begin' && method === 'POST') {
      conflictResponse = response({ error: 'environment mac-1 is unavailable: held by task-owner (recovering)' }, 409);
      return conflictResponse;
    }
    if (path === '/api/tasks/task-resume/recovery' && method === 'POST') {
      const resumed = tasks.get('task-resume')!.task;
      resumed.environmentLifecycleState = 'blocked';
      resumed.taskContextState = 'ready';
      delete resumed.recoveryState;
      return response({ task: resumed });
    }
    if (path === '/api/tasks/task-discard/recovery' && method === 'POST') {
      const discarded = tasks.get('task-discard')!.task;
      discarded.status = 'cancelled';
      discarded.environmentLifecycleState = 'discarded';
      discarded.taskContextState = 'recycled';
      delete discarded.recoveryState;
      return response({ task: discarded });
    }
    if (path === '/api/tasks/task-cleanup/end' && method === 'POST') {
      const cleanup = tasks.get('task-cleanup')!.task;
      cleanup.environmentLifecycleState = 'recovery';
      cleanup.recoveryState = 'ending';
      cleanup.taskContextState = 'cleanup-needs-recovery';
      return response({ error: 'Task context cleanup failed; lease remains retained for recovery' }, 409);
    }
    if (path === '/api/tasks/task-end/end' && method === 'POST') {
      const ended = tasks.get('task-end')!.task;
      ended.status = 'done';
      ended.environmentLifecycleState = 'ended';
      ended.taskContextState = 'recycled';
      return response({ task: ended });
    }
    return response({ error: `not found: ${path}` }, 404);
  };

  const global = globalThis as Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLFormElement: dom.window.HTMLFormElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLUListElement: dom.window.HTMLUListElement,
    EventSource: TestEventSource,
    fetch: fetchBoundary,
  };
  const originals = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true },
  });

  try {
    // Vite resolves the production module's extensionless browser imports just
    // as the shipped Web client does; no handler is imported or invoked directly.
    await vite.ssrLoadModule('/src/main.ts');
    await eventually(() => document.querySelectorAll('[data-task]').length === tasks.size, 'initial Task cards');

    // (a) An unbegun Task is distinct from a begun Task whose Agent is now idle.
    assert.match(taskText(document, 'task-unbegun'), /Activity: Unbegun/);

    // Stop comes from the real run inspector, not a Task helper. Its stream update
    // reloads the Task and lease surfaces exactly as the production client does.
    TestEventSource.latest!.emit('run', {
      id: 'run-stop', agentId: 'pi-agent', prompt: 'Initial step', status: 'running', events: [],
    });
    await eventually(() => document.querySelector('.run .stop') !== null, 'run inspector stop control');
    button(document.querySelector('.run')!, 'Stop').click();
    await eventually(() => requests.some((request) => request.path === '/api/runs/run-stop/stop'), 'stop request');
    TestEventSource.latest!.emit('run', {
      id: 'run-stop', agentId: 'pi-agent', prompt: 'Initial step', status: 'stopped', events: [],
    });
    await eventually(() => taskText(document, 'task-stop').includes('Activity: Task active · Agent idle'), 'retained idle Task');
    assert.match(taskText(document, 'task-stop'), /Task lease: mac-1 retained by Task \(blocked\)/);

    // Completed history arrives on the same run stream as live updates. The
    // inspector keeps duration and provider metrics visible for either source.
    TestEventSource.latest!.emit('run', {
      id: 'run-history',
      agentId: 'codex-agent',
      prompt: 'Completed before this page loaded',
      status: 'completed',
      events: [],
      createdAt: 1_000,
      completedAt: 2_500,
      tokenUsage: { promptTokens: 1_200, completionTokens: 300, totalTokens: 1_500 },
    });
    await eventually(
      () => document.querySelector<HTMLElement>('[data-run="run-history"]')?.textContent?.includes('1.5 s') === true,
      'run duration',
    );
    const historyRun = document.querySelector<HTMLElement>('[data-run="run-history"]');
    assert.match(historyRun?.textContent ?? '', /1,500 total \(1,200 prompt, 300 completion\)/);

    // (b, c) The stopped Task retains its Task lease and a Project Agent can be
    // selected for a corrected next advance.
    const stoppedCard = card(document, 'task-stop');
    const nextAgent = stoppedCard.querySelector<HTMLSelectElement>('.task-next-agent');
    assert.ok(nextAgent);
    assert.deepEqual([...nextAgent.options].map((option) => option.value), ['pi-agent', 'codex-agent']);
    nextAgent.value = 'codex-agent';
    button(stoppedCard, 'Advance Task').click();
    await eventually(
      () => requests.some((request) => request.path === '/api/tasks/task-stop/runs' && (request.body as { agentId?: string } | undefined)?.agentId === 'codex-agent'),
      'corrected advance with selected Agent',
    );
    // Allow the successful advance's production refresh to finish before the
    // next card-local action checks its own status message.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // (d) A 409 keeps the owning Task and recovery state visible to the operator.
    button(card(document, 'task-conflict'), 'Begin Task').click();
    await eventually(() => requests.some((request) => request.path === '/api/tasks/task-conflict/begin'), 'begin conflict request');
    assert.equal(conflictResponse?.status, 409);
    await eventually(() => taskText(document, 'task-conflict').includes('task-owner (recovering)'), 'begin conflict message');
    assert.match(document.querySelector('#task-error')?.textContent ?? '', /task-owner \(recovering\)/);

    // (e) Both recovery choices drive the owning Task route; Task-held recovering
    // leases never offer the generic Release Recovery action.
    assert.equal([...document.querySelectorAll('button')].some((control) => control.textContent === 'Release Recovery'), false);
    button(card(document, 'task-resume'), 'Resume Task').click();
    await eventually(() => taskText(document, 'task-resume').includes('Activity: Task active · Agent idle'), 'resumed Task');
    button(card(document, 'task-discard'), 'Preserve/discard and end').click();
    await eventually(() => taskText(document, 'task-discard').includes('Released after context cleanup (discarded)'), 'discarded Task cleanup');

    // (f) Cleanup failure is rendered from the 409 error before release.
    button(card(document, 'task-cleanup'), 'End Task').click();
    await eventually(() => taskText(document, 'task-cleanup').includes('Task context cleanup failed; lease remains retained for recovery'), 'cleanup failure');
    assert.match(document.querySelector('#task-error')?.textContent ?? '', /lease remains retained for recovery/);

    // (g) Successful end reports release only in the post-cleanup terminal view.
    button(card(document, 'task-end'), 'End Task').click();
    await eventually(() => taskText(document, 'task-end').includes('Released after context cleanup (ended)'), 'successful cleanup and release');
    assert.match(taskText(document, 'task-end'), /Task context: Recycled/);
  } finally {
    await vite.close();
    for (const [key, original] of originals) {
      if (original === undefined) delete global[key];
      else Object.defineProperty(globalThis, key, original);
    }
    dom.window.close();
  }
});
