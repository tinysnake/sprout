import { type PrototypeState } from '../state.js';
import { renderAttentionView } from '../views/attention-view.js';
import { renderProjectsView } from '../views/projects-view.js';
import { renderTasksView } from '../views/tasks-view.js';
import { renderEnvironmentsView } from '../views/environments-view.js';
import { renderAgentsView } from '../views/agents-view.js';
import { renderUsageView } from '../views/usage-view.js';
import { renderOnboardingView } from '../views/onboarding-view.js';

/**
 * Variant B: "Structured Workspace & Tabbed Hub" (Context & Hierarchy Centric)
 *
 * Mental Model: Clear separation of operational domains into distinct tabs:
 * Attention, Projects & Chat, Tasks & Leases, Environments & Workers, Agents, and Usage Telemetry.
 */
export function renderVariantB(state: PrototypeState): HTMLElement {
  switch (state.activeTab) {
    case 'attention':
      return renderAttentionView(state);
    case 'projects':
      return renderProjectsView(state);
    case 'tasks':
      return renderTasksView(state);
    case 'environments':
      return renderEnvironmentsView(state);
    case 'agents':
      return renderAgentsView(state);
    case 'usage':
      return renderUsageView(state);
    case 'onboarding':
      return renderOnboardingView(state);
    default:
      return renderAttentionView(state);
  }
}
