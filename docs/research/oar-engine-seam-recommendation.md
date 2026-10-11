# OAR integration seam recommendation

## Recommendation

Keep a Sprout-owned engine execution Interface and implement it with one reusable `OarEngineAdapter`. Replace the production vendor adapters with that shared Implementation as each runtime passes acceptance. Do not create one Sprout wrapper class per OAR runtime, and do not expose OAR's entire Session Interface to Core or the Worker protocol.

Keeping the seam does not require preserving every current member or comment in `src/engine/port.ts`. Simplify the Interface where production callers permit it. Its purpose is to express Sprout's admitted-run semantics, not mirror a dependency.

This is an architectural recommendation based on source inspection, not an accepted ADR, an implementation, or live execution evidence.

## Inspected upstream version

The current default-branch package manifest declares **0.35.0** at commit `8adde16fe2d12ae54af7d4dff86c3f224380a5c7`. The dependency requires Node.js 24+; Sprout currently declares Node.js 23+. Context7 resolution failed with `fetch failed`, so upstream contracts and implementation were fetched directly from GitHub. [O1, S3]

The existing [integration plan](oar-sprout-integration-plan.md) inspected 0.28.0. Its seam recommendation remains appropriate, but its version-specific implementation assumptions need revalidation before adoption.

## Division of responsibility

```text
Sprout Core / run admission
            |
Authenticated Environment Worker / recovery / leases
            |
Sprout-owned EngineAdapter / EngineSession Interface
            |
One OarEngineAdapter Implementation
            |
OAR Runtime / Session
            |
Native coding-agent runtime
```

| Concern | Owner |
| --- | --- |
| Project and Task authority, Agent identity, admission, lease and recovery decisions | Sprout |
| Sprout run correlation, progress/final-answer projection, result classification, usage attribution and host policy enforcement | Shared Sprout OAR Adapter and Worker |
| Native protocol, runtime transport, native session continuation and vendor event decoding | OAR |
| Enabled runtime IDs, verified instruction channel, readiness and host execution policy | Shared Sprout runtime catalog |

The existing seam carries neutral progress events, separate turn completion, native session identity, explicit interrupted/failed outcomes, resume-refusal classification, and instruction-delivery evidence. Worker engine selection currently constructs four separate vendor implementations. Those facts support replacing the implementations without making product callers learn OAR's larger control Interface. [S1, S2]

## Why direct substitution is incomplete

OAR's Session describes an ordered native record stream and controls including `prompt`, optional `steer`, `queue`, `deliver`, `abort` and `dispose`. Its contract explicitly assigns multi-controller arbitration to the application. An accepted `abort` establishes delivery, not execution termination. Resuming a native conversation opens a fresh stream starting at sequence zero. Multiple flat events can share one record sequence. These semantics must be translated into Sprout run and recovery facts. [O2]

OAR's `promptAndWait` concatenates root text over the turn. Sprout's final answer must retain its own final-message semantics. The helper's timeout requests cancellation, but after an accepted abort it waits for the native terminal outcome without another bound. Host execution supervision is therefore still required. [O3, S1]

OAR defaults disable interactive permission gates and Codex defaults to `danger-full-access`. Sprout currently chooses `read-only` on ordinary hosts and full access in containers. The integration must explicitly apply the selected host policy before session opening; adopting upstream defaults changes execution authority. Codex's sandbox selection reads `process.env.OAR_CODEX_SANDBOX`, so it must not be varied by racing mutations of a shared Worker's environment. [O2, O4, S2]

OAR native queueing can cause Codex to start queued work on reopen. Its upstream crash-resume report describes an attribution race in Claude, and issue #55 remained open during this inspection. Enabling a discovered runtime still needs acceptance for Sprout's root-turn attribution and recovery rules. [O5, O6]

## Lifecycle update from 0.28.0

The 0.35.0 Session contract now explicitly promises bounded disposal and process-tree termination for runtime processes. Do not duplicate native transport or process cleanup that OAR already supplies. [O2]

However, the embedded Pi Implementation still awaits `piAgentSession.abort()` before calling its shutdown helper. The helper bounds extension shutdown at ten seconds; that bound does not cover the preceding abort wait. A separate, supervised OAR runner for each Sprout session remains a reasonable host-level escalation design for embedded execution. A separate child process alone is not a sandbox, and process-tree shutdown must be demonstrated on each supported platform. [O7, O8]

## Implementation direction

1. Implement shared request/event/result translation through the existing public engine seam. Use a scripted OAR runtime to verify rejected prompts, root and background turn attribution, consecutive-run usage, resume identity, final answers and cancellation escalation.
2. Register accepted runtimes as instances of the same Adapter, preserving product engine identities such as `codex` and `pi`. Keep policy and capability differences in a shared catalog consumed by selection, readiness, admission and UI.
3. Validate one Codex and one Pi execution on a supported Environment, including interrupted-session continuation and host policy. Pin the accepted OAR version and update runtime packaging to Node.js 24+.
4. Remove the corresponding old adapters and vendor parser tests after replacement acceptance. Retain tests of Sprout's public execution semantics.
5. Add subsequent runtimes through catalog configuration and acceptance evidence. Small demonstrated compatibility hooks may remain necessary; zero per-runtime validation is not the achievable promise.

Use OAR's runtime/session layer for this integration. Its optional `@botiverse/oar/agents` library can independently spawn child sessions and wake parents through `deliver`; incorporating that mechanism into Sprout collaboration is a separate authority and admission decision, outside the adapter replacement. [O9]

## Ordering relative to Sprout #225

[Issue #225](https://github.com/tinysnake/sprout/issues/225) specifies Host-run engines with remote Environment operations while retaining Environment-hosted execution. It requires Pi, Codex and Claude Code, enforceable local-tool restrictions or native remote routing, remote-origin MCP execution, binding fencing, and recovery independent of the host engine. It retains the existing execution seam and extends engine/Worker Interfaces only where required.

Recommended sequence:

1. Run a bounded OAR compatibility prototype specifically against #225's controls before committing to a production-wide adapter replacement.
2. If that prototype passes, integrate the shared OAR Adapter into the existing Environment-hosted path for the required accepted runtimes, then implement #225 using that execution substrate and the shared Environment operations Module.
3. Defer broad runtime enablement until #225's required path is evidenced. Work on startup parsing, durable placement facts and Environment operations can proceed once their Interfaces are settled, without waiting for unrelated runtime coverage.

This order avoids implementing a new native Claude Adapter and substantial Pi/Codex control plumbing only to replace them during OAR adoption. However, OAR is not a technical prerequisite of #225, and installation/MCP support alone does not satisfy it.

The inspected `SessionOptions` has MCP attachment but no standard members for builtin-tool selection, Pi tool-operation replacement or Codex executor binding. The inspected Pi opener keeps native SDK tools, replacing bash only to overlay environment variables; the Codex thread opener supplies cwd and MCP configuration without a remote executor selection. These are gaps in the demonstrated adoption route, not proof that configuration/extensions can never supply the controls. Prototype the actual permitted mechanisms and outer isolation before assigning downstream work. If required controls cannot be supplied, record the gap and either resolve it upstream or retain a bounded native Implementation for that engine; do not block the whole product on speculative universal OAR support. [O10–O12]

This section is a sequencing recommendation only; it does not amend #225, its acceptance, or tracker dependencies.

## Sources

Upstream sources are pinned to the inspected commit except the live issue-state link.

- **O1:** [OAR package manifest](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/packages/oar/package.json)
- **O2:** [Session contract](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/packages/oar/src/contracts/session.ts)
- **O3:** [Turn helpers](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/packages/oar/src/observe/turns.ts)
- **O4:** [Codex session implementation](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/packages/oar/src/runtimes/codex/session.ts)
- **O5:** [Crash-resume evidence](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/docs/runtimes/crash-resume.md)
- **O6:** [Claude attribution issue #55](https://github.com/botiverse/oar/issues/55)
- **O7:** [Pi session implementation](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/packages/oar/src/runtimes/pi/session.ts)
- **O8:** [Pi shutdown helper](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/packages/oar/src/runtimes/pi/lifecycle.ts)
- **O9:** [OAR subagent mechanism](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/docs/spec/subagents.md)
- **O10:** [Session opening options](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/packages/oar/src/contracts/session-options.ts)
- **O11:** [Pi SDK opener](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/packages/oar/src/runtimes/pi/open.ts)
- **O12:** [Codex thread opener](https://github.com/botiverse/oar/blob/8adde16fe2d12ae54af7d4dff86c3f224380a5c7/packages/oar/src/runtimes/codex/open.ts)
- **S1:** [Sprout execution Interface](../../src/engine/port.ts)
- **S2:** [Worker engine selection](../../src/worker/engine-selection.ts)
- **S3:** [Sprout manifest](../../package.json)
