# Usage and monetary-cost observability preserves provenance and coverage

The Local Operator MVP must let one technical lead understand model consumption
across Agent runs and the larger work they contribute to. Codex and Pi expose
useful token and duration facts, and both can produce an API-equivalent USD
estimate, but neither measured interface exposes a settled per-run bill. Their
telemetry also differs: Codex cost may arrive late or remain unavailable, while
Pi calculates cost from its own model catalogue. A single unqualified `cost`
field would therefore present unlike estimates as billed truth and would hide
missing data inside plausible totals.

The product owner settled the M2 observability boundary in #50 using the
version-pinned Codex and Pi research in
`docs/research/codex-pi-usage-cost-telemetry.md`. This decision defines durable
product semantics and required views, not a persistence schema or screen
layout.

## Observability, not spending control

M2 records and presents usage; it does not provide budgets, spending targets,
threshold alerts, run-admission limits, or automatic stops. Delayed, partial,
and unavailable estimates are not a safe authority source for stopping work,
and replay or interruption may have side effects under the Task and Agent-run
lifecycles in ADR-0006.

Any later spending-control feature requires its own authority, failure, and
provider-coverage decision. It cannot infer that an unavailable value is zero
or that an API-equivalent estimate is an invoice fact.

## Usage activities and attribution

An Agent run is the primary usage activity. The run owns the work-model facts
observed from its actual engine, model, and Environment execution. A resumed
engine session contributes only usage emitted for the new turn or invocation;
historical session context is never counted again. ADR-0004's Session key
continues to control conversation resumption, not accounting identity.

A wake-model Routing attempt from ADR-0007 is also a usage activity because it
invokes a model. It remains distinct from an Agent run:

- it belongs to its Project, wake model, and time range;
- it does not belong to an Agent or Task;
- Project, model, and time-range aggregates separate routing-model usage from
  work-model usage; and
- absent routing-model telemetry is a visible coverage gap, not an omitted
  zero.

The concrete telemetry contract for the future wake model was not measured by
#45. Establishing it is follow-up research and implementation work; the missing
contract does not weaken the product requirement to expose the gap truthfully.

## Durable run usage facts

For each Agent run, Sprout preserves the most detailed trustworthy token facts
the engine supplies, together with their measurement status, source event,
engine and version, and observation time. The normalized dimensions are:

- total input and, when unambiguously available, uncached input;
- cached-input reads and cache-write input;
- output and reasoning-output detail; and
- the engine- or provider-reported total.

Reasoning output is detail within output unless a versioned provider contract
states otherwise; it is not blindly added to output a second time. A simple
prompt/completion/total summary is derived through an engine-versioned mapping.
It is not the sole durable pricing input.

Each token observation is `complete`, `partial`, or `unavailable`. A failed,
stopped, or interrupted run retains trustworthy usage observed before
settlement. Absence is unavailable rather than a zero-filled object. Pi usage
counts each final usage-bearing provider call once, never cumulative streaming
updates. Codex uses the per-turn `last` usage correlated by turn identity,
never the resumed thread's cumulative total.

Sprout's run wall duration is the authoritative cross-engine duration. It is
measured from the run lifecycle's own start and terminal settlement. An
engine-native duration, such as Codex turn duration, may be retained under its
own name for diagnosis but never silently replaces wall duration. Task calendar
elapsed time is likewise separate from the sum of its nested run durations.

## Billed cost and API-equivalent estimates are different facts

Every monetary view preserves two independent facts:

1. **Attributable billed cost** is a settled provider invoice or ledger value
   attributable to the usage activity. It is `unavailable` for the measured
   Codex and Pi per-run interfaces.
2. **API-equivalent cost estimate** is a USD valuation of observed model usage.
   Its status is `pending`, `available`, or `unavailable`, and an available
   value always names its valuation provenance.

The permitted M2 valuation provenance is:

- `provider_estimated` for an estimate returned by a provider backend, such as
  Codex per-turn estimated USD;
- `harness_calculated` for an estimate calculated by the engine harness, such
  as Pi's emitted usage cost; and
- `locally_estimated` for a Sprout calculation from a frozen, versioned
  official price snapshot.

Valuation provenance is orthogonal to billing basis. Billing basis is
`metered_api`, `subscription_included`, or `unknown`. Subscription-inclusive
access leaves attributable billed cost unavailable; it neither makes the run
free nor turns its API-equivalent estimate into zero. An emitted zero is known
zero only when the selected catalogue or configuration positively identifies a
valid zero rate. Otherwise it is unavailable.

M2 normalizes monetary estimates to integer USD micros. Provider-native quota
units such as Codex credits are neither stored, converted to USD, nor combined
across providers.

## Engine-specific valuation policy

For Codex, Sprout prefers a provider-estimated per-turn value correlated to the
turn. When that value is not available, Sprout may calculate a local estimate
only if the model, token dimensions, route or service tier, and every applicable
pricing dimension are known. The calculation uses a versioned official
Codex/OpenAI price snapshot and records the source, source version, rates,
dimensions, and valuation time. Sprout never guesses through model-family
matching or a generic fallback rate.

For Pi, Sprout uses the cost Pi emitted for each final usage-bearing call and
records the Pi and model-catalogue version. It does not use a Codex price
snapshot to reprice Pi, even when the underlying provider name matches.

Harness and local valuations are frozen at run time. A later catalogue or price
snapshot does not silently reprice history. A later Codex provider estimate may
become the currently selected value instead of an earlier local estimate, but
both observations and the selection history remain durable.

## Delayed observations and corrections are append-only

Raw usage and valuation observations are never silently overwritten. Delayed
facts append to the original activity through its run, turn, or Routing-attempt
identity. A correction appends its source, reason, time, and the fact it
supersedes. The current product view selects the effective observation while
retaining every prior value and selection transition for inspection.

`pending` means a known delayed source may still report. It becomes
`unavailable` with a durable reason when the source is unsupported, its bounded
collection is exhausted, or the result cannot be correlated. A trustworthy
fact arriving later may append another transition to `available`.

M2 provides no Human editor for token values, monetary estimates, or billed
cost. Provider, engine-adapter, reconciliation, or reviewed data-migration work
may produce a correction; the Human can inspect that history but cannot label
an arbitrary number as provider usage or a bill. Billing import and operator
financial adjustments remain later, separately designed finance work.

## Required views

All aggregate views use one semantics contract and can drill down to their
constituent Agent runs or Routing attempts:

- **Agent run** shows lifecycle outcome, Sprout wall duration, detailed tokens,
  billed-cost availability, API-equivalent estimate, billing basis,
  measurement coverage, provenance, and delayed or corrected history.
- **Task** includes only its nested Agent runs, grouped by Agent and model. It
  names the sum of run wall durations separately from Task calendar elapsed
  time.
- **Project** includes its Agent runs and Routing attempts, with separate
  work-model and routing-model subtotals and drill-down by Task, Agent, and
  model.
- **Agent** includes that Agent's runs across Projects and groups them by
  Project, Task, engine, and model. It does not absorb Routing attempts.
- **Model** attributes usage to the engine, provider, model, and version
  actually used, not merely the Agent's first configured work option. It
  separates work-model and routing-model activity.
- **Time range** applies consistently to these aggregates and supports
  cross-filtering by Project, Task, Agent, model, and activity kind.

The Task, Project, Agent, model, and time-range views show tokens, model activity
duration, API-equivalent estimated USD, and coverage. No aggregate presents an
API-equivalent value as attributable billed cost.

## Time-range and aggregation semantics

A settled Agent run belongs to the time range containing its terminal
settlement time. A Routing attempt belongs to the range containing its
completion time. In-progress activities are shown separately as provisional
`observed so far`; they are not mixed into finalized totals. Failed, stopped,
and interrupted activities enter finalized aggregates at their settlement with
their partial status intact.

Delayed observations and corrections update the original activity's settlement
range rather than appearing as new consumption on arrival day. The affected
range remains visibly marked as updated. One activity that crosses a range
boundary is not prorated: token and cost telemetry cannot be truthfully split by
wall-clock proportion. Ranges use an explicit display time zone and half-open
boundaries while durable timestamps remain absolute instants.

Aggregates sum available observations and never substitute zero for missing
data. Partial usage may contribute to an **observed, incomplete** total, which
is neither a complete total nor a claimed lower bound. Pending and unavailable
costs do not enter USD arithmetic but do enter coverage counts.

Each aggregate exposes total activity count, complete/partial/unavailable token
coverage, and available/pending/unavailable cost coverage. Available estimates
with different provenance may be summed because they share the USD
API-equivalent meaning, but the result is labelled a **mixed-provenance
API-equivalent estimate** and exposes provenance subtotals. Only complete
coverage removes the incomplete warning; it still does not make the estimate a
billed fact.

## Product-surface boundary

Mobile and desktop Web provide the same scopes, filters, coverage, provenance,
and drill-down evidence. Every monetary value remains inspectably labelled as
billed, provider-estimated, harness-calculated, locally estimated, pending, or
unavailable. Subscription-inclusive access never appears as a zero bill, and a
known subtotal never hides its unknown activities.

The mobile product-shell prototype chooses page structure, tables or charts,
default time ranges, visual hierarchy, narrow-screen interaction, and final
operator-facing copy. This ADR chooses no chart library or pixel-level layout.

## Rationale

The useful common unit is a durable usage activity, not a provider account
statement. Detailed token dimensions preserve the inputs needed to explain
cache-aware pricing, while one cross-engine wall duration permits comparison
without pretending Codex and Pi expose the same native timing.

Separating billed cost, billing basis, and valuation provenance prevents three
common false claims: that a provider estimate is an invoice, that subscription
usage costs exactly zero, and that a missing amount is free. Coverage-aware
aggregation retains the value of known observations without hiding unknown
ones.

Append-only correction and valuation history makes delayed Codex facts and
adapter repairs explainable. Freezing local and harness valuations prevents a
catalogue update from rewriting what the operator previously observed.

The reference-project findings from #45 support this direction. Paperclip was
consulted at `5b913e794315530b95f2bc95dd80e3ebc266b257`; Sprout adopts its
separation of provider, biller, billing type, and unpriced activity, but rejects
normalizing subscription-inclusive cost to zero. Cumora was consulted at
`a0309618b9102fc79221f8580afdd2f2372ab5df`; Sprout adopts cache-aware frozen
valuation and explicit estimate labelling, but rejects model-family matching,
generic fallback rates, and zero-filled missing measurements. No code was
copied.

## Rejected alternatives

- **Add budgets or automatic spending controls in M2.** Incomplete and delayed
  estimates cannot safely authorize admission or interruption, and the feature
  would require a new authority and failure model.
- **Expose one unqualified cost field.** It collapses billed fact, subscription
  basis, and three estimate sources into one misleading number.
- **Show money only when a final provider bill exists.** Neither required engine
  supplies that per-run fact, so useful and clearly labelled API-equivalent
  estimates would disappear.
- **Store only prompt, completion, and total tokens.** Those fields discard the
  cache, reasoning, route, and version detail required for truthful pricing and
  correction.
- **Use a default price for unknown models or routes.** A plausible dollar value
  is more misleading than explicit unavailability.
- **Reprice history whenever a catalogue changes.** Historical totals would
  change without new usage or a correction to the original observation.
- **Overwrite delayed or corrected values.** The operator could not explain why
  a run or old time range changed.
- **Exclude wake-model calls.** Project totals would silently omit consumption
  introduced by wake-model-assisted routing.
- **Merge Routing attempts into Agent or Task usage.** That contradicts
  ADR-0007's routing lifecycle and invents ownership that does not exist.
- **Hide every aggregate when one activity is unknown.** It discards valid
  observations; coverage-aware subtotals are both more useful and truthful.
- **Treat unknown values as zero.** It creates false low totals and turns
  missing telemetry into a monetary assertion.
- **Let Humans edit measured usage in M2.** That would create an unresearched
  financial-adjustment source and weaken provenance without implementing a
  real billing ledger.
- **Fix dashboard layout in this decision.** The mobile product-shell prototype
  needs freedom to test the presentation while preserving these semantics.

## Consequences

- The current three-field `TokenUsage` seam is insufficient as the durable
  pricing source. Later specification and implementation work must preserve
  detailed dimensions and fix Codex's reasoning-output mapping.
- Usage persistence needs activity identity, append-only observations and
  corrections, independent measurement and valuation statuses, price
  provenance, billing basis, and coverage-aware aggregation.
- Codex integration needs per-turn usage and delayed estimate correlation plus
  a versioned, complete-input local fallback. Pi integration needs final-event
  deduplication and preservation of its emitted cost and catalogue provenance.
- Routing-model telemetry requires separate research or implementation evidence;
  until then, its absence remains visible coverage rather than an implied zero.
- The Web product must provide the six settled views and equivalent mobile and
  desktop capability, while visual composition remains with the product-shell
  prototype.
- Billing imports, financial reconciliation, budgets, alerts, and spending
  controls are not M2 capabilities.
