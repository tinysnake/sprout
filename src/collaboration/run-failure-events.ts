/**
 * The system run-lifecycle failure producer (#180).
 *
 * `events.ts` documents `system` as the producer that "covers facts Sprout
 * records on its own (run lifecycle, routing, recovery)", but until now no
 * run-lifecycle producer was wired: a failed Agent run was durable in
 * `agent_runs` while the conversation carried nothing, so a reply-less direct
 * message offered no operator-visible trace of its outcome. This module is the
 * one projection from a terminal run failure to that durable Project event;
 * `CollaborationCoordinator` publishes it live when a run settles and again
 * from restart reconciliation, keyed by the run id so the two paths can never
 * produce two events for one terminal transition.
 *
 * Scope: a run is Project-scoped when its durable record names a Project —
 * exactly the runs the orchestrator records a `projectId` for (wake-admitted
 * Message/Project-event runs and Task runs). Ad-hoc API runs that never
 * resolved a Project produce no event because there is no Project whose
 * timeline would be authoritative for them.
 *
 * Routing: the event is published `informational` — durable without waking an
 * Agent, excluded from routing batches and fan-out (ADR-0007: "run progress
 * and completion … do not initiate routing"). The disposition is declared, never
 * inferred: `requireRoutingDisposition` refuses anything else.
 *
 * Privacy: the event carries only the failure class and run identifiers — never
 * the run `failure` text, `prompt`, raw `events`, tool output, or host facts.
 * Engine-authored failures can contain arbitrary output; pattern redaction at
 * publication cannot make that text safe. The `{id,status}` privacy projection
 * precedent (#98's `/api/runs/:id/status`) and ADR-0007 apply.
 *
 * Attention linkage (#103): these events are durable, typed
 * (`agent-run-failure`), sanitized Project events with an `informational`
 * disposition — the exact input shape the Feed/Attention projection consumes
 * for operational activity and may promote to Project Attention when the
 * failure class names infrastructure that blocks Project work (Spec stories
 * 14–17). Attention ordering, severity, and clearing logic stay in #103; this
 * module produces facts and nothing else.
 */

import type { AgentRun } from '../run/model.ts';
import type { PublishEventInput } from './coordinator.ts';

/** The stable producer-declared kind of every run-lifecycle failure event. */
export const RUN_FAILURE_EVENT_KIND = 'agent-run-failure';

/** Idempotency: one terminal run transition can publish exactly one event. */
export function runFailureDeliveryKey(runId: string): string {
  return `run-failure:${runId}`;
}

/**
 * The sanitized failure class a failed run is filed under.
 *
 * The class is derived only from Sprout-owned reason shapes, so it never
 * depends on engine free text being well-formed; unknown text falls back to
 * `execution` (the run failed while executing) rather than guessing finer.
 */
export type RunFailureClass = 'admission' | 'environment' | 'restart' | 'execution';

const CLASS_RULES: readonly { readonly failureClass: RunFailureClass; readonly pattern: RegExp }[] = [
  { failureClass: 'restart', pattern: /^interrupted by a sprout restart before this run finished$/i },
  {
    failureClass: 'environment',
    pattern: /^no available environment|^no project grants .* environment/i,
  },
  {
    failureClass: 'admission',
    pattern:
      /^unknown agent:|^agent .* is not a member of project |^no compatible work option|^no configured work option|^task run .* is missing its project scope|^task run .* requires lifecycle lease|^task runs are not configured|^task lease is not active/i,
  },
];

/** File one failure reason into its class; unknown shapes are `execution`. */
export function classifyRunFailure(failure: string | undefined): RunFailureClass {
  const reason = (failure ?? '').trim();
  if (reason === '') return 'execution';
  for (const rule of CLASS_RULES) {
    if (rule.pattern.test(reason)) return rule.failureClass;
  }
  return 'execution';
}

/**
 * Project one terminal run failure into its durable Project-event input.
 *
 * Returns `undefined` when the run is not a Project-scoped terminal failure:
 * only `failed` counts (an intentional Human stop settles `interrupted` and is
 * not reported as a failure), and a run without a Project has no timeline that
 * would be authoritative for the event. Every other field is derived from the
 * durable run record — identifiers and class — and never from the run's
 * failure text, prompt, events, or tool output.
 */
export function runFailureEventInput(run: AgentRun): PublishEventInput | undefined {
  if (run.status !== 'failed' || run.projectId === undefined) return undefined;
  const failureClass = classifyRunFailure(run.failure);
  // No failure text crosses this boundary: even a known prefix can be followed
  // by engine output or machine identity that a redactor cannot recognize.
  const summary = `Agent run failed (${failureClass}) for ${run.agentId}`;
  const detail = [
    `run ${run.id}`,
    `agent ${run.agentId}`,
    ...(run.taskId !== undefined ? [`task ${run.taskId}`] : []),
  ].join(' · ');
  return {
    projectId: run.projectId,
    kind: RUN_FAILURE_EVENT_KIND,
    summary,
    detail,
    producer: { id: 'sprout', kind: 'system' },
    disposition: 'informational',
    deliveryKey: runFailureDeliveryKey(run.id),
    // An informational event has no wake to admit; never wait for replies.
    awaitReply: false,
  };
}
