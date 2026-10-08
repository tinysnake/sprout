# Sprout

Sprout coordinates persistent agents, collaborative projects, and heterogeneous work environments while keeping those concepts independent from one another.

## Language

**Sprout instance**:
A running installation that forms the control boundary for its teams, projects, agents, and environments.
_Avoid_: Server, backend

**Team**:
The shared management boundary containing projects, agents, environments, integrations, and dynamic operational state.
_Avoid_: Backend, Sprout instance

**Human**:
A person who participates in Sprout and retains authority that cannot be delegated to an Agent.
_Avoid_: User account, Human Agent

**Operator identity**:
The single authentication boundary through which the Local Operator MVP's one Human controls one Sprout instance from one or more browser sessions. It is not a multi-Human account, role, or Team membership.
_Avoid_: Admin account, Team owner

**Project**:
A durable collaboration and management boundary with its own members, optional goal and rules, Environment access, Project workspaces, channels, and history. A Project remains complete when it has no Agent or Environment; a project Message may still receive a Host-run Pi reply when its Agent and Sprout-host Engine profile are authorized.
_Avoid_: Project group, group chat

**Project channel**:
The shared conversation in which all current members of one Project coordinate. Temporary member subsets use Working group channels instead.
_Avoid_: Project, group

**Working group**:
A temporary collaboration scope within one Project, containing a subset of current Project members together with an optional goal and rules, its own channel, and durable membership history. It may provide context and provenance for work but does not own Tasks, Environment access, Project workspaces, or leases.
_Avoid_: Project, Task, default group

**Task group**:
A temporary conversation scope within one Project, bound to exactly one Task and shared by every current Project member. It carries the Task's title, goal, and constraints, and preserves its conversation history when the scope is frozen after an ended status or Force Release. A Force Released `stopped` Task remains active intent; its group stays read-only until direct Resume.
_Avoid_: Working group, Task thread, direct message

**Task-group escalation**:
A durable Project event that exposes an unanswered Task-group Message for Human Attention after bounded wake orchestration cannot obtain Agent work. Acknowledging it does not retry work or grant Task authority.
_Avoid_: Agent reply, Task blocker, automatic retry

**Working group channel**:
The shared conversation whose participants are the current members of one Working group.
_Avoid_: Project channel, direct message

**Conversation scope**:
The durable identity and governance of one Project-owned communication context: the one Project channel, one Project-scoped direct conversation, one Working group channel, or one Task group. It binds its Messages to membership, versioned governing facts, and read-only rules; ended Task groups and Force Released stopped Task groups preserve their records and history while frozen. A stopped Task remains active intent and its group returns to writable state on Resume.
_Avoid_: Chat room, DM thread, channel list

**Project-scoped direct message**:
A private conversation between one Human and one current Agent member of a Project. The Human's messages can wake the Agent and the Agent's completed replies appear in the same conversation; Agents do not initiate direct messages. It is governed and recorded within that Project, so the same pair communicating in another Project has a separate conversation and context.
_Avoid_: Global direct message, cross-Project direct message

**Message**:
One durable piece of Human- or Agent-authored conversation in a Project channel, Working group channel, or Task group, or a Human-authored input or projected Agent reply in a Project-scoped direct message. A Message may cause routing, but it is not a Task, Agent run, run event, or system-generated Project event.
_Avoid_: Task, prompt, run event

**Project event**:
A durable system-produced fact exposed in a Project, with an explicit routing disposition that determines whether it has a responsible Agent, may be judged by a wake model, remains informational, or requires Human action.
_Avoid_: System Message, log line

**Routing disposition**:
The declared treatment of a Project event: addressed, wake-eligible, informational, human-action-required, or non-routing. Only addressed events route deterministically and only wake-eligible events may enter wake-model routing.
_Avoid_: Notification severity, inferred intent

**Wake policy**:
The Project-level choice between explicit-only routing, where unaddressed Project-channel and Working-group-channel Messages and events remain durable without model evaluation, and wake-model-assisted routing, where eligible unaddressed inputs are collected for model judgement. Human-authored direct messages, explicit Agent mentions, broadcasts, and addressed Project events bypass this policy and wake their recipients.
_Avoid_: Notification setting, workflow

**Routing batch**:
The durable, frozen set of eligible unaddressed Messages and Project events collected during one Project's bounded wake-model window. One batch may produce at most one Agent run per selected Agent while retaining the outcome of every input.
_Avoid_: Chat transcript, Task, prompt

**Routing attempt**:
One wake-model evaluation of one frozen routing batch and its bounded Project-shared context. Validation failure may retry the same snapshot once; a retry is a distinct durable attempt, not a new Message or batch.
_Avoid_: Agent run, hidden model call

**Wake request**:
The durable per-recipient decision that a Message or routing batch should admit one Agent run. It preserves the routing reason, admission outcome, and causal links to its input and run.
_Avoid_: Message, notification, Agent run

**Projected reply**:
The final assistant text from a completed Message-triggered Agent run, persisted by Sprout as an Agent-authored Message. It is non-routing: it may inform later bounded Project-channel context but cannot itself open a routing window or wake another Agent.
_Avoid_: Raw run output, Agent-initiated Message

**Project contract**:
The available Project facts, optional goal and rules, responsibilities, permissions, environment access, and completion guidance presented to Agents collaborating in a Project. A Working group interaction adds that group's current goal and rules, and a Task group interaction adds its Task's goal and constraints, without Sprout interpreting conflicts between written rules.
_Avoid_: Prompt, chat agreement

**Project template**:
A reusable starting shape for a project contract, containing goal guidance, rules, role slots, collaboration instructions, and completion guidance without binding concrete agents, environment instances, or workspace paths.
_Avoid_: Project copy, runtime configuration

**Project membership**:
The relationship that gives a human or agent its responsibilities and collaboration instructions within one project.
_Avoid_: Agent role

**Project workspace**:
The persistent working area of one project inside one environment instance: the repository, project rules, IDE state, build results, and caches. It outlives any one Task or agent run, and successive Tasks in the same project and environment reuse it.
_Avoid_: Environment instance, Task context directory

**Agent**:
A persistent worker identity with its own capabilities, model configuration, and private memory, independent of any environment instance or project.
_Avoid_: Process, bot instance, environment agent

**Agent work option**:
One entry in an Agent's ordered execution preferences, naming an engine, work model, and effort. Environment-hosted admission checks the selected Environment's observed facts; Host-run admission checks the local Pi profile's exact authorized model and supported effort before accepting the Message run. Sprout never switches options after an engine accepts a run.
_Avoid_: Environment binding, model fallback retry

**Execution mode**:
The immutable, process-wide choice made when a Sprout instance starts: `environment-hosted` places engine execution in the selected Environment worker, while `host-run` places supported one-round Message conversations on the Sprout host through its authorized Pi profile. Host-run Message admission needs no work Environment lookup or lease. It does not provide Project workspace access or Task execution; Tasks require Environment-hosted mode. Omission selects `environment-hosted` on every startup. Settings reports the effective mode and Host Pi readiness; changing mode requires restarting Sprout with a different startup argument.
_Avoid_: Browser preference, runtime switch

**Execution placement**:
The durable facts describing where a run or begun Task executes: its immutable Execution mode and, after admission, the actual Engine host and non-secret host profile. A Task keeps the placement chosen when it began for every later run and recovery decision.
_Avoid_: Work Environment, engine choice

**Engine host**:
The host that runs an engine process, owns its engine session storage, and holds its engine login. It is the Environment host in `environment-hosted` mode and the Sprout host in `host-run` mode. A Host-run Pi profile has one explicit provider/model authority and a host-local session namespace, independent of any work Environment.
_Avoid_: Work Environment, Project workspace

**Host Pi readiness**:
A Sprout-host-local, non-inference observation that the pinned Pi runtime, configured authentication, exact authorized model, and required isolated adapter controls are available for one Host-run profile. It does not contact an Environment Worker or perform a model turn.
_Avoid_: Environment readiness, smoke run, hidden model call

**Agent run**:
One bounded activation of an agent in response to a message, task, or system event. Its durable execution mode records where the engine ran; a Host-run record also names its opaque Engine host profile. A run executing inside a Task is a nested activation: it neither acquires nor releases that Task's environment lease.
_Avoid_: Agent, task

**Agent run stop**:
An intentional request by a Human or Task lead to settle one active Task-linked run without ending its Task. Its outcome is stopped, and the Task lease remains held.
_Avoid_: Chat run interruption, Task pause, Task end

**Chat run interruption**:
A Human-authorized request from Chat to settle an active run outside a Task. Its outcome is interrupted with a Human-stop reason. An Environment-hosted run releases its run-held Environment lease before the conversation is reused; a Host-run Pi child is interrupted and closed without contacting an Environment.
_Avoid_: Agent run stop, Task interruption, Task end

**Usage activity**:
One model-consuming activity observed by Sprout: either an Agent run using its work model or a Routing attempt using a wake model. A run activity records its execution placement and Engine host profile when applicable. A Routing attempt belongs to its Project but never to an Agent or Task.
_Avoid_: Billable run, Agent run

**Usage observation**:
One durable, source- and version-identified token, duration, or monetary fact for a Usage activity, including its completeness, observation time, and any append-only correction relationship.
_Avoid_: Usage total, invoice line

**Model activity duration**:
The sum of Sprout wall durations for the Usage activities in an aggregate. It is not Task calendar elapsed time or an engine-native latency.
_Avoid_: Task duration, provider latency

**Attributable billed cost**:
A settled provider invoice or ledger amount attributable to one Usage activity. It remains unavailable when an engine exposes only usage or an estimate.
_Avoid_: API-equivalent cost estimate, reported cost

**API-equivalent cost estimate**:
A USD valuation of observed model usage that is explicitly not a settled bill. It may be provider-estimated, harness-calculated, or locally estimated, and may be pending, available, or unavailable.
_Avoid_: Billed cost, actual cost

**Billing basis**:
Whether a Usage activity used metered API access, subscription-inclusive access, or an unknown access basis. It is independent of valuation provenance; subscription-inclusive does not mean zero attributable cost.
_Avoid_: Valuation provenance, payment method

**Valuation provenance**:
The authority that produced an API-equivalent cost estimate: provider-estimated, harness-calculated, or locally estimated from a frozen official-price snapshot.
_Avoid_: Billing basis, billed status

**Measurement coverage**:
The complete, partial, pending, or unavailable composition accompanying a usage aggregate so its known subtotal cannot imply that missing activities were measured as zero.
_Avoid_: Confidence score, success rate

**Interrupt**:
The Human escalation available while a Task pause request still has an active agent run. It requests an intentional Task-linked Agent run stop whose outcome is stopped.
_Avoid_: Interruption, Task pause, Task end

**Session key**:
The opaque, engine-native identifier of a conversation an Agent run continued or created, stored by Sprout so a later run can continue it only within the same Agent, engine, execution mode, Engine host and profile, Environment slot, working directory or controlled working area, and authorized Conversation, Routing batch, or Task scope. Owned by the engine; Sprout chooses it for Pi and captures it for the others.
_Avoid_: Session id, thread id, conversation id

**Work model**:
The model an agent uses for its primary reasoning and work.
_Avoid_: Brain, main model

**Wake model**:
The lower-cost model that selects Agent recipients for ambiguous shared conversation inputs, after deterministic addressing and any applicable Task-group assignment rules.
_Avoid_: Cerebellum, small model

**Task**:
A durable unit of multi-run or automated work that preserves its goal, state, constraints, and results across agent runs. A begun Task owns one environment lease from Task begin through Task end; an unapproved Task proposal owns none.
_Avoid_: Message, agent run

**Task proposal**:
A Task suggested by a Human or by an Agent belonging to its Project that has not received permission to begin. It holds no environment lease and cannot start an agent run, prepare Task context, or reserve an Environment instance. Its proposer may revise or withdraw it, while a Human may revise, reject, or approve it.
_Avoid_: Running task, autonomous task

**Task approval**:
The Human authority decision that accepts the current Task content, names its Task lead, and authorizes Task begin. Approval and the request to begin are one action rather than a durable approved-but-unbegun state; they remain separately observable facts.
_Avoid_: Agent consent, run approval

**Task content version**:
One durable version of a Task's goal, constraints, and validation criteria. A Human may create a new version at any time; an active agent run continues with the version it received, and the next run receives the latest version.
_Avoid_: Prompt, Agent memory

**Task lead**:
A Human or Agent Project member entrusted by a Human at Task begin to coordinate work within the Task's current content, Project permissions, and selected Environment instance. An Agent Task lead may initiate sequential agent runs, stop runs it initiated, report blockers, and make a Task completion claim, but cannot approve, pause, validate, end, or recover the Task. For an Agent-led Task, the authorized Human may submit a marked substitute claim if the lead has not filed one.
_Avoid_: Task owner, scheduler

**Task begin**:
The Human-authorized act that selects one environment instance for a Task, acquires that instance's Task lease, and has the environment worker create the Task context directory.
_Avoid_: Start, first agent run

**Task pause request**:
The admission hold created by a Human's Pause action: no new run may begin, while a current run may settle naturally. If the request cannot be recorded after repeated state conflicts, queued admissions remain gated until the Human retries Pause or explicitly cancels the request; when a run is still active, the next control is Interrupt.
_Avoid_: Agent run stop, blocked, Task end

**Task pause**:
The Human-controlled resting state reached after a Task pause request has no active run. No new run may begin, and the Task lease remains held until a Human resumes or ends the Task.
_Avoid_: Task pause request, blocked, Task end

**Task blocker**:
A routable reason that prevents Task advancement and names the required next action, its responsible actor or external condition, and who advances the Task when it clears. A blocked Task retains its Task lease.
_Avoid_: Prose-only wait, Task pause

**Task completion claim**:
A fact-form request for Human validation from the Task lead, or a marked Human substitute on an Agent-led Task whose lead has not filed a claim. It contains an outcome summary, validation evidence, durable changes, known limitations, and a proposed disposition, and it does not complete the Task or release its Task lease.
_Avoid_: Task completion, Agent final answer

**Task validation**:
The Human decision to accept a Task completion claim or require correction. Acceptance authorizes Task end toward completion; correction retains the same Environment instance and Task lease for another deliberate advance.
_Avoid_: Agent self-approval, Agent run completion

**Task end**:
The Human-authorized act that normally has the environment worker recycle the Task context directory and then releases the Task lease. Accepted work becomes completed and abandoned work becomes cancelled only after this succeeds. Only Task end ends a Task's hold on its Environment instance; a failed, stopped, or interrupted agent run does not. Force Release is the explicit emergency exception: it releases the lease while preserving active work intent in Task status `stopped`. The stopped Task needs a later direct Resume before it can admit another run.
_Avoid_: Stop, cancel

**Task stop**:
The active-intent Task status recorded by emergency Force Release: execution and the Environment lease are stopped because the Human accepts unresolved proof or cleanup, while intent to do the work remains alive. The permanent forced-release facts preserve the actor, reason, time, and unresolved cleanup facts. The Task group stays frozen while the Environment is released, but the Task remains in the active-intent family and appears outside the Closed tasks fold. A Human may directly Resume the Task if its original Environment can be safely leased again. Resume preserves those permanent facts and history, prepares fresh Task context, thaws the same Task group, and does not start a run. This differs from an ended `cancelled` Task, from Reopen, and from an Agent run's `stopped` status.
_Avoid_: Agent run stop, cancellation, normal Task discard

**Task reopen**:
The Human-authorized return of a Task in the ended family (`done`, `failed`, or `cancelled`) to deliberate work on its previously bound Environment, preserving its history and Project workspace. Reopen reacquires a Task lease and prepares fresh Task context but does not start an Agent run until a later explicit advance. A Force Released `stopped` Task remains active intent and uses direct Resume instead.
_Avoid_: Retry an old run, revise a rejected Task proposal

**Task resume**:
The Human-authorized continuation of a paused or Force Released Task. Resuming a paused Task removes its admission hold while retaining its current lease and context. Resuming a Force Released stopped Task reacquires a fresh lease on the same Environment, prepares fresh Task context, preserves prior control and run history plus permanent Force Release facts, and starts no run.
_Avoid_: Reopen a stopped Task, retry an old run

**Task discard**:
The Human decision to abandon a begun Task, including during recovery, and authorize normal Task end toward cancellation. The Task becomes cancelled only after Task end recycles its Task context and releases its lease; the Project workspace and its work remain preserved. Force Release is a separate emergency action that records active-intent status `stopped` while releasing the Environment lease.
_Avoid_: Delete Project workspace, automatic cleanup

**Task lease**:
The one environment lease a Task holds from Task begin to Task end, covering idle, paused, blocked, human-validation, and recovery gaps. Agent runs nested inside the Task reuse it and neither acquire nor release it.
_Avoid_: Run lease, lock

**Task context directory**:
The Sprout-owned scratch directory an environment's worker creates when a Task begins and recycles when it ends. Only Task-scoped temporary data belongs here; the Project workspace is not recycled with it.
_Avoid_: Project workspace, working directory

**Environment definition**:
A description of a kind of work environment, including its declared capabilities, platform, capacity, and provisioning mode.
_Avoid_: Machine, environment instance

**Environment capability**:
A named operation an environment definition declares it can perform, together with whether that operation requires an environment lease.
_Avoid_: Tool, command

**Environment instance**:
An actual physical system, VM, or container made available for work under an environment definition.
_Avoid_: Environment definition, workspace

**Environment enrollment**:
The Human-approved binding between one Environment instance, one Sprout instance, and a Worker identity whose private key remains on the Environment host. Enrollment is independent of current connectivity, protocol compatibility, engine readiness, and Project access.
_Avoid_: Engine login, transport reachability, Project Environment access

**Environment catalog**:
The Sprout-owned directory of enrolled Environment instances and their definitions from which current work-admission eligibility is projected. An instance remains in the catalog while offline, incompatible, archived, or recovering so its identity and history remain intact.
_Avoid_: Online Worker list, Environment pool

**Environment worker**:
The Sprout-owned process inside one environment instance that starts and supervises engine sessions on behalf of agent runs. It supervises an engine CLI; it does not implement an agent runtime.
_Avoid_: Agent, daemon, backend

**Worker connection epoch**:
The monotonic authority generation of one authenticated Environment worker connection. Only the current epoch may report Worker facts or run events; a replaced epoch has no authority even if its transport remains open.
_Avoid_: Session key, reconnect count

**Environment readiness probe**:
A Worker-produced, non-inference observation of the Environment's local capability and engine readiness facts, scoped by the core's current engine-to-model requirements. A v3 complete envelope carries measured target evidence and a requirement revision; supported v2 complete observations remain inspectable but aggregate model availability alone cannot prove current targets. Unsupported model measurement stays unknown. It never starts a model turn or sends a prompt and is distinct from connectivity heartbeat and real Agent work.
_Avoid_: Heartbeat, smoke run, hidden model call

**Readiness observation receipt**:
A core-issued opaque identity for one atomic, sanitized facts-and-probe commit. The durable receipt snapshots the verified connection identity, epoch, enrollment, lifecycle generation, and optional requirement scope. The scope is a validated plain object containing only optional `revision`, `requiredEngines`, `requiredModels`, and `modelsByEngine` fields; malformed or extra fields refuse the observation before persistence. Historical retrieval preserves that scope and facts but does not grant current authority: current status requires the live enrollment and connection fence. The connection identifier is an internal correlation identity, never a Worker credential. Issue-order precedence and identical redelivery are governed by #127.
_Avoid_: Browser authority token, current-ready assertion, Worker-supplied identity

**Environment lease**:
A time-bounded right to use an environment instance's lease-requiring capabilities, held either by a durable Task or by a one-round agent run. Uncommitted working files remain with the lease until preserved or discarded.
_Avoid_: Agent environment, lock

**Lease recovery**:
The state an environment instance's lease enters after a timeout, holder loss, or interruption, during which the instance is not reassignable until recovery is explicitly resolved. An unfinished Task's lease stays reserved and only a Human may resume, discard, or Force Release it; one-round Agent run recovery retains its existing holder or Human controls.
_Avoid_: Cleanup, lock timeout

**Force Release**:
The Human-only emergency recovery decision that makes an Environment instance reassignable despite unresolved proof or cleanup after ordinary recovery has been attempted. It permanently records the acknowledged risks and unresolved facts; for a Task-held lease it releases the lease and records active-intent status `stopped` while preserving work intent and the Project workspace.
_Avoid_: Automatic expiry, normal release, lease steal

**Operational event**:
A compact durable fact needed to explain Sprout startup, schema migration, Environment enrollment or connectivity, interruption, reconciliation, recovery, or release without retaining credentials, private infrastructure details, conversation content, or raw logs.
_Avoid_: Log line, Message, Project event
