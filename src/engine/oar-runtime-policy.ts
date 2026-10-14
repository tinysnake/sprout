import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, rmdirSync, lstatSync, realpathSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { McpServer, SessionOptions } from '@botiverse/oar';
import { EngineStartError, OarPolicyContentionError } from './port.ts';

export interface OarPiPolicy {
  readonly agentDir: string;
  readonly cwd: string;
  readonly agentSettingsHash: string;
  readonly projectSettingsHash: string;
  readonly disallowedTools: readonly string[];
  readonly approvedMcp?: McpServer;
}

export interface OarPiHostConfiguration {
  readonly agentDir: string;
}

/** The single replaceable source of Pi host configuration for the OAR route. */
export interface OarPiConfigurationProvider {
  resolve(): OarPiHostConfiguration;
}

/**
 * Mirrors Pi's published getAgentDir surface without importing the vendor SDK:
 * PI_CODING_AGENT_DIR, or ~/.pi/agent. The adapter resolves this once and the
 * runner pins the result with OAR_PI_AGENT_DIR before loading OAR.
 */
export const hostPiConfigurationProvider: OarPiConfigurationProvider = {
  resolve() {
    const configured = process.env.PI_CODING_AGENT_DIR;
    if (!configured) return { agentDir: join(homedir(), '.pi', 'agent') };
    const expanded = configured === '~'
      ? homedir()
      : configured.startsWith('~/') || configured.startsWith('~\\')
        ? join(homedir(), configured.slice(2))
        : configured;
    return { agentDir: resolve(expanded) };
  },
};

export interface OarRuntimePolicyLease {
  readonly descriptor: OarPiPolicy;
  close(): void;
}

export const OAR_PI_DISALLOWED_BUILTIN_TOOLS = [
  'read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell', 'codemode',
] as const;
/**
 * Lock-directory name for the exclusive OAR Pi policy lease. Contention for
 * either directory is reported as an {@link OarPolicyContentionError} naming
 * the held directory, so a reader can tell a held lease (another session on
 * this machine) from a policy defect (the message below).
 */
export const OAR_POLICY_LOCK_NAME = '.sprout-oar-policy';
const builtinToolPolicy = { defaultTools: [] } as const;
function settingsHash(settings: string): string {
  return createHash('sha256').update(settings).digest('hex');
}
function refused(): never {
  throw new EngineStartError('OAR Pi route is blocked: empty built-in tools and Worker-origin-only MCP could not be established; see #270 and #273');
}

/** Contention message; names the condition without any host-specific path. */
function contentionMessage(scope: 'agent' | 'project'): string {
  const held = scope === 'agent'
    ? `the exclusive lock directory <agentDir>/${OAR_POLICY_LOCK_NAME} is already held by another OAR Pi session on this machine`
    : `the exclusive lock directory <cwd>/.pi/${OAR_POLICY_LOCK_NAME} is already held by another OAR Pi session for this project directory`;
  return `OAR Pi policy lease contention: ${held}, so no session was started. The agent-directory lease is global to the machine and not per worktree: one live OAR Pi session at a time. Wait for the other session to exit and retry; this is contention, not a policy defect. See #270, #273 and #276.`;
}

/** One policy point: host Pi configuration supplies providers/extensions; built-in tools stay empty. */
export function assertOarRuntimePolicy(runtimeId: string, options?: SessionOptions, policy?: OarPiPolicy): void {
  if (runtimeId !== 'pi') return;
  if (!policy || !options || options.cwd !== policy.cwd) refused();
  try {
    const agentSettings = readFileSync(join(policy.agentDir, 'settings.json'), 'utf8');
    const projectSettings = readFileSync(join(policy.cwd, '.pi', 'settings.json'), 'utf8');
    if (!existsSync(join(policy.agentDir, '.sprout-oar-policy')) ||
      !existsSync(join(policy.cwd, '.pi', '.sprout-oar-policy')) ||
      JSON.stringify(JSON.parse(agentSettings).defaultTools) !== JSON.stringify(builtinToolPolicy.defaultTools) ||
      JSON.stringify(JSON.parse(projectSettings).defaultTools) !== JSON.stringify(builtinToolPolicy.defaultTools) ||
      settingsHash(agentSettings) !== policy.agentSettingsHash || settingsHash(projectSettings) !== policy.projectSettingsHash ||
      JSON.stringify(options.disallowedTools) !== JSON.stringify(policy.disallowedTools) ||
      JSON.stringify(policy.disallowedTools) !== JSON.stringify(OAR_PI_DISALLOWED_BUILTIN_TOOLS)) refused();
    const servers = options.mcpServers ?? [];
    if (servers.length !== (policy.approvedMcp ? 1 : 0)) refused();
    if (policy.approvedMcp && (!('url' in policy.approvedMcp) || 'command' in policy.approvedMcp ||
      JSON.stringify(servers[0]) !== JSON.stringify(policy.approvedMcp))) refused();
    // OAR custom env creates a native bash replacement. Never ask it to do so.
    if (options.env !== undefined) refused();
  } catch { refused(); }
}

/** Exclusive host and project settings lease, held until the runner exits, including forced termination. */
export function prepareOarRuntimePolicy(runtimeId: string, cwd: string, input: {
  readonly agentDir?: string;
  readonly approvedMcp?: McpServer;
} = {}): OarRuntimePolicyLease | undefined {
  if (runtimeId !== 'pi') return undefined;
  let projectLocked = false;
  let agentLocked = false;
  let projectOverlay = false;
  let agentOverlay = false;
  let projectBackedUp = false;
  let agentBackedUp = false;
  let projectOriginalMode: number | undefined;
  let agentOriginalMode: number | undefined;
  let createdAgentDir = false;
  let createdPi = false;
  let canonical: string;
  try { canonical = realpathSync(cwd); } catch { refused(); }
  if (!input.agentDir) refused();
  const agentDir = resolve(input.agentDir);
  const pi = join(canonical, '.pi');
  const projectSettingsPath = join(pi, 'settings.json');
  const projectLock = join(pi, OAR_POLICY_LOCK_NAME);
  const projectBackup = join(projectLock, 'settings.json');
  const agentSettingsPath = join(agentDir, 'settings.json');
  const agentLock = join(agentDir, OAR_POLICY_LOCK_NAME);
  const agentBackup = join(agentLock, 'settings.json');
  let closed = false;
  const close = () => {
    if (closed) return;
    // Restore original files by inode rename, preserving exact bytes and permissions.
    if (projectOverlay) rmSync(projectSettingsPath, { force: true });
    if (projectBackedUp) {
      renameSync(projectBackup, projectSettingsPath);
      chmodSync(projectSettingsPath, projectOriginalMode!);
    }
    if (agentOverlay) rmSync(agentSettingsPath, { force: true });
    if (agentBackedUp) {
      renameSync(agentBackup, agentSettingsPath);
      chmodSync(agentSettingsPath, agentOriginalMode!);
    }
    if (projectLocked) rmSync(projectLock, { recursive: true, force: true });
    if (agentLocked) rmSync(agentLock, { recursive: true, force: true });
    if (createdAgentDir) {
      // Remove only the empty directory this lease created.
      try { rmdirSync(agentDir); } catch { /* nonempty is owned by the host */ }
    }
    if (createdPi) {
      // Remove only our empty directory, never resources created by another actor.
      try { rmdirSync(pi); } catch { /* nonempty is owned by the project */ }
    }
    closed = true;
  };
  try {
    if (input.approvedMcp && (!('url' in input.approvedMcp) || 'command' in input.approvedMcp)) refused();
    if (!existsSync(agentDir)) { mkdirSync(agentDir, { recursive: true }); createdAgentDir = true; }
    if (!existsSync(pi)) { mkdirSync(pi); createdPi = true; }
    if (lstatSync(pi).isSymbolicLink() || !lstatSync(pi).isDirectory()) refused();
    // Separate locks serialize sessions across workspaces sharing one host Pi directory.
    try {
      mkdirSync(agentLock, { mode: 0o700 });
    } catch {
      throw new OarPolicyContentionError(contentionMessage('agent'));
    }
    agentLocked = true;
    try {
      mkdirSync(projectLock, { mode: 0o700 });
    } catch {
      throw new OarPolicyContentionError(contentionMessage('project'));
    }
    projectLocked = true;
    let originalProject: Record<string, unknown> = {};
    if (existsSync(projectSettingsPath)) {
      const projectStat = lstatSync(projectSettingsPath);
      if (!projectStat.isFile() || projectStat.isSymbolicLink()) refused();
      projectOriginalMode = projectStat.mode & 0o7777;
      originalProject = JSON.parse(readFileSync(projectSettingsPath, 'utf8'));
      if (!originalProject || typeof originalProject !== 'object' || Array.isArray(originalProject)) refused();
    }
    let originalAgent: Record<string, unknown> = {};
    if (existsSync(agentSettingsPath)) {
      const agentStat = lstatSync(agentSettingsPath);
      if (!agentStat.isFile() || agentStat.isSymbolicLink()) refused();
      agentOriginalMode = agentStat.mode & 0o7777;
      originalAgent = JSON.parse(readFileSync(agentSettingsPath, 'utf8'));
      if (!originalAgent || typeof originalAgent !== 'object' || Array.isArray(originalAgent)) refused();
    }
    // #273's operator-authorized acceptance change preserves host providers,
    // installed extensions and packages, while forcing the effective built-in
    // selection empty in both Pi settings layers.
    const projectSettings = JSON.stringify({ ...originalProject, ...builtinToolPolicy });
    const agentSettings = JSON.stringify({ ...originalAgent, ...builtinToolPolicy });
    if (existsSync(agentSettingsPath)) {
      renameSync(agentSettingsPath, agentBackup);
      agentBackedUp = true;
      chmodSync(agentBackup, 0o600);
    }
    writeFileSync(agentSettingsPath, agentSettings, { flag: 'wx', mode: 0o600 }); agentOverlay = true;
    if (existsSync(projectSettingsPath)) {
      renameSync(projectSettingsPath, projectBackup);
      projectBackedUp = true;
      chmodSync(projectBackup, 0o600);
    }
    writeFileSync(projectSettingsPath, projectSettings, { flag: 'wx', mode: 0o600 }); projectOverlay = true;
    const descriptor: OarPiPolicy = {
      agentDir,
      cwd: canonical,
      agentSettingsHash: settingsHash(agentSettings),
      projectSettingsHash: settingsHash(projectSettings),
      disallowedTools: OAR_PI_DISALLOWED_BUILTIN_TOOLS,
      ...(input.approvedMcp ? { approvedMcp: input.approvedMcp } : {}),
    };
    return { descriptor, close };
  } catch (error) {
    close();
    // Contention is reported by class, not folded into the generic policy refusal.
    if (error instanceof OarPolicyContentionError) throw error;
    refused();
  }
}
