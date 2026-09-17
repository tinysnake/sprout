# Sprout M2 Environment Management & Recovery Prototype (Ticket #65)

## Summary

This retained prototype artifact documents the design, interaction models, decision evidence, and architectural boundaries for **Environment Management, Health Facts, Lease Safety, Reconciliation, and Recovery** in the Sprout M2 Local Operator product (Ticket #65, Scope #44). It builds directly upon the shared shell baseline (#61), Feed & Attention baseline (#62), Multi-View Project baseline (#63), and Chat Scopes baseline (#64), preserving the task-held lease guarantees settled in ADR-0005, task authority in ADR-0006, management journeys in ADR-0008, and self-hosted operation and recovery promises in ADR-0009.

The interactive prototype artifact is executable via `npm run prototype` (serving `web/prototype/index.html` on `0.0.0.0:41000`), with full DOM test coverage in `web/src/prototype/environments.dom.test.ts`.

---

## 1. Information Architecture & Navigation Topology

In Sprout M2, Environments represent host-local worker instances (macOS Studio, Windows Dev Box, MacBook Air, Container CI nodes) running under the local operator's user session. Environments live within the `Manage > Environments` destination with 100% desktop/phone capability parity:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ MANAGE > ENVIRONMENTS AREA                                                  │
│ ├── Header: Title, Summary, [ + Register New Host ], [ Host Bootstrap Guide ]│
│ ├── Filter Bar: [ All (6) | Ready (1) | Attention (2) | Action Required (2) | Archived (1) ] │
│ ├───────────────────────────────────────────────────────────────────────────┤
│ ├── DESKTOP SPLIT LAYOUT (Master / Detail)                                  │
│ │   ├── Left Master Column (340px): Filterable Environment Cards List       │
│ │   │   ├── Platform Icon (macOS / Windows / Container)                     │
│ │   │   ├── Display Name & Neutral Host Context (e.g. mac-operator)         │
│ │   │   ├── Traffic Light Badge (Green Ready / Yellow Attention / Red Action)│
│ │   │   ├── 2-Line Decisive Text Reason Snippet                             │
│ │   │   └── Compact Metric Chips (Connection, Protocol Version, Lease State)│
│ │   │                                                                       │
│ │   └── Right Detail Column (Flex 1): Rich Environment Detail Panel         │
│ │       ├── Section 1: Prominent Traffic Light Summary Banner + Text Reason │
│ │       ├── Section 2: 6 Independent Health Dimensions Metric Grid          │
│ │       ├── Section 3: Capability Permissions (Granular & Safety-Guarded)   │
│ │       ├── Section 4: Engine Harness Readiness (Codex, Pi, agy, opencode)  │
│ │       ├── Section 5: Bound Project Workspaces (Workspace Readiness)       │
│ │       ├── Section 6: Active Lease / Reconciliation / Recovery Box         │
│ │       ├── Section 7: Live Operations & Simulation Toolbar                 │
│ │       └── Section 8: Recent Readiness Probes & Operational Audit Log      │
│ ├───────────────────────────────────────────────────────────────────────────┤
│ └── MOBILE DRILL-DOWN LAYOUT (390px Phone)                                  │
│     ├── Level 1 (Master List): Full-width cards with quick Probe button     │
│     └── Level 2 (Detail View): Dedicated full-screen panel with sticky top  │
│         header [ ← Back to Environments ] and browser history pushState     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 6 Independent Health Dimensions & Traffic-Light Model

Per **ADR-0009**, Sprout never collapses installation, authentication, compatibility, carrier connectivity, capability permissions, and work safety into a single boolean. Web presents six independent, inspectable dimensions behind a clear, textually explained traffic-light summary:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 6 INDEPENDENT HEALTH DIMENSIONS (ADR-0009)                                  │
├──────────────────────┬──────────────────────────────────────────────────────┤
│ 1. Enrollment Status │ `approved` · `pending` · `revoked` · `archived`      │
│                      │ Opaque public key fingerprint (sprout-wk-mac-7f89...)│
├──────────────────────┼──────────────────────────────────────────────────────┤
│ 2. Carrier Connection│ `online` · `reconnecting` · `offline` · `never conn` │
│                      │ Last confirmed timestamp + connection age in seconds │
├──────────────────────┼──────────────────────────────────────────────────────┤
│ 3. Protocol Compat.  │ `compatible` · `incompatible` · `unknown`            │
│                      │ Version (e.g. v2.1 vs required v2.x) + upgrade hint  │
├──────────────────────┼──────────────────────────────────────────────────────┤
│ 4. Work Safety       │ `clear` · `held` · `reconciling` · `recovery`        │
│                      │ Active lease holder (Task #ID, Project, duration)    │
├──────────────────────┼──────────────────────────────────────────────────────┤
│ 5. Capability Perms  │ Granular: File R/W · Process Exec · Network · GUI    │
│                      │ Interactive toggle switches with lease-active guards │
├──────────────────────┼──────────────────────────────────────────────────────┤
│ 6. Engine Readiness  │ Codex, Pi, agy, opencode                             │
│                      │ Per-engine status: `ready` · `login-required` ·      │
│                      │ `missing` · `unknown` with versions & model notes    │
└──────────────────────┴──────────────────────────────────────────────────────┘
```

### Textual Traffic-Light Invariant
Color is never used in isolation. Every Environment instance presents a mandatory, prominent textual reason explaining why it is in its current state:

- **Green — Ready**: Approved enrollment, carrier online, protocol compatible, all required capabilities permitted, required engines authenticated, work safety clear.
  - *Example:* `"All capabilities permitted · Engines authenticated · Lease held by Task #101"`
- **Yellow — Attention / Degraded**: Pending enrollment approval, first connection, transient reconnect, stale probe, or non-required engine missing / login-required.
  - *Example:* `"Pending enrollment approval by operator · Worker key verified"`
  - *Example:* `"Degraded · Codex engine login required · GUI automation unavailable"`
- **Red — Action Required / Unavailable**: Worker offline, identity revoked, protocol incompatible, required engine unavailable, or work safety in `recovery`.
  - *Example:* `"Worker offline for 14 minutes · Lease recovery required (interrupted run #206)"`
  - *Example:* `"Protocol incompatible: worker protocol v1.8 is below required v2.0+"`

---

## 3. Task-Held Lease Safety & Safe Task End (ADR-0005)

ADR-0005 establishes that **a Task acquires one Environment lease at Task begin and holds it until Task end**.

```
  TASK LIFECYCLE (Outer: Task begin → Task end)
  ├─────────────────────────────────────────────────────────────────────────┤
  │ [ Begin ] ─────────► [ Multi-Run Execution ] ─────────► [ Task End ]    │
  │     │                       │                                │          │
  │   Acquires              Runs reuse                        Recycles      │
  │  Task Lease             Task Lease                         Context      │
  │     │                       │                                │          │
  │     ▼                       ▼                                ▼          │
  │ [ Held ] ──────────► [ Held across gaps, ] ──────────► [ Releases ]     │
  │                      [ idle & validation ]               [ Lease ]      │
  └─────────────────────────────────────────────────────────────────────────┘
```

### Key Lease Safety Invariants
1. **Holding Unit is the Task, Not the Run**: Nested `AgentRun`s start and settle inside the Task's lease reservation. Idle intervals between runs, blocker states, and "Awaiting human validation" gaps **retain the lease continuously**.
2. **No Timeout-Driven Silent Reassignment**: Losing a worker connection or pausing a task never makes the environment acquirable by another Task. Unfinished work is protected over capacity utilization.
3. **Project Workspace vs. Task Scratch Context**:
   - **Project Workspace**: Durable git repository, build artifacts, and caches on host (`~/workspace/sprout-projects/minesweeper-threejs`). Persists across tasks and runs; **never deleted at Task end**.
   - **Task Scratch Context**: Ephemeral Sprout context directory created at Task begin. Recycled by the worker at Task end.

---

## 4. Disconnect, Reconnect & Reconciliation Flow (ADR-0009)

When carrier communication with a worker host is lost during an active run, Sprout does not allow unobserved execution:

```
                          ┌───────────────────────────┐
                          │   WORKER CHANNEL LOST     │
                          └─────────────┬─────────────┘
                                        │
                                        ▼
                          ┌───────────────────────────┐
                          │    ENTER LEASE RECOVERY   │
                          │ • Run marked interrupted  │
                          │ • Lease locked in recovery│
                          │ • Reassignment barred     │
                          │ • Attention item queued   │
                          └─────────────┬─────────────┘
                                        │ (Host reconnects over TLS/WSS)
                                        ▼
                          ┌───────────────────────────┐
                          │   RECONCILIATION PHASE    │
                          │ • Authenticate identity   │
                          │ • Verify protocol version │
                          │ • Synchronize evidence    │
                          │ • Prove engine stopped    │
                          └─────────────┬─────────────┘
                                        │
                        ┌───────────────┴───────────────┐
                        │                               │
                        ▼                               ▼
            ┌───────────────────────┐       ┌───────────────────────┐
            │      RESUME TASK      │       │   DISCARD & RELEASE   │
            │ • Keeps interrupted   │       │ • Worker recycles     │
            │   run as history      │       │   scratch context     │
            │ • Task active on same │       │ • Preserves Project WS│
            │   host environment    │       │ • Releases lease      │
            └───────────────────────┘       └───────────────────────┘
```

---

## 5. Human-Only Emergency Force Release (ADR-0009)

To prevent early self-hosted recovery defects from locking an operator out of an environment forever, Sprout provides **Force Release** as an emergency escape hatch.

### Strict Governance Invariants
1. **Recovery-Only Availability**: Force Release is available **only** when an Environment is already in `recovery`. It cannot preempt an ordinary active lease.
2. **Never Automatic**: Force Release cannot be triggered by timeouts, watchdog scripts, or agents. It is exclusively an operator human action.
3. **Three-Point Safety Guard**:
   - **Unresolved Facts Manifest**: Web lists every unverified fact (e.g. *"Host worker offline: engine process stop unconfirmed"*, *"Task scratch directory unrecycled"*).
   - **Mandatory Operator Reason**: The operator must provide a written reason (e.g. *"Host machine kernel panic; worker cannot reconnect"*).
   - **Risk Acknowledgement & Typed Confirmation**: The operator must check the risk acknowledgement box **and** type `FORCE RELEASE` in full uppercase before the authorize button is enabled.
4. **Outcome & Workspace Guarantee**:
   - The affected Task is cancelled with a permanent `forced release` disposition recording the actor, timestamp, reason, and unresolved facts.
   - The Project workspace on host is **preserved**. Unrecycled scratch context is noted as leftover data.
   - The Environment is unlocked to `clear` / Green (`Force Released by Operator...`) and becomes reassignable.
   - A durable forced release audit record is created and displayed in history.

---

## 6. Strict Privacy & Host Fact Boundaries (AGENTS.md & ADR-0008)

To ensure privacy, multi-host portability, and clean abstraction:
- **No Local User Home Paths**: The UI uses neutral relative paths (`~/workspace/sprout-projects`, `C:\SproutWorkspaces`, `/var/sprout/workspaces`) and never reveals host usernames like `/Users/<name>` or `C:\Users\<name>`.
- **No Private Credentials**: API tokens, OAuth cookies, SSH keys, and host private keys remain strictly on the host. Web presents only neutral readiness statuses (`ready`, `login-required`, `missing`) and public key fingerprints (`sprout-wk-mac-7f89a1c2`).
- **No Private LAN IP Topology**: Transport is identified by standard CGNAT overlay addresses (`100.64.0.4:5174`) or loopback (`127.0.0.1:41000`).

---

## 7. Phone & Desktop Parity State Matrix

The prototype provides 100% interactive parity across 390px mobile screens and wide desktop viewports:

| Scenario / State | Platform | Traffic Light | Connection | Work Safety | Key Interactive Features |
|---|---|---|---|---|---|
| **macOS Studio Host (M2 Max)** | macOS | Green: Ready | Online (10s) | Clear (Task #101 held) | Live probe request, permission toggles, engine breakdown, bound workspace unbind safety. |
| **Windows Dev Box (Core i9)** | Windows | Red: Action Required | Offline (14m) | Recovery (Task #104) | Recovery Alert Box, unresolved facts, Resume, Discard (safe Task end), Emergency Force Release. |
| **MacBook Air Onboarding** | macOS | Yellow: Attention | Reconnecting | Clear (0 leases) | Pending enrollment approval button, key verification, bootstrap registration simulation. |
| **Linux Container CI (Docker)** | Container | Yellow: Attention | Online (45s) | Clear (0 leases) | Degraded engine status (Codex login-required), missing GUI automation badge, probe latency. |
| **Mac mini (Legacy Worker)** | macOS | Red: Action Required | Online (1m) | Clear (0 leases) | Protocol version mismatch guidance (v1.8 < v2.0+ required), upgrade instructions banner. |
| **Windows Workstation (Archived)** | Windows | Yellow: Attention | Offline (3d) | Clear (0 leases) | Archived instance state, work admission disabled, Restore Instance button. |
| **Emergency Force Release Flow** | Windows | Red → Green | Offline | Recovery → Clear | Warning banner, unresolved facts, reason input, risk checkbox, typed `FORCE RELEASE` confirmation. |
| **Reconnect & Reconcile Flow** | Windows | Red → Yellow → Red | Online | Reconciling → Recovery | Sockets reconnect, evidence synchronization (4 events, engine stopped proof), Resume vs Discard. |

---

## 8. Verification & Review Drawer Recording

- **DOM Test Suite**: `web/src/prototype/environments.dom.test.ts` (extensive tests covering health facts, traffic light reasons, approval, probes, disconnect, reconnect, reconciliation, resume, discard, force release typed confirmation, permissions, archive, mobile drill-down, and privacy boundaries).
- **Owner Review Decision & Pattern Refinements**:
  1. *Streamlined Header & Filters*: Header card styled seamlessly like the Feed header (transparent background, no top/left/right borders, subtle bottom border). Title row buttons kept strictly inline on a single row (nowrap, right aligned), with Host and Guide buttons streamlined to icon-only (using standard manual/book icon). Filters restyled into 5 discrete box buttons (icon top, label bottom, auto-fitting single row) modeled after Attention urgency pills.
  2. *Top-Right Status Dot*: Environment card top-right badge/pill simplified to a small colored status dot aligned to the top-right of the title row.
  3. *Detail View Navigation*: In single-column/mobile view, entering environment detail replaces the home title bar with a traditional non-floating back header (`[ ← Back ]` + truncated environment title) without retaining the home title bar or filter row.
  4. *Unified 2x2 Grids & Anti-Overflow*: Core operational status dimensions (1–4) and capability permissions (5) unified into matching 2x2 grids, structured vertically (title/subtext top, full-width badge/button bottom) to prevent horizontal overflow on narrow mobile screens (320px–390px).
  5. *Detail Card Padding*: Added comfortable padding (14px mobile, 16px desktop) to `.env-detail-card` to eliminate unpadded border collisions.
  6. *Operations Toolbar De-duplication*: Removed redundant "Emergency Force Release" button from operations toolbar since the recovery alert box already provides it.
  7. *Harness Bar Streamlining*: Candidate select dropdowns (`top-state-matrix-select`, `top-layout-select`, `scenario-jumper`) cleanly removed from the prototype top harness. Crucially, removing these UI controls does not remove underlying state matrices, scenario data models, or backend requirements, which are strictly preserved for downstream production specification and implementation.
- **Owner Review Drawer**: Integrated into `web/src/prototype/views/review-drawer.ts` with complete checklist, accepted decisions, rejected alternatives, and unresolved notes.
- **Verification Command**:
  ```bash
  npm test && npm run typecheck
  ```
  Result: 188+ unit & integration tests passing with 0 errors.
