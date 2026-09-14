import type { Project, ProjectMembership } from './model.ts';

/**
 * Project contract assembly.
 *
 * `CONTEXT.md` defines the **project contract** as "the facts, goals,
 * responsibilities, rules, permissions, environment access, and completion
 * criteria presented to agents collaborating in a project". This module turns the
 * durable project record into that one text, so the same assembled contract is
 * what every engine adapter is handed as `instructions` on every run.
 *
 * The inputs are exactly the durable facts the project owns, plus the agent's own
 * standing configuration (`docs/goal.md`: individual agent configuration and
 * project configuration together form the collaboration agreement presented to
 * agents). Assembly is deliberately deterministic and side-effect free: the same
 * project, membership, and agent instructions always produce byte-identical text,
 * which is what lets a run's contract content be asserted in a test.
 */

export interface ProjectContract {
  readonly projectId: string;
  /** The project's shared goal. */
  readonly goal: string;
  /** Rules every member works under. */
  readonly rules: readonly string[];
  /** What this agent is responsible for in the project. */
  readonly responsibilities: readonly string[];
  /** How this agent collaborates with the rest of the project. */
  readonly collaborationInstructions: string;
  /** The environment instances the project's work may use. */
  readonly availableEnvironmentInstanceIds: readonly string[];
  /** The agent's own standing configuration, if it has any. */
  readonly agentInstructions?: string;
}

export interface AssembleContractRequest {
  readonly project: Project;
  readonly agentId: string;
  /** The agent's own standing instructions, woven into the agreement. */
  readonly agentInstructions?: string;
}

/** The membership that gives this agent its responsibilities in this project. */
export function membershipFor(project: Project, agentId: string): ProjectMembership | undefined {
  return project.memberships.find((membership) => membership.agentId === agentId);
}

/**
 * Assemble the contract one run is presented with.
 *
 * No environment choice is made here: the contract lists the project's available
 * instances, and environment resolution is a separate seam (`resolve.ts`).
 */
export function assembleProjectContract(request: AssembleContractRequest): ProjectContract {
  const membership = membershipFor(request.project, request.agentId);
  return {
    projectId: request.project.id,
    goal: request.project.goal,
    rules: [...request.project.rules],
    responsibilities: membership ? [...membership.responsibilities] : [],
    collaborationInstructions: membership?.collaborationInstructions ?? '',
    availableEnvironmentInstanceIds: [...request.project.availableEnvironmentInstanceIds],
    ...(request.agentInstructions !== undefined
      ? { agentInstructions: request.agentInstructions }
      : {}),
  };
}

/**
 * Render a contract as the standing instructions text an engine receives.
 *
 * Empty sections are omitted so an unfilled project does not present a wall of
 * headings, and section order is fixed, so the output is stable. This text is the
 * `instructions` input of the engine port regardless of how the adapter delivers
 * it (out-of-band system prompt, or a Sprout-owned working-directory file).
 */
export function renderProjectContract(contract: ProjectContract): string {
  const lines: string[] = [
    `# Project contract: ${contract.projectId}`,
    '',
    `Goal: ${contract.goal}`,
  ];

  if (contract.rules.length > 0) {
    lines.push('', 'Rules:');
    for (const rule of contract.rules) lines.push(`- ${rule}`);
  }

  if (contract.responsibilities.length > 0) {
    lines.push('', 'Your responsibilities:');
    for (const responsibility of contract.responsibilities) lines.push(`- ${responsibility}`);
  }

  if (contract.collaborationInstructions !== '') {
    lines.push('', `Collaboration: ${contract.collaborationInstructions}`);
  }

  if (contract.availableEnvironmentInstanceIds.length > 0) {
    lines.push('', 'Available environments:');
    for (const instanceId of contract.availableEnvironmentInstanceIds) {
      lines.push(`- ${instanceId}`);
    }
  }

  if (contract.agentInstructions !== undefined && contract.agentInstructions !== '') {
    lines.push('', 'Your standing instructions:', contract.agentInstructions);
  }

  return lines.join('\n');
}
