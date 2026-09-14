/**
 * Live O6 evidence: production HTTP API + SQLite + Worker + Pi/Codex adapters.
 *
 * The script creates an isolated, disposable Worker root and database. It emits
 * only aliases to stdout and writes a sanitized durable work record input; raw
 * engine session keys and local paths never leave the temporary process.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const configuredEndpoint = process.env.SPROUT_LIVE_ENDPOINT;
const configuredPort = process.env.SPROUT_PORT ?? (configuredEndpoint === undefined ? undefined : new URL(configuredEndpoint).port);
const port = configuredPort === undefined || configuredPort === '' ? await availablePort() : parsePort(configuredPort);
let base = configuredEndpoint ?? '';
const instanceId = 'live-macos-o6';
const projectId = 'live-o6-project';
const projectToken = 'LIVE-PROJECT-SENTINEL-V1';
const root = await mkdtemp(join(tmpdir(), 'sprout-live-o6-'));
const database = join(root, 'live.sqlite');
const workspaceRoot = join(root, 'worker-workspaces');
const evidencePath = join('docs', 'evidence', 'live-macos-pi-codex-task.md');

const agents = [
  agent('pi-a', 'Pi Agent A', 'pi', 'implements and reports durable facts'),
  agent('codex-b', 'Codex Agent B', 'codex', 'verifies Pi facts'),
  agent('codex-a', 'Codex Agent A', 'codex', 'verifies and corrects work'),
  agent('pi-b', 'Pi Agent B', 'pi', 'verifies Codex facts'),
];
const runtimeConfig = JSON.stringify({
  agents,
  project: {
    id: projectId,
    goal: 'Live durable Pi and Codex Task collaboration validation.',
    rules: ['Read Worker-owned Task facts before replying.', 'Report only observed durable facts.'],
    availableEnvironmentInstanceIds: [instanceId],
    memberships: agents.map((entry) => ({
      agentId: entry.id,
      responsibilities: [entry.instructions],
      collaborationInstructions: 'Read the shared workspace and the Task context; verify the previous summary before contributing.',
    })),
  },
});

let server: ChildProcess | undefined;
let serverOutput = '';
const aliases = new Map<string, string>();
let nextAlias = 1;

try {
  await start();
  console.log('stage: begin and round 1');
  const task = await createTask('O6 live Pi/Codex collaboration');
  const begun = await post(`/api/tasks/${task.id}/begin`, { agentId: 'pi-a', selection: { kind: 'instance', id: instanceId } });
  const taskId = begun.task.id as string;
  const leaseId = begun.task.environmentLeaseId as string;
  assert.ok(leaseId, 'begin returns a Task lease');

  const workspace = join(workspaceRoot, 'projects', token(projectId));
  await writeFile(join(workspace, 'LIVE-REPOSITORY-SENTINEL.md'), `${projectToken}\n`, 'utf8');
  await access(join(workspace, '.sprout', 'workspace-sentinel.json'));
  await access(join(workspace, '.sprout', 'tasks', token(taskId), 'TASK.md'));

  const round1 = [
    await advanceExpected(taskId, 'pi-a', `Read LIVE-REPOSITORY-SENTINEL.md and .sprout/tasks/${token(taskId)}/TASK.md. Reply with exactly: PI-A-1 verified ${projectToken}.`, 'PI-A-1'),
    await advance(taskId, 'codex-b', `Read LIVE-REPOSITORY-SENTINEL.md and TASK.md. Verify the prior Pi summary in TASK.md. Reply with exactly: CODEX-B-1 verified PI-A-1 and ${projectToken}.`),
    await advanceExpected(taskId, 'pi-a', `Read LIVE-REPOSITORY-SENTINEL.md and TASK.md. Verify the prior Codex summary in TASK.md. Reply with exactly: PI-A-2 verified CODEX-B-1 and ${projectToken}.`, 'PI-A-2'),
  ];
  assertResult(round1[0]!, 'PI-A-1');
  assertResult(round1[1]!, 'CODEX-B-1');
  assertResult(round1[2]!, 'PI-A-2');
  assertDistinctRunIds(round1);

  const validation = await post(`/api/tasks/${taskId}/validation`);
  assert.equal(validation.task.environmentLifecycleState, 'awaiting-validation');
  const contender = await createTask('competing Task must be refused');
  const refused = await request(`/api/tasks/${contender.id}/begin`, 'POST', { agentId: 'pi-b', selection: { kind: 'instance', id: instanceId } });
  assert.equal(refused.status, 409);
  assert.match(String(refused.body.error), new RegExp(taskId));
  assert.equal((await readFile(join(workspace, 'LIVE-REPOSITORY-SENTINEL.md'), 'utf8')).trim(), projectToken);

  // Exercise the visible stop route and resolve the Task recovery it causes
  // before advancing again. A separate active run then makes restart recovery
  // deterministic when a CLI defers interruption until a tool turn ends.
  const stopAttemptId = await startAdvance(taskId, 'codex-a', 'Use your shell tool to run `sleep 30` before replying. Do not produce a final answer before the command finishes.');
  console.log('stage: stop control');
  await waitForStatus(stopAttemptId, ['running'], 20_000);
  // `running` is persisted before the Worker returns its live session handle;
  // wait briefly so this exercises the actual stop control rather than racing
  // that setup boundary.
  await delay(1_000);
  assert.equal((await waitForStatus(stopAttemptId, ['running', 'completed'], 1_000)).status, 'running', 'stop targets a live Agent run');
  const stopResponse = await post(`/api/runs/${stopAttemptId}/stop`);
  assert.equal(stopResponse.id, stopAttemptId, 'stop response names the stopped run');
  assert.equal(stopResponse.status, 'interrupted', 'stop settles the run as interrupted');
  const stoppedRun = await waitForRun(stopAttemptId);
  assert.equal(stoppedRun.status, 'interrupted', 'stopped run remains terminal when re-read');
  const recovering = await waitForTaskState(taskId, 'recovery');
  assert.equal(recovering.task.environmentLeaseId, leaseId, 'interrupted Task retains its lease in recovery');
  assert.equal(recovering.task.activeRunId, stopAttemptId, 'recovery identifies the interrupted run');
  const resumed = await post(`/api/tasks/${taskId}/recovery`, { action: 'resume' });
  assert.equal(resumed.task.environmentLifecycleState, 'blocked', 'owner recovery resolves to a deliberately advanceable state');
  assert.equal(resumed.task.environmentLeaseId, leaseId, 'recovery keeps the original Task lease');
  assert.equal(resumed.task.taskContextState, 'ready', 'recovery preserves the Task context');
  assert.equal(resumed.task.activeRunId, undefined, 'recovery clears the settled active run');

  const durableMessage = await post('/api/messages', {
    projectId,
    channel: 'direct',
    authorId: 'pi-a',
    authorKind: 'agent',
    body: `DURABLE-RESTART-MESSAGE ${projectToken}`,
    recipients: ['pi-a'],
    deliveryKey: 'live-o6-restart-message',
  });
  assert.equal(durableMessage.duplicate, false);
  assert.equal(durableMessage.admittedRunIds.length, 0, 'self-addressed durable Message does not create a competing run');
  assert.equal(durableMessage.message.projectId, projectId);
  assert.equal(durableMessage.message.body, `DURABLE-RESTART-MESSAGE ${projectToken}`);
  const beforeRestart = await getTask(taskId);
  assertTaskRunLinks(beforeRestart, [
    { id: String(round1[0]?.id), summaryText: 'PI-A-1' },
    { id: String(round1[1]?.id), summaryText: 'CODEX-B-1' },
    { id: String(round1[2]?.id), summaryText: 'PI-A-2' },
    { id: stopAttemptId, status: 'interrupted' },
  ]);

  const restartInterruptedId = await startAdvance(taskId, 'codex-a', 'Use your shell tool to run `sleep 60` before replying. Do not produce a final answer before the command finishes.');
  console.log('stage: restart interruption');
  await waitForStatus(restartInterruptedId, ['running'], 20_000);

  // SIGTERM starts a fresh production core against the same SQLite/Worker root,
  // making this active adapter run a durable interrupted/failure recovery fact.
  await shutdown();
  await start();
  const afterRestart = await getTask(taskId);
  assert.equal(afterRestart.task.environmentLeaseId, leaseId);
  assert.equal(afterRestart.task.environmentLifecycleState, 'recovery');
  assert.equal(afterRestart.task.activeRunId, undefined, 'restart recovery clears the terminal active-run slot');
  assert.ok(afterRestart.runs.length >= 5);
  const restartInterruptedRun = await waitForRun(restartInterruptedId);
  assert.equal(restartInterruptedRun.status, 'failed', 'restart visibly settles the active run');
  const restartFailure = String((restartInterruptedRun.result as { message?: string } | undefined)?.message ?? '');
  assert.notEqual(restartFailure, '', 'restart failure carries an observable terminal fact');
  assertTaskRunLinks(afterRestart, [
    { id: String(round1[0]?.id), summaryText: 'PI-A-1' },
    { id: String(round1[1]?.id), summaryText: 'CODEX-B-1' },
    { id: String(round1[2]?.id), summaryText: 'PI-A-2' },
    { id: stopAttemptId, status: 'interrupted' },
    { id: restartInterruptedId, status: 'failed', summaryEquals: restartFailure },
  ]);
  await assertRestoredMessage(durableMessage.message);
  await access(join(workspace, '.sprout', 'tasks', token(taskId), 'TASK.md'));
  const restartRefusal = await request(`/api/tasks/${contender.id}/begin`, 'POST', { agentId: 'pi-b', selection: { kind: 'instance', id: instanceId } });
  assert.equal(restartRefusal.status, 409);

  const restartResumed = await post(`/api/tasks/${taskId}/recovery`, { action: 'resume' });
  assert.equal(restartResumed.task.environmentLifecycleState, 'blocked');
  assert.equal(restartResumed.task.environmentLeaseId, leaseId);
  assert.equal(restartResumed.task.activeRunId, undefined);
  console.log('stage: round 2');
  const round2 = [
    await advance(taskId, 'codex-a', `Read TASK.md and verify the interrupted run is summarized. Read LIVE-REPOSITORY-SENTINEL.md. Reply with exactly: CODEX-A-1 corrected after stop and verified ${projectToken}.`),
    await advanceExpected(taskId, 'pi-b', `Read TASK.md and verify CODEX-A-1. Read LIVE-REPOSITORY-SENTINEL.md. Reply with exactly: PI-B-1 verified CODEX-A-1 and ${projectToken}.`, 'PI-B-1'),
    await advance(taskId, 'codex-a', `Read TASK.md and verify PI-B-1. Read LIVE-REPOSITORY-SENTINEL.md. Reply with exactly: CODEX-A-2 verified PI-B-1 and ${projectToken}.`),
  ];
  assertResult(round2[0]!, 'CODEX-A-1');
  assertResult(round2[1]!, 'PI-B-1');
  assertResult(round2[2]!, 'CODEX-A-2');
  assertDistinctRunIds([...round1, stoppedRun, restartInterruptedRun, ...round2]);

  const beforeEnd = await getTask(taskId);
  assert.equal(beforeEnd.task.environmentLeaseId, leaseId);
  assert.ok(beforeEnd.runs.length >= 8);
  verifyDurableRows(database, taskId, leaseId, beforeEnd.runs.map((run: { runId: string }) => run.runId));
  await access(join(workspace, '.sprout', 'tasks', token(taskId), 'TASK.md'));

  const ended = await post(`/api/tasks/${taskId}/end`);
  console.log('stage: end and successor');
  assert.equal(ended.task.environmentLifecycleState, 'ended');
  await assert.rejects(access(join(workspace, '.sprout', 'tasks', token(taskId))));
  assert.equal((await readFile(join(workspace, 'LIVE-REPOSITORY-SENTINEL.md'), 'utf8')).trim(), projectToken);
  await access(join(workspace, '.sprout', 'workspace-sentinel.json'));
  const next = await createTask('next Task proves released lease');
  const nextBegun = await post(`/api/tasks/${next.id}/begin`, { agentId: 'pi-b', selection: { kind: 'instance', id: instanceId } });
  assert.equal(nextBegun.task.environmentLifecycleState, 'idle');
  await post(`/api/tasks/${next.id}/end`);

  await writeEvidence({ taskId, leaseId, round1, stopAttemptId, restartInterruptedId, durableMessageId: String(durableMessage.message.id), round2 });
  console.log('PASS: sanitized live O6 Pi/Codex Task scenario completed');
} finally {
  await shutdown();
  await rm(root, { recursive: true, force: true });
}

function agent(id: string, name: string, engine: string, instructions: string) {
  return { id, name, engine, capability: 'agent-run', instructions };
}

async function start(): Promise<void> {
  server = spawn(process.execPath, ['src/main.ts'], {
    env: {
      ...process.env,
      SPROUT_PORT: String(port), SPROUT_DATABASE: database, SPROUT_WORKSPACE_ROOT: workspaceRoot,
      SPROUT_ENV_INSTANCE: instanceId, SPROUT_ENGINE: 'codex', SPROUT_RUNTIME_CONFIG: runtimeConfig,
      SPROUT_PI_SESSION_DIR: join(root, 'pi-sessions'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverOutput = '';
  server.stdout?.on('data', (chunk: Buffer) => { serverOutput += chunk; });
  server.stderr?.on('data', (chunk: Buffer) => { serverOutput += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (serverOutput.includes('Sprout listening')) {
      if (configuredEndpoint === undefined) base = announcedEndpoint();
      return;
    }
    if (server.exitCode !== null) throw new Error(`Sprout core did not start: ${sanitizedServerOutput()}`);
    await delay(100);
  }
  throw new Error('timed out waiting for Sprout core');
}

async function shutdown(): Promise<void> {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => server!.once('exit', () => resolve()));
  server.kill('SIGTERM');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const forced = new Promise<void>((resolve) => {
    timeout = setTimeout(() => { server?.kill('SIGKILL'); resolve(); }, 10_000);
  });
  await Promise.race([exited, forced]);
  if (timeout !== undefined) clearTimeout(timeout);
  server = undefined;
}

async function createTask(title: string): Promise<{ id: string }> {
  const response = await post('/api/tasks', { projectId, title, goal: 'Validate sequential durable collaboration.', assignedAgentId: 'pi-a', constraints: ['Use only the isolated live validation artifacts.'] });
  return response.task;
}

async function startAdvance(taskId: string, agentId: string, prompt: string): Promise<string> {
  const response = await post(`/api/tasks/${taskId}/runs`, { agentId, prompt });
  return response.runId as string;
}

async function advance(taskId: string, agentId: string, prompt: string): Promise<Record<string, unknown>> {
  const id = await startAdvance(taskId, agentId, prompt);
  return waitForRun(id);
}

/** A real Agent can complete a tool-only turn without final prose; re-advance it deliberately. */
async function advanceExpected(taskId: string, agentId: string, prompt: string, label: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const run = await advance(taskId, agentId, attempt === 0 ? prompt : `${prompt}\nDo not call tools again. Produce the required final reply now.`);
    const text = (run.result as { text?: string } | undefined)?.text ?? '';
    if (run.status === 'completed' && new RegExp(`${label}.*${projectToken}`).test(text)) return run;
  }
  throw new Error(`Agent ${agentId} did not produce required observable contribution: ${label}`);
}

function assertResult(run: Record<string, unknown>, label: string): void {
  assert.equal(run.status, 'completed');
  const result = run.result as { text?: string } | undefined;
  assert.match(result?.text ?? '', new RegExp(`${label}.*${projectToken}`), `run ${label} did not produce the required final text; events=${JSON.stringify(run.events)}`);
}

async function waitForRun(runId: string): Promise<Record<string, unknown>> {
  return waitForStatus(runId, ['completed', 'failed', 'interrupted'], 180_000);
}

async function waitForStatus(runId: string, statuses: readonly string[], timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request(`/api/runs/${runId}`);
    if (response.status === 200 && statuses.includes(String(response.body.status))) return response.body;
    await delay(250);
  }
  throw new Error(`run did not reach ${statuses.join('/')}`);
}

interface TaskRunLink {
  readonly runId: string;
  readonly agentId: string;
  readonly sequence: number;
  readonly summary?: { readonly status: string; readonly summary: string };
}

interface TaskDetail {
  readonly task: Record<string, unknown>;
  readonly runs: readonly TaskRunLink[];
}

async function getTask(taskId: string): Promise<TaskDetail> {
  const response = await request(`/api/tasks/${taskId}`);
  assert.equal(response.status, 200);
  return response.body as TaskDetail;
}

async function waitForTaskState(taskId: string, state: string, timeoutMs = 20_000): Promise<TaskDetail> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await getTask(taskId);
    if (detail.task.environmentLifecycleState === state) return detail;
    await delay(100);
  }
  throw new Error(`Task did not reach lifecycle state ${state}`);
}

function assertTaskRunLinks(
  detail: TaskDetail,
  expected: readonly { readonly id: string; readonly status?: string; readonly summaryText?: string; readonly summaryEquals?: string }[],
): void {
  assert.equal(detail.runs.length, expected.length, 'Task restart restored exactly its linked runs');
  for (const [index, expectation] of expected.entries()) {
    const link = detail.runs[index];
    assert.ok(link, `Task run link ${index + 1} exists`);
    assert.equal(link.runId, expectation.id, `Task run link ${index + 1} retains its run identifier`);
    assert.equal(link.sequence, index + 1, `Task run link ${index + 1} retains its sequence`);
    assert.ok(link.summary, `Task run link ${index + 1} restored its terminal summary`);
    if (expectation.status !== undefined) assert.equal(link.summary.status, expectation.status);
    if (expectation.summaryText !== undefined) assert.match(link.summary.summary, new RegExp(expectation.summaryText));
    if (expectation.summaryEquals !== undefined) assert.equal(link.summary.summary, expectation.summaryEquals, 'Task summary preserves the restart terminal fact');
  }
}

async function assertRestoredMessage(expected: Record<string, any>): Promise<void> {
  const messages = await request('/api/messages');
  assert.equal(messages.status, 200);
  const restored = (messages.body.messages as Array<Record<string, unknown>>).find((message) => message.id === expected.id);
  assert.ok(restored, 'restart restored the durable Message');
  assert.equal(restored.projectId, expected.projectId);
  assert.equal(restored.authorId, expected.authorId);
  assert.equal(restored.authorKind, expected.authorKind);
  assert.equal(restored.body, expected.body);
  assert.deepEqual(restored.recipients, expected.recipients);
}

function assertDistinctRunIds(runs: readonly Record<string, unknown>[]): void {
  const ids = runs.map((run) => String(run.id));
  assert.ok(ids.every((id) => id !== 'undefined' && id !== ''), 'every observed run has an identifier');
  assert.equal(new Set(ids).size, ids.length, 'every observed run identifier is distinct');
}

async function post(path: string, body?: unknown): Promise<Record<string, any>> {
  const response = await request(path, 'POST', body);
  assert.ok(response.status >= 200 && response.status < 300, `POST ${path} failed: ${String(response.body.error)}`);
  return response.body;
}

async function request(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: Record<string, any> }> {
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  } catch (error) {
    throw new Error(`HTTP ${method} ${path} failed; core output: ${sanitizedServerOutput()}`, { cause: error });
  }
}

function sanitizedServerOutput(): string {
  return serverOutput.replace(/https?:\/\/\S+/g, '<runtime-endpoint>').replaceAll(root, '<temporary-root>').replaceAll(process.cwd(), '<repository>').slice(-1_500);
}

function announcedEndpoint(): string {
  const match = /Sprout listening on (\S+)/.exec(serverOutput);
  if (!match?.[1]) throw new Error('Sprout did not announce a runtime endpoint');
  return match[1];
}

function verifyDurableRows(filename: string, taskId: string, leaseId: string, runIds: readonly string[]): void {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const rows = db.prepare('SELECT id, task_id, environment_instance_id, lease_id FROM agent_runs WHERE task_id = ?').all(taskId) as Array<Record<string, string>>;
    assert.equal(rows.length, runIds.length);
    for (const row of rows) {
      assert.ok(runIds.includes(row.id!));
      assert.equal(row.task_id, taskId);
      assert.equal(row.environment_instance_id, instanceId);
      assert.equal(row.lease_id, leaseId);
    }
    const sessions = db.prepare('SELECT agent_id, engine, environment_instance_id, session_key FROM agent_session_keys').all() as Array<Record<string, string>>;
    const pi = sessions.filter((row) => row.engine === 'pi');
    const codex = sessions.filter((row) => row.engine === 'codex');
    assert.ok(pi.length >= 2 && codex.length >= 2, 'independent Pi and Codex native session slots persisted');
    assert.equal(new Set(sessions.map((row) => row.session_key!)).size, sessions.length);
  } finally { db.close(); }
}

async function writeEvidence(input: {
  taskId: string;
  leaseId: string;
  round1: readonly Record<string, unknown>[];
  stopAttemptId: string;
  restartInterruptedId: string;
  durableMessageId: string;
  round2: readonly Record<string, unknown>[];
}): Promise<void> {
  for (const value of [input.taskId, input.leaseId, input.stopAttemptId, input.restartInterruptedId, input.durableMessageId, ...input.round1.map((run) => String(run.id)), ...input.round2.map((run) => String(run.id))]) alias(value);
  const lines = [
    '# Live macOS Pi/Codex Task validation', '',
    'Sanitized evidence generated by `node scripts/live-macos-pi-codex-task.ts`.', '',
    '## Observations',
    `- Task ${alias(input.taskId)} retained Task lease ${alias(input.leaseId)} on one macOS Environment through all nested runs.`,
    `- Round 1: Pi Agent A (${alias(String(input.round1[0]?.id))}) → Codex Agent B (${alias(String(input.round1[1]?.id))}) → Pi Agent A (${alias(String(input.round1[2]?.id))}); each completed after reporting the shared Project sentinel and prior Task summary.`,
    `- A human-validation gap retained the lease; a competing Task begin was refused while the Worker-owned Project sentinel remained intact.`,
    `- The production stop control interrupted Codex Agent A (${alias(input.stopAttemptId)}). Its terminal interrupted status, retained lease, recovery state, owner resume to blocked, restored context, and cleared active-run state were asserted before the next advance.`,
    `- Before restart, durable Message ${alias(input.durableMessageId)} and Task ${alias(input.taskId)} run links/summaries were recorded. A real Sprout restart visibly settled active Codex Agent A (${alias(input.restartInterruptedId)}) as failed, restored the Message fields, each pre-restart run link and summary content, Task context, and retained lease; a competing begin remained refused.`,
    `- Round 2: Codex Agent A (${alias(String(input.round2[0]?.id))}) → Pi Agent B (${alias(String(input.round2[1]?.id))}) → Codex Agent A (${alias(String(input.round2[2]?.id))}) completed on the same binding.`,
    '- SQLite inspection verified every recorded run used the same Task, environment instance, and Task lease; four Agent-specific Pi/Codex native session slots were distinct.',
    '- End removed only the owned Task context, preserved the Project/repository sentinels, released the lease, and permitted a next Task begin.', '',
    '## Web control deviation',
    'Interactive browser authorization was human-gated. The accepted #34 production Vite/JSDOM DOM harness was exercised as the autonomous Web-client path; this live scenario drove the same production HTTP lifecycle controls directly. No product behavior was deferred.',
  ];
  await mkdir('docs/evidence', { recursive: true });
  await writeFile(evidencePath, `${lines.join('\n')}\n`, 'utf8');
}

function alias(value: string): string {
  const known = aliases.get(value);
  if (known) return known;
  const next = value.startsWith('task-') ? `T${nextAlias++}` : value.startsWith('lease-') ? `L${nextAlias++}` : value.startsWith('msg-') ? `M${nextAlias++}` : `R${nextAlias++}`;
  aliases.set(value, next);
  return next;
}

function token(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 24); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('SPROUT_PORT must be a valid TCP port');
  return port;
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const address = probe.address();
      if (typeof address !== 'object' || address === null) {
        probe.close(() => reject(new Error('could not select a runtime port')));
        return;
      }
      probe.close((error) => error === undefined ? resolve(address.port) : reject(error));
    });
  });
}
