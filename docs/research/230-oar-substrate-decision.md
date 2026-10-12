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
3. **Pi Route — Conditionally Viable for Environment-hosted Replacement:** OAR 0.35.0 is viable for an Environment-hosted Pi replacement using a controlled extension loader/settings hook to restrict tools to authorized fixtures and deny host sentinels. However, unmodified OAR lacks standard `tools`/`noTools` options and launches MCP stdio on the engine host. Production adoption is blocked pending an upstream policy hook or runner-level loader wrapper. Native Host-run Pi remains governed by #225.
4. **Codex Route — Blocked from OAR Adoption; Retains Bounded Native Exception:** Unmodified OAR 0.35.0 lacks typed executor binding (`thread/start` environments), dynamic tool callback dispatch, and per-session sandbox isolation. Codex retains a named **`CodexNativeSeamException`** using Sprout's native app-server/exec-server integration (`src/engine/codex.ts`). The OAR Codex route is blocked until upstream exposes these controls.
5. **Claude Route — Strictly Blocked from Production Host-run by this Issue:** While #229 demonstrated local feasibility with custom launch wrappers (including pre-dispatch native Agent rejection), Claude remains blocked from production Host-run adoption by #230. It requires Human CLI installation/authentication, upstream resolution or a projection hook for attribution issue #55, and resolution of remaining unproved loader boundaries.
6. **Sequencing and Independence:** **Adopting OAR does not gate or precede #225.** Substrate-independent #225 work (#237–#238) and the Pi vertical (#240–#247) proceed independently. A minimal Codex/Pi replacement in Environment-hosted mode may proceed within #226 without waiting for or disrupting #225.

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
| **Pi** | **Lifecycle & Supervision** | Model-issued | macOS | Conditionally Viable | Disposal awaits native abort without bound; post-abort wait unbounded. | Supervise runner process group externally with explicit hard deadline (140s kill / 170s supervisor). |
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
| **Claude** | **Remote Origin & File Isolation** | Model-issued (local fixture & #252 test) | macOS | Viable with wrapper | Direct engine opens denied by OS profile; remote test execution passed in #252 under native Host-run. | Sprout Environment operations and Worker MCP. |
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
   - *Status:* **Passed via External Supervision.**
   - *Evidence:* OAR's `abort()` is cancellation delivery, not remote-stop proof. Sprout's supervised runner process group and Worker delivery journal enforce settlement before releasing protected leases.

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
- **Chosen Route:** **Conditionally Viable for Environment-hosted Replacement via `OarEngineAdapter`**.
- **Substrate Decision:** Pi can use the shared `OarEngineAdapter` for Environment-hosted mode, subject to a bounded loader hook.
- **Bounded Remedy:** Upstream or runner-level Pi opener loader policy hook supplying strict `tools`/`noTools` options, disabling default native bash/ambient discovery, and enforcing Worker-origin Project MCP transport.
- **Checkable Acceptance:** Model-issued read/edit/command on an isolated fixture with native tools unregistered, ambient extensions excluded, and no host-stdio MCP execution.
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

## 6. Confirmed Architectural Foundations

The decision confirms the following non-negotiable architectural anchors:
1. **One Shared `OarEngineAdapter`:** A single adapter class parameterized by runtime identity, capability flags, and host policy. No wrapper class per runtime.
2. **Per-Session Supervised Runner:** Every OAR session runs inside an externally supervised runner process group with explicit hard timeouts (killing the process group if OAR hangs post-abort) and host OS isolation profiles.
3. **Existing Seams Preserved:** The Sprout-owned `EngineAdapter`/`EngineSession` seams (`src/engine/port.ts`, `src/engine/pi.ts`) remain authoritative. OAR Session types, raw events, and protobuf/JSON structures never cross into Sprout Core, durable Task records, or Worker protocols.
4. **Host-Local Credentials Retained:** Engine credentials remain strictly host-local and read-only. No credentials or auth tokens are copied to remote work origins or passed to untrusted tools.
5. **Current Environment-Hosted Placement Retained:** Engines execute behind the enrolled Environment Worker for this slice. Core gains no native process-spawning rules or direct vendor transport paths. Host-run placement remains governed by #225.

---

## 7. Sequencing and Independent Execution

In accordance with Acceptance Criterion 7:
1. **#225 is Not Gated by OAR Adoption:** The ordering verdict from #253 is upheld: adopting OAR does not precede or gate #225. Substrate-independent #225 work (#237–#238) and the Pi vertical (#240–#247) proceed independently.
2. **Minimal Replacement Sequencing:** The minimal Codex/Pi replacement in Environment-hosted mode may proceed under #226 within the boundaries established here: Pi via the shared adapter with its loader hook, Codex via its native exception.
3. **No Downstream Premature Starts:** Downstream planning tickets (#231–#236) are bounded drafts. Carrying `ready-for-agent` does not authorize an unsupported route:
   - #231 must honor the single shared adapter and the Pi loader hook.
   - #232 / #234 must respect the `CodexNativeSeamException` rather than attempting a non-functional OAR Codex implementation.
   - Claude production Host-run work cannot start under #226 until the named #225 prerequisites and #55 attribution are resolved.

---

## 8. Upstream Drift Finding

- **Pinned Version:** `@botiverse/oar` **0.35.0**, commit `8adde16fe2d12ae54af7d4dff86c3f224380a5c7`.
- **Latest Upstream Version:** `0.58.0`.
- **Finding:** Upstream OAR has drifted by 23 minor versions. In accordance with the hard constraint of this run scope, **OAR is not floated or upgraded**. This drift is recorded as a factual finding for future architectural consideration. Any future upgrade must be an explicit, version-pinned evaluation that re-proves the entire matrix.
