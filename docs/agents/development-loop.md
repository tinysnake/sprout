# Development control loop

Use this loop to evaluate what Sprout should do next, assign work, define acceptance, and preserve implementation evidence. The loop turns the project goal into a sequence of replaceable, evidence-driven development maps.

This file is the single source of truth for the development process. `AGENTS.md`, the outcome map, and issue-tracker documentation may point here but must not restate this workflow.

## Sources of truth

Read these in order:

1. `docs/goal.md` — durable long-term product direction and success signals.
2. `docs/roadmap.md` — the current medium-term goal, its supporting outcome graph, and accepted evidence.
3. `CONTEXT.md` and relevant ADRs — settled language and hard-to-reverse decisions.
4. The active GitHub issue labelled `wayfinder:map` — the current short-term development map.
5. Child tickets and their work records — specifications and implementation evidence.
6. The repository and test results — the actual current state.

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

### Work record

On completing work, add this comment to its ticket:

```md
## Work record

### Outcome
What now works or what was learned.

### Triage
On a rework — an attempt following an acceptance failure on this ticket — state before changing anything: what you judge the actual problem to be, and why the previous attempt did not resolve it, based on every earlier work record and acceptance failure. Omit this section entirely on the ticket's first attempt.

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

The `### Triage` section is what keeps a rework from treating each acceptance failure as a fresh symptom. A rework that satisfies its findings without saying why the previous attempt failed has not shown it understood the problem, and the next acceptance is likely to fail the same way. This is the ticket-level counterpart to the escalation-exhaustion diagnosis in step 8: it is the worker's own reading of the history, not a separate diagnostic pass, and it neither amends acceptance nor creates tickets.

### Vocabulary

These terms are used by step 8 and by the coding pipeline that runs this loop automatically; they are process language, not Sprout product language, so they are defined here rather than in `CONTEXT.md`.

- **Rework triage** — the short section a rework's Work record must carry: what the worker judges the actual problem to be, and why the previous attempt did not resolve it, written after reading the prior work records and acceptance failures and before changing anything. It is the worker's own reading, not step 8's diagnosis.
- **Diagnosis** — the bounded root-cause analysis of a ticket that keeps failing acceptance: evidence for each applicable cause, then exactly one outcome.
- **Remediation** — the map, spec, or ticket set a diagnosis publishes when the real cause is larger than the ticket. It becomes a blocker of the paused ticket.
- **Paused ticket** — a ticket whose remediation must be completed first. It keeps its history and is neither closed nor re-opened while paused.
- **Amended acceptance** — the `## Acceptance` a diagnosis rewrites when the remedy is an over-strict or mis-scoped criterion. The amended list is what the next accept step verifies against; the original is preserved in the ticket's history.

### Verification commands

`npm test` and `npm run typecheck` are the standard evidence. `npm test` prints a
failure-only report, so a passing run is a short counter block and a failing run
adds only the failing tests with their reason and location. Do not paste a whole
passing run into a work record; quote the counters. When a large command output
is genuinely needed, filter it at the shell (for example `npm test 2>&1 | tail -40`)
rather than reading the whole log into context.

## Loop

### 1. Reconcile

Read the sources of truth and compare the map with the repository. Inspect linked work records when the map summary is insufficient.

Completion criterion: every material mismatch between the map and actual state is listed under `Baseline`, `Decisions so far`, or `Fog`.

### 2. Evaluate

Recompute the outcome frontier in `docs/roadmap.md`, then find the nearest unproven result needed by the selected outcome or current map exit criteria. One map may explore multiple independent frontier outcomes when doing so shortens the path to their shared dependent outcome.

- If a missing fact blocks planning, create a `research` ticket.
- If behaviour or an interface must be experienced, create a disposable `prototype` ticket.
- If a human decision blocks progress, create a `grilling` ticket.
- If the outcome and acceptance are known, create a production `task` ticket.
- Check `docs/references.md` for a mature equivalent design in a reference repository before planning implementation from scratch; when one exists, default to adopting it and note the reference in the ticket.

Prefer the smallest work that either reduces decisive uncertainty or completes an end-to-end slice. Do not create speculative implementation tickets behind unresolved fog.

Completion criterion: every proposed ticket contributes to the map outcome, has checkable acceptance, and contains no decision that belongs to an open prerequisite.

### 3. Build the frontier

Link tickets to the map and record dependencies. The frontier is the set of open, unassigned children with no open blocker.

Independent frontier tickets may run in parallel. Tickets sharing an unsettled interface or domain decision remain sequential until that prerequisite settles.

Completion criterion: each frontier ticket can be completed without guessing at another open ticket's answer.

### 4. Select and claim

Before starting new work, inspect claimed tickets for submitted work records awaiting acceptance. Otherwise select the first frontier ticket in map order and claim it.

- Apply `ready-for-agent` when an autonomous coding agent can satisfy and verify acceptance.
- Apply `ready-for-human` when hardware access, credentials, subjective judgement, or an external human action is essential.
- Apply `needs-info` when required reporter information is missing.

Completion criterion: exactly one worker owns the ticket, or the map explicitly exposes why no frontier exists.

### 5. Execute and record

Work only within the ticket outcome and constraints. If evidence invalidates the ticket, stop and record the deviation or new fog instead of expanding scope silently.

On a **rework** — an attempt after this ticket already failed acceptance — triage first: read every earlier work record on this ticket and every acceptance failure, including the exact unmet criterion, and state in the Work record what you judge the actual problem to be and why the previous attempt did not resolve it. Do this before making changes. Do not begin by working through the failures as a list of symptoms; that is what lets a fix satisfy its own criterion while leaving the shared cause in place. If the history does not cohere — a failure that keeps repeating, or one that contradicts an earlier attempt — report that rather than guessing.

Run the acceptance checks, post the work record, and leave the issue open for acceptance.

Completion criterion: every acceptance item points to evidence, and every deviation or newly discovered uncertainty is explicit. On a rework, the Work record's `### Triage` section states the judged problem and the evidence for that judgement.

### 6. Accept

Compare the outcome and evidence against each original acceptance item.

- If all pass, add an acceptance comment, close the ticket, and append its durable result to the map's `Decisions so far`.
- If any fail, comment with the exact unmet criterion and return the ticket to the appropriate ready state.
- If the result invalidates the map, update `Fog` and re-evaluate before assigning more downstream work.

Completion criterion: the ticket is either closed with evidence or open with a precise unmet acceptance condition.

### 7. Continue or re-evaluate

Run evaluation again when:

- the frontier is empty;
- all map tickets are complete;
- a work record adds new fog;
- evidence invalidates a decision or dependency;
- an acceptance failure reveals a design problem;
- `docs/goal.md` changes.

When a single ticket keeps failing acceptance past its repairs, do not just re-evaluate the map: diagnose that ticket (step 8) before assigning more work to it.

Close the map only when its exit criteria are evidenced. Link that evidence to `docs/roadmap.md` and determine whether the current outcome is evidenced or needs another map. When an outcome is complete, recompute the outcome frontier and create a map for the next selected outcome.

After the current medium-term goal is evidenced, return to `docs/goal.md` and replace it with the next product horizon and supporting outcome graph. If the long-term success signals are all evidenced, report that result instead of inventing more work.

### 8. Diagnose a ticket that will not pass

A ticket that fails acceptance repeatedly is not making progress, however many times it is repaired. When its repairs have climbed as far as the available capability goes and it still fails, stop repairing and diagnose: the question is no longer "how do we satisfy this acceptance" but "why does this acceptance keep failing".

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

A diagnosis is bounded: one per ticket. A repair that follows a diagnosis and then fails again goes to a human rather than back to another diagnosis.

Completion criterion: the ticket carries an attribution with evidence and exactly one outcome; a fix-on-ticket plan is recorded (with any acceptance amendment) and the ticket returned to step 5; a build-first remediation exists as its own tracker item and is a blocker of the paused ticket; a human-decides ticket is left with a precise question and no work outstanding.

## Selection principle

Choose next work by this order:

1. Protect correctness and recoverability of existing work.
2. Resolve fog blocking the current end-to-end path.
3. Complete the nearest missing part of that path.
4. Expand to a second real adapter to validate a seam.
5. Add optimization and breadth only after the path is evidenced.

This ordering is judgement, not a numeric priority score. Record the reason in the map so the next evaluation can challenge it.
