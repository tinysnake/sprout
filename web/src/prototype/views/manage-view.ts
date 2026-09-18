import type { PrototypeState } from '../state.js';
import { renderEnvironmentsView } from './environments-view.js';
import { renderAgentsView } from './agents-view.js';
import { renderUsageView } from './usage-view.js';
import { renderSettingsView } from './settings-view.js';

export function renderManageView(state: PrototypeState): HTMLElement {
  const container = document.createElement('div');
  container.className = 'manage-view';

  // Content Area according to manageTab
  const contentArea = document.createElement('div');
  contentArea.className = 'manage-content-area';

  if (state.manageTab === 'environments') {
    contentArea.appendChild(renderEnvironmentsView(state));
  } else if (state.manageTab === 'agents') {
    contentArea.appendChild(renderAgentsView(state));
  } else if (state.manageTab === 'usage') {
    contentArea.appendChild(renderUsageView(state));
  } else if (state.manageTab === 'settings') {
    contentArea.appendChild(renderSettingsView(state));
  } else {
    contentArea.appendChild(renderEnvironmentsView(state));
  }

  container.appendChild(contentArea);

  return container;
}
