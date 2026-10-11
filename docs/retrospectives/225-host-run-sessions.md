# Retrospective: #225 Host-run remote work sessions

Date: 2026-10-11

This retrospective examines the work leading to [#225](https://github.com/tinysnake/sprout/issues/225) and [PR #267](https://github.com/tinysnake/sprout/pull/267). It records observations and proposed improvements; it does not amend ticket acceptance, expand the roadmap, or establish new mandatory process gates.

## Evidence and limits

The review indexed 115 Pi session files in the `r225` worktree families, inspected their task prompts and final responses, and examined selected original orchestration exchanges and durable issue records. The initial feature and OAR planning conversations were also examined. This is a process retrospective, not a fresh code review or a rerun of product acceptance.

The indexed sessions include 35 independent ticket-review sessions covering 16 tickets. Fourteen of those tickets received a first-round FAIL; two received PASS. These counts exclude prototype deliveries without a separate ticket-review session and exclude merge and scope reviews. They describe review outcomes, not worker quality or the proportion of defective production code: some failures concern missing evidence, fixtures, dependencies, or acceptance ambiguity.

The final scope record reports 19 accepted tickets, 208 commits, 243 changed files, and 2,483 passing tests across 322 files. PR #267 was subsequently merged. Scope completion used explicit Human-approved amendments and retained named limitations; it does not establish unrestricted production Codex Host-run conformance.

Primary scope evidence:

- [First scope review](https://github.com/tinysnake/sprout/issues/225#issuecomment-6100795184)
- [Final scope review](https://github.com/tinysnake/sprout/issues/225#issuecomment-6101358486)
- [Scope completion](https://github.com/tinysnake/sprout/issues/225#issuecomment-6101390851)

## 1. Guard unfinished Job closure and bound automatic recovery

On 2026-10-10, the Human pointed out that Jobs had been closed despite not declaring completion. The Orchestrator acknowledged closing `a42` and `a43` after interpreting unmet acceptance as the end of the work. It also acknowledged missing dispatch-completion records for those closures. Successor Jobs had to reconstruct context already available to their predecessors.

The relevant main session is `01a11753-6432-76aa-b65c-f8416ab1bfee`, with the Human correction at `2026-10-10T13:01:48Z`.

**Proposed improvement:** separate protection against premature closure from automatic recovery. Job disposition depends on both lifecycle observation and durable work status. A live Pi process proves that the session still exists; it does not prove that the model can execute another turn. An idle or done pane without a completion claim requires inspection. Tooling cannot reliably infer the cause of every stop from pane state or error text, so unknown cases must still wake the Orchestrator.

### Observable facts and recovery decisions

| Observable fact | Supported conclusion | Proposed action |
| --- | --- | --- |
| Pi process exited or its terminal disappeared | The current session cannot continue directly; the cause may remain unknown | Preserve available records and notify the Orchestrator |
| Pi is alive and reports an explicit structured quota, authentication, or configuration failure | The session exists, but an execution prerequisite is unmet | Stop automatic continuation and notify the Orchestrator |
| Pi is alive and reports an explicitly retryable stream or temporary service failure | A bounded recovery attempt may be useful | Continue in the same session within a finite budget; notify the Orchestrator after repeated failure |
| Pi is alive and idle without a completion claim or a reliable error classification | The turn stopped; completion and recoverability are unknown | Notify the Orchestrator for inspection and a decision |
| A durable completion claim matches the assignment | The assignment can enter reconciliation | Follow normal review, retention, or cleanup; a completed review may carry FAIL |

### Closure guard

Before closing an unfinished Job, check for a completion or handoff record. When neither exists, report the current lifecycle observation and recent error, explain that closure discards usable session context, and require inspection or an explicit termination/replacement reason. Process death, context exhaustion, cancellation, deliberate abandonment, or an explicit handoff can justify replacement. Capture unfinished work before disposal. The guard checks the basis for closure; it does not need to establish the root cause of the error or introduce a new Human approval requirement.

Distinguish assignment completion from implementation acceptance: a reviewer that submits a FAIL verdict may have completed its assignment, while a worker that reports unmet acceptance may still need continuation.

### Finite recovery budget

Start with at most one automatic recovery attempt for a reliably classified temporary failure. Record the triggering error, attempts consumed, and whether the attempt produced actual task progress. Keep the budget with the logical Job and unresolved failure; sending `continue`, seeing `working`, reopening a window, or replacing a session must not silently reset it. Only demonstrated task progress or an explicit change to the failed prerequisite can justify renewing the budget under the configured policy.

Quota exhaustion stops immediate automatic recovery. If reliable error data names a replenishment time, record the Job as blocked until that time; a configured policy may permit one bounded retry afterward. Repeated failure remains blocked and notifies the Orchestrator. Do not repeatedly prompt the model to continue or declare completion while the same quota failure persists. Unrecognized errors also go to the Orchestrator rather than receiving an unlimited retry loop.

### Save the available state without requiring another model turn

Tooling should preserve the existing transcript, recent error, Job and session identities, branch/commit, and workspace status independently of the model. A model without quota may also be unable to summarize, write a Work record, or commit. Record a missing summary or completion claim explicitly; do not keep retrying merely to obtain one. Apply the existing privacy rules to captured diagnostics and retain them in the appropriate local record store.

The Orchestrator still receives stops that automation cannot resolve. Tooling protects the session, captures observable facts, and performs a small number of explicitly permitted recoveries.

**Where to retain it:** the shared Dev Pipeline Job lifecycle implementation and its skill documentation. Keep Sprout's `AGENTS.md` as a pointer to project process rather than copying tool lifecycle rules into it.

**Useful verification:** cover premature closure of a live incomplete worker; one same-session retry after an explicit temporary stream failure; repeated failure exhausting the budget without a window/session reset bypass; quota exhaustion and unknown errors waking the Orchestrator without repeated continuation; state capture without a model turn; and a completed reviewer with a FAIL verdict settling normally.

## 2. Protect settled contracts across later tickets

Two concrete composition failures demonstrate why independently passing slices can still fail together.

- The #242/#244 merge exposed an exclusive MCP lease and a separately required workspace-mutation lease. Each route passed its own probe, but a single session could not use both. The first correction then exposed keepalive starting only at the first workspace mutation, leaving an MCP-only turn vulnerable to lease expiry. See [merge finding MF1](https://github.com/tinysnake/sprout/issues/242#issuecomment-6071983658) and [MF2](https://github.com/tinysnake/sprout/issues/242#issuecomment-6072374786).
- #259 explicitly prohibited Operations from acquiring leases. Later #258 added a read/search acquisition path, and its positive test asserted the contradictory behavior. The final scope review caught it after ticket acceptance. The correction removed acquisition methods from the Operations dependency type and tested all five bound operation paths. See [scope finding F1](https://github.com/tinysnake/sprout/issues/225#issuecomment-6100795184).

**Proposed improvement:** the project defines which settled behaviors must be preserved and how to verify them. Dev Pipeline transports that project-supplied context, records its sources and baseline, and routes verification through its existing assignments and gates. Sprout-specific lease, MCP, execution-mode, model-authority, and recovery rules remain in Sprout's specifications, domain documentation, interfaces, and tests.

### Keep the shared tool generic

| Responsibility | Dev Pipeline | Target project |
| --- | --- | --- |
| Define constraints | Provide a generic handoff format | Select behavior from current specifications, ADRs, and approved decisions |
| Select relevant constraints | Require the Orchestrator to state the applicable context | Apply repository rules and inspect the affected behavior and interfaces |
| Verify preserved behavior | Pass through project-supplied checks and record results | Supply tests, commands, and review evidence |
| Handle decisions that changed | Retain source/baseline references and identify assignments needing reassessment | Decide whether specifications, dependencies, and implementations must change |
| Judge semantic correctness | Have the reviewer compare the change with the supplied sources | Provide authoritative requirements and behavioral evidence |

File overlap can suggest relevance, but cannot reliably identify every semantic dependency. The Orchestrator and reviewer must reason about affected behavior. A tool can check missing fields, readable references, or inconsistent context versions; those mechanical checks do not prove that the selected constraints are complete or correct.

### Project practice in development-loop.md

Reuse the existing Ticket `Constraints` section. Each relevant constraint states the preserved behavior, its current authoritative source, and its verification. Keep the full rule in that source rather than creating another rule registry or copying the entire project history into each Ticket.

```md
## Constraints

- Preserve: <the behavior this work must retain>
  Source: <current spec, ADR, or approved decision>
  Verification: <existing check, or the evidence this ticket must add>
```

A Sprout assignment touching Environment Operations can include the approved rule that bound operations borrow a containing lease and never acquire one, with evidence that operations without one refuse before Worker dispatch. Dev Pipeline carries this text without introducing any lease-specific field or logic.

Proposed additions to the existing development-loop steps:

| Step | Concrete practice |
| --- | --- |
| 3. Build the frontier | Check whether neighboring Tickets affect the same settled behavior. Shared settled rules can support parallel work; conflicting redefinitions require resolution before dispatch. |
| 4. Select and claim | Reconcile relevant constraint sources against the current integration state rather than reusing the original ticket breakdown unchanged. |
| 5. Execute and record | For applicable constraints, record preserved behavior and evidence, or the conflict and its cause. Route a required rule change through the existing decision/replanning process. |
| 6. Accept | Verify both the Ticket's new behavior and relevant existing behavior. A passing test that expects behavior contrary to an approved rule is evidence of a conflict. |
| 7. Continue or re-evaluate | After a decision changes, update affected unfinished Tickets and dependencies. Send an explicit change notice to already-running assignments. |

For a small change with no relevant shared behavior, a concise explanation is enough. Expand only applicable constraints.

### Generic assignment and review handoff

Dev Pipeline's `references/protocol.md` already requires task prompts to include constraints. Extend that existing prompt contract with a project-context section:

```md
## Project context

- Integration baseline: <commit>
- Applicable constraints: <statements and source references>
- Required verification: <project-supplied checks>
- Known conflicts or pending decisions: <references or None>
```

The Orchestrator selects this context according to repository rules, gives the same captured context to the worker and reviewer, and records source references and the integration baseline in the Dispatch. Rework receives that context together with all previous findings. Where a source is mutable, retain its captured revision or content so a URL alone does not imply the worker and reviewer saw the same requirements.

In `references/review.md`, require the reviewer to compare relevant preserved behavior with the project-supplied sources. A short review section can make the result explicit:

```md
### Preserved behavior

- <constraint reference>: preserved — <evidence>
- <constraint reference>: violated — <finding ID>
- <constraint reference>: unresolved — <missing evidence or source conflict>
```

Tests are evidence to assess against requirements. They do not supersede an approved decision merely because they pass. If authoritative sources conflict, report the conflict through the existing decision path rather than choosing the interpretation that makes acceptance easiest.

### Integration checks apply to clean merges too

Dev Pipeline's current `references/integration.md` treats a clean Git merge as completing Ticket integration immediately. The proposed generic change is to execute repository-required integration checks before recording completion. The repository decides whether the affected behavior needs composition checks or additional review.

For Sprout, add this project practice to development-loop.md: when completed slices first combine use of the same resource, authority, or lifecycle, verify one coherent path through their composition. Prefer existing high-level test interfaces and expand only to affected behavior. A clean merge does not require a full independent repository review by default.

For #242/#244, the project-supplied check is a single run that calls MCP and edits the workspace under the same containing lease, then settles safely. Pipeline schedules and records the check without understanding MCP or implementing lease semantics.

Before integration, compare an assignment's captured constraint sources with current project decisions. If relevant behavior changed, reassess the implementation and evidence before recording integration complete. Content changes can flag the need for review, but formatting-only source changes must not automatically invalidate every dependent assignment.

### Apply the practice to #259 and #258

1. After #259 acceptance, the Map's `Decisions so far` points to the settled ownership rule and its verification evidence.
2. Dispatch for #258 includes that rule as applicable project context.
3. Implementation must satisfy both shared read leases and the existing prohibition on Operations acquiring a lease.
4. Review compares the implementation and tests against the same source; a positive acquisition test is a conflict to resolve.
5. Integration reruns the existing no-containing-lease refusal check on the combined result.

Enforce the prohibition through Sprout's module interface where possible. The final correction's narrow pool type is a strong example: Operations cannot call an acquisition method it is never given. Preserve mixed MCP/workspace and no-containing-lease regression scenarios as project behavior checks. This implementation constraint belongs to Sprout, not Dev Pipeline.

**Initial adoption scope:** amend Dev Pipeline's `references/protocol.md`, `references/records.md`, `references/review.md`, and `references/integration.md`, plus Sprout's `docs/agents/development-loop.md`. Start with existing prompts, durable records, and project checks; add mechanical tooling only after actual handoff omissions demonstrate its need. No new project-specific Pipeline configuration or general rule engine is needed for the first iteration. These are proposed changes, not changes implemented by this retrospective.

The existing loop already sequences unsettled interfaces. The new lesson is to propagate settled rules through later assignments and verify interacting slices when they first meet.

## 3. Diagnose specification conflicts before spending another repair round

#257 took five independent review rounds. It alternated between preserving dotted filenames and redacting hostname-shaped tokens. Inputs such as a `.com` executable filename and a two-label `.com` hostname are lexically ambiguous in file context. More suffix coverage could not resolve the policy choice. The Human eventually chose file preference in that context and explicitly accepted the resulting ambiguity.

Evidence: [round 3 rejection](https://github.com/tinysnake/sprout/issues/257#issuecomment-6084258748), [blocking conflict](https://github.com/tinysnake/sprout/issues/257#issuecomment-6084980147), and [Option A decision](https://github.com/tinysnake/sprout/issues/257#issuecomment-6085092145).

#249 and #252 provide a second example. Repeated Codex runs advertised tools without producing dynamic tool calls; the final record preserved that limitation. #252 also required a model-issued host read/write attempt even though the accepted production tool catalog contained no local file or shell tool. Adding a tool to manufacture the attempt would change the boundary being tested. The Human approved explicit acceptance amendments instead of allowing unobserved results to count as conformance.

**Proposed improvement:** classify the work a failure requires before dispatching another implementation attempt, and state what new evidence or correction will advance it. Separate early replanning of a demonstrated specification problem from the existing formal diagnostic Job. Keep project decisions in the target repository's process; Dev Pipeline carries the evidence and enforces its existing bounded execution policy.

### Check whether high-risk acceptance can be expressed and observed

Before declaring a Ticket ready, inspect acceptance that depends on external engines, platforms, installations or authorization; requires evidence of prohibited behavior; or combines preservation and rejection rules that may conflict. This is a targeted readiness check, not a new checklist for every small change.

| Question | Required clarification |
| --- | --- |
| What behavior must be proved? | Concrete input, conditions, and expected result |
| Which interface triggers it? | Whether an authorized production interface can express the required action |
| What observation distinguishes the outcomes? | How to distinguish success, failure, and an action that never occurred |
| Which prerequisite is missing? | The smallest research, prototype, installation, authorization, or decision needed first |

#252's model-issued host read/write criterion should have exposed the mismatch between the requested attempt and a production catalog without local file tools before scheduling repeated conformance runs. Resolve that mismatch by an authorized change to verification or an explicit prerequisite. Missing evidence remains missing until resolved.

Put this practice in development-loop.md's Evaluate step and Ticket readiness guidance. Pipeline asks for the project's verification basis without embedding engine-specific assumptions.

### Route a failed review by the work needed

| Failure supported by evidence | Next action |
| --- | --- |
| Expected behavior is clear and implementation violates it | Normal implementation rework |
| Required behavior is valid but the probe, fixture, or observation is defective | Repair verification while preserving the behavioral requirement |
| One decisive fact is missing | Bounded research or an experiment that answers that fact |
| Installation, authorization, or an external prerequisite is unavailable | Record the blocker and a concrete resumption condition |
| Requirements demand incompatible outcomes under the same available conditions | Resolve the specification or product decision through the project's process |
| Repeated fixes fail and attribution remains uncertain | Use the existing bounded formal diagnosis path |

The categories guide the Orchestrator's judgment; tooling does not infer root cause automatically. Cite evidence and retain uncertainty where attribution is incomplete.

For #257, an early conflict record could have stated that the same `Read github.com` text can denote a filename or hostname, while the available information cannot distinguish the interpretations and the acceptance asks for both preservation and redaction. The next useful work is a precedence decision or a way to supply distinguishing information, rather than another suffix patch.

### Give each rework a reason to advance

Extend the existing rework Triage with a concise next-attempt explanation, using existing Work and Dispatch records rather than starting another diagnostic Job for every FAIL:

```md
### Next attempt

- Unmet criterion: <exact criterion and source>
- Current explanation: <judgment supported by prior evidence>
- Change or experiment: <what this attempt will do differently>
- Expected observation: <how the result confirms or rejects the explanation>
```

An ordinary fix with a known cause needs only a short explanation of the correction and expected behavior. An uncertain retry names the new variable or observation. For example, inspect the engine-confirmed catalog to distinguish registration failure from an advertised tool that the model did not invoke.

If environment, method, and observations are unchanged, choosing a stronger worker still needs a concrete explanation of the difficulty that additional capability is expected to resolve. Without an actionable basis, route to research, a decision, or the existing diagnosis path. Repeated zero-tool-call results establish that those attempts made no calls; they do not establish that the engine can never call a tool. Preserve that evidence limit while avoiding repetitions without a new basis.

### Keep early replanning distinct from formal diagnosis

- A demonstrated specification conflict goes through the project's decision or replanning process without first spending the implementation budget.
- A precisely missing fact gets the smallest bounded research or experiment.
- Repeated failure with unclear attribution gets the independent, read-only diagnostic Job under existing triggers and limits.

Dev Pipeline already exposes optional `rework.diagnose_after` as a count-based earlier trigger. A lower threshold does not recognize semantic conflicts and may diagnose ordinary repairs prematurely. Start with better failure routing and next-attempt evidence while retaining current code-owned counters. If evidence-based early dispatch of a formal diagnostic Job is later needed, design it as a generic capability with a recorded reason, supporting evidence, and the existing diagnosis cap.

Do not manually change counters, copy a failing Ticket into a fresh one, or replace its session to bypass work or diagnosis budgets. Explicit prerequisite work keeps the original Ticket's history and budget intact.

### Make acceptance changes traceable and authorized

Distinguish a verification correction that retains the product commitment from a change to the commitment itself. Fixing an incorrect fixture, observation method, or predicate can follow existing project authorization. Reducing support, changing behavior or permissions, or accepting a new risk needs the decision-maker designated by the project. A diagnostician may propose changes and make amendments within granted authority; it cannot remove a parent specification's commitment by rewriting a child Ticket.

```md
### Acceptance change

- Previous requirement: <text or revision reference>
- Replacement: <new requirement>
- Reason and evidence: <why the change is justified>
- Authority: <decision or applicable project authorization>
- Commitments retained: <what still must be proved>
- Affected work: <tickets, probes, or reviews needing updates>
```

Give workers and reviewers the same revised acceptance and retain the previous version for audit. Unproved cells remain explicitly unproved. #252's named amendments and non-claims are worth retaining; recognize the need and obtain the decision earlier.

### Let feasibility work conclude with an evidenced blocker

A Ticket asking whether a route is feasible can complete with supported feasibility, a proven blocker, or a named prerequisite when its acceptance defines those as valid findings. A Ticket promising implementation does not complete merely because the route is blocked.

A useful blocked conclusion identifies what has been ruled out, the blocking condition, its smallest remedy, and the executable alternative that does not depend on that route. Keep the implementation Ticket unfinished, link necessary prerequisite work, and continue independent frontier work. Do not turn a research or prototype acceptance into an implicit requirement to deliver the complete production feature.

### Initial adoption and verification

| Location | Proposed addition |
| --- | --- |
| Sprout development-loop.md | High-risk acceptance readiness checks; failure routing; next-attempt rationale in Triage; acceptance-change authority and affected-work updates |
| Pipeline references/protocol.md | Rework prompts require an actionable correction or a different evidentiary basis |
| Pipeline references/review.md | Findings cite the requirement source and distinguish an actual violation, missing evidence, and source conflict |
| Pipeline references/records.md | Retain next-attempt rationale and acceptance-change information in existing records |
| Pipeline references/diagnosis.md | Distinguish early project replanning from formal diagnosis; clarify the authority for acceptance amendments |

First verify the practice through prompts and records: a #257-style ambiguity should surface as a decision before another speculative repair; a #249-style retry should name a distinct observation; and an ordinary code defect should still proceed directly to proportionate rework. Then decide which mechanical checks deserve implementation in the shared tool. These are proposed improvements, not changes implemented by this retrospective.

The existing loop's whole-history triage, bounded diagnosis, and acceptance-amendment workflow remain the foundation. The improvement is earlier routing and a checkable basis for the next attempt.

## 4. Make evidence probes exercise the actual user path

Several failures came from probes proving less than the product journey required.

- #243 initially used a scripted adapter where original acceptance required a real Pi Task journey. See [review finding F1](https://github.com/tinysnake/sprout/issues/243#issuecomment-6073510738).
- #251's admission test seeded Runtime directly. The actual Agent creation and reconfiguration path removed a model suffix, causing exact-match admission to refuse the authorized model. See [review findings](https://github.com/tinysnake/sprout/issues/251#issuecomment-6095606436).
- #252's no-Environment predicate trimmed the final response and omitted the empty-lease assertion, so its own pass condition did not prove the promised result. See [round 2 finding](https://github.com/tinysnake/sprout/issues/252#issuecomment-6099931375).
- A new sanitizer import was absent from the Host Pi sandbox's static resource allowlist. The child failed before emitting readiness facts and the outer catch projected all dimensions as unknown. This was a real product defect, distinct from the initially suspected CLI-version difference.

**Proposed improvement:** agree on a small evidence matrix before engine conformance starts: scenario, production entry path, required evidence level, pass predicate, and prerequisites. Distinguish source inspection, scripted operations, protocol calls, model-issued calls, and a separately deployed enrolled Worker. A narrower amendment changes only named cells; it does not waive remaining expressible cells.

Use at least one normal Agent create/configure-to-run path for model admission. Keep exact response, lease settlement, operation origin, and denial category inside the machine-evaluated pass predicate. Exercise readiness inside the actual production isolation profile so resource-allowlist failures surface before full journey work.

**Where to retain it:** reusable engine conformance probes and ticket acceptance templates. Business values such as model aliases and Project filenames should retain their typed semantics; a general identifier sanitizer should not silently redefine them. Keep privacy protection at explicitly defined output and persistence boundaries.

## 5. Observe, prioritize, and streamline the test suite

Reviewers repeatedly invented four, eight, ten, sixteen, thirty-two, or thirty-nine test partitions to fit the 180-second command limit. Concurrent load caused retries, and some wrapper calls exceeded their cumulative timeout despite bounded individual partitions. #257's first reviewer checkout lacked dependencies, producing typecheck and module-load failures unrelated to the filename policy.

**Proposed order:** repair observation, establish a performance/reliability baseline, improve slow harnesses and test selection, and prune tests by unique regression value. Diagnose critical intermittent failures alongside baseline collection. Treat maintenance value and runtime cost as separate concerns: removing cheap redundant assertions will not address an expensive DOM harness.

### Facts established during this retrospective

The bounded checks ran on the primary checkout at `2cea98f6d`, before #225's full integration. Candidate names and assertion shapes were also checked against `r225-integration` at `e6d075e40`. Performance samples therefore describe the primary checkout, not a complete benchmark of the final 2,483-test suite.

| Check | Observed result | Evidence limit |
| --- | --- | --- |
| `npm test -- src/test-summary.test.ts` | 3 passed; existing internal-timeout recording self-tests work | Does not prove coverage of other failure or interruption modes |
| Synthetic ordinary assertion failure plus a completed 150 ms test, through `npm test -- --bench <fixture>` | Failure and durations printed; no persistent JSONL | Confirms missing ordinary-failure and completed-duration recording |
| Synthetic per-test deadline, with the suite deadline still unspent | One cancelled test and a timeout failure printed; no persistent JSONL | Confirms that per-test timeout is not captured by the suite-timeout branch |
| Synthetic hung test with an 800 ms internal suite deadline | Persistent record names the active candidate | Confirms the existing internal total-timeout path works |
| `npm test -- --bench web/src/modules/tasks/tasks.dom.test.ts` | 28 passed; approximately 52.0 seconds | One performance sample; no attribution of the exact share spent in initialization versus waiting |
| Config, schema, and Agent-service benchmark sample | 114 passed; approximately 0.4 seconds total | These cheap tests are unlikely to explain overall suite cost |
| `npm test -- --bench src/worker/cli/worker-cli-recovery.test.ts` | 5 passed; approximately 5.9 seconds | Historical intermittent failure was not reproduced; its cause remains unknown |

No tests were deleted and no production test entrypoint was changed during this investigation. Synthetic failure fixtures used disposable local paths and were not added to the default suite.

### Prune tautological and redundant tests by unique protection

A strict tautological oracle derives its expected result from the same implementation or mirrors the same defective calculation. A separate low-value category checks static fixtures, constants, language behavior, or behavior already protected by a stronger test. Identify which category applies before proposing deletion.

The repository's `docs/test-suite-audit.md` provides an existing method and candidate list, but covers an older 1,372-test inventory. Refresh it against the final suite; this retrospective does not claim to have individually audited all 2,483 tests or established a deletion percentage.

| Inspected candidate | Assessment | Proposed disposition |
| --- | --- | --- |
| `src/host-config.test.ts`: `the host proxy is empty when the host declares none` | Redundant with the empty-environment contract's `containerProxy: {}` assertion | Delete the separate case while retaining the default configuration contract |
| `src/store/schema.test.ts`: `schema constants declare supported version range` | Low-value literal snapshot; actual creation and migration behavior provides stronger protection | Integrate supported-range consistency into opening/migration checks, then remove the constants-only case |
| `web/src/modules/agents/agents.service.test.ts`: fixture state-matrix check | Primarily checks test data; production DOM state-matrix cases exercise observable rendering | Move necessary fixture preconditions into the relevant behavior tests before deleting the standalone shape check |
| Same file: `attribution fixtures carry no transport addresses or paths` | Static fixture privacy check does not demonstrate production output sanitization | Merge into the attribution contract that uses those rows, or keep only if deliberately shared as a reusable fixture contract |
| `web/src/modules/usage/usage.service.test.ts`: fixed counts in `FixtureUsageService: returns accurate aggregates and scoped options` | Counts such as ten activities, two projects, and four Agents primarily lock sample data | Remove counts without a business requirement; retain genuine filtering, aggregation, and production mapping protection |

For each candidate, state the realistic defect it detects, the observable contract, and the remaining test that detects the same defect. When consolidating important protection, use a targeted mutation to show the retained test still fails for that defect. A green suite after deletion alone does not prove protection survived.

Do not delete migration rollback, safety-copy, durable reopen, or memory/SQLite cases merely because their names overlap. They can cover different dependency behavior and failure modes. Tests of fake implementations establish fake fidelity or fixture behavior; they do not by themselves prove production correctness. Avoid deleting an entire fixture-service suite without checking how its fidelity supports the UI tests.

### Select tests by stage, impact, and risk

Full-suite execution is unnecessary after every local edit. The proposed project policy is:

| Test set | Contents | Trigger |
| --- | --- | --- |
| Quick core | Cheap logic, parsing, state machines, database contracts, and a compact set of critical authority/recovery regressions | Meaningful implementation edits |
| Affected behavior | Changed modules, direct consumers, and relevant composed paths | Implementation completion and Ticket review |
| Extended regression | Complete DOM matrices, browser layout, platform startup, real processes, and longer fault scenarios | Related changes; Change request/final integration; periodic regression |
| External conformance | Real engines, containers, and separately deployed Workers requiring explicit prerequisites | Adapter/environment changes and the corresponding release acceptance |

Stable history and long duration do not make a test unimportant. Keep cheap high-impact migration, lease, privacy, authority, and recovery checks in regular protection. Long-running critical scenarios should be made faster or placed in an appropriately triggered extended run while a truthful compact regression remains available.

Initial candidates for less frequent unrelated-change execution are historical prototype DOM suites with no active acceptance dependency, exhaustive page/route matrices beyond representative smoke, platform/container/browser/engine checks, and extended fault-stress matrices. Re-enable them whenever their owning behavior or prerequisites change. Do not move the entire Task DOM suite out of relevant-change verification: it contains permissions, stop confirmation, and recovery behavior.

Use one project-owned inventory and selection plan with explicit membership and reasons. Audit planned full-suite membership for 0 missing / 0 extra / 0 duplicate files. Shared interfaces, schema, test harnesses, dependencies, build configuration, and uncertain impact widen selection; a path-only filter cannot establish semantic independence.

Run full verification on the final composed result before integration into the target branch. Reuse complete evidence for the same commit/content fingerprint, test inventory, and compatible environment instead of making each role rerun it without a new reason. Dirty-tree evidence must identify the tested content, not merely its base SHA.

These tiers require an explicit update to the repository's verification guidance and Pipeline assignments before replacing existing required full checks. They are not new commands or a changed `npm test` default implemented by this document. Keep project-specific selection policy and suite membership in Sprout; shared Pipeline tooling receives the project's commands and evidence requirements.

### Improve expensive DOM harnesses before weakening coverage

`web/src/modules/tasks/tasks.dom.test.ts` repeatedly creates a Vite environment and uses fixed `settle(120)` waits. Its measured cost warrants profiling initialization, transformation, mounting, actions, assertions, and cleanup separately.

- Try reusing the compilation environment within one test file while creating fresh application state, services, and mounts for each case.
- Replace fixed waits with explicit request completion, DOM conditions, render turns, or controlled timers for timing behavior.
- Reset router, Pinia, subscriptions, observers, animation frames, timers, and DOM state. Vue captures `document` during module evaluation; replacing globals while reusing old modules is not a safe isolation strategy.
- Keep DOM cases serial where they mutate shared globals. Reuse must not create order dependence.
- Retain real-browser evidence for layout, scroll, and focus behavior whose truth cannot be established by JSDOM.

Measure the delivered improvement under the same workload and compare both individual-file and full-suite wall time. Do not claim that initialization or sleep accounts for a particular fraction until measured.

### Expand recording into a durable observation dataset

Current `scripts/test-summary.ts` appends JSONL only in its `timedOut` branch. Ordinary failures, completed slow tests, and per-test cancellation do not enter that branch. `--bench` only prints durations. Temporary TAP/progress files are removed at completion. The default internal deadline and external command limit are both 180 seconds, creating a risk that external termination prevents the wrapper's final write. A worktree-local `test-timeout.jsonl` is also a poor retention location when worktrees are reclaimed. These are established design gaps; they do not prove which one caused every absent historical record.

Extend the existing reporter/wrapper with two record levels:

| Record | Minimal fields |
| --- | --- |
| Run | Run ID; commit and dirty-content fingerprint; inventory digest; suite/shard; Node/dependency versions; concurrency; start/end; exit disposition |
| Test result | Repository-relative file; full test name or stable identity; outcome; duration; attempt number; fixed error classification; Run ID |

Retain passing results as well as failures so rates have denominators and duration regressions can be measured. Preserve cancelled, skipped, timed-out, and incomplete states rather than treating zero reported failures as a successful run.

1. Write `run_started` before test execution.
2. Stream results as they become available; avoid saving everything only after the suite finishes.
3. Write the run summary at completion.
4. A run lacking its ending record is incomplete. Preserve the latest observed active tests as candidates, not proven causes.
5. Write a separate file per run to avoid concurrent writers corrupting one JSONL.
6. Default local storage to a shared location that survives worktree reclamation, such as the Git common directory's observation subdirectory, with an environment override.
7. Upload the same sanitized format as CI artifacts and consolidate it with local observations.
8. Preserve all retry attempts; a later pass never overwrites the initial failure.

Use structured runner events. Node's documented result events carry duration and failure metadata; the current progress reporter intentionally retains only a subset. Keep execution-order events for active-test candidates and result events for outcomes; do not infer execution order from declaration-ordered result output. Verify reporter behavior on supported/pinned Node versions. Reference: [Node test-runner event documentation](https://github.com/nodejs/node/blob/main/doc/api/test.md).

Apply repository privacy rules before persistence: relative paths, non-identifying environment classes, fixed classifications, and sanitized or hashed diagnostics. Do not dump raw environment variables, credentials, endpoints, host identities, or assertion payloads into the dataset. Maintain bounded local retention/rotation and longer-lived aggregate history; treat CI artifact retention as a configured part of the collection plan.

Keep the internal deadline below the outer command limit with measured room for shutdown and recording. Preserve partial evidence continuously because `SIGKILL` cannot be handled after delivery. Every agent-facing command, including an enclosing shard runner, remains at most 180 seconds. A full suite taking longer uses separately bounded invocations and a final inventory/result aggregation; enclosing all shards in one oversized invocation defeats the bound.

Start with JSONL and a small aggregation script rather than an observability platform. Report first-attempt failure rate, timeout rate, fail-then-pass retry rate, median/P95 test and file durations, suite wall time, startup overhead, incomplete runs, and isolated-versus-concurrent differences. Group by revision, test version, environment, selection, and concurrency. A retry pass is a flake candidate, not proof of nondeterminism when input or environment changed.

### Diagnose and repair intermittent failures by impact

Prioritize recording/cleanup defects first, then high-impact authority, lease, persistence, recovery, deduplication, and cancellation failures, followed by repeated DOM setup/fixed waits and lower-impact compatibility problems. Temporary quarantine needs a reason, owner, preserved execution/observation path, and a re-enable condition. It must not silently remove the only protection for a critical behavior.

The Worker recovery case at `src/worker/cli/worker-cli-recovery.test.ts:161` uses journal-file polling and the shared 60-second `waitFor` deadline. Its bounded isolated run passed all five cases; historical failure remains unproved in this investigation. The next diagnostic work should:

- Repeat the existing case both isolated and under controlled concurrency, retaining every attempt.
- Observe worker startup, event production, journal-write completion, connection loss, and stop evidence separately.
- Identify the phase that stalls before attributing the failure to product ordering, test synchronization, load, or resource leakage.
- Use an explicit completion signal when the contract requires a completed write; do not merely extend sleeps or remove the decisive assertion.
- Verify the original trigger and a regression that detects the confirmed cause after repair.

Increasing a timeout can be justified by measured scheduling needs, but a passing longer wait does not establish a repaired cause. Retain failed attempts even when a whole partition rerun passes.

### Adoption sequence and completion evidence

| Stage | Deliverable | Completion evidence |
| --- | --- | --- |
| 1. Recording | Streamed run/test results, durable shared storage, bounded cleanup | Ordinary failure, per-test timeout, total timeout, slow success, crash/incomplete run, and retries each leave distinct sanitized evidence |
| 2. Baseline | Final-integration inventory and controlled isolated/concurrent measurements | Rates and durations have denominators, revision/context, and complete inventory attribution |
| 3. Harness performance | Focused Task/route DOM initialization and synchronization improvements | Same meaningful assertions pass; comparable per-file and suite measurements improve without isolation leakage |
| 4. Selection | Project-owned quick/affected/extended/external sets and explicit triggers | Related changes activate protection; full selection has no omissions/duplicates; every invocation stays bounded |
| 5. Pruning | Updated unique-protection audit and small reviewed deletions/consolidations | Retained tests still detect representative defects; no claim based only on a lower test count |

Critical flaky diagnosis can run alongside baseline work. Reuse [#254](https://github.com/tinysnake/sprout/issues/254) for the bounded runner and shared verification concerns rather than creating a competing runner effort. Cheap deterministic checks, including dependencies and full-range whitespace, precede expensive review. The MCP EOF whitespace defect's earlier suggestion and later blocking disposition should align with the required check from the start.

Proposed implementation locations are `scripts/test-summary.ts`, `scripts/test-progress-reporter.mjs`, recording/runner contract tests, project-owned suite selection and aggregation scripts, the affected DOM/recovery harnesses, `docs/test-suite-audit.md`, and project verification guidance. These are a repair plan, not implemented changes in this retrospective.

## 6. Make delivery state explicit

The Orchestrator announced #225 closure and scope completion after pushing the integration branch and publishing a change-request comment, but no PR existed. The Human had to ask whether it had been submitted. PR #267 was created afterward.

**Proposed improvement:** record three separate delivery facts: accepted scope/evidence, published change request or PR, and integration into the target branch. Where the repository uses PRs, completion reporting should include the PR URL and current state. Creating the PR and deciding to merge it are separate actions governed by the existing authorization.

The accepted MVP and the full compatibility ambition should also remain separately visible. Codex's production gate, zero-call evidence, deferred isolation breadth, and incomplete recovery observations belong in the delivery summary, not only in long comment histories. The final records did preserve those limits; the improvement is to lead with them when describing what an operator can use.

**Where to retain it:** the pipeline's finish phase and PR description template, with milestone evidence in `docs/roadmap.md`.

## 7. Explain the decision before asking the Human to choose

The main conversation contains repeated requests for plain-language explanations and two `wait-what` interventions. Many updates led with Job IDs, commit hashes, port allocations, test counters, or escalation accounting. Those facts supported the journal but made the operator's immediate question harder to answer. The Human identified a more specific problem during this retrospective: decision requests often supplied options without explaining how the situation arose, and technical jargon made the choice difficult to understand.

**Proposed improvement:** require a self-contained decision explanation before presenting the question. A Human returning after an absence should understand the original goal, relevant events, current problem, consequences, and requested decision without reconstructing the session history. The shared Pipeline defines this communication process; the target project supplies facts, terminology, and decision authority.

### Establish whether a Human decision is actually needed

| Situation | Agent's next action |
| --- | --- |
| The cause is unclear, information is missing, or results contradict one another | Investigate facts available to the Agent; distinguish established results from remaining uncertainty |
| Requirements are clear but implementation or verification fails | Diagnose and repair under existing authorization |
| Feasible alternatives require a choice of product behavior, investment, or accepted limitations | Prepare a decision explanation |
| Progress requires credentials, hardware access, or another Human-only action | Explain the purpose and provide precise action instructions |
| The Human already authorized the same action or decision | Continue under that authorization; ask again only after a material change that requires a new decision |

Before making a recommendation, obtain accessible facts that could materially change it. A missing investigation is not automatically a product choice. If uncertainty remains, explain what is unknown and how it affects the available choices.

### Explain the situation in a stable order

Use six parts, scaled to the decision's complexity. Simple questions can combine parts; complex questions must retain the causal explanation.

1. **Original goal:** describe the observable behavior the Human wanted.
2. **Current progress:** explain what already works and which results are established.
3. **Problem and cause:** state the trigger, observed behavior, consequences, and why the work reached this point. Separate evidence from hypotheses.
4. **Reason for Human involvement:** identify the actual tradeoff or authority needed, and why further ordinary implementation cannot choose it.
5. **Recommendation and alternatives:** explain outcomes and accepted limitations for each feasible choice, with reasons for the recommendation.
6. **Exact decision and next action:** ask a concrete question, state the scope of the answer, and explain what will happen afterward.

A reusable drafting structure is:

```md
We wanted <observable goal>.
So far, <established progress>.
When <trigger>, we observed <problem>, which affects <user consequence>.
We established <cause/evidence>; <remaining uncertainty> is still unknown.
Your decision is needed because <actual tradeoff or authority>.
I recommend <choice>, because <reason tied to the agreed goal>.
This provides <benefit> and accepts <limitation>.
The feasible alternative is <choice>, with <different outcome and cost>.
Please decide <one concrete question with an explicit scope>.
Afterward, <next action>; <independent work> can continue.
```

This is a drafting aid, not a requirement to produce ten disconnected sentences or headings. The final message should read as a connected explanation.

### Compare consequences and give a supported recommendation

Options should describe what changes for the operator, not only name internal mechanisms or say "relax" versus "keep". For each meaningful alternative, cover what it enables, what limitation or risk it accepts, and how current work changes. Recommend a choice using the Human's approved goals, usage, or evidenced feasibility.

| Choice | What the Human gets | What must be accepted | Effect on current work |
| --- | --- | --- | --- |
| Recommended choice | Observable capabilities or outcome | Explicit limitation, risk, or deferred capability | Work that continues and work that waits |
| Feasible alternative | Different observable outcome | Different restriction, effort, or prerequisite | Delivery or verification changes |

Use measured cost when available; otherwise state that effort or duration is unknown. Identify uncertainty that could change the recommendation. Do not invent deadlines or fill the list with an arbitrary number of choices. Every listed option must be feasible within its stated assumptions, or clearly conditional on a named prerequisite.

### Translate necessary terms into behavior

Explain a necessary technical term at first use through its effect on machines, files, actions, and results. Put exact identifiers and detailed diagnostics in optional evidence links when they do not affect the choice. Preserve precise terminology where it helps trace the decision, paired with a plain explanation.

| Technical term | Plain explanation for the decision |
| --- | --- |
| Generation fencing | After switching machines, old tools cannot act on the newly selected machine |
| Containing lease | The machine-use authorization already held by this work |
| Uncertain settlement | A command may have run, but its response was lost, so its result remains unconfirmed |
| Model-issued conformance | Have a real model call the tool once to establish that it actually works |
| Scope amendment | Change what this delivery promises and explicitly retain its limitations |
| JEV fallback | The dispatch-selection service is unavailable, so choose from the approved backup roster |
| Cross-ticket regression | A later feature broke behavior already completed and accepted earlier |

These examples demonstrate the writing method; they are not a mandatory vocabulary built into Dev Pipeline. Follow the target repository's language preference. Use a visible Job title when the Human must open or answer that session, after explaining the decision; opaque IDs are not human handles.

### Example: rewrite the #257 request

The following is an illustrative English version of the plain-language explanation; an actual request in Sprout uses Simplified Chinese.

> We wanted an Agent to receive the exact filename you put in a task and find the corresponding file, while still filtering sensitive machine addresses.
>
> Currently, the filter sometimes treats a dotted filename as a domain. If you write "Read report.final.pdf", the Agent may receive a replacement marker and lose the filename it needs.
>
> We added common file types, but encountered an ambiguity: installer.com can be a filename, while github.com is normally a website address. After "Read", the current text filter does not query the filesystem to establish which kind of name it received.
>
> The decision is whether explicit file-reading text should favor preserving the filename or filtering a possible domain.
>
> I recommend preserving the filename in that context. You can then refer to files such as installer.com normally. The accepted limitation is that a name such as github.com may also survive in the same context. Other address, path, and credential filtering retains its existing rules.
>
> The alternative is to continue filtering these ambiguous names. That keeps stricter filtering but prevents some valid filenames from reaching the Agent unchanged. We would need to accept that usage limitation or separately design a way to establish file identity.
>
> Please decide whether to accept file preference in this context together with the stated ambiguity. If accepted, we will update the requirement and tests, then continue acceptance. Unrelated work can proceed.

The request explains the product behavior and the accepted limitation. It does not ask the Human to evaluate suffix tables or interpret a review label.

### Check the explanation before sending it

The Agent publishing the question performs this check; an additional reviewer Job is unnecessary for each request.

- The original goal and relevant history are understandable without opening earlier messages.
- Established results, the current problem, and important uncertainty are explicit.
- The reason for Human involvement identifies a real choice or Human-only action.
- The recommendation has a basis, and feasible alternatives explain consequences.
- Necessary terms are explained; irrelevant implementation detail is available through links.
- The question has a specific scope and its answer enables an executable next step.
- Existing authorization has been checked to avoid repeating a settled question.

Tools may flag missing sections or references. Presence checks cannot establish that the explanation is clear or the causal reasoning is correct. If the Human says the request is unclear or asks for its background, rewrite the full explanation around the same decision instead of merely adding more options.

### Turn the reply into action and a durable decision

Define the requested authorization precisely before asking. A request to accept a named behavior and stated limitation is actionable; a vague request to "relax" leaves its scope uncertain.

After the reply, briefly state the interpretation and proceed within it. "Follow the recommendation" refers to the concrete recommendation just presented. Ask a follow-up only when the reply leaves a material ambiguity about behavior, authority, or risk. Do not make the Human reconfirm an already clear decision.

Retain the background, decision, rationale, accepted limitations, and affected work in the appropriate durable record. Future Agents should understand why the choice was made. Respect explicit instructions to keep incidental session guidance local; the Human's direction not to publish one transient provider comment is not a blanket ban on recording failure evidence.

Keep the waiting behavior aligned with the existing Job protocol: preserve the affected live session, hold it after it has actually posed its Human question, continue independent frontier work, and resume the affected assignment after the decision. Silence or elapsed time is not an answer.

### Initial adoption and verification

| Location | Proposed addition |
| --- | --- |
| Pipeline references/human-decisions.md | One shared source for the explanation sequence, option comparison, term explanation, sending checklist, and reply handling |
| Pipeline references/protocol.md | A context pointer triggered whenever a Job asks for a Human decision or Human-only action |
| Pipeline references/tasks.md | Apply the same communication practice to prototype feedback, product choices, and operational requests |
| Pipeline references/records.md | Retain background, decision, rationale, limitations, and affected work in decision records |
| Sprout development-loop.md | Identify project decision authority and how replies update Tickets, requirements, and dependencies |

Start by rewriting the historical #257, #249, and #252 requests. Evaluate whether each explanation lets a returning reader identify the original goal, observed problem, reason for Human involvement, recommendation's consequences, and exact decision without searching the journal. Use confusion follow-ups to improve the explanation, not to quiz the Human. Test the practice through prompts and records before adding mechanical enforcement. These are proposed changes, not communication files implemented by this retrospective.

### Keep status updates and infrastructure fallback readable

Status updates lead with what now works, what is blocked, what changed since the last update, and what decision remains. Link the technical ledger instead of reproducing it. For example: “Pi can now read, edit and test the remote workspace; Claude is in verification; Codex remote tool calls remain unproved.”

The dispatch decision service returned HTTP 451 for 26 consecutive rounds before the Human directed the session to stop using it. After a stable refusal, apply the existing configured fallback policy and record a retry trigger. If policy requires a Human exception, explain that specific choice once using the decision process above. Preserve the session-specific scope of the decision rather than making it a permanent global service bypass.

For substantial new work such as cross-platform sandbox replacement, explain the platform plan and options before changing the active scope. Routine work proceeds under existing authorization.

## Practices worth keeping

- **Independent merge and final scope review.** Passing suites did not reveal every semantic composition failure. Reviews found the dual-lease conflict, keepalive gaps, and the reintroduced Operations acquisition path. Keep composition review and cross-ticket provenance.
- **Truthful evidence levels.** Local authenticated fixtures were distinguished from deployed Workers, scripted denial from model-issued calls, and tool availability from invocation. Preserve these distinctions when accepting narrower milestones.
- **Authority separate from evidence.** Force Release or a Task lead override releases an allocation by authority; it does not prove unknown remote work stopped. This domain distinction survived implementation and is reusable beyond Host-run.
- **One shared execution and Operations seam.** Engine-specific tool translation reused shared binding, lease, epoch, operation, and recovery behavior. Preserve that direction as more engines arrive.
- **Incremental durable work.** The completion record reports eight provider stream failures with no committed work lost. Incremental commits preserved delivered changes; the lifecycle fix should additionally preserve live session context.
- **Precise pause/resume semantics.** The Human's pause stopped new dispatch while existing agents finished naturally; durable reconciliation continued. Keep dispatch pause separate from interruption and bookkeeping.
- **Explicit scope amendments.** Acceptance changed through named Human decisions, with non-claims retained. Keep that mechanism while moving recognition of specification conflicts earlier.

## Suggested adoption order

| Priority | Concrete action | Primary home | Evidence of improvement |
| --- | --- | --- | --- |
| First | Guard unfinished Job closure and bound automatic recovery | Dev Pipeline Job lifecycle | Premature closure requires a recorded disposition; quota and unknown failures notify the Orchestrator; retry budgets survive session/window changes; a completed FAIL review still settles |
| First | Carry project-defined constraints and verification through assignment, review, and integration | Generic Pipeline handoffs; project development loop, domain sources, and interfaces | Worker and reviewer share traceable context; clean merges run project-required checks; changed decisions trigger focused reassessment without project-specific Pipeline logic |
| Next | Route specification conflicts early and require an actionable basis for rework | Project readiness/replanning; existing Pipeline triage, records, and bounded diagnosis | A known conflict reaches a decision without speculative retries; uncertain attempts name new evidence; ordinary repairs remain direct and budgets are preserved |
| Next | Reuse production-path conformance predicates | Probe scripts and ticket templates | Exact model identity survives normal Agent creation; no-Environment success requires no lease |
| Next | Observe and streamline verification through #254 and the project test audit | Reporter/runner, durable observation records, project selection policy, and affected harnesses | All outcomes and retries are retained; final inventory is complete; selected protection follows impact; comparable measurements show improvement without lost regression value |
| Next | Include PR publication and explicit capability limits in completion reporting | Pipeline finish phase | Completion names the PR/state and the usable milestone without implying full Codex conformance |
| Next | Explain the situation and consequences before requesting a Human decision | Generic Pipeline communication reference and records; project decision authority | A returning reader understands the goal, problem, tradeoff, recommendation, and exact question without reconstructing the journal; clear replies proceed without repeated confirmation |
| Ongoing | Lead updates with usable progress and apply configured infrastructure fallback consistently | Orchestrator guidance and decision-service integration | Status is readable without Job/port ledgers; stable service refusal receives a bounded response with an explicit retry trigger |

The repository's existing whole-history triage and diagnosis rules should be reused. The highest-value additions are execution safeguards and reusable evidence tooling, not more copies of the same rules in `AGENTS.md`.
