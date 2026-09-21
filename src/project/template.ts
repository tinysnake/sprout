/**
 * The built-in **General collaboration** Project template (ADR-0008, #92).
 *
 * `CONTEXT.md` defines a **Project template** as "a reusable starting shape for
 * a project contract, containing goal guidance, rules, role slots,
 * collaboration instructions, and completion guidance without binding concrete
 * agents, environment instances, or workspace paths."
 *
 * M2 ships exactly one immutable built-in template. It is the source every
 * Project creation copies: the copy records the template's id and version as
 * attribution facts, and later changes to this module never rewrite an
 * established Project. The template deliberately contains no concrete Agent,
 * Environment instance, workspace path, model, or credential — those facts
 * belong to the Project's own editable snapshot and its membership decisions,
 * never to the reusable starting shape.
 */

import type { WakePolicy } from './authority-model.ts';

/** One optional Agent role slot: a suggested shape, never a concrete Agent. */
export interface ProjectTemplateRoleSlot {
  /** The slot's name, e.g. "Contributor". */
  readonly name: string;
  /** Suggested responsibilities an operator may fill in or discard. */
  readonly suggestedResponsibilities: readonly string[];
  /** Suggested collaboration guidance an operator may edit. */
  readonly suggestedCollaborationInstructions: string;
}

/** The reusable starting shape for a project contract. */
export interface ProjectTemplate {
  readonly id: string;
  readonly name: string;
  /** The template's own source version, recorded on every Project copy. */
  readonly version: number;
  /** Editable, clearable goal guidance. */
  readonly goalGuidance: string;
  /** Suggested rules an operator may edit or clear. */
  readonly suggestedRules: readonly string[];
  /** Optional Agent role slots: suggestions, never bindings. */
  readonly roleSlots: readonly ProjectTemplateRoleSlot[];
  /** How members are suggested to collaborate. */
  readonly collaborationGuidance: string;
  /** What the project suggests a finished piece of work looks like. */
  readonly completionGuidance: string;
  /** The template's suggested Project wake policy (ADR-0007). */
  readonly wakePolicy: WakePolicy;
  /** The template's suggested routing interval in milliseconds (ADR-0007). */
  readonly routingIntervalMs: number;
}

/**
 * The one immutable built-in M2 template.
 *
 * Frozen at module load so a caller cannot mutate the shared source, and
 * reviewed to carry no concrete Agent id, Environment instance, workspace
 * path, model, or credential.
 */
export const GENERAL_COLLABORATION_TEMPLATE: ProjectTemplate = Object.freeze({
  id: 'template-general-collaboration',
  name: 'General collaboration',
  version: 1,
  goalGuidance: 'Coordinate durable, Human-supervised work toward a shared goal.',
  suggestedRules: [
    'Report what you actually observed.',
    'Do not claim work you did not verify.',
    'Keep the project goal and current contract version in mind when proposing work.',
  ],
  roleSlots: [
    {
      name: 'Contributor',
      suggestedResponsibilities: ['Investigate and implement assigned work', 'Report progress on the project channel'],
      suggestedCollaborationInstructions:
        'Collaborate through the project channel and keep results concise.',
    },
  ],
  collaborationGuidance:
    'Members coordinate through the project channel; Humans direct, Agents propose and perform.',
  completionGuidance:
    'Work is complete when a Human has validated the reported outcome against the project rules.',
  wakePolicy: 'explicit-only',
  routingIntervalMs: 30_000,
} satisfies ProjectTemplate);
