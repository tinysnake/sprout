/** Disposable #229: actual pinned OAR session, deterministic external CLI fault. */
import { registerHooks, createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { prototypeAdapter } from './prototype-oar-engine-seam.mjs';

const script = fileURLToPath(import.meta.url);
if (process.argv.includes('--scripted-cli')) {
  const deadline = setTimeout(() => process.exit(2), 10_000);
  const emit = message => process.stdout.write(JSON.stringify(message) + '\n');
  let prompted = false;
  createInterface({ input: process.stdin }).on('line', line => {
    const input = JSON.parse(line);
    if (input.type !== 'user' || prompted) return;
    prompted = true;
    emit({ type: 'system', subtype: 'task_notification', status: 'stopped' });
    emit({ type: 'system', subtype: 'command_lifecycle', command_id: input.uuid, state: 'queued' });
    emit({ type: 'result', subtype: 'success', origin: { kind: process.env.FAULT_ORIGIN || 'task-notification' }, num_turns: 0, result: 'BACKGROUND_ONLY', usage: { input_tokens: 17, output_tokens: 3 } });
    setTimeout(() => {
      emit({ type: 'system', subtype: 'command_lifecycle', command_id: input.uuid, state: 'started' });
      emit({ type: 'result', subtype: 'success', parent_tool_use_id: 'synthetic-child', result: 'CHILD_ONLY' });
      emit({ type: 'assistant', message: { id: 'synthetic-root-message', content: [{ type: 'text', text: 'ROOT_ONLY' }] } });
      emit({ type: 'result', subtype: 'success', result: 'ROOT_ONLY', usage: { input_tokens: 5, output_tokens: 2 } });
    }, 150);
  }).on('close', () => { clearTimeout(deadline); process.exit(0); });
} else {
  const root = resolve(process.env.OAR_PROBE_ROOT || 'missing-oar-prerequisite');
  const deps = resolve(process.env.OAR_PROBE_DEPS || 'missing-dependency-prerequisite');
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'))).version, '0.35.0');
  const require = createRequire(join(deps, 'package.json'));
  const dependencyUrls = Object.fromEntries(['cross-spawn', 'which'].map(name => [name, pathToFileURL(require.resolve(name)).href]));
  const projection = pathToFileURL(join(root, 'dist/runtimes/claude/projection.js')).href;
  const hook = pathToFileURL(join(import.meta.dirname, 'prototype-claude-origin-hook.mjs')).href;
  let enableHook = false;
  registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'oar-claude-original-projection') return { url: projection, shortCircuit: true };
    if (enableHook && specifier === './projection.js' && context.parentURL?.includes('/runtimes/claude/session.js')) return { url: hook, shortCircuit: true };
    if (dependencyUrls[specifier]) return { url: dependencyUrls[specifier], shortCircuit: true };
    return next(specifier, context);
  } });
  const { promptAndWait } = await import(pathToFileURL(join(root, 'dist/observe/turns.js')));
  const scratch = mkdtempSync(join(tmpdir(), 'sprout-oar-claude-fault-'));
  const command = join(scratch, 'scripted-cli');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(command, '#!/bin/sh\nexec ' + [process.execPath, script, '--scripted-cli'].map(quote).join(' ') + '\n');
  chmodSync(command, 0o700);
  const facts = { evidenceClass: 'scripted', oar: '0.35.0', cases: [] };
  const deadline = setTimeout(() => process.exit(2), 20_000);
  try {
    for (const [name, hooked, originKind] of [['original', false, 'task-notification'], ['hooked', true, 'task-notification'], ['unknown-origin-hooked', true, 'unknown-autonomous']]) {
      enableHook = hooked;
      // Separate module instance keeps each session's projection binding explicit.
      const { claudeSession } = await import(pathToFileURL(join(root, 'dist/runtimes/claude/session.js')).href + '?case=' + name);
      const session = await claudeSession({ via: 'executable', command }, { cwd: scratch, env: { FAULT_ORIGIN: originKind } });
      let steerObservation = Promise.resolve(null);
      session.rawEvents(record => {
        if (record.kind === 'frame' && record.body.native.origin?.kind === originKind) {
          steerObservation = new Promise(resolveSteer => queueMicrotask(() => session.steer('synthetic harmless steer').then(resolveSteer)));
        }
      });
      try {
        const adapter = prototypeAdapter(async () => session, promptAndWait, 3000);
        const engineSession = await adapter.startSession({ workingDirectory: scratch });
        const result = await engineSession.run('synthetic pending root').completion;
        const terminal = session.records().find(record => record.kind === 'frame' && record.agentPath.length === 0 && record.body.events.some(event => event.kind === 'turn_ended'));
        const premature = terminal?.body.native.origin?.kind === originKind;
        const steer = await steerObservation;
        const fact = { name, pendingRootRemainsSteerableAfterBackground: steer?.kind === 'accepted', pendingRootSettledByBackground: premature, rootTextObservedAtSettlement: result.text === 'ROOT_ONLY', outcome: result.status, childResultSettledRoot: terminal?.body.native.parent_tool_use_id === 'synthetic-child' };
        assert.equal(fact.pendingRootRemainsSteerableAfterBackground, hooked);
        assert.equal(premature, !hooked);
        assert.equal(fact.rootTextObservedAtSettlement, hooked);
        assert.equal(fact.childResultSettledRoot, false);
        if (hooked) {
          const rootUsage = session.records().flatMap(record => record.kind === 'frame' && record.agentPath.length === 0 ? record.body.events : []).filter(event => event.kind === 'usage');
          fact.rootUsageExcludesAutonomous = rootUsage.length === 1 && rootUsage[0].usage.tokens.input === 5;
          assert.equal(fact.rootUsageExcludesAutonomous, true);
        }
        facts.cases.push(fact);
      } finally { await session.dispose(); }
    }
    const { foldClaudeStdout, initialClaudeProjection } = await import(hook);
    const folded = foldClaudeStdout({ ...initialClaudeProjection, abortRequested: true }, { type: 'result', origin: { kind: 'task-notification' }, usage: { input_tokens: 17 } });
    facts.autonomousResultPreservesPendingAbort = folded.state.abortRequested;
    assert.equal(facts.autonomousResultPreservesPendingAbort, true);
    writeFileSync('docs/research/oar-claude-attribution-evidence.json', JSON.stringify(facts, null, 2) + '\n');
    console.log(JSON.stringify(facts));
  } finally { clearTimeout(deadline); rmSync(scratch, { recursive: true, force: true }); }
}
