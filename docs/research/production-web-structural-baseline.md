# Research report: Production Web structural and UI-language contract

**Issue:** [#72](https://github.com/tinysnake/sprout/issues/72) (part of Map [#70](https://github.com/tinysnake/sprout/issues/70))
**Research date:** 2026-09-19
**Fixed base:** `ea0c660cff96d2845aab492305085a9e2739a348`
**Status:** evidence and a proposed inheritance contract for the representative
Vue slice (#74). It selects no product behaviour beyond what #44, ADR-0006
through ADR-0011, and the retained #61–#68 artifacts already accepted.

Terminology follows `CONTEXT.md`: Project, Project channel, Working group,
Project-scoped direct message, Task, Agent run, Task lease, Environment
instance, Usage activity, Attention-style Human decision. Where this report
needs a UI word the glossary does not own (card, primitive, token, inspector),
it says so explicitly and keeps the Glossary term for anything that carries
domain meaning.

This report separates **observed facts** (with file and line evidence) from
**recommendations** (what production should do). Recommendations are labelled.

---

## 1. What the prototype is, and what it is not

Observed facts:

- The prototype is a plain-TypeScript, direct-DOM renderer: `web/src/prototype/prototype.ts`
  re-renders the whole `#prototype-app` subtree from a snapshot on every state
  notification (`prototype.ts` lines ~17–28, ~460–520).
- Fixture state lives in one large mutable `StateManager` in
  `web/src/prototype/state.ts` (approximately 6,800 lines) with fixture
  collections: 7 Agents, 6 Environment instances, 3 Projects, 8 Tasks,
  15 Messages, 4 Routing batches, 10 Usage activities, 6 Attention items,
  8 Activity items.
- The fixture layer also simulates behaviour (projected replies on timers,
  disconnect/reconnect transitions, wake-request terminalization). This is a
  decision artifact, not a domain layer.
- Structural language is carried by one stylesheet, `web/src/prototype/prototype.css`
  (5,574 lines, 17 CSS sections), plus inline `style="..."` attributes inside
  the view modules.
- Prototype-only surfaces exist inside the product canvas: the top control bar
  (`proto-control-bar`: viewport switcher, theme and density toggles, operator
  pill, Style Baseline button, Owner Review button), the review drawer
  (`views/review-drawer.ts`, ~410 lines of Ticket/ADR acceptance checklists),
  and the Ticket/ADR copy embedded in feature surfaces (for example
  `view-primitives`, "Baseline invariant" notes naming ADR-0008/ADR-0009).
- Reachability check performed in this Ticket: 6 of 23 non-test prototype
  modules are unreachable from `prototype.ts` — `variants/variant-a.ts`,
  `variants/variant-b.ts`, `variants/variant-c.ts`,
  `components/variant-switcher.ts`, `views/attention-view.ts`,
  `views/onboarding-view.ts`. They are dead exploration code retained in the
  repository.

Recommendation: treat the prototype as a **structure and language source** and
never as a code source. No prototype file, class name, or CSS rule is promoted
verbatim; ADR-0011 already fixes this.

---

## 2. Inventory of the accepted structure

The inventory below is grouped by the destination or pattern the operator
actually uses. "Preserve" claims the accepted information architecture and
interaction flow; "rewrite" means the same structure with a different
implementation; "remove" means it must not exist on a production surface.

### 2.1 Shell

Observed facts:

| Element | Evidence |
| --- | --- |
| Three destinations: Feed, Project, Manage | `prototype.ts` sidebar sections `OPERATIONS` / `PROJECT` / `MANAGE`; mobile bottom nav `data-nav="feed/project/manage"` |
| Desktop left sidebar with section labels | `prototype.ts` `.desktop-sidebar`, `.sidebar-section-label` |
| Mobile sticky bottom navigation with badges | `prototype.ts` `.mobile-bottom-nav`, `.bottom-nav-badge`, `.bottom-nav-dot` |
| Sub-navigation inside Project (Overview, Tasks, Chat) and Manage (Environments, Agents, Usage & Costs, Settings) | `prototype.ts` `mode-sub-nav` bottom bar; `views/projects-view.ts`, `views/manage-view.ts` |
| Entry/exit drill-down header replacing the destination header on phone | `views/environments-view.ts` `.mobile-detail-nav-header`, `views/agents-view.ts` `.mobile-detail-nav-header` |
| Deep-link return banner `← Back to Feed` | `prototype.ts` `.return-context-banner`, `#btn-pop-return` |
| Browser history integration for detail/list | `prototype.ts` `popstate` handler switching `task-detail`/`chat-detail`/`env-detail`/`agent-detail` states |
| Operator connection pill | `prototype.ts` `.operator-pill` with `online`/otherwise status dot |
| Theme (dark/light) and density (comfortable/compact) | `prototype.ts` `top-theme-btn`, `top-density-btn`; `prototype.css` `:root`/`[data-theme="dark"]`/`[data-theme="light"]` token blocks |

Notable observed gaps:

- `data-density` is written on the app element but **no CSS rule consumes it**
  (`grep -c data-density web/src/prototype/prototype.css` = 0). The Compact
  density announced in `docs/prototype-baseline.md` is not implemented.
- The top control bar (viewport switcher, theme/density toggles, Style Baseline,
  Owner Review) is prototype harness. It must be removed from production; theme
  may survive only as a user preference if production chooses one.

Recommendation (preserve, rewritten): the three-destination hierarchy, the
sidebar section grouping, the mobile bottom navigation, the nested sub-navigation
for Project and Manage, phone drill-down with a header back control, the
Feed return banner, and URL-addressable navigation. Theme becomes a
presentation preference owned by tokens; density is either implemented as a real
token dimension or dropped explicitly — it must not remain a declared-but-inert
attribute.

### 2.2 Feed

Observed facts (`web/src/prototype/views/feed-view.ts`, 866 lines):

- Three-tier landing surface: scope selector
  (`#feed-scope-select`, options include all Projects, per-Project, and
  Infrastructure) → Human Attention section → Live In-Flight Work →
  Recent Operational Activity.
- Attention severity tiers with counters: `all`, `action_required`,
  `attention`, `info` (`urgency-pill-btn`, `aria-pressed`).
- Activity stream category filters: `all`, `tasks`, `messages`, `envs`, `usage`.
- Attention cards carry severity left border, category icon, title, summary,
  disambiguated lifecycle sentence, responsible actor, relative time, and a
  deep-link action that navigates to the authoritative surface.
- Feed performs **no domain mutation**: no approve, pause, interrupt, or release
  control exists on a Feed card (confirmed by Owner-accepted text in
  `docs/prototype-feed-attention.md` §2, and by the absence of such handlers in
  `feed-view.ts`).
- Three layout variants exist (`unified`, `split-board`, `project-grouped`),
  switchable from harness state (`setFeedLayoutVariant`); the accepted default is
  `unified`.
- Empty states per section (`All Attention Items Cleared`).
- Project-scope selection cascades to Attention, Active Work, and Activity; the
  selected scope is preserved across a deep-link round trip.

Recommendation (preserve, rewritten): the tiered structure, the scope and
category filters, the "discovery only, no inline domain action" boundary, the
severity-plus-text language, and the deep-link/return contract. Remove the
layout-variant switching: production ships one Feed composition. Remove the
Feed scenario preset projection (`feedScenarioSnapshot`, `applyFeedPreset`, the
seven-state review matrix) and the harness control that drives it.

### 2.3 Project

Observed facts (`web/src/prototype/views/projects-view.ts`, 913 lines;
`docs/prototype-project-multiview.md`):

- Project selector plus project metadata snapshot.
- Overview sub-view: derived template source, editable goal and rules,
  wake-policy switch (`explicit-only` vs wake-model-assisted window),
  memberships with responsibilities and instructions, bound Environment
  workspaces with workspace root and relative path, communication scope cards,
  archive/restore with an active-work guard.
- Tasks sub-view (see 2.4).
- Chat sub-view (see 2.5).
- Non-destructive end-membership, Working group disband, and Project archive.
- Desktop = split pane; phone = list then detail with `← Back to Chats`.

Recommendation (preserve, rewritten): the three-sub-view Project partition, the
contract/goal/rules/wake-policy/membership/workspace sections, non-destructive
history, and responsive split↔drill-down. Remove embedded ADR/Ticket prose and
any "review evidence" panel.

### 2.4 Task

Observed facts (`web/src/prototype/views/tasks-view.ts`, 983 lines):

- Task list: a single filter `<select>` with counts (`all`, `active`,
  `validation`, `blocked`, `proposed`, `recovery`, `completed`), a responsive
  card grid (`role="listbox"`, `role="option"`, `tabindex="0"`), one card per
  Task with lifecycle pill, title clamp, goal clamp, lifecycle sentence, lead,
  environment, and a chevron.
- Task detail drill-down with `.mobile-detail-nav-header` on phone and
  `pushState`/`popstate` support.
- A collapsed-by-default **three-part lifecycle disambiguation** box:
  `Task state · Agent run state · Task lease state`, with an expandable detail
  list (`lifecycle-fold-header`, `aria-expanded`, `keydown` Enter/Space).
- Ordered operating stages: proposal (holds no lease, runs no Agent), Human
  approve-and-begin, multi-run lead execution, two-stage pause then intentional
  interrupt, routable blocker, completion claim and Human validation with accept
  versus require-correction, safe end, ordinary recovery (resume or discard),
  content versioning with history.
- `edgeCase`: Force Release is deliberately **absent** from the Task surface and
  lives only in Manage / Environments (confirmed by `grep` — the only
  `openInspector('force-release', …)` calls are in `environments-view.ts` and
  the Feed preset handler).

Recommendation (preserve, rewritten): every listed structure and control, with
its authority ordering unchanged (ADR-0006). The three-part lifecycle sentence
is a first-class shared primitive, not a Task-local block.

### 2.5 Chat

Observed facts (`web/src/prototype/views/chat-view.ts`, 1,228 lines;
`docs/prototype-chat-routing.md`):

- Three conversation scopes: Project channel (`#general`), Working group
  channels, Project-scoped direct messages — grouped into labelled sections in
  a left list pane with per-scope unread counters and last-message preview.
- Desktop = list + timeline + composer; phone = list, then detail with the
  header back control.
- Read-only reasons for archived Project, disbanded Working group, ended
  membership, and archived Agent, each with an explanatory sentence and a
  disabled composer.
- Message attribution, projected-reply marking, causal-chain reference, and an
  **on-demand** routing inspector triggered by an `i` control beside the
  timestamp (the "always-visible tags" variant is explicitly rejected in
  `docs/prototype-chat-routing.md` §9).
- The routing inspector (`views/inspector-view.ts` `kind === 'routing'`) shows
  batch identity, window, wake model and attempt count, frozen-context manifest
  with privacy exclusions, attempt history with fail-closed note, per-input
  model decisions labelled "model judgement, not fact", resulting WakeRequests
  with terminal status, and a footnote stating there are no manual routing
  controls.
- The active collection-window banner was removed from the timeline per Owner
  review.

Recommendation (preserve, rewritten): the three scopes, the grouped list,
read-only explanations, on-demand inspection, and the inspector's evidence
sections in that order. Remove the hardcoded unread fixture map and the
`chat-batch-window-banner` rule that is no longer rendered.

### 2.6 Environments

Observed facts (`web/src/prototype/views/environments-view.ts`, 891 lines;
`docs/prototype-environments-recovery.md`):

- Manage tab; header with title and two icon-only actions (Register host,
  Bootstrap guide).
- Five discrete filter boxes with counts: All, Ready, Attention, Action
  required, Archived, each `aria-pressed` and carrying an `sr-only` count.
- Desktop split layout: master card list (platform icon, display name, neutral
  host context, traffic-light dot with `aria-label`, two-line decisive reason
  snippet, connection/protocol/lease chips, plus a quick probe action) and a
  detail column.
- Detail sections in order: traffic-light summary banner with mandatory
  textual reason, six independent health dimensions (enrollment, connection,
  protocol, work safety, capability permissions, engine readiness), bound
  Project workspaces, then exactly one of reconciling / recovery / active lease
  / forced-release audit, then an operations toolbar, then probe history.
- Phone: master list to full-screen detail with a non-floating back header.
- Force Release requires three independent gates: an unresolved-facts manifest,
  a mandatory typed reason, and both a risk-acknowledgement checkbox and the
  typed phrase `FORCE RELEASE` before the button enables.
- Recovery offers Resume on the same host or Discard (safe Task end).
- Reconcile step appears after reconnect and states what evidence was
  synchronized.

Recommendation (preserve, rewritten): all of the above. This is the slice #74
must validate; the acceptance contract is in §9.

### 2.7 Agents

Observed facts (`web/src/prototype/views/agents-view.ts`, 1,474 lines):

- Manage tab; header with icon-only Create and Guide actions; five filter boxes
  (All, Active, Attention, Unavailable, Archived).
- Desktop split; phone drill-down; same lifecycle as Environments.
- Agent detail: identity with stable id, display name, avatar monogram,
  description, standing instructions, private-memory **entry count only**;
  ordered work options (engine, work model, effort, configured flag) with
  add/reorder/delete and a minimum-one guard (`disabled` with an explanatory
  title); environment compatibility with per-environment ineligibility reasons;
  pre-acceptance fallback simulation; four foldable evidence boxes (environment
  compatibility, Project memberships, version changelog/history, attribution
  trace); archive/restore under a safety guard.
- Privacy: no host paths or credentials appear; the detail shows a neutral
  local-context label.

Recommendation (preserve, rewritten): the structure, the ordering semantics,
the minimum-one-option guard, the compatibility reasons, and the
non-destructive archive. Keep foldables only for genuinely on-demand evidence;
the primary facts stay open.

### 2.8 Usage and Costs

Observed facts (`web/src/prototype/views/usage-view.ts`, 752 lines;
ADR-0010 §Required views):

- Six views over one semantics contract: Agent run, Task, Project, Agent, Model,
  Time range, presented as `usage-view-tabs` with `role="tablist"` and
  `aria-selected`.
- Cross-filters for Project, Agent, model, and range (`today`, `7d`, `30d`).
- Work-model Agent runs and Project-owned Routing attempts are never merged;
  Project view shows them as separate subtotal cards; Task and Agent views
  exclude Routing attempts and say so.
- Aggregate cards expose tokens, model activity duration, API-equivalent
  estimate, and a coverage strip; provenance is shown per activity
  (`provider_estimated`, `harness_calculated`, `locally_estimated`), and billed
  cost is always shown as unavailable.
- Ongoing activity is provisional and excluded from finalized totals; unavailable
  duration keeps a known subtotal but marks coverage incomplete.
- Model grouping key includes source, provider, and version, not only the model
  name.
- Empty state after filtering is real, not a zero row.

Recommendation (preserve, rewritten): the six views, the work/routing
separation, coverage and provenance labelling, and the drill-down to activity
evidence. ADR-0010 §Product-surface boundary leaves chart choice and pixel
layout to the product shell — so production must choose a chart or table
strategy per view, and that is the one place this inventory deliberately does not
prescribe layout.

### 2.9 Settings

Observed facts (`web/src/prototype/views/settings-view.ts`, 218 lines;
`docs/prototype-settings-operator.md`):

- One page in Manage / Settings with three authoritative categories behind
  sub-tabs: Access & Security, Instance & System, Data & Diagnostics.
- A status strip above the tabs (`role="button"`, `tabindex="0"`,
  `aria-label`) summarising operator access, instance compatibility, and the
  migration guard; each item also switches category.
- Cards: operator identity and access boundary facts, browser sessions with
  per-session revoke and revoke-others, host-local credential recovery with a
  risk-gated rotation, instance/protocol/schema compatibility, transactional
  migration with safety-copy status and failure visibility, durable-data
  relative location with a copy action, sanitized diagnostics with included and
  excluded facts and a host-local fallback, and a Web-versus-host boundary list.
- Six-state coverage matrix: normal, loading, warning, unavailable, failure,
  risk-bearing.
- Review evidence lives in collapsible `<details>` blocks below the categories.
- No Force Release and no Environment recovery control appears here.

Recommendation (preserve, rewritten): the three categories, the status strip,
the fact/boundary split, the six-state coverage, and the "no duplicate recovery
control" rule. **Remove** the review-evidence and state-coverage `<details>`
blocks from the production surface — they are owner-review artifacts, not
product content. The state coverage must instead be exercised by tests and by
the real states the backend can produce.

### 2.10 Primitives testbed

Observed fact: `views/primitives-view.ts` (643 lines) is an interactive
catalogue of tokens, buttons, forms, cards, lists, sheets, dialogs, state
language, and accessibility floors. It is reachable from the harness
(`#top-primitives-btn`) and asserted by `shell.dom.test.ts`.

Recommendation: **remove from production.** Its content is the source for §4
(tokens, primitives, state language) and its assertions move into primitive-level
tests, not into a shipped route.

---

## 3. Preserve / rewrite / remove matrix

Legend: **P** preserve structure and behaviour; **R** preserve intent, rewrite
implementation; **X** remove from production.

| # | Surface or pattern | Disposition | Note |
| --- | --- | --- | --- |
| 1 | Three destinations Feed / Project / Manage | P | ADR-0011 and #44 |
| 2 | Sidebar section grouping and mobile bottom nav | R | Vue Router; badges stay |
| 3 | Project and Manage nested sub-navigation | R | URL-addressable, not renderer state |
| 4 | Phone drill-down with header back control | R | Real routes plus history |
| 5 | `← Back to Feed` return context | R | Preserve scope and filter on return |
| 6 | Theme dark/light tokens | R | Token dimension; keep both themes |
| 7 | Density comfortable/compact | R or X | Currently inert; implement or drop explicitly |
| 8 | Feed tiering: scope → attention → in-flight → activity | P | |
| 9 | Feed severity tiers and category filters | R | |
| 10 | Feed discovery-only boundary (no inline domain action) | P | Owner-accepted |
| 11 | Feed layout variants (unified/split/project-grouped) | X | Ship one composition |
| 12 | Feed seven-state preset projection (harness) | X | Fixture review device |
| 13 | Project Overview / Tasks / Chat partition | P | |
| 14 | Project contract, membership, workspace sections | R | |
| 15 | Task list filter, grid, drill-down | R | |
| 16 | Three-part lifecycle disambiguation sentence | P | Promote to shared primitive |
| 17 | Task proposal/begin/run/pause/interrupt/blocker/claim/validation/end/recovery stages | P | ADR-0006 authority order |
| 18 | Force Release absent from Task surface | P | Stays in Environments |
| 19 | Three Chat scopes with grouped list | P | |
| 20 | Read-only reasons for archived/ended/disbanded | R | |
| 21 | On-demand routing inspector with `i` affordance | P | |
| 22 | Always-visible routing tags/countdown banners | X | Owner-rejected |
| 23 | Environment master/detail, filters, six dimensions, textual traffic light | P | Slice scope |
| 24 | Force Release three-gate confirmation | P | |
| 25 | Recovery resume/discard and reconcile step | P | |
| 26 | Agents work options, compatibility, archive guard | P | |
| 27 | Usage six views, work/routing separation, coverage, provenance | P | Chart choice open |
| 28 | Settings three categories and boundary facts | P | |
| 29 | Settings review-evidence and state-matrix details | X | Owner-review artifact |
| 30 | Primitives catalogue route | X | Becomes tests |
| 31 | Prototype control bar (viewport/theme/density/review/Style Baseline) | X | Harness |
| 32 | Owner review drawer | X | Harness |
| 33 | Ticket/ADR copy inside feature surfaces | X | e.g. "ADR-0008 & ADR-0009" captions |
| 34 | Dead variant modules and switcher | X | Unreachable today |
| 35 | Fixture `StateManager` as domain layer | X | ADR-0011 |
| 36 | Inline `style="..."` presentation inside view markup | X | Replace with tokens/utilities |
| 37 | Simulation controls ("Simulate Disconnect", "Simulate macOS Host") | X | Harness |
| 38 | Hardcoded unread counters and fixture previews | X | Need a real source or removal |
| 39 | `scenarioLog`, `loadScenarioPreset`, preset switchboard | X | Harness |
| 40 | Onboarding wizard view | X (for now) | Unreachable; ADR-0008 first-run journey must be re-planned as production work, not inherited from this dead view |

Removal evidence to cite in the acceptance comment is in §8.

---

## 4. UI-language classification

### 4.1 Tokens

Observed: `prototype.css` defines `:root`/`[data-theme="dark"]` and
`[data-theme="light"]` blocks with these roles: `--bg-app`, `--bg-surface`,
`--bg-surface-elevated`, `--bg-surface-glass`, `--border-subtle`,
`--border-strong`, `--border-focus`, `--text-primary/secondary/muted/inverse`,
`--accent-primary(-hover)`, `--accent-bg`, `--accent-border`, `--green-ready`,
`--yellow-attention`, `--red-action`, `--purple-agent` (each with `-bg` and
`-border` companions), `--font-sans`, `--font-mono`, `--radius-xs…full`,
`--touch-target` (44px), and `--shadow-sm/md/lg`.

Recommendation: these roles become Tailwind CSS 4 `@theme` variables in
Sprout's own namespace so utilities and hand-written rules read the same
authority. Sprout keeps the role names and the two-theme contract; the raw
hex values may be retuned. Do not adopt another design system's semantic token
names. A `--radius` anchor with a multiplicative ladder (as Paperclip uses) is a
reasonable implementation shape, but the Sprout ladder is Sprout's choice.

### 4.2 Primitives (behaviour-level)

Observed primitive set, with usage counts from the view modules:

- Buttons: `.btn` with `primary`, `secondary`, `danger`, `ghost`, `outline`
  and sizes `sm`(32px) `md`(38px) `lg`(44px), plus `:disabled` and `.loading`
  with `aria-busy`. Evidence: `primitives-view.ts`, `prototype.css` §9.
- Forms: `.form-input`, `.form-select`, `.form-textarea`, `.form-helper`,
  `.form-error`, `.has-error`, `.search-input-wrapper` with clear button,
  `.switch-control`/`.switch-slider`/`.switch-label`, `.segmented-control`.
- Selection surfaces: filter pill boxes (`filter-pill`, `urgency-pill-btn`,
  `activity-filter-pill-btn`, `env-filter-box-btn`, `agent-filter-box-btn`) with
  `aria-pressed` and `sr-only` counts; tab strips (`sub-nav-tabs`,
  `usage-view-tabs`, `settings-sub-tabs`) with `role="tablist"`/`role="tab"`/
  `aria-selected`.
- Cards and lists: `.card` (`header`/`title`/`body`/`footer`),
  `.card-kpi` (`label`/`value`/`trend`), `.list-group`/`.list-item`
  (`-interactive`, `-leading`, `-body`, `-title`, `-subtitle`, `-trailing`,
  `-chevron`).
- Overlays: `.dialog-overlay` + `.modal-dialog`, `.bottom-sheet` with
  `.sheet-drag-handle`, `.danger-confirm-dialog`, `.inspector-overlay` +
  `.inspector-sheet`, `.proto-modal-backdrop` + `.proto-modal-dialog`.
- Disclosure: `.foldable-card`/`.foldable-header`/`.foldable-body` with
  `role="button"` + `aria-expanded`, and `<details>`-based
  `.settings-disclosure`.
- Feedback: `.state-banner.warning`/`.danger`, `.skeleton-line`,
  `.empty-state-box`, `.sr-only`.

Recommendation: split these into three tiers.

1. **Headless behaviour primitives** — dialog, alert dialog, sheet/drawer,
   popover, tooltip, menu, select/combobox, tabs, switch, checkbox, radio
   group, scroll area, accordion/collapsible, roving focus. Source these from
   Reka UI (root and sub-components) and only wrap them where Sprout adds
   language or composition.
2. **Sprout presentation primitives** — Button, Input/Textarea/Select chrome,
   Field/Label/Helper/Error, Badge, StatusDot, StatusPill, LifecyclePill,
   ProvenanceTag, Card shell, ListRow, KpiTile, StateBanner, Skeleton, EmptyState,
   FilterPillGroup, SubNav, SectionHeading, MetadataRow, Foldable.
3. **Domain modules** — see 4.4.

### 4.3 Shared patterns/templates

Observed recurring compositions worth naming as templates rather than as
conditional components:

- **Master/detail workspace**: filter box row + master card list + detail column
  (Environments, Agents) and phone list→detail drill-down. Same skeleton across
  two domains with different card bodies and different action sets.
- **Evidence-before-action**: every destructive or irreversible action is
  preceded by facts (unresolved-facts manifest, coverage strip, ineligibility
  reason, session list).
- **Typed confirmation for irreversible actions**: typed phrase + risk
  acknowledgement + reason (Force Release; single-click destructive actions are
  explicitly rejected).
- **State sentence + pills**: a human sentence plus independent status pills
  (`Task state · Agent run state · Task lease state`) instead of one merged
  status.
- **On-demand inspection**: an `i` control or a foldable that reveals durable
  evidence without adding a permanent column.
- **Deep-link discovery with return context**: Feed item → authoritative surface
  with preserved filters and a return banner.

Recommendation: implement these as composable patterns driven by slots and
explicit props (for example a `MasterDetailWorkspace` with `list` and `detail`
slots, a `ConfirmDangerAction` with typed-phrase configuration), not as
behaviour-switching mega-components.

### 4.4 Domain modules

Observed: the prototype has no module boundary — one stylesheet and one state
object serve every view. Domain meaning is still discernible:

- **Environment module**: traffic light + textual reason, six-dimension health
  block, capability permissions, engine readiness, probe history, recovery and
  Force Release.
- **Task module**: three-part lifecycle, operating stages, run timeline, content
  versions, blocker, completion claim.
- **Message module**: scope identity, author attribution, projected reply,
  causal chain, routing evidence inspector.
- **Attention module**: severity, category, reason, target, lifecycle sentence,
  action label and target destination.
- **Agent module**: identity, work options ordering, compatibility, archive,
  attribution history.
- **Usage module**: activity, token dimensions, duration, valuation, coverage,
  provenance, aggregation kinds.
- **Project module**: contract, wake policy, memberships, workspaces, scope
  cards.

Recommendation: each domain module owns its card/list/detail variant, its
actions, and its status vocabulary. Cross-module reuse happens in the layers
below (headless primitives and presentation primitives), never by making the
domain card generic.

### 4.5 View-specific exceptions

Observed exceptions that are legitimately not shared:

- Task lifecycle disambiguation box (only Tasks have three nested lifecycles).
- Force Release dialog (only Environments).
- Usage six-view tab contract and coverage strip (only Usage).
- Settings status strip and Web-versus-host boundary list (only Settings).
- Chat scope grouping with per-scope unread (only Chat).
- Routing causal-chain inspector (only Chat/Project).

Recommendation: keep these as view-owned compositions. They may reuse the
primitives, but they must not be generalized.

### 4.6 Observed inconsistencies to resolve during rewrite

These are defects of the prototype's language, not of its structure:

- Classes used in markup but **never defined** in the stylesheet:
  `badge-success` (5 uses), `badge-danger` (7), `badge-warning` (4),
  `badge-secondary` (2), `badge-blue` (2), `btn-warning` (6), `btn-xs` (7).
  The defined families are `badge-{info,green,yellow,red,purple}`,
  `btn-{primary,secondary,danger,ghost,outline}` with `-{sm,md,lg}`, and
  `status-pill.{green,yellow,red,purple,blue,gray}`. Meanwhile `status-pill
  neutral` appears 13 times with no matching rule.
- Declared-but-inert token: `data-density`.
- Rules with no remaining markup reference: `scenario-select`, `project-nav-bar`,
  `project-select-wrapper`, `project-sub-nav-tabs`, `sub-nav-tabs`,
  `sub-nav-icon`, `sub-nav-icon-wrapper`, `sub-nav-label`, `nav-tab-badge`,
  `mention-chip-btn`, `task-carousel*`, `task-filter-bar`, `task-filter-pill`,
  `tasks-header-row`, `task-detail-top-nav`, `lifecycle-pills-wrap`,
  `prim-section-num`, `usage-detail-hint`, `usage-time-coverage`. `proto-icon`
  is the default class emitted by `renderIcon`, so its rule is live even though
  no view writes the name directly. `chat-batch-window-banner` survives only as
  CSS plus a test asserting its absence.
  (`settings-matrix-*` is the exception: those rules are live, because
  `settings-view.ts` emits `settings-matrix-${item.key}`.)
- Inline styles carry layout that should be tokens: `env-traffic-light-banner`
  background/border/padding are computed inline in
  `environments-view.ts`, and `agents-view.ts` repeats the pattern.
- Eight distinct CSS media widths coexist (`520`, `640`, `680`, `768`, `769`,
  `840`, `859`, `860`), and several mobile rules are written
  twice — once under `@media` and once under `.viewport-stage.mode-mobile`
  (for example the whole `settings-*` mobile block).

Recommendation: production defines a small breakpoint set as Tailwind theme
values, and mobile variants exist once. A lint or a build-time check that fails
on undefined utility classes would have caught the `badge-*`/`btn-*` drift.

---

## 5. Convergent card behaviour (no universal Card)

Observed card families and what they actually share:

| Card | Structure | Shared with others |
| --- | --- | --- |
| `.attention-card` | severity left border, icon+category row, title, summary, lifecycle sentence, footer with reason and action | severity border, header row, footer row |
| `.active-task-card` | accent left border, title row, task summary, action row | severity border, header row |
| `.task-grid-card` | status left border, title clamp, goal clamp, meta row, chevron | left border, header, meta |
| `.env-master-card` | platform icon, name/context, traffic dot, reason clamp, chip row, quick action | left/status accent, header, chip row |
| `.chat-scope-card` | avatar, title + timestamp + unread, preview clamp | header row, preview clamp, active ring |
| `.nested-run-card` | run identity, engine/model/effort, duration, tokens, events | meta grid, foldable body |
| `.card-kpi` | label, value, trend | value scale, label style |
| `.card` | header/title/body/footer shell | the shell itself |
| `.foldable-card` | header, chevron, body | disclosure behaviour |
| `.settings-card` | header with icon+title+description, badge, body | header composition |

Genuinely shared, and therefore worth extracting as primitives:

- **Card shell**: surface background, subtle border, radius, shadow, overflow.
- **CardHeader**: title plus optional leading icon and trailing meta/action slot.
- **CardBody/Footer** with consistent padding and divider rules.
- **StatusAccent**: a left border or leading bar driven by a severity token
  (`green|yellow|red|blue|purple|neutral`).
- **MetaChipRow**: a wrapping row of Badge/StatusPill chips.
- **ClampedText**: one or two line clamp with a `title` attribute.
- **InteractiveCardAffordance**: hover elevation, active ring, pointer cursor,
  focus ring, and full-card keyboard activation.

Not shared, and must stay domain-owned:

- Which facts appear on the card, in what order, and with what wording.
- Identity block (avatar monogram vs platform icon vs status dot).
- The action set and whether an action is inline, quick, or a drill-down.
- Severity semantics: Environment `red` means unavailable/recovery; Task `red`
  means blocked/recovery; Agent `red` means no available work option. These are
  different truths expressed with the same token.

Therefore the recommendation is: a **Card shell + header + status accent +
meta row + clamped text + interactive affordance** composition, and **no
`Card` component with a `variant`/`kind` prop that switches domain bodies**.
The prototype's `paperclip` reference does exactly this split (a `Card` with an
`interactive` boolean and separate `CardHeader/CardTitle/CardContent/CardFooter`)
and it is the closest reference shape; see §7.

`AttentionCard`, `EnvironmentMasterCard`, `TaskGridCard`, `ChatScopeCard`,
`AgentMasterCard`, `NestedRunCard`, `KpiTile`, `SettingsCard`, and `FoldableCard`
are Sprout domain compositions built from those primitives.

---

## 6. Stack mapping

ADR-0011 fixes: Vue 3.5 SFCs + TypeScript + Vite; Vue Router; bounded Pinia;
Tailwind CSS 4 via the first-party Vite integration with CSS-first theme
variables; Reka UI for headless primitives; selective adoption of shadcn-vue
source; Sprout authoritative over tokens, status language, density, domain
composition, and responsive hierarchy.

Concrete mapping recommendations:

- **Tokens**: define Sprout roles in `@theme`; dark and light remain the two
  themes; expose spacing/density as a small set of token values rather than a
  parallel density system unless density is really implemented.
- **Layout and responsive composition**: Tailwind utilities at the point of
  composition (grid, flex, gap, padding, clamp), one small breakpoint set, and
  mobile/desktop structure expressed as distinct templates where the accepted
  design is genuinely different (phone drill-down vs desktop split).
- **Behaviour**: Reka UI primitives for dialog, alert dialog, drawer/sheet,
  popover, tooltip, menu, select/combobox, tabs, switch, checkbox, radio group,
  scroll area, accordion/collapsible, roving focus, focus scope, visually hidden.
  These cover focus management, dismissal, escape handling, and roving focus —
  all of which the prototype currently **does not implement** (§6.1).
- **shadcn-vue source adoption**: adopt the *wrapper* pattern (thin SFC around a
  Reka primitive, `cn()` class merging, `data-slot` attributes, slot-based
  composition), but Sprout supplies its own class strings and token names. Do
  not import shadcn-vue's default theme, radius ladder, or colour values.
  Adopt only what is needed: button, input, textarea, select, checkbox, switch,
  dialog, alert-dialog, sheet/drawer, popover, dropdown-menu, tabs, tooltip,
  scroll-area, collapsible, badge/skeleton as starting points.
- **Authority retained by Sprout**: status vocabulary and severity→token mapping,
  lifecycle sentences, density/touch floor, card composition per domain,
  responsive hierarchy, and the privacy rules in §8.
- **State boundaries**: authoritative Project/Task/Message/Environment/Agent/
  Usage/lease/routing facts arrive through typed ports and adapters; Pinia holds
  bounded cross-page UI state only (for example selected destination, theme);
  view-local state (open foldable, active filter) stays in the view module.
  The prototype's `StateManager` must not be ported (§3 rows 35, 39).

### 6.1 Inherited gap list that the stack must close

Observed prototype gaps that production must fix, because external primitives
make them cheap and the acceptance contract (§9) requires them:

- No `Escape` handling for any overlay (`grep -rn Escape web/src/prototype` finds
  only an HTML-escaping comment).
- No focus trap, no focus restore, no `inert`/background isolation for the 18
  `role="dialog"`/`aria-modal` overlays.
- No `aria-live` region anywhere (`grep -rn aria-live web/src` = 0), yet the
  product is built around state arriving from a stream. The M1 client
  (`web/index.html`) does use `aria-live="polite"`; the prototype dropped it.
- Cards and foldables use `role="button"`/`role="tab"` with manual `keydown`
  handlers (`keyboard.ts`), which is correct-but-fragile; real buttons and
  Reka-managed roving focus should replace it.
- Roving-focus/tab semantics are only partial: `role="listbox"`/`role="option"`
  in the Task grid has no arrow-key navigation, and `role="tablist"` strips stop
  at `aria-selected` without tab-key semantics.

---

## 7. Reference repository check (pinned)

Policy from `docs/references.md`: reference-first; record the revision consulted;
Sprout terminology and seams win over a reference design. ADR-0011 already
recorded a check at the planning baseline. This Ticket re-checked the Web/UI
areas with fresh fetches on 2026-09-19.

### 7.1 Paperclip — `352153b5edf02ff4262210c7bd5bfa94bcf37c7c` (MIT)

Observed:

- `ui/package.json` uses React 19, `tailwindcss@^4.3.3` with
  `@tailwindcss/vite`, `radix-ui`/`@base-ui/react` headless primitives,
  `class-variance-authority`, `tailwind-merge`, `clsx`.
- `ui/components.json` is a shadcn configuration (`style: new-york`,
  `cssVariables: true`, `iconLibrary: lucide`).
- `ui/src/components/ui/` contains 25 wrapper modules (button, card, sheet,
  dialog, alert-dialog, badge, tabs, select, checkbox, collapsible, popover,
  scroll-area, skeleton, tooltip, command, separator, breadcrumb, …).
- `ui/src/components/ui/card.tsx` is a composable shell (`Card`, `CardHeader`,
  `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter`) with
  one behavioural prop, `interactive`, that adds hover affordance and a focus
  ring. Note the comment: "one Card, two modes."
- `ui/src/components/ui/sheet.tsx` wraps a Radix dialog with `side` and
  `showCloseButton`, and includes an `sr-only` close label.
- `ui/src/index.css` uses `@import "tailwindcss"`, an `@theme inline` block that
  maps Tailwind colour names onto CSS variables, an OKLCH palette, and a
  **multiplicative radius ladder** derived from a single `--radius` knob.
- Paperclip's `ui/src/components/` holds roughly 470 domain components
  (`AttentionQueueRow`, `ApprovalCard`, `BlockedReasonChip`, `AgentCapsule`, …).

Adopted:

- The composable card-shell-plus-slots shape, with at most one behavioural prop,
  and **separate domain cards** rather than one conditional Card.
- Thin wrapper around a headless primitive + `cn`-style class merging +
  `data-slot` attributes for testability.
- Tailwind-first token mapping where utility names read Sprout's roles.
- A single radius anchor with a multiplicative ladder.

Rejected:

- React, Radix/Base UI React packages, and shadcn's default neutral OKLCH theme.
- Paperclip's component inventory as a source of Sprout structure: its IA and
  domain grouping are a different product.
- Copying any code: no file was copied, so no attribution header is required.

### 7.2 Cumora — `ae18eff5d351f9a666984a2a03f13428d8f714fc` (MIT)

Observed:

- React + Vite + Electron/Capacitor; Tailwind CSS **3.4** with a classic
  `@tailwind base/components/utilities` stylesheet (`src/styles/globals.css`)
  and an RGB-channel token scheme (`--skype-rgb`, `--ink-*-rgb`, `--paper-rgb`,
  `--whisper-*`, plus semantic `--avail/--working/--thinking/--waiting/--resting`
  status colours) whose comment explains that channels are the source of truth so
  opacity modifiers keep working.
- Component-level CSS module files under `src/components/` and `src/admin/`.
- Its domain vocabulary is messaging-centric (`Message.tsx`, `WhisperRoom.tsx`,
  `HuddleList`, `MessageAnchorRail`) — Sprout shares the "conversation is a
  first-class surface" instinct but not its scope model.

Adopted:

- The idea that **presence/attention status colours are named domain roles**
  (`working`, `waiting`, `thinking`, `resting`) rather than only generic
  red/yellow/green. Sprout's equivalent roles (`ready`, `attention`, `action`,
  `agent`) already exist; production should keep this role-named approach.
- The discipline of documenting *why* a token is shaped a certain way next to it
  (Cumora's channel/opacity comment is a good example).

Rejected:

- Tailwind 3 configuration (`@tailwind base…` directives) — ADR-0011 selects
  Tailwind 4 with CSS-first theme variables.
- Its Electron/Capacitor shell and mobile app packaging: Sprout is one Web
  experience with phone/desktop parity, not a native app.
- Its message-centric IA: Sprout's Project/Task/Environment/Usage structure is
  settled by #44.

### 7.3 AionUi — `6744099b279b991c17e31c243f0920477bd31cb6` (Apache-2.0)

Observed:

- Electron + React; **Arco Design (`@arco-design/web-react@^2.66.1`)** as the
  styled component system, plus CodeMirror, dnd-kit, floating-ui.
- Styling is mostly CSS modules and per-feature CSS files
  (`Sider.module.css`, `MobileActionSheet.module.css`, `messages.css`,
  `themes/base.css`, `arco-override.css`).
- Contains a `MobileActionSheet` component and mobile-specific layout work.

Adopted:

- Confirmation that a bottom action sheet on the phone viewport is a normal and
  maintainable pattern (Sprout's mobile bottom sheet aligns with it).
- The practice of isolating third-party theme overrides in one named file.

Rejected:

- Arco Design as the visual language: an externally owned component system
  conflicts with Sprout's accepted structural and state language, exactly as
  ADR-0011 already concluded.
- React and the Electron desktop shell.
- CSS-module-per-component organization as the primary strategy: Sprout adopts
  Tailwind utilities plus a small token layer.

No reference code was copied in this Ticket.

---

## 8. Inherited obligations for production

### 8.1 Accessibility and keyboard

Inherited floors (from `docs/prototype-baseline.md` §5 and observed markup):

- Status is never colour-only: every traffic light, lifecycle pill, and status
  dot carries text and/or a labelled icon plus an `aria-label`/`sr-only`
  explanation. Examples: `.status-dot` with `aria-label="READY"` and an
  `aria-describedby` context span in `environments-view.ts`; severity pills with
  text.
- `:focus-visible` outline: 2px `--border-focus` at 2px offset, applied globally.
- Touch floor 44px for mobile interactive targets (`--touch-target`), with
  `.btn-lg`, bottom-nav items, usage tabs/selects/links, and settings sub-tabs
  meeting it; note that `.btn-sm` is 32px and is used 125 times, so "44px
  everywhere" is not currently true on phone.
- `prefers-reduced-motion: reduce` disables animation and transition durations.

Obligations production must meet that the prototype does not:

- Overlay focus management: initial focus, focus trap, focus restore, and
  `Escape` dismissal for dialog, alert dialog, sheet/drawer, and inspector.
- A live region for streamed state (agent run progress, connection changes,
  routing settlement); the M1 client already uses `aria-live="polite"` for the
  Message stream and Task list, and the prototype regressed it.
- Correct widget semantics: `tabs` with arrow-key navigation and `tablist`
  roving focus; the Task grid either becomes a real listbox with arrow keys or
  stops claiming `role="listbox"`.
- Touch floor reconciled with density: choose either a 44px floor with `sm`
  controls only on pointer-fine viewports, or an explicit compact mode.
- Announce dynamically inserted errors and confirmations (form error, task
  action status) through a live region rather than only visual text.
- Dismissible overlays must be reachable by keyboard-only and screen-reader
  users; the typed-confirmation dialogs must move focus to the input and expose
  the disabled reason.

### 8.2 Touch and phone/desktop parity

Inherited contract: every accepted journey is available on phone and desktop
with the same capability set; phone uses drill-down plus bottom sheets, desktop
uses split panes plus dialogs. The prototype proves the layout switch exists for
Environments, Agents, Task, and Chat, and its DOM suites assert it.

Obligation: the representative slice must show master/detail on desktop and
list→detail on phone for Environments, with the same actions available on both,
including Force Release and recovery resolution. A read-only phone fallback is
explicitly rejected (`docs/prototype-baseline.md` §6).

### 8.3 Privacy

Inherited rules (AGENTS.md, ADR-0008, ADR-0009, and asserted by prototype DOM
tests such as "Strict privacy boundary ensures no private host paths or
credentials appear"):

- Never render host usernames, absolute home paths, private keys, API keys,
  tokens, OAuth cookies, or network addresses/bindings.
- Show neutral relative workspace paths and a neutral local-context label.
- Worker identity is opaque and its value is withheld.
- Show engine readiness only as `ready` / `login-required` / `missing` /
  `unknown`, with version and model-availability notes, never credentials.
- Usage surfaces must never present an API-equivalent estimate as a billed cost,
  and diagnostics must list included and excluded facts.
- Routing context must list its privacy exclusions and must not surface raw tool
  transcripts, private reasoning, sessions, DMs, or credentials.

Obligations for production code and fixtures:

- Fixture adapters for the slice must be synthetic and must not embed real host
  facts. The prototype already had repair commits for exactly this
  ("Repair prototype privacy boundary fixtures"), so the check is worth encoding
  as a test.
- Logs and error copy from the transport layer must not leak host details to the
  browser.

### 8.4 State matrix obligations

Each surface must render its accepted states, not only the happy path. Observed
accepted matrices:

- Feed: mixed, empty (all clear), healthy active, stale telemetry, pending
  approvals, degraded host, intervention.
- Environments: ready, pending enrollment, degraded, offline, incompatible,
  reconciling, recovery, forced-release audit, archived.
- Agents: ready, attention/degraded, unavailable, empty, archived.
- Task: proposed, active + run running, active + run idle, pause requested,
  paused, blocked, awaiting validation, ending, recovery, completed, cancelled.
- Chat: normal, empty, pending batch, deliberate suppression, fail-closed,
  projected reply, read-only (archived/disbanded/ended).
- Usage: complete, partial, unavailable coverage; ongoing provisional; delayed;
  corrected; mixed provenance; pending cost.
- Settings: normal, loading, warning, unavailable, failure, risk-bearing.

Obligation: the slice and later views must demonstrate at least the states that a
real backend can produce, and tests must assert the distinction between
"unavailable" and "zero" wherever that distinction exists in the domain.

---

## 9. Proposed Shell + Manage / Environments representative-slice contract

This is the deliverable #74 validates. It is written as an acceptance contract,
not as an implementation plan.

### 9.1 Scope of the slice

- The production Shell: three destinations, desktop sidebar, phone bottom
  navigation, Project and Manage nested navigation, URL-addressable routing and
  history, phone drill-down header, Feed return context, theme tokens.
- Manage / Environments end to end: filter boxes, master/detail on desktop,
  list→detail on phone, six health dimensions, textual traffic light, capability
  permissions, engine readiness, bound workspaces, active-lease/reconciling/
  recovery/forced-release block, probe history, enrollment approval, readiness
  probe, archive/restore, recovery resume/discard, and Force Release.
- No other destination is migrated in this slice.

### 9.2 Acceptance conditions

1. **Versions pinned and compatible.** Vue 3.5 stable, Vite, TypeScript, Vue
   Router, Pinia, Tailwind CSS 4 with the first-party Vite plugin, Reka UI,
   and only the shadcn-vue source modules that are actually used. No
   `--force`/`--legacy-peer-deps` install and no globally ignored peer warning.
2. **Structure preserved.** Desktop shows sidebar + Manage sub-navigation +
   environments master/detail. Phone shows bottom navigation + Manage
   sub-navigation + list, then a full-width detail with a header back control.
   Both are the same route tree and both are reachable by URL.
3. **Language preserved.** Traffic-light summary always carries a decisive
   textual reason. The six dimensions are shown independently. Severity is never
   colour-only.
4. **Primitives established.** Sprout tokens resolve in both themes; Button,
   Input/Select/Textarea, Field/Helper/Error, Badge/StatusPill/StatusDot,
   Card+Header+Body+Footer, ListRow, Foldable, EmptyState, Skeleton,
   StateBanner, and FilterPillGroup exist as Sprout modules; overlay behaviour
   comes from Reka UI.
5. **No universal Card.** The Environment master card, the environment detail
   sections, and the metric tiles are distinct compositions over the shared card
   shell; a single severity→token mapping is shared; no `Card` prop switches
   domain bodies.
6. **Behaviour from external primitives.** Sheet, dialog, alert dialog, tooltip,
   select, switch, and collapsible behaviours come from Reka UI wrappers.
   Focus trap, initial focus, focus restore, and `Escape` dismissal are
   demonstrated on the Force Release alert dialog and the mobile sheet.
7. **State separation.** Authoritative Environment facts arrive through a typed
   port with a fixture adapter for the slice; bounded cross-page UI state (theme,
   selected destination) is in Pinia; foldable/filter/dialog state is local to
   the Environment module. No fixture `StateManager` is ported.
8. **State coverage.** Normal/ready, loading, empty, warning (degraded), offline,
   incompatible, reconciling, recovery, and risk-confirmation (Force Release) are
   all reachable in the running artifact on phone and desktop.
9. **Harness excluded.** No control bar, viewport switcher, state switcher,
   review drawer, Ticket/ADR caption, "Simulate Disconnect", or "Style Baseline"
   route exists in the slice.
10. **Tests and checks.** Focused tests at the caller-facing module interfaces;
    DOM/accessibility coverage for dialogs, sheet, filters, and the traffic-light
    reason; `npm run typecheck`; `npm test`; `npm run web:build`;
    `git diff --check`; a privacy assertion that no host path or credential
    fixture appears; and an owner-reviewed running artifact.
11. **Retained decision record.** The slice records its accepted/rejected stack
    and module decisions, and updates ADR-0011 only if the evidence requires it.

### 9.3 Explicit non-goals for the slice

- Migrating Feed, Project, Chat, Agents, Usage, or Settings.
- Implementing real Environment enrollment, persistence, recovery, or Force
  Release backend contracts.
- Introducing a published UI package or a second overlapping UI framework.
- Vue Vapor or any Vue prerelease.

---

## 10. Verification performed in this Ticket

All commands were run in the assigned worktree at the fixed base. Output is
sanitized; no local paths or identities are reproduced.

| Command | Result |
| --- | --- |
| `npm ci` | installed the locked dependency set successfully |
| `npm run typecheck` | clean (root project and `web/tsconfig.json`) |
| `npm test` | 523 tests, 523 pass, 0 fail, 0 skipped |
| `npm run web:build` | Vite production build succeeded; prototype chunk is the large one (~562 kB minified) |
| `git diff --check` | clean (no whitespace errors) |

Observed non-fatal noise: the Web test run prints `WebSocket server error: Port
24678 is already in use` repeatedly while Vite dev servers start per DOM suite.
It does not fail any test, but it is worth a follow-up (§11).

Static inspection evidence used throughout this report is cited inline by file
and symbol. Additional `grep`-based counts performed: unreachable modules (6),
`aria-live` occurrences in `web/src` (0), `Escape` handlers in the prototype
(0), `data-density` CSS consumers (0), undefined-but-used badge/button classes
(7 class names), and card/primitive class usage counts.

---

## 11. Follow-ups

- Resolve the adopted-but-inert density dimension: implement it as real tokens or
  delete it.
- Add a build-time or lint check that fails on class names with no matching rule,
  to prevent a repeat of the `badge-*`/`btn-*`/`status-pill neutral` drift.
- Re-plan the first-run onboarding journey (ADR-0008 §First-run journey) as
  production work; the prototype's wizard view is unreachable dead code and is
  not a usable structural baseline.
- Decide the Usage chart/table strategy per view (ADR-0010 leaves this to the
  product shell) before the Usage view is migrated.
- Investigate the repeated Vite dev-server port collision in the DOM test suites.
- Decide whether the mobile 44px touch floor applies to `sm` controls on all
  viewports or only on pointer-coarse ones, and encode the decision in tokens.

## 12. New fog

- Density has no agreed meaning yet: the baseline document describes a
  comfortable/compact mode, the prototype never implements it, and the accepted
  screenshots are comfortable-only. Whether production carries two densities at
  all is an open product question, not an implementation detail.
- The accepted prototype's phone navigation is implemented with a
  renderer-level mode switch (`viewportMode`) rather than the actual viewport.
  It is not yet proven that one Tailwind breakpoint set reproduces the accepted
  phone composition without reintroducing a mode flag; #74 should test this.
- Usage copy and aggregation language is dense and authoritative, and its
  `usage-view-tabs` are described as an accepted contract. Whether charts are
  required or tables suffice is unresolved (ADR-0010 deliberately leaves it).
