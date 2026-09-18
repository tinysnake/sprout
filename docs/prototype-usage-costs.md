# Sprout M2 Usage & Costs Observability Prototype

## Status and boundary

This is the retained decision artifact for Issue #67, the first implementation
attempt. It is a disposable Web prototype mounted at `Manage > Usage & Costs`.
It does not implement persistence, provider adapters, billing imports, or a
production API.

The prototype opens on a mixed retained-activity fixture so the operator can
inspect known, partial, pending, unavailable, delayed, and corrected facts in
one pass. The default time range, summary emphasis, and aggregate link density
remain **unresolved owner preferences**. They are proposed presentation choices,
not silent product decisions.

## Reused design language

The surface reuses the accepted #61 to #66 conventions:

- Manage remains the low-frequency management destination with the existing
  mobile and desktop navigation containers.
- The page uses the restrained shared palette, compact status language, 44px
  touch targets, visible focus rings, and keyboard-capable controls.
- The default hierarchy is a short page header, a semantic reading note, a
  sparse summary band, a six-view control, filters, coverage, then detail on
  demand.
- Activity rows are the primary surface. Token dimensions, valuation history,
  and source facts move into an activity detail panel rather than becoming a
  telemetry dump.
- No candidate engine or model harness controls were added. Project, Agent,
  model, and time range controls are observational filters only.

## Domain model preserved by the fixture

Every `UsageActivity` retains the distinctions required by ADR-0010 and the
Codex and Pi telemetry research:

| Fact | Prototype representation |
| --- | --- |
| Activity identity | `agent_run` or `routing_attempt`, with Project ownership and optional Task or Agent ownership |
| Token dimensions | Total input, uncached input, cached reads, cache write, output, reasoning output, and provider or engine total. Missing dimensions are absent, not zero. |
| Token measurement | `complete`, `partial`, or `unavailable`, with the source event named |
| Duration | Sprout wall duration is separate from optional engine duration. Ongoing duration is labelled observed so far. |
| Run outcome | Completed, ongoing, failed, stopped, or interrupted |
| Session identity | New invocation or resumed invocation. A resumed activity counts only new-turn usage. |
| Monetary fact | Attributable billed cost remains unavailable for these per-activity interfaces. |
| API-equivalent valuation | Available, pending, or unavailable. Available values name provider-estimated, harness-calculated, or locally-estimated provenance. |
| Billing basis | Metered API, subscription-inclusive, or unknown. Subscription-inclusive never becomes a zero bill. |
| Coverage | Aggregate counts show complete, partial, and unavailable token observations plus available, pending, and unavailable estimates. |
| Observation history | Delayed and corrected observations remain append-only examples with source, status, and supersession note. |
| Time semantics | Activities group by terminal settlement range. Ongoing work is provisional and not mixed into finalized totals. |

## Six views and drill-down contract

All six views use the same filters and can open the same activity detail
surface.

1. **Agent run** lists work-model runs and Project-owned Routing attempts with
   outcome, tokens, model activity duration, estimate state, and provenance.
2. **Task** groups nested Agent runs and shows model activity time separately
   from Task calendar elapsed time. Routing attempts are explicitly excluded.
3. **Project** shows work-model and routing-model subtotals side by side.
4. **Agent** groups runs across Projects and does not absorb Routing attempts.
5. **Model** groups by actual provider, engine, model, and activity kind.
6. **Time range** groups by settlement range and keeps provisional activity
   distinct from finalized activity.

Selecting an activity or a constituent link opens details for attribution,
duration, token dimensions, billed-cost availability, API-equivalent estimate,
billing basis, measurement coverage, source, and observation history.

## State matrix

| State | Fixture evidence |
| --- | --- |
| Resumed | `act-203`, `act-206`, and `act-208` identify a resumed invocation and avoid counting historical session context. |
| Ongoing | `act-206` has partial observed duration, partial token detail, pending valuation, and is excluded from finalized totals. |
| Failed | `act-207` preserves partial tokens and a pending correlated cost after a turn failure. |
| Stopped | `act-202` and `act-208` retain observed usage. Stopped does not imply zero. |
| Interrupted | `act-209` retains partial usage and shows unavailable cost after a worker interruption. |
| Delayed | `act-207` and `act-210` show pending provider observations rather than invented values. |
| Corrected | `act-204` retains a superseded local estimate and a later provider estimate in history. |
| Incomplete | Partial and unavailable dimensions are displayed as unavailable, not zero-filled. |
| Mixed provenance | The aggregate may sum available USD API-equivalent values but exposes the separate provenance labels in activity detail. |
| Routing gap | `act-wake-003` is a failed Routing attempt with unavailable token and cost telemetry, visible as a coverage gap. |

## Owner review record

### Accepted reuse

- The shared Feed and Manage hierarchy, light and dark token treatment, low
  density, progressive disclosure, and phone and desktop parity from #61.
- Full-row selection and an on-demand evidence affordance rather than
  permanently displaying every fact, consistent with the accepted #64 chat
  inspection pattern.
- Textual status and coverage labels paired with color, consistent with #61,
  #62, and #65.
- The prototype and artifact retain backend and domain obligations even when a
  fact is moved behind details on demand.

### Rejected patterns

- One unqualified `cost` field or any display that makes an estimate look like
  a settled invoice.
- Treating subscription-inclusive usage as a zero billed amount.
- Replacing pending or unavailable data with zero, hiding a missing Routing
  attempt, or collapsing work-model activity into wake-model activity.
- Budgets, alerts, admission limits, automatic stops, billing-account
  management, billing imports, and chart-library selection.
- Candidate dropdowns that simulate engine or model harness decisions.
- A dense telemetry dump as the default page or permanently visible correction
  history.

### Unresolved owner decisions

- Should the default time range be All retained activity, Previous 7 days, or
  Today once real data exists?
- Should the top summary emphasize known token volume, coverage, or model
  duration for a technical lead's first glance?
- Should aggregate constituent activity links remain visible by default or move
  behind one compact disclosure on narrow screens?
- Should a future prototype add a separate routing-coverage callout, or is the
  current Project view separation sufficient?

These questions are intentionally surfaced for Human review. The first
implementation does not claim owner acceptance.

## Verification and reuse rule

The retained UI is in `web/src/prototype/views/usage-view.ts`, its state fixture
is in `web/src/prototype/state.ts`, and focused DOM checks live in
`web/src/prototype/usage.dom.test.ts`.

Future production work must preserve this vocabulary and the independent
observation history. It must not infer a bill from an estimate, reprice a frozen
historical valuation, count resumed session context twice, or make an unknown
fact numerically zero.
