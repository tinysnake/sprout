# Sprout M2 Agent Identity & Work Options Prototype (Ticket #66)

## Summary

This retained prototype artifact documents the design, interaction models, decision evidence, and architectural boundaries for **Agent Identity, Standing Instructions, Ordered Work Option Preferences, Environment Compatibility, Pre-Acceptance Fallback, and Non-Destructive Archiving** in the Sprout M2 Local Operator product (Ticket #66, Scope #44). It builds directly upon the shared shell baseline (#61), Feed & Attention baseline (#62), Multi-View Project baseline (#63), Chat Scopes baseline (#64), and Environment Management baseline (#65), strictly preserving the portable worker identity and management journey decisions settled in **ADR-0008** and **CONTEXT.md**.

The interactive prototype artifact is executable via `npm run prototype` (serving `web/prototype/index.html`), with full DOM test coverage in `web/src/prototype/agents.dom.test.ts`.

---

## 1. Information Architecture & Navigation Topology

In Sprout M2, Agents represent persistent, portable worker identities with their own private memory and ordered execution preferences, independent of any specific Project or Environment. Agents live within the `Manage > Agents` destination with 100% desktop/phone capability parity:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ MANAGE > GLOBAL AGENTS AREA                                                 │
│ ├── Header: Title, Summary, [ + Create New Agent ], [ Architecture Guide ]  │
│ ├── Filter Bar: [ All (7) | Active (6) | Attention (0) | Unavailable (1) | Archived (1) ] │
│ ├───────────────────────────────────────────────────────────────────────────┤
│ ├── DESKTOP SPLIT LAYOUT (Master / Detail)                                  │
│ │   ├── Left Master Column (340px): Filterable Agent Cards List             │
│ │   │   ├── Avatar Monogram / Badge (e.g. PG, PL, ST) in purple agent token  │
│ │   │   ├── Display Name & Stable Identifier (e.g. programmer)              │
│ │   │   ├── Status Dot (Green Ready / Yellow Attention / Red / Neutral)     │
│ │   │   ├── Role / Standing Instruction Snippet                             │
│ │   │   └── Compact Metric Chips (Priority 1 Option, Projects, Version, Mem)│
│ │   │                                                                       │
│ │   └── Right Detail Column (Flex 1): Rich Agent Detail Panel               │
│ │       ├── Section 2: Agent Identity & Core Metadata (Stable Identity, Private Memory) │
│ │       ├── Section 3: Standing Instructions (Editable)                     │
│ │       ├── Section 4: Ordered Work Options (Execution Preferences)         │
│ │       │   ├── Priority Rows (Priority 1 Primary, Priority 2 Fallback...)  │
│ │       │   ├── Drag-and-Drop Reorder Handles, Delete (Min 1 Invariant)     │
│ │       │   └── Pre-Acceptance Fallback & No-Replay Guarantee Notice        │
│ │       ├── Section 5: Foldable Environment Compatibility & Admission Simulator │
│ │       │   ├── Enrolled Host Compatibility Evaluation                      │
│ │       │   ├── Interactive Fallback Simulation Tool                        │
│ │       │   └── Strict Privacy Boundary Notice (Zero host paths / secrets)  │
│ │       ├── Section 6: Foldable Project Memberships & Responsibilities      │
│ │       ├── Section 7: Foldable Version Changelog                           │
│ │       ├── Section 8: Foldable Historical Run Attribution & Provenance     │
│ │       └── Section 9: Operations Toolbar (Edit, Archive / Restore)         │
│ ├───────────────────────────────────────────────────────────────────────────┤
│ └── MOBILE DRILL-DOWN LAYOUT (390px Phone)                                  │
│     ├── Level 1 (Master List): Full-width cards with quick selection        │
│     └── Level 2 (Detail View): Dedicated full-screen panel with sticky top  │
│         header [ ← Back to Agents ] and browser history pushState           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Portable Agent Identity & Core Invariants (ADR-0008)

Per **ADR-0008**, an Agent is created independently of any Project or Environment:

```
  PORTABLE AGENT BOUNDARY (ADR-0008)
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ GLOBAL AGENT DEFINITION (Sprout Instance Scope)                         │
  │ ├── Stable Identity: `programmer` (Immutable slug)                     │
  │ ├── Display Name: "Programmer"                                          │
  │ ├── Avatar / Badge: "PG" (Purple Agent Token)                           │
  │ ├── Description: "Core logic, Three.js game loop, and DOM rendering"    │
  │ ├── Standing Instructions: Persistent across all projects and runs     │
  │ ├── Private Memory: 26 entries (Preserved across projects & archives)  │
  │ ├── Configuration Version: v3 (Changelog of edits with author & time)   │
  │ └── Ordered Work Options: [ Option 1 (Pi) > Option 2 (Codex) > ... ]   │
  └─────────────────────────────────────────────────────────────────────────┘
```

### Core Invariants
1. **No Project or Host Coupling**: An Agent does not belong to a Project; Projects reference Agents via Project Memberships.
2. **No Environment Lock-in**: An Agent is not bound to a specific host machine; its ordered work options define execution preferences evaluated at run admission across any available Environment.
3. **Strict Privacy Boundary**: Agent definitions never contain host filesystem paths (`/Users/...`, `C:\Users\...`) or engine credentials (API keys, OAuth tokens).
4. **Minimum One Work Option**: An Agent must have at least one ordered work option. The UI disables deletion when only one option remains.

---

## 3. Ordered Work Options & Pre-Acceptance Fallback vs No-Silent-Replay

ADR-0008 establishes how Sprout evaluates execution preferences at run admission:

```
  RUN ADMISSION EVALUATION (Outer Boundary)
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 1. Evaluate Target Environment Host (e.g. macOS Studio)                 │
  │    ├── Check Option 1 (Pi · claude-3-5-sonnet · high)                   │
  │    │   └── Is Pi permitted & authenticated? Model available?            │
  │    │       ├── YES ──► ADMIT RUN with Option 1 (Pi)                     │
  │    │       └── NO  ──► PRE-ACCEPTANCE FALLBACK to Option 2              │
  │    └── Check Option 2 (Codex · gpt-4o · medium)                         │
  │        └── Is Codex permitted & authenticated? Model available?         │
  │            ├── YES ──► ADMIT RUN with Option 2 (Codex)                  │
  │            └── NO  ──► PRE-ACCEPTANCE FALLBACK to Option 3 (or REFUSE)  │
  └─────────────────────────────────────────────────────────────────────────┘
                                     │
                             Engine Accepts Run
                                     │
                                     ▼
  EXECUTION PHASE (Inner Boundary — ADR-0008 Invariant)
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 2. Engine Invokes Tools & Executes Work                                │
  │    ├── Tools may produce irreversible host side-effects (commits, etc.) │
  │    └── IF Turn Fails ──► REPORT FAILURE DIRECTLY AS ERROR               │
  │                          (NEVER SILENTLY REPLAY THROUGH OPTION 2 / 3)   │
  └─────────────────────────────────────────────────────────────────────────┘
```

### Key Differences: Pre-Acceptance Fallback vs Post-Acceptance Replay
- **Pre-Acceptance Fallback (Permitted & Expected)**: Before an engine accepts a run, Sprout safely walks down the ordered options list until it finds an engine that is installed, authenticated, and has model availability on the selected Environment instance.
- **Post-Acceptance No-Silent-Replay (Strictly Forbidden)**: Once an engine accepts the run, tools may have already executed shell commands, written files, or initiated network calls. Silently replaying the work through a fallback model would risk duplicate side effects and state corruption. Sprout reports the failure directly to the operator or Task Lead.

---

## 4. Project Membership & Responsibilities vs Global Identity

Project membership is a reference relationship that gives an Agent responsibilities within one Project:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ PROJECT MEMBERSHIP SEPARATION (ADR-0008)                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ • Global Agent Identity: `programmer` (Portable, reusable across projects)  │
│                                                                             │
│ • Membership in Project "Three.js Minesweeper Game":                        │
│   ├── Status: `active`                                                      │
│   ├── Responsibilities: "Core logic, Three.js game loop, and DOM rendering" │
│   └── Collaboration Instructions: "Verify pure functions & build passes"    │
│                                                                             │
│ • Membership in Project "Unity Room Lighting Prototype":                    │
│   ├── Status: `active`                                                      │
│   ├── Responsibilities: "Shader profiling and C# buffer optimization"      │
│   └── Collaboration Instructions: "Profile GPU frame bottlenecks"           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Membership Ending Safety
Ending an Agent's Project membership:
1. Deactivates future communication and run admissions for that Agent within that Project.
2. Ends current participation in every Working Group without deleting its participation history. A disbanded group cannot be restored while any retained member lacks an active Project membership.
3. If the Agent is currently the Task Lead of an unfinished Task, the Task enters a `blocked` lifecycle with an explicit, routable blocker requiring the Human operator to assign a replacement Task Lead.
4. **Preserves Attribution**: Historical messages, Working Group participation, Task runs, and completion claims permanently retain the Agent's identity and configuration version.

---

## 5. Non-Destructive Archive & Historical Attribution

Archiving an Agent is non-destructive (ADR-0008):

- **Safety Guard**: An Agent **cannot be archived** while it has an active run or remains the Task Lead of an unfinished Task. The UI validates active tasks and prevents accidental archiving.
- **Archive Effects**:
  - Bars new Project memberships, chat messages, and Task runs.
  - Exact Project-channel mentions fail closed for an archived target, retain visible per-target routing evidence, and never silently wake a different Agent.
  - Cancels pending projected replies for the archived Agent; callbacks independently recheck Agent and Project state before appending a reply, and durable routing evidence records the responsible archived Agent or Project plus the terminal reason.
  - Retains all private memory entries, past chat messages, Task run facts, and engine session slots.
  - Re-activable at any time via "Restore Agent".

---

## 6. State Matrix Coverage

The prototype demonstrates realistic data covering all 5 canonical states:

| State | Exemplar Agent | Characteristics & Observable Facts |
|---|---|---|
| **Healthy / Ready** | `programmer` (v3), `planner` (v2) | Priority 1 option ready on macOS Studio & Windows Dev; active project memberships; rich private memory; version changelog. |
| **Attention / Fallback** | `designer` (v2), `researcher` (v1) | Priority 1 option degraded on some hosts; pre-acceptance fallback to Priority 2 verified in simulation. |
| **Unavailable** | `sentinel` (ST, v1) | Work option (`opencode` · `deepseek-coder-v2`) is unconfigured (`isConfigured: false`); Agent identity remains intact while clearly explaining why runs cannot currently be admitted. |
| **Archived** | `legacy-coder` (LC, v1) | Archived status; read-only presentation; preserved attribution of past runs and messages; one-click restore. |
| **Empty / Custom** | New Agent Creation Form | Clean validation with display name, description, optional standing instructions, and default Priority 1 work option. |

---

## 7. Product Owner Review Decisions & Pattern Refinements

- **Owner Review Decision & Pattern Refinements**:
  1. *Streamlined Header & Filters*: Header styled seamlessly like Feed and Environments headers (transparent background, no top/left/right borders, subtle bottom border). Title row actions kept inline with icon-only Guide and Create buttons. Filters formatted into 5 discrete box buttons (icon/dot top, count top, label bottom, auto-fitting single row).
  2. *Top-Right Status Dot*: Agent master cards feature a colored status dot aligned to the top-right of the title row.
  3. *Detail View Navigation*: In mobile/single-column view, selecting an agent navigates to a focused, dedicated level-2 full-screen detail panel with a traditional non-floating back header (`[ ← Back ]` + status dot + title) without retaining the list header or filter row.
  4. *Unified Metadata Grid*: Agent metadata (Stable Identity, Private Memory) formatted as a matching 2x2 grid to prevent horizontal overflow on narrow screens; redundant Status & Version / Project count tiles removed in favor of the status banner and foldable sections.
  5. *Work Option Management & Invariant Protection*: Full interactive support for adding options, reordering across devices (desktop drag-and-drop, mobile touch move buttons, and keyboard ArrowUp/Down), automatic version incrementing, and deleting options (with minimum 1 option invariant protection).
  6. *Foldable Progressive Disclosure*: Environment Compatibility & Admission Evaluation, Project Memberships, Version Changelog, and Historical Run Attribution are presented as collapsed foldable boxes, expanding by pointer, Enter, or Space to keep the default view focused on identity and next actions.
  7. *Pre-Acceptance Fallback Simulator*: Interactive tool allows testing how Sprout evaluates run admission across enrolled environments in real-time.
  8. *Safety-Guarded Archiving*: Archiving independently validates that the agent is not executing active runs and is not leading unfinished tasks; displays clear explanation of non-destructive attribution preservation.
  9. *Top Control Bar Streamlining*: Zero space-occupying candidate select dropdowns; clean visual hierarchy following `design-taste-frontend` taste principles.
  10. *Concise Status Banner*: Agent detail top banner shows only the status label and concise version/state chip; the verbose narrative fact paragraph was removed.
  11. *No Search Box*: The Agents header has no search input; the 5 status filter pills are the only list-narrowing control, matching the Environments surface.
  12. *Repo-Standard Modal Primitives*: Create Agent, Agent Architecture Guide, Edit Agent, Edit Standing Instructions, Add Work Option, Archive Agent, and Run Attribution Trace dialogs use the shared `proto-modal-*` overlay/dialog/header/body/footer primitives from the accepted #61 baseline, so they render as centered, dimmed-backdrop modals with a legible title, fields, and Cancel/Confirm actions on both phone and desktop.
  13. *Keyboard Navigation Parity*: Agent master cards and Project, Working Group, and direct-message scope cards are focusable and activate with Enter or Space without adding controls or default visual density.
- **Verification Command**:
  ```bash
  npm run typecheck && node --test 'src/**/*.test.ts' 'web/src/**/*.test.ts'
  ```
