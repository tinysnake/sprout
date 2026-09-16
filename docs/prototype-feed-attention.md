# Sprout M2 Feed & Attention Experience Prototype (Ticket #62)

## Summary

This retained artifact documents the design, interaction models, decision evidence, and architectural boundaries for the **Feed & Attention Experience** in the Sprout M2 Local Operator product (Ticket #62, part of Scope #44). It builds upon the shared mobile-first shell baseline settled in Ticket #61 and ADR-0006 through ADR-0010.

The interactive prototype artifact is executable via `npm run prototype` (serving `web/prototype/index.html` on `0.0.0.0:41000`), with full DOM test coverage in `web/src/prototype/feed.dom.test.ts`.

---

## 1. Bounded Scope: Owned vs. Excluded Concerns

| Bounded Owned Concerns (Ticket #62) | Excluded Downstream Concerns (Owned by Module Tickets #63–#68) |
|---|---|
| **Feed Landing Surface:** Primary cross-project entry point for discovery and situational awareness. | **Task Authority & Run Workflows (#63):** Authorizing task begin, 2-stage pause/interrupt, versioning edits, completing or rejecting validation claims. |
| **Human Attention Section:** Concrete separation of urgent, actionable human interventions from routine background logs. | **Chat & Communication Workflows (#64):** Authoring project messages, creating working groups, causal routing batch inspector. |
| **Prioritization & Grouping:** Urgency tiers (`Action Required` [Red], `Attention Needed` [Yellow], `Info Notice` [Blue]) with category filters. | **Environment Lifecycle Workflows (#65):** Approving worker enrollment, editing permissions, triggering emergency Force Release. |
| **Contextual Discovery:** Disambiguated lifecycle sentences (`Task · Run · Lease`), actor attribution, and explicit "Why attention is needed" explanations. | **Global Agent Definitions (#66):** Configuring work options, editing standing instructions, memory management. |
| **Deep-Link Delegation:** Navigating directly to authoritative domain surfaces with sticky `← Back to Feed` return breadcrumbs. | **Usage & Cost Analysis (#67):** 6-view telemetry filtering, billing rates, token reconciliation. |
| **Live In-Flight Work Snapshot:** Real-time visibility into active tasks and running agent turns across projects. | **Settings & Operator Identity (#68):** Overlay network settings, diagnostics, fourth tab naming. |
| **Recent Operational Activity Stream:** Chronological background audit stream with category filters (Tasks, Chat, Envs, Cost). | |

---

## 2. Mental Model: Human Attention vs. Ordinary Feed Content

The Feed experience establishes an explicit, concrete distinction between **Human Attention Items** and **Operational Activity Events**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. PROMINENT HUMAN ATTENTION QUEUE (Urgent, Actionable, Sorted by Urgency)   │
│    ├── 🔴 Action Required: Blocker permissions, Lease recovery, Host offline │
│    ├── 🟡 Attention Needed: Validation claims, Pending worker enrollment    │
│    └── 🔵 Info / Pending Notice: Proposed tasks awaiting begin authority     │
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
- Clicking an Attention card or its action button (e.g. `Review Claim in Tasks →`, `Inspect Recovery in Tasks →`, `Review Enrollment in Envs →`) deep-links directly to the authoritative domain surface (`Project > Tasks` or `Manage > Environments`), pre-selecting the entity and mounting the `← Back to Feed` return banner.
- **Why this boundary is critical:** Embedding validation claim approval buttons or Force Release triggers directly on Feed cards risks accidental execution without reviewing detailed Playwright test transcripts, diffs, or environment logs.

---

## 3. Layout Exploration Paradigms

The prototype implements an interactive Layout Paradigm Switcher to evaluate three competing structural models:

1. **Variant A: Unified Urgency-First Stream (Primary / Default)**
   - Single vertical stream with three clearly tiered sections: Attention Queue at top, Active In-Flight Work in the middle, Filterable Activity Stream below.
   - Recommended for mobile-first scanning and consistent top-to-bottom reading on both phone and desktop.
2. **Variant B: Split Operator Board (Dual-Stream Desktop / Tabbed Mobile)**
   - *Desktop:* Two balanced side-by-side columns: Left column = Attention Queue + Active Work; Right column = Live Activity Stream.
   - *Mobile (390px):* Segmented top switcher `[ Attention (4) | Live Activity (8) ]` providing single-column focus without vertical crowding.
3. **Variant C: Project-Grouped Feed (Per-Project Containers)**
   - Aggregates the feed into Project Cards (e.g. `O7 Minesweeper`, `Sprout Core Framework`), grouping project-specific attention, active tasks, and latest messages, with a shared Infrastructure card at bottom.

---

## 4. Realistic 7-State Matrix Verification

The prototype provides 1-click state matrix switching to verify that the Feed renders truthfully and robustly across all representative operational conditions:

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
   - Horizontal category filter chips (`All`, `Action Required`, `Validation`, `Blockers`, `Recovery`, `Envs`, `Proposed`) with smooth touch scrolling.
   - Bottom navigation bar with live attention badge counter (`4`).
   - Deep linking preserves context and renders a sticky `← Back to Feed` return banner at top of destination view.
   - All interactive touch targets meet or exceed the 44px accessibility floor.
2. **Desktop Viewport:**
   - Left navigation sidebar with live attention counter and status dots.
   - Rich multi-column split board and wide activity streams.
   - Keyboard navigation and instant scenario jumping.

---

## 6. Accepted Decisions, Rejected Patterns & Unresolved Questions

### Accepted Decisions (Ticket #62)

1. **Strict Discovery & Context Boundary:** Feed is discovery/context only; all domain actions are delegated to authoritative domain surfaces via deep links with `← Back to Feed` return breadcrumbs.
2. **Three-Tier Feed Structure:**
   - *Prominent Attention Section* (Top): Prioritized by urgency (`Action Required` → `Attention` → `Info`), with category filter chips.
   - *Live In-Flight Work Snapshot* (Middle): Pulsing live status of executing tasks and agent runs across environments.
   - *Recent Operational Activity Stream* (Bottom): Chronological background audit stream with category filters (Tasks, Chat, Envs, Cost).
3. **Multi-Modal Attention Cues:** High-contrast severity borders (Red `--red-action`, Yellow `--yellow-attention`, Blue `--accent-primary`), category icons, disambiguated lifecycle sentences (`Task · Run · Lease`), and textual "Why attention is needed" reasons.
4. **7-State Realistic Matrix:** Instantaneous preview of Mixed, Empty, Healthy, Stale, Pending, Degraded, and Intervention states.
5. **Default Feed Layout Variant:** *Variant A: Unified Stream* is accepted as the primary default; *Variant B (Split Board)* is accepted for widescreen desktop environments.

### Rejected Patterns

1. **Inline Domain Action Execution in Feed:** Rejected; embedding validation claim acceptance buttons, force-release triggers, or task pause buttons directly in Feed risks accidental clicks without inspecting evidence, diffs, or logs.
2. **Single Flat Timeline without Attention Isolation:** Rejected; mixing critical blockers with routine heartbeat logs risks missing human-action-required events.
3. **Color-Only Urgency Signals:** Rejected; attention items must pair color with distinctive category icons, severity badges, and textual reasons.
4. **Standalone Disjoint Attention Destination:** Rejected in #60 & #61; attention belongs prominently within the Feed cross-project landing surface.

### Unresolved Questions & Implementation Notes

1. **Feed Polling vs. Server-Sent Push Rate:** The prototype uses an in-memory reactive state stream; production M2 implementation will settle WebSocket vs. SSE subscription rates for low-latency push on mobile.
2. **Attention Item Dismissal / Snooze Policy:** Whether non-critical warnings (e.g. stale telemetry notice) can be temporarily snoozed by the operator or must always remain until underlying health recovers.

---

## 7. Downstream Module Reuse Rules (#63–#68)

1. **#63 (Project View):** Integrates Task-level deep-link landing targets, claim verification cards, and 2-stage pause/interrupt controls.
2. **#64 (Chat):** Integrates Project and Working Group deep-link landing targets and causal routing inspectors.
3. **#65 (Environments):** Integrates Worker enrollment and degraded health deep-link landing targets, with traffic lights and emergency Force Release.
4. **#66 (Agents):** Integrates Agent work option inspection.
5. **#67 (Usage & Costs):** Integrates Usage milestone deep-link targets into the 6-view telemetry table.
6. **#68 (Settings):** Settles final fourth Manage tab label (`General`, `Operator`, or `Settings`).
