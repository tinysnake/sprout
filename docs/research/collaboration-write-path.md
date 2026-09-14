# The M1 collaboration write path and wake contract

**Status**: Prototype recommendation for ticket #25 (part of map #24)
**Scope**: O6 — Multi-agent collaboration (`docs/roadmap.md`)
**Prototype code**: `src/collaboration/` (prototype-only; not a production subsystem)

This document records what the #25 prototype proved, which engine-neutral write
path Sprout adopts for M1 and why, and the wake contract that path implies. It is
the evidence map #24 asked for before any production Message, channel, or Task
ticket is planned.

Nothing here is a production commitment by itself. The prototype code under
`src/collaboration/` exists to make the decisions testable; it is deliberately not
wired into `src/main.ts`, adds nothing to the engine port, and adds nothing to the
engine protocol or the worker protocol (ADR-0003).

---

## 1. What was inspected in the references

Two mature references were inspected at the pinned commits from `docs/references.md`:

- **Cumora** at `a0309618b9102fc79221f8580afdd2f2372ab5df` — cross-platform team
  chat where agents are first-class participants.
- **Paperclip** at `13368c518303e886a5c9445fbc69afcbdf0a9228` — an operational
  control plane for managing agents at work.

### Cumora

| Area inspected | What it does | Sprout adopts | Why not (or the deviation) |
| --- | --- | --- | --- |
| Message model (`server/src/db/schema.ts`, `migrate.ts`) | `messages` rows carry `conversation_id`, `author_id`, `kind` (`text`/`tool`/`thought`/`system`), `body`, `sequence`, `client_id`, `quoted_message_id`. | The minimal conversation unit: author, body, conversation, and an explicit reply link. Sprout calls the reply link `inReplyTo`. | Sprout stores **only** author text in conversation. Cumora keeps `tool` and `thought` as message kinds in the same table; Sprout keeps those in the run record and excludes them from conversation entirely (§6). |
| Message-level routing (`server/src/agents/routing.ts`) | Deterministic target derivation (exact `@mention`, `@all` broadcast) plus a *small* model that only answers "me" or "each". Every uncertainty — no targets, model error, unparseable answer — resolves to `each`. | **Adopted almost verbatim** as the M1 wake contract (§5): addressed messages never reach the model; the model only decides whether an unaddressed room engages; failure fails open. | None. This is the strongest reference match in the ticket. |
| Wake bus (`server/src/agents/runtime/wake-bus.ts`) | Redis pub/sub per agent plus per-agent SSE; a durable inbox is the fallback; events are deduped by id; a backed-up subscriber is dropped and re-drains the durable inbox. | The **principle**: the durable input is the source of truth and a transport failure must never lose work. | The mechanism is not adopted. It assumes a multi-instance server with always-on per-agent pods and Redis. Sprout M1 is one local core with lazily started workers; there is no resident pod and no Redis, and adding them before the write path needs them would be infrastructure for its own sake. |
| Inbox triage / cerebellum (`server/src/agents/inbox-triage.ts`) | A cheap gate decides whether to wake the expensive model; it fails **closed** for synthetic wakes and, for the routing decision, falls back to the full fan-out. | The bias `docs/goal.md` already states: prefer an observable extra wake over silently losing addressed work. | Adopted as a principle, not as a component. Sprout's M1 wake model has one job (§5) and no cost-ledger. |
| Idempotent create (`server/src/idempotent-create.ts`) | `requestId` + `pg_advisory_xact_lock` + a request hash; a repeat returns the already-created entity, and a hash mismatch is a conflict. | The pattern: a delivery key is unique, and a repeat returns the stored entity rather than creating a second one. | Sprout uses a unique key and `INSERT OR IGNORE` semantics rather than an advisory lock, because M1 is a single local SQLite database (ADR-0002). |
| Agent CLI write path (`server/src/agents/cli-identity.ts`, `runtime/client.ts`, `agent-cli/`) | Agents act through a `cumora` CLI. A server-owned JWT scoped to `{agentId, companyId, scope:'agent-run'}` is injected before the CLI runs; the CLI resolves identity from ambient runtime credentials, never from a caller-supplied flag in production. | The identity model is the *right long-term shape* for agent-initiated writes. | **Deferred** (candidate B in §2). It needs per-run credentials and a reachable endpoint in every environment, and the container and Windows topologies do not have one at M1. |

### Paperclip

| Area inspected | What it does | Sprout adopts | Why not (or the deviation) |
| --- | --- | --- | --- |
| Wakeup requests (`packages/db/src/schema/agent_wakeup_requests.ts`) | A durable per-agent row with `source`, `reason`, `payload`, `status`, `coalesced_count`, `idempotency_key`, `run_id`, `requested_by_actor_type/id`, plus partial unique indexes per idempotency-key family. | **The shape of the M1 `WakeRequest`** (§6): durable, per-recipient, idempotency-keyed, linked to the run it admitted, with an explicit status. | Sprout drops `coalesced_count` and the actor columns for M1: one wake is one run, and there is no multi-tenant actor model yet. The *fields* are deferred, not rejected. |
| Run record (`packages/db/src/schema/heartbeat_runs.ts`) | `heartbeat_runs.wakeup_request_id` links a run back to the wake that caused it. | The durable `WakeRequest.runId` link, in the same direction. | Adopted. |
| Inter-agent communication (`doc/SPEC.md` §5) | "All agent communication flows through the task system… There is no separate messaging or chat system. Tasks are the communication channel." | Nothing. | **Explicitly not adopted.** Sprout keeps Message and durable Task distinct (`docs/goal.md`, `CONTEXT.md`): a Message is conversation, a Task is durable multi-run work. Collapsing them is exactly the conflation the ticket forbids. Paperclip's model is the reference for the *Task* ticket, not for Messages. |
| Execution semantics (`doc/execution-semantics.md`) | Single assignee; `checkoutRunId`/`executionRunId` ownership locks; blockers; parent/sub-issue reporting; the courier pattern. | Nothing yet. | This is durable Task territory and belongs to a later ticket; #25 is a non-goal for it. |
| Agent API keys (`packages/db/src/schema/agent_api_keys.ts`) | A hashed key per agent, with a scope blob and revocation. | Nothing yet. | Deferred with candidate B. It is the credential model an agent-facing API would need. |
| Run-log events (`doc/run-log-events.md`) | Run events are a separate, redacted stream with hashes and sequence cursors; they are not conversation. | The **separation**: run events/raw output are never conversation. Sprout already keeps them in `AgentRun.events`. | Sprout keeps M1's version far simpler (a JSON document per run, ADR-0002). Paperclip's codec and hash machinery are for a multi-tenant cloud, not M1. |

**Summary of adoption**: Sprout adopts Cumora's *wake routing rule and fail-open
bias* and Paperclip's *durable wakeup-request + run-link shape*. Sprout does not
adopt Cumora's Redis/SSE wake bus, Cumora's agent CLI write path, or Paperclip's
"tasks are the only channel" model.

---

## 2. The three candidate write paths

The question: how does a persistent Agent running inside a macOS, container, or
Windows environment read collaboration input and write a reply back to the core?

Each candidate is assessed against (a) the three worker topologies and (b) the
explicit facts the ticket requires: Agent identity, authentication, reachability,
cancellation, and restart behaviour.

### Candidate A — automatic final-result projection **(selected)**

The Agent writes nothing explicitly. After a run admitted by a wake request
settles, the **core** projects the run's final assistant text as one Agent-authored
reply Message linked to the input.

| Concern | macOS (worker over loopback TCP) | Container (worker over exec pipe) | Windows (worker over SSH-tunneled daemon) |
| --- | --- | --- | --- |
| Agent identity | The core uses `run.agentId`, the record it created. | Same. | Same. |
| Authentication | None added. The run already crossed the existing worker channel authenticated by the carrier. | None added. | None added. |
| Reachability | The core never initiates anything to the environment beyond the existing run session. | Same. | Same. |
| Cancellation | `orchestrator.stop` settles the run as `interrupted`; no reply is projected. Deterministic. | Same. | Same. |
| Restart | The reply is keyed by the wake idempotency key, so re-projection cannot duplicate it. A run orphaned by restart is already reconciled to `failed` (O4), so no reply is fabricated. A `completed` run whose reply was never projected can be re-projected from the persisted run result. | Same. | Same. |

Because projection happens in the core and uses only `EngineTurnResult.text` —
which every adapter already produces — it is **engine-neutral**, needs no new
protocol surface, and behaves identically across all three topologies.

### Candidate B — an Agent-facing Sprout API/CLI

The Agent, inside the environment, calls a Sprout endpoint (HTTP or a CLI) to post
messages and, later, mutate Tasks. This is Cumora's model.

| Concern | macOS | Container | Windows |
| --- | --- | --- | --- |
| Agent identity | Needs a per-run credential bound to `agentId`. | Same, and the credential must be injected into the engine's process environment inside the container. | Same, injected into a detached daemon's environment or exec session. |
| Authentication | Required: a per-agent token (Cumora uses a server-issued JWT). New secret distribution and rotation surface. | Same, plus the token must survive the exec boundary. | Same, plus it must survive the SSH/daemon boundary. |
| Reachability | The core's HTTP address is reachable from a local macOS run. | **Blocked at M1.** A container publishes no port, and the carrier is core→worker only; there is no reverse route from the container back to the core. | **Blocked at M1.** The SSH tunnel is core→daemon; no core endpoint is exposed to the daemon. |
| Cancellation | The agent may write independently of its run, so a stopped run can still have written conversation. Ordering becomes a new concern. | Same. | Same. |
| Restart | Durable writes survive; but a mid-run server outage becomes an agent-visible failure mode. | Same. | Same. |

Candidate B is the right long-term shape for *agent-initiated* writes (durable
Task mutations, richer replies, multi-message turns), and Cumora's scoped-JWT
identity model is the reference for it. It is **not viable at M1** because the
container and Windows topologies have no core reachability today, and adding an
inbound endpoint plus per-run credentials is a larger, riskier change than
proving the collaboration invariant needs.

### Candidate C — worker-mediated core operations

Add collaboration verbs (read inbox, post message) to the core↔worker protocol so
the worker relays them.

This is rejected on architectural grounds, not on effort. ADR-0003 states the
worker protocol expresses the **engine port** and that no engine-specific
collaboration method may enter it; the worker "is not the agent" and owns neither
agent identity nor conversation. A collaboration verb on that protocol would make
the worker a second source of conversation truth and would still need the Agent to
invoke it — collapsing back into candidate B, but with the ownership error added.

**Decision**: adopt candidate A for M1. Candidate B is recorded as the deferred
successor for agent-initiated writes; candidate C is rejected.

---

## 3. Probe evidence

The probe is `src/collaboration/probe.test.ts`. It runs in `npm test` and is
deliberately shaped so the ticket's constraint — "the worker and persistence
boundaries may not both be faked" — is satisfied literally:

- **A real worker process.** `EndpointCarrier.start` launches a separate OS
  process hosting the scripted engine and connects over a loopback TCP endpoint.
  The probe asserts the worker's pid differs from the test process's.
- **Real core orchestration.** `RunOrchestrator` resolves the project's
  environment, acquires a lease, starts a session through the worker, streams the
  turn, and settles the run.
- **Real SQLite persistence.** Messages, wake requests, observations, runs, and
  leases all use `SqliteCollaborationStore` / `SqliteStore` over a real database
  file. The probe re-reads rows through an **independent** connection to prove the
  data is on disk.
- **A fake engine only.** The scripted adapter replays one turn. This is the
  permitted isolation of the transport question, and it lets the probe emit
  private events (`TOOL_OUTPUT_MUST_NOT_LEAK`, `PRIVATE_REASONING_MUST_NOT_LEAK`)
  to prove they are excluded from the reply.

What the probe shows:

1. **One addressed input → one durable Agent-authored reply.** A direct Message to
   `scout` wakes `scout` with reason `direct-recipient`, admits exactly one run
   through the real worker, and produces exactly one reply authored by `scout`
   whose `inReplyTo` is the input and whose body is the run's final text. The
   reply contains neither the tool output nor the notice event.
2. **Persistence-before-wake.** The Message and its wake request are committed in
   one store transaction *before* any run is admitted. In the probe, the wake row
   is already `admitted` with its run id before the test inspects the reply.
3. **Idempotent retry.** Delivering the same `deliveryKey` twice returns the same
   durable input, admits no second run, and leaves exactly one wake request and
   exactly two Messages (input + reply).
4. **Lost acknowledgement.** After a run is admitted, a retry with the same
   delivery key returns the durable wake still naming its one run and admits
   nothing new.

Store-level evidence is in `src/collaboration/sqlite-store.test.ts`: a Message and
its wake requests survive reopening the database; a repeated delivery key inserts
nothing; exactly one of two `admitWake` calls wins.

Wake-contract evidence is in `src/collaboration/wake.test.ts`; coordinator
behaviour (no reply for failed/interrupted runs, prompt content, observation
surfacing) is in `src/collaboration/coordinator.test.ts`.

**Residual gap (honest)**: the probe projects the reply inside `deliver`, after
awaiting the run. If the core process died *after* a run completed but *before* it
projected the reply, the reply would be missing until a reconciliation pass
re-projects it from the persisted run result. The write path supports this
(re-projection is idempotent by wake key), but no reconciliation pass is wired in
the prototype. This is recorded under New fog in the work record.

---

## 4. Persistence-before-wake and idempotent retry

Both invariants live in the store, not in the caller, which is what makes them
survive a crash or a race:

- `collaboration_messages.delivery_key` is `UNIQUE`; a retry is recognised by the
  key and returns the stored Message.
- The Message and its wake requests are written in **one transaction**, so no
  reader can observe an input with no wake request to recover from.
- `collaboration_wake_requests.idempotency_key` is `${messageId}:${agentId}` and
  `UNIQUE`; `admitWake` is a compare-and-set (`WHERE status = 'pending'`), so at
  most one caller can transition a wake to `admitted` and thereby admit a run.

The ordering the coordinator enforces is: **persist the input → persist the wake
requests → admit the run → project the reply**. A crash at any boundary loses at
most *unprojected work*, never *unrecorded input*.

---

## 5. The M1 wake contract

Given one durable Message and the project's members, the contract decides who is
woken and why. The governing rule: **prefer an observable extra wake over silently
losing addressed work.**

| Message kind | Woken | Reason | Reaches the wake model? |
| --- | --- | --- | --- |
| Direct Message | Exactly its declared recipients. | `direct-recipient` | No. |
| Project channel with `@all` | Every other member. | `broadcast` | No. |
| Project channel with exact `@<agentId>` mention(s) | Exactly the mentioned members. | `agent-mention` | No. |
| Project channel, unaddressed, model engages | Every other member. | `wake-model` | Yes. |
| Project channel, unaddressed, model suppresses | Nobody, **recorded as a `suppressed` observation**. | `wake-model` | Yes. |
| Project channel, unaddressed, model missing or failed | Every other member. | `wake-model-fail-open` | Yes (fails open). |
| Recipient is not a project member | Nobody, **recorded as a `failed` observation**. | (the original reason) | Depends on kind. |

Rules that follow from the governing rule, each with its test in
`src/collaboration/wake.test.ts`:

- **Addressed messages are deterministic and never consult the model.** This is
  the one silent failure mode — an addressed agent that is never woken leaves no
  reply and no run record — and determinism removes it. A broadcast or mention
  bypasses the model entirely.
- **Mentions are whole tokens.** `@forge` does not match `@forge-two`, matching
  Cumora's `@all` token rule.
- **The author is never woken by its own Message.**
- **The wake model only decides *whether*, never *who*.** It cannot narrow the
  recipient set, so it cannot drop an addressed agent.
- **Failure fails open.** A missing, throwing, or unusable wake model wakes every
  other member and records a `failed` observation. This is the Cumora `routing.ts`
  rule adapted to Sprout's vocabulary.
- **Suppression and failure are durable, never silent.** A deliberate model
  refusal is a recorded `suppressed` observation, reachable only for an
  unaddressed Message. "Nothing happened" is never indistinguishable from a bug.

The `@all` token is `(?<![\w@])@all(?![\w-])`, the same rule Cumora uses, so a
broadcast is never confused with an address such as `@allen`.

---

## 6. Minimum durable fields and relationships

The minimum needed to reconstruct causality from an input to a reply, and to
enforce idempotency, is four records and three links.

### `Message` (`collaboration_messages`)

| Field | Purpose |
| --- | --- |
| `id` | Identity. |
| `project_id` | Which project's channel. |
| `channel` | `direct` or `project`. |
| `author_id`, `author_kind` | Who wrote it (`human`/`agent`); the attribution the reply preserves. |
| `body` | The conversation text. |
| `recipients` | Declared addressees for a direct Message; empty otherwise. |
| `delivery_key` **UNIQUE** | Idempotency: a repeated delivery produces one Message. |
| `in_reply_to` | The Message this one answers; null for a new input. |
| `created_at` | Ordering. |

### `WakeRequest` (`collaboration_wake_requests`)

| Field | Purpose |
| --- | --- |
| `id` | Identity. |
| `message_id` | The input that caused it. |
| `project_id` | Denormalized for querying. |
| `agent_id` | The one recipient this wake is for. |
| `reason` | `direct-recipient`, `agent-mention`, `broadcast`, `wake-model`, `wake-model-fail-open`. |
| `status` | `pending` → `admitted` (or `suppressed`/`failed`). |
| `idempotency_key` **UNIQUE** | `${message_id}:${agent_id}`; at most one admission. |
| `run_id` | The Agent run admitted, once one was. |
| `detail` | Why a wake was suppressed or failed. |
| `created_at` | Ordering. |

### `AgentRun` (existing, `agent_runs`)

Unchanged: `id`, `agent_id`, `prompt`, `environment_instance_id`, `project_id`,
`status`, `events`, `result`, `created_at`, `completed_at`.

### Reply

Not a separate entity. A reply **is** a `Message` with
`author_kind = 'agent'`, `in_reply_to = <input id>`, and
`delivery_key = 'reply:' + <wake idempotency key>`. Keeping one conversation unit
is what prevents a parallel, unsanitized reply store.

### Relationships

```
Message ──1:N──► WakeRequest ──0..1──► AgentRun
   ▲                                        │
   └──────────── in_reply_to ───────────────┘   reply Message authored by run.agentId
```

### Where private run events and raw reasoning are excluded

- A run's tool calls, tool output, notices, and any engine-internal reasoning stay
  in `AgentRun.events` (and the engine's own session store). They never become a
  `Message`. The probe asserts this explicitly with sentinel strings.
- A reply's body is **only** `EngineTurnResult.text` — the final assistant
  message. This is the same boundary O5's hand-off rule already draws for shared
  context, applied here to conversation.
- This is a deliberate deviation from Cumora, which stores `tool` and `thought` as
  message kinds in the conversation table. Sprout keeps those out of conversation
  so a teammate reading the channel never sees another agent's raw working state.
- Cancellation and failure produce **no reply at all**: an answer that was never
  produced is not fabricated.

---

## 7. Proposed next production tickets

Only what the evidence makes ready. These are proposals for map #24's
`Work graph`, not commitments:

1. **Production Message and project channel, projected replies.** Implement the
   adopted write path for real: durable Messages, the wake contract, automatic
   final-result projection, and a reconciliation pass that re-projects a reply for
   a `completed` run whose projection was lost to a restart. Persist behind a
   `CollaborationStore` interface with SQLite (ADR-0002).
2. **Collaboration observability in the Web client.** Let a human read the project
   channel, see each Message's wake requests and reasons, see suppression/failure
   observations, and stop the run a wake admitted. This is what makes the "never
   silently lose addressed work" rule verifiable by a person.

Deferred until the evidence above exists:

3. **Agent-facing Sprout API/CLI (candidate B)** with a per-run scoped credential,
   once a reverse-reachability and credential story exists for container and
   Windows environments.
4. **Durable Task lifecycle** (Paperclip-informed): the M1 Task states, links to
   runs, and blocker semantics — only after Message work is proven end to end.

Non-goals restated (#25): a production Web chat UI, the final durable Task
implementation, advanced subscriptions/topic routing, and the full four-engine
three-environment O6 acceptance scenario.
