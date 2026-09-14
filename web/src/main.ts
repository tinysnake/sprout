export {};

/**
 * The M1 Web client.
 *
 * It renders run state and forwards two commands — submit and stop. It holds no
 * domain rules: leases, environment access, and engine choice are the server's
 * business (ADR-0002 defers UI-library choice, so this is plain DOM).
 */

interface RunEvent {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly detail?: string;
  readonly final?: boolean;
}

interface RunView {
  readonly id: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly status: string;
  readonly events: readonly RunEvent[];
  readonly failure?: string;
  readonly result?: { readonly status?: string; readonly text?: string; readonly message?: string };
}

interface AgentView {
  readonly id: string;
  readonly name: string;
}

interface LeaseView {
  readonly id: string;
  readonly instanceId: string;
  readonly capability: string;
  readonly holderId: string;
  readonly state: string;
}

const form = document.querySelector<HTMLFormElement>('#request-form');
const agentSelect = document.querySelector<HTMLSelectElement>('#agent');
const promptInput = document.querySelector<HTMLTextAreaElement>('#prompt');
const runsRoot = document.querySelector<HTMLElement>('#runs');

if (!form || !agentSelect || !promptInput || !runsRoot) {
  throw new Error('the Sprout client markup is incomplete');
}

const agents = await loadAgents();
for (const agent of agents) {
  const option = document.createElement('option');
  option.value = agent.id;
  option.textContent = agent.name;
  agentSelect.append(option);
}

const initialLeases = await loadLeases();
renderLeases(initialLeases);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = promptInput.value.trim();
  if (prompt === '') return;

  const submit = form.querySelector('button');
  if (submit) submit.disabled = true;
  try {
    await fetch('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: agentSelect.value, prompt }),
    });
    promptInput.value = '';
  } finally {
    if (submit) submit.disabled = false;
  }
});

// One event stream carries every run's progress, so the client never polls and
// never has to guess when a run changed.
const stream = new EventSource('/api/events');
stream.addEventListener('run', (event) => {
  const run = JSON.parse((event as MessageEvent<string>).data) as RunView;
  render(run);
  void loadLeases().then(renderLeases);
});

async function loadLeases(): Promise<readonly LeaseView[]> {
  try {
    const response = await fetch('/api/leases');
    const body = (await response.json()) as { leases?: LeaseView[] };
    return body.leases ?? [];
  } catch {
    return [];
  }
}

function renderLeases(leases: readonly LeaseView[]): void {
  const leaseList = document.querySelector<HTMLUListElement>('#lease-list');
  if (!leaseList) return;
  const activeOrRecovering = leases.filter((l) => l.state === 'active' || l.state === 'recovering');
  if (activeOrRecovering.length === 0) {
    leaseList.replaceChildren();
    const empty = document.createElement('li');
    empty.textContent = 'No active or recovering leases.';
    leaseList.append(empty);
    return;
  }
  leaseList.replaceChildren(...activeOrRecovering.map(renderLeaseItem));
}

function renderLeaseItem(lease: LeaseView): HTMLLIElement {
  const item = document.createElement('li');
  item.className = `lease lease-${lease.state}`;
  const label = document.createElement('span');
  label.textContent = `${lease.instanceId} (${lease.capability}) — ${lease.holderId} [${lease.state}]`;
  item.append(label);

  if (lease.state === 'recovering') {
    const releaseBtn = document.createElement('button');
    releaseBtn.type = 'button';
    releaseBtn.textContent = 'Release Recovery';
    releaseBtn.addEventListener('click', async () => {
      releaseBtn.disabled = true;
      try {
        await fetch(`/api/leases/${lease.id}/release`, { method: 'POST' });
        const updated = await loadLeases();
        renderLeases(updated);
      } finally {
        releaseBtn.disabled = false;
      }
    });
    item.append(releaseBtn);
  }
  return item;
}

async function loadAgents(): Promise<readonly AgentView[]> {
  try {
    const response = await fetch('/api/agents');
    const body = (await response.json()) as { agents?: AgentView[] };
    return body.agents ?? [];
  } catch {
    return [];
  }
}

function render(run: RunView): void {
  const existing = runsRoot?.querySelector<HTMLElement>(`[data-run="${run.id}"]`);
  const element = existing ?? createRunElement(run);
  if (!existing) runsRoot?.prepend(element);

  const status = element.querySelector<HTMLElement>('.status');
  if (status) {
    status.textContent = run.status;
    status.dataset.status = run.status;
  }

  const events = element.querySelector<HTMLUListElement>('.events');
  if (events) {
    events.replaceChildren(...run.events.map(renderEvent));
  }

  const failure = element.querySelector<HTMLElement>('.failure');
  if (failure) {
    failure.textContent = run.failure ?? '';
    failure.hidden = run.failure === undefined;
  }

  const stop = element.querySelector<HTMLButtonElement>('button.stop');
  if (stop) {
    stop.hidden = run.status !== 'running' && run.status !== 'queued';
  }
}

function createRunElement(run: RunView): HTMLElement {
  const article = document.createElement('article');
  article.className = 'run';
  article.dataset.run = run.id;

  const header = document.createElement('header');
  const title = document.createElement('h2');
  title.textContent = run.agentId;
  const status = document.createElement('span');
  status.className = 'status';
  header.append(title, status);

  const prompt = document.createElement('p');
  prompt.className = 'prompt';
  prompt.textContent = run.prompt;

  const events = document.createElement('ul');
  events.className = 'events';

  const failure = document.createElement('p');
  failure.className = 'failure';
  failure.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'actions';
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'stop';
  stop.textContent = 'Stop';
  stop.addEventListener('click', () => {
    stop.disabled = true;
    void fetch(`/api/runs/${run.id}/stop`, { method: 'POST' }).finally(() => {
      stop.disabled = false;
    });
  });
  actions.append(stop);

  article.append(header, prompt, events, failure, actions);
  return article;
}

function renderEvent(event: RunEvent): HTMLLIElement {
  const item = document.createElement('li');
  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = event.type;
  item.append(kind, document.createTextNode(describe(event)));
  return item;
}

function describe(event: RunEvent): string {
  switch (event.type) {
    case 'message':
      return event.final ? `${event.text ?? ''} (final)` : (event.text ?? '');
    case 'tool-call':
      return `${event.name ?? 'tool'}: ${event.detail ?? ''}`;
    case 'tool-output':
      return event.text ?? '';
    case 'notice':
      return event.text ?? '';
    default:
      return JSON.stringify(event);
  }
}
