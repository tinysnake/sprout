# Test selection

This document is the project-owned inventory and selection plan for the test
suite. Membership and triggers live here; the mechanical rules live in
`scripts/test-select.ts`; each `npm test` invocation records a durable run in
the observation dataset (see `AGENTS.md`). Every tier runs through
`scripts/test-summary.ts`, so no invocation exceeds the 180-second command
limit.

Privacy hardening and redaction are future work under [ADR-0020](adr/0020-defer-privacy-hardening-and-redaction.md). Existing privacy tests remain part of the current inventory until an implementation change updates or prunes them; do not add privacy-only coverage or preserve a superseded privacy assertion as a product gate. Required checks still run and failures are reported truthfully.

## Tiers

| Tier | Command | Contents | Trigger |
| --- | --- | --- | --- |
| Quick core | `npm run test:quick` | All default-glob test files except `.dom.test.ts` suites and `src/worker/cli/worker-cli.macos.test.ts`: cheap logic, parsing, state machines, memory/SQLite database contracts, and the compact critical authority, lease, and recovery regressions | Meaningful implementation edits |
| Affected behavior | `npm run test:affected` | Quick core plus the tests under each changed file's directory; any `web/` change also activates `web/src/modules/tasks/tasks.dom.test.ts` (permissions, stop confirmation, recovery) | Implementation completion and ticket review |
| Extended regression | `npm run test:extended` | The 20 remaining `*.dom.test.ts` suites (full DOM matrices, real rendering paths) plus `src/worker/cli/worker-cli.macos.test.ts` (platform startup) | Related DOM/platform changes; change-request or final integration; periodic regression |
| Full | `npm test` | The complete default-glob inventory (quick ∪ extended) | Final composed result before integration into the target branch |
| External conformance | hand-scheduled probes | Real engines, containers, and separately deployed Workers (`scripts/probe-*`, `scripts/*-conformance.*`); requires explicit prerequisites | Adapter/environment changes and the corresponding release acceptance |

## Widening rules

An affected selection widens to the full inventory when a changed file is a
shared surface whose change invalidates path-based independence:

- `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts` — build
  and dependency configuration
- `src/store/` — schema and persistence contracts used by every runtime path
- `src/web/views.ts` — the shared view-model boundary
- `web/src/app/main.ts`, `web/src/router/`, `web/src/shell/`,
  `web/src/transport/` — application composition and transport, reachable from
  every page

Uncertain impact widens; a path-only filter never narrows below quick core.

## Cost baseline

Measured on the full-suite observation run at `2026-10-11T08-41` (2487 tests,
concurrency 4): quick ≈ 49 s, extended ≈ 98 s, full ≈ 142 s wall. DOM suites are
~61 % of summed test time across ~13 % of the files; the three largest
(`routes.dom`, `tasks.dom`, `ChatView.dom`) dominate. These numbers age; the
observation dataset (`node scripts/test-observations.ts`) is the source of
current rates and durations.

On 2026-10-11 the 21 historical prototype DOM suites
(`web/src/prototype/*.dom.test.ts`, plus `environments.dom-responsive-privacy`
and its `dom-harness.ts`) were **deleted**, not merely re-tiered. Rationale: the
prototype is a frozen reference artifact being retired in two steps — the
tests are removed now, the prototype code itself later; a freeze guard for
code scheduled for deletion only delays that deletion. Protection forgone:
prototype UI regressions and vue/vite/jsdom-upgrade breakage inside
`web/src/prototype/` are no longer detected. That is accepted because no
production path renders the prototype (the production isolation claim stays
covered by `web/src/app/routes.dom.test.ts`), and the DOM cost figures above
overstate the current suite until the next observation baseline.

## Verification

`npm run test:audit` re-derives membership from the current default globs and
reports missing, extra, and duplicate files. It must print `0 0 0` after any
change to the globs, the tier rules, or a test-file rename/move.

## Rules for changing this plan

- Moving a test between tiers requires a stated reason here: what protection
  the move could delay, and which trigger still covers it.
- A test whose owning behavior or prerequisites change is re-enabled in the
  extended tier before the change lands.
- New expensive harnesses record their measured cost in a comment or here, so
  the next tier revision has data instead of guesses.
- This plan changes what runs when; it never changes what a test asserts. The
  `npm test` default and its full inventory remain the integration gate.
