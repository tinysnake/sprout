# Sprout M2 Multi-View Project Experience & Task Operating Loop Prototype

## Summary

This retained prototype artifact settles the **Multi-View Project Experience** and the complete **Project-Owned Task Operating Loop** for the Sprout M2 Local Operator product (Ticket #63, Scope #44). It builds on the accepted shared shell baseline (Ticket #61) and Feed baseline (Ticket #62) at base commit `6a48b137f886c3cfcbf941868361f74345617ac2`, implementing the product boundaries settled in ADR-0006, ADR-0007, and ADR-0008.

The interactive prototype artifact is accessible at `web/prototype/index.html` via `npm run prototype`, with full DOM verification in `web/src/prototype/project.dom.test.ts`.

---

## 1. Multi-View Project Information Architecture

Rather than forcing all Project concerns into a single monolithic tab or scrollview, the Project experience is structured into three focused, responsive sub-views accessible via sticky top segmented tabs:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ PROJECT AREA                                                                │
│ ├── Project Selector & Metadata Snapshot (Template, Envs, Members, Tasks)   │
│ ├── [ Overview | Tasks (N) | Chat ] Sub-Navigation Bar                      │
│ ├───────────────────────────────────────────────────────────────────────────┤
│ ├── SUB-VIEW 1: OVERVIEW & CONTRACT                                         │
│ │   ├── Project Contract & Purpose (Derived template, goal, rules, criteria)│
│ │   ├── Wake Routing Policy Toggle (Explicit-only vs 30s wake-model window) │
│ │   ├── Project Memberships (Human lead, agent roles, instructions, status) │
│ │   ├── Bound Workspaces & Environments (macOS/Windows, host roots, paths)  │
│ │   ├── Communication Entry Points & Working Groups (Active/Disbanded)      │
│ │   └── Non-Destructive Archive / Restore (Safety checks on active leases)  │
│ ├───────────────────────────────────────────────────────────────────────────┤
│ ├── SUB-VIEW 2: TASKS & COMPLETE OPERATING LOOP                             │
│ │   ├── Task Carousel & Lifecycle Filters (All, Active, Validation, Blocked)│
│ │   ├── 3-Part Disambiguated Sentence (Task · Agent Run · Task Lease)       │
│ │   ├── Stage 1: Proposal (Non-resource validation, Approve & Begin)        │
│ │   ├── Stage 2: Active Multi-Run Execution (Lead coordination, run timeline)│
│ │   ├── Stage 3: 2-Stage Pause & Intentional Run Interrupt (Hold / Stop)    │
│ │   ├── Stage 4: Routable Blockers (Reason, required action, actor, advance)│
│ │   ├── Stage 5: Completion Claims & Human Validation (Evidence, safe end)  │
│ │   ├── Stage 6: Ordinary Recovery (Lease locked, resume vs discard)        │
│ │   └── Stage 7: Content Versioning (v1 -> v2 for future runs)              │
│ ├───────────────────────────────────────────────────────────────────────────┤
│ └── SUB-VIEW 3: PROJECT DISCUSSION & WORKING GROUPS CHAT                    │
│     ├── Scope Selector (#general channel, working groups, direct messages)  │
│     ├── Timeline Stream (Attribution, projected replies, causal chains)     │
│     └── Causal Routing Inspector Link (Trace wake batch decisions)          │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Project Overview Sub-View

### Project Contract & Purpose
- **Derived Template Source:** Projects are created atomically from the immutable built-in `General collaboration template v1.0`. The template provides editable goal guidance, suggested rules, collaboration instructions, and completion guidance.
- **Project Contract Editing:** The operator can edit the project goal, add/edit/remove project rules, and update completion guidance at any time. Edits apply to future tasks and runs.
- **Wake Routing Policy Toggle:** Switch between `Explicit Mentions Only` and `Wake-Model Assisted (30s batch window)` with explicit guidance that changes govern future incoming messages only.

### Project Memberships & Collaboration Roles
- **Membership Model:** Project memberships reference independent global Human and Agent definitions without copying credentials or host paths into Agent identity.
- **Role Assignment & Instructions:** Each member displays their assigned role responsibilities and optional collaboration instructions (e.g. *"Break tasks down into verifiable slices under 5 minutes duration"*).
- **Membership Actions:**
  - `+ Add Agent Member`: Selects an unassigned global agent, configures project-specific responsibilities and instructions.
  - `Edit Instructions`: Inline adjustment of collaboration instructions.
  - `End Membership`: Non-destructively marks membership `ended`. Prevents new message delivery and agent runs while preserving historical messages, runs, and attribution. Active tasks requiring this lead are flagged with a routable blocker.
  - `Restore Membership`: Restores ended agent membership.

### Bound Workspaces & Host Environments
- **Environment Access:** References enrolled macOS and Windows host environments.
- **Workspace Location:** Displays a neutral host workspace root and project-relative directory paths (`minesweeper-threejs`), without exposing host filesystem roots.
- **Preparation & Safety:**
  - `+ Bind Environment`: Binds an enrolled host environment and verifies/prepares the relative workspace directory.
  - `Switch Workspace Path`: Permitted only when no active task run or held lease exists on that environment.
  - `Unbind Environment`: Refused while active task lease or recovery is held; files on host are preserved.

### Communication Scopes, Chat Cards & Responsive Layout
- **Categorized Scope Architecture:** Separates communication into three distinct sections with clean dividers:
  1. **Project Channels:** Broadcast channel (`#general`) for whole-project coordination.
  2. **Working Groups:** Focused team scopes with member counts (`Core Mechanics WG`, `WebAudio Effects WG`).
  3. **Direct Messages:** 1-on-1 collaboration scopes with active project agents (`@Programmer`, `@Reviewer`, `@Designer`, `@Planner`).
- **Minimalist Scope Cards:**
  - Left icon or agent avatar.
  - Middle: Scope title + 2-line clamped subtitle previewing the latest message content (with overflow ellipsis).
  - Right: Timestamp and prominent red unread badge dot with unread counter.
- **Wide Screen (Desktop) Split-Pane Layout:**
  - Left column (310px): Categorized chat cards list.
  - Right column: Active conversation timeline stream, message composer, and causal routing inspector link.
  - Clicking any card on the left instantly updates the active conversation on the right.
- **Narrow Screen (Mobile) Hierarchical IM Layout:**
  - **Level 1 (Chat List):** Full-screen categorized card list. App-Header displays standard Project Selector + Info + New Project buttons.
  - **Level 2 (Chat Detail):** Tapping any chat card drills down into the full-screen conversation stream and composer. The App-Header transforms into a focused back-navigation header (`← Back to Chats` + Chat Title), with native browser history (`pushState`/`popstate`) support.

### Safe Project Archiving
- **Active Work Guard:** Archiving is safely blocked if any task in the project has an active agent run, held lease, or unconfirmed recovery. An explanatory warning identifies the blocking task.
- **Archived State:** When clean, archiving transitions the project to `archived`, marks all channels and DMs read-only, disables new task proposals, and preserves all workspace directories on host.

---

## 3. Project-Owned Task Operating Loop

The prototype implements the complete 7-stage Task operating loop governed by ADR-0006:

### Task List (Grid View) & Task Detail Page Drill-Down
- **Single Status Filter Dropdown:** Replaces horizontal pill clutter with a clean `<select>` displaying counts for `All`, `Active / Running`, `Validation Claims`, `Blocked`, `Proposals`, `Recovery`, and `Completed`.
- **Responsive Tasks Grid:**
  - Phone / Narrow: 1 column card list with high-contrast status borders.
  - Wide / Desktop: 3–4 column responsive grid view (`repeat(auto-fill, minmax(280px, 1fr))`).
  - Cards display Task ID, Lifecycle pill, Title (2-line clamp), Goal snippet, 3-part sentence pill, Lead agent, Bound host environment, and click chevron.
- **Drill-Down Detail Page & Native Browser Back Support:**
  - Clicking any task card opens its dedicated **Task Detail Page** containing the complete operating controls, version editor, and run execution timeline.
  - Top-left `← Back to Tasks` button returns to the Task List View.
  - Full `window.history.pushState` and `popstate` integration enables native browser Back and Forward navigation without full page reloads.

### 3-Part Disambiguated Lifecycle Sentence
Every task presents its operational state through a unified sentence and color-coded badge row:
$$\text{Task State} \cdot \text{Agent Run State} \cdot \text{Task Lease State}$$
Examples:
- `Task active · Agent running · Lease held (env-ready)`
- `Task pause requested · Active run settling · Lease held (env-ready)`
- `Task awaiting validation · No active Agent run · Lease held (env-ready)`
- `Task proposed · Executes NO run · Holds NO lease`
- `Task recovery · Interrupted run recorded · Lease recovering (env-recovery)`

### Stage 1: Proposal & Human Begin Authority
- **Non-Resource Validation:** Proposals perform non-resource validation only. A proposed task holds **NO** Environment lease, executes **NO** agent run, and cannot wake agents.
- **Proposer Attribution:** Proposers can be Humans (Operator) or Agents (e.g. Planner, Designer).
- **Human Approve & Begin Authority:** The operator selects a bound host Environment and confirms the Task Lead Agent. Begin atomically binds the environment, acquires its exclusive Task lease, creates the scratch context directory, and starts the lead agent run.
- **Proposal Rejection:** Explicit Human action recording a visible rejection reason.

### Stage 2: Autonomous Lead Multi-Run Coordination
- Within the approved boundary, the Task Lead Agent autonomously initiates sequential agent runs (e.g. Lead Programmer invokes Reviewer) without requiring per-run Human approval.
- **Runs Timeline:** Displays nested runs with Run ID, Agent name, Engine (`pi`, `codex`), Model (`claude-3-5-sonnet`, `gpt-4o`), Effort, Content Version used, Status, Wall duration, Token usage breakdown (uncached input, cached reads, output, reasoning), Cost estimate, Tool call events stream, and Final assistant text.

### Stage 3: Two-Stage Pause & Intentional Run Interrupt
- **Stage 1: Pause Task (Admission Hold):** Sets task lifecycle to `Task pause requested`. Running agent is allowed to settle naturally; no new runs are admitted.
- **Stage 2: Interrupt Active Run (Intentional Stop):** Halts running agent immediately, settles run as `stopped`, keeps Task lease held, and sets Task lifecycle to `paused`.
- **Resume Task:** Human resumes deliberate execution on the held lease.

### Stage 4: Routable Blockers
- When progress is blocked on permissions or assets, the Lead declares a structured blocker capturing:
  1. **Reason:** Specific cause of blockage.
  2. **Required Next Action:** Concrete action needed.
  3. **Responsible Actor:** Human or specific Agent.
  4. **Who Advances When Cleared:** Actor who resumes execution.
- **Resolve Blocker:** Operator resolves condition and resumes deliberate advance on held lease.

### Stage 5: Completion Claims & Human Validation
- **Lead Agent Claim:** The Lead submits a formal claim containing Outcome Summary, Validation Evidence (test script output), Durable Changes (file paths), Known Limitations, and Recommended Disposition (`completed`).
- **Human Validation Actions:**
  - `Accept & Authorize Safe Task End`: Safe task end sequence — recycles scratch context directory, releases environment lease, sets task to `completed`.
  - `Require Correction`: Operator provides feedback notes; returns task to active advance on the same environment and held lease.

### Stage 6: Safe Task End & Discard
- `Discard Task (Safe End)`: Human-only safe cancellation sequence — cancels execution, recycles scratch context, releases lease, sets task to `cancelled`, and preserves project workspace files.

### Stage 7: Ordinary Task Recovery
- Detects interrupted worker connection or engine crash.
- **Lease Protection Guarantee:** Environment lease remains locked to prevent capacity theft or overwriting unfinished work.
- **Recovery Actions:** `Ordinary Resume (Deliberate Advance)` on the original environment instance, or `Discard Task (Safe End)`.
- **Force Release Separation:** Emergency Force Release is strictly located in Manage > Environments as an operator exception, with clear risk acknowledgment.

### Stage 8: Task Content Versioning
- Operator can edit Goal, Constraints, Validation Criteria, or Replace Lead at any time.
- Edits immediately create `v2`, `v3` for future runs; active runs continue executing against their admission version.

---

## 4. Realistic State Matrix (Predeclared Project Scenarios)

The prototype includes 8 predeclared scenarios accessible via the top Scenario Jumper:

| Scenario Key | Project | View / Task | Target State & Capability Evidenced |
|---|---|---|---|
| `proj-overview` | `proj-minesweeper` | Overview | Contract rules, wake policy toggle, memberships, bound workspaces, working groups |
| `proj-active-task` | `proj-minesweeper` | Tasks `#102` | Live running Agent run with 2-Stage Pause and Intentional Run Interrupt |
| `proj-validation-claim` | `proj-minesweeper` | Tasks `#101` | Completion claim validation with test report evidence (Accept / Require correction) |
| `proj-blocker` | `proj-minesweeper` | Tasks `#103` | Routable blocker with reason, required action, responsible actor, and advance resolution |
| `proj-proposal` | `proj-minesweeper` | Tasks `#105-prop` | Proposed task with non-resource validation and Human Approve & Begin authority |
| `proj-recovery` | `proj-minesweeper` | Tasks `#104` | Interrupted run on Windows host with lease locked in ordinary recovery |
| `proj-archived` | `proj-docs-portal` | Overview | Archived read-only project with preserved workspaces and history |
| `proj-chat` | `proj-minesweeper` | Chat | Project discussion stream, working group channel filtering, and routing inspector |

---

## 5. Phone & Desktop Capability Parity

- **Mobile Viewport (390px simulated iPhone):**
  - Sticky top header with brand and operator connection status.
  - Sticky bottom navigation with dynamic Project sub-nav pills (`[ Overview | Tasks (N) | Chat ]`).
  - Minimum 44px touch targets on all interactive controls.
  - Horizontal scrollable task carousel with active border highlighting.
  - Bottom action bar for pause, interrupt, resume, and discard actions.
  - Touch-friendly modal sheets for new proposals, members, and working groups.
- **Desktop Viewport:**
  - Left navigation sidebar providing clear separation between Operations, Project, Management, and Primitives.
  - Multi-column overview grid (Contract, Memberships, Bound Workspaces, Working Groups).
  - Expandable nested agent runs timeline with syntax-highlighted event streams.
  - Deep-link return banner (`← Back to Feed`) when navigating from Attention items.

---

## 6. Accepted Decisions, Rejected Patterns & Unresolved Questions

### Accepted Decisions
1. **Multi-View Project Navigation:** Project concerns are partitioned into `Overview`, `Tasks`, and `Chat` rather than one flat tab.
2. **Human Authority for Task Begin/End:** Proposals hold NO lease and run NO agents; Human Approve & Begin acquires lease; Safe Task End releases lease.
3. **Autonomous Multi-Run Execution:** Task lead coordinates sequential agent runs under the Task-held lease without per-run Human approval.
4. **Two-Stage Pause & Intentional Run Interrupt:** Stage 1 admission hold lets active run settle naturally; Stage 2 intentional stop halts agent immediately.
5. **Routable Blockers:** Blockers require reason, required next action, responsible actor, and who advances when cleared.
6. **Completion Claims & Human Validation:** Formal evidence presentation with Accept Safe End vs Require Correction.
7. **Non-Destructive Historical Preservation:** Ending memberships, disbanding working groups, and archiving projects preserves all history, messages, and files on host.

### Rejected Patterns
1. **One-Screen Flat Project Tab:** Cramming task lists, agent definitions, contract, and chat into one scrollview breaks mobile usability.
2. **Automatic Task Begin on Proposal:** Allows unmonitored acquisition of scarce host environment capacity.
3. **Collapsing Task, Run, and Lease into One Status:** Conflates agent execution with environment resource ownership.
4. **Instant Hard Stop on First Pause:** Destructive when a cooperative turn could complete safely.
5. **Automatic Terminal Failures on Run Interruption:** Interrupted runs enter recovery and keep lease locked to prevent work loss.
6. **Hard Deletion of Memberships, Workspaces, or Projects:** Destroys historical audit trails.

### Unresolved Questions
1. **Multi-Task Concurrency per Environment:** ADR-0005 strictly enforces one active Task lease per Environment instance.
2. **Working Group Creation Policy:** In M2, any Project member can create a Working Group; the creator is automatically added as its initial member.
