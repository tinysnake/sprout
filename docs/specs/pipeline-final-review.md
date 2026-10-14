# Final review by default, with project-directed orchestration

Status: agreed requirements for separate implementation by the dev-pipeline and Sprout owners. This document specifies the intended change; it does not change the active workflow by itself.

## Problem

The current dev-pipeline runs an independent work–review loop for each implementation ticket, then reviews the assembled scope again. This repeats context acquisition, checks, verdict recording, and orchestration. Small corrections can trigger another complete ticket gate even when their impact is already understood.

Independent review remains valuable, especially for defects that automated checks miss. The default review boundary should be the assembled result of the selected scope. Projects must also be able to direct the orchestrator to insert earlier reviews or otherwise adjust execution without configuring a general risk classification system.

The responsibility boundary matters: dev-pipeline is a general-purpose pipeline. It must not know that Sprout has a document named `development-loop`, depend on that document's structure, or incorporate Sprout's product constraints into its defaults.

## Agreed decisions

1. Replace the default per-ticket work–review loop with **all work → final review**, followed by **repair → reassemble → final review** when needed.
2. Allow the orchestrator to adjust the default flow under project instructions, including inserting focused review jobs.
3. Keep project-specific review requirements and adjustment authority in the project. In Sprout, their authoritative home is `docs/agents/development-loop.md`.
4. Align work completion, dependency readiness, integration, review, and acceptance so the project workflow and the pipeline can execute together.
5. Keep the default usable without additional review-policy configuration.

## Default execution model

A scope is the bounded set of work selected for one pipeline run: for example, a spec and its implementation tickets. “All work” refers to that scope, not the entire repository or roadmap.

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

Worker checks and integration checks continue throughout execution. Independent ticket review is no longer a prerequisite for ordinary assembly. The integration branch is the place to compose work before final acceptance; merging into it is distinct from publishing the completed scope to the delivery target.

A blocked implementation remains unfinished. “All work” is not satisfied by declaring a blocked implementation complete. Research or prototype work may finish with a supported negative conclusion when its own acceptance permits that result.

## Responsibilities

| Owner | Deliverable | Responsibility boundary |
| --- | --- | --- |
| dev-pipeline | A complete default flow with final review and support for project-directed adjustments | General execution, review dispatch, findings, records, recovery, and lifecycle mechanics |
| Sprout | Project instructions compatible with that flow | Project acceptance, preserved constraints, additional review requirements, and orchestrator authority |
| Both owners | A verified end-to-end handoff | Consistent completion/dependency semantics and no duplicate mandatory gates |

## A. Requirements for the dev-pipeline owner

### A1. Make final review the default independent gate

- Execute and assemble ordinary tickets without spawning an independent reviewer for each ticket.
- Begin final review when the selected scope's required work is assembled and required checks have usable results. Do not require every ticket to have an independent review PASS before starting final review.
- Review the actual integration revision against scope requirements, applicable project instructions, work evidence, and composition behavior.
- Keep the independent final verdict separate from worker completion and the orchestrator's delivery checks.
- On FAIL, route findings to affected work and run the resulting repairs through assembly and final review. Repair tickets do not automatically acquire a separate ticket-review loop.
- Carry unresolved findings forward with stable identities. Re-review verifies their disposition, repair effects, and relevant regressions; expand inspection when the changed behavior justifies it.
- Retain bounded rework and exhaustion handling. Define how scope findings, repair attempts, and their budgets are attributed without relying on a preceding ticket-review round.

### A2. Open customization through project instructions

The generic contract is:

> This pipeline defines the default execution flow. The orchestrator may adjust work ordering, grouping, concurrency, and intermediate reviews under project instructions. Parts of the flow not adjusted by those instructions retain their default behavior.

- Use the project's existing instruction discovery mechanism. A project can use any document name or organization to express its policy.
- Require no new project policy file, configuration schema, risk matrix, or role taxonomy to use the default flow.
- Support focused intermediate review as an ordinary orchestrated job, including its scope, requirement sources, verdict, and continuation condition.
- Record material adjustments and their authority in durable run records so another orchestrator can resume the same plan.
- Apply an intermediate gate only to the work it governs; independent work can continue when its prerequisites permit it.
- Preserve the distinction between authority to adjust execution and authority to change requirements or permissions. A scheduling adjustment does not authorize changing acceptance.

The pipeline must not look up a special `development-loop` file or embed Sprout-specific criteria. This document's Sprout section is an assignment for the Sprout owner, not a dependency of the generic implementation.

### A3. Remove conflicting lifecycle assumptions

Define and preserve these distinctions in prompts, commands, records, and recovery:

| Fact | Meaning |
| --- | --- |
| Worker assignment complete | The assignment has a durable outcome and evidence; this alone is not a review verdict. |
| Work ready for assembly/dependent work | The relevant delivery checks and project-defined prerequisite conditions are met. An independent ticket PASS is not universally required. |
| Work assembled | Its changes are present in the recorded integration revision and required integration checks are accounted for. |
| Scope accepted | The composed requirements have passed final review and applicable project acceptance. |
| Scope delivered | The normal publication/merge and completion steps have succeeded. |

The implementation may reuse existing states and records. A new status framework is not a requirement. Issue closure must follow the project's semantics; it must neither falsely imply independent review nor prevent the default flow from progressing when ticket review is absent.

Audit every assumption that currently requires an accepted ticket before assembly, cleanup, or downstream dispatch. Include semantic merge resolution: continue resolving conflicts and checking the result, but a separate mandatory merge-review gate is no longer a generic default. Project instructions may insert one; final review still covers the assembled result.

Keep work and evidence recoverable after temporary worktrees are reclaimed. Recovery must distinguish pending final review from unfinished implementation and from completed delivery.

### A4. Keep outcomes and measurements honest

- Record a review PASS only when that review occurred.
- Separate implementation delivery, inserted-review verdicts, final-review verdicts, and repair attempts in outcome accounting.
- Preserve source attribution for measured model usage and outcomes. Do not generate synthetic ticket PASS records to satisfy existing selection, quota, or bootstrap bookkeeping.
- Ensure absence of a ticket-review verdict does not strand reservations, completion records, or worktree cleanup.
- On final FAIL, attribute findings and repairs to their supported scope; do not mark every contributing worker as failed merely because one composed requirement failed.

### A5. Align the whole pipeline

Update the default skill, review and integration references, dispatch/recovery instructions, generated prompts, record handling, and executable guards that encode the former loop. In the dev-pipeline repository, current starting points include `skill/SKILL.md` and `skill/references/{review,integration,protocol,records,diagnosis,models}.md`; inspect actual callers rather than treating this list as exhaustive.

Define a transition for active runs: preserve existing verdicts, completed work, attempt budgets, and ownership, and record adoption of the new flow before resuming. Do not silently reinterpret historical PASS records or restart completed work.

### Acceptance for assignment A

- **A-AC1 — Default:** A scope with dependent and independent implementation tickets reaches assembly and one final review without per-ticket reviewer jobs or extra review-policy setup.
- **A-AC2 — Repair:** A final-review FAIL produces attributed repair work, reassembly, and final re-review, without inserting ticket-review gates automatically. Exhaustion remains bounded.
- **A-AC3 — Customization:** A fixture project whose instructions use a different document name can request an intermediate review before a dependent job. The gate runs and controls that dependency; another project with no customization uses the default.
- **A-AC4 — Lifecycle:** Dependency readiness, issue handling, conflict resolution, completion records, cleanup, and resume work without synthetic ticket PASS records. A resolved merge can proceed to final review without a separate reviewer unless project instructions require one.
- **A-AC5 — Accounting:** Inserted and final reviews retain their actual outcomes and source attribution; missing ticket reviews do not leave phantom pending outcomes or reservations.
- **A-AC6 — Consistency:** No active default instruction or executable guard still requires the old per-ticket loop. Existing-run transition preserves history and pending obligations.

## B. Requirements for the Sprout owner

### B1. Align the project workflow with the new default

Update [the development control loop](../agents/development-loop.md) as the single source of truth for Sprout's process. Keep existing instruction pointers concise.

Specify how the orchestrator receives and checks a worker's delivery, determines whether dependent work can proceed, and records assembly before the scope's final review. State what closing a child issue proves and what remains for scope acceptance. Ordinary ticket handling must not recreate a fresh independent reviewer for every ticket or require final scope acceptance before downstream implementation can begin.

Retain truthful evidence, preserved behavior, requirement-change authority, unfinished-work handling, and research/prototype completion semantics. Reconcile the existing Accept, composition, re-evaluation, and diagnosis rules with the new timing of independent review.

### B2. Define Sprout's additional reviews locally

[ADR-0020](../adr/0020-defer-privacy-hardening-and-redaction.md) defers privacy hardening and content redaction to future work. Privacy-only gaps must not trigger mandatory intermediate reviews or block final acceptance in the current stage. Authentication, access permissions, Human authority, and execution/recovery safety retain their independent requirements.

Identify the project commitments that need independent review before particular downstream work or integration steps. Ground them in current project requirements and authoritative decisions rather than copying a new rulebook into the pipeline.

For each required insertion, make the trigger, review scope, blocking effect, and continuation evidence clear enough for the orchestrator to act. These are Sprout-owned requirements; the dev-pipeline owner does not select them.

A focused PASS establishes only the reviewed boundary. It does not substitute for final composed acceptance or turn unrelated suggestions into blockers.

### B3. Define the orchestrator's adjustment authority

The development control loop must explain:

- Which execution adjustments the orchestrator can make under existing authorization, including ordering, grouping, concurrency, and focused review jobs.
- Which changes require a project decision because they alter acceptance, product behavior, permissions, or an accepted limitation.
- How to record an adjustment's source, reason, affected work, and continuation condition using existing project/run records.
- How to notify affected active jobs when their instructions or governing decisions change, and how a replacement orchestrator resumes the adjusted plan.

Use existing records and navigation where sufficient. Routine authorized adjustments should not require repeated Human approval or new user configuration.

### Acceptance for assignment B

- **B-AC1 — Compatibility:** Sprout's instructions allow ordinary work to be checked, assembled, and used by downstream work before independent final review, with truthful issue and acceptance records.
- **B-AC2 — Local policy:** Sprout's required intermediate reviews have actionable project-owned triggers and continuation conditions. The generic pipeline needs no knowledge of their domain or document names.
- **B-AC3 — Authority:** The orchestrator can apply and resume authorized adjustments from durable records; requirement changes still follow Sprout's decision rules.
- **B-AC4 — No duplicate gates:** Project instructions, issue handling, test selection, composition checks, and final acceptance agree on what is required at each stage and do not accidentally restore the old loop.

## Joint verification and rollout

Deliver assignment A's generic capability before enabling Sprout's revised execution policy, or coordinate both changes so the active orchestrator sees one consistent set of instructions. Reviewers receive the requirements currently in force.

Verify these journeys together:

1. **Ordinary scope:** Multiple Sprout work items complete and assemble; downstream work proceeds under the revised project rules; independent final review precedes delivery.
2. **Project insertion:** A Sprout-defined condition inserts a focused review. Its affected downstream work waits for the required evidence, while independent work continues. Final review still examines the composed result.
3. **Repair and resume:** Final review finds a cross-ticket defect. The orchestrator routes and records the repair, resumes after a session interruption, assembles the correction, and obtains final review without duplicating ticket gates.

Both owners should provide evidence appropriate to their changes: executable regression checks for executable lifecycle/dispatch behavior, and concrete walkthroughs for instruction-driven behavior. Changes to runtime code require the repository's relevant checks. This requirements document alone does not require running the Sprout test suite.

## Scope exclusions

This change does not redesign model selection, quota policy, job transport, project product requirements, or Human decision authority. It does not introduce a general risk-scoring engine or a mandatory project customization format. CI and lint improvements identified during the retrospective are separate work.

The deliverable is a simpler general default plus project-directed orchestration, with independent review concentrated on the assembled scope and intermediate reviews added where the project directs them.
