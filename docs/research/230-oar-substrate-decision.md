# #230: OAR Substrate Decision for the Minimal Replacement and #225

**Ticket:** #230 (`wayfinder:research`)
**Run scope:** `r226` (parent spec **#226**)
**Role:** `explorer` (decision and evidence synthesis only; no vendor-control implementation)
**Base commit:** `e8b692fc5` (integration HEAD carrying #227, #228, and #229)

---

## 1. Executive Summary & Verdict

This decision artifact synthesizes the prototype outcomes from **#227** (Pi via OAR), **#228** (Codex via OAR), **#229** (Claude via OAR), and the completed evidence chain from **#225** (#237–#252, specifically #253's ordering verdict and #252's composition results) into **one authoritative, versioned execution-substrate decision**.

### The Core Verdict
1. **Single Shared Adapter Confirmed:** Sprout adopts **one shared `OarEngineAdapter`** (`src/engine/oar.ts` or equivalent) parameterized by runtime identity, capability, and host policy. It preserves the existing `EngineAdapter`/`EngineSession` seams (`src/engine/port.ts`, `src/engine/pi.ts`) and enforces per-session supervised runner processes. No OAR Session types or raw records leak into Core, durable records, or Worker protocols. No per-runtime adapter wrapper classes or second vendor transports are permitted.
2. **Current Placement Retained:** Placement remains **Environment-hosted** for this slice. Core gains no native process-spawning rules or direct vendor transports. Host-run placement remains governed strictly by #225. Host-local credentials remain unexposed.
3. **Pi Route — Conditionally Viable for Environment-hosted Replacement:** OAR 0.35.0 is viable for an Environment-hosted Pi replacement using a controlled extension loader/settings hook to restrict tools to authorized fixtures and deny host sentinels. However, unmodified OAR lacks standard `tools`/`noTools` options and launches MCP stdio on the engine host. Furthermore, OAR session disposal awaits native abort without bound, and `promptAndWait` waits indefinitely for settlement; external process-group supervision is an external scripted remedy rather than proof of remote operation settlement. Production adoption remains blocked pending an upstream policy hook or runner-level loader wrapper, plus an OAR-specific termination and settlement acceptance check. Native Host-run Pi remains governed by #225.
4. **Codex Route — Blocked from OAR Adoption; Retains Bounded Native Exception:** Unmodified OAR 0.35.0 lacks typed executor binding (`thread/start` environments), dynamic tool callback dispatch, and per-session sandbox isolation. Codex retains a named **`CodexNativeSeamException`** using Sprout's native app-server/exec-server integration (`src/engine/codex.ts`). The OAR Codex route is blocked until upstream exposes these controls.
5. **Claude Route — Strictly Blocked from Production Host-run by this Issue:** While #229 demonstrated local feasibility with custom launch wrappers (including pre-dispatch native Agent rejection), Claude remains blocked from production Host-run adoption by #230. It requires Human CLI installation/authentication, upstream resolution or a projection hook for attribution issue #55, and resolution of remaining unproved loader boundaries.
6. **Sequencing and Governing Order (Reconciliation of AC7 and #253 Verdict):**
   - **Source Conflict Reconciliation:** Ticket #230 AC7 and #226 `Relationship to #225` require minimal Codex/Pi replacement *before* "#225's engine-dependent delivery", while `docs/research/225-226-ordering-verdict.md:165-173` (#253) noted that replacement does not gate or block #225. Per the project decision path (Human adjudication), AC7's phrase **"#225's engine-dependent delivery" is read as the subset of #225 that directly depends on the engine substrate**, rather than #225 as a whole.
   - **Governing Order:** The minimal Codex/Pi (Environment-hosted) replacement strictly precedes #225's engine-dependent delivery; substrate-independent #225 work (startup parsing, durable placement facts, shared Environment operations Module per #237–#238) and the Pi Host-run vertical proceed in parallel and are never blocked. Unrelated engine coverage (such as future Claude Host-run production support) follows both.
   - **Boundaries Preserved:** This ordering does not amend or close #225, does not make broad runtime migration a blocker of #225, and upholds the independence of both scopes.

---

## 2. Input Correction: Real Artifacts Replacing Stale "#253 Composite Proof"

Ticket #230's acceptance criteria 1 and 2 referenced "the cross-host topology proof from #253" and "#253's go/no-go evidence for … enrolled remote operation/MCP origin …".

**Correction recorded:** As documented in #253's own Work record:
> *"#253 delivers a decision and blocker matrix, not a composite build; #230 must consume this report instead, with composite behavior evidence arriving later from #240–#247."*

Because the entire #225 chain (#237–#252) has now closed, #230 consumes the **actual authoritative evidence artifacts**:
- `docs/research/225-226-ordering-verdict.md` (#253 ordering verdict, blocker matrix E1–E7, S1–S8, decisive remedies D1–D6, and native-vs-OAR comparison).
- `docs/evidence/ticket-252-host-run-composition.md` (the closed #252 composition result: live verified Pi baseline/Task lifecycle, Claude no-env/test lifecycle, and Codex zero-tool-call reality).
- `docs/research/host-run-engines-remote-environment-tools.md` (#241 Environment operations design).
- `docs/research/codex-claude-host-run-remote-work-compatibility.md` and `docs/research/claude-native-remote-diagnostic.json`.
- The three OAR engine prototypes:
  - `docs/research/oar-pi-origin-prototype.md` (#227)
  - `docs/research/oar-codex-origin-prototype.md` (#228)
  - `docs/research/oar-claude-origin-prototype.md` and `docs/research/oar-claude-rework2.md` (#229)

---

## 3. Versioned Matrix Across Runtimes and Dimensions

### Evidence Level Discipline
Evidence classes are strictly separated:
- **Model-issued:** Observed tool callbacks and verified resource effects from an actual model turn.
- **Protocol-only:** Real SDK/wire/catalog observations without a real model exercising the feature.
- **Scripted:** Deterministic builder checks, OS sandbox probes, or synthetic test harnesses.
- **Source-only:** Direct inspection of package source, schemas, or CLI help.

*A weaker evidence class never inherits the standing of a stronger class. A local fixture is never an enrolled remote deployment.*

### Pinned Versions
- **OAR:** `@botiverse/oar` **0.35.0**, commit `8adde16fe2d12ae54af7d4dff86c3f224380a5c7`. *(Upstream drift finding: latest upstream is 0.58.0; no floating upgrade permitted.)*
- **Pi:** SDK / CLI **1.0.4** (with harness at 1.1.0; Node >= 24 required).
- **Codex:** `codex-cli` **0.159.3**; native executor 0.159.3.
- **Claude Code:** CLI **2.1.294**; executable SHA-256 `def0d15e64dd7d89621f88d28214f885b1c38b0ddd69762fb8593e34915d6d53`.
- **Host OS / Node:** macOS 27.0.1, Node 26.11.1 (satisfies OAR Node >= 24 floor).

### Matrix

| Runtime | Dimension | Evidence Level | Platform Scope | OAR 0.35.0 Status | Gap / Limitation | Remedy / Prerequisite |
|---|---|---|---|---|---|---|
| **Pi** | **Lifecycle & Supervision** | Model-issued (turn completion) / Source-only (unbounded abort & post-abort wait) / Scripted (process-group supervision) | macOS | Blocked / Unproved (OAR lifecycle) | Native abort and post-abort wait (`promptAndWait`) are unbounded in source; local process-group kill (140s/170s) does not prove remote operation stopped. Remote cancellation/fencing remains unproved in #227. Native Host-run recovery in #252 is partial and does not supply OAR evidence. | Bounded checkable acceptance: run an OAR-specific abort/hung-close scenario verifying the runner deadline takes effect, followed by either Worker-confirmed remote operation termination or a protected recovery state with lease retained and no replay; otherwise the OAR lifecycle route remains blocked. |
| **Pi** | **Instructions & Cwd** | Protocol-only | macOS | Conditionally Viable | Cwd trusted on host; ambient extensions loaded from agent dir. | Isolate agent dir in scratch location with controlled settings.json. |
| **Pi** | **Host Restriction / Tool Exclusion** | Model-issued (denial) / Protocol-only (catalog) | macOS (`sandbox-exec`) | Blocked as published | `SessionOptions` lacks `tools`/`noTools`; bash replaced only for env overlay. Native tools remain. | Upstream or runner-level loader hook setting `defaultTools`, `setActiveTools`, and `tool_call` guard. |
| **Pi** | **Remote Origin & File Isolation** | Model-issued | macOS | Conditionally Viable | Local sandboxed origin only; arbitrary patches/search unproved in #227 base. | Inject `RemoteWorkspaceTools` capability; full remote execution via Worker. |
| **Pi** | **MCP / Binding Behavior** | Protocol-only | macOS | Blocked for ADR-0019 | OAR starts MCP stdio on engine host; cannot replace tools in-place (`withdraw` is input-only). | Remote Worker MCP origin (#244/#245); fresh session on binding change. |
| **Pi** | **Continuation / Resume** | Model-issued | macOS | Viable | MCP configuration must be re-supplied on resume. | Sprout session key store tracks native ID; re-supplies config on resume. |
| **Pi** | **Attribution & Telemetry** | Source-only | macOS | Conditionally Viable | Progress declared `none` in prototype; event mapping not certified. | Map OAR turn events to Sprout progress/event stream at EngineAdapter seam. |
| **Codex** | **Lifecycle & Supervision** | Scripted | macOS | Blocked | Lacks typed executor binding; defaults to `danger-full-access` via process env `OAR_CODEX_SANDBOX`. | **Native Exception** (retain native adapter). Upstream OAR per-session sandbox and typed executor hook. |
| **Codex** | **Instructions & Cwd** | Source-only | macOS | Blocked | App server spawned in caller cwd; thread gets `options.cwd`. | Controlled scratch cwd at runner start. |
| **Codex** | **Host Restriction / Tool Exclusion** | Source-only | macOS | Blocked | No tool exclusion in `thread/start`; OAR never answers server-initiated dynamic-tool requests (`toApp`). | Upstream OAR dynamic-tool bridge or **Native Exception**. |
| **Codex** | **Remote Origin & File Isolation** | Scripted builder check | macOS | Blocked | No remote executor binding in `thread/start` or `turn/start`. | **Native Exception** using Sprout native `exec-server` / remote environment forward. |
| **Codex** | **MCP / Binding Behavior** | Scripted builder check | macOS | Blocked | `mcpServers` additive, runs stdio on engine host; cannot enforce empty native tools. | Worker-origin MCP via native adapter. |
| **Codex** | **Continuation / Resume** | Scripted builder check | macOS | Blocked | Resume builder omits executor/environment binding. | **Native Exception**. |
| **Codex** | **Attribution & Telemetry** | Unproved | macOS | Unproved | Zero dynamic tool calls observed in #249 and #252; billing facts unknown. | Native Codex telemetry resolution under #248/#249. |
| **Claude** | **Lifecycle & Supervision** | Protocol-only / Scripted | macOS | Conditionally Viable with hooks | Unmodified OAR passes `--dangerously-skip-permissions` and merges host env. | Executable launch wrapper stripping flags, applying bare mode, and sanitizing env. |
| **Claude** | **Instructions & Cwd** | Scripted (loader probe) | macOS | Partially Viable | Automatic `CLAUDE.md` excluded by `--bare`; rules-file read denial and managed policy unproved. | Pre-dispatch wrapper + OS sandbox profile + isolated policy fixture. |
| **Claude** | **Host Restriction / Tool Exclusion** | Model-issued (Agent rejected) / Scripted | macOS | Viable with wrapper | Unmodified OAR has no exclusion flags; wrapper supplies `--tools ''` and permission denials. | Verified wrapper applying strict tool denials and approval rejection. |
| **Claude** | **Remote Origin & File Isolation** | Model-issued (read/edit on local fixture; native Host-run test pass in #252) | macOS | Viable with wrapper | Direct engine opens denied by OS profile; remote test execution passed in #252 under native Host-run (not OAR). | Sprout Environment operations and Worker MCP. |
| **Claude** | **MCP / Binding Behavior** | Model-issued / Protocol-only | macOS | Viable with wrapper | Approved bridge advertises tools only; MCP resources/prompts rejected with `-32601`; managed MCP unproved. | Strict MCP configuration; Worker-origin HTTP/stdio MCP. |
| **Claude** | **Continuation / Resume** | Model-issued | macOS | Viable | Same-binding resume verified; changed-authority fencing requires fresh session. | Session key store partition by mode/host; fresh session on re-binding. |
| **Claude** | **Attribution & Telemetry** | Scripted (#55 reproducible) + Model-issued (non-Claude backend) | macOS | Blocked pending upstream #55 | Upstream issue #55 causes premature root settlement; non-Claude backend used in prototypes. | Upstream #55 resolution or verified projection hook; genuine Claude backend verification. |

---

## 4. Consumption of Go/No-Go Evidence and Decisive Gaps

Consuming the go/no-go requirements across both local prototypes and composite #225 evidence:

1. **Conversation without a Work Environment:**
   - *Status:* **Passed natively; unproved through OAR.**
   - *Evidence:* #252 proved bounded baseline `PONG` conversation with zero Environment attachments or leases for native Pi and Claude. OAR prototypes did not exercise standalone conversation without fixture attachment.
2. **Enrolled Remote Operation / MCP Origin:**
   - *Status:* **Decisively gapped in OAR 0.35.0.**
   - *Evidence:* OAR 0.35.0 launches MCP stdio processes on the **engine host**, violating ADR-0019 (remote Project MCP placement). #244 and #245 established native Worker-side MCP launch with origin-preserving HTTP/stdio transport. OAR cannot claim remote MCP readiness without Sprout-owned HTTP bridging or an upstream remote-transport extension.
3. **Access and Lease Enforcement:**
   - *Status:* **Passed at the Sprout boundary.**
   - *Evidence:* Task mutation leases are strictly enforced at Sprout's Runtime and Environment operations layers (`src/operations/environment-operations.ts`). OAR carries no concept of leases; Sprout's seam protects the work plane regardless of substrate.
4. **Stale Binding Rejection:**
   - *Status:* **Passed via Fresh-Session Policy.**
   - *Evidence:* OAR exposes no in-place tool replacement or generation fencing (`Session.withdraw` affects inputs only). Re-binding is safely handled by session disposal, invalidating the old native session ID, and opening a fresh session with new authority. Old capabilities are rejected at the Sprout operations seam with `remote-operation-blocked`.
5. **Uncertain-Operation Recovery:**
   - *Status:* **Decisively gapped in OAR; Blocked / Unproved without external checkable acceptance.**
   - *Evidence:* #227 established that OAR's `abort()` is cancellation delivery, not remote-stop proof. Pi session disposal awaits native abort when running without bound, and `promptAndWait` waits indefinitely for native settlement after an accepted abort. External process-group timeouts (140s/170s) are scripted external supervisor remedies, not remote termination proof. Moreover, #252's native Host-run recovery evidence is partial and cannot be treated as OAR-level verification. The OAR route remains blocked until an OAR-specific abort/hung-close scenario confirms remote operation settlement or protected lease recovery without replay.

**Decisive Principle:** Individual local engine fixtures do not satisfy composite enrolled-Worker proof. Unresolved decisive gaps keep the corresponding production route blocked.

---

## 5. Per-Runtime Route Decisions and Native Exceptions

### 5.1 Codex: Blocked on OAR; Named Native Exception
- **Chosen Route:** **Retain Native Sprout Implementation** (`src/engine/codex.ts` using native Codex app-server / exec-server).
- **Substrate Decision:** The OAR Codex route is **decisively blocked**.
- **Named Native Exception:** `CodexNativeSeamException`.
  - *Mechanism:* Sprout continues to maintain its native `CodexEngineAdapter` conforming to the Sprout `EngineAdapter` interface.
  - *Removal / Revisit Trigger:* Upstream OAR exposes supported typed executor binding (`thread/start` environments), dynamic tool callback dispatch handling, and per-session sandbox isolation (decoupled from the runner's process environment `OAR_CODEX_SANDBOX`). When an upstream release containing these controls is published and verified against Codex >= 0.159.3, the exception may be reviewed.
- **Preservation of #225 Controls:** Retaining the native adapter preserves the native remote-environment forwarding (`forward --remote`), `--code-mode-host`, and outer OS isolation established in #248 and #249.

### 5.2 Pi: Minimal Production Replacement via Shared Adapter
- **Chosen Route:** **Conditionally Viable for Environment-hosted Replacement via `OarEngineAdapter` (Blocked on Lifecycle & MCP)**.
- **Substrate Decision:** Pi can use the shared `OarEngineAdapter` for Environment-hosted mode, subject to a bounded loader hook and lifecycle/MCP remedies.
- **Evidence-Class Breakdown:**
  - *Model-issued:* Successful turn completion and work-tool execution (`remote_read`, `remote_write`) on isolated local fixtures.
  - *Source-only facts:* OAR session disposal awaits native abort without bound; `promptAndWait` waits indefinitely for native settlement after accepted abort; native tool registry retains native tools.
  - *Scripted external supervision:* Process-group hard kill (140s kill / 170s supervisor) terminates local hung processes, but neither accepted abort nor local process-group kill proves remote operation stopped. Native #252 Host-run evidence cannot substitute for OAR lifecycle proof.
- **Bounded Remedy:**
  1. *Loader/MCP hook:* Upstream or runner-level Pi opener loader policy hook supplying strict `tools`/`noTools` options, disabling default native bash/ambient discovery, and enforcing Worker-origin Project MCP transport.
  2. *Lifecycle supervisor & settlement:* Supervised runner process group with explicit hard timeouts and lease fencing.
- **Checkable Acceptance:**
  1. *Tool exclusion & origin:* Model-issued read/edit/command on an isolated fixture with native tools unregistered, ambient extensions excluded, and no host-stdio MCP execution.
  2. *Lifecycle & settlement (R230-02 check):* An OAR-specific abort/hung-close scenario that verifies runner deadline enforcement, followed by either Worker-confirmed remote termination or a protected recovery state with lease retained and zero replay. Without passing this acceptance check, the OAR Pi production route remains blocked.
- **#270 reconciliation (OAR 0.59.1, amended acceptance):** A framework-internal controlled opener now exists in the single shared runtime-policy module: OAR's published `OAR_PI_AGENT_DIR` pin supplies an owned global root with `defaultTools: []`, while an exclusive, reversible project-settings overlay applies `extensions: ['!**/*']` and suppresses ambient packages. Executed scripted sessions through the real shared runner observe zero native tools, or only the explicitly attached Worker-origin Project MCP bridge tool. Unrestricted extension/Bash controls create resources; forced excluded calls return errors without those resources, and a real runner rejects an explicitly supplied host-stdio server before opening OAR. Original project settings are restored on disposal and forced runner exit; acquisition/verification failures retain the fail-closed refusal. The narrower missing-`SessionOptions` forwarding conclusion remains true, but upstream forwarding is an improvement rather than the sole remedy. See [#270 policy and executed evidence](./270-oar-pi-policy.md). Actual enrolled Worker acceptance and the separate lifecycle/settlement check above remain required; no model-issued or OS-isolation proof is inferred from these scripted substrate measurements.
- **Preservation of #225 Controls:** Native Host-run Pi remains in `src/engine/pi-host.ts` with macOS `sandbox-exec` isolation and Worker MCP. Adopting OAR for Environment-hosted Pi does not displace the #225 Host-run implementation.

### 5.3 Claude: Blocked from Host-run Production by this Issue
- **Chosen Route:** **Future Route with Named Prerequisites; Not Authorized as Production Host-run by #230**.
- **Substrate Decision:** Pinned OAR 0.35.0 as published is decisively blocked for Claude (unmodified launch skips permissions and lacks tool exclusion). Even with #229's prototype launch wrapper and native Agent pre-dispatch rejection, Claude cannot be presented as production Host-run by this issue.
- **Prerequisites & Bounded Remedies:**
  1. *Human-owned prerequisite:* Claude Code CLI installed and authenticated on the engine host.
  2. *Attribution prerequisite:* Upstream resolution of issue #55, or adoption of #229's verified projection hook preventing premature root settlement.
  3. *Tool exclusion prerequisite:* Native pre-dispatch launch wrapper enforcing `--bare`, `--tools ''`, and explicit tool denial.
  4. *Loader verification prerequisite:* Resolution of five remaining unproved loader boundaries identified in #229 rework 2 (rules file read denial, automatic plugin discovery, LSP trigger/entry, OS-managed policy, and managed MCP).
- **Checkable Acceptance:** Model-issued turn using a genuine Claude backend verifying exact root-turn attribution, complete builtin exclusion, remote Worker MCP transport, and zero host leakage.

---

## 6. Confirmed Architectural Foundations and Reference-Design Comparison

The decision confirms the following non-negotiable architectural anchors and establishes explicit relationship to Sprout's standing reference designs (`docs/references.md`):

### 6.1 Architectural Anchors
1. **One Shared `OarEngineAdapter`:** A single adapter class parameterized by runtime identity, capability flags, and host policy. No wrapper class per runtime.
2. **Per-Session Supervised Runner:** Every OAR session runs inside an externally supervised runner process group with explicit hard timeouts (killing the process group if OAR hangs post-abort) and host OS isolation profiles.
3. **Existing Seams Preserved:** The Sprout-owned `EngineAdapter`/`EngineSession` seams (`src/engine/port.ts`, `src/engine/pi.ts`) remain authoritative. OAR Session types, raw events, and protobuf/JSON structures never cross into Sprout Core, durable Task records, or Worker protocols.
4. **Host-Local Credentials Retained:** Engine credentials remain strictly host-local and read-only. No credentials or auth tokens are copied to remote work origins or passed to untrusted tools.
5. **Current Environment-Hosted Placement Retained:** Engines execute behind the enrolled Environment Worker for this slice. Core gains no native process-spawning rules or direct vendor transport paths. Host-run placement remains governed by #225.

### 6.2 Reference-Design Alignment and Required Deviations (AC6)
In accordance with Sprout's standing reference policy (`docs/references.md`), this architecture compares against the three standing reference repositories:

1. **Cumora (MIT, `yetone/cumora`):**
   - *Absorbed design:* The engine run seam (`EngineAdapter`/`EngineSession` in `src/engine/port.ts`, ADR-0002).
   - *Route alignment:* Fully adopted. The single shared `OarEngineAdapter` conforms directly to Cumora's `EngineAdapter`/`EngineSession` port shape.
   - *Deviations:* **None.** Sprout preserves the exact interface contract for session startup, turn dispatch, interrupt handling, and completion observation without leaking vendor types.
2. **Paperclip (MIT, `paperclipai/paperclip`, pinned at `d351e08`):**
   - *Absorbed design:* Separation of durable project workspace from temporary per-work execution area (ADR-0005) and separation of work status/ownership from live execution (ADR-0006).
   - *Route alignment:* Fully adopted. The OAR substrate operates strictly within the per-work execution area. OAR session lifecycle does not own project state, task records, or durable recovery.
   - *Deviations:* **None.** Paperclip has no environment lease model; Sprout maintains its original lease model on top of the execution substrate.
3. **AionUi (Apache-2.0, `iOfficeAI/AionUi`, pinned at `dc78ccd`):**
   - *Primary reference area:* Engine integration code (how a host application spawns, supervises, streams from, and integrates CLI agents such as Claude Code, Codex, and others; ADR-0016).
   - *Route comparison:*
     - AionUi implements individual per-CLI process controllers (e.g., `ProcessAcpClient.ts`, per-engine process supervisors) with dedicated JSON/stream parsers and CLI flag management for each tool.
     - Sprout's OAR route consolidates supported engines behind a **single shared `OarEngineAdapter`**, delegating raw CLI/SDK communication to the OAR substrate while Sprout supervises the runner process group.
   - *Required deviations from AionUi:*
     - **Deviation 1: Single Shared Adapter vs. Per-CLI Process Adapters.** Instead of maintaining distinct native process supervisors for every runtime (as AionUi does), Sprout routes OAR-viable runtimes through one parameterised `OarEngineAdapter`. Where OAR cannot support a runtime (e.g. Codex), Sprout maintains a native exception (`CodexNativeSeamException`) that follows AionUi's native process supervision pattern.
     - **Deviation 2: Upstream Vendor Abstraction Layer.** AionUi directly drives native agent CLIs (via stdio JSON/ACP). Sprout introduces OAR as an intermediate engine substrate. To prevent vendor lock-in or type leakage, Sprout strictly denies OAR session types from crossing the `EngineAdapter` boundary.
     - **Deviation 3: Strict Host Authority and Remote Placement.** In AionUi, tools execute with local user desktop permissions. Sprout strictly deviates by requiring remote Worker execution (ADR-0019) and OS sandbox boundary confinement (`sandbox-exec`), never granting engines direct host filesystem authority or unconstrained tool execution.

---

## 7. Sequencing, Governing Order, and Independent Execution

In accordance with Acceptance Criterion 7, #226 `Relationship to #225`, and the Human adjudication of R230-01:

### 7.1 Source Conflict and Reconciliation
- **The Conflicting Sources:**
  - *Source A:* Ticket #230 AC7 ("Record the sequencing: minimal Codex/Pi replacement before #225's engine-dependent delivery, independent settled #225 work may proceed, and unrelated engine coverage follows...") and #226 `Relationship to #225` ("this issue selects and minimally integrates the engine substrate before #225's full Host-run delivery").
  - *Source B:* `docs/research/225-226-ordering-verdict.md:165-173` (#253), which identified the pre-#253 "OAR-first" sequencing as obsolete and reversed it ("replacement follows or runs parallel to #225; it is not a blocker of it").
- **Human Adjudication (Governing Reading):**
  - AC7's phrase **"#225's engine-dependent delivery"** is interpreted strictly as **the specific subset of #225 that depends on the engine execution substrate**, rather than #225 in its entirety.
  - Under this reconciled reading, both sources are fully consistent: #226 already explicitly provides in the same section that startup parsing, durable placement facts, and the shared Environment operations Module from #225 "may proceed independently", that #225 must not "depend on completion of unrelated runtime migration", and that "OAR is a proposed foundation choice, not an intrinsic technical prerequisite of #225".

### 7.2 Governing Execution Order
The authoritative execution order is therefore:
1. **Independent #225 Substrate-Independent Work (Parallel / Immediate):** #225 work that is independent of engine substrates (e.g., startup argument parsing, durable placement facts, shared Environment operations Module in #237–#238) proceeds in parallel and is never blocked by #226 or OAR adoption.
2. **Minimal Codex/Pi Environment-Hosted Replacement (Precedes #225 Engine-Dependent Delivery):** The minimal Codex/Pi replacement in Environment-hosted mode under #226 (Pi via shared adapter with loader hook, Codex via native exception) is resolved and integrated **before** #225's engine-dependent delivery.
3. **#225 Engine-Dependent Delivery:** The portion of #225 that delivers engine-dependent Host-run capabilities proceeds once the execution substrate foundations are established.
4. **Unrelated Engine Coverage Follows:** Broad runtime migrations and unrelated engine coverage (such as future Claude Host-run production support) follow both and never block #225.

### 7.3 Constraints and Non-Interference
- **No Amendment or Closure of #225:** This decision does not amend, close, or invalidate Ticket #225 or any ticket in its chain.
- **No Broad Migration Blocker:** Broad runtime migration is strictly prohibited from becoming a blocker of #225.
- **No Downstream Premature Starts:** Downstream planning tickets (#231–#236) are bounded planning drafts. Carrying `ready-for-agent` does not authorize an unsupported route:
  - #231 must honor the single shared adapter, the Pi loader hook, and the lifecycle settlement acceptance check.
  - #232 / #234 must respect the `CodexNativeSeamException` rather than attempting a non-functional OAR Codex implementation.
  - Claude production Host-run work cannot start under #226 until the named #225 prerequisites, upstream #55 attribution, and loader boundaries are resolved.

---

## 8. Upstream Drift Finding

- **Pinned Version:** `@botiverse/oar` **0.35.0**, commit `8adde16fe2d12ae54af7d4dff86c3f224380a5c7`.
- **Latest Upstream Version:** `0.58.0`.
- **Finding:** Upstream OAR has drifted by 23 minor versions. In accordance with the hard constraint of this run scope, **OAR is not floated or upgraded**. This drift is recorded as a factual finding for future architectural consideration. Any future upgrade must be an explicit, version-pinned evaluation that re-proves the entire matrix.
