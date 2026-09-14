import assert from 'node:assert/strict';
import { test } from 'node:test';

import { refreshRecipientsOnProjectChange } from './recipient-refresh.ts';

test('changing a direct-message project replaces recipients with its members', () => {
  const projects = [
    { id: 'project-alpha', memberIds: ['agent-alpha'] },
    { id: 'project-beta', memberIds: ['agent-beta'] },
  ];
  const projectSelect = new EventTarget();
  let selectedProjectId = 'project-alpha';
  let recipients = ['agent-alpha'];

  refreshRecipientsOnProjectChange(projectSelect, () => {
    recipients = [...(projects.find((project) => project.id === selectedProjectId)?.memberIds ?? [])];
  });

  selectedProjectId = 'project-beta';
  projectSelect.dispatchEvent(new Event('change'));

  assert.deepEqual(recipients, ['agent-beta']);
  assert.equal(recipients.includes('agent-alpha'), false);
});
