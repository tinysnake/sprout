/**
 * Live O7 evidence: execute one Planner-led Minesweeper collaboration run.
 *
 * State lives in a durable, ignored SQLite database so a timed-out Agent turn
 * can be inspected without losing completed work. This runner deliberately
 * accepts only an empty database: a Ticket #42 run is one coherent, durable
 * conversation rather than a splice of independent continuation fragments.
 * The evidence is rebuilt from that database's API surface on every invocation.
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
interface Message {
  readonly id: string;
  readonly channel: 'direct' | 'project';
  readonly authorId: string;
  readonly authorKind: string;
  readonly recipients: readonly string[];
  readonly body: string;
  readonly inReplyTo?: string;
  readonly createdAt: number;
}
interface Wake { readonly runId?: string; }
interface Turn { readonly message: Message; readonly run: Run; }

let server: ChildProcess | undefined;
let serverOutput = '';
let delivery = 0;
const aliases = new Map<string, string>();
let nextAlias = 1;

try {
  await start();
  if (process.env.O7_WRITE_EVIDENCE_ONLY === '1') {
    await validateGame();
  } else if (process.env.O7_FINALIZE_EXISTING === '1') {
    await finalizeExistingReview();
  } else {
    await requireEmptyHistory();
    await runFromStart();
  }
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

  const programmerReport = await requireTurn('programmer implementation', await direct('planner', 'programmer', `${approvedAssignment}\n\nThe Project workspace already contains the playable 2D Minesweeper implementation from the assigned work. Verify or make only necessary corrections to its Three.js rendering, reset, mine counter/status, left-click reveal, right-click flag, win/loss feedback, and first-click-safe generation. Run only \`npm test\`; do not start a development server, browser, or extra exploratory checks. End now with \`NEXT: planner\` and \`MESSAGE: <changed files and checks>\`.`, 'planner-programmer'));
  await finishReview('programmer', directive(programmerReport, 'planner'));
}

async function finishReview(authorId: string, report: string): Promise<void> {
  const plannerReview = await requireTurn('planner implementation review', await direct(authorId, 'planner', `${report}\n\nInspect the implementation and its verification facts. End with exactly \`NEXT: reviewer\` and \`MESSAGE: <review assignment>\`.`, 'implementation-report'));
  const reviewerReport = await requireTurn('reviewer inspection', await direct('planner', 'reviewer', `${directive(plannerReview, 'reviewer')}\n\nInspect the workspace against DESIGN.md and the stated Minesweeper behaviour. Run \`npm test\`. Do not modify files. End with exactly \`NEXT: planner\` and \`MESSAGE: <pass/follow-up report>\`.`, 'planner-reviewer'));
  let reviewAssessment = await requireTurn('planner reviewer assessment', await direct('reviewer', 'planner', `${directive(reviewerReport, 'planner')}\n\nAssess the Reviewer findings. If any required finding remains, end with \`NEXT: programmer\` and \`MESSAGE: <specific correction assignment>\`. Otherwise end with \`NEXT: human\` and \`MESSAGE: Reviewer acceptance is supported.\`.`, 'reviewer-report'));
  if (requiresCorrection(reviewAssessment)) {
    const correction = await requireTurn('programmer correction', await direct('planner', 'programmer', `${directive(reviewAssessment, 'programmer')}\n\nFix every required Reviewer finding in the Project workspace. Run only \`npm test\`; do not start a development server or browser. End with \`NEXT: planner\` and \`MESSAGE: <fixed findings and checks>\`.`, 'planner-programmer-correction'));
    const correctionAssessment = await requireTurn('planner correction assessment', await direct('programmer', 'planner', `${directive(correction, 'planner')}\n\nInspect the correction against every prior Reviewer finding. End with \`NEXT: reviewer\` and \`MESSAGE: <focused re-review assignment>\`.`, 'programmer-correction-report'));
    const rereview = await requireTurn('reviewer re-inspection', await direct('planner', 'reviewer', `${directive(correctionAssessment, 'reviewer')}\n\nRe-inspect every finding from your prior report in the current workspace. Run \`npm test\`. Do not modify files. End with \`NEXT: planner\` and \`MESSAGE: <pass/follow-up report>\`.`, 'planner-reviewer-rereview'));
    reviewAssessment = await requireTurn('planner re-review assessment', await direct('reviewer', 'planner', `${directive(rereview, 'planner')}\n\nAssess the re-review. Only accept it when every required finding is resolved. End with \`NEXT: human\` and \`MESSAGE: Reviewer acceptance is supported, or remaining required findings.\`.`, 'reviewer-rereview-report'));
  }
  assert.ok(!requiresCorrection(reviewAssessment), `Planner did not accept the Reviewer result: ${text(reviewAssessment)}`);
  await validateGame();
  const finalPlanner = await requireTurn('planner final verification', await direct('human', 'planner', `Independent rendered-game browser verification passed after the Reviewer acceptance: a primary pointer input revealed a covered Three.js cell, and a secondary pointer input flagged a different covered cell and decremented the mine counter. ${directive(reviewAssessment, 'human')}\n\nVerify the complete workspace evidence and issue the final completion report. End with exactly \`NEXT: human\` and \`MESSAGE: Completion verified: <final completion report>\`.`, 'human-browser-verification'));
  assert.match(text(finalPlanner), /completion\s+verified/i, 'Planner final report did not verify completion');
  await publishCompletionToHuman(directive(finalPlanner, 'human'));
}

function requiresCorrection(run: Run): boolean {
  return /(?:not support|not verified|incomplete|follow-?up|required finding|required fix|remaining required)/i.test(text(run));
}

/**
 * Complete only the final Human-visible hand-off after an interrupted process
 * has already durably completed the correction and re-review turns. It refuses
 * any partial history, so it is a recovery of one known collaboration rather
 * than a replay or a synthetic reviewer result.
 */
async function finalizeExistingReview(): Promise<void> {
  const turns = await persistedTurns();
  assert.equal(turns.length, 13, 'existing history is not the completed correction/re-review prefix');
  assert.ok(turns.every((turn) => turn.run.status === 'completed'), 'cannot finalize a history with an unsettled Agent turn');
  const reviewerAssessment = turns.at(-1)!.run;
  assert.equal(reviewerAssessment.agentId, 'planner', 'the durable prefix must end with Planner re-review assessment');
  assert.ok(!requiresCorrection(reviewerAssessment), `Planner did not accept the re-review: ${text(reviewerAssessment)}`);
  await validateGame();
  const finalPlanner = await requireTurn('planner recovered final verification', await direct('human', 'planner', `Independent rendered-game browser verification passed after the durable Reviewer acceptance: a primary pointer input revealed a covered Three.js cell, and a secondary pointer input flagged a different covered cell and decremented the mine counter. ${directive(reviewerAssessment, 'human')}\n\nVerify the complete workspace evidence and issue the final completion report. End with exactly \`NEXT: human\` and \`MESSAGE: Completion verified: <final completion report>\`.`, 'human-browser-verification-recovery'));
  assert.match(text(finalPlanner), /completion\s+verified/i, 'Planner recovered final report did not verify completion');
  await publishCompletionToHuman(directive(finalPlanner, 'human'));
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

/**
 * Human is a conversation participant, not an Agent project member. Publish
 * Planner's final report on the project channel, addressed only to Planner
 * itself as a no-op marker, instead of creating a failed direct-agent wake for
 * Human. The message remains human-visible and has no recipient wake.
 */
async function publishCompletionToHuman(report: string): Promise<Message> {
  const response = await post('/api/messages', {
    projectId, channel: 'project', authorId: 'planner', authorKind: 'agent',
    body: `Final completion report for Human:\n\n${report}\n\nPublication marker: @planner`,
    deliveryKey: `o7-${Date.now()}-${++delivery}-planner-final-human`,
  });
  assert.deepEqual(response.admittedRunIds, [], 'the Human-visible completion must not wake another Agent');
  assert.deepEqual(response.wakes, [], 'the Planner self-marker must produce no wake request');
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
  const browser = await command('npm', ['run', 'verify:o7-game-browser']);
  assert.equal(browser.code, 0, `rendered-game browser verification failed: ${sanitize(browser.output)}`);
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

/** Refuse accidental continuation: this evidence must be one complete run. */
async function requireEmptyHistory(): Promise<void> {
  const [messagesResponse, runs] = await Promise.all([request('/api/messages'), listRuns()]);
  const messages = messagesResponse.body.messages as readonly Message[];
  assert.equal(messages.length, 0, `refusing to append to existing collaboration history in ${databasePath}`);
  assert.equal(runs.length, 0, `refusing to append to existing run history in ${databasePath}`);
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
  const messagesResponse = await request('/api/messages');
  const messages = messagesResponse.body.messages as readonly Message[];
  const turns = await persistedTurns();
  await requireCompleteFlow(messages, turns);
  const total = turns.reduce((sum, turn) => sum + turn.run.tokenUsage!.totalTokens, 0);
  const inputMessages = messages.filter((message) => message.inReplyTo === undefined);
  const correctionTurns = turns.filter((turn) => turn.run.agentId === 'programmer').length - 1;
  const lines = [
    '# O7 Minesweeper collaboration evidence', '',
    'Sanitized evidence generated by the durable O7 runner using its configured runtime endpoint and port.', '',
    '## Configuration',
    '- Planner — Codex, `gpt-5.6-terra`, medium effort.',
    '- Designer — Pi, `antigravity/gemini-3.8-flash`, high effort.',
    '- Programmer — Pi, `workbuddy/deepseek-v4.1-flash`, high effort.',
    '- Reviewer — Codex, `gpt-5.6-luna`, xhigh effort.', '',
    '## Collaboration observations',
    `- One clean durable conversation contains ${inputMessages.length} delivered/publication messages, ${turns.length} completed Agent turns, and ${messages.length - inputMessages.length} projected Agent replies.`,
    '- The recorded order is Human start → Planner → Designer → Planner design review → Human pause/resume → Programmer → Planner implementation review → Reviewer assessment → any required correction and re-review → independent browser verification → Planner final verification.',
    ...(correctionTurns > 0
      ? [`- Reviewer findings required ${correctionTurns} Programmer correction turn${correctionTurns === 1 ? '' : 's'}; the subsequent independent Reviewer re-review was accepted before final completion.`]
      : ['- The Reviewer assessment required no correction turn before final completion.']),
    '- The final Planner report is a Human-visible Project-channel publication. It deliberately has no direct Human recipient because Human is not an Agent project member; the Planner self-marker creates no wake request.',
    '- The Reviewer was woken by Planner and sent its own durable reply to Planner; no reviewer report was synthesized by the runner.', '',
    '## Playable browser verification',
    '- A Chromium browser loaded the Vite-served Three.js game. A primary pointer interaction revealed a covered cell; a secondary pointer interaction on another covered cell toggled its flag and changed the mine counter.',
    '- The browser check observed the live `window.__minesweeper` board state and the rendered canvas after each interaction. It does not rely on source inspection or a production build alone.', '',
    '## Complete conversation audit',
    '| Message | Kind | Route | Message created | Run started | Run completed | Duration | Durable outcome |',
    '| --- | --- | --- | --- | --- | --- | ---: | --- |',
    ...messages.map((message) => {
      const turn = turns.find((candidate) => candidate.message.id === message.id);
      const kind = message.inReplyTo === undefined
        ? (message.channel === 'project' ? 'Human-visible completion publication' : 'Turn request')
        : 'Agent reply';
      const route = message.channel === 'direct'
        ? `${message.authorId} → ${message.recipients.join(', ')}`
        : `${message.authorId} → project channel`;
      const outcome = message.inReplyTo === undefined
        ? (message.channel === 'project' ? 'No Agent wake (Planner self-marker)' : 'One completed Agent turn; reply projected')
        : `Reply to ${alias(message.inReplyTo)}`;
      const started = turn === undefined ? '—' : timestamp(turn.run.createdAt);
      const completed = turn?.run.completedAt === undefined ? '—' : timestamp(turn.run.completedAt);
      const duration = turn?.run.completedAt === undefined ? '—' : `${Math.max(0, turn.run.completedAt - turn.run.createdAt)} ms`;
      return `| ${alias(message.id)} | ${kind} | ${route} | ${timestamp(message.createdAt)} | ${started} | ${completed} | ${duration} | ${outcome} |`;
    }), '',
    '## Agent-turn duration and provider-token audit',
    '| Turn | Stage | Direct message | Agent | Duration | Prompt tokens | Completion tokens | Total tokens |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: |',
    ...turns.map((turn, index) => {
      const usage = turn.run.tokenUsage!;
      const duration = turn.run.completedAt! - turn.run.createdAt;
      return `| ${index + 1} | ${turnStage(index)} | ${turn.message.authorId} → ${turn.message.recipients.join(', ')} (${alias(turn.message.id)}) | ${turn.run.agentId} (${alias(turn.run.id)}) | ${duration} ms | ${usage.promptTokens} | ${usage.completionTokens} | ${usage.totalTokens} |`;
    }),
    '', `Total provider tokens: ${total}. Every Agent turn in this complete run has durable provider token usage and a recorded duration.`, '',
    '## Deviations',
    ...(correctionTurns > 0
      ? ['- The first Reviewer assessment required corrections. They are retained as durable turns and were resolved by the recorded Programmer correction and Reviewer re-review; no failed, interrupted, recovered, or synthetic Agent turn exists.']
      : ['- None. The run contains no failed, interrupted, recovered, or synthetic Agent turn.']), '',
    '## Durable artifacts',
    '- `.sprout-o7.sqlite` — ignored durable run/message/token state for this complete collaboration.',
    '- `config/o7-minesweeper-runtime.json` — four-Agent runtime configuration.',
    '- `.sprout-game-workspaces/minesweeper` — ignored Project workspace containing the implemented game and `DESIGN.md`.',
  ];
  await mkdir(join('docs', 'evidence'), { recursive: true });
  await writeFile(evidencePath, `${lines.join('\n')}\n`, 'utf8');
}

/** Verify the exact Ticket #42 narrative before making a success evidence claim. */
async function requireCompleteFlow(messages: readonly Message[], turns: readonly Turn[]): Promise<void> {
  const inputs = messages.filter((message) => message.inReplyTo === undefined);
  assert.ok(inputs.length >= 11, 'the durable history does not contain the complete collaboration and browser-verification flow');
  const expected = [
    ['human', 'planner', /Start the 2D Minesweeper collaboration/i],
    ['planner', 'designer', /Create DESIGN\.md/i],
    ['designer', 'planner', /Review the design/i],
    ['human', 'planner', /我们先暂停一下任务/],
    ['human', 'planner', /继续/],
    ['planner', 'programmer', /Project workspace already contains the playable 2D Minesweeper implementation/i],
    ['programmer', 'planner', /Inspect the implementation/i],
    ['planner', 'reviewer', /Inspect the workspace against DESIGN\.md/i],
    ['reviewer', 'planner', /Assess the Reviewer findings/i],
  ] as const;
  for (const [index, [authorId, recipient, body]] of expected.entries()) {
    const message = inputs[index]!;
    assert.equal(message.channel, 'direct', `flow message ${index + 1} must be a direct hand-off`);
    assert.equal(message.authorId, authorId, `flow message ${index + 1} has the wrong author`);
    assert.deepEqual(message.recipients, [recipient], `flow message ${index + 1} has the wrong recipient`);
    assert.match(message.body, body, `flow message ${index + 1} has the wrong purpose`);
  }
  const browserVerification = inputs.at(-2)!;
  assert.equal(browserVerification.channel, 'direct', 'independent browser evidence must be delivered to Planner');
  assert.equal(browserVerification.authorId, 'human', 'Human must deliver independent browser evidence');
  assert.deepEqual(browserVerification.recipients, ['planner']);
  assert.match(browserVerification.body, /Independent rendered-game browser verification passed/i);
  const completion = inputs.at(-1)!;
  assert.equal(completion.channel, 'project', 'final report must use the Project channel');
  assert.equal(completion.authorId, 'planner', 'Planner must publish the final report');
  assert.match(completion.body, /Final completion report for Human/i);
  assert.match(completion.body, /@planner/);

  assert.ok(turns.some((turn) => turn.run.agentId === 'reviewer'), 'the durable history has no Reviewer turn');
  assert.ok(turns.filter((turn) => turn.run.agentId === 'programmer').length >= 1, 'the durable history has no Programmer turn');
  assert.ok(turns.every((turn) => turn.run.status === 'completed'), 'every Agent hand-off must complete');
  assert.ok(turns.every((turn) => turn.run.tokenUsage !== undefined && turn.run.completedAt !== undefined), 'every Agent turn must have durable duration and provider token usage');

  for (const turn of turns) {
    const reply = messages.find((message) => message.inReplyTo === turn.message.id);
    assert.ok(reply, `completed ${turn.run.agentId} turn has no projected durable reply`);
    assert.equal(reply.authorId, turn.run.agentId, 'a projected reply must be authored by the Agent that ran');
  }
}

function turnStage(index: number): string {
  return [
    'Initial plan', 'Design', 'Design review', 'Pause acknowledgement', 'Resume acknowledgement',
    'Implementation', 'Implementation review', 'Code review', 'Reviewer assessment', 'Correction',
    'Correction assessment', 'Re-review', 'Re-review assessment', 'Final verification',
  ][index] ?? 'Additional verification';
}

function text(run: Run): string { return run.result?.text ?? run.result?.message ?? ''; }
function alias(value: string): string { const known = aliases.get(value); if (known) return known; const next = `A${nextAlias++}`; aliases.set(value, next); return next; }
function timestamp(value: number): string { return new Date(value).toISOString(); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sanitizedServerOutput(): string { return sanitize(serverOutput).slice(-1_000); }
function sanitize(value: string): string { return value.replace(/\/Users\/[^/\s]+/g, '~').replace(/https?:\/\/[^\s]+/g, '<runtime-endpoint>'); }
