/**
 * Test/probe composition for the collaboration scope port (#96).
 *
 * The coordinator governs every Message against one conversation scope, so a
 * test or probe that exercises delivery needs the same port runtime composes:
 * the real `ConversationScopeService` backed by the in-memory scope store,
 * with Project facts projected from the M1 `ProjectRegistry` fixture the
 * orchestrator already uses (plus the fixture's Human member ids).
 *
 * This is a harness, not production composition: runtime builds its facts port
 * from the durable Project authority instead. It lives beside the domain so
 * collaboration tests, API harnesses, and the runnable probe share exactly one
 * fixture shape rather than hand-rolling three.
 */

import { ConversationScopeService } from '../conversation/service.ts';
import { InMemoryConversationScopeStore } from '../conversation/store.ts';
import type { ConversationProjectPort } from '../conversation/service.ts';
import { ProjectRegistry } from '../project/registry.ts';
import type { Project } from '../project/model.ts';
import type { WakePolicy } from '../project/authority-model.ts';

export interface CollaborationScopeHarnessOptions {
  /** The M1 projects the fixture routes against (registry or plain list). */
  readonly projects: ProjectRegistry | readonly Project[];
  /**
   * Human member ids every fixture Project projects as current members.
   *
   * Defaults to the operator and the test lead — the two Human identities the
   * existing fixtures author Messages as — so a Human author is a real member
   * (and a valid direct-conversation participant) without every test restating
   * it.
   */
  readonly humanMemberIds?: readonly string[];
  /** Reflect projects as archived (read-only scopes), like the authority bridge. */
  readonly statusOf?: (projectId: string) => 'active' | 'archived';
  /**
   * The fixture Projects' wake policy (#97). Defaults to `explicit-only`, the
   * ADR-0007 default; assisted-routing tests opt in explicitly.
   */
  readonly wakePolicy?: WakePolicy;
  /** The fixture Projects' fixed routing interval; defaults to 30 seconds. */
  readonly routingIntervalMs?: number;
}

export interface CollaborationScopeHarness {
  /** The service itself: it structurally satisfies `CollaborationScopePort`. */
  readonly scopes: ConversationScopeService;
  /** Ensure the Project's one channel and return its scope id. */
  channel(projectId: string): Promise<string>;
  /** Open (idempotently) one Project-scoped direct conversation. */
  openDirect(projectId: string, participants: readonly string[]): Promise<string>;
}

export function buildCollaborationScopes(
  options: CollaborationScopeHarnessOptions,
): CollaborationScopeHarness {
  const registry =
    options.projects instanceof ProjectRegistry ? options.projects : new ProjectRegistry(options.projects);
  const humans = options.humanMemberIds ?? ['operator', 'human-lead'];
  const projects: ConversationProjectPort = {
    async projectFacts(projectId) {
      const project = registry.get(projectId);
      if (project === undefined) return undefined;
      return {
        projectId: project.id,
        status: options.statusOf?.(projectId) ?? 'active',
        contentVersion: 0,
        goal: project.goal,
        rules: [...project.rules],
        wakePolicy: options.wakePolicy ?? 'explicit-only',
        routingIntervalMs: options.routingIntervalMs ?? 30_000,
        members: [
          ...humans.map((memberId) => ({ memberId, memberKind: 'human' as const })),
          ...project.memberships.map((membership) => ({
            memberId: membership.agentId,
            memberKind: 'agent' as const,
            responsibilities: [...membership.responsibilities],
            collaborationInstructions: membership.collaborationInstructions,
          })),
        ],
      };
    },
  };
  const scopes = new ConversationScopeService({
    store: new InMemoryConversationScopeStore(),
    projects,
  });
  return {
    scopes,
    async channel(projectId) {
      return (await scopes.ensureProjectChannel(projectId)).id;
    },
    async openDirect(projectId, participants) {
      return (await scopes.openDirect({ projectId, participants })).id;
    },
  };
}
