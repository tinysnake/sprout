# Agent direct messages

An active Project-bound Agent run can explicitly send a direct message to another
current member of that Project. Core resolves the author and Project from the
admitted Run. The command accepts only `recipientId`, `body`, `deliveryKey`, and
optional `awaitReply`; author, authority kind, Project, and scope cannot be chosen
by the engine. The authenticated browser remains Human-only.

Production execution carries this capability over the authenticated Environment
Worker channel. The Worker adds a session-local shell command to the engine's
standing instructions. Its local bridge requires a random session credential,
accepts bounded JSON requests, and closes on session close, startup failure, or
Worker shutdown. Core also refuses sends once the Run settles or stop is
requested. Credentials and host-local bridge locations are not persisted in
Core's Run instructions, Messages, or browser views. The bridge grants no Task
approval, membership, environment permission, or other Human authority.

Use one stable delivery key for one intended send and reuse it on retry. Keys are
namespaced by the server-resolved Agent and Project. A canonical direct pair is
opened idempotently, then the existing collaboration coordinator persists the
Message and wake before submitting recipient work. The deterministic
`direct-recipient` contract, membership/scope checks, normal environment
admission, and reply projection are shared with Human messages.

`awaitReply` defaults to false so the sender need not remain blocked while the
recipient runs. Set it to true only when waiting is appropriate. The result
contains the durable Message and scope identities, actual author, duplicate
flag, wakes, newly submitted Run IDs, and current Run status/failure facts.
A stored Message or an `admitted` wake is not proof that execution succeeded:
the existing coordinator can link a wake to a Run that records an environment
admission failure. Inspect `runs` and `wakes`; unavailable or busy capacity never
starts an engine, and later outcomes remain observable through Chat evidence.
Repeated delivery returns the original Message and wake facts rather than
creating another wake.

ADR-0007 supplies the loop rule: automatically projected final replies are
non-routing, including replies containing mentions or broadcasts. Reconciliation
cannot turn them into new wakes. Only a separate explicit send can initiate
another activation. This bounds automatic reply cycles; it does not impose a
budget on independently requested messages.

The Human can inspect the existing Project Chat scope list. Agent-pair titles
name both participants, and messages carry an Agent badge beside the actual
author. Inspection does not make the Human a participant: sending into an
Agent-only pair remains refused, and participant-only unread receipts remain
unchanged. Messages and replies stay in their canonical pair; they are not
copied into either Human–Agent conversation. Direct content is excluded from
routing-model context, which retains its existing bounded windows and excerpts.
No additional transcript store or in-memory message mirror is introduced.

The bridge is for tools available to a Worker-hosted CLI engine. An engine that
cannot execute the supplied shell command cannot initiate sends through this
surface. A recipient can fail admission while the sender occupies scarce
capacity; sending does not release or transfer the sender's lease.
