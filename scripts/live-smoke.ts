/**
 * Live smoke check: the real Codex engine on the real macOS environment.
 *
 * Not part of the automated test suite. The automated tests use controlled
 * adapters; this script exists because the slice must cross the real seams at
 * least once, and the evidence it prints is what the work record cites.
 *
 * Usage:
 *   node scripts/live-smoke.ts
 *   node scripts/live-smoke.ts "List the top-level files in this directory."
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { CodexEngineAdapter } from '../src/engine/codex.ts';
import type { AgentRunEvent } from '../src/engine/port.ts';
import { MacOsEnvironment } from '../src/environment/macos.ts';
import { EnvironmentPool } from '../src/environment/pool.ts';
import { AgentRegistry } from '../src/agent/registry.ts';
import { InMemoryRunStore } from '../src/run/store.ts';
import { RunOrchestrator } from '../src/run/orchestrator.ts';

const prompt = process.argv[2] ?? 'Reply with exactly the word PONG and nothing else.';
const projectRoot = join(import.meta.dirname, '..');
const binaryPath =
  process.env.SPROUT_CODEX_BIN ??
  execFileSync('/bin/sh', ['-lc', 'command -v codex'], { encoding: 'utf8' }).trim();

const log = (line: string) => process.stdout.write(`${line}\n`);

log(`# Sprout live smoke check`);
log(`codex:   ${binaryPath}`);
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

const orchestrator = new RunOrchestrator({
  engines: new Map([['codex', new CodexEngineAdapter({ binaryPath, args: ['--strict-config'] })]]),
  agents: new AgentRegistry([
    {
      id: 'scout',
      name: 'Scout',
      engine: 'codex',
      environmentInstanceId: 'local-macos',
      capability: 'agent-run',
      workingDirectory: projectRoot,
      instructions: 'You are Scout. Answer directly and briefly.',
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
    instances: [{ id: 'local-macos', definitionId: 'macos-workstation' }],
  }),
  store: new InMemoryRunStore(),
  leaseTtlMs: 600_000,
});

const started = Date.now();
const observed: { atMs: number; description: string }[] = [];
orchestrator.subscribe((run) => {
  observed.push({ atMs: Date.now() - started, description: `${run.status} (${run.events.length} events)` });
});

const { id } = await orchestrator.submit({ agentId: 'scout', prompt });
log(`[run] submitted ${id}`);
const run = await orchestrator.waitFor(id);
const elapsedMs = Date.now() - started;

log('');
log(`[run] observed states:`);
let previous = '';
for (const entry of observed) {
  const key = `${entry.description}`;
  if (key === previous) continue;
  previous = key;
  log(`  ${String(entry.atMs).padStart(6)}ms  ${entry.description}`);
}

log('');
log(`[run] events in order:`);
for (const event of run.events) log(`  - ${describe(event)}`);

log('');
log(`[run] final status: ${run.status} (${elapsedMs}ms)`);
if (run.result?.status === 'completed') {
  log(`[run] final text: ${run.result.text.trim()}`);
}
log(`[run] active lease after completion: ${JSON.stringify(orchestrator.activeLease('local-macos') ?? null)}`);

// 2. Both seams were crossed for real, or the evidence is not evidence.
const crossedEngine = run.events.some((event) => event.type === 'message');
const crossedEnvironment = uname.exitCode === 0;
const ok = run.status === 'completed' && crossedEngine && crossedEnvironment;
log('');
log(ok ? 'PASS: real Codex run completed on the real macOS environment' : 'FAIL: see status above');
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
