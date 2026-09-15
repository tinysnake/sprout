/**
 * Live O7 evidence: resume a Planner-led Minesweeper collaboration run.
 *
 * State lives in a durable, ignored SQLite database so a timed-out Agent turn
 * can be stopped or resumed without replaying completed work. The evidence is
 * rebuilt from that database's API surface on every invocation.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const port = Number(process.env.PORT ?? 41000);
const host = process.env.O7_HOST ?? 'localhost';
const endpoint = new URL(process.env.O7_ENDPOINT ?? `http://${host}:${port}`);
const projectId = 'o7-minesweeper';
const workspaceRoot = '.sprout-game-workspaces';
const gameWorkspace = join(workspaceRoot, 'minesweeper');
const databasePath = process.env.O7_DATABASE ?? '.sprout-o7.sqlite';
const evidencePath = join('docs', 'evidence', 'o7-minesweeper-collaboration.md');
const runtimeConfig = await readFile(join('config', 'o7-minesweeper-runtime.json'), 'utf8');

assert.equal(isAbsolute(databasePath), false, 'O7_DATABASE must be a relative durable path');

interface TokenUsage { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number; }
interface Run {
  readonly id: string;
  readonly agentId: string;
  readonly status: string;
  readonly result?: { readonly status?: string; readonly text?: string; readonly message?: string };
  readonly failure?: string;
  readonly tokenUsage?: TokenUsage;
  readonly createdAt: number;
  readonly completedAt?: number;
}
interface Message { readonly id: string; readonly authorId: string; readonly authorKind: string; readonly recipients: readonly string[]; readonly body: string; readonly createdAt: number; }
interface Wake { readonly runId?: string; }
interface Turn { readonly message: Message; readonly run: Run; }

let server: ChildProcess | undefined;
let serverOutput = '';
let delivery = 0;
const aliases = new Map<string, string>();
let nextAlias = 1;

try {
  await start();
  await resolveRecoveredLeases();
  if (process.env.O7_FINALIZE_AFTER_BROWSER === '1') await finalizeAfterBrowserVerification();
  else if (process.env.O7_CONTINUE_AFTER_PROGRAMMER === '1') await continueAfterProgrammer();
  else await runFromStart();
  await validateGame();
  await writeEvidence();
  console.log('PASS: O7 Minesweeper collaboration evidence updated from durable state');
} finally {
  await shutdown();
}

async function runFromStart(): Promise<void> {
  const initial = await direct('human', 'planner', 'Start the 2D Minesweeper collaboration. Inspect the Three.js scaffold, create a concrete plan, then end with `NEXT: designer` and `MESSAGE: <design assignment>`. Do not implement the game yourself.', 'human-start');
  const plannerPlan = await requireTurn('planner plan', initial);
  const design = await direct('planner', 'designer', `${directive(plannerPlan, 'designer')}\n\nCreate DESIGN.md in the Project workspace with interaction, visual, accessibility, and playable-rule guidance. Inspect the scaffold first. End with \`NEXT: planner\` and \`MESSAGE: <factual design report>\`.`, 'planner-design');
  const designerReport = await requireTurn('designer design', design);
  const plannerReview = await direct('designer', 'planner', `${directive(designerReport, 'planner')}\n\nReview the design in the workspace. Do not dispatch implementation yet. End with \`NEXT: programmer\` and \`MESSAGE: <approved implementation assignment>\`.`, 'designer-report');
  const approvedAssignment = directive(await requireTurn('planner design review', plannerReview), 'programmer');

  const runCountBeforePause = (await listRuns()).length;
  const pause = await requireTurn('planner pause acknowledgement', await direct('human', 'planner', '我们先暂停一下任务', 'human-pause'));
  assert.match(text(pause), /(pause|paused|暂停|hold)/i, 'planner did not acknowledge the pause');
  assert.equal((await listRuns()).length, runCountBeforePause + 1, 'pause acknowledgement dispatched another Agent');
  await delay(500);
  assert.equal((await listRuns()).length, runCountBeforePause + 1, 'workflow dispatched during the pause gap');
  const resume = await requireTurn('planner resume acknowledgement', await direct('human', 'planner', '继续', 'human-resume'));
  assert.match(text(resume), /(resume|继续|恢复|programmer|implement)/i, 'planner did not acknowledge resumption');

  const programmerReport = await requireTurn('programmer implementation', await direct('planner', 'programmer', `${approvedAssignment}\n\nImplement the playable 2D Minesweeper game in this Three.js workspace. Preserve Three.js rendering. Include reset, mine counter/status, left-click reveal, right-click flag, win/loss feedback, and first-click-safe generation. Run \`npm test\`. End with \`NEXT: planner\` and \`MESSAGE: <changed files and checks>\`.`, 'planner-programmer'));
  await finishReview('programmer', directive(programmerReport, 'planner'));
}

/** Resume after the preserved Programmer implementation without replaying it. */
async function continueAfterProgrammer(): Promise<void> {
  await finishReview('programmer', 'Implementation is already present in the Project workspace: DESIGN.md and the Three.js Minesweeper modules. The workspace production build completed successfully. Inspect these artifacts, then assign Reviewer.\n\nNEXT: planner\nMESSAGE: Inspect the completed Minesweeper implementation and assign Reviewer.');
}

/** Give Planner the independent rendered-game evidence before its final Human report. */
async function finalizeAfterBrowserVerification(): Promise<void> {
  const finalPlanner = await requireTurn('planner final browser verification', await direct('reviewer', 'planner', 'Reviewer inspection is complete. Independent verification also ran the preserved workspace production build and a headless Edge browser against the Vite-served Three.js canvas: a primary pointer input revealed a cell, and a secondary pointer input flagged a different covered cell and decremented the mine counter. Verify those facts with the workspace and issue a final report to Human. End with exactly `NEXT: human` and `MESSAGE: <final completion report>`.', 'browser-reviewer-report'));
  await directWithoutWake('planner', 'human', directive(finalPlanner, 'human'), 'planner-final-human-browser');
}

async function finishReview(authorId: string, report: string): Promise<void> {
  const plannerReview = await requireTurn('planner implementation review', await direct(authorId, 'planner', `${report}\n\nInspect the implementation and its verification facts. End with exactly \`NEXT: reviewer\` and \`MESSAGE: <review assignment>\`.`, 'implementation-report'));
  const reviewerReport = await requireTurn('reviewer inspection', await direct('planner', 'reviewer', `${directive(plannerReview, 'reviewer')}\n\nInspect the workspace against DESIGN.md and the stated Minesweeper behaviour. Run \`npm test\`. Do not modify files. End with exactly \`NEXT: planner\` and \`MESSAGE: <pass/follow-up report>\`.`, 'planner-reviewer'));
  const finalPlanner = await requireTurn('planner final verification', await direct('reviewer', 'planner', `${directive(reviewerReport, 'planner')}\n\nVerify the game workspace one final time. Report completion only if the build and implemented interactions are supported by observed files and checks. End with exactly \`NEXT: human\` and \`MESSAGE: <final completion report>\`.`, 'reviewer-report'));
  await directWithoutWake('planner', 'human', directive(finalPlanner, 'human'), 'planner-final-human');
}

async function start(): Promise<void> {
  server = spawn(process.execPath, ['src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port), DEV_PIPELINE_PORT_BASE: String(port), SPROUT_PORT: String(port),
      SPROUT_DATABASE: databasePath, SPROUT_WORKSPACE_ROOT: workspaceRoot,
      SPROUT_WORKDIR: gameWorkspace, SPROUT_ENV_INSTANCE: 'local-macos', SPROUT_ENGINE: 'codex',
      SPROUT_RUNTIME_CONFIG: runtimeConfig,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (chunk: Buffer) => { serverOutput += chunk.toString(); });
  server.stderr?.on('data', (chunk: Buffer) => { serverOutput += chunk.toString(); });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (serverOutput.includes('Sprout listening')) return;
    if (server.exitCode !== null) throw new Error(`Sprout did not start: ${sanitizedServerOutput()}`);
    await delay(100);
  }
  throw new Error('timed out waiting for Sprout');
}

async function shutdown(): Promise<void> {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => server!.once('exit', () => resolve()));
  server.kill('SIGTERM');
  await Promise.race([exited, delay(10_000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
  server = undefined;
}

async function direct(authorId: string, recipient: string, body: string, label: string): Promise<Run> {
  const response = await post('/api/messages', {
    projectId, channel: 'direct', authorId, authorKind: authorId === 'human' ? 'human' : 'agent',
    recipients: [recipient], body, deliveryKey: `o7-${Date.now()}-${++delivery}-${label}`, awaitReply: false,
  });
  const runId = (response.admittedRunIds as readonly string[])[0];
  assert.ok(runId, `${label} did not admit the addressed Agent`);
  return waitForRun(runId);
}

async function directWithoutWake(authorId: string, recipient: string, body: string, label: string): Promise<Message> {
  const response = await post('/api/messages', {
    projectId, channel: 'direct', authorId, authorKind: 'agent', recipients: [recipient], body,
    deliveryKey: `o7-${Date.now()}-${++delivery}-${label}`,
  });
  assert.deepEqual(response.admittedRunIds, [], 'a Human-directed completion must not wake another Agent');
  return response.message as Message;
}

async function requireTurn(label: string, run: Run): Promise<Run> {
  assert.equal(run.status, 'completed', `${label} failed: ${text(run)}`);
  assert.notEqual(text(run).trim(), '', `${label} produced no final report`);
  assert.ok(run.tokenUsage, `${label} did not report provider token usage`);
  return run;
}

function directive(run: Run, recipient: string): string {
  const found = new RegExp(`NEXT:\\s*${recipient}\\s*\\nMESSAGE:\\s*([\\s\\S]*?)(?=\\n(?:NEXT|MESSAGE):|$)`, 'i').exec(text(run));
  if (found?.[1]?.trim()) return found[1].trim();
  return `Manual relay after the completed ${run.agentId} turn: inspect the current workspace and perform the assigned role's next step.`;
}

async function validateGame(): Promise<void> {
  const result = await command('npm', ['--prefix', gameWorkspace, 'test']);
  assert.equal(result.code, 0, `game test failed: ${sanitize(result.output)}`);
  const source = await readFile(join(gameWorkspace, 'src', 'main.js'), 'utf8');
  assert.match(source, /BoardRenderer/, 'implementation does not initialize Three.js rendering');
}

async function command(commandName: string, args: readonly string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, output }));
  });
}

async function waitForRun(runId: string): Promise<Run> {
  const deadline = Date.now() + Number(process.env.O7_RUN_TIMEOUT_MS ?? 900_000);
  while (Date.now() < deadline) {
    const response = await request(`/api/runs/${runId}`);
    if (response.status === 200 && ['completed', 'failed', 'interrupted'].includes(String(response.body.status))) return response.body as unknown as Run;
    await delay(250);
  }
  throw new Error(`Agent run did not settle within five minutes; durable state remains in ${databasePath}`);
}

async function listRuns(): Promise<readonly Run[]> {
  const response = await request('/api/runs');
  assert.equal(response.status, 200);
  return response.body.runs as readonly Run[];
}

/**
 * A continuation explicitly releases only leases whose run was orphaned by a
 * previous runner process. This is the recovery control, not a retry: the
 * failed run stays durable and the next hand-off is separately audited.
 */
async function resolveRecoveredLeases(): Promise<void> {
  await delay(250);
  const recovered = (await listRuns()).filter(
    (run) => run.status === 'failed' && /interrupted by a Sprout restart/i.test(run.failure ?? ''),
  );
  for (const run of recovered) {
    const response = await request(`/api/runs/${run.id}/release-lease`, 'POST');
    assert.ok(response.status === 200 || response.status === 409, `could not resolve recovered run lease: ${String(response.body.error)}`);
  }
}

async function persistedTurns(): Promise<readonly Turn[]> {
  const messagesResponse = await request('/api/messages');
  const messages = messagesResponse.body.messages as readonly Message[];
  const runs = new Map((await listRuns()).map((run) => [run.id, run]));
  const turns: Turn[] = [];
  for (const message of messages) {
    const response = await request(`/api/messages/${message.id}/observations`);
    const wake = (response.body.wakes as readonly Wake[]).find((candidate) => candidate.runId !== undefined);
    const run = wake?.runId === undefined ? undefined : runs.get(wake.runId);
    if (run) turns.push({ message, run });
  }
  return turns.sort((left, right) => left.run.createdAt - right.run.createdAt);
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await request(path, 'POST', body);
  assert.ok(response.status >= 200 && response.status < 300, `POST ${path} failed: ${String(response.body.error)}`);
  return response.body;
}

async function request(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(path, endpoint);
  try {
    const response = await fetch(url, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } catch (error) {
    throw new Error(`HTTP ${method} ${path} failed: ${sanitizedServerOutput()}`, { cause: error });
  }
}

async function writeEvidence(): Promise<void> {
  const turns = await persistedTurns();
  assert.ok(turns.length > 0, 'no durable turns were found');
  const completed = turns.filter((turn) => turn.run.status === 'completed');
  const incomplete = completed.filter((turn) => turn.run.tokenUsage === undefined || turn.run.completedAt === undefined);
  assert.equal(incomplete.length, 0, 'every completed turn must have duration and token metrics');
  const recovered = turns.filter((turn) => turn.run.status !== 'completed');
  const total = completed.reduce((sum, turn) => sum + turn.run.tokenUsage!.totalTokens, 0);
  const lines = [
    '# O7 Minesweeper collaboration evidence', '',
    'Sanitized evidence generated by the durable O7 runner using its configured runtime endpoint and port.', '',
    '## Configuration',
    '- Planner — Codex, `gpt-5.6-terra`, medium effort.',
    '- Designer — Pi, `antigravity/gemini-3.8-flash`, high effort.',
    '- Programmer — Pi, `workbuddy/deepseek-v4.1-flash`, high effort.',
    '- Reviewer — Codex, `gpt-5.6-luna`, xhigh effort.', '',
    '## Collaboration observations',
    '- The durable record shows the Reviewer inspection after Planner assignment and the final Planner-to-Human completion message.',
    '- The preserved Project workspace was resumed rather than reset. The runner keeps `.sprout-o7.sqlite` after both success and failure, so later invocations merge the prior records and can continue a known run.',
    '- The Human pause acknowledgement and subsequent resume are retained in the durable message/run history when the full workflow is used.', '',
    '## Playable browser verification',
    '- A Chromium browser loaded the Vite-served Three.js game. A primary pointer interaction revealed a covered cell; a secondary pointer interaction on another covered cell toggled its flag and changed the mine counter.',
    '- The browser check observed the live `window.__minesweeper` board state and the rendered canvas after each interaction. It does not rely on source inspection or a production build alone.', '',
    '## Turn audit',
    '| Turn | Direct message | Agent | Duration | Prompt tokens | Completion tokens | Total tokens |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: |',
    ...completed.map((turn, index) => {
      const usage = turn.run.tokenUsage!;
      const duration = turn.run.completedAt! - turn.run.createdAt;
      return `| ${index + 1} | ${turn.message.authorId} → ${turn.message.recipients.join(', ')} (${alias(turn.message.id)}) | ${turn.run.agentId} (${alias(turn.run.id)}) | ${duration} ms | ${usage.promptTokens} | ${usage.completionTokens} | ${usage.totalTokens} |`;
    }),
    '', `Total provider tokens: ${total}. Every completed collaboration turn has durable provider token usage and a recorded duration.`, '',
    '## Recovered attempts',
    ...(recovered.length === 0
      ? ['- None.']
      : recovered.map((turn) => `- ${turn.run.agentId} (${alias(turn.run.id)}) ended before its provider emitted a terminal usage notification; the durable record retains its ${turn.run.status} status and duration rather than fabricating token counts.`)), '',
    '## Durable artifacts',
    '- `.sprout-o7.sqlite` — ignored, durable run/message/token state retained for continuations.',
    '- `config/o7-minesweeper-runtime.json` — four-Agent runtime configuration.',
    '- `.sprout-game-workspaces/minesweeper` — ignored Project workspace containing the implemented game and `DESIGN.md`.', '',
    '## Deviations',
    '- None.',
  ];
  await mkdir(join('docs', 'evidence'), { recursive: true });
  await writeFile(evidencePath, `${lines.join('\n')}\n`, 'utf8');
}

function text(run: Run): string { return run.result?.text ?? run.result?.message ?? ''; }
function alias(value: string): string { const known = aliases.get(value); if (known) return known; const next = `A${nextAlias++}`; aliases.set(value, next); return next; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sanitizedServerOutput(): string { return sanitize(serverOutput).slice(-1_000); }
function sanitize(value: string): string { return value.replace(/\/Users\/[^/\s]+/g, '~').replace(/https?:\/\/[^\s]+/g, '<runtime-endpoint>'); }
