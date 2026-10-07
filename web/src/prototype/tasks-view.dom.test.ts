import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setupPrototypeDom } from './dom-harness.ts';

test('archived Tasks view classifies active intent and ended statuses from the shared Task taxonomy', async () => {
  const { vite, cleanup } = await setupPrototypeDom();
  try {
    const { stateManager } = (await vite.ssrLoadModule('/src/prototype/state.ts')) as typeof import('./state.js');
    const { renderTasksView } = (await vite.ssrLoadModule('/src/prototype/views/tasks-view.ts')) as typeof import('./views/tasks-view.js');
    const base = stateManager.getSnapshot();
    const projectId = base.selectedProjectId;
    const template = base.tasks.find((task) => task.projectId === projectId);
    assert.ok(template, 'the selected Project has a Task fixture');

    const tasks = ([
      'stopped',
      'paused',
      'active',
      'Task pause requested',
      'blocked',
      'awaiting validation',
      'recovery',
      'ending',
      'completed',
      'failed',
      'cancelled',
      'proposed',
      'rejected',
      'withdrawn',
    ] as const).map((lifecycle, index) => ({
      ...structuredClone(template),
      id: `task-status-${index}`,
      projectId,
      lifecycle,
    }));
    const render = (taskFilter: string) => renderTasksView({
      ...base,
      tasks,
      taskFilter,
      taskViewMode: 'list',
      selectedTaskId: '',
    });
    const taskIds = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.task-grid-card')]
      .map((card) => card.dataset.task);

    const allTasks = render('all');
    const filter = allTasks.querySelector<HTMLSelectElement>('#task-filter-select');
    assert.ok(filter);
    assert.match(filter.querySelector('[value="active"]')?.textContent ?? '', /\(8\)/,
      'all active-intent statuses, including stopped and paused, contribute to the active count');
    assert.match(filter.querySelector('[value="ended"]')?.textContent ?? '', /\(3\)/,
      'completed, failed, and cancelled contribute to the ended count');
    assert.ok(allTasks.querySelector('[data-task="task-status-0"] .status-pill.green'),
      'stopped uses the active-intent badge treatment');
    assert.deepEqual(taskIds(render('active')), [
      'task-status-0', 'task-status-1', 'task-status-2', 'task-status-3',
      'task-status-4', 'task-status-5', 'task-status-6', 'task-status-7',
    ]);
    assert.deepEqual(taskIds(render('ended')), ['task-status-8', 'task-status-9', 'task-status-10']);

    const stoppedDetail = renderTasksView({
      ...base,
      tasks,
      taskFilter: 'all',
      taskViewMode: 'detail',
      selectedTaskId: 'task-status-0',
    });
    assert.ok(stoppedDetail.querySelector('.lifecycle-detail-row .status-pill.green'),
      'the stopped Task detail badge also uses the active-intent treatment');
  } finally {
    await cleanup();
  }
});
