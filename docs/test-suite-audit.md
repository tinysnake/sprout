# Test-suite unique-protection audit (#133)

Scope: the current default-glob inventory (322 files; the most recent full run
recorded 2,488 tests). This is a **review recommendation and decision log**:
deletions and consolidations are applied only in separately reviewed changes,
each validated by a targeted mutation that proves the retained protection still
detects the defect. A green suite after a deletion alone does not prove
protection survived. Tier membership and execution triggers live in
`docs/test-selection.md`; current rates and durations live in the observation
dataset (`node scripts/test-observations.ts`).

## Method

Compare test titles and assertion surfaces across the complete inventory,
grouping by contract, boundary, and failure mode; nominate only cases where
another named test plausibly subsumes the same regression. For each candidate,
state the realistic defect it detects, the observable contract, and the
remaining test that detects the same defect. Then apply a targeted mutation to
the production or fixture code and confirm the retained test fails.

A strict tautological oracle derives its expected result from the same
implementation or mirrors the same defective calculation. A separate low-value
category checks static fixtures, constants, language behavior, or behavior
already protected by a stronger test.

Not flagged despite similar-looking titles: schema safety-copy and migration
cases cover distinct persisted data/reopen failures; privacy tests distinguish
concrete sensitive-input formats and non-sensitive false positives; Agent
creation and reconfiguration cases protect different lifecycle transitions.
Backend loops exercise real SQLite separately from in-memory storage.
Constructor/getter/setter-shaped assertions embedded in behavioural tests are
not grounds to remove the whole test while its lifecycle or privacy oracle
remains unique. Migration rollback, safety-copy, durable reopen, and
memory/SQLite cases keep their separate entries even when names overlap.

## Applied dispositions

| Test | Risk → retained protection | Disposition | Mutation check |
| --- | --- | --- | --- |
| `src/host-config.test.ts` — "the host proxy is empty when the host declares none" | An empty host environment unexpectedly yields a proxy → the defaults contract "an empty host environment takes exactly the documented defaults" asserts the complete result object, including `containerProxy: {}` | **Deleted** as a separate case; the defaults contract retains the assertion | `containerProxy()` forced to return a non-empty record → 5 failures in the defaults contract family |
| `src/store/schema.test.ts` — "schema constants declare supported version range" | Version constants drift apart → migration/open on every open refuses an inconsistent range (`SchemaTooNewError`/`SchemaTooOldError`); the real creation path already asserts the shipped version | **Merged** the range-consistency invariant into "empty store creation initializes full schema at current version with no safety copy"; constants-only case **deleted** | `SUPPORTED_SCHEMA_RANGE.current` set to `CURRENT_SCHEMA_VERSION - 1` → exactly the retained creation-path test fails |
| `web/src/modules/agents/agents.service.test.ts` — "the fixture covers ready, attention, unavailable, archived, and not-observed rows distinctly" | Fixture data loses a state → the DOM suite ("the state matrix renders distinctly", `agents.dom.test.ts`) renders ready/attention/unavailable/archived through the same fixture and evaluator, but does not render the model-missing or unobserved rows and does not pin colour values | **Trimmed** to "status evaluation distinguishes model-missing, unobserved, and their reasons": the rows, colour mapping, and distinct-cause/distinct-reason invariant the DOM suite does not cover | Model-missing reason collapsed into the installation-missing reason → the trimmed test fails |
| `web/src/modules/agents/agents.service.test.ts` — "attribution fixtures carry no transport addresses or paths" | A fixture accidentally contains a host path or transport endpoint → `agents.privacy.test.ts` ("no fixture fact contains a private host path, address, credential, or key") covers the same fixtures with a strictly larger pattern set, plus a dedicated attribution-identifier contract | **Deleted** as a strict subset of the privacy suite | Superseded check; privacy suite retains the protection with more patterns |
| `web/src/modules/usage/usage.service.test.ts` — "FixtureUsageService: returns accurate aggregates and scoped options" (fixed counts: ten activities, two projects, four Agents) | Counts lock sample data, not behavior; the genuine risks are an aggregate detached from the activity list and a filter that does not scope | **Rewritten** as "aggregates derive from the activity list and filters scope both": total equals the listed length, every scoped project owns a strict subset and honours the filter, every activity names a listed model | Aggregate `totalActivities` forced to a constant 999 → the rewritten test fails |

No test was deleted whose only coverage is a critical behavior; every deletion
above was backed by a named stronger test and a mutation check. These changes
alter maintenance cost only: the default-glob suite lost three cases net after
consolidation, which is an outcome, not a target.

## Open candidates (inspected, not yet dispositioned)

| Flagged test | Question for the next review |
| --- | --- |
| `src/host-config.test.ts` — "an empty numeric host setting keeps the runtime conversion it had before" | Keeps compatibility with explicit empty strings for numeric settings. **Keep pending policy decision**: if explicit-empty compatibility is required, keep; otherwise specify parsing behaviour rather than pin language coercion. |
| Historical prototype DOM suites (`web/src/prototype/*.dom.test.ts`) | **Decided 2026-10-11: deleted** (21 suites + `dom-harness.ts`) as step one of the two-step prototype retirement: the frozen prototype code remains as a design reference but is leaving the regression suite, since a freeze guard for code scheduled for deletion only delays that deletion. Production isolation from the prototype stays covered by `web/src/prototype` having no production importers plus `routes.dom.test.ts`. Re-add suites only if the retirement plan is cancelled. |
