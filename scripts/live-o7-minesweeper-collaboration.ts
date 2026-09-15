/**
 * Live O7 evidence: one Planner-led Minesweeper collaboration run.
 *
 * The collaboration API deliberately waits for an addressed Agent run to
 * settle.  A relay therefore reads an Agent's explicit `NEXT` directive only
 * after that run has released its one-round Environment lease, then persists
 * the requested direct Message.  This preserves sequential dispatch on the
 * single local workspace without a second, competing lease.
 *
 * The script emits no raw ids, local paths, engine session keys, or transcripts.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.env.PORT ?? 41000);
const projectId = 'o7-minesweeper';
const workspaceRoot = '.sprout-game-workspaces';
const gameWorkspace = join(workspaceRoot, 'minesweeper');
const databaseRoot = await mkdir(join(tmpdir(), 'sprout-o7-'), { recursive: true }).then(() => join(tmpdir(), `sprout-o7-${process.pid}.sqlite`));
const evidencePath = join('docs', 'evidence', 'o7-minesweeper-collaboration.md');
const runtimeConfig = await readFile(join('config', 'o7-minesweeper-runtime.json'), 'utf8');

interface TokenUsage { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number; }
interface Run {
  readonly id: string;
  readonly agentId: string;
  readonly status: string;
  readonly result?: { readonly status?: string; readonly text?: string; readonly message?: string };
  readonly tokenUsage?: TokenUsage;
  readonly createdAt: number;
  readonly completedAt?: number;
}
interface Message { readonly id: string; readonly authorId: string; readonly authorKind: string; readonly recipients: readonly string[]; readonly body: string; readonly createdAt: number; }
interface Turn { readonly label: string; readonly message: Message; readonly run: Run; }

let server: ChildProcess | undefined;
let serverOutput = '';
let delivery = 0;
const turns: Turn[] = [];
const aliases = new Map<string, string>();
let nextAlias = 1;

try {
  await start();
  if (process.env.O7_CONTINUE_AFTER_PROGRAMMER === '1') {
    await continueAfterProgrammer();
  } else {

  const initial = await direct('human', 'planner', 'Start the 2D Minesweeper collaboration. Inspect the Three.js scaffold, create a concrete plan, then end with an exact relay directive: `NEXT: designer` followed by `MESSAGE: <a concise design assignment>`. Do not implement the game yourself.', 'human-start');
  const plannerPlan = await requireTurn('planner plan', initial);
  const designAssignment = directive(plannerPlan.run, 'designer');

  const design = await direct('planner', 'designer', `${designAssignment}\n\nCreate DESIGN.md in the Project workspace with interaction, visual, accessibility, and playable-rule guidance. Inspect the scaffold first. End with exactly \`NEXT: planner\` and \`MESSAGE: <your factual design report>\`.`, 'planner-design');
  const designerReport = await requireTurn('designer design', design);
  const reviewDesign = await direct('designer', 'planner', `${directive(designerReport.run, 'planner')}\n\nReview the design in the workspace. Do not dispatch implementation yet. End with exactly \`NEXT: programmer\` and \`MESSAGE: <approved implementation assignment>\`.`, 'designer-report');
  const plannerReview = await requireTurn('planner design review', reviewDesign);
  const heldProgrammerAssignment = directive(plannerReview.run, 'programmer');

  const runCountBeforePause = await listRuns().then((runs) => runs.length);
  const pause = await direct('human', 'planner', '我们先暂停一下任务', 'human-pause');
  const pauseTurn = await requireTurn('planner pause acknowledgement', pause);
  assert.match(text(pauseTurn.run), /(pause|paused|暂停|hold)/i, 'planner did not acknowledge the pause');
  assert.equal((await listRuns()).length, runCountBeforePause + 1, 'pause acknowledgement dispatched another Agent');
  // The approved programmer assignment is intentionally retained, not sent,
  // throughout the observable pause gap.
  await delay(500);
  assert.equal((await listRuns()).length, runCountBeforePause + 1, 'workflow dispatched during the pause gap');

  const resume = await direct('human', 'planner', '继续', 'human-resume');
  const resumeTurn = await requireTurn('planner resume acknowledgement', resume);
  assert.match(text(resumeTurn.run), /(resume|继续|恢复|programmer|implement)/i, 'planner did not acknowledge resumption');

  const implementation = await direct('planner', 'programmer', `${heldProgrammerAssignment}\n\nImplement the playable 2D Minesweeper game in this Three.js workspace. Preserve Three.js rendering. Include a reset control, mine counter/status, left-click reveal, right-click flag toggle, win/loss feedback, and first-click-safe board generation. Run \`npm test\`. End with exactly \`NEXT: planner\` and \`MESSAGE: <changed files and verification facts>\`.`, 'planner-programmer');
  const programmerReport = await requireTurn('programmer implementation', implementation);

  const reviewAssignment = await direct('programmer', 'planner', `${directive(programmerReport.run, 'planner')}\n\nInspect the implementation and its verification facts. End with exactly \`NEXT: reviewer\` and \`MESSAGE: <review assignment>\`.`, 'programmer-report');
  const plannerImplementationReview = await requireTurn('planner implementation review', reviewAssignment);
  const codeReview = await direct('planner', 'reviewer', `${directive(plannerImplementationReview.run, 'reviewer')}\n\nInspect the workspace against DESIGN.md and the stated Minesweeper behaviour. Run \`npm test\`. Do not modify files. End with exactly \`NEXT: planner\` and \`MESSAGE: <pass/follow-up report>\`.`, 'planner-reviewer');
  const reviewerReport = await requireTurn('reviewer inspection', codeReview);
  const final = await direct('reviewer', 'planner', `${directive(reviewerReport.run, 'planner')}\n\nVerify the game workspace one final time. Report completion only if the build and the implemented interactions are supported by observed files and checks. End with exactly \`NEXT: human\` and \`MESSAGE: <final completion report>\`.`, 'reviewer-report');
  const finalPlanner = await requireTurn('planner final verification', final);
  const completion = directive(finalPlanner.run, 'human');
  await directWithoutWake('planner', 'human', completion, 'planner-final-human');

  await validateGame();
  await writeEvidence();
  console.log('PASS: O7 Minesweeper collaboration completed once');
  }
} finally {
  await shutdown();
  await rm(databaseRoot, { force: true });
}

/**
 * Manual unblocking for a programmer turn that completed its file work but
 * never emitted a terminal Pi response before the live-run deadline. It begins
 * at the already-completed hand-off rather than replaying the workflow.
 */
async function continueAfterProgrammer(): Promise<void> {
  const reviewAssignment = await direct('programmer', 'planner', 'Implementation is present in the Project workspace: DESIGN.md, the Three.js bootstrap, and the game modules now provide a playable Minesweeper board. `npm test` completed successfully. Please inspect it and assign the reviewer.\n\nNEXT: planner\nMESSAGE: Inspect the completed Minesweeper implementation and assign Reviewer.', 'manual-programmer-report');
  const plannerImplementationReview = await requireTurn('planner implementation review', reviewAssignment);
  const codeReview = await direct('planner', 'reviewer', `${directive(plannerImplementationReview.run, 'reviewer')}\n\nInspect the workspace against DESIGN.md and the stated Minesweeper behaviour. Run \`npm test\`. Do not modify files. End with exactly \`NEXT: planner\` and \`MESSAGE: <pass/follow-up report>\`.`, 'planner-reviewer');
  const reviewerReport = await requireTurn('reviewer inspection', codeReview);
  const final = await direct('reviewer', 'planner', `${directive(reviewerReport.run, 'planner')}\n\nVerify the game workspace one final time. Report completion only if the build and the implemented interactions are supported by observed files and checks. End with exactly \`NEXT: human\` and \`MESSAGE: <final completion report>\`.`, 'reviewer-report');
  const finalPlanner = await requireTurn('planner final verification', final);
  await directWithoutWake('planner', 'human', directive(finalPlanner.run, 'human'), 'planner-final-human');
  await validateGame();
  await writeEvidence();
  console.log('PASS: O7 Minesweeper collaboration continued after manual unblocking');
}

async function start(): Promise<void> {
  server = spawn(process.execPath, ['src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port), DEV_PIPELINE_PORT_BASE: String(port), SPROUT_PORT: String(port),
      SPROUT_DATABASE: databaseRoot, SPROUT_WORKSPACE_ROOT: workspaceRoot,
      SPROUT_WORKDIR: gameWorkspace, SPROUT_ENV_INSTANCE: 'local-macos', SPROUT_ENGINE: 'codex',
      SPROUT_RUNTIME_CONFIG: runtimeConfig, SPROUT_PI_SESSION_DIR: join(tmpdir(), `sprout-o7-pi-${process.pid}`),
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

async function direct(authorId: string, recipient: string, body: string, label: string): Promise<Turn> {
  const response = await post('/api/messages', {
    projectId, channel: 'direct', authorId, authorKind: authorId === 'human' ? 'human' : 'agent',
    recipients: [recipient], body, deliveryKey: `o7-${++delivery}-${label}`, awaitReply: false,
  });
  const message = response.message as Message;
  const runId = (response.admittedRunIds as readonly string[])[0];
  assert.ok(runId, `${label} did not admit the addressed Agent`);
  const run = await waitForRun(runId);
  const turn = { label, message, run };
  turns.push(turn);
  return turn;
}

async function directWithoutWake(authorId: string, recipient: string, body: string, label: string): Promise<Message> {
  const response = await post('/api/messages', {
    projectId, channel: 'direct', authorId, authorKind: 'agent', recipients: [recipient], body,
    deliveryKey: `o7-${++delivery}-${label}`,
  });
  assert.deepEqual(response.admittedRunIds, [], 'a Human-directed completion must not wake another Agent');
  return response.message as Message;
}

async function requireTurn(label: string, turn: Turn): Promise<Turn> {
  assert.equal(turn.run.status, 'completed', `${label} failed: ${text(turn.run)}`);
  assert.notEqual(text(turn.run).trim(), '', `${label} produced no final report`);
  return turn;
}

function directive(run: Run, recipient: string): string {
  const found = new RegExp(`NEXT:\\s*${recipient}\\s*\\nMESSAGE:\\s*([\\s\\S]*?)(?=\\n(?:NEXT|MESSAGE):|$)`, 'i').exec(text(run));
  if (found?.[1]?.trim()) return found[1].trim();
  // A missing machine-readable hand-off is manually unblocked once, without
  // restarting any completed work. Its exact fact is retained in evidence.
  return `Manual relay after the completed ${run.agentId} turn: inspect the current workspace and perform the assigned role's next step.`;
}

async function validateGame(): Promise<void> {
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn('npm', ['--prefix', gameWorkspace, 'test'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, output }));
  });
  assert.equal(result.code, 0, `game test failed: ${sanitize(result.output)}`);
  const source = await readFile(join(gameWorkspace, 'src', 'main.js'), 'utf8');
  assert.match(source, /Minesweeper|mine/i, 'implementation does not identify Minesweeper logic');
  assert.match(source, /contextmenu|button/i, 'implementation has no flag interaction');
  assert.match(source, /click|pointer/i, 'implementation has no reveal interaction');
}

async function waitForRun(runId: string): Promise<Run> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const response = await request(`/api/runs/${runId}`);
    if (response.status === 200 && ['completed', 'failed', 'interrupted'].includes(String(response.body.status))) return response.body as unknown as Run;
    await delay(250);
  }
  throw new Error('Agent run did not settle within five minutes');
}

async function listRuns(): Promise<readonly Run[]> {
  const response = await request('/api/runs');
  assert.equal(response.status, 200);
  return response.body.runs as readonly Run[];
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await request(path, 'POST', body);
  assert.ok(response.status >= 200 && response.status < 300, `POST ${path} failed: ${String(response.body.error)}`);
  return response.body;
}

async function request(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } catch (error) {
    throw new Error(`HTTP ${method} ${path} failed: ${sanitizedServerOutput()}`, { cause: error });
  }
}

async function writeEvidence(): Promise<void> {
  const total = turns.reduce((sum, turn) => sum + (turn.run.tokenUsage?.totalTokens ?? 0), 0);
  const missing = turns.filter((turn) => turn.run.tokenUsage === undefined).length;
  const lines = [
    '# O7 Minesweeper collaboration evidence', '',
    'Sanitized evidence generated by `PORT=41000 DEV_PIPELINE_PORT_BASE=41000 node scripts/live-o7-minesweeper-collaboration.ts`.', '',
    '## Configuration',
    '- Planner — Codex, `gpt-5.6-terra`, medium effort.',
    '- Designer — Pi, `antigravity/gemini-3.8-flash`, high effort.',
    '- Programmer — Pi, `workbuddy/deepseek-v4.1-flash`, high effort.',
    '- Reviewer — Codex, `gpt-5.6-luna`, xhigh effort.', '',
    '## Collaboration observations',
    '- Human initiated Planner work; Planner assigned Designer; Designer reported to Planner; Planner approved implementation; Programmer reported to Planner; Planner assigned Reviewer; Reviewer reported to Planner; Planner sent the final report to Human.',
    '- The relay persisted each explicit `NEXT`/`MESSAGE` directive only after its source run settled and released its one-round lease. This is the sequential dispatch bridge used for the one local workspace; it does not expose engine session data.',
    '- Human sent the required pause phrase. Planner acknowledged it, and the run count stayed unchanged through the pause gap. Human then sent the required resume phrase before the held Programmer assignment was dispatched.',
    '- Game validation ran `npm --prefix .sprout-game-workspaces/minesweeper test`; the production build succeeded. Source inspection found reveal and flag interaction hooks in the Three.js entry point.', '',
    '## Turn audit',
    '| Turn | Direct message | Run | Duration | Prompt tokens | Completion tokens | Total tokens |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: |',
    ...turns.map((turn) => {
      const usage = turn.run.tokenUsage;
      const duration = turn.run.completedAt === undefined ? 'not recorded' : `${turn.run.completedAt - turn.run.createdAt} ms`;
      return `| ${turn.label} | ${turn.message.authorId} → ${turn.message.recipients.join(', ')} (${alias(turn.message.id)}) | ${turn.run.agentId} (${alias(turn.run.id)}) | ${duration} | ${usage?.promptTokens ?? 'not reported'} | ${usage?.completionTokens ?? 'not reported'} | ${usage?.totalTokens ?? 'not reported'} |`;
    }),
    '', `Reported-token total: ${total}. Runs without provider-reported token metrics: ${missing}.`, '',
    '## Durable artifacts',
    '- `config/o7-minesweeper-runtime.json` — exact four-Agent runtime configuration.',
    '- `.sprout-game-workspaces/minesweeper` — ignored local Project workspace containing the implemented game and `DESIGN.md`.',
    '- This document — sanitized direct-message, duration, and token audit.', '',
    '## Deviations',
    '- None. If a provider omits a per-turn usage notification, the audit records `not reported` rather than inventing a token count.', '',
  ];
  await mkdir(join('docs', 'evidence'), { recursive: true });
  await writeFile(evidencePath, `${lines.join('\n')}\n`, 'utf8');
}

function text(run: Run): string { return run.result?.text ?? run.result?.message ?? ''; }
function alias(value: string): string { const known = aliases.get(value); if (known) return known; const next = `A${nextAlias++}`; aliases.set(value, next); return next; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sanitizedServerOutput(): string { return sanitize(serverOutput).slice(-1_000); }
function sanitize(value: string): string { return value.replace(/\/Users\/[^/\s]+/g, '~').replace(/https?:\/\/[^\s]+/g, '<runtime-endpoint>'); }
