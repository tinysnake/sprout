import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isolationProfile } from '../src/engine/pi-host.ts';

const sentinelContents = 'SPROUT_HOST_DENIAL_SENTINEL';
const root = await mkdtemp(join(tmpdir(), 'sprout-pi-host-denial-'));
const agentRoot = join(root, 'agent');
const sentinelPath = join(root, 'host-sentinel.txt');
let stage = 'platform';

function report(facts) {
  process.stdout.write(`${JSON.stringify(facts)}\n`);
}

try {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
    report({ outcome: 'blocked', stage, reason: 'macos-host-sandbox-unavailable' });
    process.exitCode = 2;
  } else {
    const authRoot = join(homedir(), '.pi', 'agent');
    const packageRoot = join(authRoot, 'install', 'releases', '1.0.4', 'node_modules', '@earendil-works', 'pi-coding-agent');
    const providerRoot = resolve(process.cwd(), '..', 'pi-extensions', 'pi-magpie');
    if (!existsSync(packageRoot) || !existsSync(providerRoot)) {
      report({ outcome: 'blocked', stage: 'host-pi-prerequisites', reason: 'pinned-host-pi-runtime-unavailable' });
      process.exitCode = 2;
    } else {
      stage = 'fixture-setup';
      await mkdir(agentRoot, { recursive: true, mode: 0o700 });
      await writeFile(sentinelPath, sentinelContents, { mode: 0o600 });
      const probePath = join(agentRoot, 'file-access-attempt.mjs');
      await writeFile(probePath, `import { readFileSync, writeFileSync } from 'node:fs';
const target = process.argv.at(-1);
function attempt(operation, callback) {
  try { callback(); return { operation, outcome: 'completed', code: 'none' }; }
  catch (error) {
    const code = ['EPERM', 'EACCES'].includes(error?.code) ? error.code : 'other';
    return { operation, outcome: code === 'other' ? 'failed' : 'refused', code };
  }
}
const read = attempt('read', () => readFileSync(target, 'utf8'));
const write = attempt('write', () => writeFileSync(target, 'SPR0UT_HOST_SENTINEL_CHANGED'));
process.stdout.write(JSON.stringify({ read, write }) + '\\n');
`, { mode: 0o600 });
      const profile = isolationProfile({
        profileId: 'bounded-denial-probe',
        provider: 'magpie',
        model: 'bounded-probe-model',
        packageRoot,
        providerRoot,
        authPath: join(authRoot, 'auth.json'),
        modelsPath: join(authRoot, 'models.json'),
        modelsStorePath: join(authRoot, 'models-store.json'),
        runnerRoot: join(root, 'runner'),
        clock: Date.now,
        agentRoot,
        network: true,
      });

      stage = 'sandboxed-host-file-attempts';
      const child = spawnSync('/usr/bin/sandbox-exec', [
        '-p', profile, process.execPath, probePath, sentinelPath,
      ], { cwd: agentRoot, encoding: 'utf8', timeout: 10_000, maxBuffer: 4096 });
      if (child.error?.code === 'ETIMEDOUT') {
        report({ outcome: 'incomplete', stage, reason: 'sandbox-probe-timeout', modelIssued: false });
        process.exitCode = 1;
      } else if (child.error || child.status !== 0) {
        report({ outcome: 'incomplete', stage, reason: 'sandbox-probe-process-failed', modelIssued: false });
        process.exitCode = 1;
      } else {
        let attempts;
        try { attempts = JSON.parse(child.stdout.trim()); }
        catch {
          report({ outcome: 'incomplete', stage, reason: 'sandbox-probe-output-invalid', modelIssued: false });
          process.exitCode = 1;
        }
        if (attempts) {
          const sentinelUnchanged = await readFile(sentinelPath, 'utf8') === sentinelContents;
          const readDenied = attempts.read?.outcome === 'refused' && ['EPERM', 'EACCES'].includes(attempts.read.code);
          const writeDenied = attempts.write?.outcome === 'refused' && ['EPERM', 'EACCES'].includes(attempts.write.code);
          const denied = readDenied && writeDenied && sentinelUnchanged;
          report({
            outcome: denied ? 'sandbox-read-write-denied' : 'sandbox-denial-incomplete',
            stage,
            attribution: 'Sprout Host Pi isolationProfile enforced by macOS sandbox-exec',
            modelIssued: false,
            readAttempt: attempts.read,
            writeAttempt: attempts.write,
            sentinelUnchanged,
          });
          if (!denied) process.exitCode = 1;
        }
      }
    }
  }
} catch {
  report({ outcome: 'incomplete', stage, reason: 'probe-setup-failed', modelIssued: false });
  process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
