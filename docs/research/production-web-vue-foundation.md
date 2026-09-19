# Production Web Foundation Validation (Shell & Environments)

**Ticket:** [#74](https://github.com/tinysnake/sprout/issues/74) (part of Map [#70](https://github.com/tinysnake/sprout/issues/70))  
**Date:** 2026-09-19  
**Branch:** `m70-ticket-74`  
**Fixed base:** `2ab8bc1050e82c2195f269a9b2c37e6f827e80a9`  
**Status:** Completed and verified vertical slice demonstrating production Web foundation  

---

## 1. Summary & Outcome

Ticket #74 validates the production Web foundation with a complete vertical slice of the **Application Shell** and **Manage / Environments** domain, executing the decisions formulated in **ADR-0011** and fulfilling the structural and UI-language baseline documented in **#72** (`docs/research/production-web-structural-baseline.md`).

The vertical slice proves that:
1. Stable **Vue 3.5.43**, **Vite 7.3.6**, **TypeScript 5.9.3**, **Vue Router 4.6.4**, **Pinia 3.0.4**, **Tailwind CSS 4.3.3**, and **Reka UI 2.10.4** integrate seamlessly without peer dependency warnings or `--force` / `--legacy-peer-deps` flags.
2. The accepted structural hierarchy is preserved: desktop sidebar (`OPERATIONS`, `PROJECT`, `MANAGE`), Manage sub-navigation (`Environments`, `Agents`, `Usage & Costs`, `Settings`), phone sticky bottom navigation, URL-addressable navigation, and mobile drill-down header.
3. The traffic-light status model always pairs visual state with mandatory textual reason language (`READY`, `ATTENTION`, `ACTION REQUIRED`).
4. The 6 independent health dimensions (enrollment, connection, protocol, work safety, capability permissions, and engine readiness) remain distinct and inspectable, never collapsed into a single boolean (ADR-0009).
5. External UI primitives from Reka UI supply accessible behaviour (dialogs, alert dialogs, sheets, focus trap, initial focus, focus restore, and Escape key dismissal), while Sprout remains authoritative over tokens, density, domain composition, and responsive hierarchy.
6. The prototype harness controls (`proto-control-bar`, viewport switcher, Style Baseline button, review drawer, ticket/ADR copy) are completely excluded from the production surface.
7. Authoritative remote facts arrive through a typed port (`EnvironmentService`) with a fixture adapter (`FixtureEnvironmentService`); Pinia owns strictly bounded cross-page UI state (`theme`, `returnContext`, `operatorOnline`); view-local state stays local to its Vue module.

---

## 2. Pinned Package Dependencies & Compatibility

All packages were pinned to stable, mutually compatible versions without peer dependency warnings:

| Package | Version | Role in Architecture |
|---|---|---|
| `vue` | `^3.5.43` | Stable Vue 3.5 Single-File Components (Composition API, `<script setup>`) |
| `@vitejs/plugin-vue` | `^6.0.9` | Official Vite 7 plugin for Vue 3 SFC compilation |
| `vue-router` | `^4.6.4` | URL-addressable routing, browser history (`createWebHistory`) |
| `pinia` | `^3.0.4` | Bounded cross-page UI state store |
| `tailwindcss` | `^4.3.3` | Tailwind CSS 4 utility framework |
| `@tailwindcss/vite` | `^4.3.3` | First-party Vite integration for Tailwind CSS 4 |
| `reka-ui` | `^2.10.4` | Headless accessible UI primitives (AlertDialog, Dialog, Sheet, Checkbox, Switch, Collapsible) |
| `clsx` | `^2.1.1` | Class string construction |
| `tailwind-merge` | `^3.7.0` | Class merging for Tailwind utilities (`cn` helper) |
| `class-variance-authority` | `^0.7.1` | Variant-based class resolution |

**Installation check:** `npm install` executed cleanly in 1s with 0 peer dependency errors or warnings.

---

## 3. Architecture & Module Seams

### 3.1 Three-Tier UI System

Following the recommendations of #72 §4.2:
1. **Headless Behaviour Primitives (Reka UI wrappers)**:
   - `AlertDialog.vue`: Accessible confirmation dialog with focus trap, initial focus, focus restore, Escape dismissal, and `role="alertdialog"`.
   - `Dialog.vue`: Modal dialog with overlay, close action, and escape handling.
   - `Sheet.vue`: Mobile bottom sheet / side drawer.
   - `Checkbox.vue`: Accessible checkbox (`v-model`).
   - `Switch.vue`: Accessible switch for capability permission toggling.
   - `Foldable.vue`: Accessible collapsible disclosure (`CollapsibleRoot`).
2. **Sprout Presentation Primitives**:
   - `Button.vue`: Standardized Sprout button with variants (`primary`, `secondary`, `danger`, `warning`, `ghost`, `outline`), sizes (`xs`, `sm`, `md`, `lg`, `icon`), and 44px touch compliance.
   - `Badge.vue`: Semantic badges (`info`, `green`, `yellow`, `red`, `purple`, `secondary`, `neutral`).
   - `StatusDot.vue`: Status indicator with mandatory `title`, `aria-label`, and text explanation.
   - `StatusPill.vue`: Pill badge for platform, protocol, and lease status.
   - `Input.vue` / `Textarea.vue`: Standard inputs with focus ring (`var(--border-focus)`).
   - `Card.vue` + `CardHeader.vue` / `CardTitle.vue` / `CardDescription.vue` / `CardContent.vue` / `CardFooter.vue`: Composable card shell.
   - `StateBanner.vue`: Prominent traffic-light summary banner with decisive textual reason.
   - `FilterPillGroup.vue` + `FilterPill.vue`: Discrete box filter buttons with active ring and `sr-only` counts.
   - `SubNav.vue`: Navigation tab strip with `role="tablist"` / `role="tab"`.
   - `Icon.vue`: Crisp geometric SVG icons.
3. **Environment Domain Components**:
   - `EnvironmentMasterCard.vue`: Card list item with platform icon, display name, neutral host context, traffic light dot, 2-line decisive reason snippet, connection/protocol/lease chips, quick probe button.
   - `EnvironmentMasterList.vue`: Filterable master card list with empty state handling.
   - `EnvironmentDetail.vue`: Complete detail panel comprising the 6 sections:
     - Prominent traffic light summary banner
     - 6 independent health dimensions (dimensions 1–4, capability permissions 5, engine harness readiness 6)
     - Bound project workspaces (workspace root + relative path, unbind action)
     - Resolution area: Reconciling box / Recovery alert box / Active lease box / Forced release audit box
     - Operations toolbar: Probe, Archive, Restore, Unenroll
     - Recent readiness probes stream
   - `ForceReleaseDialog.vue`: 3-gate emergency override confirmation dialog.
   - `BootstrapGuideDialog.vue` & `RegisterHostDialog.vue`.

### 3.2 State Boundary & Remote Port

- **Authoritative Remote Port**: `EnvironmentService` (`web/src/modules/environments/ports.ts`) defines asynchronous queries and mutations:
  `listEnvironments`, `getEnvironment`, `approveEnrollment`, `triggerProbe`, `togglePermission`, `unbindWorkspace`, `reconcileEvidence`, `resumeRecovery`, `discardRecovery`, `forceRelease`, `archiveEnvironment`, `restoreEnvironment`, `unenrollEnvironment`.
- **Fixture Adapter**: `FixtureEnvironmentService` (`web/src/modules/environments/adapters/fixture-adapter.ts`) implements `EnvironmentService` with synthetic, realistic data.
- **Pinia Cross-Page State**: `useAppStore` (`web/src/stores/app.ts`) owns ONLY `theme` (`dark` | `light`), `returnContext` (`{ title, to }`), and `operatorOnline`. No domain entities or environment lists reside in Pinia.
- **View-Local State**: Active filter, selected environment ID, dialog open states remain local `ref`s inside `EnvironmentsView.vue`.

---

## 4. Accepted vs. Rejected Decisions

| Area | Accepted Decision | Rejected Alternative | Rationale |
|---|---|---|---|
| **Component Model** | Composable Card shell (`Card` + slots) + distinct domain compositions | Universal conditional `Card` with `kind`/`variant` props switching bodies | ADR-0011; universal conditional cards lead to untyped prop bloat and leaky domain boundaries. |
| **State Management** | Authoritative typed port (`EnvironmentService`) + bounded Pinia cross-page UI state | Porting prototype `StateManager` (~6,800 lines of mutable mock state) | ADR-0011; prototype `StateManager` was a decision artifact, not a production domain layer. |
| **UI Primitives** | Reka UI headless wrappers + Sprout presentation primitives | Adopting an off-the-shelf styled library (e.g. Arco Design, Ant Design, Vuetify) | ADR-0011 & References check; third-party visual languages conflict with Sprout's density and status semantics. |
| **Tailwind Strategy** | Tailwind CSS 4 with CSS-first `@theme` variables in `theme.css` | Tailwind 3 legacy JS config (`tailwind.config.js`) | ADR-0011; Tailwind 4 Vite integration provides native CSS variables and eliminates bundler indirection. |
| **Renderer** | Stable Vue 3.5.43 SFCs with Composition API | Vue Vapor or Vue 3.6 prereleases | ADR-0011; Vapor prereleases break router and UI peer ranges. |
| **Navigation & History** | Vue Router HTML5 history mode with URL-addressable routes (`/manage/environments/:id`) | Prototype custom `popstate` event listeners and manual hash flags | URL addressability, standard router hooks, clean deep-linking. |
| **Harness Controls** | Excluded completely from production surface | Porting prototype top control bar, viewport switcher, Style Baseline, review drawer | Production surface presents only product capabilities; review artifacts belong in repo docs and tests. |

---

## 5. State Coverage Matrix

The vertical slice demonstrates all 8 operational states across desktop and mobile:

| State / Scenario | Platform | Traffic Light | Connection | Safety / Lease | Demonstrated Capability |
|---|---|---|---|---|---|
| **Normal / Ready** | macOS | Green: Ready | Online (10s) | Held (Task #101) | Live probe, capability toggle, engine status, bound workspace unbind, task lease details. |
| **Recovery** | Windows | Red: Action Req. | Offline (14m) | Recovery (Task #104) | Recovery alert box, unresolved facts manifest, Resume, Discard, Emergency Force Release. |
| **Pending Enrollment**| macOS | Yellow: Attention | Reconnecting | Clear | Operator approve action updates status, connection, and turns traffic light to Green. |
| **Degraded** | Container | Yellow: Attention | Online (45s) | Clear | Codex engine login-required, GUI auto missing, probe latency record. |
| **Incompatible** | macOS | Red: Action Req. | Online (1m) | Clear | Protocol version mismatch guidance banner (v1.8 < v2.0+ required). |
| **Archived** | Windows | Yellow: Attention | Offline (3d) | Clear | Archived status, work admission barred, Restore Instance action. |
| **Reconciling** | macOS | Yellow: Attention | Online | Reconciling | Worker reconnected, Reconcile & Synchronize Evidence action. |
| **Force Release Flow**| Environment | Red → Green | Offline | Recovery → Clear | 3-gate safety check: unresolved facts, operator reason, typed `FORCE RELEASE`, risk checkbox. |

---

## 6. Verification Evidence

All checks executed cleanly in the assigned worktree at commit `2ab8bc1`:

| Check | Command | Result |
|---|---|---|
| **Package install** | `npm install` | 73 packages added, 0 peer warnings, 0 errors |
| **Typecheck** | `npm run typecheck` | Clean pass (`tsc --noEmit` root and `web/tsconfig.json`) |
| **Web build** | `npm run web:build` | Pass: builds `dist/app/index.html`, app JS (265 kB minified / 82 kB gzip), app CSS (32 kB) |
| **Full test suite** | `npm test` | **541 passed, 0 failed, 0 skipped** (including 18 new production tests) |
| **Service tests** | `node --test web/src/modules/environments/environments.service.test.ts` | 9 passed, 0 failed |
| **Privacy tests** | `node --test web/src/modules/environments/environments.privacy.test.ts` | 1 passed, 0 failed (asserts zero host paths or credentials) |
| **DOM / A11y tests**| `node --test web/src/app/production.dom.test.ts` | 8 passed, 0 failed (covers Shell, filters, Force Release, probes, drill-down, return context) |
| **Whitespace check** | `git diff --check` | Clean pass |

---

## 7. ADR-0011 Status

ADR-0011 remains **accepted** and unmodified. The implementation evidence confirms all its assumptions regarding Vue 3.5, Vite, TypeScript, Vue Router, Pinia, Tailwind CSS 4, Reka UI, and selective shadcn-vue patterns. No deviation was required.
