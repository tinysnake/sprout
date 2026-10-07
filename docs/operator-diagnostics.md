# Operator Settings and diagnostics

Ticket #108 implements a read-only backend Module. Settings presentation belongs
in the separate production Settings page ticket; these contracts are available
without completing that page.

## Public contracts

- `src/operations/contract.ts`: browser-safe DTOs, finite operational event
  vocabulary, host-local observations, and structural privacy projections.
- `OperatorDiagnostics`: composed session/settings and diagnostic reads over
  enrollment, current Worker authority, recovery history, and an operational
  journal. It never starts an engine probe, runs inference, admits work, or
  releases a lease.
- `GET /api/operator/settings`: product versions, the immutable process
  `executionMode`, authenticated session state, active-session count,
  private-access boundary, and Web/host responsibilities. The execution mode is
  the one selected at service startup; omission means `environment-hosted` for
  every boot. This read does not probe readiness or perform inference. Settings
  has no mode write route; changing placement requires a service restart.
  The existing session API lists current browser sessions and permits revocation.
  Version ranges are supported protocol majors, not negotiated compatibility.
  Settings does not report schema support limits or safety-copy retention; Web must
  not infer those assurances from a successful read or migration event. The
  production page labels safety-copy status as requiring host verification.

Settings displays the effective mode on desktop and mobile and marks cached
mode facts stale when the browser transport is offline or reconnecting. Once the
transport reconnects, it refreshes the authoritative settings snapshot. It never
stores a browser mode preference or queues a mode mutation.

- `GET /api/operator/diagnostics`: versioned Web JSON export with schema version,
  service and durable-data access facts, independent Environment enrollment,
  accepted Worker connection/reachability, protocol compatibility, engine
  readiness, work safety, and durable operational events. Both endpoints require
  the production browser-session boundary and return `Cache-Control: no-store`.
- `createOperatorBrowserAdapter`: typed browser reads through the existing
  authenticated transport; its connection state remains the transport's state.
- `sprout worker status --diagnostics`: host-local JSON using
  `HostDiagnosticExport`. Observations cover host service inspection, local
  configuration/key access, Worker state and reachability, and product/protocol
  versions. It reads only the Worker host's existing local state. It does not
  read Sprout's database or launch engine probes: schema is `null`, and engine
  readiness is explicitly `unknown`. A host diagnostic caller that already has
  non-inference readiness observations can pass typed facts to
  `projectHostDiagnostic`; unknown input never becomes a healthy fact.

Web manages sessions, enrollment, recovery decisions and diagnostics. Credential
initialization/recovery, engine login, service maintenance, private connectivity
and backup remain host-local responsibilities. Private-network membership alone
is not authority; application authentication is also required. Public-Internet
hosting remains unsupported.

## Journal and restart

Schema v22 adds `operational_events`; the existing transactional migration and
pre-migration safety-copy boundary owns its installation. Initialization and
migration transition facts are written inside the transaction that sets the
schema version, so a failed journal write rolls back the schema change and a
restart after commit retains the `initialized` or `migrated` fact. Same-version
opens are recorded separately as `unchanged`. Schema refusal or migration failure
still happens before normal startup: no diagnostic endpoint opens a refused
database, and the existing typed host-local schema errors remain its failure
contract.

Each runtime composition records a startup-ready fact. Catalog publication
captures enrollment decisions, connection and compatibility transitions, and
recovery/interruption/release decisions. Export also reconciles durable decision
history, so a crash between a domain commit and diagnostic capture loses no
permanent authority or recovery decision. Decision-source hashes deduplicate
history replay; SQL atomically suppresses repeated current-state observations.
Heartbeat times, latency and probe receipts never create journal events.

Source subjects are opaque one-way hashes. A connection subject groups transitions
of one enrollment; decision subjects identify individual durable decisions. The
journal carries only `sequence`, `subject`, finite `kind`/`state`, and epoch-ms
`at`; it stores no routing or content fields. Web export rejoins recovery decision
subjects to the authoritative recovery record to add optional run/Task identities
(including the typed lease holder when the optional identity is absent) and an
established Feed target. Task owners link to Task detail with Project
context; other known runs link to Project Chat or Agent detail. Missing owners
have no target. Rejoining on each export preserves correlation after restart
without changing the journal schema or interpreting a hash as a route.

Settings' Data & Diagnostics tab shows the latest 50 journal entries in insertion
order, their journal event identity, available run/Task identities, and an owner
link only when the Feed grammar and actual browser route validate it. All event
times use one local date/time format with seconds and an ISO `<time datetime>`
attribute. Cached facts keep the existing stale notice. The JSON export continues
to include the full journal; the presentation window does not truncate export.

Sequence is journal insertion order; `at` is decision time for durable history
and observation time for connection/compatibility. Old decisions recovered after
restart may therefore
have earlier times than recently inserted events. All transition facts remain,
including unresolved recovery and permanent Force Release history; there is no
raw-log retention facility. A historical observation without a current accepted
Worker is offline, never an online Worker inherited across restart.

## Privacy boundary

Privacy is field selection, not regular-expression redaction. Export DTOs have no
slots for credentials, provider/account identity, hostnames, addresses/topology,
absolute paths, Messages/prompts, private reasoning, commands, tool output, raw
stderr, operator-authored reasons or engine-authored detail. Engine names are
restricted to the product's supported `pi` and `codex`; model identities, auth
mode/type, arbitrary engine versions and probe summaries do not cross this seam.
Product versions come from the installed package, not an Environment payload.

The only enrichment slots are bounded route-key identities and canonical Feed
targets. Field selection excludes source reasons, goals, run prompts/results,
Messages, host facts, and arbitrary extra routing fields. Rows without a valid
owner remain plain. Counts and finite operational states remain the event window's
only summaries.

The event writer accepts only finite kind/state pairs and integer times. SQLite
reads re-project rows and omit invalid subjects or unrecognized kind/state text,
including historical or tampered rows. Host diagnostics similarly select finite
facts and discard extra properties. There is no advanced/content-rich export.

The service/data fields describe successful reads in this process, not a promise
of host backup or future availability. Reachable means a current accepted Worker
channel, not permission to work or proof that old execution stopped. Readiness,
compatibility and work safety remain separate facts. Host-local unavailable
observations remain unknown rather than guessed from raw command output.

## Test risks

- Lost facts or duplicate noise: SQLite reopen plus concurrent repeated states.
- Privacy escape through legacy rows or rich domain records: hostile-row and
  structural field-selection tests, including credential and reason sentinels.
- Restart confusion and anonymous disclosure: real runtime HTTP with enrollment,
  restart, session authentication and cache headers.
- Browser contract drift: typed adapter routes and inherited transport state.
- Host diagnostics leaking local state: real CLI status export over temporary
  host-local configuration with an untrusted detail sentinel.
