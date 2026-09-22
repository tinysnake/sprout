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

Run the acceptance checks, post the work record, and leave the issue open for acceptance.

Completion criterion: every acceptance item points to evidence, and every deviation or newly discovered uncertainty is explicit.

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

Close the map only when its exit criteria are evidenced. Link that evidence to `docs/roadmap.md` and determine whether the current outcome is evidenced or needs another map. When an outcome is complete, recompute the outcome frontier and create a map for the next selected outcome.

After the current medium-term goal is evidenced, return to `docs/goal.md` and replace it with the next product horizon and supporting outcome graph. If the long-term success signals are all evidenced, report that result instead of inventing more work.

## Selection principle

Choose next work by this order:

1. Protect correctness and recoverability of existing work.
2. Resolve fog blocking the current end-to-end path.
3. Complete the nearest missing part of that path.
4. Expand to a second real adapter to validate a seam.
5. Add optimization and breadth only after the path is evidenced.

This ordering is judgement, not a numeric priority score. Record the reason in the map so the next evaluation can challenge it.
