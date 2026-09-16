# Sprout M2 Shared Mobile-First Shell & Style Baseline

## Summary

This baseline settles the shared visual language, responsive application framing, and interaction primitives for the Sprout M2 Local Operator experience (Ticket #61). It implements the product hierarchy and architectural boundaries settled in #60 grilling and ADR-0006 through ADR-0010.

The interactive prototype artifact is accessible at `web/prototype/index.html` via `npm run prototype`, with full DOM verification in `web/src/prototype/shell.dom.test.ts`.

---

## 1. Product Hierarchy & Navigation Containers

The product organizes navigation into three primary destinations ordered by routine operating frequency, rather than a flat multi-tab list:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. FEED (Cross-Project Landing Surface)                                     │
│    ├── Prominent Human Attention Section (Urgent approvals, recovery)      │
│    └── Recent Operational Activity Stream (Live agent/worker telemetry)    │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. PROJECT (Project Workspace & Coordination)                              │
│    ├── Project Selector & Metadata Snapshot                                 │
│    ├── Overview (Contract, rules, bound workspaces, memberships)           │
│    ├── Tasks (Task authority, runs, 2-stage pause/interrupt, validation)    │
│    └── Chat (Project channel, working groups, DMs, routing evidence)       │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. MANAGE (Lower-frequency management via accessible Gear control)          │
│    ├── Tab 1: Environments (Enrollment, health, readiness, Force Release)   │
│    ├── Tab 2: Agents (Global definitions, standing instructions, options)  │
│    ├── Tab 3: Usage & Costs (Observability across 6 views, API estimates)   │
│    └── Tab 4: Settings (Operator identity, overlay, diagnostics, recovery)  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. STYLE BASELINE / PRIMITIVES (Design System Testbed)                      │
│    └── Interactive token, component, and state language showcase            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Responsive Framing & Device Parity

- **Phone (390px viewport):**
  - Sticky top header with brand and operator connection pill (`online` / `reconnecting`).
  - Sticky bottom navigation bar with `Feed` (with attention badge), `Project` (with task badge), and `Manage` (gear icon with degraded alert dot).
  - Inside `Project`: top segmented bar for `[Overview | Tasks | Chat]`.
  - Inside `Manage`: top sub-navigation bar for `[Environments | Agents | Usage & Costs | Settings]`.
  - Mobile bottom sheets slide up from the bottom with drag handles and touch-friendly controls.
- **Desktop Viewport:**
  - Left navigation sidebar providing clear separation between *Operations*, *Project*, *Management*, and *Design Baseline*.
  - Multi-column cards and slide-over inspector sheets for deep dive.
- **Deep Linking & Return Breadcrumb:**
  - When navigating from `Feed` attention items into `Project > Tasks` or `Manage > Environments`, a prominent `← Back to Feed` return banner appears, allowing one-click return to the operator's starting context.

---

## 2. Design Tokens & Visual Language

All styles are defined via semantic CSS variables supporting high-contrast **Dark Theme (Default)** and **Light Theme**:

| Token Role | Dark Theme | Light Theme | Usage |
|---|---|---|---|
| `--bg-app` | `#0a0e17` | `#f8fafc` | Application canvas base |
| `--bg-surface` | `#131b26` | `#ffffff` | Primary cards, headers, sidebars |
| `--bg-surface-elevated` | `#1a2534` | `#f1f5f9` | Modal dialogs, popovers, nested containers |
| `--border-subtle` | `#243245` | `#e2e8f0` | Dividers, card borders, list borders |
| `--border-strong` | `#384c66` | `#cbd5e1` | Focus outlines, active borders |
| `--text-primary` | `#f1f5f9` | `#0f172a` | High-contrast headings and body copy |
| `--text-secondary` | `#94a3b8` | `#475569` | Metadata, subtitles, descriptions |
| `--text-muted` | `#64748b` | `#64748b` | Timestamps, character counters, captions |
| `--accent-primary` | `#38bdf8` | `#0284c7` | Interactive sky blue (primary buttons, links) |
| `--green-ready` | `#10b981` | `#059669` | Healthy status, completed tasks |
| `--yellow-attention` | `#f59e0b` | `#d97706` | Attention required, degraded health |
| `--red-action` | `#ef4444` | `#dc2626` | Offline workers, blockers, destructive actions |
| `--purple-agent` | `#a855f7` | `#7c3aed` | Agent validation, member attribution |

### Typography Scale & Grid

- **Font Stacks:** Sans-serif (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`) and Monospace (`ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas`).
- **Scale:** Caption (`11-12px`), Body Regular (`13-14px`), Subhead (`15-16px`), Section Header (`17-18px`), Title (`22-24px`).
- **Spacing Grid:** 4px grid (`4px`, `8px`, `12px`, `16px`, `20px`, `24px`, `32px`).
- **Density Modes:** `Comfortable` (default, min 44px touch targets) and `Compact` (denser tables/lists).

---

## 3. Shared Interaction Primitives

The interactive testbed (`web/src/prototype/views/primitives-view.ts`) exercises all shared UI controls:

1. **Buttons (`.btn`):**
   - Variants: `.btn-primary`, `.btn-secondary`, `.btn-danger`, `.btn-ghost`, `.btn-outline`.
   - Sizes: `.btn-sm` (32px), `.btn-md` (38px), `.btn-lg` (44px touch floor).
   - States: Hover, active, `:disabled`, and `.loading` (inline spinning loader with `aria-busy="true"`).
2. **Form Controls:**
   - `.form-input`, `.form-select`, `.form-textarea` (with char count).
   - `.search-input-wrapper` with clear button (`✕`).
   - `.switch-control` for toggling wake policies and options.
   - `.has-error` with inline `.form-error` message and alert icon.
3. **Cards & Lists:**
   - `.card` with distinct `.card-header`, `.card-body`, `.card-footer`.
   - `.card-kpi` metric tiles for live metrics.
   - `.list-item-interactive` with avatar/leading icon, title, subtitle, status tag, and `.list-item-chevron`.
4. **Sheets, Modals & High-Risk Danger Dialogs:**
   - `.bottom-sheet` (mobile slide-up drawer with `.sheet-drag-handle`).
   - `.modal-dialog` (desktop centered overlay).
   - `.danger-confirm-dialog` (emergency override requiring typed confirmation phrase before destructive button activates, e.g. `FORCE RELEASE`).
   - `.inspector-sheet` (slide-over panel for causal routing batch inspection and run telemetry).

---

## 4. Shared State Language

1. **Health Indicators (Traffic Light + Mandatory Textual Reason):**
   - Status indicators must NEVER rely on color alone. Every health dot is paired with an independent textual explanation:
     - 🟢 **Healthy:** `All 4 engine readiness probes confirmed · Lease clear`
     - 🟡 **Degraded:** `1/4 engine offline (Codex login-required) · Reconnecting`
     - 🔴 **Offline:** `Heartbeat timed out 8m ago · Retained lease blocked`
2. **Disambiguated Lifecycle Sentence (ADR-0006):**
   - `Task state · Agent run state · Task lease state`
   - Explicitly separates nested Agent run progress (`running` / `stopped` / `completed`) from environment lease ownership (`held` / `recovery` / `released`).
3. **Lifecycle Pills:**
   - `Active` (pulsing blue dot), `Idle` (gray), `Paused` (amber), `Blocked` (amber), `Awaiting Validation` (purple), `Completed` (green), `Interrupted` (red), `Failed` (red).
4. **Provenance & Attribution Tags:**
   - Human Operator badge (`👤 Lead Tech`), Agent badge (`🤖 Programmer · Pi claude-3-5-sonnet`), Worker host tag (`🖥️ Mac Studio`), and Timestamp with relative time and ISO tooltip.
5. **Edge States:**
   - Loading shimmer skeleton lines (`.skeleton-line`).
   - Empty state box (`.empty-state-box`) with friendly icon, description, and primary call to action.
   - Stale telemetry warning banner (`.state-banner.warning`).
   - Lease conflict alert banner (`.state-banner.danger`).

---

## 5. Accessibility Floors

- **Touch Target Floor:** All interactive controls on mobile enforce minimum height `44px` or sufficient touch padding.
- **Focus Rings:** `:focus-visible` renders a 2px high-contrast sky-blue outline with 2px offset.
- **Non-Color State Cues:** All statuses pair color with distinctive icon shapes, text labels, and border accents.
- **Semantic ARIA Roles:** `role="tablist"`, `role="tab"`, `role="dialog"`, `role="alertdialog"`, `aria-label`, `aria-busy`.

---

## 6. Accepted Baseline Decisions vs Rejected Patterns

| Accepted Baseline Decisions | Rejected Patterns |
|---|---|
| 3-destination hierarchy: Feed, Project, Manage (with gear control) | 7-tab flat navigation bar |
| Human Attention prominent inside Feed landing surface | Disjoint standalone top-level Attention module |
| Full phone/desktop capability parity with mobile bottom sheets | Read-only mobile fallback |
| Traffic light paired with mandatory textual reason | Color-only status dots without text explanation |
| 3-part disambiguated sentence (`Task · Run · Lease`) | Conflating Task, Run, and Lease into one status |
| Explicit typed confirmation for high-risk overrides (Force Release) | Blind single-click destructive actions |
| Shared token & component baseline for downstream module tickets | Silent style forking across module tickets |

---

## 7. Downstream Module Reuse Rules (#62-#68)

Subsequent focused prototype tickets MUST reuse this shared shell baseline:

1. **#62 (Feed & Attention):** Mounts inside `Feed`; builds upon the Attention card primitives, severity badges, and deep-link return patterns.
2. **#63 (Project View):** Mounts inside `Project`; reuses the segmented sub-nav, Task lifecycle cards, and 2-stage pause/interrupt controls.
3. **#64 (Chat):** Mounts inside `Project > Chat`; reuses message styling, projected reply banners, and slide-over routing inspectors.
4. **#65 (Environments):** Mounts inside `Manage > Environments`; reuses traffic-light health indicators with textual reasons, and the danger Force Release confirmation dialog.
5. **#66 (Agents):** Mounts inside `Manage > Agents`; reuses global Agent cards and work option selectors.
6. **#67 (Usage & Costs):** Mounts inside `Manage > Usage & Costs`; reuses the 6-view filter and truthful API-equivalent cost tables.
7. **#68 (Settings):** Mounts inside `Manage > Settings`; settles between `General`, `Operator`, or `Settings` as the final 4th tab label.
