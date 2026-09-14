import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the pool lease decisions are provably driven by persisted state across real process kill and restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-kill-test-'));
  const dbPath = join(dir, 'sprout.db');

  try {
    // Process 1: acquires a lease in SQLite and stays alive until killed.
    const proc1Code = `
      import { SqliteStore } from './src/run/sqlite-store.ts';
      import { EnvironmentPool } from './src/environment/pool.ts';

      const store = new SqliteStore({ filename: ${JSON.stringify(dbPath)} });
      const pool = new EnvironmentPool({
        definitions: [{
          id: 'macos-workstation',
          platform: 'macos',
          capabilities: [{ name: 'agent-run', requiresLease: true }],
        }],
        instances: [{ id: 'mac-mini-1', definitionId: 'macos-workstation' }],
        store: store.leases,
      });

      const res = pool.acquireLease({
        instanceId: 'mac-mini-1',
        capability: 'agent-run',
        holderId: 'agent-first',
        ttlMs: 600_000,
      });

      if (!res.ok) {
        process.stderr.write('failed to acquire: ' + res.reason + '\\n');
        process.exit(1);
      }

      process.stdout.write('LEASE_HELD:' + res.lease.id + '\\n');
      // Keep process alive indefinitely until killed from outside.
      setInterval(() => {}, 10_000);
    `;

    const child1 = spawn(process.execPath, ['--input-type=module', '-e', proc1Code], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    const leaseId = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      child1.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const match = buffer.match(/LEASE_HELD:(.+)\n/);
        if (match && match[1]) {
          resolve(match[1].trim());
        }
      });
      child1.on('error', reject);
      child1.on('exit', (code) => {
        reject(new Error(`child 1 exited prematurely with code ${code}`));
      });
    });

    assert.ok(leaseId, 'process 1 acquired a lease');

    // Abruptly kill process 1 (SIGKILL) between acquire and release.
    child1.kill('SIGKILL');
    await new Promise((resolve) => child1.on('exit', resolve));

    // Process 2: restarts against the same SQLite file.
    // It must observe the restored lease and enforce exclusion based on persisted state.
    const proc2Code = `
      import { SqliteStore } from './src/run/sqlite-store.ts';
      import { EnvironmentPool } from './src/environment/pool.ts';

      const store = new SqliteStore({ filename: ${JSON.stringify(dbPath)} });
      const pool = new EnvironmentPool({
        definitions: [{
          id: 'macos-workstation',
          platform: 'macos',
          capabilities: [{ name: 'agent-run', requiresLease: true }],
        }],
        instances: [{ id: 'mac-mini-1', definitionId: 'macos-workstation' }],
        store: store.leases,
      });

      // 1. Lease is present from disk
      const existing = pool.getLease(${JSON.stringify(leaseId)});
      if (!existing || (existing.state !== 'active' && existing.state !== 'recovering')) {
        process.stderr.write('lease missing or invalid state: ' + JSON.stringify(existing) + '\\n');
        process.exit(2);
      }

      // 2. Acquiring the same instance conflicts based on persisted lease
      const conflict1 = pool.acquireLease({
        instanceId: 'mac-mini-1',
        capability: 'agent-run',
        holderId: 'agent-second',
        ttlMs: 60_000,
      });
      if (conflict1.ok || conflict1.reason !== 'conflict' || conflict1.heldBy !== 'agent-first') {
        process.stderr.write('expected conflict on active lease, got: ' + JSON.stringify(conflict1) + '\\n');
        process.exit(3);
      }

      // 3. Mark recovering
      const recovering = pool.markRecovering(${JSON.stringify(leaseId)});
      if (!recovering || recovering.state !== 'recovering') {
        process.stderr.write('failed to mark recovering\\n');
        process.exit(4);
      }

      // 4. Acquiring when recovering conflicts and surfaces recovering state
      const conflict2 = pool.acquireLease({
        instanceId: 'mac-mini-1',
        capability: 'agent-run',
        holderId: 'agent-third',
        ttlMs: 60_000,
      });
      if (conflict2.ok || conflict2.reason !== 'conflict' || conflict2.state !== 'recovering') {
        process.stderr.write('expected conflict with recovering state, got: ' + JSON.stringify(conflict2) + '\\n');
        process.exit(5);
      }

      // 5. Resolving recovery frees the instance
      const released = pool.resolveRecovery(${JSON.stringify(leaseId)});
      if (!released || released.state !== 'released') {
        process.stderr.write('failed to release recovering lease\\n');
        process.exit(6);
      }

      // 6. Now acquisition succeeds
      const success = pool.acquireLease({
        instanceId: 'mac-mini-1',
        capability: 'agent-run',
        holderId: 'agent-fourth',
        ttlMs: 60_000,
      });
      if (!success.ok) {
        process.stderr.write('failed to acquire after release\\n');
        process.exit(7);
      }

      store.close();
      process.stdout.write('PERSISTED_LEASE_VERIFIED\\n');
    `;

    const child2 = spawn(process.execPath, ['--input-type=module', '-e', proc2Code], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    const output = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      child2.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
      });
      child2.on('error', reject);
      child2.on('exit', (code) => {
        if (code === 0) resolve(buffer);
        else reject(new Error(`child 2 exited with failure code ${code}`));
      });
    });

    assert.match(output, /PERSISTED_LEASE_VERIFIED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an orphaned mid-flight run after restart has an explicit failed state with events intact, exercised by real restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-orphan-restart-'));
  const dbPath = join(dir, 'sprout.db');

  try {
    // Process 1: starts a run that emits events and hangs mid-flight, then gets killed.
    const proc1Code = `
      import { SqliteStore } from './src/run/sqlite-store.ts';
      import { EnvironmentPool } from './src/environment/pool.ts';
      import { RunOrchestrator } from './src/run/orchestrator.ts';
      import { AgentRegistry } from './src/agent/registry.ts';
      import { ProjectRegistry } from './src/project/registry.ts';
      import { ScriptedEngineAdapter } from './src/engine/scripted.ts';

      const store = new SqliteStore({ filename: ${JSON.stringify(dbPath)} });
      const pool = new EnvironmentPool({
        definitions: [{
          id: 'macos-workstation',
          platform: 'macos',
          capabilities: [{ name: 'agent-run', requiresLease: true }],
        }],
        instances: [{ id: 'mac-mini-1', definitionId: 'macos-workstation' }],
        store: store.leases,
      });

      // An engine adapter that emits progress and then hangs indefinitely
      const hangingAdapter = {
        name: 'hanging-engine',
        async startSession() {
          return {
            run() {
              async function* generate() {
                yield { type: 'notice', text: 'turn-started' };
                yield { type: 'tool-call', name: 'bash', detail: 'echo pre-kill-progress' };
                yield { type: 'tool-output', text: 'pre-kill-progress\\n' };
                // Hang forever: never complete
                await new Promise(() => {});
              }
              return {
                events: generate(),
                completion: new Promise(() => {}),
              };
            },
            async interrupt() {},
            async close() {},
          };
        },
      };

      const agents = new AgentRegistry([{
        id: 'scout',
        name: 'Scout',
        engine: 'hanging-engine',
        capability: 'agent-run',
        workingDirectory: '/tmp',
      }]);

      const projects = new ProjectRegistry([{
        id: 'sprout',
        goal: 'Ship Sprout',
        rules: [],
        availableEnvironmentInstanceIds: ['mac-mini-1'],
        memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }],
      }]);

      const orchestrator = new RunOrchestrator({
        engines: new Map([['hanging-engine', hangingAdapter]]),
        agents,
        projects,
        pool,
        store: store.runs,
      });

      const { id } = await orchestrator.submit({ agentId: 'scout', prompt: 'work on something big' });

      // Poll until the events are saved to the store
      const check = setInterval(async () => {
        const saved = await store.runs.get(id);
        if (saved && saved.status === 'running' && saved.events.length >= 3) {
          clearInterval(check);
          process.stdout.write('RUN_MID_FLIGHT:' + id + '\\n');
        }
      }, 50);
    `;

    const child1 = spawn(process.execPath, ['--input-type=module', '-e', proc1Code], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    const runId = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      child1.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const match = buffer.match(/RUN_MID_FLIGHT:(.+)\n/);
        if (match && match[1]) {
          resolve(match[1].trim());
        }
      });
      child1.on('error', reject);
      child1.on('exit', (code) => {
        reject(new Error(`child 1 exited prematurely with code ${code}`));
      });
    });

    assert.ok(runId, 'run is mid-flight in process 1');

    // Kill process 1 with SIGKILL simulating abrupt process death / restart
    child1.kill('SIGKILL');
    await new Promise((resolve) => child1.on('exit', resolve));

    // Process 2: the restart. Reconciles orphaned runs and verifies explicit end state & lease recovery.
    const proc2Code = `
      import { SqliteStore } from './src/run/sqlite-store.ts';
      import { EnvironmentPool } from './src/environment/pool.ts';
      import { RunOrchestrator } from './src/run/orchestrator.ts';
      import { AgentRegistry } from './src/agent/registry.ts';
      import { ProjectRegistry } from './src/project/registry.ts';

      const store = new SqliteStore({ filename: ${JSON.stringify(dbPath)} });
      const pool = new EnvironmentPool({
        definitions: [{
          id: 'macos-workstation',
          platform: 'macos',
          capabilities: [{ name: 'agent-run', requiresLease: true }],
        }],
        instances: [{ id: 'mac-mini-1', definitionId: 'macos-workstation' }],
        store: store.leases,
      });

      const agents = new AgentRegistry([{
        id: 'scout',
        name: 'Scout',
        engine: 'scripted',
        capability: 'agent-run',
        workingDirectory: '/tmp',
      }]);

      const projects = new ProjectRegistry([{
        id: 'sprout',
        goal: 'Ship Sprout',
        rules: [],
        availableEnvironmentInstanceIds: ['mac-mini-1'],
        memberships: [{ agentId: 'scout', responsibilities: [], collaborationInstructions: '' }],
      }]);

      const orchestrator = new RunOrchestrator({
        engines: new Map(),
        agents,
        projects,
        pool,
        store: store.runs,
      });

      // Run reconciliation
      const orphaned = await orchestrator.reconcileOrphanedRuns();
      if (orphaned.length !== 1) {
        process.stderr.write('expected 1 orphaned run, got ' + orphaned.length + '\\n');
        process.exit(10);
      }

      const run = orphaned[0];
      if (run.id !== ${JSON.stringify(runId)}) {
        process.stderr.write('unexpected run id: ' + run.id + '\\n');
        process.exit(11);
      }

      if (run.status !== 'failed') {
        process.stderr.write('expected failed status, got: ' + run.status + '\\n');
        process.exit(12);
      }

      if (!run.failure || !/restart/i.test(run.failure)) {
        process.stderr.write('expected restart failure message, got: ' + run.failure + '\\n');
        process.exit(13);
      }

      // Check events are intact
      if (run.events.length !== 3) {
        process.stderr.write('events were not preserved! Count: ' + run.events.length + '\\n');
        process.exit(14);
      }

      // Check the associated lease entered recovering state
      const lease = pool.leases().find((l) => l.runId === run.id || l.id === run.leaseId);
      if (!lease) {
        process.stderr.write('lease not found for run\\n');
        process.exit(15);
      }
      if (lease.state !== 'recovering') {
        process.stderr.write('expected lease to be recovering, was: ' + lease.state + '\\n');
        process.exit(16);
      }

      // Ensure acquiring the environment conflicts due to recovery
      const conflict = pool.acquireLease({
        instanceId: 'mac-mini-1',
        capability: 'agent-run',
        holderId: 'agent-new',
        ttlMs: 60_000,
      });
      if (conflict.ok || conflict.state !== 'recovering') {
        process.stderr.write('expected conflict with recovering state, got: ' + JSON.stringify(conflict) + '\\n');
        process.exit(17);
      }

      store.close();
      process.stdout.write('ORPHAN_RECONCILED_SUCCESS\\n');
    `;

    const child2 = spawn(process.execPath, ['--input-type=module', '-e', proc2Code], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    const output = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      child2.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
      });
      child2.on('error', reject);
      child2.on('exit', (code) => {
        if (code === 0) resolve(buffer);
        else reject(new Error(`child 2 exited with failure code ${code}`));
      });
    });

    assert.match(output, /ORPHAN_RECONCILED_SUCCESS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
