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
 * Privacy and truthfulness: the event carries the durable Sprout-set
 * `failureClass`, run identifiers, and an exact product-owned outcome reason
 * (or an explicit missing/withheld diagnostic) — never arbitrary `failure` text, `prompt`,
 * raw `events`, tool output, or host facts. Legacy untyped runs are execution;
 * no wording in a diagnostic can grant a more specific class.
 * Engine-authored failures can contain arbitrary output; pattern redaction at
 * publication cannot make that text safe. The minimal status projection
 * (#98's `/api/runs/:id/status`) adds only this same safe explanation; ADR-0007 applies.
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
import { runFailureReason } from '../run/failure-reason.ts';
import type { PublishEventInput } from './coordinator.ts';

/** The stable producer-declared kind of every run-lifecycle failure event. */
export const RUN_FAILURE_EVENT_KIND = 'agent-run-failure';

/** Idempotency: one terminal run transition can publish exactly one event. */
export function runFailureDeliveryKey(runId: string): string {
  return `run-failure:${runId}`;
}

/**
 * Project one terminal run failure into its durable Project-event input.
 *
 * Returns `undefined` when the run is not a Project-scoped terminal failure:
 * only `failed` counts (an intentional Human stop settles `interrupted` and is
 * not reported as a failure), and a run without a Project has no timeline that
 * would be authoritative for the event. Every other field is derived from the
 * durable run record — identifiers, class, and exact product-owned reason —
 * never from arbitrary failure text, prompt, events, or tool output.
 */
export function runFailureEventInput(run: AgentRun): PublishEventInput | undefined {
  if (run.status !== 'failed' || run.projectId === undefined) return undefined;
  // Legacy untyped failures are execution, regardless of their free text.
  const failureClass = run.failureClass ?? 'execution';
  // Arbitrary failure prose stays out. The reason boundary admits only exact
  // product-owned grammar, with Environment reasons gated by their saved class.
  const summary = `Agent run failed (${failureClass}) for ${run.agentId}`;
  const detail = [
    `run ${run.id}`,
    `agent ${run.agentId}`,
    ...(run.taskId !== undefined ? [`task ${run.taskId}`] : []),
    runFailureReason(run),
    ...(failureClass === 'environment' && run.result?.status === 'failed'
      ? ['Open Environments for recovery controls, or open Tasks, select the holding Task, enter a reason, and Discard Task. Discard ends unfinished work.'] : []),
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
