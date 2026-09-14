/**
 * Live smoke check: the real Codex engine, inside a real environment worker, on
 * the real macOS host.
 *
 * Not part of the automated test suite. The automated tests use controlled
 * adapters; this script exists because the slice must cross the real seams at
 * least once, and the evidence it prints is what the work record cites.
 *
 * Since ADR-0003 it also proves the separation this ticket is about: the engine
 * process is a child of the worker, not of this process.
 *
 * Usage:
 *   node scripts/live-smoke.ts
 *   node scripts/live-smoke.ts "List the top-level files in this directory."
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { AgentRunEvent } from '../src/engine/port.ts';
import { MacOsEnvironment } from '../src/environment/macos.ts';
import { EnvironmentPool } from '../src/environment/pool.ts';
import { AgentRegistry } from '../src/agent/registry.ts';
import { ProjectRegistry } from '../src/project/registry.ts';
import { InMemoryRunStore } from '../src/run/store.ts';
import { RunOrchestrator } from '../src/run/orchestrator.ts';
import { EndpointCarrier } from '../src/worker/carrier.ts';
import { EnvironmentWorkerRegistry } from '../src/worker/supervisor.ts';

const execFileAsync = promisify(execFile);

const prompt = process.argv[2] ?? 'Reply with exactly the word PONG and nothing else.';
const projectRoot = join(import.meta.dirname, '..');
const workerEntry = join(projectRoot, 'src', 'worker', 'main.ts');

const log = (line: string) => process.stdout.write(`${line}\n`);

log('# Sprout live smoke check');
log(`worker:  ${workerEntry}`);
log(`cwd:     ${projectRoot}`);
log(`prompt:  ${prompt}`);
log('');

// 1. The macOS environment answers a read-only probe without a lease.
const environment = new MacOsEnvironment({ workingDirectory: projectRoot });
const probe = await environment.probe();
log(`[environment] probe available=${probe.available} (${probe.detail})`);
if (!probe.available) {
  log('FAIL: the macOS environment is not usable');
  process.exit(1);
}

const uname = await environment.run('uname -s -m && sw_vers -productVersion');
log(`[environment] uname: ${uname.stdout.trim().replace(/\n/g, ' | ')}`);

// 2. Start a real worker process. Codex is spawned inside it, not here.
const environmentWorkers = new EnvironmentWorkerRegistry({
  connect: (requestedInstanceId) =>
    EndpointCarrier.start({
      command: process.execPath,
      args: [workerEntry],
      env: { ...process.env, SPROUT_ENV_INSTANCE: requestedInstanceId },
      label: 'sprout-worker',
      onLog: (line) => log(`[worker] ${line}`),
    }),
  onLog: (line) => log(`[env-worker] ${line}`),
});

const engines = await environmentWorkers.adapters('local-macos');
log(`[worker] engines reported by the worker: ${[...engines.keys()].join(', ') || '(none)'}`);
if (!engines.has('codex')) {
  log('FAIL: the worker does not host codex');
  await environmentWorkers.close();
  process.exit(1);
}

const orchestrator = new RunOrchestrator({
  // Resolved per run *for the resolved instance*, exactly as the runtime does it:
  // the executing worker follows the instance the run leases (F1, #18).
  engines: (instanceId) => environmentWorkers.adapters(instanceId),
  agents: new AgentRegistry([
    {
      id: 'scout',
      name: 'Scout',
      engine: 'codex',
      capability: 'agent-run',
      instructions: 'You are Scout. Answer directly and briefly.',
    },
  ]),
  projects: new ProjectRegistry([
    {
      id: 'sprout-smoke',
      goal: 'Verify the live Sprout run path.',
      rules: [],
      availableEnvironmentInstanceIds: ['local-macos'],
      memberships: [
        { agentId: 'scout', responsibilities: ['Answer directly'], collaborationInstructions: '' },
      ],
    },
  ]),
  pool: new EnvironmentPool({
    definitions: [
      {
        id: 'macos-workstation',
        platform: 'macos',
        capabilities: [
          { name: 'agent-run', requiresLease: true },
          { name: 'read-only-investigation', requiresLease: false },
        ],
      },
    ],
    instances: [{ id: 'local-macos', definitionId: 'macos-workstation', workingDirectory: projectRoot }],
  }),
  store: new InMemoryRunStore(),
  leaseTtlMs: 600_000,
});

const started = Date.now();
const observed: { atMs: number; description: string }[] = [];
orchestrator.subscribe((run) => {
  observed.push({
    atMs: Date.now() - started,
    description: `${run.status} (${run.events.length} events)`,
  });
});

const { id } = await orchestrator.submit({ agentId: 'scout', prompt });
log(`[run] submitted ${id}`);

// Observe the process tree while the run is live: the engine must belong to the
// worker, never to this process.
await new Promise((resolve) => setTimeout(resolve, 3_000));
const tree = await execFileAsync('/bin/sh', [
  '-c',
  "ps -eo pid,ppid,command | grep -E 'sprout/src/worker/main.ts|codex app-server' | grep -v grep",
]);
log('[process] engine ownership while the run is live:');
const processes = tree.stdout
  .trim()
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '');
for (const line of processes) log(`  ${line}`);
log(`[process] this process is pid ${process.pid}`);

// The engine's *parent* must be a worker, not this process. Checking for the
// absence of this pid is not enough, since it legitimately appears as the
// worker's own parent.
const engine = processes.find((line) => line.includes('codex app-server'));
const engineParentPid = engine?.split(/\s+/)[1];
const watchedPids = new Set(
  processes
    .filter((line) => line.includes('worker/main.ts'))
    .map((line) => line.split(/\s+/)[0] ?? ''),
);
const engineOwnedByWorker =
  engineParentPid !== undefined && engineParentPid !== String(process.pid) && watchedPids.has(engineParentPid);
log(
  `[process] codex parent pid ${String(engineParentPid)} ` +
    `(this process ${process.pid}, workers ${[...watchedPids].join(', ') || 'none'})`,
);

const run = await orchestrator.waitFor(id);
const elapsedMs = Date.now() - started;

log('');
log('[run] observed states:');
let previous = '';
for (const entry of observed) {
  if (entry.description === previous) continue;
  previous = entry.description;
  log(`  ${String(entry.atMs).padStart(6)}ms  ${entry.description}`);
}

log('');
log('[run] events in order:');
for (const event of run.events) log(`  - ${describe(event)}`);

log('');
log(`[run] final status: ${run.status} (${elapsedMs}ms)`);
if (run.result?.status === 'completed') {
  log(`[run] final text: ${run.result.text.trim()}`);
}
log(`[run] active lease after completion: ${JSON.stringify(orchestrator.activeLease('local-macos') ?? null)}`);

const ok =
  run.status === 'completed' &&
  run.events.some((event) => event.type === 'message') &&
  uname.exitCode === 0 &&
  engineOwnedByWorker;

await environmentWorkers.close();
log('');
log(
  ok
    ? 'PASS: real Codex run completed inside the environment worker on the real macOS host'
    : 'FAIL: see status above',
);
process.exit(ok ? 0 : 1);

function describe(event: AgentRunEvent): string {
  switch (event.type) {
    case 'message':
      return `message${event.final ? ' (final)' : ''}: ${JSON.stringify(event.text.slice(0, 160))}`;
    case 'tool-call':
      return `tool-call ${event.name}: ${event.detail.slice(0, 160)}`;
    case 'tool-output':
      return `tool-output: ${JSON.stringify(event.text.slice(0, 160))}`;
    case 'notice':
      return `notice: ${event.text}`;
  }
}
