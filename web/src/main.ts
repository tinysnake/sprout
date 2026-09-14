import { refreshRecipientsOnProjectChange } from './recipient-refresh';

/**
 * The M1 Web client.
 *
 * It renders run state, the project channel, and forwards three commands —
 * submit a request, stop a run, and post a Message. It holds no domain rules:
 * leases, environment access, engine choice, and the wake contract are the
 * server's business (ADR-0002 defers UI-library choice, so this is plain DOM).
 *
 * The collaboration surface (#27) is deliberately observational: it shows the
 * projected conversation, each Message's wake requests and their durable status,
 * and the non-wake observations (suppression, failure) that would otherwise be a
 * console line. Private run events stay in the run inspector below; nothing here
 * merges tool output or reasoning into conversation.
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

interface ProjectView {
  readonly id: string;
  readonly goal: string;
  readonly memberIds: readonly string[];
}

interface MessageView {
  readonly id: string;
  readonly projectId: string;
  readonly channel: string;
  readonly authorId: string;
  readonly authorKind: string;
  readonly body: string;
  readonly recipients: readonly string[];
  readonly inReplyTo?: string;
  readonly createdAt: number;
}

interface WakeView {
  readonly agentId: string;
  readonly reason: string;
  readonly status: string;
  readonly runId?: string;
}

interface ObservationView {
  readonly agentId: string;
  readonly status: string;
  readonly reason: string;
  readonly detail: string;
}

interface MessageDetail {
  readonly wakes: readonly WakeView[];
  readonly observations: readonly ObservationView[];
}

/** The identity the Web client posts as. There is no authentication at M1. */
const WEB_AUTHOR_ID = 'operator';

const form = document.querySelector<HTMLFormElement>('#request-form');
const agentSelect = document.querySelector<HTMLSelectElement>('#agent');
const promptInput = document.querySelector<HTMLTextAreaElement>('#prompt');
const runsRoot = document.querySelector<HTMLElement>('#runs');
const messageForm = document.querySelector<HTMLFormElement>('#message-form');
const projectSelect = document.querySelector<HTMLSelectElement>('#project');
const channelSelect = document.querySelector<HTMLSelectElement>('#channel');
const recipientsField = document.querySelector<HTMLElement>('#recipients-field');
const recipientsRoot = document.querySelector<HTMLElement>('#recipients');
const messageBody = document.querySelector<HTMLTextAreaElement>('#message-body');
const messageError = document.querySelector<HTMLElement>('#message-error');
const messageStream = document.querySelector<HTMLUListElement>('#message-stream');

if (
  !form ||
  !agentSelect ||
  !promptInput ||
  !runsRoot ||
  !messageForm ||
  !projectSelect ||
  !channelSelect ||
  !recipientsField ||
  !recipientsRoot ||
  !messageBody ||
  !messageError ||
  !messageStream
) {
  throw new Error('the Sprout client markup is incomplete');
}

// Narrowed aliases: TypeScript does not carry the null-check narrowing above
// into the hoisted function declarations below, so bind the checked values once.
const messageFormEl: HTMLFormElement = messageForm;
const projectSelectEl: HTMLSelectElement = projectSelect;
const channelSelectEl: HTMLSelectElement = channelSelect;
const recipientsFieldEl: HTMLElement = recipientsField;
const recipientsRootEl: HTMLElement = recipientsRoot;
const messageBodyEl: HTMLTextAreaElement = messageBody;
const messageErrorEl: HTMLElement = messageError;
const messageStreamEl: HTMLUListElement = messageStream;

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

/**
 * The collaboration composer and stream (#27).
 *
 * The project list is the only state that must load before the form is usable;
 * the stream reloads from the durable source after any delivery and after run
 * progress, so a projected reply appears without polling.
 */
const projects = await loadProjects();
for (const project of projects) {
  const option = document.createElement('option');
  option.value = project.id;
  option.textContent = project.id;
  projectSelectEl.append(option);
}
renderRecipients();

channelSelectEl.addEventListener('change', renderRecipients);
refreshRecipientsOnProjectChange(projectSelectEl, renderRecipients);

messageFormEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = messageBodyEl.value.trim();
  const project = projects.find((candidate) => candidate.id === projectSelectEl.value);
  if (body === '' || !project) {
    showMessageError('Choose a project and write a Message.');
    return;
  }
  const channel = channelSelectEl.value === 'direct' ? 'direct' : 'project';
  const recipients =
    channel === 'direct'
      ? [...recipientsRootEl.querySelectorAll<HTMLInputElement>('input:checked')].map(
          (input) => input.value,
        )
      : [];
  if (channel === 'direct' && recipients.length === 0) {
    showMessageError('A direct message needs at least one recipient.');
    return;
  }

  const submit = messageFormEl.querySelector('button');
  if (submit) submit.disabled = true;
  hideMessageError();
  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        channel,
        authorId: WEB_AUTHOR_ID,
        authorKind: 'human',
        body,
        ...(channel === 'direct' ? { recipients } : {}),
        deliveryKey: newDeliveryKey(),
      }),
    });
    if (!response.ok) {
      const failure = (await response.json().catch(() => ({}))) as { error?: string };
      showMessageError(failure.error ?? `the message was rejected (${response.status})`);
      return;
    }
    messageBodyEl.value = '';
    await refreshMessages();
  } finally {
    if (submit) submit.disabled = false;
  }
});

await refreshMessages();

// One event stream carries every run's progress, so the client never polls and
// never has to guess when a run changed.
const stream = new EventSource('/api/events');
stream.addEventListener('run', (event) => {
  const run = JSON.parse((event as MessageEvent<string>).data) as RunView;
  render(run);
  void loadLeases().then(renderLeases);
  // A collaboration wake admits a run, and its reply is projected once that run
  // settles; reloading the stream on progress is what surfaces the reply.
  scheduleMessageRefresh();
});

/** Coalesce the bursts of run events one admitted run produces. */
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleMessageRefresh(): void {
  if (refreshTimer !== undefined) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refreshMessages();
  }, 250);
}

async function loadProjects(): Promise<readonly ProjectView[]> {
  try {
    const response = await fetch('/api/projects');
    if (!response.ok) return [];
    const body = (await response.json()) as { projects?: ProjectView[] };
    return body.projects ?? [];
  } catch {
    return [];
  }
}

function renderRecipients(): void {
  const direct = channelSelectEl.value === 'direct';
  recipientsFieldEl.hidden = !direct;
  if (!direct) {
    recipientsRootEl.replaceChildren();
    return;
  }
  const project = projects.find((candidate) => candidate.id === projectSelectEl.value);
  const memberIds = project?.memberIds ?? [];
  if (memberIds.length === 0) {
    recipientsRootEl.replaceChildren(document.createTextNode('This project has no members.'));
    return;
  }
  recipientsRootEl.replaceChildren(
    ...memberIds.map((agentId) => {
      const label = document.createElement('label');
      label.className = 'recipient';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = agentId;
      label.append(checkbox, document.createTextNode(agentId));
      return label;
    }),
  );
}

/**
 * Reload the durable conversation and its wake/observation detail.
 *
 * Messages come from `GET /api/messages`; each Message's wakes and observations
 * come from `GET /api/messages/:id/observations`. The detail requests run in
 * parallel because the stream is small at M1 size.
 */
async function refreshMessages(): Promise<void> {
  const messages = await loadMessages();
  const details = await Promise.all(messages.map((message) => loadDetail(message.id)));
  const detailById = new Map(messages.map((message, index) => [message.id, details[index]]));
  renderMessages(messages, detailById);
}

async function loadMessages(): Promise<readonly MessageView[]> {
  try {
    const response = await fetch('/api/messages');
    if (!response.ok) return [];
    const body = (await response.json()) as { messages?: MessageView[] };
    return body.messages ?? [];
  } catch {
    return [];
  }
}

async function loadDetail(messageId: string): Promise<MessageDetail> {
  try {
    const response = await fetch(`/api/messages/${encodeURIComponent(messageId)}/observations`);
    if (!response.ok) return { wakes: [], observations: [] };
    const body = (await response.json()) as Partial<MessageDetail>;
    return { wakes: body.wakes ?? [], observations: body.observations ?? [] };
  } catch {
    return { wakes: [], observations: [] };
  }
}

function renderMessages(
  messages: readonly MessageView[],
  detailById: ReadonlyMap<string, MessageDetail | undefined>,
): void {
  const bodyById = new Map(messages.map((message) => [message.id, message]));
  messageStreamEl.replaceChildren(
    ...messages.map((message) => renderMessage(message, detailById.get(message.id), bodyById)),
  );
}

function renderMessage(
  message: MessageView,
  detail: MessageDetail | undefined,
  bodyById: ReadonlyMap<string, MessageView>,
): HTMLLIElement {
  const item = document.createElement('li');
  item.className = `message message-${message.authorKind} message-${message.channel}`;
  item.dataset.message = message.id;

  const header = document.createElement('header');
  const author = document.createElement('span');
  author.className = `author author-${message.authorKind}`;
  author.textContent =
    message.authorKind === 'agent' ? `agent ${message.authorId}` : `human ${message.authorId}`;
  const meta = document.createElement('span');
  meta.className = 'message-meta';
  meta.textContent = `${message.channel === 'direct' ? 'direct' : 'project channel'} · ${formatTime(message.createdAt)}`;
  header.append(author, meta);

  const body = document.createElement('p');
  body.className = 'message-body';
  body.textContent = message.body;

  item.append(header);

  if (message.inReplyTo !== undefined) {
    const link = document.createElement('p');
    link.className = 'reply-link';
    const target = bodyById.get(message.inReplyTo);
    const anchor = document.createElement('a');
    anchor.href = `#message-${message.inReplyTo}`;
    anchor.textContent = `↳ reply to ${target ? `${target.authorKind} ${target.authorId}` : message.inReplyTo}`;
    link.append(anchor);
    if (target) {
      const snippet = document.createElement('span');
      snippet.className = 'reply-snippet';
      snippet.textContent = ` — ${truncate(target.body, 80)}`;
      link.append(snippet);
    }
    item.append(link);
  }

  if (message.recipients.length > 0) {
    const recipients = document.createElement('p');
    recipients.className = 'message-recipients';
    recipients.textContent = `to ${message.recipients.join(', ')}`;
    item.append(recipients);
  }

  item.append(body);
  item.append(renderWakeSection(detail));

  // The anchor target for reply links; `id` on an `li` is valid and lets a
  // click scroll to the answered Message without extra script.
  item.id = `message-${message.id}`;
  return item;
}

function renderWakeSection(detail: MessageDetail | undefined): HTMLElement {
  const section = document.createElement('div');
  section.className = 'wakes';

  const wakes = detail?.wakes ?? [];
  if (wakes.length > 0) {
    const list = document.createElement('ul');
    list.className = 'wake-list';
    for (const wake of wakes) {
      const entry = document.createElement('li');
      entry.className = `wake wake-${wake.status}`;

      const label = document.createElement('span');
      label.className = 'wake-target';
      label.textContent = `${wake.agentId} — ${reasonLabel(wake.reason)} `;
      const status = document.createElement('span');
      status.className = 'wake-status';
      status.textContent = wake.status;
      entry.append(label, status);

      if (wake.runId !== undefined) {
        const runLink = document.createElement('a');
        runLink.className = 'wake-run';
        runLink.href = `#run-${wake.runId}`;
        runLink.textContent = ` · run ${wake.runId}`;
        entry.append(runLink);
      }
      list.append(entry);
    }
    section.append(list);
  } else {
    const none = document.createElement('p');
    none.className = 'wake-none';
    none.textContent = 'No wake requests.';
    section.append(none);
  }

  // Suppression and failure are the outcomes that would otherwise be invisible:
  // they are shown as their own list, not folded into the wake list, because
  // "woke nobody and said why" is the fact the operator needs.
  const observations = detail?.observations ?? [];
  if (observations.length > 0) {
    const list = document.createElement('ul');
    list.className = 'observation-list';
    for (const observation of observations) {
      const entry = document.createElement('li');
      entry.className = `observation observation-${observation.status}`;
      entry.textContent = `${observation.status} (${observation.reason}, ${observation.agentId}): ${observation.detail}`;
      list.append(entry);
    }
    section.append(list);
  }

  return section;
}

function reasonLabel(reason: string): string {
  // The domain value for an `@all` broadcast is `broadcast`; the operator-facing
  // label matches the wake contract's name for it.
  return reason === 'broadcast' ? 'all-broadcast' : reason;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function newDeliveryKey(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `web-${random}`;
}

function showMessageError(text: string): void {
  messageErrorEl.textContent = text;
  messageErrorEl.hidden = false;
}

function hideMessageError(): void {
  messageErrorEl.textContent = '';
  messageErrorEl.hidden = true;
}

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
  // The target a collaboration wake's run link scrolls to (#27).
  article.id = `run-${run.id}`;

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
