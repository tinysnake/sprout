/**
 * Project vocabulary: the collaboration space, its shared rules, the
 * environments its work may use, and each member's responsibilities.
 *
 * Mirrors `CONTEXT.md`. A **project** is where human and agent members pursue a
 * defined goal under shared rules; **project membership** is the relationship
 * that gives a member its responsibilities and collaboration instructions. An
 * agent is not owned by a project — membership is how an agent takes part in
 * one, which is also why an agent can serve several projects.
 */

/** One member's responsibilities and collaboration instructions within a project. */
export interface ProjectMembership {
  readonly agentId: string;
  /** What this member is responsible for in the project. */
  readonly responsibilities: readonly string[];
  /** How this member should collaborate with the rest of the project. */
  readonly collaborationInstructions: string;
}

/** A collaboration space in which members pursue a goal under shared rules. */
export interface Project {
  readonly id: string;
  /** The project's shared goal. */
  readonly goal: string;
  /** Rules every member of the project works under. */
  readonly rules: readonly string[];
  /**
   * The environment instances this project's work may use.
   *
   * A run's environment is resolved from this set rather than from the agent,
   * which is what keeps an agent usable across environments.
   */
  readonly availableEnvironmentInstanceIds: readonly string[];
  readonly memberships: readonly ProjectMembership[];
}
