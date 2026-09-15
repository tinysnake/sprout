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

/**
 * One environment-local location for a persistent Project workspace.
 *
 * `path` is deliberately relative to the Environment Worker's configured
 * workspace root.  A Project never stores a host-specific absolute path: the
 * same Project can name a different relative workspace on another Environment
 * instance without binding its portable identity to a machine.
 */
export interface ProjectWorkspace {
  readonly environmentInstanceId: string;
  readonly path: string;
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
  /**
   * Optional registered workspace locations, one per Environment instance.
   *
   * An absent entry retains the Worker-managed default workspace for this
   * Project.  A present entry points at an existing repository below that
   * Worker's root.
   */
  readonly workspaces?: readonly ProjectWorkspace[];
  readonly memberships: readonly ProjectMembership[];
}
