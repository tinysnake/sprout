/** DISPOSABLE #239 shared origin fixture. No production imports, credentials, or service. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, lstatSync, openSync, closeSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export function makeOriginFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sprout-prototype-origin-')));
  const host = join(root, 'host-runner');
  const remote = join(root, 'remote-origin');
  const outside = join(root, 'host-outside');
  for (const path of [host, remote, outside]) mkdirSync(path);
  writeFileSync(join(host, 'origin.txt'), 'HOST_ORIGIN');
  writeFileSync(join(remote, 'origin.txt'), 'REMOTE_ORIGIN');
  writeFileSync(join(host, 'effect.txt'), 'HOST_UNCHANGED');
  writeFileSync(join(remote, 'effect.txt'), 'REMOTE_UNCHANGED');
  writeFileSync(join(outside, 'sentinel.txt'), 'HOST_SENTINEL_UNCHANGED');
  writeFileSync(join(outside, 'credential-sibling.txt'), 'SYNTHETIC_CREDENTIAL_SENTINEL');
  return { root, host, remote, outside, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// These rules only isolate file data; other OS operations retain their defaults.
// Work executors additionally have no network. Runtime trees are read-only.
export function fileIsolationProfile({ runtimeRoots, readRoots = [], writeRoots = [], readFiles = [], network = false }) {
  const quoted = path => JSON.stringify(realpathSync(path));
  return ['(version 1)', '(allow default)', '(deny file-read*)', '(deny file-write*)',
    '(allow file-read-metadata)',
    // dyld resolves these system ancestor directories/symlinks before loading Node.
    '(allow file-read* (literal "/") (literal "/opt") (literal "/opt/homebrew") (literal "/opt/homebrew/opt") (literal "/opt/homebrew/Cellar") (literal "/private") (literal "/private/var") (literal "/var") (literal "/etc") (literal "/tmp"))',
    ...['/System', '/usr', '/bin', '/sbin', '/dev', '/private/etc', ...runtimeRoots, ...readRoots]
      .map(path => `(allow file-read* (subpath ${quoted(path)}))`),
    ...readFiles.map(path => `(allow file-read* (literal ${quoted(path)}))`),
    ...writeRoots.map(path => `(allow file-write* (subpath ${quoted(path)}))`),
    ...(network ? [] : ['(deny network*)']),
  ].join('\n');
}

export function launchOrigin(fixture, runtimeRoots) {
  const child = spawn('/usr/bin/sandbox-exec', ['-p', fileIsolationProfile({
    runtimeRoots, readRoots: [fixture.remote, dirname(fileURLToPath(import.meta.url))], writeRoots: [fixture.remote],
  }), process.execPath, fileURLToPath(import.meta.url), '--origin', fixture.remote], {
    cwd: fixture.remote, env: { PATH: '/usr/bin:/bin', HOME: fixture.remote }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Never retain native stderr or request bodies. Correlated replies stay in memory.
  child.stderr.resume();
  const pending = new Map();
  let sequence = 0;
  createInterface({ input: child.stdout }).on('line', line => {
    try { const reply = JSON.parse(line); const waiter = pending.get(reply.id); if (waiter) { pending.delete(reply.id); waiter.resolve(reply); } } catch { /* no raw output */ }
  });
  child.on('exit', () => { for (const waiter of pending.values()) waiter.reject(new Error('origin-exited')); pending.clear(); });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 150_000);
  return {
    child,
    call(op, args) { return new Promise((resolveReply, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('origin-timeout')); }, 10_000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolveReply(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(JSON.stringify({ id, op, args }) + '\n');
    }); },
    async stop() {
      clearTimeout(deadline);
      const exited = new Promise(resolveExit => child.once('exit', resolveExit));
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    },
  };
}

function permitted(root, path, write) {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.startsWith('/') || path.split(/[\\/]/).includes('..')) throw new Error('path-denied');
  const target = resolve(root, path);
  if (!target.startsWith(root + sep)) throw new Error('path-denied');
  const parent = realpathSync(dirname(target));
  if (parent !== root && !parent.startsWith(root + sep)) throw new Error('path-denied');
  if (!write || (() => { try { lstatSync(target); return true; } catch { return false; } })()) {
    if (lstatSync(target).isSymbolicLink() || !realpathSync(target).startsWith(root + sep)) throw new Error('path-denied');
  }
  return target;
}

export function operate(root, op, args) {
  try {
    if (op === 'read') return { ok: true, value: readFileSync(permitted(root, args.path, false), 'utf8') };
    if (op === 'write') {
      if (typeof args.content !== 'string' || args.content.length > 4096) throw new Error('content-denied');
      writeFileSync(permitted(root, args.path, true), args.content, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW });
      return { ok: true, value: 'remote-write-observed' };
    }
    if (op === 'os-negative') {
      // Bypasses path policy deliberately, testing the OS boundary itself. No contents returned.
      let readDenied = false, writeDenied = false;
      try { const fd = openSync(args.path, 'r'); closeSync(fd); } catch (error) { readDenied = ['EPERM', 'EACCES'].includes(error.code); }
      try { const fd = openSync(args.path, 'r+'); closeSync(fd); } catch (error) { writeDenied = ['EPERM', 'EACCES'].includes(error.code); }
      return { ok: readDenied && writeDenied, readDenied, writeDenied };
    }
    return { ok: false, reason: 'unsupported-operation' };
  } catch { return { ok: false, reason: 'path-or-content-denied' }; }
}

if (process.argv[2] === '--origin') {
  const root = realpathSync(process.argv[3]);
  const deadline = setTimeout(() => process.exit(2), 150_000);
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => {
    try { const { id, op, args } = JSON.parse(line); process.stdout.write(JSON.stringify({ id, ...operate(root, op, args) }) + '\n'); } catch { process.stdout.write('{"ok":false,"reason":"invalid-request"}\n'); }
  });
  lines.on('close', () => { clearTimeout(deadline); process.exit(0); });
}
