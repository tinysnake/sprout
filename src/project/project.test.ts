import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EnvironmentDefinition, EnvironmentInstance } from '../environment/model.ts';
import { EnvironmentPool } from '../environment/pool.ts';
import { SqliteProjectStore, SqliteStore } from '../run/sqlite-store.ts';
import type { Project } from './model.ts';
import { ProjectRegistry } from './registry.ts';
import { resolveEnvironmentInstance } from './resolve.ts';
import { InMemoryProjectStore } from './store.ts';

function sampleProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-sprout',
    goal: 'Ship a local multi-agent collaboration platform',
    rules: ['Report what you observed', 'Never silently expand scope'],
    availableEnvironmentInstanceIds: ['mac-mini-1', 'container-1'],
    memberships: [
      {
        agentId: 'agent-scout',
        responsibilities: ['Investigate the repository', 'Answer the project lead'],
        collaborationInstructions: 'Keep results concise and cite evidence.',
      },
      {
        agentId: 'agent-cartographer',
        responsibilities: ['Maintain the domain map'],
        collaborationInstructions: 'Flag vocabulary drift.',
      },
    ],
    ...overrides,
  };
}

const macDefinition: EnvironmentDefinition = {
  id: 'macos-workstation',
  platform: 'macos',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};
const containerDefinition: EnvironmentDefinition = {
  id: 'container-linux',
  platform: 'container',
  capabilities: [{ name: 'agent-run', requiresLease: true }],
};
const macInstance: EnvironmentInstance = { id: 'mac-mini-1', definitionId: 'macos-workstation' };
const containerInstance: EnvironmentInstance = { id: 'container-1', definitionId: 'container-linux' };

function pool(options: { instances?: readonly EnvironmentInstance[] } = {}) {
  return new EnvironmentPool({
    definitions: [macDefinition, containerDefinition],
    instances: options.instances ?? [macInstance, containerInstance],
  });
}

test('a project survives an in-memory store round-trip', async () => {
  const store = new InMemoryProjectStore();
  await store.save(sampleProject());

  assert.deepEqual(await store.get('project-sprout'), sampleProject());
  assert.deepEqual(await store.list(), [sampleProject()]);
});

test('a project survives being written to disk and read back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-sqlite-project-'));
  const dbPath = join(dir, 'sprout.db');
  const writer = new SqliteProjectStore({ filename: dbPath });
  await writer.save(sampleProject());
  writer.close();

  // A second store instance is a new process reading the same file.
  const reader = new SqliteProjectStore({ filename: dbPath });
  const restored = await reader.get('project-sprout');
  reader.close();

  assert.deepEqual(restored, sampleProject());
});

test('saving the same project again updates it rather than duplicating it', async () => {
  const store = new SqliteProjectStore({ filename: ':memory:' });
  await store.save(sampleProject());
  await store.save(sampleProject({ goal: 'A revised goal' }));

  const all = await store.list();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.goal, 'A revised goal');
  store.close();
});

test('SqliteStore manages runs, leases, and projects over one connection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprout-sqlite-all-'));
  const store = new SqliteStore({ filename: join(dir, 'sprout.db') });
  await store.projects.save(sampleProject());

  const restored = await store.projects.get('project-sprout');
  assert.deepEqual(restored, sampleProject());
  store.close();
});

test('the registry finds a project by its members and hydrates from a store', async () => {
  const registry = new ProjectRegistry([sampleProject()]);
  assert.equal(registry.forAgent('agent-scout').length, 1);
  assert.equal(registry.forAgent('agent-nobody').length, 0);

  const store = new InMemoryProjectStore();
  await store.save(sampleProject({ id: 'project-other' }));
  const loaded = await registry.load(store);

  assert.equal(loaded.length, 2);
  assert.equal(registry.get('project-other')?.goal, sampleProject().goal);
});

test('an agent that is a member of several projects resolves against the first that can serve it', () => {
  const empty = sampleProject({ id: 'project-empty', availableEnvironmentInstanceIds: [] });
  const usable = sampleProject({ id: 'project-usable', availableEnvironmentInstanceIds: ['container-1'] });

  const resolution = resolveEnvironmentInstance([empty, usable], 'agent-run', pool());
  assert.deepEqual(resolution, { ok: true, instanceId: 'container-1', projectId: 'project-usable' });
});

test('resolution uses the project environment order, not the pool order', () => {
  const project = sampleProject({ availableEnvironmentInstanceIds: ['container-1', 'mac-mini-1'] });
  const resolution = resolveEnvironmentInstance([project], 'agent-run', pool());
  assert.equal(resolution.ok && resolution.instanceId, 'container-1');
});

test('resolution refuses precisely when no project or no environment can serve the capability', () => {
  const noProject = resolveEnvironmentInstance([], 'agent-run', pool());
  assert.deepEqual(noProject, { ok: false, reason: 'no-project' });

  const noEnvironment = resolveEnvironmentInstance(
    [sampleProject({ availableEnvironmentInstanceIds: [] })],
    'agent-run',
    pool(),
  );
  assert.equal(noEnvironment.ok, false);
  assert.equal(noEnvironment.ok === false && noEnvironment.reason, 'no-available-environment');

  // A project that names an instance the pool does not know cannot serve either.
  const unknown = resolveEnvironmentInstance(
    [sampleProject({ availableEnvironmentInstanceIds: ['decommissioned-host'] })],
    'agent-run',
    pool(),
  );
  assert.equal(unknown.ok === false && unknown.reason, 'no-available-environment');

  // A project that names a real instance lacking the capability cannot serve it.
  const lacking = resolveEnvironmentInstance(
    [sampleProject({ availableEnvironmentInstanceIds: ['mac-mini-1'] })],
    'gpu-render',
    pool(),
  );
  assert.equal(lacking.ok, false);
});
