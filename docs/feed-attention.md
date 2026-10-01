# Feed and Human Attention projection

The production Feed (#103) is a **read-only projection** over authoritative
state, composed in `src/runtime.ts` as `createFeedProjection` and served by
`GET /api/feed` (`src/web/feed-router.ts`). The portable contract lives in
`src/web/feed.ts`; the browser reads it through
`web/src/adapters/feed-api.ts`. Prototype behaviour this implements:
`docs/prototype-feed-attention.md` (stories 14–20 of #77).

## Three sections

| Section | Sources | Notes |
| --- | --- | --- |
| **Attention** | Task proposals (`proposed`), pending completion claims, routable blockers, Task recovery, Environment recovery records (`reconciling`/`recovery`), pending enrollments, failed wake-model routing batches, Project events with disposition `human-action-required` | One item per unresolved source; severity-ranked `action_required` → `attention` → `info`, then newest first |
| **In-flight work** | Tasks in `beginning`/`running`, runs in `queued`/`running` | Identity and lifecycle only: never a run's prompt, events, result, or failure |
| **Operational activity** | Project events plus terminal run settlements as fact-form one-liners | Newest first, bounded to 50 items, each summary bounded to 300 characters |

An informational Project event stays activity; it becomes Attention only when
its disposition is `human-action-required` (ADR-0007). A Project-scoped failed
run is represented by its durable `agent-run-failure` event, never twice.

## Invariants

- **No second authority.** The projection stores and mutates nothing. Every
  item carries `source: { kind, id }` naming the authoritative record it
  projects.
- **No dismiss or snooze.** The route set is GET-only; deeper paths fall
  through to 404. An item disappears only when its source clears, and a
  restart recomputes the identical snapshot from the reopened stores
  (`src/web/feed-restart.test.ts`).
- **Scoping and transcolation.** Items carry scope ids: their Project, `infra`,
  or both. An infrastructure fact that directly blocks a Project's Task (a
  recovery record holding that Task's lease) belongs to that Project's scope as
  well; generic infrastructure appears only under `all` and `infra`. The
  implicit `all` scope includes everything. Unknown filter values refuse with
  400 rather than widening the view.
- **Deep links are identities.** Each item's `target` names an owning surface
  (`FEED_SURFACE_TEMPLATES`) and resolves through `feedTarget`; the browser
  test pins those templates to the shipped route table in
  `web/src/router/index.ts`.
- **Privacy.** Interpolated source text passes `redactSensitiveText` and is
  length-bounded (400 for reasons, 300 for activity summaries). Engine prose,
  prompts, raw run events/results/failures, frozen routing context, and claim
  text never cross the projection.

## Evidence

- `src/web/feed-projection.test.ts` — derivation, filtering, transcolation,
  referential integrity, privacy, clearing.
- `src/web/feed-restart.test.ts` — identical snapshot across a SQLite reopen.
- `src/web/feed-router.test.ts` — HTTP contract, filters, 401/400/404 matrix.
- `src/web/feed-runtime.test.ts` — full-runtime journey driven by real domain
  commands.
- `web/src/adapters/feed-api.test.ts` — typed read adapter, error mapping, and
  route-table deep-link resolution.

Wiring the Feed page from fixture data to this adapter is separate page work.
