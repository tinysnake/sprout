import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentRegistry, type AgentDefinition } from './agent/registry.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from './environment/model.ts';
import { EnvironmentPool } from './environment/pool.ts';
import { CodexEngineAdapter } from './engine/codex.ts';
import type { EngineAdapter } from './engine/port.ts';
import { RunOrchestrator } from './run/orchestrator.ts';
import { SqliteRunStore } from './run/sqlite-store.ts';
import { createRunApi } from './web/api.ts';

/**
 * The M1 runtime entry point.
 *
 * This is the only module that names concrete adapters. Everything above it
 * works against the `EngineAdapter` and `RunStore` interfaces, which is what
 * keeps the core testable without Codex or a real machine.
 *
 * Configuration is read from environment variables with local defaults rather
 * than being hard-coded, because the working directory and the Codex binary are
 * host facts, not product decisions.
 */

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');

const databasePath = process.env.SPROUT_DATABASE ?? join(projectRoot, 'sprout.db');
const workingDirectory = process.env.SPROUT_WORKDIR ?? projectRoot;
const port = Number(process.env.SPROUT_PORT ?? 5174);
const instanceId = process.env.SPROUT_ENV_INSTANCE ?? 'local-macos';

/** Codex must be launched through its real path; a PATH symlink fails sandboxed. */
function resolveCodexBinary(): string {
  try {
    const found = execFileSync('/bin/sh', ['-lc', 'command -v codex'], { encoding: 'utf8' }).trim();
    if (found !== '') return found;
  } catch {
    // Fall through to the explicit override or a clear failure below.
  }
  return process.env.SPROUT_CODEX_BIN ?? 'codex';
}

const environmentDefinitions: readonly EnvironmentDefinition[] = [
  {
    id: 'macos-workstation',
    platform: 'macos',
    capabilities: [
      { name: 'agent-run', requiresLease: true },
      { name: 'read-only-investigation', requiresLease: false },
    ],
  },
];

const environmentInstances: readonly EnvironmentInstance[] = [
  { id: instanceId, definitionId: 'macos-workstation' },
];

const agents: readonly AgentDefinition[] = [
  {
    id: 'scout',
    name: 'Scout',
    engine: 'codex',
    environmentInstanceId: instanceId,
    capability: 'agent-run',
    workingDirectory,
    instructions:
      'You are Scout, a careful engineering assistant working inside the Sprout project. ' +
      'Answer the request directly and report what you observed.',
  },
];

const registry = new AgentRegistry(agents);
const engines = new Map<string, EngineAdapter>([
  [
    'codex',
    new CodexEngineAdapter({
      binaryPath: resolveCodexBinary(),
      args: ['--strict-config'],
    }),
  ],
]);

const store = new SqliteRunStore({ filename: databasePath });
const orchestrator = new RunOrchestrator({
  engines,
  agents: registry,
  pool: new EnvironmentPool({
    definitions: environmentDefinitions,
    instances: environmentInstances,
  }),
  store,
  leaseTtlMs: Number(process.env.SPROUT_LEASE_TTL_MS ?? 900_000),
});

const staticRoot = join(projectRoot, 'web', 'dist');
const api = createRunApi({
  orchestrator,
  agents: registry,
  staticRoot,
  readFile: async (path) => {
    if (!existsSync(path)) return undefined;
    return readFile(path);
  },
  // Unbuilt client assets: fall back to the source entry so `npm start` works
  // before `vite build` has ever run.
});

const { port: boundPort } = await api.listen(port);

/**
 * Reconcile runs left mid-flight by a previous process before serving.
 *
 * A `running` run whose process is gone can never progress, and its lease died
 * with it, so it is reported as failed rather than shown as live forever.
 */
const orphaned = await orchestrator.reconcileOrphanedRuns();

process.stdout.write(
  `Sprout listening on http://127.0.0.1:${boundPort}\n` +
    `  agent:      ${agents.map((agent) => agent.id).join(', ')}\n` +
    `  engine:     ${[...engines.keys()].join(', ')}\n` +
    `  environment: ${instanceId} (macos, cwd ${workingDirectory})\n` +
    `  database:   ${databasePath}\n`,
);

if (orphaned.length > 0) {
  process.stdout.write(
    `  recovered:  ${orphaned.length} run(s) marked failed after restart: ` +
      `${orphaned.map((run) => run.id).join(', ')}\n`,
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void api.close().then(() => {
      store.close();
      process.exit(0);
    });
  });
}
