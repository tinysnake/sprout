import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentIdentityError,
  createAgentConfiguration,
  currentConfiguration,
  currentOptions,
  effectiveWorkOptions,
  sanitizeDisplayName,
  sanitizeInstructions,
  sanitizeWorkOption,
  type Agent,
} from './model.ts';
import { AgentService } from './service.ts';
import { InMemoryAgentStore } from './store.ts';
import { projectAgentCompatibility } from './compatibility.ts';
import { evaluateAdmissibleWorkOption, selectAdmissibleWorkOption } from './admission.ts';

/**
 * The portable Agent identity contract (#90, ADR-0008): stable identity,
 * non-empty display name, optional standing instructions, at least one ordered
 * work option, append-only configuration versions, and non-destructive
 * archive/restore. Privacy: no host path, credential, hostname, or address may
 * survive into the durable record.
 */

const OPTION_A = { engine: 'codex', workModel: 'gpt-5.2-codex', effort: 'high' };
const OPTION_B = { engine: 'pi', workModel: 'glm-5', effort: 'medium' };

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const created = createAgentConfiguration({
    displayName: 'Programmer',
    workOptions: [OPTION_A, OPTION_B],
    at: 1_000,
  });
  return {
    id: 'programmer',
    displayName: created.displayName,
    status: 'active',
    configuration: created.configuration,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

test('an Agent requires a non-empty display name', () => {
  assert.throws(() => sanitizeDisplayName(''), AgentIdentityError);
  assert.throws(() => sanitizeDisplayName('   '), AgentIdentityError);
  // A path typed into a display name is redacted to nothing usable, so it is
  // refused rather than persisted.
  assert.throws(() => sanitizeDisplayName('/Users/someone/secrets'), AgentIdentityError);
  assert.equal(sanitizeDisplayName('  Programmer  '), 'Programmer');
});

test('an Agent requires at least one ordered work option', () => {
  assert.throws(
    () => createAgentConfiguration({ displayName: 'X', workOptions: [], at: 1 }),
    (error: unknown) => error instanceof AgentIdentityError && error.code === 'no-work-option',
  );
  const created = createAgentConfiguration({ displayName: 'X', workOptions: [OPTION_A], at: 1 });
  assert.equal(created.configuration.currentVersion, 1);
  assert.deepEqual(
    created.configuration.versions[0]!.options.map((option) => option.engine),
    ['codex'],
  );
});

test('a work option refuses an empty or host-shaped identifier', () => {
  assert.throws(
    () => sanitizeWorkOption({ engine: ' ', workModel: 'm', effort: 'high' }),
    AgentIdentityError,
  );
  assert.throws(
    () => sanitizeWorkOption({ engine: 'codex', workModel: '', effort: 'high' }),
    AgentIdentityError,
  );
  assert.throws(
    () => sanitizeWorkOption({ engine: 'codex', workModel: 'm', effort: '' }),
    AgentIdentityError,
  );
  // A hostname cannot masquerade as a work model.
  assert.throws(
    () => sanitizeWorkOption({ engine: 'codex', workModel: 'buildbox-7', effort: 'high' }),
    AgentIdentityError,
  );
  const option = sanitizeWorkOption({ ...OPTION_A, id: 'primary' });
  assert.equal(option.id, 'primary');
});

test('standing instructions are optional and pass the privacy boundary', () => {
  assert.equal(sanitizeInstructions(undefined), undefined);
  assert.equal(sanitizeInstructions('  '), undefined);
  const instructions = sanitizeInstructions('Check pure functions before claiming completion.');
  assert.equal(instructions, 'Check pure functions before claiming completion.');
  // A credential in instructions is redacted, not preserved.
  const redacted = sanitizeInstructions('Use sk-abcdefghijklmnopqrstuvwx for API calls.');
  assert.ok(!redacted?.includes('sk-abcdefghijklmnopqrstuvwx'));
});

test('configuration versions are append-only and current is the latest', () => {
  const agent = makeAgent();
  const first = currentConfiguration(agent);
  assert.equal(first.version, 1);
  assert.deepEqual(currentOptions(agent).map((option) => option.engine), ['codex', 'pi']);
});

test('a definition-era single engine projects as one work option', () => {
  assert.deepEqual(effectiveWorkOptions({ engine: 'scripted' }), [
    { id: 'primary', engine: 'scripted', workModel: '', effort: '' },
  ]);
  assert.deepEqual(effectiveWorkOptions({ engine: 'pi', model: 'glm-5', effort: 'medium' }), [
    { id: 'primary', engine: 'pi', workModel: 'glm-5', effort: 'medium' },
  ]);
  // Ordered options win when present.
  assert.equal(effectiveWorkOptions({ engine: 'scripted', workOptions: [
    { id: 'one', engine: 'codex', workModel: 'gpt-5.2-codex', effort: 'high' },
  ] }).length, 1);
});

test('the service creates, lists, and gets durable Agents', async () => {
  const service = new AgentService({ store: new InMemoryAgentStore(), clock: () => 5_000 });
  const agent = await service.create({
    id: 'programmer',
    displayName: 'Programmer',
    instructions: 'Be careful.',
    workOptions: [OPTION_A],
  });
  assert.equal(agent.id, 'programmer');
  assert.equal(agent.status, 'active');
  assert.equal(agent.displayName, 'Programmer');
  assert.equal(currentConfiguration(agent).instructions, 'Be careful.');
  assert.deepEqual((await service.list()).map((entry) => entry.id), ['programmer']);
  assert.equal((await service.get('programmer'))?.id, 'programmer');
  assert.equal(await service.get('nobody'), undefined);
});

test('the service refuses a duplicate or invalid identity', async () => {
  const service = new AgentService({ store: new InMemoryAgentStore(), clock: () => 5_000 });
  await service.create({ id: 'programmer', displayName: 'Programmer', workOptions: [OPTION_A] });
  await assert.rejects(
    () => service.create({ id: 'programmer', displayName: 'Other', workOptions: [OPTION_A] }),
    (error: unknown) => error instanceof AgentIdentityError && error.code === 'invalid-identity',
  );
  // A host-shaped identity cannot become a stable Agent id.
  await assert.rejects(
    () => service.create({ id: 'buildbox-7', displayName: 'X', workOptions: [OPTION_A] }),
    (error: unknown) => error instanceof AgentIdentityError && error.code === 'invalid-identity',
  );
});

test('reconfigure appends a version and never rewrites history', async () => {
  let now = 1_000;
  const service = new AgentService({ store: new InMemoryAgentStore(), clock: () => now });
  await service.create({ id: 'programmer', displayName: 'Programmer', workOptions: [OPTION_A] });
  now = 2_000;
  const updated = await service.reconfigure('programmer', {
    displayName: 'Programmer II',
    workOptions: [OPTION_B, OPTION_A],
    reason: 'switch primary engine',
  });
  assert.equal(updated.configuration.currentVersion, 2);
  assert.equal(updated.displayName, 'Programmer II');
  assert.equal(updated.configuration.versions.length, 2);
  assert.deepEqual(
    updated.configuration.versions[0]!.options.map((option) => option.engine),
    ['codex'],
  );
  assert.deepEqual(
    updated.configuration.versions[1]!.options.map((option) => option.engine),
    ['pi', 'codex'],
  );
  // The old version is intact, so a run admitted under v1 stays attributable.
  assert.equal(updated.configuration.versions[0]!.version, 1);
});

test('reconfigure refuses an option-less edit and an unknown agent', async () => {
  const service = new AgentService({ store: new InMemoryAgentStore(), clock: () => 1_000 });
  await service.create({ id: 'programmer', displayName: 'P', workOptions: [OPTION_A] });
  await assert.rejects(
    () => service.reconfigure('programmer', { workOptions: [] }),
    (error: unknown) => error instanceof AgentIdentityError && error.code === 'no-work-option',
  );
  await assert.rejects(
    () => service.reconfigure('nobody', { workOptions: [OPTION_A] }),
    (error: unknown) => error instanceof AgentIdentityError && error.code === 'unknown-agent',
  );
});

test('null clears standing instructions, omission keeps them, and history stays append-only', async () => {
  let now = 1_000;
  const service = new AgentService({ store: new InMemoryAgentStore(), clock: () => now });
  await service.create({
    id: 'programmer',
    displayName: 'P',
    instructions: 'Be careful.',
    workOptions: [OPTION_A],
  });

  // An omitted field keeps the current instructions.
  now = 2_000;
  const kept = await service.reconfigure('programmer', { workOptions: [OPTION_B] });
  assert.equal(currentConfiguration(kept).instructions, 'Be careful.');

  // A string replaces them through the privacy boundary.
  now = 3_000;
  const replaced = await service.reconfigure('programmer', {
    workOptions: [OPTION_B],
    instructions: 'Verify tests.',
  });
  assert.equal(currentConfiguration(replaced).instructions, 'Verify tests.');

  // An explicit null clears: the new version records no instructions while
  // every earlier version keeps the instructions it was admitted under.
  now = 4_000;
  const cleared = await service.reconfigure('programmer', {
    workOptions: [OPTION_B],
    instructions: null,
  });
  assert.equal(currentConfiguration(cleared).instructions, undefined);
  assert.equal(cleared.configuration.versions[0]!.instructions, 'Be careful.');
  assert.equal(cleared.configuration.versions[1]!.instructions, 'Be careful.');
  assert.equal(cleared.configuration.versions[2]!.instructions, 'Verify tests.');
  assert.equal('instructions' in cleared.configuration.versions[3]!, false);

  // The cleared state is durable, not just the returned row.
  const reread = await service.get('programmer');
  assert.ok(reread);
  assert.equal(currentConfiguration(reread).instructions, undefined);
  assert.equal(reread.configuration.versions.length, 4);
});

test('archive is refused while active work depends on the Agent', async () => {
  let activeRun = false;
  let openTask = false;
  const service = new AgentService({
    store: new InMemoryAgentStore(),
    workSafety: {
      hasActiveRun: async () => activeRun,
      hasOpenTaskAssignment: async () => openTask,
    },
    clock: () => 1_000,
  });
  await service.create({ id: 'programmer', displayName: 'P', workOptions: [OPTION_A] });

  activeRun = true;
  await assert.rejects(
    () => service.archive('programmer'),
    (error: unknown) => error instanceof AgentIdentityError && error.code === 'active-work-depends-on-agent',
  );
  activeRun = false;
  openTask = true;
  await assert.rejects(
    () => service.archive('programmer'),
    (error: unknown) => error instanceof AgentIdentityError && error.code === 'active-work-depends-on-agent',
  );
  openTask = false;

  const archived = await service.archive('programmer');
  assert.equal(archived.status, 'archived');
  // The identity, instructions, and full configuration history are retained.
  assert.equal((await service.get('programmer'))?.configuration.currentVersion, 1);
});

test('archive and restore are non-destructive and idempotent-safe', async () => {
  const service = new AgentService({ store: new InMemoryAgentStore(), clock: () => 1_000 });
  await service.create({ id: 'programmer', displayName: 'P', workOptions: [OPTION_A] });
  await service.archive('programmer');
  await assert.rejects(
    () => service.archive('programmer'),
    (error: unknown) => error instanceof AgentIdentityError && error.code === 'already-archived',
  );
  await assert.rejects(
    () => service.reconfigure('programmer', { workOptions: [OPTION_B] }),
    (error: unknown) => error instanceof AgentIdentityError && error.code === 'archived-agent-is-read-only',
  );
  const restored = await service.restore('programmer');
  assert.equal(restored.status, 'active');
  assert.equal(restored.configuration.currentVersion, 1);
  await assert.rejects(
    () => service.restore('programmer'),
    (error: unknown) => error instanceof AgentIdentityError && error.code === 'not-archived',
  );
  await assert.rejects(() => service.archive('nobody'), AgentIdentityError);
});

test('compatibility is a projection over current Environment facts', () => {
  const projection = projectAgentCompatibility({
    workOptions: currentOptions(makeAgent()),
    availableEngines: [
      { engine: 'pi', installed: true, readiness: 'ready', models: { state: 'available', models: ['glm-5'] } },
      { engine: 'codex', installed: false, readiness: 'missing', models: { state: 'none', models: [] } },
    ],
  });
  // The ordered walk skips the missing engine and takes the ready one.
  assert.equal(projection.available, true);
  assert.equal(projection.firstAvailable?.engine, 'pi');
  assert.equal(projection.options[0]!.state, 'missing');
  assert.equal(projection.options[1]!.state, 'available');
});

test('an unsupported Agent stays valid but visibly unavailable', () => {
  const projection = projectAgentCompatibility({
    workOptions: currentOptions(makeAgent()),
    availableEngines: [
      { engine: 'codex', installed: true, readiness: 'login-required', models: { state: 'unknown', models: [] } },
      { engine: 'pi', installed: false, readiness: 'missing', models: { state: 'none', models: [] } },
    ],
  });
  assert.equal(projection.available, false);
  assert.equal(projection.firstAvailable, undefined);
  assert.ok(projection.unavailableReason!.length > 0);
  // Every option carries a decisive textual reason.
  for (const option of projection.options) {
    assert.ok(option.reason.length > 0);
  }
});

test('model availability gates an option independently of engine readiness', () => {
  const projection = projectAgentCompatibility({
    workOptions: [{ id: 'o', engine: 'pi', workModel: 'glm-9-turbo', effort: 'high' }],
    availableEngines: [
      { engine: 'pi', installed: true, readiness: 'ready', models: { state: 'available', models: ['glm-5'] } },
    ],
  });
  assert.equal(projection.available, false);
  assert.equal(projection.options[0]!.state, 'model-unavailable');
});

test('an unobserved engine is unknown, never available', () => {
  const projection = projectAgentCompatibility({
    workOptions: [{ id: 'o', engine: 'agy', workModel: 'm', effort: 'medium' }],
    availableEngines: [],
  });
  assert.equal(projection.available, false);
  assert.equal(projection.options[0]!.state, 'unknown');
});

test('admission selects the first verified option and never a lower one silently', () => {
  const options = currentOptions(makeAgent());
  const facts = [
    { engine: 'codex', installed: true, readiness: 'ready' as const, models: { state: 'available' as const, models: ['gpt-5.2-codex'] } },
    { engine: 'pi', installed: true, readiness: 'ready' as const, models: { state: 'available' as const, models: ['glm-5'] } },
  ];
  assert.equal(selectAdmissibleWorkOption(options, facts)?.engine, 'codex');
  // Facts without the primary engine fall to the next option.
  assert.equal(
    selectAdmissibleWorkOption(options, [facts[1]!])?.engine,
    'pi',
  );
  // Unknown readiness is never admissible.
  assert.equal(
    selectAdmissibleWorkOption(options, [
      { engine: 'codex', installed: true, readiness: 'unknown', models: { state: 'unknown', models: [] } },
      { engine: 'pi', installed: true, readiness: 'unknown', models: { state: 'unknown', models: [] } },
    ]),
    undefined,
  );
  // An empty fact list verifies nothing.
  assert.equal(selectAdmissibleWorkOption(options, []), undefined);
});

test('#129: a required unknown model is unknown in compatibility and refused by admission with matching explanation', () => {
  const options = [{ id: 'opt-1', engine: 'codex', workModel: 'gpt-5.2-codex', effort: 'medium' }];
  const facts = [
    { engine: 'codex', installed: true, readiness: 'ready' as const, models: { state: 'unknown' as const, models: [] } },
  ];
  const compat = projectAgentCompatibility({ workOptions: options, availableEngines: facts });
  assert.equal(compat.available, false);
  assert.equal(compat.options[0]!.state, 'unknown');
  assert.match(compat.options[0]!.reason, /availability is unknown for "codex"/);
  assert.equal(compat.unavailableReason, compat.options[0]!.reason);

  const admission = evaluateAdmissibleWorkOption(options, facts);
  assert.equal(admission.ok, false);
  assert.equal(admission.reason, compat.options[0]!.reason, 'compatibility and admission reasons agree');
  assert.equal(selectAdmissibleWorkOption(options, facts), undefined);
});
