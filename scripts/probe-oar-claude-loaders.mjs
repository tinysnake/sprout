/** Disposable #229 loader controls. No real auth, installed plugin mutation or managed policy mutation. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeOriginFixture, fileIsolationProfile } from './prototype-origin-fixture.mjs';
import { macOsTimezoneFiles } from '../src/engine/host-runtime-files.ts';
const fixture = makeOriginFixture();
const facts = { evidenceClass: 'scripted native CLI loader controls; no model-issued evidence', cli: '2.1.294', loaders: [], unproved: [] };
const deadline = setTimeout(() => process.exit(2), 165_000);
try {
  const cli = realpathSync(execFileSync('/usr/bin/which', ['claude'], { encoding: 'utf8', timeout: 5000 }).trim());
  if (execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim() !== '2.1.294 (Claude Code)') throw Error('version-drift');
  const control = join(fixture.root, 'c'); mkdirSync(control);
  const config = join(control, 'config'); mkdirSync(config);
  mkdirSync(join(fixture.host, '.claude'));
  const entry = join(control, 'entry.json');
  const effect = join(fixture.outside, 'loader-effect');
  const sentinel = join(fixture.outside, 'sentinel.txt');
  const canary = join(control, 'canary.cjs');
  writeFileSync(canary, `const fs=require('fs');let read=false,write=false,readDenied=false,writeDenied=false;try{read=fs.readFileSync(${JSON.stringify(sentinel)},'utf8')==='HOST_SENTINEL_UNCHANGED'}catch(e){readDenied=['EPERM','EACCES'].includes(e.code)}try{fs.writeFileSync(${JSON.stringify(effect)},'CANARY_EFFECT');write=true}catch(e){writeDenied=['EPERM','EACCES'].includes(e.code)}fs.writeFileSync(${JSON.stringify(entry)},JSON.stringify({entered:true,read,write,readDenied,writeDenied}));`);
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const settings = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: [process.execPath, canary].map(quote).join(' '), timeout: 3 }] }] } };
  const explicit = join(control, 'explicit.json');
  const plugin = join(control, 'plugin');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  mkdirSync(join(plugin, 'hooks'));
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'synthetic-canary', version: '1.0.0', description: 'Disposable loader control' }));
  const paths = { plugin: join(plugin, 'hooks', 'hooks.json'), user: join(config, 'settings.json'), project: join(fixture.host, '.claude', 'settings.json'), local: join(fixture.host, '.claude', 'settings.local.json'), explicit };
  const baseProfile = fileIsolationProfile({ runtimeRoots: ['/opt/homebrew', dirname(realpathSync(process.execPath)), dirname(cli)], readRoots: [control, fixture.host], writeRoots: [control], network: true }) + '\n(allow file-write* (literal "/dev/null"))' + macOsTimezoneFiles().map(path => `\n(allow file-read-data (literal ${JSON.stringify(path)}))`).join('');
  // Synthetic auth fails at the deliberately closed local route; no real credentials are read.
  const env = { HOME: control, PATH: '/usr/bin:/bin', TMPDIR: control, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_TMPDIR: control, ANTHROPIC_API_KEY: 'synthetic-not-a-credential', ANTHROPIC_BASE_URL: 'http://localhost:1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', API_TIMEOUT_MS: '1000', CLAUDE_CODE_MAX_RETRIES: '0' };
  for (const [source, path] of Object.entries(paths)) {
    for (const other of Object.values(paths)) rmSync(other, { force: true });
    writeFileSync(path, JSON.stringify(settings));
    const row = { source, cases: [] };
    for (const mode of ['positive', 'denied', 'restricted']) {
      rmSync(entry, { force: true }); rmSync(effect, { force: true });
      const profile = baseProfile + (mode === 'positive' ? `\n(allow file-read* (subpath ${JSON.stringify(fixture.outside)}))\n(allow file-write* (subpath ${JSON.stringify(fixture.outside)}))` : '');
      const flags = ['--print', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk', '--setting-sources', mode === 'restricted' || ['explicit', 'plugin'].includes(source) ? '' : source, ...(source === 'plugin' ? ['--plugin-dir', plugin] : []), ...(source === 'explicit' ? ['--settings', explicit] : []), ...(mode === 'restricted' ? ['--bare', '--disable-slash-commands'] : []), 'Reply READY.'];
      const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, cli, ...flags], { cwd: fixture.host, env, encoding: 'utf8', timeout: 4500, maxBuffer: 32768 });
      row.cases.push({ mode, exitCode: result.status, timedOut: result.error?.code === 'ETIMEDOUT', entry: existsSync(entry) ? JSON.parse(readFileSync(entry, 'utf8')) : null, effectPresent: existsSync(effect) });
    }
    const positive = row.cases[0], denied = row.cases[1], restricted = row.cases[2];
    row.positiveObserved = positive.entry?.read === true && positive.entry?.write === true && positive.effectPresent;
    row.attemptedAndDenied = denied.entry?.entered === true && denied.entry?.readDenied === true && denied.entry?.writeDenied === true && !denied.effectPresent;
    row.restrictedSuppressed = row.positiveObserved && restricted.entry === null && !restricted.effectPresent;
    row.disposition = row.positiveObserved && row.attemptedAndDenied && row.restrictedSuppressed ? 'bounded scripted loader control observed' : 'unproved';
    facts.loaders.push(row);
  }
  facts.unproved = [
    { loader: 'CLAUDE.md and rules context', mechanism: 'Bare suppresses discovery; context reads have no entry/execute callback in this probe. Original ambient marker is insufficient.', remedy: 'Capture attempted file reads under pinned native CLI with an authorized OS audit tracer, plus a positive context-load control.' },
    { loader: 'skills', mechanism: 'disable-slash-commands disables skills and Skill is excluded. Bare alone still permits slash-name resolution according to pinned help. No observed skill loader entry.', remedy: 'Authorized isolated skill discovery positive control and audited denied resource read under the restricted launch.' },
    { loader: 'installed plugins, plugin hooks, agents and LSP', mechanism: 'Bare suppresses plugin sync/hooks/LSP. Explicit disposable plugin hooks have their own controls above; automatic installed-plugin registry, agents and LSP entry were not traced.', remedy: 'Register one synthetic plugin only in disposable config, verify native load, then audit denied resource reads/execution with current flags.' },
    { loader: 'managed settings and managed MCP', mechanism: 'System-managed source cannot be redirected by setting-sources; no authorization to modify OS-managed policy and no controlled managed source installed.', remedy: 'Administrator-provisioned disposable managed-policy fixture and native loader read/execute trace, without changing real policy.' },
    { loader: 'MCP resources/prompts', mechanism: 'Approved bridge advertises tools only; resources/prompts are not admitted and no model-visible resource route exists.', remedy: 'A separate bounded admitted resource-loader conformance experiment with typed Worker authority, if that surface is required.' },
    { loader: 'explicit plugin-url/add-dir/agents (and plugin-dir on the OAR route)', mechanism: 'Constructed OAR launch supplies none; OAR SessionOptions does not add these switches. Explicit plugin-dir hook execution is controlled separately above; the remaining source routes did not enter.', remedy: 'Audit immutable launch argument admission and independently control each source if admitted later.' },
  ];
} catch { facts.blocker = 'loader-probe-prerequisite-or-runtime-failure'; }
finally { clearTimeout(deadline); fixture.cleanup(); writeFileSync('docs/research/oar-claude-loader-evidence.json', JSON.stringify(facts, null, 2) + '\n'); console.log(JSON.stringify(facts)); }
