import { refreshRecipientsOnProjectChange } from './recipient-refresh';
import { eligibleTaskAgents, taskActivity, taskContextState, taskFailureMessage } from './task-controls';

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
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
  readonly createdAt: number;
  readonly completedAt?: number;
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
  readonly holderKind?: 'run' | 'task';
  readonly state: string;
}

interface ProjectView {
  readonly id: string;
  readonly goal: string;
  readonly memberIds: readonly string[];
}

interface TaskView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly status: string;
  readonly assignedAgentId?: string;
  readonly environmentInstanceId?: string;
  readonly environmentLeaseId?: string;
  readonly environmentLifecycleState?: string;
  readonly taskContextState: string;
  readonly recoveryState?: string;
  readonly activeRunId?: string;
  readonly blockerReason?: string;
}

interface TaskRunLinkView {
  readonly runId: string;
  readonly agentId: string;
  readonly sequence: number;
  readonly summary?: { readonly status: string; readonly summary: string };
}

interface TaskWithRunsView {
  readonly task: TaskView;
  readonly runs: readonly TaskRunLinkView[];
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
const taskForm = document.querySelector<HTMLFormElement>('#task-form');
const taskProjectSelect = document.querySelector<HTMLSelectElement>('#task-project');
const taskAgentSelect = document.querySelector<HTMLSelectElement>('#task-agent');
const taskTitle = document.querySelector<HTMLInputElement>('#task-title');
const taskGoal = document.querySelector<HTMLTextAreaElement>('#task-goal');
const taskConstraints = document.querySelector<HTMLTextAreaElement>('#task-constraints');
const taskError = document.querySelector<HTMLElement>('#task-error');
const taskList = document.querySelector<HTMLElement>('#task-list');

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
  !messageStream ||
  !taskForm ||
  !taskProjectSelect ||
  !taskAgentSelect ||
  !taskTitle ||
  !taskGoal ||
  !taskConstraints ||
  !taskError ||
  !taskList
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
const taskFormEl: HTMLFormElement = taskForm;
const taskProjectSelectEl: HTMLSelectElement = taskProjectSelect;
const taskAgentSelectEl: HTMLSelectElement = taskAgentSelect;
const taskTitleEl: HTMLInputElement = taskTitle;
const taskGoalEl: HTMLTextAreaElement = taskGoal;
const taskConstraintsEl: HTMLTextAreaElement = taskConstraints;
const taskErrorEl: HTMLElement = taskError;
const taskListEl: HTMLElement = taskList;

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
  const taskOption = document.createElement('option');
  taskOption.value = project.id;
  taskOption.textContent = project.id;
  taskProjectSelectEl.append(taskOption);
}
renderRecipients();
renderTaskAgentOptions();

channelSelectEl.addEventListener('change', renderRecipients);
refreshRecipientsOnProjectChange(projectSelectEl, renderRecipients);
taskProjectSelectEl.addEventListener('change', renderTaskAgentOptions);

taskFormEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = taskTitleEl.value.trim();
  const goal = taskGoalEl.value.trim();
  if (title === '' || goal === '' || taskProjectSelectEl.value === '') {
    showTaskError('Choose a Project, title, and goal.');
    return;
  }
  const constraints = taskConstraintsEl.value
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  await submitTaskCommand(null, taskFormEl.querySelector('button'), async () => {
    const response = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: taskProjectSelectEl.value,
        title,
        goal,
        constraints,
        ...(taskAgentSelectEl.value !== '' ? { assignedAgentId: taskAgentSelectEl.value } : {}),
      }),
    });
    if (!response.ok) throw new Error(await responseError(response));
    taskTitleEl.value = '';
    taskGoalEl.value = '';
    taskConstraintsEl.value = '';
  });
});

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
await refreshTasks();

// One event stream carries every run's progress, so the client never polls and
// never has to guess when a run changed.
const stream = new EventSource('/api/events');
stream.addEventListener('run', (event) => {
  const run = JSON.parse((event as MessageEvent<string>).data) as RunView;
  render(run);
  void loadLeases().then(renderLeases);
  void refreshTasks();
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

/** Populate the Task owner/next-Agent choices from the selected Project only. */
function renderTaskAgentOptions(): void {
  const project = projects.find((candidate) => candidate.id === taskProjectSelectEl.value);
  const eligible = eligibleTaskAgents(project, agents);
  taskAgentSelectEl.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'No default Agent';
  taskAgentSelectEl.append(none);
  for (const agent of eligible) {
    const option = document.createElement('option');
    option.value = agent.id;
    option.textContent = agent.name ?? agent.id;
    taskAgentSelectEl.append(option);
  }
}

async function refreshTasks(): Promise<void> {
  const tasks = await loadTasks();
  const details = await Promise.all(tasks.map((task) => loadTask(task.id)));
  const complete = details.filter((detail): detail is TaskWithRunsView => detail !== undefined);
  renderTasks(complete);
}

async function loadTasks(): Promise<readonly TaskView[]> {
  try {
    const response = await fetch('/api/tasks');
    if (!response.ok) return [];
    const body = (await response.json()) as { tasks?: TaskView[] };
    return body.tasks ?? [];
  } catch {
    return [];
  }
}

async function loadTask(taskId: string): Promise<TaskWithRunsView | undefined> {
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`);
    return response.ok ? (await response.json()) as TaskWithRunsView : undefined;
  } catch {
    return undefined;
  }
}

/** Render Tasks under their Project boundary, never mixed into Message controls. */
function renderTasks(tasks: readonly TaskWithRunsView[]): void {
  const byProject = new Map<string, TaskWithRunsView[]>();
  for (const task of tasks) {
    const group = byProject.get(task.task.projectId) ?? [];
    group.push(task);
    byProject.set(task.task.projectId, group);
  }
  const projectIds = new Set([...projects.map((project) => project.id), ...byProject.keys()]);
  taskListEl.replaceChildren(
    ...[...projectIds].map((projectId) => {
      const section = document.createElement('section');
      section.className = 'task-project';
      const heading = document.createElement('h3');
      heading.textContent = projectId;
      section.append(heading);
      const entries = byProject.get(projectId) ?? [];
      if (entries.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'hint';
        empty.textContent = 'No Tasks yet.';
        section.append(empty);
      } else {
        section.append(...entries.map(renderTaskCard));
      }
      return section;
    }),
  );
}

function renderTaskCard(detail: TaskWithRunsView): HTMLElement {
  const { task, runs } = detail;
  const card = document.createElement('article');
  card.className = 'task-card';
  card.dataset.task = task.id;

  const header = document.createElement('header');
  const title = document.createElement('h4');
  title.textContent = task.title;
  const status = document.createElement('span');
  status.className = 'status';
  status.dataset.status = task.status;
  status.textContent = task.status;
  header.append(title, status);

  const goal = document.createElement('p');
  goal.className = 'prompt';
  goal.textContent = task.goal;
  const facts = document.createElement('ul');
  facts.className = 'task-facts';
  const lifecycle = task.environmentLifecycleState;
  const lease = task.environmentLeaseId === undefined
    ? 'Not held (Task has not begun)'
    : lifecycle === 'ended' || lifecycle === 'discarded'
      ? `Released after context cleanup (${lifecycle})`
      : `${task.environmentInstanceId ?? 'selected environment'} retained by Task (${lifecycle ?? 'unknown'})`;
  appendFact(facts, 'Activity', taskActivity(task));
  appendFact(facts, 'Default Agent', task.assignedAgentId ?? 'Unassigned');
  appendFact(facts, 'Environment', task.environmentInstanceId ?? 'Not selected');
  appendFact(facts, 'Task lease', lease);
  appendFact(facts, 'Task context', taskContextState(task));
  if (task.constraints.length > 0) appendFact(facts, 'Constraints', task.constraints.join(' · '));
  if (task.blockerReason !== undefined) appendFact(facts, 'Blocker', task.blockerReason);

  const runList = document.createElement('ol');
  runList.className = 'task-runs';
  if (runs.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = lifecycle === undefined ? 'No Agent run: begin this Task explicitly.' : 'No Agent run: Task is active and Agent idle.';
    runList.append(empty);
  } else {
    for (const run of runs) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = `#run-${run.runId}`;
      link.textContent = `${run.sequence}. ${run.agentId}`;
      item.append(link, document.createTextNode(run.summary ? ` — ${run.summary.status}: ${run.summary.summary}` : ' — current run'));
      if (task.activeRunId === run.runId) item.className = 'task-run-current';
      runList.append(item);
    }
  }

  const actions = document.createElement('div');
  actions.className = 'task-actions';
  if (lifecycle === undefined) {
    const begin = actionButton('Begin Task', () => taskCommand(task.id, begin, 'Beginning Task and preparing its context…', 'begin'));
    actions.append(begin);
  } else if (lifecycle === 'recovery') {
    const resume = actionButton('Resume Task', () => taskCommand(task.id, resume, 'Resuming the owning Task lease…', 'recovery', { action: 'resume' }));
    const discard = actionButton('Preserve/discard and end', () => taskCommand(task.id, discard, 'Cleaning up preserved Task context before release…', 'recovery', { action: 'discard' }));
    actions.append(resume, discard);
  } else if (!['ended', 'discarded', 'ending'].includes(lifecycle ?? '')) {
    if (task.activeRunId === undefined) {
      const agentField = document.createElement('label');
      agentField.className = 'field';
      agentField.textContent = 'Next Agent';
      const agent = document.createElement('select');
      agent.className = 'task-next-agent';
      const project = projects.find((candidate) => candidate.id === task.projectId);
      for (const candidate of eligibleTaskAgents(project, agents)) {
        const option = document.createElement('option');
        option.value = candidate.id;
        const name = candidate.name ?? candidate.id;
        option.textContent = candidate.id === task.assignedAgentId ? `${name} (default)` : name;
        agent.append(option);
      }
      agentField.append(agent);
      const advance = actionButton('Advance Task', () => taskCommand(task.id, advance, 'Starting nested Agent run; Task lease remains retained…', 'runs', { agentId: agent.value }));
      const validate = actionButton('Await human validation', () => taskCommand(task.id, validate, 'Retaining environment while awaiting validation…', 'validation'));
      actions.append(agentField, advance, validate);
    }
    const end = actionButton('End Task', () => taskCommand(task.id, end, 'Cleaning up Task context before releasing lease…', 'end'));
    end.disabled = task.activeRunId !== undefined;
    actions.append(end);
  }

  const actionStatus = document.createElement('p');
  actionStatus.className = 'task-action-status';
  actionStatus.hidden = true;
  card.append(header, goal, facts, runList, actions, actionStatus);
  return card;
}

function appendFact(list: HTMLUListElement, label: string, value: string): void {
  const item = document.createElement('li');
  const strong = document.createElement('strong');
  strong.textContent = `${label}: `;
  item.append(strong, document.createTextNode(value));
  list.append(item);
}

function actionButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

async function taskCommand(
  taskId: string,
  button: HTMLButtonElement,
  progress: string,
  command: 'begin' | 'runs' | 'end' | 'recovery' | 'validation',
  body: Record<string, string> = {},
): Promise<void> {
  const card = button.closest<HTMLElement>('[data-task]');
  const status = card?.querySelector<HTMLElement>('.task-action-status');
  await submitTaskCommand(status ?? null, button, async () => {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/${command}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await responseError(response));
  }, progress);
}

async function submitTaskCommand(
  status: HTMLElement | null,
  button: HTMLButtonElement | null,
  command: () => Promise<void>,
  progress = '',
): Promise<void> {
  if (button) button.disabled = true;
  if (status && progress !== '') {
    status.textContent = progress;
    status.hidden = false;
    status.classList.remove('task-action-error');
  }
  hideTaskError();
  try {
    await command();
    await refreshTasks();
  } catch (error) {
    const message = taskFailureMessage(error instanceof Error ? error.message : String(error));
    if (status) {
      status.textContent = message;
      status.hidden = false;
      status.classList.add('task-action-error');
    }
    showTaskError(message);
  } finally {
    if (button) button.disabled = false;
  }
}

async function responseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Task command was rejected (${response.status})`;
}

function showTaskError(message: string): void {
  taskErrorEl.textContent = message;
  taskErrorEl.hidden = false;
}

function hideTaskError(): void {
  taskErrorEl.textContent = '';
  taskErrorEl.hidden = true;
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

  // A Task-held lease is resolved only through its owning Task's recovery
  // controls. Offering the run-lease release action here would imply that an
  // operator can discard unfinished Task work without its cleanup path.
  if (lease.state === 'recovering' && lease.holderKind !== 'task') {
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

  const duration = element.querySelector<HTMLElement>('.duration');
  if (duration) duration.textContent = formatDuration(run);

  const tokenUsage = element.querySelector<HTMLElement>('.token-usage');
  if (tokenUsage) tokenUsage.textContent = formatTokenUsage(run.tokenUsage);

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

  const metrics = document.createElement('dl');
  metrics.className = 'run-metrics';
  const duration = document.createElement('div');
  const durationLabel = document.createElement('dt');
  durationLabel.textContent = 'Duration';
  const durationValue = document.createElement('dd');
  durationValue.className = 'duration';
  duration.append(durationLabel, durationValue);
  const tokenUsage = document.createElement('div');
  const tokenUsageLabel = document.createElement('dt');
  tokenUsageLabel.textContent = 'Tokens';
  const tokenUsageValue = document.createElement('dd');
  tokenUsageValue.className = 'token-usage';
  tokenUsage.append(tokenUsageLabel, tokenUsageValue);
  metrics.append(duration, tokenUsage);

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

  article.append(header, prompt, metrics, events, failure, actions);
  return article;
}

function formatDuration(run: RunView): string {
  if (run.completedAt === undefined) return 'In progress';
  const milliseconds = Math.max(0, run.completedAt - run.createdAt);
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function formatTokenUsage(tokenUsage: RunView['tokenUsage']): string {
  if (tokenUsage === undefined) return 'Unavailable';
  return `${tokenUsage.totalTokens.toLocaleString()} total (${tokenUsage.promptTokens.toLocaleString()} prompt, ${tokenUsage.completionTokens.toLocaleString()} completion)`;
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
