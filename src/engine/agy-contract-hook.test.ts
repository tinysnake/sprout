import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGY_CONTRACT_HOOK_NAME,
  AGY_CONTRACT_HOOK_SCRIPT,
  AGY_CONTRACT_PAYLOAD_ENV,
  agyContractHookScriptPath,
  deliverContractThroughAgyHook,
  hookCommand,
  removeAgyContractPayload,
} from './agy-contract-hook.ts';

/**
 * `agy` contract delivery through the engine's own config hook.
 *
 * The rule: install a `SessionStart` hook in agy's customization root, write a
 * per-run payload, and hand back the env var that selects it. The hook must be
 * idempotent and must never replace configuration Sprout does not own.
 */

function configDir(): string {
  return mkdtempSync(join(tmpdir(), 'sprout-agy-hook-'));
}

test('the hook is installed, a per-run payload is written, and the env var selects it', () => {
  const dir = configDir();
  const payloadPath = join(dir, 'sprout-payloads', 'run-1.json');

  const result = deliverContractThroughAgyHook({
    configDirectory: dir,
    payloadPath,
    instructions: '# Project contract\nGoal: ship it',
  });

  assert.equal(result.delivery.mechanism, 'engine-hook');
  assert.equal(result.env[AGY_CONTRACT_PAYLOAD_ENV], payloadPath);
  assert.equal(result.payloadPath, payloadPath);

  const hooks = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')) as Record<
    string,
    { SessionStart?: { command?: string }[] }
  >;
  const command = hooks[AGY_CONTRACT_HOOK_NAME]?.SessionStart?.[0]?.command ?? '';
  assert.match(command, /sprout-project-contract\.sh/, 'the hook runs the Sprout script');
  assert.ok(
    existsSync(join(dir, AGY_CONTRACT_HOOK_SCRIPT)),
    'the hook script is written under the customization root',
  );

  const payload = JSON.parse(readFileSync(payloadPath, 'utf8')) as {
    injectSteps: { ephemeralMessage: string }[];
  };
  assert.equal(
    payload.injectSteps[0]?.ephemeralMessage,
    '# Project contract\nGoal: ship it',
    'the contract travels as an injected ephemeral system message',
  );
});

test('installing the hook preserves every other hook already configured', () => {
  const dir = configDir();
  writeFileSync(
    join(dir, 'hooks.json'),
    JSON.stringify({ 'someone-elses': { PreInvocation: [{ command: './theirs.sh' }] } }, null, 2),
  );

  deliverContractThroughAgyHook({
    configDirectory: dir,
    payloadPath: join(dir, 'p.json'),
    instructions: 'contract',
  });

  const hooks = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')) as Record<string, unknown>;
  assert.ok(hooks['someone-elses'], 'a pre-existing hook is preserved');
  assert.ok(hooks[AGY_CONTRACT_HOOK_NAME], 'and the Sprout hook is added alongside it');
});

test('installing the hook twice is idempotent', () => {
  const dir = configDir();
  deliverContractThroughAgyHook({
    configDirectory: dir,
    payloadPath: join(dir, 'p1.json'),
    instructions: 'first',
  });
  deliverContractThroughAgyHook({
    configDirectory: dir,
    payloadPath: join(dir, 'p2.json'),
    instructions: 'second',
  });

  const hooks = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(hooks), [AGY_CONTRACT_HOOK_NAME], 'one Sprout hook, not two');
});

test('a hooks.json that cannot be parsed is left alone and reported unavailable', () => {
  const dir = configDir();
  const hooksPath = join(dir, 'hooks.json');
  const original = '{ this is not json';
  writeFileSync(hooksPath, original);

  const result = deliverContractThroughAgyHook({
    configDirectory: dir,
    payloadPath: join(dir, 'p.json'),
    instructions: 'contract',
  });

  assert.equal(result.delivery.mechanism, 'unavailable');
  assert.deepEqual(result.env, {});
  assert.equal(readFileSync(hooksPath, 'utf8'), original, 'the user file was not replaced');
});

test('an unwritable customization root is reported unavailable, not claimed delivered', () => {
  const dir = configDir();
  chmodSync(dir, 0o500);
  let writable = true;
  try {
    writeFileSync(join(dir, 'probe'), 'x');
    writable = false;
  } catch {
    // Expected: the directory is read-only.
  }
  if (!writable) {
    chmodSync(dir, 0o755);
    return;
  }

  const result = deliverContractThroughAgyHook({
    configDirectory: dir,
    payloadPath: join(dir, 'sub', 'p.json'),
    instructions: 'contract',
  });
  chmodSync(dir, 0o755);

  assert.equal(result.delivery.mechanism, 'unavailable');
  assert.deepEqual(result.env, {});
});

test('removing a payload tolerates an absent file', () => {
  assert.doesNotThrow(() => {
    removeAgyContractPayload(join(configDir(), 'never-written.json'));
  });
  assert.doesNotThrow(() => removeAgyContractPayload(undefined));
});

test('the installed hook script emits the payload when, and only when, selected', () => {
  // The hook must be a real, executable sh contract: emit the run's payload when
  // the env var points at it, and an empty JSON object otherwise so agy sees no
  // injection for runs Sprout did not launch.
  const dir = configDir();
  const payloadPath = join(dir, 'p.json');
  deliverContractThroughAgyHook({
    configDirectory: dir,
    payloadPath,
    instructions: 'CONTRACT_TEXT',
  });
  const scriptPath = join(dir, AGY_CONTRACT_HOOK_SCRIPT);

  const selected = execFileSync('sh', [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, [AGY_CONTRACT_PAYLOAD_ENV]: payloadPath },
  });
  const injected = JSON.parse(selected) as { injectSteps: { ephemeralMessage: string }[] };
  assert.equal(injected.injectSteps[0]?.ephemeralMessage, 'CONTRACT_TEXT');

  const unselected = execFileSync('sh', [scriptPath], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(unselected), {}, 'no payload selected means no injection');

  // A payload path that has gone away must also degrade to no injection rather
  // than failing the hook.
  removeAgyContractPayload(payloadPath);
  const gone = execFileSync('sh', [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, [AGY_CONTRACT_PAYLOAD_ENV]: payloadPath },
  });
  assert.deepEqual(JSON.parse(gone), {});
});

/**
 * C21-005 — the hook must be runnable on the platform `agy` runs on.
 *
 * `agy` executes a hook `command` through `sh -c` on Unix and `cmd /c` on
 * Windows (its own embedded hook documentation), and `docs/roadmap.md` treats
 * Windows as a supported target (O2, #5). A hook that always invoked `sh` was
 * therefore silently Unix-only. These tests pin the platform-specific artifact
 * and command without needing a Windows host.
 */
test('a Windows hook is a batch file invoked through cmd, not sh', () => {
  const dir = configDir();
  const result = deliverContractThroughAgyHook({
    configDirectory: dir,
    payloadPath: join(dir, 'p.json'),
    instructions: 'CONTRACT_TEXT',
    platform: 'windows',
  });

  assert.equal(result.delivery.mechanism, 'engine-hook');
  const scriptRelative = agyContractHookScriptPath('windows');
  assert.match(scriptRelative, /\.cmd$/, 'the Windows entry is a batch file');
  assert.ok(existsSync(join(dir, scriptRelative)), 'the batch file is written');

  const hooks = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')) as Record<
    string,
    { SessionStart?: { command?: string }[] }
  >;
  const command = hooks[AGY_CONTRACT_HOOK_NAME]?.SessionStart?.[0]?.command ?? '';
  assert.ok(!/^\s*sh\b/.test(command), `the Windows hook does not invoke sh (${command})`);
  assert.match(command, /sprout-project-contract\.cmd/, 'it names the batch file');
  assert.equal(hookCommand('windows', 'C:\\cfg\\hooks\\sprout-project-contract.cmd'),
    '""C:\\cfg\\hooks\\sprout-project-contract.cmd""');
});

test('the Windows batch hook is inert without the payload and emits it when selected', () => {
  // `cmd` is not available on this host, so the batch file's contract is checked
  // as text: a payload-selecting branch that types the payload, and an inert
  // branch that prints `{}`. The POSIX script's behaviour is executed above.
  const dir = configDir();
  deliverContractThroughAgyHook({
    configDirectory: dir,
    payloadPath: join(dir, 'p.json'),
    instructions: 'CONTRACT_TEXT',
    platform: 'windows',
  });
  const script = readFileSync(join(dir, agyContractHookScriptPath('windows')), 'utf8');
  assert.match(script, /%SPROUT_AGY_CONTRACT_PAYLOAD%/, 'selects the run payload by env var');
  assert.match(script, /type "%SPROUT_AGY_CONTRACT_PAYLOAD%"\r?\n/, 'emits the payload');
  assert.match(script, /echo \{\}/, 'an inert run still answers with an empty JSON object');
  assert.ok(script.includes('\r\n'), 'a batch file uses CRLF line endings');
});

test('a supported hook platform is required; an unknown one is reported unavailable', () => {
  const dir = configDir();
  const result = deliverContractThroughAgyHook({
    configDirectory: dir,
    payloadPath: join(dir, 'p.json'),
    instructions: 'contract',
    platform: 'plan9',
  });
  assert.equal(result.delivery.mechanism, 'unavailable');
  assert.deepEqual(result.env, {});
  assert.match(result.delivery.reason ?? '', /not available on this platform/);
  assert.equal(existsSync(join(dir, 'hooks.json')), false, 'nothing was installed');
});
