import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';

import type {
  PrepareTaskContextResult,
  RecycleTaskContextParams,
  TaskContextMaterialization,
  ValidateWorkspaceParams,
  ValidateWorkspaceResult,
} from './protocol.ts';

/**
 * Worker-owned filesystem boundary for Project workspaces and Task contexts.
 *
 * The core sends portable ids and durable facts only.  This module alone turns
 * them into paths and refuses every operation that is not below its root.
 */
export class WorkerWorkspace {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async prepare(input: TaskContextMaterialization): Promise<PrepareTaskContextResult> {
    const root = await this.#rootPath();
    const workspace = await this.#workspace(root, input.projectId, true, input.projectWorkspacePath);
    const sprout = await this.#directory(root, join(workspace, '.sprout'), true);
    const tasks = await this.#directory(root, join(sprout, 'tasks'), true);
    const context = await this.#directory(root, join(tasks, token(input.taskId)), true);
    const agents = await this.#directory(root, join(context, 'agents'), true);

    const manifest = {
      sprout: 'sprout-task-context-v1',
      projectId: input.projectId,
      taskId: input.taskId,
      environmentInstanceId: input.environmentInstanceId,
      environmentLeaseId: input.environmentLeaseId,
    };
    await writeOwned(root, join(sprout, 'PROJECT.md'), renderProject(input));
    await writeJsonOwned(root, join(sprout, 'workspace-sentinel.json'), { sprout: 'sprout-project-workspace-v1', projectId: input.projectId });
    await writeManifest(root, join(context, 'manifest.json'), manifest);
    await writeOwned(root, join(context, 'TASK.md'), renderTask(input));
    await writeOwned(root, join(agents, `${token(input.agentId)}.md`), renderAgent(input));

    const relativeContext = join('.sprout', 'tasks', token(input.taskId));
    const bootstrapInstructions = [
      'Sprout Task bootstrap:',
      `- Read ${join(relativeContext, 'TASK.md')}.`,
      `- Read ${join(relativeContext, 'agents', `${token(input.agentId)}.md`)} for your responsibilities.`,
      '- Read .sprout/PROJECT.md for shared Project rules.',
      '- Work in this Project workspace. Do not edit or remove .sprout/task manifests.',
    ].join('\n');
    await writeOwned(root, join(context, 'BOOTSTRAP.md'), `${bootstrapInstructions}\n`);
    return { bootstrapInstructions };
  }

  async recycle(input: RecycleTaskContextParams): Promise<void> {
    const root = await this.#rootPath();
    const workspace = await this.#workspace(root, input.projectId, false, input.projectWorkspacePath);
    const context = await this.#directory(root, join(workspace, '.sprout', 'tasks', token(input.taskId)), false);
    // This is deliberately before all destructive cleanup.  A missing or
    // replaced Project sentinel must leave the Task context retryable.
    await assertProjectSentinel(root, workspace, input.projectId);
    const manifestPath = join(context, 'manifest.json');
    let manifest: Record<string, unknown>;
    try {
      await regularFile(root, manifestPath);
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    } catch {
      throw new Error('Task context manifest is missing or unreadable; refusing cleanup');
    }
    if (manifest.sprout !== 'sprout-task-context-v1') {
      throw new Error('Task context manifest lacks the Sprout ownership marker; refusing cleanup');
    }
    for (const [key, value] of Object.entries({
      projectId: input.projectId,
      taskId: input.taskId,
      environmentInstanceId: input.environmentInstanceId,
      environmentLeaseId: input.environmentLeaseId,
    })) {
      if (manifest[key] !== value) throw new Error(`Task context manifest ${key} does not match; refusing cleanup`);
    }
    for (const file of await filesBelow(context)) {
      if (file === manifestPath) continue;
      if (!(await readFile(file, 'utf8')).startsWith(OWNED_MARKER)) {
        throw new Error('Task context contains a foreign file; refusing cleanup');
      }
    }
    await rm(context, { recursive: true, force: false });
    // Prove the Project-level owned sentinel survived a narrowly scoped delete.
    await assertProjectSentinel(root, workspace, input.projectId);
  }

  /**
   * Resolve one Project's workspace to its absolute location on this host.
   *
   * The caller names portable facts only. A registered location must be a safe
   * Worker-root-relative path: an absolute or escaping location is refused at
   * this boundary rather than resolved, so a corrupt projection cannot cross
   * the internal Project/Worker boundary as a host path (#93, ADR-0009).
   */
  async projectWorkingDirectory(
    workspaceId: string,
    workspacePath?: string,
    workspaceKind?: 'default' | 'relative',
  ): Promise<string> {
    const root = await this.#rootPath();
    if (workspaceKind === 'default') {
      if (workspacePath !== undefined) {
        throw new Error('a Worker-managed default workspace cannot carry a registered path');
      }
      return this.#workspaceByOpaqueId(root, workspaceId, false);
    }
    return this.#workspace(root, workspaceId, false, workspacePath);
  }

  /**
   * Validate or prepare one Project workspace selection (#93).
   *
   * The Worker owns the filesystem boundary, so it is the only place that turns
   * a portable selection into a real path or creates the Worker-managed default.
   * The absolute location stays here: the result carries an opaque identity — the
   * same stable hash the default Project layout already uses — and, for a
   * relative selection, the relative location it was given.
   */
  async validateWorkspace(input: ValidateWorkspaceParams): Promise<ValidateWorkspaceResult> {
    const root = await this.#rootPath();
    if (input.kind === 'relative') {
      if (input.path === undefined) {
        throw new Error('a relative Project workspace selection requires a location');
      }
      // Create-if-missing through the same containment and symlink checks every
      // other workspace operation uses, so a selection can never escape the
      // Worker root or write through a planted symlink.
      await this.#workspace(root, input.projectId, true, input.path);
      return { workspaceId: token(`${input.projectId}\u0000relative\u0000${input.path}`), kind: 'relative', path: input.path };
    }
    // The Worker-managed default lives at the same stable Project layout used by
    // Task context preparation. Its returned opaque identity is that directory's
    // name, and start-session receives the explicit `default` discriminator so
    // it resolves this identity directly rather than hashing it a second time.
    await this.#workspace(root, input.projectId, true);
    return { workspaceId: token(input.projectId), kind: 'default' };
  }

  async #rootPath(): Promise<string> {
    await mkdir(this.#root, { recursive: true });
    return realpath(this.#root);
  }

  async #workspace(
    root: string,
    projectId: string,
    create: boolean,
    workspacePath?: string,
  ): Promise<string> {
    if (workspacePath !== undefined) {
      if (!isSafeRelativePath(workspacePath)) {
        throw new Error(
          'registered Project workspace path must be relative and stay below the Worker root',
        );
      }
      return this.#directory(root, join(root, workspacePath), create);
    }
    if (projectId.startsWith('/') || projectId.includes('..') || /^[A-Za-z]:/.test(projectId)) {
      throw new Error('Project workspace identity must be portable, not a host path');
    }
    const projects = await this.#directory(root, join(root, 'projects'), create);
    return this.#directory(root, join(projects, token(projectId)), create);
  }

  /** Resolve a Worker-issued default workspace identity without re-hashing it. */
  async #workspaceByOpaqueId(root: string, workspaceId: string, create: boolean): Promise<string> {
    if (!/^[a-f0-9]{24}$/.test(workspaceId)) {
      throw new Error('Worker-managed workspace identity is malformed');
    }
    const projects = await this.#directory(root, join(root, 'projects'), create);
    return this.#directory(root, join(projects, workspaceId), create);
  }

  #insideRoot(root: string, path: string): string {
    const resolved = resolve(path);
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
      throw new Error('refusing workspace operation outside Worker root');
    }
    return resolved;
  }

  /**
   * Create or resolve one path component, then compare its physical location
   * with the Worker root.  Lexical containment alone would follow a planted
   * symlink and let the Worker write or return a host-owned directory.
   */
  async #directory(root: string, path: string, create: boolean): Promise<string> {
    const lexical = this.#insideRoot(root, path);
    if (create) await mkdir(lexical, { recursive: true });
    const physical = await realpath(lexical);
    this.#insideRoot(root, physical);
    if (!(await stat(physical)).isDirectory()) throw new Error('Worker workspace path is not a directory');
    return physical;
  }
}

function token(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

const OWNED_MARKER = '<!-- sprout:task-context -->\n';

async function writeOwned(root: string, path: string, content: string): Promise<void> {
  await regularFile(root, path, true);
  try {
    const existing = await readFile(path, 'utf8');
    if (!existing.startsWith(OWNED_MARKER)) {
      throw new Error('refusing to overwrite a foreign file in the Sprout context');
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await writeFile(path, `${OWNED_MARKER}${content}`, 'utf8');
}

async function writeJsonOwned(root: string, path: string, value: Record<string, unknown>): Promise<void> {
  await regularFile(root, path, true);
  try {
    const existing = JSON.parse(await readFile(path, 'utf8')) as { sprout?: unknown };
    if (typeof existing.sprout !== 'string' || !existing.sprout.startsWith('sprout')) {
      throw new Error('refusing to overwrite a foreign file in the Sprout context');
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeManifest(root: string, path: string, value: Record<string, unknown>): Promise<void> {
  await regularFile(root, path, true);
  try {
    const existing = JSON.parse(await readFile(path, 'utf8')) as { sprout?: unknown };
    if (existing.sprout !== 'sprout-task-context-v1') {
      throw new Error('refusing to overwrite a foreign Task context manifest');
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Verify a file and its parent resolve under the physical Worker root. */
async function regularFile(root: string, path: string, allowMissing = false): Promise<void> {
  const parent = await realpath(resolve(path, '..'));
  insideRoot(root, parent);
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('refusing unsafe non-file entry in Worker workspace');
    }
  } catch (error) {
    if (allowMissing && isNotFound(error)) return;
    throw error;
  }
}

async function assertProjectSentinel(root: string, workspace: string, projectId: string): Promise<void> {
  const sentinel = join(workspace, '.sprout', 'workspace-sentinel.json');
  await regularFile(root, sentinel);
  let value: { sprout?: unknown; projectId?: unknown };
  try {
    value = JSON.parse(await readFile(sentinel, 'utf8')) as { sprout?: unknown; projectId?: unknown };
  } catch {
    throw new Error('Project workspace sentinel is missing or unreadable; refusing cleanup');
  }
  if (value.sprout !== 'sprout-project-workspace-v1' || value.projectId !== projectId) {
    throw new Error('Project workspace sentinel does not match; refusing cleanup');
  }
}

function insideRoot(root: string, path: string): string {
  const resolved = resolve(path);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error('refusing workspace operation outside Worker root');
  }
  return resolved;
}

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error('Task context contains an unsafe non-file entry; refusing cleanup');
  }
  return files;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

function isSafeRelativePath(path: string): boolean {
  if (path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:/.test(path)) return false;
  return path.split(/[\\/]/).every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function renderProject(input: TaskContextMaterialization): string {
  return ['# Sprout Project rules', '', `Goal: ${input.projectGoal}`, '', 'Rules:', ...(input.projectRules.length ? input.projectRules.map((rule) => `- ${rule}`) : ['- (none declared)']), ''].join('\n');
}

function renderTask(input: TaskContextMaterialization): string {
  return ['# Sprout Task', '', `Title: ${input.taskTitle}`, `Status: ${input.taskStatus}`, '', `Goal: ${input.taskGoal}`, '', 'Constraints:', ...(input.taskConstraints.length ? input.taskConstraints.map((constraint) => `- ${constraint}`) : ['- (none declared)']), '', 'Prior bounded run summaries:', input.priorRunSummaries || '(none)', ''].join('\n');
}

function renderAgent(input: TaskContextMaterialization): string {
  return ['# Your Task responsibilities', '', ...(input.responsibilities.length ? input.responsibilities.map((responsibility) => `- ${responsibility}`) : ['- (none declared)']), '', 'Collaboration instructions:', input.collaborationInstructions || '(none)', ''].join('\n');
}
