# Self-hosted operation and recovery promises

The Local Operator MVP turns Sprout's durable coordination foundation into a
self-hosted product for one technical lead. The foundation already persists
Messages, Tasks, Agent runs, leases, and Project state in SQLite, reconciles
orphaned runs after a restart, and prevents a recovering lease from being
reassigned. It does not yet define a supported browser-access boundary, divide
host setup from routine Web operation, explain Worker connectivity as product
state, protect schema changes, or provide a complete escape path when normal
recovery is itself broken.

The product owner settled those promises in #48. This decision defines the
minimum operational trust boundary for M2 without turning the Local Operator
MVP into a production-deployment, backup, or upgrade-management product.

## One operator and one private Web boundary

One Sprout instance has one **operator identity**. The same Human may hold
several concurrent browser sessions on desktop and mobile; they are sessions of
the same operator, not separate Human accounts. Sprout does not add invitations,
roles, a second administrator, external identity providers, or multi-Human
authorization for M2.

The Web product is supported through either:

- loopback on the host running the Sprout instance; or
- TLS over an operator-managed private network, with a private overlay as the
  preferred cross-network path established by #47.

Direct public-Internet exposure is unsupported. A non-loopback browser session
therefore needs both the private network boundary and Sprout's single-operator
authentication; private-network membership alone is not Sprout authority.
Operator credentials are initialized and recovered on the Sprout host, have no
default value, and never appear as durable URL credentials. Web can list and
revoke browser sessions or revoke all other sessions. Host-local credential
recovery or rotation invalidates existing sessions. Agents, Environment
Workers, and wake models never receive the operator credential.

The Web experience has mobile and desktop capability parity. A browser that
cannot reach the Sprout instance may show its last observed state as stale, but
M2 provides no offline command queue and accepts no control action until the
browser reconnects.

## Host-local setup and routine Web operation

Actions that inherently change a host or handle host-owned credentials may
remain host-local:

- installing, updating, or removing Sprout, an Environment Worker, Codex, or
  Pi;
- selecting the operating-system user and granting workspace, startup, and
  network access;
- logging Codex or Pi in, refreshing that login, or logging it out;
- generating and storing a Worker private key, joining a private overlay, and
  configuring firewall policy;
- registering the macOS user login item or Windows logon-triggered task; and
- resetting local Worker identity or running offline host diagnostics.

The Environment Worker runs in the intended user's context after sign-in, so it
can use that user's engine login and workspace. It is not promised as an
unattended system or root service. Host service registration starts it after
login and restarts it after an unexpected process exit.

After bootstrap, routine product operation occurs through Web. The operator can
create, approve, reject, inspect, and revoke Environment enrollment; configure
capability permission; inspect compatibility and engine readiness; request a
new readiness probe; manage Projects, Agents, Messages, Tasks, runs, and leases;
inspect diagnostics; and choose recovery or release outcomes without editing
runtime JSON.

M2 has no Web action to restart the Sprout instance or an Environment Worker,
drain work, enter maintenance mode, or schedule a restart. A Human starts or
restarts those processes on their hosts. OS restart-after-exit is service
behaviour, not a Web maintenance workflow. Sprout observes the resulting
disconnect and reconnect through the same recovery semantics as any other
channel loss.

## Environment health is a summary plus independent facts

An Environment never collapses installation, authentication, compatibility,
connectivity, and work safety into one boolean. Web exposes at least these
independent dimensions:

- enrollment: `pending`, `approved`, or `revoked`;
- connection: `never connected`, `online`, `reconnecting`, or `offline`, with
  the last confirmed time and age;
- compatibility: `unknown`, `compatible`, or `incompatible`;
- each capability's permission and each engine's `ready`, `login-required`,
  `missing`, or `unknown` readiness; and
- work safety: `clear`, `reconciling`, or `recovery`.

Web also gives the Environment one prominent traffic-light summary with a text
reason:

- **Green — Ready** means enrollment is approved, the Worker is online and
  compatible, every capability and engine required for its configured use is
  permitted and ready, and no work is reconciling or recovering.
- **Yellow — Attention** means a fact is pending or the Environment is degraded
  without a confirmed safety block, such as pending enrollment, first
  connection, a brief reconnect, a stale probe, or an unavailable non-required
  engine.
- **Red — Unavailable / Action required** means the Worker is offline or
  revoked, its protocol is incompatible, a required capability or engine is
  unavailable, or work is reconciling or recovering.

Colour never carries the distinction alone. The reason names the decisive fact,
for example `Offline for 12 minutes` or `Lease recovery required`, and the
independent dimensions remain inspectable.

## Disconnect, reconnect, and version mismatch

Normal reconnect by the same enrolled Worker identity is automatic. It does not
require another Human approval, but it re-authenticates the Worker and rechecks
revocation, protocol compatibility, capability permission, and engine
readiness. A compatible reconnect with no uncertain work becomes available
again after those checks.

A version mismatch leaves enrollment intact but blocks new work and points the
Human to host-local update or downgrade instructions. Sprout never guesses
across an unsupported protocol range. Revocation prevents new commands and
future authentication; restoring a revoked host requires fresh enrollment
rather than toggling an old binding back on.

If the Worker channel is lost during an Agent run, Sprout does not intentionally
allow that run to continue unobserved. The Worker stops accepting commands,
immediately attempts to interrupt the engine turn, and retains the events and
settlement evidence already produced so they can be reconciled after reconnect.
The Sprout instance shows channel loss and an unsettled outcome, protects the
lease, and admits no replacement work. A reconnect synchronizes evidence; it
never automatically replays the run.

When no Agent run was active, an ordinary same-version restart still preserves
the durable lease. The same Worker may return to `clear` automatically after it
proves there is no leftover engine session and its Task context and lease agree
with the Sprout instance. When a run was active, or those facts cannot be
established, the Environment remains in reconciliation or recovery.

## Normal recovery and safe release

A reconnecting socket is not proof that an Environment is safe to reassign.
Normal release requires all of the following:

1. the same authenticated Worker has synchronized its locally retained events
   and settlement evidence;
2. the Worker has proved that the old engine session stopped or has completed a
   local fence/reset that isolates it;
3. the interrupted Agent run has a visible, explainable terminal outcome and no
   event remains pending; and
4. the Human has made the authority decision required by the lease holder.

For a Task-held lease, ADR-0006 continues to govern the normal decision. Resume
keeps the interrupted run as history and returns the Task to deliberate blocked
work on the same Environment; it never reruns automatically. Discard performs
normal Task end, recycles Task context, releases the lease, and only then marks
the Task cancelled. For a one-round run-held lease, the run remains interrupted
and the Human confirms Release after the evidence above is available.

An inaccessible Environment may be archived without pretending that uncertain
work was safely released. Its history and recovery state remain visible, and
that Environment identity admits no new work.

## Human-only emergency Force Release

Early self-hosted software can contain recovery defects, so recovery cannot be
allowed to trap the only operator forever. M2 therefore provides **Force
Release** as an explicit Human-only emergency override.

Force Release is available only for a lease already in recovery. It cannot
preempt an ordinary active lease, cannot be initiated by an Agent or Task lead,
and is never triggered by timeout, inactivity, restart, or any other automatic
policy. Before confirming it, Web identifies every unresolved fact it knows,
including whether the old engine stopped, events are complete, and Task context
was recycled. The Human acknowledges the risks of concurrent execution, missing
results, and leftover temporary state and supplies a reason. Sprout records the
actor, time, reason, unresolved facts, affected Environment, lease, Task, and
runs as a durable operational event.

Sprout still attempts ordinary interruption, reconciliation, cleanup, and
release before applying the override. If they cannot finish:

- a one-round run remains `interrupted`, carries an explicit warning that its
  events or result may be incomplete, and releases its run-held lease; and
- a Task Force Release is also the Human's decision to abandon that Task. It
  performs an emergency Task end, releases the Task lease, and records the Task
  as `cancelled` with a permanent `forced release` disposition, unresolved
  facts, and any unverified context cleanup. The Task can neither resume nor
  move to another Environment.

The Project workspace is never deleted. An unrecycled Task context is recorded
as leftover data. After Force Release the Environment may be assigned again
without Worker proof or fresh enrollment because the Human has explicitly
accepted that risk. The Environment, Task, lease, and run histories continue to
show the override even after the Environment becomes Green.

This is a narrow exception to ADR-0005 and ADR-0006's normal Task-end safety
rule. It changes neither the default recovery path nor the rule that unfinished
work must never become *silently* reassignable: the exceptional release exists
only because the Human knowingly and durably authorizes it.

## Restart durability, schema migration, and backup boundary

An ordinary same-version Sprout restart preserves all durable product state.
Recovery never depends on a backup to satisfy that promise.

M2 does not provide general Backup or Restore commands. The durable data
location and its components are documented so the operator can stop Sprout and
include them in host-managed backup. Scheduling, retention, off-host copies,
restore testing, and disaster recovery remain operator responsibilities.

Schema safety is required even though product-upgrade orchestration is not. Each
released build declares the schema versions it supports and, at minimum, can
migrate forward from the immediately preceding released schema. A schema newer
than the supported range, or one too old for a direct migration, is refused with
host-local guidance rather than opened optimistically.

Every supported migration is transactional and tested. Before changing a
non-empty durable store, Sprout creates a consistent local safety copy. Failure
to create that copy, including insufficient space, prevents migration. A failed
migration preserves the original store and safety copy and prevents normal
product startup; it never serves partially migrated state. The newest
pre-migration copy remains until a later successful migration replaces it or the
operator explicitly removes it on the host. A new empty store needs no
meaningless safety copy. Host-local stopped-service recovery instructions are
required, but Web restore, arbitrary historical upgrades, and downgrade are not.

This safety copy is a migration guard, not a product backup system.

## Sanitized operational diagnostics

The operator can diagnose both a reachable and an unreachable installation:

- Web provides current health and a sanitized diagnostic export containing
  Sprout, Worker, protocol, and schema versions; startup and migration outcomes;
  Environment connection, compatibility, capability, and engine-readiness
  facts; Task, Agent-run, and lease outcomes; recovery causes; times; and durable
  correlation identifiers.
- A host-local diagnostic command can inspect service registration, durable-data
  access, local Worker state, network reachability, and engine readiness when
  Web is unavailable.

Startup, schema migration, enrollment, connection and compatibility changes,
Worker interruption, reconciliation, recovery, and release—including Force
Release—are compact durable operational events. Repeated successful heartbeats
are not permanent history; a readiness fact records its current value, latest
probe time, and latest change. High-volume process logs are bounded host-local
troubleshooting data rather than product audit history.

Durable diagnostics and Web exports never contain credentials, tokens, provider
or account identity, hostnames, network addresses or topology, absolute host
paths, Message or prompt content, private reasoning, commands, tool output, or
unsanitized stderr. M2 has no content-rich or opt-in "advanced" diagnostic
bundle that bypasses this rule. Facts needed to explain unresolved recovery are
not removed merely to satisfy a high-volume log bound.

## Production deployment governance is later work

Self-hosted in M2 does not imply support for:

- public-Internet deployment or cloud SaaS;
- multi-Human identity, roles, SSO, or compliance policy;
- high availability, multiple Sprout instances sharing control, failover,
  zero-downtime upgrades, or availability objectives;
- managed DNS, certificates, reverse proxies, firewalls, or private overlays;
- scheduled backup, Web restore, off-site disaster recovery, or retention
  governance;
- centralized logs, metrics, alerts, or enterprise observability; or
- an unattended system-level Environment Worker or a 24-hour service promise.

The operator owns operating-system maintenance, power, private connectivity,
host backup, and production deployment policy. M2 promises that one technical
lead can start, observe, diagnose, recover, and deliberately release work inside
that controlled boundary.

## Rationale

A private network is necessary but not sufficient authority for a browser that
can start work and release scarce Environments. One operator identity protects
that authority without prematurely introducing team account administration.
Keeping engine login and host changes local preserves the established rule that
credentials belong to the Environment, while moving routine decisions into Web
removes runtime JSON from normal operation.

Independent Environment facts prevent a reachable process from being mistaken
for a compatible, permitted, authenticated, and safe worker. The traffic light
gives the operator a fast mobile summary without hiding why an Environment is
unavailable. Interrupt-on-disconnect favors Human control and bounded side
effects over speculative offline continuation.

Normal recovery remains evidence-based because a socket reconnect cannot prove
that an old engine stopped. Force Release accepts that an early MVP also needs a
way out when its own proof or cleanup path is defective. Making it Human-only,
risk-acknowledged, and permanently auditable preserves the difference between a
safe release and a deliberate emergency override.

Versioned transactional migration and one pre-migration safety copy protect the
same durable state that restart recovery promises. They do not require Sprout to
become a backup scheduler or software deployment manager.

## Rejected alternatives

- **Loopback-only Web access.** It cannot provide the required mobile operating
  surface.
- **Trust the private network without application authentication.** Network
  membership is not Human authority and gives any permitted peer operator
  control.
- **Centralize engine login in Sprout.** This would turn the Sprout instance into
  a credential store and break Environment ownership of Codex and Pi login.
- **Provide Web restart and maintenance orchestration.** It expands M2 into a
  service-management product without being required for routine collaboration
  and recovery.
- **Use one Environment online/offline flag.** It conflates transport,
  compatibility, permission, engine readiness, and work safety.
- **Let disconnected Agent runs continue and report later.** The Human could
  neither observe nor interrupt work while side effects continued.
- **Automatically release after timeout or reconnect.** Neither event proves an
  old execution stopped, and timeout release contradicts ADR-0005.
- **Never allow release without machine proof.** A recovery defect could
  permanently trap the sole local operator; explicit Force Release is the
  accepted escape hatch.
- **Offer Force Release for an ordinary active lease.** That would turn emergency
  recovery into routine preemption and weaken the Task authority model.
- **Call a migration safety copy a backup system.** It would imply scheduling,
  retention, restoration, and disaster-recovery promises M2 does not make.
- **Export raw logs or an opt-in content-rich diagnostic bundle.** Such an export
  cannot reliably preserve the prohibition on credentials and private
  infrastructure details.

## Consequences

- M2 needs a single-operator authentication and browser-session seam without a
  general Human-account or authorization model.
- Environment enrollment, connection, compatibility, readiness, and work safety
  require distinct durable or observed facts plus a deterministic traffic-light
  projection.
- The Worker protocol needs authenticated reconnect, version negotiation,
  revocation checks, interruption on channel loss, and retained reconciliation
  evidence.
- Routine Environment, recovery, diagnostic, and Force Release actions must be
  available through the same mobile and desktop Web product.
- Recovery must distinguish machine-proved safe release from a Human-authorized
  emergency override and preserve that distinction permanently.
- Persistence needs explicit schema versions, compatibility refusal,
  transactional migrations, one consistent safety copy, and failure-before-serve
  behaviour.
- Diagnostics need a structured redaction boundary; raw host logs cannot become
  the Web diagnostic contract.
- `docs/roadmap.md` needs no change: M2-O4 already requires explicit host-local
  setup, routine Web operation, observable compatibility and health, restart
  durability, diagnostics, and safe recovery. This decision makes those checks
  precise without adding an outcome.
