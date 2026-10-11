## Problem Statement

#260 makes Tasks Project-owned records assigned to Working groups (WGs), and #265 retains pending lease escrows under WG governance. Both kinds of state must be readable by Humans and by Agents, and more WG-attached information will follow. Without a shared surface, every kind invents its own delivery path: Tasks ride wake prompts, escrows get an ad-hoc view, and each future kind repeats the same visibility and permission decisions with room to drift between them.

The surface must be a state snapshot, not an activity feed: it shows what currently exists for the WG, not a history of who did what. Seeing an entry must never grant authority — takeover, mutations, and management keep their own server-enforced contracts.

## Solution

Introduce the **Working group glance**: one WG-scoped read contract with two presentations — a Human panel inside the Working group view, and an explicit Agent query. The glance is a projection, not a store: registered providers compute entries from existing records (assigned Tasks, pending lease escrows, future kinds) and own each kind's entry lifecycle, rendering, and visibility rule. Every current WG member sees the identical entry set; there is no read state and no per-member filtering.

Agents receive content only through the explicit query. A wake prompt may carry a one-line pointer ("your WG glance has N entries") and never entry content. The glance produces no messages, notifications, wakes, or periodic discovery. The Human panel refreshes by re-fetching the glance when a related `/api/events` event arrives, plus manual refresh.

## User Stories

1. As a Human WG member, I want my WG's assigned/finished Tasks and pending escrows in one panel inside the WG view, so that I do not chase separate screens.
2. As an Agent, I want one explicit query that returns every current glance entry for my WG, so that I can inspect WG state without waiting for a wake.
3. As an Agent whose wake just fired, I want a one-line pointer saying the glance has entries, so that discovery does not depend on periodic polling while content stays query-fetched.
4. As a current WG member, I want an identical entry set regardless of who I am, so that the glance is shared state rather than a personalized feed.
5. As a WG-external participant, I want no access to any glance entry, so that WG state and handoff notes never leak across membership.
6. As an Agent, I want entries grouped by kind and stably ordered within each group, so that repeated queries are predictable.
7. As an Agent, I want full records inline in one response — handoff notes included — so that I need no drill-down round trips.
8. As a WG member, I want canceled and proposed Tasks absent from the glance, so that it reflects only work currently attached to this WG.
9. As a WG member, I want finished Tasks to remain visible, so that recent outcomes stay in the shared view.
10. As a WG member, I want taken-over escrows to disappear without successor or history, so that the glance stays a state snapshot, not an activity feed.
11. As an Agent, I want the server to enforce takeover eligibility independently of glance visibility, so that reading an entry never implies authority to act on it.
12. As a Human, I want the panel to refresh when a related event arrives instead of polling, so that the view stays current without a new push channel.
13. As a developer, I want a new WG-attached kind to plug in by registering one provider, so that future information needs no new view or permission path.
14. As a WG member, I want no read/unread state on the glance, so that it remains a uniform snapshot.
15. As an authorized actor, I want mutations to act on source records only, so that the glance stays read-only and cannot bypass existing authorities.

## Implementation Decisions

- **Read model:** the glance persists nothing of its own. Entries are computed from existing records at query time through one glance service boundary; no caller re-implements membership or visibility rules.
- **Provider contract:** each provider declares its kind, a membership-scoped query, a Human rendering, an Agent rendering, and its entry lifecycle/visibility rule. The two presentations share the same entry set and content; a provider may shape each rendering's representation, never its visibility.
- **Query contract:** one query per WG, authorized for current members only. Entries are grouped by kind (Tasks first, escrows second), stably ordered by `updatedAt` within each group, returned in full inline, with no pagination and no summary/detail drill-down in v1. These two kinds are small; if one kind later grows, bounding it is that provider's problem.
- **Tasks provider:** entries are Tasks whose WG field equals this WG and whose status is `assigned` or `finished`. This constrains #263's mutation contract: `cancel` and `return` clear the WG field, `proposed`/reopened work carries none, `finish` retains it; historical assignment stays in actor/time history. The provider derives purely from WG field + status — no provider-side status bookkeeping.
- **Escrow provider:** entries are this WG's pending escrows with takeover scope and handoff note. Taken-over or removed escrows leave the entry set; successor identity and takeover history are never projected. The current user's own-use context and the owner/Human outstanding-chain management queries remain in #265's escrow contract, not in the glance.
- **Uniform visibility:** the entry set is identical for every current member and enforced server-side. No read state, no recipient filtering, no WG-external access. Visibility is not authority: takeover, Task mutations, and escrow management each enforce their own checks.
- **Wake and delivery:** wake prompts carry a pointer to the glance, never its content. This amends #260's approved provision that assigned Tasks are handed to the owner at wake; the pointer preserves its anti-starvation intent while keeping one content path. Glance changes cause no wake, notification, or message projection, and there is no periodic discovery.
- **Human panel:** rendered inside the Working group view. Refresh = refetch on a related `/api/events` event + manual refresh. No polling, no new push channel.
- **Write path:** the glance is read-only. Mutations go through source records' existing authorities (Task mutations, escrow actions); no entry is created, edited, or resolved on the glance itself.
- **Extensibility:** a new WG-attached kind registers one provider and changes nothing in authorization, grouping, panel routing, or wake handling. v1's proof of the contract is two heterogeneous providers: record-backed Tasks and reservation-backed escrows. A freeform WG note with no source record is deferred until a concrete need arrives; if added, it becomes a minimal source record of its own — never a generic item table.

## Testing Decisions

- **Primary seam:** the composed authenticated API boundary. Query the glance as a Human, a member Agent, and a WG-external caller through the existing Web/Agent action harness; assert responses, not internal projection methods.
- **Uniform visibility:** two current members with different roles and different takeover eligibility receive identical entry sets; a WG-external caller is refused; after a takeover the entry disappears without successor identity or history.
- **Derived lifecycle:** assignment and finishing add/keep entries; cancel, return, and Human reopen remove them per the #263 WG-field rules; assert the provider never drifts from the source records after any Task mutation.
- **Response shape:** kind grouping (Tasks before escrows), stable `updatedAt` ordering, full inline records including handoff notes, idempotent repeated queries.
- **Pointer-only wake:** a wake prompt contains the pointer/count and no entry content; glance changes emit no notification, message, or wake; no polling timer exists in the panel path.
- **Provider extensibility:** registering a second kind requires no change to membership authorization, grouping, panel routing, or wake handling; heterogeneous entry shapes survive one query.
- **Verification:** production implementation passes typecheck and `npm test` with an explicit 180-second timeout, following the repository's documented partitioning when #254 concurrency bounds apply. Publishing this specification is not test evidence.

## Out of Scope

- Implementing #260's Task lifecycle or #265's escrow behavior; the glance consumes their contracts.
- A freeform note kind, a generic WG item table, and any glance-side write operations.
- Read/unread state, recipient-filtered views, pagination, and detail drill-down.
- A new push channel, polling, periodic discovery, autonomous scheduling, or a general workflow engine.
- Project-level or cross-WG glances, and using glance visibility as authorization for anything.
- Multi-Human authorization expansion and backward compatibility with obsolete delivery paths.

## Further Notes

- Tracked in #266, child of the #260 planning map. Its approved provision "provide the WG's assigned Tasks when its owner is next awakened" is amended on the map to pointer-only wake; ADR-0016 records the trade-off between injection, pointer, and pure query.
- #265's specification and user stories were rewritten from "WG board / information board" to Working group glance; the escrow visibility rules become the escrow provider's lifecycle rule rather than a separate surface.
- #263 must settle `cancel` clearing the Task's WG field (recorded as a comment on that ticket); without it the Tasks provider has no derived filter.
- Canonical terms: `Working group glance` and `Glance entry` in CONTEXT.md. Avoid: board, blackboard, feed, channel — the glance is state, the channel is conversation.
