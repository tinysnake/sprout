/**
 * Live container check: a real container environment running a real worker and a
 * real Codex.
 *
 * Not part of the automated suite. The automated tests use a fake runtime; this
 * script crosses the real Docker seam and prints the evidence the work record
 * cites, including process inspection *inside* the container.
 *
 * Usage:
 *   environments/container/build.sh            # once, to build the image
 *   node scripts/live-container.ts
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentRunEvent } from '../src/engine/port.ts';
import { DockerRuntime } from '../src/environment/container.ts';
import { EnvironmentPool } from '../src/environment/pool.ts';
import { AgentRegistry } from '../src/agent/registry.ts';
import { ProjectRegistry } from '../src/project/registry.ts';
import { InMemoryRunStore } from '../src/run/store.ts';
import { RunOrchestrator } from '../src/run/orchestrator.ts';
import { ContainerCarrier, containerWorkerEntry } from '../src/worker/container-carrier.ts';

const execFileAsync = promisify(execFile);

const image = process.env.SPROUT_CONTAINER_IMAGE ?? 'sprout/environment:latest';
const instanceId = 'container-live';
const containerName = 'sprout-live-check';
const mountRoot = '/sprout';
const projectRoot = join(import.meta.dirname, '..');
const prompt = process.argv[2] ?? 'Run the shell command `echo container-ok` and reply with its exact output.';

/** The host proxy, translated to the name a container uses for the host. */
function containerProxy(): Record<string, string> {
  const raw = process.env.SPROUT_DOCKER_PROXY ?? process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (!raw) return {};
  const translated = raw.replace(/127\.0\.0\.1|localhost/g, 'host.docker.internal');
  return { HTTPS_PROXY: translated, HTTP_PROXY: translated, NO_PROXY: 'localhost,127.0.0.1' };
}

const log = (line: string) => process.stdout.write(`${line}\n`);

log('# Sprout live container check');
log(`image:   ${image}`);
log(`prompt:  ${prompt}`);
log('');

const runtime = new DockerRuntime();
const availability = await runtime.available();
log(`[docker] ${availability.available ? 'available' : 'UNAVAILABLE'} — ${availability.detail}`);
if (!availability.available) {
  log('FAIL: Docker is not reachable, so the container environment cannot be checked');
  process.exit(1);
}

const authPath = join(homedir(), '.codex', 'auth.json');

// Reuse a container from a previous run rather than destroying one: `rm` is the
// only irrecoverable action (#4), so this script never removes a container.
if (await runtime.exists(containerName)) {
  log(`[docker] reusing existing container ${containerName}`);
} else {
  log(`[docker] creating container ${containerName}`);
  await runtime.create({
    name: containerName,
    image,
    volumes: [
      // The repository is mounted so the container runs the same worker source as
      // the core, rather than a copy baked into the image.
      `${projectRoot}:${mountRoot}`,
      // Codex auth is the owner's own credential; it is mounted read-only and
      // never copied into an image layer.
      `${authPath}:/codexhome/auth.json:ro`,
    ],
    environment: {
      SPROUT_ENV_INSTANCE: instanceId,
      CODEX_HOME: '/codexhome',
      ...containerProxy(),
    },
    labels: { 'sprout.environment': instanceId },
    addHostGateway: true,
  });
}

// 1. What the image provides: the worker needs node, Codex needs git.
for (const command of [['node', '--version'], ['git', '--version'], ['codex', '--version']]) {
  const result = await runtime.exec(containerName, command);
  log(`[container] ${command.join(' ')} → ${(result.stdout || result.stderr).trim()}`);
}

// 2. Codex needs an authenticated home and a git repository in its work dir.
const copied = await runtime.exec(containerName, [
  'sh',
  '-c',
  'test -s /codexhome/auth.json || echo missing',
]);
log(`[container] auth present: ${copied.stdout.trim() === 'missing' ? 'no' : 'yes'}`);
if (copied.stdout.trim() === 'missing') {
  log(`[container] FAIL: no Codex auth at /codexhome/auth.json (expected from ${authPath})`);
}
await runtime.exec(containerName, [
  'sh',
  '-c',
  `cd ${mountRoot} && (git rev-parse --git-dir >/dev/null 2>&1 || (git init -q && git commit -q --allow-empty -m init))`,
]);

// 3. Start a worker inside the container and drive a real run through it.
const carrier = new ContainerCarrier({
  runtime,
  containerName,
  workerEntryPath: containerWorkerEntry(mountRoot),
  environmentInstanceId: instanceId,
  workingDirectory: mountRoot,
  environment: {
    CODEX_HOME: '/codexhome',
    ...containerProxy(),
  },
  label: 'container-worker',
  onLog: (line) => log(`[worker] ${line}`),
});

const connection = await carrier.start();
log(`[worker] engines reported inside the container: ${[...connection.adapters.keys()].join(', ') || '(none)'}`);

const orchestrator = new RunOrchestrator({
  engines: () => Promise.resolve(connection.adapters),
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
      id: 'sprout-container-check',
      goal: 'Verify the live container run path.',
      rules: [],
      availableEnvironmentInstanceIds: [instanceId],
      memberships: [
        { agentId: 'scout', responsibilities: ['Answer directly'], collaborationInstructions: '' },
      ],
    },
  ]),
  pool: new EnvironmentPool({
    definitions: [
      {
        id: 'container-linux',
        platform: 'container',
        capabilities: [
          { name: 'agent-run', requiresLease: true },
          { name: 'read-only-investigation', requiresLease: false },
        ],
      },
    ],
    instances: [{ id: instanceId, definitionId: 'container-linux', workingDirectory: mountRoot }],
  }),
  store: new InMemoryRunStore(),
  leaseTtlMs: 600_000,
});

const started = Date.now();
const { id } = await orchestrator.submit({ agentId: 'scout', prompt });
log(`[run] submitted ${id}`);

// Observe where the engine actually runs, while the run is live.
//
// The container's processes live in their own PID namespace, so the host cannot
// see the engine at all. That absence is the evidence: the engine runs inside the
// container, not on the host.
await new Promise((resolve) => setTimeout(resolve, 4_000));
const inside = await runtime.exec(containerName, [
  'sh',
  '-c',
  "ls /proc | grep -E '^[0-9]+$' | while read p; do tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -E 'worker/main|codex' && echo; done",
]);
log('[container] processes inside the container while the run is live:');
const insideLines = inside.stdout.trim().split('\n').filter((line) => line.trim() !== '');
if (insideLines.length === 0) log('  (none found)');
for (const line of insideLines) log(`  ${line.trim()}`);

const onHost = await execFileAsync('/bin/sh', [
  '-c',
  "ps -eo pid,ppid,command | grep -E 'node /sprout/src/worker/main.ts' | grep -v grep || true",
]);
log('[host] worker process running inside the container (visible as a docker exec):');
log(`  ${onHost.stdout.trim() === '' ? '(none)' : onHost.stdout.trim()}`);
const hostEngine = await execFileAsync('/bin/sh', [
  '-c',
  "ps -eo pid,ppid,command | grep 'codex app-server' | grep -v grep | grep -v ChatGPT || true",
]);
log('[host] codex processes on the host (must be none for this run):');
log(`  ${hostEngine.stdout.trim() === '' ? '(none)' : hostEngine.stdout.trim()}`);

const run = await orchestrator.waitFor(id);
const elapsedMs = Date.now() - started;

log('');
log(`[run] final status: ${run.status} (${elapsedMs}ms)`);
for (const event of run.events) log(`  - ${describe(event)}`);
if (run.result?.status === 'completed') log(`[run] final text: ${run.result.text.trim()}`);
log(`[run] active lease after completion: ${JSON.stringify(orchestrator.activeLease(instanceId) ?? null)}`);

// 4. Exclusivity must hold for the container too, and Docker will not enforce
// it (#4): Sprout's lease registry must. The two runs have to overlap, so this
// starts the second while the first is still active.
log('');
log('[lease] starting a long run and a second run against the same container:');
const long = await orchestrator.submit({
  agentId: 'scout',
  prompt: 'Count slowly from 1 to 20, one number per line, with a sentence of explanation each.',
});
const conflict = await orchestrator.submit({ agentId: 'scout', prompt: 'must be refused' });
const refused = await orchestrator.waitFor(conflict.id);
log(`[lease] second run: ${refused.status} — ${refused.failure ?? '(no failure text)'}`);
await orchestrator.stop(long.id);

const exclusivityEnforced =
  refused.status === 'failed' && /busy|lease/i.test(refused.failure ?? '');

// The engine ran inside the container: it is visible there and absent on the host.
const engineRanInContainer = inside.stdout.includes('codex');
const engineAbsentOnHost = !hostEngine.stdout.includes('codex app-server');
log('');
log(`[evidence] engine inside container: ${engineRanInContainer}`);
log(`[evidence] engine absent on host:   ${engineAbsentOnHost}`);
log(`[evidence] lease exclusivity:       ${exclusivityEnforced}`);
const ok = run.status === 'completed' && engineRanInContainer && engineAbsentOnHost && exclusivityEnforced;

await connection.close();
log('');
log(
  ok
    ? 'PASS: real Codex run completed inside the container environment'
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
