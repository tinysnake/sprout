/**
 * Runnable collaboration probe for ticket #25.
 *
 * `npm run probe:collaboration`
 *
 * This is the disposable, runnable form of the acceptance probe in
 * `src/collaboration/probe.test.ts`: it crosses a real Sprout worker process
 * boundary with a real SQLite database and the selected engine-neutral write
 * path, then prints a sanitized transcript.
 *
 * The engine is scripted (a fake engine is permitted for isolating the transport
 * question). The worker and persistence boundaries are real.
 *
 * Output is sanitized: no local user, host, home path, network address, or
 * credential is printed. The temporary database is removed on exit.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AgentRegistry } from '../src/agent/registry.ts';
import type { EnvironmentDefinition, EnvironmentInstance } from '../src/environment/model.ts';
import { EnvironmentPool } from '../src/environment/pool.ts';
import { ProjectRegistry } from '../src/project/registry.ts';
import type { Project } from '../src/project/model.ts';
import { RunOrchestrator } from '../src/run/orchestrator.ts';
import { SqliteStore } from '../src/store/db.ts';
import { EndpointCarrier } from '../src/worker/carrier.ts';
import { CollaborationCoordinator } from '../src/collaboration/coordinator.ts';

function workerScript(): string {
  const workerServer = new URL('../src/worker/server.ts', import.meta.url).pathname;
  const scripted = new URL('../src/engine/scripted.ts', import.meta.url).pathname;
  const carrier = new URL('../src/worker/carrier.ts', import.meta.url).pathname;
  return `
    import { ScriptedEngineAdapter } from ${JSON.stringify(scripted)};
    import { EnvironmentWorker } from ${JSON.stringify(workerServer)};
    import { serveWorkerEndpoint, WORKER_READY_PREFIX } from ${JSON.stringify(carrier)};
    const engines = new Map([['scripted', new ScriptedEngineAdapter({ turns: [
      { events: [
        { type: 'tool-call', name: 'shell', detail: 'grep -r wake src' },
        { type: 'tool-output', text: 'TOOL_OUTPUT_MUST_NOT_LEAK' },
        { type: 'notice', text: 'PRIVATE_REASONING_MUST_NOT_LEAK' },
        { type: 'message', text: 'Scout: the wake contract prefers an extra wake over a lost one.', final: true },
      ], result: { status: 'completed', text: 'Scout: the wake contract prefers an extra wake over a lost one.' } },
    ] })]]);
    const endpoint = await serveWorkerEndpoint({
      serve: (socket) => { new EnvironmentWorker({
        environmentInstanceId: 'probe-macos', engines, input: socket, output: socket,
      }); socket.on('error', () => undefined); },
    });
    process.stdout.write(WORKER_READY_PREFIX + JSON.stringify({ host: endpoint.ready.host, port: endpoint.ready.port }) + '\\n');
  `;
}

const definition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};
const instance: EnvironmentInstance = {
  id: 'probe-macos',
  definitionId: 'macos-workstation',
  workingDirectory: '/sprout-work',
};
const project: Project = {
  id: 'project-sprout',
  goal: 'Ship Sprout',
  rules: [],
  availableEnvironmentInstanceIds: ['probe-macos'],
  memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }],
};

const line = (text = '') => process.stdout.write(`${text}\n`);

const directory = mkdtempSync(join(tmpdir(), 'sprout-collab-probe-'));
const dbPath = join(directory, 'probe.db');
const connection = await EndpointCarrier.start({
  command: process.execPath,
  args: ['--input-type=module', '-e', workerScript()],
  label: 'collab-probe-worker',
  readyTimeoutMs: 20_000,
});
const sqlite = new SqliteStore({ filename: dbPath });
const store = sqlite.collaboration;
const projects = new ProjectRegistry([project]);
const orchestrator = new RunOrchestrator({
  engines: async () => connection.adapters,
  agents: new AgentRegistry([
    {
      id: 'scout',
      name: 'Scout',
      engine: 'scripted',
      capability: 'agent-run',
      workingDirectory: '/sprout-work',
    },
  ]),
  projects,
  pool: new EnvironmentPool({ definitions: [definition], instances: [instance], store: sqlite.leases }),
  store: sqlite.runs,
  leaseTtlMs: 60_000,
});
const coordinator = new CollaborationCoordinator({
  projects,
  store,
  runs: orchestrator,
  onObservation: ({ observation }) =>
    line(`  observation: ${observation.status} (${observation.agentId}) — ${observation.detail}`),
});

try {
  line('Sprout collaboration probe (#25)');
  line(`  worker: a separate process (pid differs from this one: ${connection.info.pid !== process.pid})`);
  line(`  persistence: real SQLite database in a temporary directory`);
  line(`  engine: scripted fake (transport isolation only)`);
  line();

  const input = {
    projectId: 'project-sprout',
    channel: 'direct' as const,
    author: { id: 'human-lead', kind: 'human' as const },
    body: 'What does the M1 wake contract prefer?',
    recipients: ['scout'],
    deliveryKey: 'probe-delivery-1',
  };

  line('delivery 1 (new key)');
  const first = await coordinator.deliver(input);
  line(`  message:    ${first.message.id}`);
  line(`  duplicate:  ${first.duplicate}`);
  line(`  wakes:      ${first.wakes.length}`);
  for (const wake of first.wakes) {
    line(`    - ${wake.agentId} reason=${wake.reason} status=${wake.status} run=${wake.runId ?? '(none)'}`);
  }
  line(`  admitted:   ${first.admittedRunIds.length}`);

  line();
  line('delivery 2 (same key — idempotent retry)');
  const second = await coordinator.deliver(input);
  line(`  duplicate:  ${second.duplicate}`);
  line(`  admitted:   ${second.admittedRunIds.length}`);

  line();
  line('durable conversation (read back from the database)');
  for (const message of await store.listMessages()) {
    const arrow = message.inReplyTo ? `  ↳ replies to ${message.inReplyTo}` : '';
    line(`  [${message.author.kind}] ${message.author.id}: ${message.body}${arrow}`);
  }

  const db = new DatabaseSync(dbPath);
  const wakeCount = (db.prepare('SELECT COUNT(*) AS n FROM collaboration_wake_requests').get() as { n: number }).n;
  const messageCount = (db.prepare('SELECT COUNT(*) AS n FROM collaboration_messages').get() as { n: number }).n;
  db.close();

  line();
  line('on-disk totals (independent connection)');
  line(`  collaboration_messages:       ${messageCount}`);
  line(`  collaboration_wake_requests:  ${wakeCount}`);

  const reply = (await store.listMessages()).find((message) => message.author.kind === 'agent');
  const leaked = reply
    ? /TOOL_OUTPUT_MUST_NOT_LEAK|PRIVATE_REASONING_MUST_NOT_LEAK/.test(reply.body)
    : false;
  line();
  line('private run events excluded from conversation');
  line(`  tool output / raw reasoning present in reply: ${leaked}`);
} finally {
  await connection.close();
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
}
