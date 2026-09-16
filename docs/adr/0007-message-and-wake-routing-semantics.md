# Message and wake-routing semantics

The Local Operator MVP needs routine direct and Project-channel communication
without either unexplained silence or uncontrolled Agent wakes. M1 proved the
durable write path: persist a `Message` and its per-recipient `WakeRequest`
before admitting an Agent run, project only a completed run's final assistant
text as its reply, and reconcile pending wakes and missing projections after a
restart. It also kept private run events and raw reasoning out of conversation.

M1 deliberately used a narrower wake contract: each unaddressed Project-channel
Message was evaluated immediately, the wake model could only engage every other
member or nobody, and a missing or failed model woke every other member. Those
choices proved the path, but they would make a larger Project noisy and make a
low-cost routing failure create uncontrolled fan-out. The product owner settled
the M2 semantics in #51. This decision deepens the proven path rather than
replacing its persistence-before-wake, idempotency, reply-projection, or privacy
boundaries.

## Project wake policies

Every Project stores one explicit wake policy:

- **Explicit-only** keeps unaddressed Project-channel Messages and Project
  events durable without consulting a wake model or waking an Agent.
- **Wake-model-assisted** collects eligible unaddressed inputs into bounded
  routing batches and asks a wake model which current Project Agents, if any,
  should receive them.

Explicit-only is the default for a newly created Project, a Project template
without an explicit value, and migration of an existing Project without the
field. A template carries its explicit choice into Projects created from it.
Changing policy affects only later inputs; it never reroutes or rewrites
history.

## Deterministic addressing

The following inputs wake their Agent recipients immediately and never consult
the wake policy or model:

- a Project-scoped direct Message naming one or more current Agent members;
- exact, whole-token Agent mentions in a Project-channel Message;
- an exact `@all` broadcast, which wakes every current Agent member except the
  author; and
- a Project event with an explicitly responsible Agent.

Human- and Agent-authored Messages use the same deterministic rules. A
`(Message, Agent)` target is deduplicated when more than one addressing form
names it. The author is not woken by its own Message. A target that is unknown
or no longer belongs to the Project produces a durable per-target routing
failure while other valid targets continue; it never falls through to model
judgement. Human notification semantics are outside this decision.

## Eligible inputs and routing dispositions

Under wake-model-assisted routing, an unaddressed Project-channel Message that
a Human or Agent explicitly submitted is eligible for the next routing batch.
The author does not determine eligibility.

A system-produced Project event is not treated as an undifferentiated "system
Message." Its producer declares one routing disposition:

- **addressed** names a responsible Agent and routes deterministically;
- **wake-eligible** may enter a routing batch;
- **informational** remains durable without waking an Agent;
- **human-action-required** remains durable for Human attention and cannot
  delegate that authority to an Agent; or
- **non-routing** may be useful as later shared context but cannot initiate
  routing.

Agent replies projected automatically by Sprout are non-routing. They remain
durable Project-channel context, but cannot open a collection window even if
their text contains `@all` or an Agent-like mention. An Agent that intends to
wake another Agent must submit a distinct, explicitly addressed Message. Run
progress and completion, routing and wake lifecycle records, retry and restart
reconciliation, telemetry and diagnostics, and Human-only recovery events do
not initiate routing.

This distinction is the loop-prevention boundary: automatic output never
becomes automatic input to another wake. It does not rely on a model deciding
when a reply chain has become a loop.

## Collection windows and routing batches

The first eligible input for a Project opens that Project's fixed collection
window. The default interval is 30 seconds and is configurable per Project and
through its template. Later eligible inputs join the open window without
resetting its deadline. No eligible input means no model call. Deterministically
addressed inputs bypass the window.

The collection cursor, deadline, and input membership are durable. Restart
continues the same window, and an elapsed window is submitted immediately.
Changing the interval affects the next window rather than changing an already
frozen one.

Closing a window creates a durable **Routing batch**. If its inputs cannot fit
within the bounded model context, Sprout splits them chronologically into
multiple batches rather than dropping a durable input. A single oversized input
is represented to the model by a deterministic bounded excerpt marked as
truncated; its complete durable content remains available to the Human.

## Wake-model authority and run fan-out

One routing attempt evaluates one frozen batch in one model call. The wake
model may select zero or more current Project Agents and, for each selected
Agent, identify the batch inputs relevant to it with a concise rationale. It
cannot select a non-member, rewrite deterministic recipients, create or begin a
Task, select an Environment instance, or grant authority.

Every batch input must have an explicit result: selected for at least one Agent
or suppressed. Omitted inputs, unknown Agents or input identifiers, and other
malformed or incomplete output invalidate the entire attempt; Sprout does not
salvage a plausible-looking subset.

One selected Agent receives at most one `WakeRequest` and one Agent run for a
routing batch, even when several inputs selected that Agent. The run receives
its assigned inputs in chronological order. One input may select several
Agents, each with its own wake and run. The projected reply retains links to the
batch, wake, run, and all triggering inputs; when exactly one Message triggered
the run, its ordinary single `inReplyTo` relationship remains available.

Deterministically addressed Messages retain the proven per-Message,
per-recipient WakeRequest path. They are not coalesced into a routing batch.

## Bounded routing context

A routing attempt freezes a deterministic, bounded view containing only
Project-shared facts:

1. each batch input's identifier, kind, author, time, content, and reply or
   thread relationship;
2. the Project goal and rules;
3. candidate Agent identifiers, Project responsibilities, and membership
   collaboration instructions;
4. bounded recent Project-channel context, including non-routing projected
   replies;
5. curated public Task state, Task lead, and blocker summaries explicitly
   relevant to the input; and
6. the policy, batch cutoff, split relationship, bounds, and truncation markers.

Candidate inputs have priority, followed by their direct thread ancestors and
then recent shared channel context within the remaining bound. Automatic retry
uses exactly the same frozen snapshot.

The wake model never receives direct Messages or their replies, Agent-private
memory, raw reasoning, engine-native sessions, full run transcripts, tool
output, credentials, host identity, private network facts, or uncurated internal
events. Temporary Environment availability is also excluded: transient capacity
must not cause the model to silently substitute a different Agent for the one
whose Project responsibility best matches the input.

## Failure, suppression, admission, and retry

A missing or unavailable model, timeout, exception, invalid identifier,
malformed output, or incomplete accounting is a routing-attempt failure. Sprout
automatically retries once with the same frozen batch and context. A second
failure **fails closed**: no Agent is woken, every affected input has a durable
and visible routing failure, and the original inputs remain intact.

A valid result that selects no Agent is deliberate suppression, not failure. It
is durable, visible, and not retried automatically.

Once routing has selected a recipient, the WakeRequest is durable before run
admission. Temporary contention or unavailable capacity leaves it pending or
waiting and admission continues when the condition clears; it does not expire,
retarget itself, or become silent. Membership or permission loss that makes
admission invalid produces a visible failure. A later policy or membership
change does not rewrite the historical routing decision.

Once a durable Agent run exists, Sprout never starts another run automatically
for the same wake. A failed, interrupted, or stopped run produces no fabricated
reply and is not rerun automatically, because it may already have caused side
effects.

The MVP adds no routing-specific Human controls: no Route now, routing Retry,
model override, or pending-wake cancellation. The Human can still send an
ordinary new direct or explicitly mentioned Message and can use the existing
Agent-run stop control. Dedicated routing controls may be reconsidered after
MVP evidence exists.

## Human-inspectable routing evidence

The Human can follow each input through its complete durable causal chain
without consulting internal logs. The evidence includes:

- the Message or Project event, author, time, routing disposition, and wake
  policy then in force;
- deterministic recipients and reasons, deduplication, and invalid targets;
- routing-batch inputs, window times, cutoff, cursor, split relationships, and
  context bounds;
- model identity, attempt number and timing, candidate Agents, input-to-Agent
  assignments, and each input's selected, suppressed, or failed result;
- concise model rationale labelled as model judgement rather than fact;
- the frozen context manifest and all truncation markers;
- timeouts, exceptions, invalid output, and validation errors, without raw
  private reasoning;
- WakeRequest pending, waiting, admitted, or failed outcomes and admission
  blockers; and
- linked Agent runs, run outcomes, and projected replies.

Later policy, interval, membership, or model changes do not alter this evidence.

## Rationale

Deterministic addressing protects explicit work from probabilistic judgement.
Batching amortizes the low-cost model call across a burst and, by coalescing per
Agent, also prevents a burst from starting several expensive work-model runs for
the same recipient. A fixed window has bounded latency; a debounce window could
starve under continuous conversation.

Recipient selection uses declared Project responsibilities without allowing the
model to acquire resources or create authority. Failing closed is appropriate
only because unaddressed inputs remain durable and every explicit address
bypasses the model; an all-member fail-open would turn model failure into
uncontrolled cost. Durable failure evidence prevents that safer fallback from
becoming unexplained silence.

Non-routing projection and explicit Agent sends separate an answer from an
intentional delegation. Bounded Project-shared context gives the model useful
collaboration facts while preserving the established rule that private raw
reasoning is never routing context.

## Rejected alternatives

- **Keep M1's all-or-none wake judgement.** It cannot route a Message to the
  member whose responsibilities match it and needlessly wakes unrelated Agents.
- **Fail open to every member when the model fails.** This protected the M1
  prototype from silent loss but creates uncontrolled fan-out even though M2's
  explicit work already has a deterministic path.
- **Evaluate every unaddressed Message immediately.** Bursts repeat context and
  can create several Agent runs before the conversation settles.
- **Use a reset-on-Message debounce.** A continuously active channel may never
  close its routing window.
- **Create one run per selected Message.** It preserves the old cardinality but
  defeats the batch's main work-model and coordination benefit.
- **Route every system-produced event.** Run, wake, recovery, and telemetry
  events would create loops or delegate Human-only actions.
- **Route projected replies automatically.** Mention-like prose and ordinary
  answers could recursively wake Agents without an explicit send intent.
- **Accept the valid-looking portion of malformed model output.** Partial
  acceptance makes omitted inputs and recipients indistinguishable from a model
  decision.
- **Automatically rerun a failed Agent run.** Tools may already have produced
  side effects, so replay is not generally safe.
- **Give the wake model direct conversations, private sessions, or raw run
  evidence.** Those facts are unnecessary for Project routing and violate the
  privacy boundary.

## Consequences

- M2 implementation needs durable routing dispositions, Project policy and
  interval configuration, collection windows, Routing batches, Routing
  attempts, per-input outcomes, and restart reconciliation for each boundary.
- Model-assisted WakeRequests are identified by batch and Agent, while the
  deterministic Message-and-Agent identity remains unchanged.
- The collaboration context and reply relationships must support several
  triggering inputs without turning a Routing batch into a Task.
- Existing Projects migrate safely to explicit-only; enabling assisted routing
  is an explicit operator choice.
- The Web product must expose the evidence above on mobile and desktop, but MVP
  routing evidence is observational rather than a new routing-control surface.
- The model provider, concrete scheduler, storage schema, prompt wording, token
  limits, and screen layout remain implementation choices constrained by these
  outcomes.
