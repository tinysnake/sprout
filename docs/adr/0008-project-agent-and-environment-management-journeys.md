# Project, Agent, and Environment management journeys

The M1 coordination foundation can load Agents and a default Project from
runtime JSON, connect one configured Environment Worker, and persist additional
Projects. That is sufficient to prove the coordination seams, but it is not a
product management journey. A local technical lead still needs to establish
portable Agent identities, enroll host-local Environments, create Projects and
their workspaces, change those objects without rewriting history, and retire
them without losing work.

The product owner settled the M2 management boundary in #52. This decision
defines observable outcomes rather than page layout, protocol fields, or
storage schemas. It preserves ADR-0003's Worker boundary, ADR-0004's
environment-slot session scope, ADR-0005's persistent Project workspace, and
ADR-0006's Human authority over Project permissions and Task begin.

## Ownership and collaboration boundaries

Agents, Environment instances, Project templates, and Projects are independent
objects at the Sprout-instance management boundary. A Project owns its Project
contract, Project memberships, Environment access, Project workspaces, Working
groups, and collaboration history.

A Project membership references a global Human or Agent; it does not copy or
own that identity. Project Environment access likewise references an enrolled
Environment instance. A Project workspace belongs to one Project on one
Environment instance, while its absolute host path remains an Environment-local
fact. Neither an Agent nor portable Project identity contains a host path or an
engine credential.

A Project requires a stable identity, a non-empty display name, the local
Human's Project membership, and its Project channel. Its goal, rules, Agent
memberships, Environment access, and Project workspaces may all be absent. This
is a complete Project, not an incomplete draft. Missing Agents or Environments
limit what the Project can do: a Task proposal may still be recorded, but Human
approve-and-begin is unavailable until the Project has an Agent, an Environment
with a Project workspace, and a compatible Agent work option.

Only the Human may add or end Agent Project memberships. Membership-specific
responsibilities and collaboration instructions are optional. An Agent cannot
join a Project or invite another Agent. Adding an Agent does not bind it to an
Environment; compatibility is reported across the Project's current
Environment instances. Ending membership prevents new Project communication
and Agent runs while preserving historical attribution. A run already admitted
may settle naturally or be interrupted by the Human. An unfinished Task that
depends on the removed Agent exposes a blocker and never substitutes another
Agent silently.

## Project and Working group communication

Routine communication has three explicit scopes:

1. A Project-scoped direct message between current members of the same Project.
2. The Project channel, whose current participants are all Project members.
3. A Working group channel, whose participants are the members of one Working
   group inside that Project.

Direct-message history is separate per Project. A pair that shares two Projects
therefore has two distinct direct-message contexts. When a membership ends, the
old direct messages remain readable but no new message can be sent in that
Project.

A Working group is a temporary collaboration scope within exactly one Project.
It has a stable identity, non-empty display name, optional goal and rules, a
subset of current Project members, a creator, a channel, and durable membership
history. A Human or Agent Project member may create one and is included as its
first member. The creator may change its name, goal, rules, and members and may
disband it; the Human may manage any Working group. It can include Human-only,
Agent-only, or mixed membership, but never a non-Project member.

Creating a Working group and its channel is atomic. Creation itself sends no
message, wakes no Agent, creates no Task, and acquires no Environment lease.
Disbanding makes the channel read-only instead of deleting its configuration,
membership changes, or messages. The Human or its creator may restore it when
its members are still eligible. An ended Project membership also ends that
member's current participation in every Working group without erasing history.

Sprout presents both Project and Working group rules to an Agent where relevant;
it does not interpret conflicts, enforce a rule-precedence algorithm, or decide
whether one rule weakens another. A one-round run caused by a Working group
message receives the current Project contract plus that Working group's current
goal and rules.

A Task remains Project-owned and retains ADR-0006's authority and lease model.
A Task proposal created from a Working group records that group and source
message as provenance. Human approve-and-begin records the Working group context
version used for the approval, so later edits cannot silently change an active
Task. Disbanding the source Working group neither ends nor blocks the Task.

## Portable Agent configuration

An Agent is created independently of any Project or Environment. It requires a
stable identity, a non-empty display name, and at least one ordered **Agent work
option**. Each option contains an engine, work model, and effort. The list may
span Codex and Pi. Standing instructions and other descriptive text are
optional.

At run admission, Sprout evaluates the selected Environment instance and takes
the first configured option whose engine is permitted and authenticated and
whose model is available. It may move to the next option only before an engine
accepts the run. Once accepted, a later failure is reported; Sprout never
replays the work automatically through a lower-priority option because tools may
already have produced side effects. Every run records the actual Agent
configuration version, engine, work model, and effort it used.

An Agent may be created even when no current Environment supports its options.
Environment reports inform the Web suggestions and compatibility display, not
the Agent's identity. Reordering, adding, or removing options affects later
runs, preserves earlier run facts and engine sessions, and cannot leave an
Agent with no work option.

## Built-in template and Project creation

M2 provides one immutable built-in **General collaboration** Project template.
It is the starting point for every Project creation and supplies editable,
clearable goal guidance, suggested rules, optional Agent role slots,
collaboration guidance, and completion guidance. M2 does not provide custom
Project template creation, editing, archiving, or deletion.

The template never contains concrete Agents, Environment instances, Project
workspaces, models, credentials, or host paths. Project creation copies the
template content and records its source version; later Sprout template changes
do not rewrite an existing Project. The Project channel is an invariant of a
Project, not template content.

Outside first-run onboarding, the Human creates a Project by naming it and may
optionally:

- fill or clear its goal and rules;
- select global Agents and enter optional membership responsibilities and
  collaboration instructions; and
- add enrolled Environment instances, preparing one Project workspace for each.

One submission atomically creates the Project, Human and selected Agent
memberships, Project channel, Environment/workspace bindings, and template
snapshot. Working groups are created later as needed. A Project with no Agent or
Environment remains valid, but the product explains why Task begin is not yet
available.

## Environment enrollment and Project workspace selection

Environment enrollment follows #47's accepted direction: the common Worker
protocol runs over authenticated TLS/WSS on a private operator-managed overlay
for the preferred cross-network path. Host bootstrap remains necessary because
Web cannot install a process, generate and protect the Worker private key,
register user-session startup, configure host networking, choose filesystem
roots, or log Codex and Pi in for the Human.

The Web creates a short-lived pending enrollment. On macOS or Windows, the Human
runs the host bootstrap in the intended user's context. The Worker proves
possession of its host-generated private key, and the Web presents its identity,
platform, protocol, requested capability permissions, and neutral engine facts.
One explicit Human action approves the Worker identity and its capability
permissions. Duplicate new identities and revoked Workers cannot work without
an explicit reset and fresh approval.

Enrollment and readiness remain separate. An enrolled Environment instance
keeps its identity when it disconnects, becomes protocol-incompatible, or loses
an engine login. Web reports carrier connectivity, transport authentication,
protocol compatibility, capability permission, engine installation, engine
authentication, model availability, readiness-probe result, and Project
workspace availability as distinct facts. Sprout never receives engine or
overlay credentials. M2 requires Codex and Pi across the product, not both on
every Environment instance.

Adding an Environment instance to an existing Project is itself the Human grant
of Project access; there is no second authorization step. In the same Web action
the Human either accepts the Worker-managed default Project workspace or selects
an existing repository/directory beneath a host-configured Worker workspace
root. The common path is one action with the default selected. The Worker first
validates or prepares the workspace; only then does Sprout atomically record
Environment access and the binding. Failure leaves the Project unchanged.

Web deals in a Worker-validated relative location or opaque workspace identity.
The absolute path remains on the host. Each Project has at most one current
Project workspace on a given Environment instance, while it may have independent
workspaces on several instances.

Changing a workspace is permitted only when the Project and Environment have no
active Agent run, unfinished Task lease, or lease recovery. The Worker prepares
or validates the replacement before the binding changes. Sprout does not move,
copy, merge, or delete the old directory. Historical work retains the old
binding, and later runs start a new native session slot because ADR-0004 scopes
sessions to the working directory.

## First-run journey

First-run onboarding is Web-led and yields a Project that can communicate and
begin Agent work:

1. Web creates a pending Environment enrollment and supplies the macOS or
   Windows bootstrap instructions.
2. The Human completes host-local Worker installation, user-session startup,
   private-overlay setup, key generation, and at least one engine login.
3. The Human approves Worker identity and capability permissions in Web and can
   inspect each independent readiness fact.
4. The Human creates or selects a global Agent. Web may prefill one work option
   from observed availability; the Human may reorder or add options.
5. The Human names the first Project. Sprout applies the built-in template,
   adds the Human and chosen Agent, adds the eligible Environments completed or
   already ready during onboarding, prepares their default Project workspaces,
   and creates the Project channel.
6. Web shows the resulting Project, Agent, Environment, workspace, and work
   option facts before entering the Project channel.

No extra Working group is required. Onboarding is complete only when the first
Project has an Agent membership, an Environment with a Project workspace, and a
compatible work option. Pending enrollment and successfully created global
objects survive an interrupted onboarding, but a failed final submission never
stores a partially created Project.

## Editing, history, archive, and revocation

Every effective edit records its actor, time, and changed version or facts.
Project and Working group text, membership instructions, Agent options, and
Environment capability permissions affect only later message delivery, Task
admission, and Agent runs. An active run keeps the versions with which it was
admitted. Historical Messages, Tasks, completion claims, runs, memberships,
workspaces, and attribution continue to identify the versions and resources
actually used.

Revoking an Environment capability is refused while an active run, Task lease,
or recovery depends on it. Editing alone never wakes an Agent, sends a message,
or retries work.

M2 offers non-destructive archive and restore, not hard deletion:

- A **Project** cannot be archived while it has an active run, unfinished Task,
  held or recovering lease, or Task end in progress. Archive makes all of its
  channels and direct messages read-only and prevents proposals and new work,
  while preserving memberships, Working groups, history, bindings, and all
  host-local Project workspaces. Restore rechecks compatibility.
- An **Agent** cannot be archived during an active run or while it remains the
  Task lead of an unfinished Task. Archive prevents new membership, Messages,
  and runs but preserves private memory, memberships, sessions, and attribution.
  Restore does not recreate memberships that ended explicitly.
- An **Environment instance** cannot be archived or unenrolled while an active
  run, unfinished bound Task, held or recovering lease, or recovery depends on
  it. Archive prevents new Project assignment and work while retaining its
  enrollment and history. Unenrollment is a separate security action that
  revokes Worker identity and reconnect authority without deleting the
  Environment record, workspace references, or history. A restored archived
  instance may reuse valid enrollment; an unenrolled one requires fresh Human
  approval.
- A **Working group** is disbanded rather than deleted. Its channel becomes
  read-only and all facts remain available for audit and possible restore.
- Ending a **Project membership**, Environment access relationship, or workspace
  binding records the end of that relationship rather than erasing it.

## Rejected alternatives

- **Own Agents or Environments inside a Project.** This would prevent reusable
  Agent identity and shared Environment capacity, contradicting the product's
  primary portability boundary.
- **Require a Project goal, Agent, and Environment before creation.** This would
  turn optional narrative and temporarily unavailable resources into invalid
  identity. Task begin capability is a clearer boundary than a draft Project
  status.
- **Provide only a Project channel or only Working group channels.** Project-only
  communication cannot form temporary focused groups; Working-group-only
  communication recreates a mandatory special default group. The two-level
  channel model makes both scopes explicit.
- **Allow Sprout-instance direct messages.** Cross-Project messages would lack a
  clear contract, membership, and audit boundary.
- **Give each Agent one engine and model.** Model and harness availability varies
  by Environment. An ordered option list preserves identity without silently
  choosing an unconfigured fallback.
- **Treat enrolled as ready.** A valid Worker identity says nothing about
  protocol compatibility, permission, engine login, model availability, or
  workspace readiness.
- **Store host paths or credentials in Agent, Project, or template identity.**
  Those facts belong to the Environment and would make portable configuration
  unsafe and false.
- **Continuously link a Project to its template.** Later template changes would
  rewrite an established Project contract without a Project edit.
- **Release or delete workspace state during management changes.** This would
  violate ADR-0005's persistent-workspace guarantee and could destroy unfinished
  or historical work.
- **Hard-delete archived objects.** Removing durable identity would make Message,
  Task, run, lease, membership, and cost history misleading or untraceable.

## Consequences

- The current runtime JSON and single-engine Agent record are migration inputs,
  not the M2 product interface. Production persistence needs independently
  versioned Agents, work options, Projects, memberships, Working groups,
  Environment enrollments, and workspace bindings.
- The future Message and wake-routing decision must cover Project-scoped direct
  messages, Project channels, and Working group channels without changing the
  authority decisions here.
- Project creation and first-run onboarding share domain operations but have
  different convenience defaults: onboarding automatically includes its ready
  Environments and default workspaces; ordinary creation leaves resources
  optional and explicit.
- Environment loss can reduce Project capability without invalidating Project
  identity. The Web must explain missing Task-begin prerequisites rather than
  labelling the Project an incomplete draft.
- Version and relationship history is product data. Implementations may store
  snapshots, versions, or immutable events, but observable history cannot be
  reconstructed from mutable current rows alone.
- Archive, unenrollment, workspace switching, and membership ending all require
  impact checks against active work. Convenience never overrides unfinished-work
  safety.
- This ADR does not choose screen layout, a pairing wire protocol, a filesystem
  browser implementation, or persistence tables. Those remain specification and
  implementation concerns constrained by the outcomes above.
