# Environment lease escrow design

Status: product design resolved and synthesized into [implementation specification #265](https://github.com/tinysnake/sprout/issues/265). The local specification is [Environment lease escrow](specs/environment-lease-escrow.md). This records the design decisions; publication is not production implementation evidence.

## Direction

Align with [#260](https://github.com/tinysnake/sprout/issues/260): Tasks remain Project-owned and acquire or release no Environment leases. Agent runs belong to conversations. Lease escrow preserves exclusive Environment occupancy across Agent-run handoffs independently of Task status. Task completion, cancellation, return, or reassignment does not release an escrow reservation.

A Working group is not the lease owner. Its stable identity defines takeover eligibility and governance. Display names confer no authority.

## Confirmed decisions

- A takeover scope names either all eligible current Agent members of one WG, or one specific eligible current Agent member of that WG.
- Only the current legitimate lease user who is a current member of the target WG may escrow it. A specifically named successor must also be a current member. Escrow and takeover validate current Project membership and Environment permissions; takeover scope grants no additional Environment access.
- Taking over transfers current use without making the reservation expire at the successor's run settlement. The successor explicitly escrows again or releases normally. Unexpected holder loss enters recovery and does not make the Environment reassignable.
- The WG owner is its one current Human or Agent member designated as owner under #260, not necessarily its historical creator. Only the Human manages ownership. Escrow management authority follows the current owner.
- The current WG owner and Human may reclaim normal escrow with no active Agent run. Recovery with unresolved stopping or cleanup evidence retains Human-only emergency Force Release authority.
- The current WG owner and Human may change a normal escrow's takeover scope within the WG, recording actor, reason, and before/after scope. The Environment remains occupied throughout the change. They may then wake eligible successors.
- Escrow has no automatic timeout release. Its age, scope, and depositor remain inspectable.
- A timeout wakes the current Agent owner for adjudication or creates Human Attention for a Human owner. The owner chooses normal release or arranges successor takeover.
- Adjudication must remain possible when no work Environment is free. It provides coordination authority without directly granting access to the escrowed Environment's working files.
- Timeout handling is bounded: one unresolved timeout does not repeatedly start owner runs. An unavailable or unresponsive Agent owner causes escalation to Human Attention after a further deadline, while occupancy remains retained. Human owners receive Human Attention directly.
- Escrow first proves the previous Environment execution has stopped, then atomically retains occupancy as escrow and revokes the previous user's authority. Missing stop proof enters recovery instead of claimable escrow.
- Takeover is atomic and grants use to exactly one Agent. Concurrent losers receive an already-taken result; retries of the same request cannot grant another independent use right. Authorization uses current membership, permissions, and takeover scope at the successful transition.
- Losing WG membership, Project membership, or Environment permission prevents takeover without releasing occupancy or broadening a specifically named scope. The current owner is notified to arrange a new successor or release. WG-wide eligibility includes newly admitted, authorized Agent members. Revocation after takeover follows execution stopping or recovery controls and does not immediately reassign the Environment.
- Human disbanding a WG warns about its escrowed leases and automatically releases them as part of disbanding, rather than requiring prior manual release of each lease. Owner transfer preserves occupancy and transfers management responsibility. Cross-WG escrow transfer is outside this design's current scope.
- Normal release, including owner reclamation, requires proof that old execution has stopped and that working state is preserved or has an explicitly authorized disposition. It preserves the Project workspace. Missing stopping or cleanup evidence requires Human recovery adjudication rather than an owner bypass.
- WG disbanding completes even if some automatic releases fail. Normal escrow is released automatically; failures remain blocking recovery reservations with takeover disabled and Human responsible for resolution. Disband confirmation does not itself authorize emergency Force Release.
- Disband warnings also expose outstanding taken-over reservations from that WG's escrow chains. Confirmation disables new takeover, re-escrow, and new runs in those chains, requests existing execution to stop, and releases only after stopping and working-state requirements are met. Unresolved execution or cleanup transfers to Human recovery handling.
- Each escrow includes a durable handoff note identifying the continuation goal, current work state, and necessary deliverable references. The successor receives it before work begins under Project access controls. It does not copy private Agent memory or promise continuation of another Agent's engine conversation.
- Immediate successor activation is optional and explicit. A named scope wakes the named Agent; a WG-wide scope wakes the owner to coordinate rather than broadcasting to all members. Escrow without immediate activation remains claimable and subject to timeout handling. Notification or wake failure does not release occupancy.
- Escrow survives core restart and Worker disconnection without release. It becomes claimable again only after verifying durable escrow/Worker agreement and absence of leftover execution; otherwise it remains blocking recovery for Human resolution. Already-taken execution follows execution recovery rules. Duplicate requests are idempotent, and stale requests cannot mutate a later handoff.
- Default timeout: request owner adjudication after 30 minutes without takeover; escalate an unresponsive Agent owner to Human Attention 2 hours after that request. An owner that cannot be awakened escalates immediately. Durations are configurable. Scope changes or successor wakes do not reset the clock. Explicit owner deferral specifies the next check time and reason; Human Attention does not repeatedly wake anyone.
- One WG may escrow multiple Environments. Each lease has independent scope, timeout, handoff history, and release decisions. No WG count quota or automatic eviction is introduced. Human can inspect all reservations, and the current owner can inspect all outstanding chains for the WG.
- The Working group glance shows every pending escrow and its handoff information to all current WG members, including specifically named scopes that a viewer cannot take over. Visibility is not filtered by takeover eligibility; the takeover operation independently enforces scope and permissions. Once taken over, a reservation disappears from the ordinary-member pending view; the successor's identity and handoff history are not exposed as ordinary-member activity information. The current user still receives its own work authorization and handoff context. Owner and Human management visibility remains available for adjudication and reclamation.
- Successful takeover or release invalidates outstanding timeout attention for that escrow episode.

## Implementation follow-up

Concrete coordination execution and routing mechanisms belong to implementation planning; adjudication must satisfy the confirmed no-free-work-Environment requirement. Storage, APIs, Worker fencing, timeout scheduling, UI integration, and regression validation must implement the product rules above.

## Relationship to existing documentation

The existing Task-held lease implementation and ADRs describe the pre-#260 model. This design follows #260's replacement direction; canonical documentation and implementation reconciliation remain separate work. It does not relax Project permissions, Environment safety, privacy, or Human-only emergency authority.
