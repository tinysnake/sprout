# Sprout M2 Chat Scopes & Wake-Routing Inspection Prototype (Ticket #64)

## Summary

This retained prototype artifact documents the design, interaction models, decision evidence, and architectural boundaries for **Chat Scopes and Wake-Routing Inspection** in the Sprout M2 Local Operator product (Ticket #64, Scope #44). It builds directly upon the shared shell baseline (#61), Feed & Attention baseline (#62), and Multi-View Project baseline (#63), preserving the message and wake-routing semantics settled in ADR-0007 and the project/agent management journeys settled in ADR-0008.

The interactive prototype artifact is executable via `npm run prototype` (serving `web/prototype/index.html` on `0.0.0.0:41000`), with full DOM test coverage in `web/src/prototype/chat.dom.test.ts` and `web/src/prototype/project.dom.test.ts`.

---

## 1. Three Explicit Conversation Scopes

Under ADR-0008 and ADR-0007, routine collaboration is organized into three strictly bounded conversation scopes rather than an undifferentiated chat stream or global cross-project DMs:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ PROJECT CHAT TOPOLOGY (ADR-0008)                                            │
│                                                                             │
│ 1. PROJECT BROADCAST CHANNEL (#general)                                     │
│    ├── Participants: All current Project members (Human + Agents)          │
│    ├── Policy: Project Wake Policy (Explicit-Only vs Wake-Model-Assisted)   │
│    └── Addressing: @all broadcast, exact @agent mentions, unaddressed batch │
│                                                                             │
│ 2. WORKING GROUP CHANNELS (e.g. Core Mechanics WG, WebAudio Effects WG)    │
│    ├── Participants: Subset of current Project members                      │
│    ├── Lifecycle: Active vs Disbanded (Non-destructive read-only archive)   │
│    └── Provenance: WG rules & goals injected into 1-round agent runs        │
│                                                                             │
│ 3. PROJECT-SCOPED DIRECT MESSAGES (@Programmer, @Designer, @Planner)        │
│    ├── Participants: 1-on-1 between Operator and a Project Agent            │
│    ├── Scope: Strictly scoped to one Project (no cross-project leakage)     │
│    ├── Addressing: 100% Deterministic (always bypasses wake model & window) │
│    └── Ended Membership: Preserved as read-only history; sending disabled   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Scope Characteristics & Invariants

| Scope Kind | Participants | Addressing & Wake Semantics | Read-Only Safeguard |
|---|---|---|---|
| **Project Channel (`#general`)** | All current Project members | Governed by Project wake policy (`explicit-only` vs `wake-model-assisted`). Exact mentions & `@all` route deterministically; unaddressed inputs enter fixed 30s collection window under assisted policy. | Archived project makes channel read-only. |
| **Working Group Channel** | Subset of current Project members | Governed by Project wake policy for WG members. Creator is automatically enrolled upon creation. | Disbanded WG makes channel read-only while preserving all history and configuration for potential restore. |
| **Project-Scoped Direct Message** | Operator + 1 specific Project Agent | **100% Deterministic addressing**. Always wakes the recipient immediately, completely bypassing wake policy and collection windows. | Ended agent membership makes DM read-only, preserving attribution and historical messages. |

---

## 2. Deterministic Addressing vs. Wake-Model-Assisted Batching

ADR-0007 establishes a strict separation between deterministic addressing and probabilistic wake-model evaluation:

```
                  ┌─────────────────────────────────────────────────────────┐
                  │                 INCOMING COLLABORATION INPUT             │
                  └────────────────────────────┬────────────────────────────┘
                                               │
                       Is input explicitly addressed?
                       (Direct DM, @agent mention, @all, or assigned event)
                                       /               \
                                    YES                 NO
                                    /                     \
        ┌───────────────────────────────────────┐   ┌───────────────────────────────┐
        │       DETERMINISTIC ADDRESSING        │   │    PROJECT WAKE POLICY CHECK  │
        │ • Bypasses wake policy & window       │   └───────────────┬───────────────┘
        │ • Deduplicates targets                │                   │
        │ • Author never woken by own message   │        Is policy Wake-Model-Assisted?
        │ • Produces immediate WakeRequest      │            /                     \
        └───────────────────────────────────────┘          YES                      NO
                                                           /                         \
                          ┌────────────────────────────────────────┐     ┌──────────────────────┐
                          │     30-SECOND COLLECTION WINDOW        │     │    EXPLICIT-ONLY     │
                          │ • Opens on 1st eligible input          │     │ • Persisted as       │
                          │ • Fixed duration (no debounce starvation)│    │   informational      │
                          │ • Freezes batch manifest               │     │ • Wakes NO agents    │
                          └───────────────────┬────────────────────┘     └──────────────────────┘
                                              │
                          ┌───────────────────┴────────────────────┐
                          │   WAKE-MODEL EVALUATION (1 Call/Batch) │
                          │ • Evaluates frozen context bounds      │
                          │ • Assigns inputs to 0+ agents          │
                          │ • Coalesces: max 1 WakeRequest / agent │
                          └────────────────────────────────────────┘
```

### Addressing Invariants
1. **Direct DM**: Direct messages always route as `addressed` and wake the recipient immediately.
2. **Exact Mentions**: `@Programmer` wakes only `@Programmer`, evaluated as whole tokens (e.g. `@forge` does not match `@forge-two`).
3. **`@all` Broadcast**: Wakes every active agent member in the Project except the author.
4. **Author Exclusion**: The author is never woken by their own message.
5. **Deduplication**: When an input contains multiple mentions of the same agent, targets are deduplicated to produce a single wake request.

---

## 3. Fixed 30s Collection Windows & Routing Batches

Under `wake-model-assisted` routing:
- **Fixed Window**: The first eligible unaddressed input opens a fixed 30-second collection window.
- **Why Fixed (Not Debounce)**: ADR-0007 specifically rejected reset-on-message debounce windows, because a continuously active channel would never close its window, causing latency starvation.
- **Single Model Call per Batch**: When the window closes, Sprout freezes the batch snapshot and invokes the low-cost wake model (`gpt-4o-mini`) exactly once for all messages in the batch.
- **Coalescing per Agent**: Even if 5 messages in the batch select the Programmer, the Programmer receives **at most one `WakeRequest` and one Agent run**, receiving all assigned messages chronologically. This prevents burst conversations from spinning up redundant, expensive work-model runs.

---

## 4. Strict Privacy Boundaries & Context Manifest Exclusions

Under ADR-0007 and ADR-0008, the wake model receives only curated Project-shared facts. The prototype explicitly verifies and visualizes this privacy boundary in the Causal Routing Inspector:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ FROZEN ROUTING CONTEXT MANIFEST (ADR-0007)                                  │
├──────────────────────────────────────┬──────────────────────────────────────┤
│ ✅ INCLUDED IN ROUTING CONTEXT       │ ❌ STRICTLY EXCLUDED (PRIVACY BOUNDARY)│
├──────────────────────────────────────┼──────────────────────────────────────┤
│ 1. Batch inputs (ID, author, text)   │ 1. Direct Messages & DM histories    │
│ 2. Project Contract (Goal & Rules)   │ 2. Agent private memory & scratchpads│
│ 3. Candidate Agent responsibilities  │ 3. Engine sessions & raw transcripts │
│ 4. Recent Project channel messages   │ 4. Tool call outputs & stdin/stdout  │
│ 5. Public Task state summaries       │ 5. Overlay/engine credentials & keys │
│ 6. Non-routing projected replies     │ 6. Host paths & private network facts│
│                                      │ 7. Transient Environment capacity    │
└──────────────────────────────────────┴──────────────────────────────────────┘
```

> **Why Transient Environment Capacity is Excluded:** Transient worker disconnection or busy status must never cause the wake model to silently substitute a different agent for the one whose declared Project responsibility best matches the user's input.

---

## 5. Automatic Retry & Fail-Closed Semantics

When evaluating a routing batch:
1. **Transient Failure Handling**: If the wake model times out, returns malformed JSON, or fails schema validation, Sprout automatically retries **once** using the exact same frozen context manifest.
2. **Fail-Closed Guarantee**: If the second attempt also fails:
   - Sprout **fails closed**: zero agents are woken.
   - All input messages remain intact and durable in the channel.
   - A durable routing failure record is stored and visible in the causal inspector.
   - **Why Fail-Closed (Not Fail-Open)**: ADR-0007 rejected failing open to all members, because model failure would result in massive, uncontrolled agent fan-out and token burn.
3. **Deliberate Suppression**: When the model successfully decides that an unaddressed message requires no agent action (e.g. casual conversational chatter), it records `suppressed`. This is a deliberate, durable decision, not a failure, and is not retried.

---

## 6. Durable Projected Replies & Loop Prevention

When an Agent completes a run triggered by a message or wake request:
- Sprout projects **only the completed run's final assistant text** as a durable message in the channel.
- **Non-Routing Tag**: The projected reply is stamped with `disposition: non-routing` and displays the `Projected Reply · Non-Routing` badge.
- **Loop Prevention Boundary**: Automatic projected replies **cannot open collection windows or trigger wake evaluations**, even if their generated text contains `@all` or agent mentions.
- **Provenance Links**: Each projected reply retains explicit links to its triggering input message, Agent Run ID (`#run-202`), and WakeRequest ID (`#wake-02`).

---

## 7. Observational Causal Evidence (No Manual Routing Controls)

In accordance with ADR-0007:
- The Local Operator MVP provides **no routing-specific manual controls** (no manual "Route now" or "Retry routing" buttons, and no manual pending-wake override buttons).
- All routing evidence is **purely observational and inspectable**, providing complete causal visibility from input message $\rightarrow$ collection window $\rightarrow$ context manifest $\rightarrow$ model attempt $\rightarrow$ model rationale $\rightarrow$ WakeRequest admission $\rightarrow$ linked Agent run $\rightarrow$ projected reply.
- Operators can communicate naturally via standard composition (e.g. sending a direct message or explicit mention if immediate attention is desired).

---

## 8. Phone & Desktop Parity & Realistic State Matrix

### Responsive Viewport Parity
- **Phone Viewport (390px simulated iPhone)**:
  - *Level 1 (Chat List)*: Full-screen categorized scope cards (`Project Channels`, `Working Groups`, `Direct Messages`) with unread counter badges and last message previews.
  - *Level 2 (Chat Detail)*: Full-screen conversation timeline, sticky `← Back to Chats` header button with native browser history integration (`pushState`/`popstate`), conversation information button opening modal scope details, and streamlined bottom composer.
- **Desktop Viewport**:
  - *Split-Pane Layout*: Left column (310px) categorized scope cards; Right column conversation detail with sticky header, active window banner, message stream, and rich composer.

### 10 Predeclared Scenario Presets (Accessible via Scenario Jumper)

| Scenario Key | Scope / Target | Condition & Verified Capability |
|---|---|---|
| `chat-project-broadcast` | `#general` | Normal active broadcast stream with mixed human messages, unaddressed batches, and projected replies. |
| `chat-working-group` | `Core Mechanics WG` | Active Working Group channel with sub-team member list, goal, and rules. |
| `chat-direct-message` | `@Programmer` | 1-on-1 direct message channel with deterministic addressing. |
| `chat-batch-open` | `#general` | Active 30s collection window with countdown timer and pending queued inputs. |
| `chat-batch-inspect-selected` | `batch-002` | Causal Inspector for settled batch selecting `@Designer` with model rationale and projected reply. |
| `chat-batch-inspect-suppressed` | `batch-003` | Causal Inspector for batch with deliberate suppression (0 agents selected; conversational chatter). |
| `chat-batch-inspect-failed` | `batch-004` | Causal Inspector for batch failing closed after 2 failed model attempts (timeout + validation error). |
| `chat-empty-scope` | Empty project | Empty state UI with clear onboarding prompt. |
| `chat-disbanded-wg` | `WebAudio Effects WG` | Disbanded Working Group with read-only banner, preserved history, and Restore WG action. |
| `chat-ended-membership` | `@Researcher` | Direct message with ended agent membership showing read-only state and preserved messages. |

---

## 9. Accepted Decisions, Rejected Patterns & Unresolved Questions

### Accepted Decisions (Ticket #64, ADR-0007, ADR-0008)
1. **Three-Tier Scope Partitioning**: Project Broadcast, Working Groups, and Project-Scoped Direct Messages.
2. **Deterministic Addressing Precedence**: Direct DMs, exact `@agent` mentions, and `@all` bypass wake policy and collection windows.
3. **Fixed 30s Collection Window**: Fixed window avoids debounce starvation and batches burst inputs.
4. **Non-Routing Projected Replies**: Projected output cannot become automatic input, preventing recursive loops.
5. **Automatic Retry & Fail-Closed Fallback**: 2 attempts maximum; fails closed with durable error.
6. **Strict Privacy Boundaries**: DMs, private memory, sessions, transcripts, credentials, host paths, and transient capacity excluded from routing context.
7. **Observational Evidence Only**: No manual route-now or retry buttons in MVP.
8. **Non-Destructive Lifecycles**: Disbanding WGs and ending memberships preserve full history and attribution.

### Rejected Patterns
1. **Manual "Route Now" or "Retry Routing" Buttons**: Rejected; invites operator micro-management into deterministic scheduling.
2. **Fail-Open Fan-Out to All Agents**: Rejected; creates uncontrolled operational cost and token burn.
3. **Global Cross-Project Direct Messages**: Rejected; violates project contract and audit boundaries.
4. **Automatic Wake Routing of Projected Replies**: Rejected; causes infinite wake loops.
5. **Debounce Reset-on-Message Window**: Rejected; starves active channels indefinitely.
6. **Hard Deletion of Groups or DMs**: Rejected; damages historical traceability.
7. **Permanent Quick-Mention Chips & In-Composer Addressing Feedback Pills**: Rejected per owner review in favor of a clean, uncluttered composer; deterministic addressing and collection windows remain governed by ADR-0007 invariants.

### Unresolved Questions
1. **Working Group Creation Authority**: In M2, any Project member can create a Working Group; creator is automatically enrolled.
2. **Collection Window Duration Tuning**: Defaulted to 30 seconds per ADR-0007; configurable per project template.
