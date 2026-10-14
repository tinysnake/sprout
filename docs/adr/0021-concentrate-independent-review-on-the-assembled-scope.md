---
Status: accepted, not yet in force — activation waits for the pipeline's final-review default
---

# Independent review concentrates on the assembled scope

> **Adoption:** this decision is agreed but not activated. It takes effect together with the generic pipeline's final-review default; until then the pipeline still gates each Ticket and the revised flow is not the currently executing one. The Sprout-side implementation carries an "Adoption status — not yet in force" banner for the same reason.

Sprout's development loop assembles a scope's work and then runs one independent final review over the assembled result, followed by repair, reassembly, and re-review when it fails. The previous default ran an independent work–review loop for every ticket before assembly, repeating context acquisition, checks, verdict recording, and orchestration; small corrections could trigger another complete ticket gate even when their impact was already understood.

A **scope** is the bounded set of work selected for one development pass: a map or spec and the tickets that implement it. Worker checks and integration checks continue throughout execution. Independent ticket review is no longer a prerequisite for ordinary assembly, and a ticket may be accepted and its issue closed without an independent review verdict. Issue closure proves that the ticket's own acceptance and evidence are met; it does not assert an independent review verdict and does not mean the scope is accepted. Scope acceptance follows the final review of the recorded integration revision and applicable project acceptance.

## Required reviews

Besides the final review of the assembled scope, Sprout requires four focused reviews, defined with their triggers, scope, continuation evidence, and blocking effect in `docs/agents/development-loop.md`:

- **Human, Agent, and Worker authority** — ADR-0006, ADR-0009, ADR-0012.
- **Leases, recovery, and unfinished work** — ADR-0005, ADR-0006, ADR-0009.
- **Engine, Host-run, Worker, and MCP execution boundaries** — ADR-0012, ADR-0017 as amended by ADR-0018, ADR-0019, and the affected route's approved acceptance.
- **Durability, migrations, and idempotency** — ADR-0009, ADR-0007, and affected storage/operation contracts.

A review triggers when a change alters a listed behavioral boundary and downstream work or delivery will rely on it; merely touching a related file does not. It blocks only the named dependent use or delivery step, and a focused PASS establishes only the reviewed boundary and revision, not final composed acceptance. Overlapping triggers may share one review. When a cited decision is superseded or amended, the row's source pointer is updated in the same change rather than left stale.

These are Sprout-owned requirements. The generic dev-pipeline defines the default flow and supports project-directed adjustments, but it neither selects these reviews nor knows their domain or document names.

## Orchestrator authority

The orchestrator may adjust ordering, grouping, concurrency, and focused review jobs under existing authorization, recording each material adjustment with its source, reason, affected work, and continuation condition in an existing durable record. Changes to acceptance, product behavior, permissions, or an accepted limitation are not execution adjustments and follow the project's decision rules, normally with the Human as the designated decision-maker.

## Authority and coordination

Authority: the project owner's approval of `docs/specs/pipeline-final-review.md` and its assignment to the Sprout owner. This decision is implemented in `docs/agents/development-loop.md` and coordinates with the dev-pipeline's default-flow change; the active workflow changes only once both are in force. Historical work records and PASS verdicts are preserved, not reinterpreted.
