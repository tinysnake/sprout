import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync, rmdirSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer, SessionOptions } from '@botiverse/oar';
import { EngineStartError } from './port.ts';

export interface OarPiPolicy {
  readonly agentDir: string;
  readonly cwd: string;
  readonly projectSettings: string;
  readonly approvedMcp?: McpServer;
}

export interface OarRuntimePolicyLease {
  readonly descriptor: OarPiPolicy;
  close(): void;
}

const suppression = { defaultTools: [], extensions: ['!**/*'], packages: [] };
function refused(): never {
  throw new EngineStartError('OAR Pi route is blocked: controlled settings and Worker-origin-only MCP could not be established; see #270');
}

/** One policy point: no deployment environment variable selects or weakens admission. */
export function assertOarRuntimePolicy(runtimeId: string, options?: SessionOptions, policy?: OarPiPolicy): void {
  if (runtimeId !== 'pi') return;
  if (!policy || !options || options.cwd !== policy.cwd) refused();
  try {
    const global = JSON.parse(readFileSync(join(policy.agentDir, 'settings.json'), 'utf8'));
    const project = readFileSync(join(policy.cwd, '.pi', 'settings.json'), 'utf8');
    const parsed = JSON.parse(project);
    if (!existsSync(join(policy.cwd, '.pi', '.sprout-oar-policy')) ||
      Object.entries(suppression).some(([key, value]) => JSON.stringify(parsed[key]) !== JSON.stringify(value)) ||
      JSON.stringify(global) !== JSON.stringify(suppression) || project !== policy.projectSettings) refused();
    const servers = options.mcpServers ?? [];
    if (servers.length !== (policy.approvedMcp ? 1 : 0)) refused();
    if (policy.approvedMcp && (!('url' in policy.approvedMcp) || 'command' in policy.approvedMcp ||
      JSON.stringify(servers[0]) !== JSON.stringify(policy.approvedMcp))) refused();
    // OAR custom env creates a native bash replacement. Never ask it to do so.
    if (options.env !== undefined) refused();
  } catch { refused(); }
}

/**
 * Resolves host-approved Pi model/provider configuration into a validated models.json descriptor.
 *
 * Checks the host agent directory for explicit models.json providers, or constructs provider
 * descriptors from host-persisted models-store.json and auth.json (e.g. gateway providers like magpie).
 * Returns undefined if no host provider configuration is found.
 */
export function resolveHostApprovedPiModels(targetModel?: string): Readonly<Record<string, unknown>> | undefined {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  const modelsJsonPath = join(agentDir, 'models.json');
  const storePath = join(agentDir, 'models-store.json');
  const authPath = join(agentDir, 'auth.json');

  let providers: Record<string, unknown> = {};

  if (existsSync(modelsJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(modelsJsonPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object') {
        providers = { ...parsed.providers };
      }
    } catch { /* malformed models.json ignored */ }
  }

  const slash = targetModel ? targetModel.indexOf('/') : -1;
  const targetProvider = targetModel && slash > 0 ? targetModel.slice(0, slash) : undefined;

  if (existsSync(storePath)) {
    try {
      const store = JSON.parse(readFileSync(storePath, 'utf8'));
      let auth: Record<string, { key?: string; apiKey?: string }> = {};
      if (existsSync(authPath)) {
        try {
          auth = JSON.parse(readFileSync(authPath, 'utf8')) || {};
        } catch { /* malformed auth.json ignored */ }
      }

      for (const [providerId, provData] of Object.entries(store)) {
        if (providers[providerId]) continue;
        if (!provData || typeof provData !== 'object' || !Array.isArray((provData as { models?: unknown[] }).models)) continue;

        if (targetProvider && targetProvider !== providerId) continue;

        const candidateModels = (provData as { models: Array<Record<string, unknown>> }).models.filter(
          (m) => m && typeof m === 'object' && typeof m.id === 'string',
        );
        if (candidateModels.length === 0) continue;

        const first = candidateModels[0];
        if (!first || typeof first.baseUrl !== 'string') continue;

        const apiKey = auth[providerId]?.key || auth[providerId]?.apiKey;

        providers[providerId] = {
          baseUrl: first.baseUrl,
          api: typeof first.api === 'string' ? first.api : 'openai-completions',
          ...(apiKey ? { apiKey } : {}),
          models: candidateModels.map((m) => ({
            id: m.id,
            ...(typeof m.name === 'string' ? { name: m.name } : {}),
            ...(typeof m.reasoning === 'boolean' ? { reasoning: m.reasoning } : {}),
            ...(typeof m.contextWindow === 'number' ? { contextWindow: m.contextWindow } : {}),
            ...(typeof m.maxTokens === 'number' ? { maxTokens: m.maxTokens } : {}),
          })),
        };
      }
    } catch { /* store read errors ignored */ }
  }

  return Object.keys(providers).length > 0 ? { providers } : undefined;
}

/** Exclusive settings overlay, held until the runner exits, including forced termination. */
export function prepareOarRuntimePolicy(runtimeId: string, cwd: string, input: {
  readonly approvedMcp?: McpServer;
  readonly models?: Readonly<Record<string, unknown>>;
  readonly targetModel?: string;
} = {}): OarRuntimePolicyLease | undefined {
  if (runtimeId !== 'pi') return undefined;
  let agentDir: string | undefined;
  let locked = false;
  let overlay = false;
  let backedUp = false;
  let createdPi = false;
  let canonical: string;
  try { canonical = realpathSync(cwd); } catch { refused(); }
  const pi = join(canonical, '.pi');
  const settings = join(pi, 'settings.json');
  const lock = join(pi, '.sprout-oar-policy');
  const backup = join(lock, 'settings.json');
  let closed = false;
  const close = () => {
    if (closed) return;
    // Preserve the original inode, bytes and permissions; do not rewrite the original JSON.
    if (overlay) rmSync(settings, { force: true });
    if (backedUp) renameSync(backup, settings);
    if (locked) rmSync(lock, { recursive: true, force: true });
    if (createdPi) {
      // Remove only our empty directory, never resources created by another actor.
      try { rmdirSync(pi); } catch { /* nonempty is owned by the project */ }
    }
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    closed = true;
  };
  try {
    if (input.approvedMcp && (!('url' in input.approvedMcp) || 'command' in input.approvedMcp)) refused();
    if (!existsSync(pi)) { mkdirSync(pi); createdPi = true; }
    if (lstatSync(pi).isSymbolicLink() || !lstatSync(pi).isDirectory()) refused();
    mkdirSync(lock, { mode: 0o700 }); locked = true;
    let original: Record<string, unknown> = {};
    if (existsSync(settings)) {
      if (!lstatSync(settings).isFile() || lstatSync(settings).isSymbolicLink()) refused();
      original = JSON.parse(readFileSync(settings, 'utf8'));
      if (!original || typeof original !== 'object' || Array.isArray(original)) refused();
    }
    // Replace unsafe discovery settings for this session; restore the original unchanged.
    const projectSettings = JSON.stringify({ ...original, ...suppression });
    agentDir = mkdtempSync(join(tmpdir(), 'sprout-oar-pi-'));
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(suppression), { mode: 0o600 });
    const approvedModels = input.models ?? resolveHostApprovedPiModels(input.targetModel);
    if (approvedModels) writeFileSync(join(agentDir, 'models.json'), JSON.stringify(approvedModels), { mode: 0o600 });
    if (existsSync(settings)) { renameSync(settings, backup); backedUp = true; }
    writeFileSync(settings, projectSettings, { flag: 'wx', mode: 0o600 }); overlay = true;
    const descriptor: OarPiPolicy = { agentDir, cwd: canonical, projectSettings,
      ...(input.approvedMcp ? { approvedMcp: input.approvedMcp } : {}) };
    return { descriptor, close };
  } catch {
    close();
    refused();
  }
}
