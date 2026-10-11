# Resolve #225 feasibility blockers and decide the orchestration order for #225 and #226

Proposed replacement text for #253. GitHub writes failed during preparation; this document does not claim that the live issue or its blocking relationships have been updated. Intended labels: `ready-for-agent`, `wayfinder:research`.

Intended scheduling: #253 has no blockers and runs before selecting either feature's orchestration. The OAR-specific prototype chain begins at #227 only when #253's verdict selects it; #227 waits for #253. Later OAR substrate acceptance in #230 follows the necessary engine prototypes and reuses the ordering verdict. Neither parent specification is rewritten by this decision ticket.

## Parent

Part of #225. One prerequisite decision ticket shared by #225 and the OAR integration in #226.

## Goal contribution

Resolve the uncertainties that prevent the Human from choosing whether to orchestrate Host-run remote work (#225) or OAR replacement (#226) first. This ticket can start immediately: it does not depend on #227–#229 or require the OAR production migration to exist.

## What to build

Produce one evidence-backed implementation-readiness report for #225 and one concrete orchestration recommendation. Investigate the required Pi, Codex and Claude controls against both the existing native integration routes and OAR. Use bounded disposable experiments only for facts that determine feasibility or ordering; reuse existing research and probes rather than making a full three-engine Host-run implementation the prerequisite for deciding where to start.

The result must identify the actual #225 blockers, their workable resolution mechanisms and the smallest work that should run next. Recommend #225 first, #226 first, or a precisely named minimal slice followed by the other feature; explain the genuine blocking edges and where independent work can proceed. Do not presume the previously suggested OAR-first order is correct.

A decision is incomplete if it merely lists risks, tells the Human to run all existing prototype tickets, or says both features need more investigation without identifying the decisive missing fact and its smallest remedy.

## Acceptance criteria

- [ ] Read the complete #225 and #226 specifications, existing engine/Worker/Runtime behavior, relevant ADRs and current research/probe evidence. Reconcile assumptions that engine placement, working directory, native session storage and work Environment are on the same host.
- [ ] Produce one blocker matrix for #225. Cover Pi tool replacement/restriction, Claude builtin exclusion/configuration sources, Codex remote executor or restricted external tools, host read/write isolation, remote MCP origin and typed discovery, safe binding changes, and root-turn attribution. Classify each as evidenced, resolvable through a named mechanism, decisively blocked, or dependent on a named external prerequisite.
- [ ] Cover the shared Sprout risks as well as engine controls: conversation without a work Environment/lease; separate host versus work readiness; admitted mode and session identity; Human Task authority; stale binding/Worker-epoch rejection; remote cancellation; response loss after mutation; protected leases and no replay after restart. Identify which require new Sprout behavior and which existing guarantees can be reused.
- [ ] Compare the native and OAR route for every decisive engine requirement on pinned versions. State exactly what OAR exposes, what requires a small verified hook/upstream extension, and what remains native work regardless of adopting OAR. MCP attachment is not builtin-tool exclusion; read-only writes/cwd are not host read isolation; an accepted abort is not remote-stop proof.
- [ ] Run the smallest bounded experiment needed to distinguish competing routes where existing primary-source/probe evidence cannot decide. Verify execution-origin/negative-host-access or remote lifetime/authority behavior only to the extent it changes the ordering decision. Reuse current probes or a disposable injected Runtime/engine/Worker harness. Report source-only, scripted, protocol-level and model-issued evidence separately; a local fixture is not a proven enrolled remote deployment.
- [ ] For each decisive blocker, give a concrete remedy and its checkable acceptance, ownership and scope: existing engine control, small Sprout compatibility hook, shared Environment operations behavior, upstream change or explicit native exception. Make clear whether the remedy must precede #225, #226 or only the final production acceptance of one engine. Do not leave it as an unbounded future investigation.
- [ ] Deliver one explicit ordering verdict with reasons and the exact first executable ticket or minimal slice, real blocking edges and safe parallel work. Do not require full OAR engine/platform coverage before #225 unless evidence establishes that dependency. If a hard external prerequisite prevents a decision, identify it precisely and give the executable path that remains available without pretending unsupported work is ready.
- [ ] Assess the existing #227–#236 plan against the verdict: identify tickets still needed, overlapping experiments that can reuse this evidence, any obsolete assumptions, and the minimum dependency changes required. Existing prototype tickets are downstream options, not prerequisites of this investigation. Do not create another speculative multi-ticket prerequisite chain to answer this ticket's question.
- [ ] Preserve #225's required eventual Pi/Codex/Claude real-work and platform acceptance. A feasibility verdict, source inspection or disposable experiment cannot close #225, certify production Host-run execution or waive unsupported engine controls.
- [ ] Save a single sanitized English report and publish a compact Work record with the blocker matrix, named remedies, ordering verdict, first executable work and evidence limits. Run the repository standard checks only if code changes warrant them; every command/experiment has an explicit timeout of at most 180 seconds. Missing login, hardware or version support remains explicit rather than passed.

## Constraints

Use the existing Runtime Message/Task admission Interface as the highest test seam, with existing EngineAdapter/EngineSession and Worker seams for focused probes. Do not introduce a new scheduler or production execution graph to investigate a planning decision. Source facts must come from primary references or pinned installed-version behavior.

Preserve Human authority, Project access, leases, enrolled Worker authentication/epochs, existing Environment-hosted behavior, host-local engine credentials, origin-local remote MCP credentials, truthful usage and diagnostics privacy. Do not silently enable full-access defaults, automatically install/login engines, replay uncertain mutations or treat runner exit as termination of remote work.

This is one bounded research/decision ticket. It may use disposable targeted prototypes; it does not require all of #225 to be implemented or all three engines to pass the full production journey before an ordering recommendation can be made. Unproved production facts must remain visible in the recommendation.

## Blocked by

None (can start immediately).

## Non-goals

Production delivery or full release acceptance of #225 or #226; implementing the complete remote operations/MCP system; broad OAR runtime migration; finishing #227–#229 as a prerequisite; changing parent specifications or closing parent issues; creating a replacement scheduler or another general research program.
