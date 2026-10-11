# #225 / #226 ordering verdict and #225 implementation-readiness report

Ticket: #253 (`wayfinder:research`). Base: `master` at `2cea98f6`.
Scope: decide whether #225 (Host-run remote work) or #226 (OAR adoption) is orchestrated first, resolve #225's feasibility blockers, and assess the #227–#236 plan against the verdict.

All experiments below were bounded, local, and completed well within a 180-second timeout each. No model turn was performed, no service was started, no port was used, and no engine was installed or logged in. Nothing here is production acceptance.

## Evidence levels used

| Level | Meaning in this report |
|---|---|
| **source-only (repo)** | Reading this repository's code, ADRs, tests, and research at the pinned base. |
| **source-only (installed-version surface)** | Pinned installed-version CLI help, feature lists, and generated protocol schemas — surface facts, not behavior proofs. |
| **source-only (package)** | Pinned upstream package contents inspected without executing it. |
| **documentation-level** | Vendor documentation (current vendor CLI reference), not verified on this host. |
| **scripted** | Existing deterministic repository tests (pre-existing). |
| **protocol-level** | Protocol probes recorded in #225/#226 during specification (prior work; local disposable fixtures). |
| **model-issued** | A real model turn exercising the control. **None exists in this report — an explicit gap**, and it is exactly what #239, #248, #250, and #252 must produce. |

A local fixture at any level below model-issued is not a proven enrolled remote deployment, and nothing here claims one.

## Pinned versions

| Component | Pinned fact | Source |
|---|---|---|
| Pi CLI | `1.0.4`, installed on the engine host | installed-version (`pi --version`) |
| Codex CLI | `codex-cli 0.159.3`, installed on the engine host | installed-version (`codex --version`) |
| Claude Code CLI | **not installed** — no executable resolvable on this host (checked `PATH`, common local install locations, npm global prefix) | installed-version probe; explicit gap |
| OAR | candidate `0.35.0` (the version #226 pins for inspection); `0.36.0` is published but **not pinned** and was checked only to confirm the control surface did not change | package source |
| OAR runtime floor | `engines.node >= 24`; repository declares `>= 23`; host Node `26.x` satisfies both | package source / `package.json` |
| Sprout | `master` at `2cea98f6`, worktree branch `r225-ticket-253` | git |

## Reconciled placement assumptions

The specification assumption that "engine placement, working directory, native session storage, and work Environment are on the same host" holds only in the current Environment-hosted mode:

- **Current code (source-only, repo):** run admission resolves an `EnvironmentInstance` *before* the run is recorded (`src/run/orchestrator.ts`, `resolveEnvironmentInstance`), work options are admitted against that instance's facts, the engine process is spawned by the Worker with `cwd` inside the Environment workspace, and native session keys are stored under the identity `(agent, engine, environment instance, working directory)` (`src/run/session-key-store.ts`). Engine installation/auth/model readiness is probed through the Worker on the Environment host (`src/worker/readiness.ts`, `src/environment/readiness-workflow.ts`, ADR-0013 non-inference rules).
- **Host-run splits three of the four:** the engine and its session store move to the Sprout host; the working directory and files stay on the Environment host behind the enrolled Worker; the work Environment may be absent entirely for ordinary conversation. Consequences, all of which are #225 work and none of which depend on #226: a session-key identity without a mode/engine-host dimension cannot be reused across modes (#238); an admission path that never resolves an Environment must exist (#240); engine-host readiness must be measured on the Sprout host, separate from work readiness (#240); and the sandbox posture decision must stop being derived solely from the Environment's platform (`src/worker/engine-selection.ts` derives `danger-full-access` for containers — a rule that must not leak into host-run).

## Blocker matrix — #225 engine blockers

Classification vocabulary: **evidenced** / **resolvable through a named mechanism** / **decisively blocked** / **dependent on a named external prerequisite**.

| # | Blocker (per #253 acceptance) | Classification | Evidence (level) | Route notes |
|---|---|---|---|---|
| E1 | Pi tool replacement / restriction | **Resolvable through a named mechanism** | Pi `1.0.4` exposes `--no-builtin-tools`, `--tools <allowlist>`, `--exclude-tools <denylist>` (applies to MCP tools too), `--no-extensions`, `--no-mcp`, `--no-skills`, `--no-context-files` (installed-version surface, this report); prior protocol-level MCP register/use/withdraw evidence recorded in #225 | **Native route: named mechanism = argv tool policy at session construction + MCP registration + outer isolation.** OAR route at pinned candidate: `SessionOptions` has no tool member; the Pi opener keeps native tools and replaces only the builtin bash for its env overlay (package source, 0.35.0 and 0.36.0) — decisive as published, needs an upstream extension. Model-issued negative test remains #239. |
| E2 | Claude builtin exclusion / configuration-source control | **Dependent on a named external prerequisite** (Claude Code CLI installation + authentication on the engine host — absent on this host); native controls otherwise **resolvable through a named mechanism** | documentation-level: current vendor CLI reference documents `--tools` (restrict the builtin set; empty value disables all builtins), `--disallowedTools`, `--allowedTools`, and settings-source precedence; no installed CLI to verify against | Native route works once the Human installs/logs in (never auto-installed). OAR route as published is **decisively blocked**: its Claude opener passes only `-p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --dangerously-skip-permissions` plus session/prompt/MCP flags — no builtin exclusion, and permissions-skipped is dependency default, not Human authorization (package source). |
| E3 | Codex remote executor or restricted external tools | **Resolvable through a named mechanism** (native-first evaluation required by #248) | installed-version surface (this report): `codex exec-server` (standalone, `ws://`/stdio) with `exec-server forward --remote <URL> --environment-id <ID> --connect <URL>` registering a remote environment; `app-server --code-mode-host <URL>`; feature `code_mode_host` stable/enabled; sandbox policy set `read-only`/`workspace-write`/`danger-full-access`/external + Windows sandbox surfaces; `initialize` capability `experimentalApi`; prior protocol-level evidence recorded in #225 (restrictive feature controls, empty environment selection, standalone executor file RPCs, executor attachment, bound thread at 0.159.3) | The generated **non-experimental** `thread/start` schema has *no* environment/executor member, so the thread-binding step must be pinned through the experimental surface in #248 before production use; the spec-allowed fallback (restricted external-tool route with outer isolation) does not need it. OAR route: no executor member anywhere in `SessionOptions`; Codex posture only via process-global `OAR_CODEX_SANDBOX` (default `danger-full-access`) — per-session posture needs a runner hook, executor binding needs an upstream extension. |
| E4 | Host read/write isolation | **Resolvable through a named mechanism on macOS** (outer OS isolation profile around the engine process + engine controls, verified by negative sentinels); **dependent on an external prerequisite on Windows** (no Windows host verified in this ticket — explicit evidence gap) | prior protocol-level negative recorded in #225: a Codex `read-only` command read a temp file outside cwd — write-sandbox is not read isolation; repo source confirms no Sprout-owned OS isolation profile exists today; existing engine-side posture is Codex's own sandbox (source-only, repo) | Both routes need the same outer layer; neither substrate supplies it. macOS `sandbox-exec`-style profiles are deprecated-but-functional and must be proven, not assumed; Codex's `read-only`/`workspace-write` cover writes only; a Pi tool allowlist and cwd restriction are not read isolation; MCP servers spawned on the engine host also sit inside the profile. Precedes any host-run model turn (#240 depends on #239's accepted policy). Windows verification precedes only final production acceptance (#252). |
| E5 | Remote MCP origin and typed discovery | **Resolvable through a named mechanism** — new Sprout behavior, substrate-independent | engine-side attachment exists natively on all three (prior protocol-level Pi evidence; Codex `mcp_servers` config on `thread/start` in generated schema; Claude `--mcp-config` documentation-level) and via OAR `SessionOptions.mcpServers` (package source) | **MCP attachment is not builtin-tool exclusion** (see below). The decisive work is Sprout's: the Environment operations Module, Worker-side stdio launch in the remote workspace, origin-preserving HTTP connection, typed catalog registration, lease-gated startup (#241, #244, #245). Identical on both routes. |
| E6 | Safe binding changes | **Resolvable through a named mechanism** — new Sprout behavior | prior protocol-level Pi withdraw/re-register evidence; spec-declared fresh-session fallback; repo has no generation-fencing yet (source-only, repo) | Generation fencing, tool withdrawal, staged discovery, atomic publish live in Sprout at the existing engine seam (#246). OAR route has no per-session tool-set member, so a binding change there is dispose+reopen; re-verify, but it does not block native work. |
| E7 | Root-turn attribution | **Resolvable** for Pi/Codex native (existing final-answer-selection research + scripted tests, repo); **dependent on external prerequisite** for Claude (no install → #250 gap); on the OAR Claude route additionally **dependent on a named upstream prerequisite** (upstream Claude attribution issue #55, recorded open in #226) | source-only (repo): final-answer selection research and `src/engine/*` mapping tests; OAR declares per-runtime `AttributionTier` (package source) | Sprout's rule "one admitted run owns one root activation" already exists and stays authoritative on both routes. #226 already provides the bounded remedy for #55 (withhold the runtime until fixed or verified hook). |

## Blocker matrix — shared Sprout risks

| # | Risk | Classification | New Sprout behavior vs reusable guarantee |
|---|---|---|---|
| S1 | Conversation without a work Environment / lease | **Resolvable** — new behavior | **New:** an admission path that skips Environment resolution and leases entirely for Host-run conversation (today resolution is mandatory before the run record — source-only, repo). Nothing else changes: reply projection, identity, usage all reused. #240. |
| S2 | Separate host vs work readiness | **Resolvable** — mixed | **Reusable:** ADR-0013 non-inference rules, the single readiness-workflow trigger discipline, "unknown stays unknown". **New:** engine-host-scoped installation/auth/model/control facts on the Sprout host, reported independently from Worker readiness (host-local engine diagnostics are a partial precedent). #240. |
| S3 | Admitted mode and session identity | **Resolvable** — new behavior | **New:** durable mode + engine-host profile facts on runs/Tasks, mode-mismatch admission refusal, and a session-key identity partitioned by mode/engine/host (the current identity has no mode dimension — source-only, repo). **Reusable:** the session-key store seam itself. #237, #238. |
| S4 | Human Task authority | **Evidenced — reusable** | ADR-0006 authority, approval/begin, validation, discard, Force Release, Resume/Reopen semantics and their tests are unchanged; #225 only adds the mode-mismatch refusal on top (#238, #243). |
| S5 | Stale binding / Worker-epoch rejection | **Evidenced (epoch layer) + resolvable (per-operation layer)** | **Reusable:** enrollment-backed connections, epochs, revocation, recovery journal fencing (ADR-0012; gateway identity-epoch and revocation-recovery tests). **New:** per-binding generation numbers carried by every queued/parallel operation and enforced remotely (#241, #246). |
| S6 | Remote cancellation | **Resolvable** — new behavior over reusable distinctions | **Reusable:** Chat interrupt vs Task-linked stop vs pause semantics (ADR-0006), engine `interrupt()` at the EngineSession seam. **New:** remote descendant accounting and settlement inspection — **an accepted abort (native kill or OAR `abort()`) is not remote-stop proof**; only Worker-observed termination or an established fence releases protected work (#242, #247). OAR's own contract awaits native abort before its bounded shutdown helper and waits without a further limit after an accepted cancellation (#226 record) — host supervision is required either way. |
| S7 | Response loss after mutation | **Resolvable** — new behavior | **New:** durable operation identity, outcome inspection, conflicting-reuse rejection, no blind replay (#241, #242, #247). **Reusable:** Worker delivery journal for prompt/delivery correlation and the existing uncertain-outcome recovery language. |
| S8 | Protected leases, no replay after restart | **Evidenced — reusable** | ADR-0005 Task-held leases, orphaned-lease→recovering transition on restart, reconnect/retry durability tests (repo) all hold in both modes; #225 adds only mode-mismatch guards before execution-bearing resume (#238). |

**None of S1–S8 or E1–E7 is resolved only by #226.** Every blocker is either native-engine control surface, OS isolation, or substrate-neutral Sprout work.

## Decisive blockers → remedies (checkable acceptance, ownership, scope, precedence)

| Blocker | Concrete remedy | Checkable acceptance | Ownership | Scope | Precedes |
|---|---|---|---|---|---|
| D1 — Pi tool restriction (E1) | Native Pi argv policy: `--no-builtin-tools`/`--tools` allowlist restricted to approved remote MCP tools + `--no-extensions --no-skills --no-context-files`, inside the outer isolation profile of D4; MCP registration/withdrawal through the engine seam | #239's contract: model-issued turn on same-name host/remote fixtures; explicit host-sentinel read/write attempts denied by controls, not prompt; version/platform/policy recorded; unsupported paths declared | existing engine control (Pi CLI) + Sprout adapter argv construction | one adapter option block; no Core change | **Precedes #225's Host-run turns** (#240); does not precede #237/#238 and does not involve #226 |
| D2 — Codex execution origin (E3) | Evaluate native remote-environment/exec-server binding first at pinned 0.159.3 (`exec-server`, `forward`, `--code-mode-host`, experimental API), fall back to the spec-allowed restricted external-tool route under outer isolation; pin the accepted engine/executor version pair | #248's contract: model-issued command+patch affecting only the remote fixture; host sentinels unreadable/unchanged; no remote model-account login; shell, patch, filesystem tested independently | existing engine control (Codex) + Sprout adapter; upstream only if a native defect is found | bounded experiment first, then one adapter route | **Precedes #225's Codex slice** (#249); does not precede #225 start; independent of #226 |
| D3 — Claude exclusion + attribution (E2, E7) | (a) Human-side: install and authenticate Claude Code CLI on the engine host — never by Sprout; (b) native route: documented `--tools`/`--disallowedTools` + settings-source control under outer isolation; (c) OAR route: small verified hook/upstream extension to the Claude opener, plus upstream fix or bounded hook for attribution issue #55 | #250's contract: pinned CLI, model-issued turn through typed MCP, observed catalog after exclusion, host-sentinel denials, reproduced-or-bounded attribution race; a missing executable stays an unmet prerequisite | (a) Human/external prerequisite; (b) existing engine control; (c) upstream OAR change or explicit native exception | engine-specific; no Sprout core change | **Does not precede #225 start.** (a) precedes #250/#251; (c) precedes only an OAR-based Claude route (i.e., #226 scope) and, if OAR is never adopted, never applies |
| D4 — Host read/write isolation (E4) | Sprout-owned outer OS isolation profile around the engine process on the engine host (macOS first), layered over engine controls; negative-sentinel tests including read attempts | #239 acceptance (macOS/Pi), mirrored in #248/#250: host sentinels outside the runner area unreadable *and* unchanged under explicit prompts; profile + versions recorded | new Sprout behavior (host policy module) using existing OS primitives; no new scheduler | platform-scoped; one policy seam reused by all engines | **Precedes any Host-run model turn** (#240). Windows proof **precedes only final production acceptance** (#252), remains an explicit evidence gap until a Windows host is exercised |
| D5 — OAR route gaps (E1–E3 as published) | If and when #226 proceeds: one bounded upstream extension per missing control (Pi tool policy, Claude builtin exclusion, Codex per-session posture/executor), or an explicit native exception recorded with a removal/revisit trigger; runner-level `OAR_CODEX_SANDBOX` posture hook at minimum | #230's matrix: per-runtime mechanism, evidence level, platform scope, remaining gaps; refused-option honesty via OAR's `UnsupportedOptionError` surface | upstream OAR change / small Sprout runner hook / native exception | #226 only | **Precedes #231** (first production OAR run), **never precedes #225** |
| D6 — Remote operations, MCP origin, binding generations (E5, E6, S5–S7) | One deep Environment operations Module behind the existing Runtime/Worker seam: typed operation execution, durable operation identity, inspection, cancellation; binding generation fencing; Worker-side MCP launch with origin-preserving transport | #241/#242/#244/#245/#246/#247 scenario contracts: response loss never replays, stale generations never retarget, remote stdio never starts on the engine host, HTTP origin preserved, lease-gated startup | new Sprout behavior (shared Environment operations), substrate-neutral | shared across engines and both modes' remote paths | **Precedes the corresponding #225 tickets** (internal sequencing); no #226 dependency |

No remedy above is an unbounded future investigation, and none of them closes #225: **#225 still requires eventual real Pi/Codex/Claude model-issued work and platform acceptance (#239, #248, #250, #235-equivalent matrix in #252); this report waives none of it.**

## Native vs OAR routes for every decisive engine requirement (pinned versions)

Honesty statements kept explicit throughout:

1. **MCP attachment is not builtin-tool exclusion.** Both routes attach MCP (native engines directly; OAR through `SessionOptions.mcpServers`). Only exclusion/replacement controls close the second local work plane.
2. **Read-only writes/cwd are not host read isolation.** Codex `read-only` denies writes, not reads (prior probe read outside cwd); a tool allowlist and cwd constraint are not isolation either.
3. **An accepted abort is not remote-stop proof.** Native `interrupt()` kills the local engine process; OAR `abort()` is delivery of cancellation. Remote commands/MCP descendants stop only on Worker-observed termination or an established fence.

| Decisive requirement | Native route (pinned) | OAR route (pinned candidate 0.35.0; 0.36.0 checked, unchanged) | Verdict |
|---|---|---|---|
| Pi builtin-tool exclusion / restriction | **Available as CLI surface:** `--no-builtin-tools`, `--tools`, `--exclude-tools`, `--no-extensions`, `--no-context-files` (installed 1.0.4) | **Not exposed:** no `SessionOptions` tool member; opener embeds the Pi SDK (`@earendil-works/pi-coding-agent ^1.0.2`), keeps native tools, replaces only bash for env overlay, registers MCP via extension | Native stronger today; OAR needs an upstream extension. Exclusion proof is #239 either way |
| Pi typed MCP register/withdraw | Prior protocol-level evidence (SDK registration in one session) | `SessionOptions.mcpServers` (stdio + HTTP) attachable | Attachment exists on both — **not** exclusion |
| Claude builtin exclusion + settings-source control | Documentation-level flags exist (`--tools`, `--disallowedTools`, `--allowedTools`, settings sources); no installed CLI → gap | **Absent:** opener passes no exclusion flag and adds `--dangerously-skip-permissions` (dependency default, not authorization) | Native documented route once CLI installed; OAR needs upstream change; both unproven until #250 |
| Codex execution origin | **Available as experimental native surface:** `exec-server` (+ `forward` remote-environment registration), `--code-mode-host`, sandbox policies, `experimentalApi`; exact thread-binding method not in the non-experimental schema → pin in #248 | **Absent:** no executor/environment member; posture only via `OAR_CODEX_SANDBOX` (default `danger-full-access`); `approvalPolicy: 'never'` only | Native-first per #248; OAR needs runner hook (posture) + upstream extension (executor) |
| Per-session host posture | Adapter sets `sandbox` per thread (`read-only` default on shared host; container → full access) — existing behavior | Process-global env override only; defaults full-access | Native fine-grained; OAR requires runner scoping so concurrent sessions cannot affect each other (#226 already demands this) |
| Outer host read/write isolation | **Required regardless; not supplied by either** — new Sprout OS-isolation work (D4) | Same | Substrate-neutral |
| Remote MCP origin & typed discovery | Engines attach; origin/lease/typed behavior is Sprout's operations module | Same via `mcpServers` | Substrate-neutral; #244/#245 unchanged by adoption |
| Safe binding change | Pi withdraw/re-register (prior protocol evidence); fresh-session fallback declared | No per-session tool refresh; change = dispose + reopen | Native marginally better; both acceptable under spec's fresh-session clause |
| Root-turn attribution / final answer | Pi/Codex: existing Sprout selection + scripted tests; Claude: untested | Declared `AttributionTier` per runtime; Claude upstream issue #55 open; queue/steer/deliver surfaces Sprout must not expose as admission | Native Pi/Codex strongest; OAR Claude blocked on upstream attribution |
| Cancellation & termination evidence | Local kill + Worker-side accounting (new, D6) | `abort()` delivery; bounded-dispose caveats recorded in #226 | Equal: both need host supervision + Worker proof |
| Native session continuation | Keys via engine-native paths, stored under Sprout identity (needs mode partition, #238) | `resume` with runtime-native id; refuse-option honesty; adapter-held queue not durable for Pi/Claude | Equivalent; #233 verifies on the OAR route only |
| Readiness without inference | Worker probe workflow (ADR-0013) + host diagnostics precedent | Reuse per-runtime queries individually (spec) | Substrate-neutral |
| Platform/runtime floor | Node `>=23` today | Node `>=24`, pinned OAR version, Apache-2.0 obligations | Deployment note for #231/#235; not a #225 factor |

**Conclusion of the comparison:** for every *decisive* engine requirement, the native route on pinned installed versions exposes at least as much control as the OAR route, and for three requirements (Pi exclusion, Claude exclusion, Codex executor/posture) it exposes strictly more. OAR's value for #226 is reduced maintenance breadth for the *Environment-hosted* replacement — it is not a source of #225 controls. Therefore no #225 blocker resolves only through #226, and adopting OAR cannot precede the #225 proofs.

## Bounded experiments run (what they decided)

Each ran as a single command well under 180 seconds; all outputs sanitized of host paths and account facts.

1. **E1 — Pi control surface** (`pi --help` on installed 1.0.4): decided that native Pi *has* builtin exclusion/allowlist flags — the open question behind "Pi tool replacement or restriction". Level: installed-version surface. Not a behavior proof → #239 model-issued test still required.
2. **E2 — Codex control surface** (`codex app-server generate-json-schema` + schema queries; `codex features list`; `codex exec-server --help`/`forward --help`; `codex app-server --help`, pinned 0.159.3): decided that the native remote-environment/executor surface exists (standalone exec-server, remote registration, `--code-mode-host`) but its thread-binding step is not in the public non-experimental schema. Level: installed-version surface + protocol schema. → #248 pins the exact binding method.
3. **E3 — OAR control surface** (`npm pack @botiverse/oar@0.35.0` and `@0.36.0`, inspection only): decided the open question #226 itself left unresolved — "configuration or extensions may resolve these gaps". At both pinned candidates there is **no generic argv/config passthrough** in `SessionOptions`, no tool-exclusion member, no executor member, and the Claude/Codex openers carry permission-skipping/full-access defaults. Level: package source. → the OAR route for D1–D3 needs a bounded upstream extension/hook (D5), it cannot be assumed complete *or* impossible beyond what is shown.
4. **E4 — Claude documentation check** (vendor CLI reference): confirmed current flag names for builtin exclusion and settings sources. Level: documentation-level; installation/login remains a Human-side prerequisite.
5. **E5 — repository source reads** (admission, session-key store, readiness workflow, leases, epochs, final-answer research): established which shared risks are new behavior vs reusable guarantees. Level: source-only (repo).

**Why no model-issued experiment:** the ordering decision turns on whether the decisive controls *exist and on which route* — established above on pinned sources — and on whether any #225 step must wait for #226 — which none does. A model turn would not change that; its proper home is #239 (first Host-run turn), whose acceptance already requires model-issued negative host-access evidence before #240 runs. Recording this gap rather than simulating it is deliberate: **missing login/hardware/version support stays an explicit evidence gap, never a pass.**

## Ordering verdict

**#225 first.** Exact first executable ticket: **#237 — "Select immutable execution mode at service startup and show it in Settings."**

Opening slice (precisely named): **#237 → #238, with #239 running in parallel from the start**; then the Pi vertical #240–#247 while #248 proceeds on the shared origin fixture.

Reasons:

1. Every #225 blocker classification above resolves through native engine controls, OS isolation, or substrate-neutral Sprout work; none resolves through #226. #226-first would delay #225 by the entire OAR replacement program without unblocking a single blocker.
2. The substrate-independent #225 work is executable now at the existing seams (startup argument + immutable mode, durable placement facts, admission refusal) — evidenced by both specifications' shared statements and the repo's existing Runtime/Settings structure.
3. #226's rework concern (building native plumbing that OAR later replaces) is real only for *new production adapters*. It is handled by sequencing, not by delaying #225: the substrate decision (#230) must land before the Codex/Claude production integrations (#249/#251) finalize their route, while the Pi vertical and mode/placement work are substrate-neutral. If #230 later selects OAR, only the adapter layer is re-cut; the operations module, MCP origin work, binding generations, leases, and mode facts carry over — both specs already declare those shared.
4. Claude's missing installation is at the *end* of the #225 chain (#250/#251), so the external prerequisite shapes scheduling (install early enough to not gate #252) but cannot block the start.

### Real blocking edges

- #237 → #238 (durable mode/placement facts build on the startup seam).
- #239 → #240 (accepted isolated host policy before the first Host-run turn); #237 → #240 (mode recorded at admission).
- #240 → #241 → {#242, #244} → {#243, #246, #247} (Pi vertical: remote reads → edits/commands/MCP → Tasks/binding/recovery), with #245 after #244.
- #239's origin fixture → #248 (Codex proof reuses it) → #249.
- Claude CLI installation + login (external, Human-owned) → #250 → #251.
- #230 → #231 → … → #236 (OAR chain, unchanged internally).
- Advisory (rework guard, not a hard blocker): #230's substrate decision before finalizing the route inside #249/#251.
- **No edge from any #226 ticket into #237–#248.** #252 (final three-engine, two-mode acceptance) is last.
- On the #226 side: #227–#229 (OAR-delta prototypes) → #230; this report → #230 as the blocker/remedy input its current text wrongly expects to be a composite proof.

### Safely parallel work

- **#239 ∥ #237** immediately (different seams: engine-control experiment vs service startup).
- **#248** once #239's fixture exists — independent of the Pi vertical's Runtime work.
- **#227–#229** may run in parallel *if* #226 is pursued concurrently; they never block #225 and their results feed only #230/#231.
- Documentation/ADR/glossary updates accompanying #237/#238 ride along with those tickets.
- Human-side Claude installation can happen at any time; it is never on an agent's critical path.

## Assessment of the #227–#236 plan against the verdict

**Tickets still needed (for #226, on its own merits):** #230 (decision synthesis), #231–#236 (production replacement and acceptance). Their internal order is sound and untouched by this verdict.

**Overlapping experiments that can reuse this evidence:**

- #227 (Pi via OAR) overlaps #239 (Pi controls): the engine-control half is now answered at source level on both routes (E1, E3). #227 should be trimmed to the **OAR delta only** — does the OAR Pi opener preserve the accepted exclusion/MCP controls — reusing #239's shared origin fixture rather than rebuilding it.
- #228 overlaps #248 (Codex origin): E2/E3 already establish the native surface exists and OAR lacks it; #228's unique value is testing whether OAR's opener can carry an executor/posture hook at all.
- #229 overlaps #250 (Claude): both are blocked on the same external prerequisite (Claude installation/login); when unblocked, one pinned CLI run should be shared, with #229 adding only the OAR-opener delta (which source shows currently *skips permissions without exclusion* — a known-negative to verify).

**Obsolete assumptions:**

1. #230 expects "the composite enrolled-remote-Worker result from #253" and "the cross-host topology proof from #253" as its inputs. #253's actual acceptance is a decision, blocker matrix, and remedies — no composite build exists or was permitted. **#230 must consume this report instead**; the composite behavior evidence arrives later from #225's own #240–#247.
2. #230's recorded sequencing "minimal Codex/Pi replacement before #225's engine-dependent delivery" presupposes the pre-#253 OAR-first suggestion. The verdict reverses it: replacement follows or runs parallel to #225; it is not a blocker of it.
3. #226's "recommended order" note (prototype → replacement → #225) is superseded by this verdict; #226's own text already allows it ("OAR is a proposed foundation choice, not an intrinsic technical prerequisite of #225").
4. Any assumption that OAR's MCP attachment demonstrates remote-work readiness is refuted by inspection: attachment exists, exclusion does not.

**Minimum dependency changes required:**

1. #230: replace the two "#253 composite proof" inputs with this report (blocker matrix, remedies, route comparison); keep its go/no-go role for **#226-internal** routing only.
2. #230's sequencing bullet: record that substrate-independent and Pi-vertical #225 work proceeds first per this verdict.
3. #227–#229: add #239's shared origin fixture as a reusable input (or accept it as already satisfied by this report for the source-level halves); re-scope their acceptance from "prove engine controls through OAR" to "prove OAR preserves the controls proven natively".
4. No new prerequisite chain is created: no #226 ticket becomes a blocker of any #225 ticket, and this ticket creates none.

## Explicit evidence gaps (never passes)

1. **No Claude Code CLI on this host** — installation and authentication are Human-side prerequisites; all Claude claims here are documentation-level. Smallest remedy: Human installs and authenticates Claude Code on the engine host, then run #250.
2. **No model-issued turn in this report** — negative host-access, execution-origin, and remote-lifetime behavior are unproven until #239/#248/#250 run. Smallest remedy: those tickets, in order, on the pinned installed versions.
3. **No Windows evidence** — host-isolation and termination-fence verification on Windows remain open; they gate final acceptance (#252), not the start. Smallest remedy: one bounded Windows session exercising #239's contract.
4. **No enrolled remote deployment exercised** — all fixtures discussed are local; the enrolled-Worker remote path is proven only by pre-existing enrollment research and remains to be proven for Host-run inside #241/#242.
5. **Codex experimental thread-environment binding method not pinned** — the surface exists (CLI/protocol schema) but the exact binding request must be captured in #248 before it can be designed against.
6. **OAR upstream issue #55 open at inspection** — an attribution prerequisite for any OAR Claude route only.
7. **OAR 0.36.0 is not the pinned candidate** — inspected only to confirm no control-surface change; acceptance must pin one version (#226 already requires this).

## Repository checks

- `npm test` (180-second timeout): **tests 2310, pass 2310, fail 0** on the final run (`exit 0`); one intermediate run showed a timing flake in `worker-cli-recovery.test.ts` (#167 journal timing) which passed in isolation (5/5) and on the subsequent full run. Fresh-worktree dependency install was required first (`npm ci`).
- `npm run typecheck` (180-second timeout): clean (`exit 0`).
- This change is documentation-only; no code or test changes were needed beyond the standard checks above.

## References (primary, sanitized)

- #225, #226, #227–#236, #237–#252, #253 — tracker specifications and plan.
- ADR-0003, ADR-0004, ADR-0005, ADR-0006, ADR-0007, ADR-0012, ADR-0013 — placement, session keys, leases, authority, routing, enrollment, non-inference readiness.
- `src/engine/port.ts`, `src/engine/pi.ts`, `src/engine/codex.ts`, `src/run/orchestrator.ts`, `src/run/session-key-store.ts`, `src/worker/readiness.ts`, `src/worker/engine-selection.ts` — existing seams and behaviors.
- `docs/research/final-answer-selection.md`, `docs/research/codex-pi-non-inference-readiness.md`, `docs/research/codex-pi-usage-cost-telemetry.md` — prior engine research reused, not redone.
- Installed-version surfaces: Pi `1.0.4` CLI reference; Codex `0.159.3` generated app-server schema, feature list, `exec-server`/`app-server` CLI.
- `@botiverse/oar` `0.35.0` (candidate) and `0.36.0` (published) package contents: `contracts/session-options`, `contracts/session`, `runtimes/pi/open`, `runtimes/codex/{open,session}`, `runtimes/claude/launch`.
- Vendor Claude CLI reference: `--tools`, `--disallowedTools`, `--allowedTools`, settings-source precedence (documentation-level).
