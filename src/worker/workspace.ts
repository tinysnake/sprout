import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';

import type {
  PrepareTaskContextResult,
  RecycleTaskContextParams,
  TaskContextMaterialization,
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
    const workspace = this.#workspace(input.projectId);
    const context = this.#context(input.projectId, input.taskId);
    await mkdir(context, { recursive: true });

    const manifest = {
      sprout: 'sprout-task-context-v1',
      projectId: input.projectId,
      taskId: input.taskId,
      environmentInstanceId: input.environmentInstanceId,
      environmentLeaseId: input.environmentLeaseId,
    };
    await writeOwned(join(workspace, '.sprout', 'PROJECT.md'), renderProject(input));
    await writeJsonOwned(join(workspace, '.sprout', 'workspace-sentinel.json'), { sprout: 'sprout-project-workspace-v1', projectId: input.projectId });
    await writeJsonOwned(join(context, 'manifest.json'), manifest);
    await writeOwned(join(context, 'TASK.md'), renderTask(input));
    await writeOwned(join(context, 'agents', `${token(input.agentId)}.md`), renderAgent(input));

    const relativeContext = join('.sprout', 'tasks', token(input.taskId));
    const bootstrapInstructions = [
      'Sprout Task bootstrap:',
      `- Read ${join(relativeContext, 'TASK.md')}.`,
      `- Read ${join(relativeContext, 'agents', `${token(input.agentId)}.md`)} for your responsibilities.`,
      '- Read .sprout/PROJECT.md for shared Project rules.',
      '- Work in this Project workspace. Do not edit or remove .sprout/task manifests.',
    ].join('\n');
    await writeOwned(join(context, 'BOOTSTRAP.md'), `${bootstrapInstructions}\n`);
    return { bootstrapInstructions };
  }

  async recycle(input: RecycleTaskContextParams): Promise<void> {
    const workspace = this.#workspace(input.projectId);
    const context = this.#context(input.projectId, input.taskId);
    const manifestPath = join(context, 'manifest.json');
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    } catch {
      throw new Error('Task context manifest is missing or unreadable; refusing cleanup');
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
    await stat(join(workspace, '.sprout', 'workspace-sentinel.json'));
  }

  projectWorkingDirectory(projectId: string): string {
    return this.#workspace(projectId);
  }

  #workspace(projectId: string): string {
    return this.#insideRoot(join(this.#root, 'projects', token(projectId)));
  }

  #context(projectId: string, taskId: string): string {
    return this.#insideRoot(join(this.#workspace(projectId), '.sprout', 'tasks', token(taskId)));
  }

  #insideRoot(path: string): string {
    const resolved = resolve(path);
    if (resolved !== this.#root && !resolved.startsWith(`${this.#root}${sep}`)) {
      throw new Error('refusing workspace operation outside Worker root');
    }
    return resolved;
  }
}

function token(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

const OWNED_MARKER = '<!-- sprout:task-context -->\n';

async function writeOwned(path: string, content: string): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
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

async function writeJsonOwned(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
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

function renderProject(input: TaskContextMaterialization): string {
  return ['# Sprout Project rules', '', `Goal: ${input.projectGoal}`, '', 'Rules:', ...(input.projectRules.length ? input.projectRules.map((rule) => `- ${rule}`) : ['- (none declared)']), ''].join('\n');
}

function renderTask(input: TaskContextMaterialization): string {
  return ['# Sprout Task', '', `Title: ${input.taskTitle}`, `Status: ${input.taskStatus}`, '', `Goal: ${input.taskGoal}`, '', 'Constraints:', ...(input.taskConstraints.length ? input.taskConstraints.map((constraint) => `- ${constraint}`) : ['- (none declared)']), '', 'Prior bounded run summaries:', input.priorRunSummaries || '(none)', ''].join('\n');
}

function renderAgent(input: TaskContextMaterialization): string {
  return ['# Your Task responsibilities', '', ...(input.responsibilities.length ? input.responsibilities.map((responsibility) => `- ${responsibility}`) : ['- (none declared)']), '', 'Collaboration instructions:', input.collaborationInstructions || '(none)', ''].join('\n');
}
