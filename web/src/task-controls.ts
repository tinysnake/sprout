/**
 * Presentation rules for the Task controls.
 *
 * These are deliberately small and engine-neutral: the Web client presents a
 * Task's outer lifecycle and lets an operator choose a Project Agent, but never
 * presents an engine lifecycle as a Task control.
 */

export interface TaskControlTask {
  readonly environmentLifecycleState?: string;
  readonly recoveryState?: string;
  readonly activeRunId?: string;
}

export interface TaskControlProject {
  readonly memberIds: readonly string[];
}

export interface TaskControlAgent {
  readonly id: string;
  readonly name?: string;
}

/** Distinguishes a begun idle Task from an unbegun `todo` Task. */
export function taskActivity(task: TaskControlTask): string {
  if (task.activeRunId !== undefined) return 'Agent running';
  switch (task.environmentLifecycleState) {
    case undefined:
      return 'Unbegun';
    case 'idle':
    case 'blocked':
    case 'awaiting-validation':
      return 'Task active · Agent idle';
    case 'beginning':
      return 'Task beginning';
    case 'ending':
      return 'Task ending';
    case 'recovery':
      return 'Task recovery';
    case 'ended':
    case 'discarded':
      return 'Task ended';
    default:
      return `Task ${task.environmentLifecycleState}`;
  }
}

/** A human-readable projection of Worker-owned Task context state. */
export function taskContextState(task: TaskControlTask): string {
  switch (task.environmentLifecycleState) {
    case undefined:
      return 'Not created';
    case 'beginning':
      return 'Preparing';
    case 'idle':
    case 'running':
    case 'blocked':
    case 'awaiting-validation':
      return 'Ready';
    case 'ending':
      return 'Cleanup in progress';
    case 'recovery':
      return task.recoveryState === 'ending' ? 'Cleanup needs recovery' : 'Recovery retained';
    case 'ended':
    case 'discarded':
      return 'Recycled';
    default:
      return 'Unknown';
  }
}

/** Only Project members are eligible for a Task's next nested Agent run. */
export function eligibleTaskAgents(
  project: TaskControlProject | undefined,
  agents: readonly TaskControlAgent[],
): readonly TaskControlAgent[] {
  const members = new Set(project?.memberIds ?? []);
  return agents.filter((agent) => members.has(agent.id));
}

/** The controls visible for one outer lifecycle state. */
export function taskControlActions(task: TaskControlTask): readonly string[] {
  if (task.environmentLifecycleState === undefined) return ['begin'];
  if (task.environmentLifecycleState === 'recovery') return ['resume', 'preserve-discard-and-end'];
  if (task.environmentLifecycleState === 'ended' || task.environmentLifecycleState === 'discarded') return [];
  if (task.activeRunId !== undefined) return ['end-disabled'];
  return ['advance', 'await-validation', 'end'];
}

/** Preserve precise lifecycle conflicts and cleanup failures for operator display. */
export function taskFailureMessage(message: string): string {
  return message;
}
