# Development control loop

Use this loop to evaluate what Sprout should do next, assign work, define acceptance, and preserve implementation evidence. The loop turns the project goal into a sequence of replaceable, evidence-driven development maps.

This file is the single source of truth for the development process. `AGENTS.md`, the outcome map, and issue-tracker documentation may point here but must not restate this workflow.

> **Adoption status — not yet in force.** This revision introduces the default flow where independent review concentrates on the assembled scope. The generic pipeline that runs this loop still gates each Ticket, and this revision takes effect only when the pipeline's final-review default lands. Until then the active loop continues to gate each Ticket as the pipeline requires; the default execution model, required reviews, and adjustment authority below describe the intended state, not the currently executing one.

## Sources of truth

Read these in order:

1. `docs/goal.md` — durable long-term product direction and success signals.
2. `docs/roadmap.md` — the current medium-term goal, its supporting outcome graph, and accepted evidence.
3. `CONTEXT.md` and relevant ADRs — settled language and hard-to-reverse decisions.
4. The active GitHub issue labelled `wayfinder:map` — the current short-term development map.
5. Child tickets and their work records — specifications and implementation evidence.
6. The repository and test results — the actual current state.

Privacy scope for current work, review, and acceptance is governed by [ADR-0020](../adr/0020-defer-privacy-hardening-and-redaction.md). Privacy hardening and content redaction are future work. Do not initiate or expand privacy-only features or tests, insert privacy-only review gates, or block assembly, dependent work, or delivery on a privacy-only gap. Authentication, access permissions, Human authority, and execution/recovery safety retain their independent requirements. Earlier privacy requirements do not reactivate through a preservation clause or milestone.

The goal is not a backlog. The outcome map is not a fixed sequence of tasks. A development map is a temporary hypothesis about how to evidence one frontier outcome. Replace it when evidence changes that hypothesis.

## Artifacts

### Outcome map

`docs/roadmap.md` is the bridge between the long-term goal and short-term development maps. It contains dependency-linked, observable outcomes rather than implementation tasks.

An outcome becomes frontier work when all of its dependencies are evidenced. Each completed development map contributes evidence to one or more frontier outcomes, and one outcome may require several successive maps. Revise unproven outcomes whenever implementation evidence changes the expected path.

### Development map

Keep at most one open issue labelled `wayfinder:map`. Its body has:

```md
## Outcome
Which coherent step toward one or more frontier outcomes in docs/roadmap.md this map advances.

## Baseline
What the repository can do now, with pointers to evidence.

## Decisions so far
- Decision or learned fact — #ticket or ADR link

## Fog
- An uncertainty that prevents responsible task planning

## Work graph
- [ ] #ticket — why it is on the current path

## Exit criteria
- Observable conditions that end this map

## Re-evaluate when
- Evidence or events that invalidate the current plan before the work graph is empty
```

`Decisions so far` is the compressed construction history. Link to detailed work records instead of copying them into the map.

### Ticket

Every child ticket uses exactly one type label:

- `wayfinder:research`
- `wayfinder:prototype`
- `wayfinder:grilling`
- `wayfinder:task`

```md
Part of #map
Blocked by: #ticket, #ticket

## Goal contribution
The goal outcome or map uncertainty this work advances.

## Outcome
The observable result this ticket must produce.

## Acceptance
- [ ] A checkable behaviour, answer, or decision
- [ ] Required verification evidence

## Constraints
Facts and settled decisions the worker must preserve.

## Non-goals
Nearby work deliberately excluded from this ticket.
```

Write acceptance in terms of observable outcomes, not implementation steps. A ticket is ready only when a worker can distinguish success from partial completion without inventing a product decision.

Write `## Constraints` as statements of preserved behavior, not as a copied rulebook. Each applicable constraint names the behavior to preserve, its current authoritative source, and its verification:

```md
## Constraints

- Preserve: <the behavior this work must retain>
  Source: <current spec, ADR, or approved decision>
  Verification: <existing check, or the evidence this ticket must add>
```

Keep the full rule in its authoritative source; the ticket carries the pointer and the check, not a copy of the project's decision history. For a small change with no relevant shared behavior, one sentence saying so is enough.

### Work record

On completing work, add this comment to its ticket:

```md
## Work record

### Outcome
What now works or what was learned.

### Triage
On a rework — an attempt following an acceptance failure on this ticket — state before changing anything: what you judge the actual problem to be, and why the previous attempt did not resolve it, based on every earlier work record and acceptance failure. When that judgment is uncertain, add:

#### Next attempt
- Unmet criterion: <exact criterion and source>
- Current explanation: <judgment supported by prior evidence>
- Change or experiment: <what this attempt will do differently>
- Expected observation: <how the result confirms or rejects the explanation>

Omit this section entirely on the ticket's first attempt.

### Evidence
- Tests, commands, observed behaviour, screenshots, or source links

### Changes
- Commit, files, ADR, or other durable output

### Deviations
- Differences from the ticket and why

### New fog
- Newly exposed uncertainties, or `None`

### Follow-ups
- Suggested work, without silently adding it to the active plan
```

The record reports evidence; it does not redefine acceptance after implementation.

The `### Triage` section is what keeps a rework from treating each acceptance failure as a fresh symptom. A rework that satisfies its findings without saying why the previous attempt failed has not shown it understood the problem, and the next acceptance is likely to fail the same way. This is the ticket-level counterpart to the escalation-exhaustion diagnosis in step 8: it is the worker's own reading of the history, not a separate diagnostic pass, and it neither amends acceptance nor creates tickets. An ordinary fix with a known cause needs only a short statement of the correction and the expected behavior. An uncertain retry must name the new variable or observation it will introduce; if the environment, method, and observations are unchanged, do not dispatch another implementation attempt — route the failure instead (step 7).

### Unfinished handoff

A session that claimed a ticket may end without posting its Work record: the process can die, the context can be exhausted, or the session can stop for a reason no observer can classify. That is an unfinished handoff, and it is neither completion nor proof the work is lost.

Before the session context is discarded, preserve what exists:

- the branch and commits produced so far, and the workspace state;
- evidence already gathered (test runs, probes, links), prepared under the repository/issue-tracker publishing hygiene in `AGENTS.md`;
- the ticket's current state and the exact unmet acceptance condition, when it is known;
- an explicit note that no completion claim was posted — a missing Work record is recorded as missing, never inferred from pane state or silence.

Replacing or abandoning the worker requires a recorded disposition — process loss, context exhaustion, cancellation, or a deliberate decision — and unfinished work is captured before disposal. Do not repeatedly prompt a stopped session merely to obtain a completion record it may be unable to produce.

Distinguish assignment completion from acceptance: a reviewer that submits a FAIL verdict has completed its assignment, while a worker reporting unmet acceptance still has work outstanding. A ticket whose claiming session ended unfinished stays open; the next claimant reads the handoff record before acting and continues from the preserved branch and evidence rather than reconstructing the context from scratch.

### Decision requests

Before asking the Human anything, establish whether a decision is actually needed:

- cause unclear, information missing, or results contradicting one another → investigate what is available here first; distinguish established results from remaining uncertainty;
- requirements clear but implementation or verification fails → diagnose and repair under existing authorization;
- the blocker is credentials, hardware access, or another Human-only action → explain the purpose and give precise action instructions, not a choice;
- the same decision was already answered → proceed under that authorization; ask again only after a material change.

A decision request is needed only when feasible alternatives require choosing product behavior, investment, or an accepted limitation. Prepare it as a self-contained explanation — a reader returning from an absence must understand it without reconstructing the session history:

1. **Original goal** — the observable behavior that was wanted.
2. **Current progress** — what already works and which results are established.
3. **Problem and cause** — trigger, observed behavior, consequence; evidence and hypotheses stated separately.
4. **Why a Human decision is needed** — the actual tradeoff or authority, and why ordinary implementation cannot choose it. Authority follows Acceptance change in step 8: verification corrections stay within existing authorization; changes to product commitments require the project's designated decision-maker.
5. **Recommendation and alternatives** — for each feasible choice, what it enables, what limitation or risk it accepts, and how current work changes; only feasible choices, with measured cost or an explicit note that cost is unknown.
6. **Exact decision** — one concrete question, the scope of the answer, and what happens afterward; which independent work continues meanwhile.

Explain necessary technical terms through their effect on behavior, files, actions, and results; link the technical ledger instead of reproducing it. Scale the explanation to the decision's complexity — a simple question can combine parts, but a complex one keeps the causal explanation.

Before sending: check that the original goal and problem are understandable without opening earlier messages, that the recommendation is grounded, that the question has a specific scope whose answer enables an executable next step, and that existing authorization has not already settled it. If the Human says the request is unclear, rewrite the whole explanation around the same decision rather than only adding options.

After the reply, state the interpretation briefly and proceed within it; ask a follow-up only when the reply leaves a material ambiguity about behavior, authority, or risk. A reply that changes acceptance, constraints, or dependency edges updates the affected unfinished tickets and assignments through step 7's change notice. Record the decision, its rationale, accepted limitations, and affected work in the durable record — the map's `Decisions so far` or the ticket — so future readers understand why. Silence or elapsed time is never an answer.

### Vocabulary

These terms are used by step 8 and by the coding pipeline that runs this loop automatically; they are process language, not Sprout product language, so they are defined here rather than in `CONTEXT.md`.

- **Rework triage** — the short section a rework's Work record must carry: what the worker judges the actual problem to be, and why the previous attempt did not resolve it, written after reading the prior work records and acceptance failures and before changing anything. When the cause is uncertain it carries a `Next attempt` block naming the new variable or observation. It is the worker's own reading, not step 8's diagnosis.
- **Diagnosis** — the bounded root-cause analysis of a ticket that keeps failing acceptance: evidence for each applicable cause, then exactly one outcome.
- **Remediation** — the map, spec, or ticket set a diagnosis publishes when the real cause is larger than the ticket. It becomes a blocker of the paused ticket.
- **Paused ticket** — a ticket whose remediation must be completed first. It keeps its history and is neither closed nor re-opened while paused.
- **Amended acceptance** — the `## Acceptance` a diagnosis rewrites when the remedy is an over-strict or mis-scoped criterion. The amended list is what the next accept step verifies against; the original is preserved in the ticket's history. The amendment distinguishes a verification correction that retains the product commitment from a change to the commitment itself, which requires the project's designated decision-maker.
- **Decision request** — a self-contained, six-part explanation ending in one concrete question with an explicit scope, used when feasible alternatives require choosing product behavior, investment, or an accepted limitation. It is distinct from `needs-info` (missing reporter information) and from step 8's *a human decides* outcome (a diagnosis's conclusion).

### Lifecycle distinctions

These are the states of work in this loop and in the coding pipeline that runs it. They keep assignment completion, readiness, assembly, acceptance, and delivery from being conflated.

- **Worker assignment complete** — the assignment has a durable outcome and evidence; this alone is not a review verdict.
- **Ready for assembly and dependent work** — the relevant delivery checks and this file's required-review conditions are met; an independent ticket PASS is not universally required.
- **Work assembled** — its changes are present in the recorded integration revision and the required integration checks are accounted for.
- **Scope accepted** — the composed requirements have passed final review and applicable project acceptance.
- **Scope delivered** — the normal publication/merge and completion steps have succeeded.

### Verification commands

`npm test` and `npm run typecheck` are the standard evidence. `npm test` prints a
failure-only report, so a passing run is a short counter block and a failing run
adds only the failing tests with their reason and location. Do not paste a whole
passing run into a work record; quote the counters. When a large command output
is genuinely needed, filter it at the shell (for example `npm test 2>&1 | tail -40`)
rather than reading the whole log into context.

## Default execution model

A **scope** is the bounded set of work selected for one development pass: a map or spec and the tickets that implement it. Independent review concentrates on the assembled result of that scope, not on each ticket. This is the only meaning of "scope" used for the work selection; elsewhere in this file "review scope" names the boundary a single review covers, and "scope-level findings" are findings about the assembled scope rather than a second kind of scope.

```text
Select scope
    ↓
Execute work in dependency order, with parallel work where possible
    ↓
Run required checks and progressively assemble the integration branch
    ↓
Independent final review of the assembled scope
    ├─ PASS → deliver through the normal publication/merge process
    └─ FAIL → route findings → repair affected work → reassemble
                                                    ↓
                                             final review again
```

Worker checks and integration checks continue throughout execution; the final review does not replace them. The integration branch is where work is composed before final acceptance, and merging into it is distinct from publishing the completed scope to the delivery target. A blocked implementation remains unfinished; "all work" is not satisfied by declaring it complete. A research or prototype ticket may finish with a supported negative conclusion when its own acceptance permits that result.

The default requires no additional review policy. A project may direct an earlier or focused review under its own instructions; in Sprout those insertions are exactly the required reviews below.

## Required independent reviews

[ADR-0020](../adr/0020-defer-privacy-hardening-and-redaction.md) defers privacy hardening and content redaction to future work. Privacy-only gaps must not trigger mandatory intermediate reviews or block final acceptance in the current stage. Authentication, access permissions, Human authority, and execution/recovery safety retain their independent requirements.

Sprout requires four focused reviews in addition to the final review of the assembled scope. They are Sprout-owned requirements; the generic pipeline neither selects them nor knows their domain. A review is triggered when a change alters a listed behavioral boundary and downstream work or delivery will rely on it; merely touching a related file does not trigger a gate. Ground each review in the current authoritative decision, including approved amendments and accepted limitations.

| Commitment and source | Trigger | Review scope and continuation evidence | Blocking effect |
| --- | --- | --- | --- |
| **Human, Agent, and Worker authority** — [ADR-0006](../adr/0006-task-authority-and-lifecycle-outcomes.md), [ADR-0009](../adr/0009-self-hosted-operation-and-recovery-promises.md), [ADR-0012](../adr/0012-production-workers-use-enrollment-backed-outbound-connections.md) | Changes to Task approval, advancement, validation or recovery permissions; Project/WG access; Worker enrollment, revocation or command authorization. | Verify authorization at the side-effect boundary. Require executed evidence that permitted actions work and unauthorized actions are refused without effects, including relevant membership changes, revocation and stale connection epochs. | Before dependent work consumes the changed authority contract or the affected path is delivered. |
| **Leases, recovery, and unfinished work** — [ADR-0005](../adr/0005-task-held-environment-lease.md), ADR-0006, ADR-0009 | Changes to lease acquisition/release, Task/Run settlement, disconnect/reconnect, Force Release or workspace/context cleanup. | Verify that nested Run settlement preserves the Task lease; interruption, timeout and restart do not silently replay work or select another Environment; uncertain remote outcomes remain protected under recovery. Exercise relevant failure and cleanup paths and verify that persistent Project work survives. | Before dependent execution uses the changed lifecycle or an affected Environment becomes reassignable under it. |
| **Engine, Host-run, Worker, and MCP execution boundaries** — ADR-0012, [ADR-0017](../adr/0017-durable-execution-placement.md) as amended by [ADR-0018](../adr/0018-host-run-tasks-retain-task-environment-lease.md), [ADR-0019](../adr/0019-project-mcp-tools-run-on-the-environment-worker.md), and the affected route's current approved acceptance | Adapter additions/replacements or changes to tool admission, configuration sources, execution placement, workspace bindings, session ownership or transports. | Verify actual execution origin, granted tools and binding/session ownership; exercise stale-tool or stale-session refusal and relevant failure paths without unauthorized local, model or Environment fallback. Prove bounded startup, interruption and close where affected. Keep model-issued, protocol-only, scripted and source-only evidence distinct. | Before downstream work relies on the new route, it becomes a production default, or the affected path is delivered. |
| **Durability, migrations, and idempotency** — ADR-0009, [ADR-0007](../adr/0007-message-and-wake-routing-semantics.md), and affected storage/operation contracts | Changes to schema migrations, transaction boundaries, operation identities, reply projection, recovery retries or routing deduplication. | Exercise relevant crash, partial-commit, lost-response and retry cases. Verify recoverable durable facts, migration atomicity and absence of duplicate remote execution, projected replies or wakes; preserve unknown outcomes where execution cannot be established. | Before dependent work consumes the changed storage/operation contract or a migration is applied to data that must be retained. |

Record each insertion's source, reason, reviewed revision, scope, affected downstream/integration step, verdict and continuation evidence in the existing ticket or run record. Block only the named dependent use or delivery step; independent work and assembly needed to produce the review revision may continue. Overlapping triggers may share one focused review. Ordinary presentation changes and local refactors that preserve these boundaries remain under final review.

When a cited decision is superseded or amended — for example the Task/WG and lease changes tracked by the active development map — the row's source pointer updates in the same change, and the boundary contract is re-grounded rather than silently dropped.

A focused PASS requires evidence for the changed boundary and its relevant rejection/recovery paths; a green suite alone does not establish that an unexercised path works. It establishes only the reviewed boundary and revision, not final composed acceptance. Reassess that verdict when subsequent changes affect the reviewed behavior. Unrelated suggestions do not become blockers, and approved requirement changes or accepted limitations must not be silently reversed by a reviewer.

## Orchestrator adjustment authority

The flow in this file is the default. The orchestrator may adjust execution under existing authorization when the adjustment is scheduling or composition only:

- reordering or grouping work;
- changing concurrency;
- inserting a focused review job required by this file or requested under existing authorization;
- choosing where in the flow an existing required step runs, provided its evidence is still produced.

Every material adjustment is recorded with its source, reason, affected work, and continuation condition in an existing durable record — the map's `Decisions so far`, the ticket, or the run record — so a replacement orchestrator can resume the same plan. Affected active assignments receive an explicit change notice through step 7 when their governing decision changes.

A change that alters **acceptance, product behavior, permissions, or an accepted limitation** is not an execution adjustment. It follows the project's decision rules (Decision requests above; step 8 acceptance amendments), normally with the Human as the designated decision-maker. Authority over execution never implies authority to change requirements.

## Loop

### 1. Reconcile

Read the sources of truth and compare the map with the repository. Inspect linked work records when the map summary is insufficient.

Completion criterion: every material mismatch between the map and actual state is listed under `Baseline`, `Decisions so far`, or `Fog`.

### 2. Evaluate

Recompute the outcome frontier in `docs/roadmap.md`, then find the nearest unproven result needed by the selected outcome or current map exit criteria. One map may explore multiple independent frontier outcomes when doing so shortens the path to their shared dependent outcome.

- If a missing fact blocks planning, create a `research` ticket.
- If behaviour or an interface must be experienced, create a disposable `prototype` ticket.
- If a human decision blocks progress, create a `grilling` ticket whose body follows the Decision requests structure below.
- If the outcome and acceptance are known, create a production `task` ticket.
- Check `docs/references.md` for a mature equivalent design in a reference repository before planning implementation from scratch; when one exists, default to adopting it and note the reference in the ticket.

Prefer the smallest work that either reduces decisive uncertainty or completes an end-to-end slice. Do not create speculative implementation tickets behind unresolved fog.

Before declaring a ticket ready, run a readiness check on high-risk acceptance: acceptance that depends on external engines, platforms, installations, or authorization; requires evidence that a prohibited behavior did not occur; or combines preservation and rejection rules that may conflict. For each such criterion, the ticket must state:

- the concrete input, conditions, and expected result that must be proved;
- which authorized production interface can express the required action;
- what observation distinguishes success, failure, and an action that never occurred;
- the smallest missing prerequisite — research, prototype, installation, authorization, or decision.

A mismatch between the required proof and the available interface is resolved by an authorized change to the verification or by an explicit prerequisite ticket; the ticket is not ready until it is resolved, and missing evidence stays missing until then. This is a targeted check for high-risk acceptance, not a checklist for every small change.

Completion criterion: every proposed ticket contributes to the map outcome, has checkable acceptance, and contains no decision that belongs to an open prerequisite.

### 3. Build the frontier

Link tickets to the map and record dependencies. The frontier is the set of open, unassigned children with no open blocker.

Independent frontier tickets may run in parallel. Tickets sharing an unsettled interface or domain decision remain sequential until that prerequisite settles. Also check whether neighboring tickets affect the same settled behavior: shared settled rules support parallel work, while conflicting redefinitions must be resolved before dispatch.

Completion criterion: each frontier ticket can be completed without guessing at another open ticket's answer.

### 4. Select and claim

Before starting new work, inspect claimed tickets for submitted work records awaiting acceptance. Otherwise select the first frontier ticket in map order and claim it. Reconcile the ticket's relevant constraint sources against the current integration state rather than reusing the original ticket breakdown unchanged.

- Apply `ready-for-agent` when an autonomous coding agent can satisfy and verify acceptance.
- Apply `ready-for-human` when hardware access, credentials, subjective judgement, or an external human action is essential.
- Apply `needs-info` when required reporter information is missing.

Completion criterion: exactly one worker owns the ticket, or the map explicitly exposes why no frontier exists.

### 5. Execute and record

Work only within the ticket outcome and constraints. If evidence invalidates the ticket, stop and record the deviation or new fog instead of expanding scope silently.

On a **rework** — an attempt after this ticket already failed acceptance — triage first: read every earlier work record on this ticket and every acceptance failure, including the exact unmet criterion, and state in the Work record what you judge the actual problem to be and why the previous attempt did not resolve it. Do this before making changes. Do not begin by working through the failures as a list of symptoms; that is what lets a fix satisfy its own criterion while leaving the shared cause in place. If the history does not cohere — a failure that keeps repeating, or one that contradicts an earlier attempt — report that rather than guessing.

For applicable constraints, record the preserved behavior and its evidence in the Work record, or the conflict and its cause. A required rule change goes through the decision/replanning process; the worker does not redefine a settled rule to make its change fit.

Run the acceptance checks, post the work record, and leave the issue open for acceptance.

Completion criterion: every acceptance item points to evidence, and every deviation or newly discovered uncertainty is explicit. On a rework, the Work record's `### Triage` section states the judged problem and the evidence for that judgement.

### 6. Accept

Compare the outcome and evidence against each original acceptance item. Verify both the ticket's new behavior and the relevant existing behavior named in its constraints; a passing test that expects behavior contrary to an approved rule is evidence of a conflict to resolve, not acceptance.

Closing a child issue proves that the ticket's own acceptance and evidence are met. It does not assert an independent review verdict, and it does not mean the scope is accepted. Under the default flow a ticket may be accepted and closed without any independent ticket review; independent review happens on the assembled scope (see Default execution model). Downstream work proceeds once the ticket is ready for assembly and dependent work, not once the scope has passed final review. Closing the issue does not waive a required independent review: if the change triggered one of the reviews above, that review must still complete before the downstream use or delivery it governs.

- If all pass, add an acceptance comment, close the ticket, and append its durable result to the map's `Decisions so far`.
- If any fail, comment with the exact unmet criterion and return the ticket to the appropriate ready state.
- If the result invalidates the map, update `Fog` and re-evaluate before assigning more downstream work.

Completion criterion: the ticket is either closed with evidence or open with a precise unmet acceptance condition.

A research or prototype ticket may conclude with supported feasibility, a proven blocker, or a named prerequisite when its acceptance defines those as valid findings. An implementation ticket does not complete merely because its route is blocked: record what has been ruled out, the blocking condition, its smallest remedy, and the executable alternative that does not depend on that route; keep the ticket unfinished, link the prerequisite work as a blocker, and continue independent frontier work. Do not turn a research or prototype acceptance into an implicit requirement to deliver the complete production feature.

### 7. Continue or re-evaluate

Run evaluation again when:

- the frontier is empty;
- all map tickets are complete;
- a work record adds new fog;
- evidence invalidates a decision or dependency;
- an acceptance failure reveals a design problem;
- `docs/goal.md` changes.

When a decision changes, update the affected unfinished tickets and dependency edges, and send an explicit change notice to assignments already running under the old decision.

Before assigning another implementation attempt after an acceptance failure, route the failure by the work its evidence supports:

- implementation defect with a clear expectation → normal rework;
- defective probe, fixture, or observation → repair the verification while preserving the behavioral requirement;
- one decisive missing fact → the smallest bounded research or experiment that answers it;
- unavailable installation, authorization, or external prerequisite → record the blocker and a concrete resumption condition;
- requirements demanding incompatible outcomes under the same available conditions → a specification or product decision through this loop, without spending another implementation round;
- repeated repairs with uncertain attribution → the step 8 diagnosis.

Cite the evidence for the route and retain uncertainty where attribution is incomplete. A demonstrated specification conflict is decided, not repaired; an ordinary defect with a known cause still proceeds directly to proportionate rework.

A final-review FAIL is routed through the same judgement. Findings are attributed to the work and requirements they support, repair work is dispatched to the affected tickets or created as bounded repair tickets, and the corrected result is reassembled and re-reviewed. A repair does not automatically acquire its own ticket-review gate. One composed requirement failing does not mark every contributing worker as failed.

Scope repair is bounded by the pipeline's repair-attempt budget. Sprout keeps no second budget for the repair → reassemble → re-review cycle: the pipeline's counters and attribution govern, and when that budget is exhausted the scope stops for a human decision instead of looping between repair and re-review.

When a single ticket keeps failing acceptance past its repairs, do not just re-evaluate the map: diagnose that ticket (step 8) before assigning more work to it.

Close the map only when its exit criteria are evidenced. Link that evidence to `docs/roadmap.md` and determine whether the current outcome is evidenced or needs another map. When an outcome is complete, recompute the outcome frontier and create a map for the next selected outcome.

After the current medium-term goal is evidenced, return to `docs/goal.md` and replace it with the next product horizon and supporting outcome graph. If the long-term success signals are all evidenced, report that result instead of inventing more work.

### 8. Diagnose a ticket that will not pass

A ticket that fails acceptance repeatedly is not making progress, however many times it is repaired. When its repairs have climbed as far as the available capability goes and it still fails, stop repairing and diagnose: the question is no longer "how do we satisfy this acceptance" but "why does this acceptance keep failing".

Scope-level findings from the final review are not this step: they are attributed to their supported requirements and repaired through step 7, and they require neither per-ticket diagnosis nor a ticket-review round.

This is the automatic coding-pipeline path (Dev Pipeline's escalation-exhaustion diagnosis); when working the loop by hand, treat the same signals — a ticket whose rework has run out of stronger workers, or whose budget is spent — as the trigger.

The diagnosis reads the whole ticket history, not the latest attempt: every work record, every acceptance failure and its exact unmet criterion, and every deviation or new fog it produced. It attributes the repeated failure to whichever of these actually applies, with evidence:

1. the work was not good enough, or genuinely defective;
2. the acceptance or its verification is too strict, or tests the wrong thing;
3. the acceptance asks for more than this ticket's stated goal;
4. the surrounding design, not the change, is what makes every attempt fail;
5. the evidence does not settle it and a human must decide.

Then it chooses one outcome, and only one:

- **fix on this ticket** — the diagnosis is smaller than the ticket. Record the ordered plan on the ticket, amend its `## Acceptance` directly when that is the remedy, and return to step 5. Tell the next accept step which acceptance is in force. A ticket whose acceptance was narrowed is verified against the amended acceptance, not the original.
- **build something first** — the diagnosis is larger than the ticket. Create the remediation as a map, a spec, or an explicit ticket set, link it as a blocker of this ticket (`Blocked by:`), record the pause on the ticket, and work the remediation first. The paused ticket keeps its history; it is not closed and not re-opened. When the remediation is resolved, resume the ticket.
- **a human decides** — record the question and leave the ticket for a human.

An acceptance amendment records its authority. Correcting a fixture, observation method, or predicate that retains the product commitment follows existing project authorization; reducing support, changing behavior or permissions, or accepting a new risk requires the project's designated decision-maker, normally the Human. Record the change on the ticket:

```md
### Acceptance change

- Previous requirement: <text or revision reference>
- Replacement: <new requirement>
- Reason and evidence: <why the change is justified>
- Authority: <decision or applicable project authorization>
- Commitments retained: <what still must be proved>
- Affected work: <tickets, probes, or reviews needing updates>
```

Workers and reviewers receive the same revised acceptance, and the previous version is retained for audit. Unproved items remain explicitly unproved. A diagnostician may propose changes within granted authority; it cannot remove a parent specification's commitment by rewriting a child ticket. Affected unfinished tickets are updated through step 7's change notice.

A diagnosis is bounded: one per ticket. A repair that follows a diagnosis and then fails again goes to a human rather than back to another diagnosis.

Completion criterion: the ticket carries an attribution with evidence and exactly one outcome; a fix-on-ticket plan is recorded (with any acceptance amendment) and the ticket returned to step 5; a build-first remediation exists as its own tracker item and is a blocker of the paused ticket; a human-decides ticket is left with a precise question and no work outstanding.

## Composition of settled slices

Independently accepted slices can still fail when they first meet. When completed slices first combine use of the same resource, authority, or lifecycle, verify one coherent path through their composition before treating integration as complete. Prefer existing high-level test interfaces and expand only to the affected behavior. A clean merge is not evidence of correct composition, and a full independent repository review is not required by default.

Composition verification is part of assembly and final review rather than an extra mandatory reviewer gate. When a change alters one of the required-review boundaries above, that focused review covers the boundary instead. Otherwise a resolved merge proceeds to final review without a separate reviewer.

Before integration is recorded complete, compare the assignment's captured constraint sources with current project decisions. If relevant behavior changed, reassess the implementation and evidence first; formatting-only source changes do not invalidate dependent work.

## Selection principle

Choose next work by this order:

1. Protect correctness and recoverability of existing work.
2. Resolve fog blocking the current end-to-end path.
3. Complete the nearest missing part of that path.
4. Expand to a second real adapter to validate a seam.
5. Add optimization and breadth only after the path is evidenced.

This ordering is judgement, not a numeric priority score. Record the reason in the map so the next evaluation can challenge it.

## Stage gates and non-blocking findings

When a map has an explicitly approved early-use milestone before its full outcome, name both milestones and their acceptance evidence in the map. Early-use evidence does not close the full outcome or silently satisfy a later ticket's acceptance. Amend affected ticket acceptance and dependency edges explicitly before assigning work under the new plan.

Classify each finding by **impact on the next real operator journey**, not by the presence of a bug or a severity label alone:

- **Blocking**: a broken required journey; a credible breach of authentication, access permissions, Human authority, or execution authority; possible loss, duplication, or unsafe reassignment of unfinished work; an unobservable or misleading failure that prevents safe correction; or a regression that defeats the milestone's stated evidence. Stop and fix or narrow the milestone transparently. An uncertain impact in these categories is blocking until investigated.
- **Non-blocking defect or risk**: an edge case outside the milestone's required journey with bounded, known impact, no credible path to the blocking categories, and a usable workaround or explicit limitation. Open a linked issue with reproduction or evidence, affected scope, impact, workaround/limitation, and a proposed revisit trigger. It does not block unrelated frontier work or the early-use milestone merely because the issue is open.
- **Deferred breadth or polish**: privacy hardening and content redaction under ADR-0020, or a capability, state matrix, visual refinement, or broader platform check not promised by the early-use milestone. Keep its original full-outcome ticket or create a bounded follow-up; do not describe it as implemented or evidenced.

At acceptance, record the classification and links in the work record or acceptance comment. Reassess a non-blocking finding if it occurs on the real journey, recurs, compounds with another issue, loses its workaround, or changes impact. Do not mark an unmet original acceptance criterion as passed: amend the criterion before work proceeds, split out a follow-up, or leave the ticket open. The full outcome still requires its own checks and Human acceptance.
