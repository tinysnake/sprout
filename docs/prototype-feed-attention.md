# Sprout M2 Feed & Attention Experience Prototype (Ticket #62)

## Summary

This retained artifact documents the design, interaction models, decision evidence, and architectural boundaries for the **Feed & Attention Experience** in the Sprout M2 Local Operator product (Ticket #62, part of Scope #44). It builds upon the shared mobile-first shell baseline settled in Ticket #61 and ADR-0006 through ADR-0010, refined through owner grilling.

The interactive prototype artifact is executable via `npm run prototype`, with full DOM test coverage in `web/src/prototype/feed.dom.test.ts`.

---

## 1. Bounded Scope: Owned vs. Excluded Concerns

| Bounded Owned Concerns (Ticket #62) | Excluded Downstream Concerns (Owned by Module Tickets #63-#68) |
|---|---|
| **Feed Landing Surface:** Primary cross-project entry point for discovery and situational awareness. | **Task Authority & Run Workflows (#63):** Authorizing task begin, 2-stage pause/interrupt, versioning edits, completing or rejecting validation claims. |
| **Human Attention Section:** Concrete separation of urgent, actionable human interventions from routine background logs. | **Chat & Communication Workflows (#64):** Authoring project messages, creating working groups, causal routing batch inspector. |
| **Scope & Project Filtering:** Scalable Scope Dropdown (`[ All Projects (4) ▾ ]`) plus dynamic urgent Project quick-chips that only surface projects with active attention. | **Environment Lifecycle Workflows (#65):** Approving worker enrollment, editing permissions, triggering emergency Force Release. |
| **Prioritization & Multi-Modal Tiers:** 4 streamlined urgency tiers (`All`, ` Action Req.`, `[Yellow] Attention`, `[Blue] Info/Notices`) with dynamic counters. | **Global Agent Definitions (#66):** Configuring work options, editing standing instructions, memory management. |
| **Contextual Discovery & Transcolation:** Disambiguated lifecycle sentences (`Task · Run · Lease`), actor attribution, why attention is needed, and transcolation of infrastructure issues blocking project tasks. | **Usage & Cost Analysis (#67):** 6-view telemetry filtering, billing rates, token reconciliation. |
| **Deep-Link Delegation:** Navigating directly to authoritative domain surfaces with sticky `← Back to Feed` return breadcrumbs and filter state preservation. | **Settings & Operator Identity (#68):** Private transport settings, diagnostics, fourth tab naming. |
| **Live In-Flight Work Snapshot:** Real-time visibility into active tasks and running agent turns across environments. | |
| **Recent Operational Activity Stream:** Chronological background audit stream strictly scoped to selected project with category filters. | |

---

## 2. Mental Model: Human Attention vs. Ordinary Feed Content

The Feed experience establishes an explicit, concrete distinction between **Human Attention Items**, **In-Flight Work**, and **Operational Activity Events**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 0. PROJECT / SCOPE FILTER BAR (Dropdown + Dynamic Urgent Chips)             │
│    ├── Dropdown: [ 📂 All Projects (4 pending) ▾ | 🎮 O7 Minesweeper (3) |  Infrastructure (1) ]   │
│    └── Dynamic Chips: [ All (4) ] [ 🎮 O7 Minesweeper [Red]2 [Yellow]1 ] [  Infrastructure [Yellow]1 ]    │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. PROMINENT HUMAN ATTENTION QUEUE (Urgent, Actionable, Sorted by Urgency)   │
│    ├── 4 Urgency Pills: [ All (4) | [Red] Action Req. (2) | [Yellow] Attention (2) | [Blue] Proposals (0) ] │
│    ├── [Red] Action Required: Blocker permissions, Lease recovery, Host offline │
│    ├── [Yellow] Attention Needed: Validation claims, Pending worker enrollment    │
│    └── [Blue] Info / Pending Notice: Proposed tasks awaiting begin authority     │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. LIVE IN-FLIGHT WORK SNAPSHOT (Real-Time Background Execution)             │
│    └── Pulsing Active Tasks: Running agent, Engine/Model, Duration, Env     │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. RECENT OPERATIONAL ACTIVITY STREAM (Chronological Historical Stream)      │
│    └── Background Activity: Completed turns, Messages, Routing, Heartbeats   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### The Strict Discovery & Non-Ownership Boundary

Under ADR-0006, ADR-0008, and ADR-0009:
- The Feed **discovers and contextualizes work**; it **never executes domain actions inline**.
- Attention cards present the full causal reason why operator intervention is needed, along with attribution and lifecycle state.
- Clicking an Attention card or its action button (e.g. `Review Claim in Tasks →`, `Inspect Recovery in Tasks →`, `Review Enrollment in Envs →`) deep-links directly to the authoritative domain surface (`Project > Tasks` or `Manage > Environments`), pre-selecting the entity, preserving Feed filter state, and mounting the `← Back to Feed` return banner.
- **Why this boundary is critical:** Embedding validation claim approval buttons or Force Release triggers directly on Feed cards risks accidental execution without reviewing detailed Playwright test transcripts, diffs, or environment logs.

---

## 3. Scope Filtering & Multi-Dimensional Convergence

During interactive grilling, the filtering architecture was unified into a three-tiered model:

1. **Top Scope Selector Dropdown (`<select id="feed-scope-select">`):**
   - **Unified Scope Dropdown:** Houses all projects and infrastructure in one clean, scalable control (`[ 📂 All Projects (4 pending) ▾ ]`, `[ 🎮 O7 Minesweeper (3 pending) ]`, `[  Sprout Core (0 pending) ]`, `[  Infrastructure (1 pending) ]`).
   - Completely eliminates duplicate pills/chips beneath the dropdown, ensuring zero redundant filter UI across phone and desktop.
   - **Infrastructure Event Transcolation Rule:** Infrastructure issues directly blocking or recovering a project's task (e.g. a recovery environment holding Task #104 lease) transcolate into that project's filtered Attention view, ensuring the operator sees the root cause. Generic environment enrollments appear only under `All` and `Infrastructure`.
   - **Lightweight Project Clear Banner:** Selecting a project with 0 attention items displays a clean green banner (`[Pass] <Project>: All clear, system running autonomously`), without hiding its active in-flight tasks or scoped activity stream.
2. **Attention Urgency Pills (Dynamic Counter AND Intersection):**
   - Streamlined into 4 distinct pills: `All`, `[Red] Action Req.`, `[Yellow] Attention`, `[Blue] Info/Notices`.
   - Counters dynamically recalculate based on the active Project Scope.
3. **Activity Event Stream Scoping:**
   - When a project is selected, the operational activity stream strictly scopes to events belonging to that project.

---

## 4. Realistic 7-State Matrix Verification

The prototype provides 1-click state matrix switching (housed in the top Prototype Harness bar and Review Drawer) to verify that the Feed renders truthfully and robustly across all representative operational conditions:

| State Preset | Operational Condition | Attention Items | In-Flight Work | Primary Visual Cue |
|---|---|---|---|---|
| **1. Mixed (Default)** | Realistic multi-agent workflow | 4 items (Validation, Recovery, Blocker, Enrollment) | 1 active task running | Red/Yellow severity cards + Pulsing active task |
| **2. Empty (All Clear)** | 0 pending interventions | 0 items | 0 active tasks | Green checkmark empty state box ("All Attention Items Cleared") |
| **3. Healthy Active** | Work progressing smoothly | 0 blockers | 2 active tasks running | Pulsing active tasks (Three.js rendering + Sound FX synthesis) |
| **4. Stale Telemetry** | Worker heartbeat overdue >14m | 2 items (Stale host, Unconfirmed lease) | 1 unconfirmed task | Amber warning cards + Stale heartbeat notices |
| **5. Pending Approvals** | Proposed work & enrollment | 3 items (2 proposed tasks, 1 enrollment) | 0 active tasks | Blue info cards (Awaiting Human Begin Authorization) |
| **6. Degraded Host** | Windows host offline + engine issue | 3 items (Offline host, Codex login-required, Wake fallback) | 1 recovery task | Red alert cards + Textual degraded health reasons |
| **7. Intervention** | Blocker + Validation claim | 2 items (Audio asset permission + Task #101 claim) | 0 active tasks | High-contrast action-required cards with evidence summaries |

---

## 5. Phone & Desktop Capability Parity

1. **Phone Viewport (390px simulated):**
   - Compact Scope Dropdown + Dynamic Urgent Chips scrollable horizontally with touch inertia.
   - 4 Streamlined Urgency Pills with dynamic counters.
   - Bottom navigation bar with live attention badge counter (`4`).
   - Deep linking preserves context and renders a sticky `← Back to Feed` return banner at top of destination view, returning to exact project scope.
   - All interactive touch targets meet or exceed the 44px accessibility floor.
2. **Desktop Viewport:**
   - Left navigation sidebar with live attention counter and status dots.
   - Layout options: Variant A (Unified Stream), Variant B (Split Board), Variant C (Project Grouped).
   - Top Prototype Harness bar housing State Matrix and Layout selectors cleanly outside the product canvas.

---

## 6. Accepted Decisions, Rejected Patterns & Unresolved Questions

### Accepted Decisions (Ticket #62)

1. **Strict Discovery & Context Boundary:** Feed is discovery/context only; all domain actions are delegated to authoritative domain surfaces via deep links with `← Back to Feed` return breadcrumbs and filter state preservation.
2. **Unified Scope Selector Dropdown:** Scalable Project Scope dropdown with active attention counts, eliminating duplicate chips.
3. **Three-Tier Feed Structure:**
   - *Prominent Attention Section* (Top): Prioritized by urgency (`Action Required` → `Attention` → `Info`), with 4 streamlined urgency pills.
   - *Live In-Flight Work Snapshot* (Middle): Pulsing live status of executing tasks and agent runs across environments.
   - *Recent Operational Activity Stream* (Bottom): Chronological background audit stream strictly scoped to selected project.
4. **Multi-Modal Attention Cues:** High-contrast severity borders (Red `--red-action`, Yellow `--yellow-attention`, Blue `--accent-primary`), category icons, disambiguated lifecycle sentences (`Task · Run · Lease`), and textual "Why attention is needed" reasons.
5. **Infrastructure Transcolation:** Project-blocking host issues transcolate into that project's view.
6. **7-State Realistic Matrix:** Instantaneous preview of Mixed, Empty, Healthy, Stale, Pending, Degraded, and Intervention states via top harness bar.
7. **Clean Production Canvas Separation:** Prototype review controls (State Matrix & Layout switcher) are moved to the top Harness Bar and Review Drawer.

### Rejected Patterns

1. **Inline Domain Action Execution in Feed:** Rejected; embedding validation claim acceptance buttons, force-release triggers, or task pause buttons directly in Feed risks accidental clicks without inspecting evidence, diffs, or logs.
2. **Single Flat Timeline without Attention Isolation:** Rejected; mixing critical blockers with routine heartbeat logs risks missing human-action-required events.
3. **Color-Only Urgency Signals:** Rejected; attention items must pair color with distinctive category icons, severity badges, and textual reasons.
4. **Standalone Disjoint Attention Destination:** Rejected in #60 & #61; attention belongs prominently within the Feed cross-project landing surface.
5. **Duplicate Scope Filter Pills alongside Dropdown:** Rejected in #62 grilling; having both a dropdown and chips sitting side-by-side creates redundant UI clutter. A single clean dropdown is adopted.

### Unresolved Questions & Implementation Notes

1. **Feed Polling vs. Server-Sent Push Rate:** The prototype uses an in-memory reactive state stream; production M2 implementation will settle WebSocket vs. SSE subscription rates for low-latency push on mobile.
2. **Attention Item Dismissal / Snooze Policy:** Whether non-critical warnings (e.g. stale telemetry notice) can be temporarily snoozed by the operator or must always remain until underlying health recovers.

---

## 7. Downstream Module Reuse Rules (#63-#68)

1. **#63 (Project View):** Integrates Task-level deep-link landing targets, claim verification cards, and 2-stage pause/interrupt controls.
2. **#64 (Chat):** Integrates Project and Working Group deep-link landing targets and causal routing inspectors.
3. **#65 (Environments):** Integrates Worker enrollment and degraded health deep-link landing targets, with traffic lights and emergency Force Release.
4. **#66 (Agents):** Integrates Agent work option inspection.
5. **#67 (Usage & Costs):** Integrates Usage milestone deep-link targets into the 6-view telemetry table.
6. **#68 (Settings):** Settles final fourth Manage tab label (`General`, `Operator`, or `Settings`).
