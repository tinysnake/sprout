# Proposed OAR integration into Sprout

## Intended outcome

Replace most vendor protocol, process-transport, and event-parsing maintenance with `@botiverse/oar`, while retaining Sprout's engine-neutral Interface and product control. A supported new OAR runtime should be enabled through runtime registration, capability/policy configuration, and acceptance evidence, rather than a new Sprout JSON-RPC or CLI parser.

This is a proposed integration plan, not an accepted ADR or an implementation. It follows the inspected OAR v0.28.0 source at commit `86323f089734bdc55cb4cb087bc7e5e7ee1cff9c`. See [the support investigation](oar-pi-durable-support.md). No active `wayfinder:map` issue was returned by the read-only tracker lookup during planning. The stages below are candidate work, not published or claimed Tickets.

## Proposed seam and ownership

Keep `src/engine/port.ts` as the Interface consumed by Sprout. Add a reusable `OarEngineAdapter`, parameterized by runtime ID and a validated host policy. Several registered adapter instances may implement that Interface with different IDs; they share one Implementation.

```text
Sprout Core
  Agent identity, Project contract, Task authority, admission, leases, results
                 |
         existing Worker protocol
                 |
Environment Worker
  authenticated connection, recovery outbox, engine selection, fencing
                 |
        existing EngineAdapter Interface
                 |
OarEngineAdapter
  Sprout request/result mapping, run correlation, execution supervision
                 |
     isolated OAR runner process for each EngineSession
                 |
@botiverse/oar runtime
  vendor protocol and native session, events, model and effort control
                 |
  native CLI or embedded SDK; tools execute on the Environment
```

The isolated runner is recommended because OAR embeds Pi in process, its abort is cooperative, and its configuration includes process-global environment settings. Placing it directly in the long-lived Worker would make escalation and per-session configuration harder. The runner is generic and adds no vendor transport parser. Isolation here means execution lifecycle and configuration isolation; an ordinary child process alone is not an OS sandbox.

A runner must be supervised as an execution tree, with cross-platform descendant-process termination and evidence of shutdown. A killed parent alone is not fencing proof. This fits ADR-0003's Worker-owned execution; deployment and packaging of the runner remain host-local.

## Proposed translation

| Existing Sprout Interface | OAR mechanism | Required Sprout behavior |
| --- | --- | --- |
| `startSession()` | Installation query, runtime selection, `runtime.session()` | Apply required host policy before opening; refuse unsupported options; subscribe to retained opening records. |
| `workingDirectory` | `SessionOptions.cwd` | Only use the Worker-resolved Project/Task location. |
| `resumeSessionKey` | `SessionOptions.resume` | Scope keys to Agent, engine, Environment and working directory, as in ADR-0004. |
| `instructions` | Prefer `appendSystemPrompt` when supported | Check `refusedSessionOptions`; use an established engine-readable file mechanism where verified, otherwise make the option unavailable. Never silently drop the Project contract. |
| `model`, `effort` | Corresponding session options and observed read-back | A requested setting that is refused must remain a failure; no silent fallback after work is admitted. |
| `engineSessionKey` | Native `Session.id` | Persist the actual identity, not a guessed or runner-local ID. |
| `run(prompt)` | `Session.prompt()` plus observed records/events | One admitted Sprout run owns one root turn. Busy or rejected input is not implicitly queued. |
| Progress events | Text/tool events | Map to Sprout progress without exporting raw records or private reasoning. |
| Turn completion | Root `turn_ended` and correlated input | Preserve completed, failed and interrupted outcomes; do not let a child/background turn settle the root run. |
| `interrupt()` | `Session.abort()` and supervised escalation | Acceptance means the cancellation was delivered, not that execution stopped. Retain uncertainty until termination is established. |
| `close()` | `Session.dispose()` plus runner supervision | Bound cleanup; fence the runner and descendants if cooperative shutdown fails. |
| Per-run token usage | Observed cumulative totals and run baseline | Attribute deltas and completeness to the run; do not sum cumulative reports or invent zero for missing data. |

OAR flat events can share a record `seq`; one sequence may yield multiple events. Do not discard all but the first event as duplicates. Preserve a correlation tuple including runner/session identity and boot/run identity; OAR resume starts a fresh stream at sequence zero. The Worker journal retains its own durable acknowledgement sequence.

Final-answer selection must preserve Sprout's existing distinction between progress text and the final answer. OAR's `promptAndWait()` concatenates root text over the turn; that is not automatically the right final-message projection. Verify against [final-answer-selection.md](final-answer-selection.md) and native frame metadata where required.

## Constraints that prevent a blind replacement

### Execution and cancellation

OAR's `abort()` reports that interruption was delivered. Its `promptAndWait()` helper can wait indefinitely after an accepted abort for the native terminal event. Sprout must own liveness bounds and escalation rather than inheriting an unbounded wait.

The current Pi implementation's `dispose()` awaits the embedded SDK's abort before releasing it. An isolated runner provides a generic escalation path, but macOS and Windows tests still have to prove descendant processes stop and recovery uncertainty is preserved.

### Permissions and sandbox

OAR deliberately disables interactive permission gates, and Codex defaults to `danger-full-access`. Sprout currently selects `read-only` Codex execution on ordinary hosts and `danger-full-access` in containers. Preserve the selected posture explicitly through the runner's configuration; upstream exposes `OAR_CODEX_SANDBOX`. Other runtimes need measured capability/policy decisions, not assumed equivalent protection.

A Task approval authorizes work under its constraints. It is not permission to widen filesystem or host privileges because a dependency defaults differently.

### Admission and recovery

Do not expose OAR `queue()`, `deliver()`, or `steerOrQueue()` in the first integration. Keep waiting work in Sprout so every Agent run crosses existing admission and lease checks. Native Codex queued inputs can survive and start on reopen, as upstream measured; sessions with uncertain native queued work require reconciliation, not automatic resume.

Record subscriptions must account for native activity and notifications during session open, not just events after a new prompt. A generic completed-turn event alone is insufficient to attribute a result in the presence of spontaneous or background turns. The inspected upstream crash-resume report documents such a Claude race; either establish a corrected version or withhold that runtime until correlation is proved.

### Readiness and information ownership

OAR's installation, auth-status and model-catalog queries can reduce duplicate integration work, but must individually meet ADR-0013. Listing a runtime or finding its executable is not evidence of authentication, model entitlement, or safe execution. Unknown required facts remain blocked unless covered by the established Human-authorization evidence.

Retain host-local credential handling and the existing durable redaction rules. OAR's raw records contain native payloads, paths and potentially sensitive content. They cannot become Sprout diagnostics or product wire objects by direct serialization. Model usage observations remain distinct from billed cost.

## Integration stages

### 1. Resolve the decisive uncertainties with an isolated contract prototype

Use a pinned OAR dependency, injected/scripted runtime, and runner fault scenarios. Exercise the existing EngineAdapter Interface. Verify:

- normal root progress and completion, a rejected prompt, early runtime exit, and a resumed session;
- Project contract, model and effort delivery/refusal;
- correct final answer and per-run usage across two consecutive runs;
- cancellation acceptance followed by missing terminal events, and escalation;
- child/background terminal events and opening notifications cannot settle another run;
- stale runner/boot events cannot enter newer runs;
- ordinary reconnect neither starts new work nor releases the lease.

Then perform one bounded live Codex run and one Pi run in a controlled macOS Environment. Establish the supported Windows process-tree and SDK behavior separately. This prototype determines whether upstream fixes are needed before production switching; do not create speculative implementation Tickets for unresolved behavior.

### 2. Deliver a production slice for Codex and Pi

Suggested changes after the prototype passes:

- `src/engine/oar.ts`: shared Adapter and mapping;
- an engine-owned runner entrypoint and its supervised IPC/lifecycle Implementation;
- `src/worker/engine-selection.ts`: select OAR-backed instances for the accepted runtimes;
- readiness integration only for verified OAR queries;
- pinned package version and lockfile, including OAR's Node.js 24+ requirement in runtime and installation checks;
- meaningful contract and recovery tests using the same public engine seam.

Keep runtime IDs `codex` and `pi` so product configuration remains about the selected engine. Use a separate engine implementation/version identity where evidence needs it. Existing native session IDs/files may be reusable, but same-ID resume and Pi session-directory compatibility must be tested. An implementation switch must not discard interrupted-run history or clear an uncertain lease.

The old and new implementations may coexist during bounded comparison. Remove the corresponding old adapters, parsers and redundant tests once replacement acceptance is complete. The target is one maintained production implementation per enabled engine, not a permanent parallel stack.

### 3. Enable additional engines through capabilities and acceptance

Describe enabled runtimes through a shared catalog: product ID/label, OAR runtime ID, supported platforms, instruction mechanism, verified readiness, execution policy and tested version scope. Audit hard-coded engine lists in Worker configuration, admission, model selectors, and Web rather than updating the Worker alone.

Start with one additional runtime, such as Claude, after resolving its turn-correlation behavior. Enabling it should reuse the shared Adapter; engine-specific metadata or a small verified compatibility hook may still be needed. Cursor requires supplying its optional SDK and should not be assumed included by `defaultRuntimes`.

Automatically discovering an OAR runtime is not automatically authorizing it for Project use. Distinguish runtime discovery from policy and readiness eligibility.

### 4. Establish an upstream update gate

Pin OAR to an accepted version, initially the inspected `0.28.0`. Each update must pass the shared Adapter contract and the relevant live engine/platform checks before changing production execution. Report the OAR version and actual native runtime/SDK version in sanitized evidence. File common protocol defects upstream rather than accumulating a new vendor parser in Sprout; retain small compatibility hooks only where demonstrated necessary.

OAR is Apache-2.0. Using it as a dependency and copying its source are different acts: if code is copied, preserve required license/NOTICE material and attribution under repository reference policy.

## Acceptance outcome

A Human-approved Sprout Task on an enrolled Environment runs through OAR, streams truthful progress, can be interrupted, retains its lease through failure/restart, continues its native context in a later deliberate run, and produces correctly attributed results and usage. An additional eligible runtime can then be enabled without introducing a new vendor protocol parser into Sprout.

This delivers reduced adapter maintenance, not a guarantee that every future engine works without validation. It does not require Pi Durable.

## Primary references

- [OAR Session Interface](https://github.com/botiverse/oar/blob/86323f089734bdc55cb4cb087bc7e5e7ee1cff9c/packages/oar/src/contracts/session.ts)
- [Runtime Interface](https://github.com/botiverse/oar/blob/86323f089734bdc55cb4cb087bc7e5e7ee1cff9c/packages/oar/src/contracts/runtime.ts)
- [Record and token semantics](https://github.com/botiverse/oar/blob/86323f089734bdc55cb4cb087bc7e5e7ee1cff9c/packages/oar/src/contracts/records.ts)
- [Turn helpers and cancellation](https://github.com/botiverse/oar/blob/86323f089734bdc55cb4cb087bc7e5e7ee1cff9c/packages/oar/src/observe/turns.ts)
- [Embedded Pi session](https://github.com/botiverse/oar/blob/86323f089734bdc55cb4cb087bc7e5e7ee1cff9c/packages/oar/src/runtimes/pi/session.ts)
- [Codex execution configuration](https://github.com/botiverse/oar/blob/86323f089734bdc55cb4cb087bc7e5e7ee1cff9c/packages/oar/src/runtimes/codex/session.ts)
- [Cross-runtime crash-resume evidence](https://github.com/botiverse/oar/blob/86323f089734bdc55cb4cb087bc7e5e7ee1cff9c/docs/runtimes/crash-resume.md)
- [Sprout engine Interface](../../src/engine/port.ts), [Worker engine selection](../../src/worker/engine-selection.ts), [Worker recovery journal](../../src/worker/recovery-journal.ts)
- [ADR-0003: environment Worker](../adr/0003-each-environment-runs-a-sprout-worker.md), [ADR-0004: session identity](../adr/0004-engine-session-keys-are-scoped-to-one-environment-slot.md), [ADR-0009: recovery](../adr/0009-self-hosted-operation-and-recovery-promises.md), [ADR-0013: readiness](../adr/0013-readiness-probes-never-perform-model-inference.md)
