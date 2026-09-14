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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const port = Number(process.env.SPROUT_PORT ?? 41000);
const instanceId = 'live-macos-o6';
const projectId = 'live-o6-project';
const projectToken = 'LIVE-PROJECT-SENTINEL-V1';
const root = await mkdtemp(join(tmpdir(), 'sprout-live-o6-'));
const database = join(root, 'live.sqlite');
const workspaceRoot = join(root, 'worker-workspaces');
const base = `http://127.0.0.1:${port}`;
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

  const validation = await post(`/api/tasks/${taskId}/validation`);
  assert.equal(validation.task.environmentLifecycleState, 'awaiting-validation');
  const contender = await createTask('competing Task must be refused');
  const refused = await request(`/api/tasks/${contender.id}/begin`, 'POST', { agentId: 'pi-b', selection: { kind: 'instance', id: instanceId } });
  assert.equal(refused.status, 409);
  assert.match(String(refused.body.error), new RegExp(taskId));
  assert.equal((await readFile(join(workspace, 'LIVE-REPOSITORY-SENTINEL.md'), 'utf8')).trim(), projectToken);

  // Exercise the visible stop route, then deliberately interrupt a real active
  // Codex run by restarting Sprout. A CLI may acknowledge an interrupt only
  // after a tool turn finishes, so the restart is the deterministic live fault.
  const stopAttemptId = await startAdvance(taskId, 'codex-a', 'Use your shell tool to run `sleep 30` before replying. Do not produce a final answer before the command finishes.');
  console.log('stage: stop control');
  await waitForStatus(stopAttemptId, ['running'], 20_000);
  await post(`/api/runs/${stopAttemptId}/stop`);
  await waitForRun(stopAttemptId);
  const stoppedId = await startAdvance(taskId, 'codex-a', 'Use your shell tool to run `sleep 60` before replying. Do not produce a final answer before the command finishes.');
  console.log('stage: restart interruption');
  await waitForStatus(stoppedId, ['running'], 20_000);

  // SIGTERM starts a fresh production core against the same SQLite/Worker root,
  // making this active adapter run a durable interrupted/failure recovery fact.
  await shutdown();
  await start();
  const afterRestart = await getTask(taskId);
  assert.equal(afterRestart.task.environmentLeaseId, leaseId);
  assert.equal(afterRestart.task.environmentLifecycleState, 'recovery');
  assert.ok(afterRestart.runs.length >= 5);
  assert.ok(['failed', 'interrupted'].includes(String((await waitForRun(stoppedId)).status)));
  await access(join(workspace, '.sprout', 'tasks', token(taskId), 'TASK.md'));
  const restartRefusal = await request(`/api/tasks/${contender.id}/begin`, 'POST', { agentId: 'pi-b', selection: { kind: 'instance', id: instanceId } });
  assert.equal(restartRefusal.status, 409);

  const resumed = await post(`/api/tasks/${taskId}/recovery`, { action: 'resume' });
  assert.equal(resumed.task.environmentLifecycleState, 'blocked');
  console.log('stage: round 2');
  const round2 = [
    await advance(taskId, 'codex-a', `Read TASK.md and verify the interrupted run is summarized. Read LIVE-REPOSITORY-SENTINEL.md. Reply with exactly: CODEX-A-1 corrected after stop and verified ${projectToken}.`),
    await advanceExpected(taskId, 'pi-b', `Read TASK.md and verify CODEX-A-1. Read LIVE-REPOSITORY-SENTINEL.md. Reply with exactly: PI-B-1 verified CODEX-A-1 and ${projectToken}.`, 'PI-B-1'),
    await advance(taskId, 'codex-a', `Read TASK.md and verify PI-B-1. Read LIVE-REPOSITORY-SENTINEL.md. Reply with exactly: CODEX-A-2 verified PI-B-1 and ${projectToken}.`),
  ];
  assertResult(round2[0]!, 'CODEX-A-1');
  assertResult(round2[1]!, 'PI-B-1');
  assertResult(round2[2]!, 'CODEX-A-2');

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

  await writeEvidence({ taskId, leaseId, round1, stoppedId, round2 });
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
    if (serverOutput.includes('Sprout listening')) return;
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

async function getTask(taskId: string): Promise<{ task: Record<string, unknown>; runs: Array<{ runId: string }> }> {
  const response = await request(`/api/tasks/${taskId}`);
  assert.equal(response.status, 200);
  return response.body as { task: Record<string, unknown>; runs: Array<{ runId: string }> };
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
  return serverOutput.replaceAll(root, '<temporary-root>').replaceAll(process.cwd(), '<repository>').slice(-1_500);
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

async function writeEvidence(input: { taskId: string; leaseId: string; round1: readonly Record<string, unknown>[]; stoppedId: string; round2: readonly Record<string, unknown>[] }): Promise<void> {
  for (const value of [input.taskId, input.leaseId, input.stoppedId, ...input.round1.map((run) => String(run.id)), ...input.round2.map((run) => String(run.id))]) alias(value);
  const lines = [
    '# Live macOS Pi/Codex Task validation', '',
    'Sanitized evidence generated by `node scripts/live-macos-pi-codex-task.ts`.', '',
    '## Observations',
    `- Task ${alias(input.taskId)} retained Task lease ${alias(input.leaseId)} on one macOS Environment through all nested runs.`,
    `- Round 1: Pi Agent A (${alias(String(input.round1[0]?.id))}) → Codex Agent B (${alias(String(input.round1[1]?.id))}) → Pi Agent A (${alias(String(input.round1[2]?.id))}); each completed after reporting the shared Project sentinel and prior Task summary.`,
    `- A human-validation gap retained the lease; a competing Task begin was refused while the Worker-owned Project sentinel remained intact.`,
    `- The production stop control was exercised. A separate active Codex Agent A run ${alias(input.stoppedId)} was deliberately interrupted by the real Sprout restart and durably settled interrupted/failed; the retained Task entered recovery, then resumed and corrected re-advance succeeded.`,
    `- A real Sprout restart restored ${alias(input.taskId)}, its pre-restart run links/summaries, Task context, and retained lease; a competing begin remained refused.`,
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
  const next = value.startsWith('task-') ? `T${nextAlias++}` : value.startsWith('lease-') ? `L${nextAlias++}` : `R${nextAlias++}`;
  aliases.set(value, next);
  return next;
}

function token(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 24); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
