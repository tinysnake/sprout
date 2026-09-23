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
A durable collaboration and management boundary with its own members, optional goal and rules, Environment access, Project workspaces, channels, and history. A Project remains complete when it has no Agent or Environment, although it cannot begin Agent work until the required resources are present.
_Avoid_: Project group, group chat

**Project channel**:
The shared conversation in which all current members of one Project coordinate. Temporary member subsets use Working group channels instead.
_Avoid_: Project, group

**Working group**:
A temporary collaboration scope within one Project, containing a subset of current Project members together with an optional goal and rules, its own channel, and durable membership history. It may provide context and provenance for work but does not own Tasks, Environment access, Project workspaces, or leases.
_Avoid_: Project, Task, default group

**Working group channel**:
The shared conversation whose participants are the current members of one Working group.
_Avoid_: Project channel, direct message

**Project-scoped direct message**:
A private conversation between two current members of one Project, governed and recorded within that Project. The same pair communicating in another Project has a separate conversation and context.
_Avoid_: Global direct message, cross-Project direct message

**Message**:
One durable piece of Human- or Agent-authored conversation in a Project-scoped direct message, Project channel, or Working group channel. A Message may cause routing, but it is not a Task, Agent run, run event, or system-generated Project event.
_Avoid_: Task, prompt, run event

**Project event**:
A durable system-produced fact exposed in a Project, with an explicit routing disposition that determines whether it has a responsible Agent, may be judged by a wake model, remains informational, or requires Human action.
_Avoid_: System Message, log line

**Routing disposition**:
The declared treatment of a Project event: addressed, wake-eligible, informational, human-action-required, or non-routing. Only addressed events route deterministically and only wake-eligible events may enter wake-model routing.
_Avoid_: Notification severity, inferred intent

**Wake policy**:
The Project-level choice between explicit-only routing, where unaddressed Project-channel and Working-group-channel Messages and events remain durable without model evaluation, and wake-model-assisted routing, where eligible unaddressed inputs are collected for model judgement. Project-scoped direct messages, explicit Agent mentions, broadcasts, and addressed Project events bypass this policy and wake their recipients.
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
The available Project facts, optional goal and rules, responsibilities, permissions, environment access, and completion guidance presented to Agents collaborating in a Project. A Working group interaction adds that group's current goal and rules without Sprout interpreting conflicts between written rules.
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
One entry in an Agent's ordered execution preferences, naming an engine, work model, and effort. At run admission Sprout chooses the first option available on the selected Environment instance, and it never changes options automatically after an engine accepts the run.
_Avoid_: Environment binding, model fallback retry

**Agent run**:
One bounded activation of an agent in response to a message, task, or system event. A run executing inside a Task is a nested activation: it neither acquires nor releases that Task's environment lease.
_Avoid_: Agent, task

**Agent run stop**:
An intentional request by a Human, or by the Task lead for a run it initiated, to settle one active agent run without ending its Task or releasing the Task lease. The Human's operator action is named Interrupt, but its intentional run outcome is stopped, distinct from an unexpected run interruption.
_Avoid_: Task pause, Task end, interruption

**Usage activity**:
One model-consuming activity observed by Sprout: either an Agent run using its work model or a Routing attempt using a wake model. A Routing attempt belongs to its Project but never to an Agent or Task.
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
The Human escalation available while a Task pause request still has an active agent run. It requests an intentional Agent run stop whose outcome is stopped, not interrupted.
_Avoid_: Interruption, Task pause, Task end

**Session key**:
The opaque, engine-native identifier of the conversation an agent run continued or created, stored by Sprout so the next run in the same environment and working directory can continue it. Owned by the engine; Sprout chooses it for Pi and captures it for the others.
_Avoid_: Session id, thread id, conversation id

**Work model**:
The model an agent uses for its primary reasoning and work.
_Avoid_: Brain, main model

**Wake model**:
The lower-cost model that decides whether a project-channel message should start an agent run.
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
A Human or Agent Project member entrusted by a Human at Task begin to coordinate work within the Task's current content, Project permissions, and selected Environment instance. An Agent Task lead may initiate sequential agent runs, stop runs it initiated, report blockers, and make a Task completion claim, but cannot approve, pause, validate, end, or recover the Task.
_Avoid_: Task owner, scheduler

**Task begin**:
The Human-authorized act that selects one environment instance for a Task, acquires that instance's Task lease, and has the environment worker create the Task context directory.
_Avoid_: Start, first agent run

**Task pause request**:
The admission hold created by a Human's first Pause action while an agent run remains active: no new run may begin, but the current run may settle. The next Human control is Interrupt, which requests an Agent run stop.
_Avoid_: Agent run stop, blocked, Task end

**Task pause**:
The Human-controlled resting state reached after a Task pause request has no active run. No new run may begin, and the Task lease remains held until a Human resumes or ends the Task.
_Avoid_: Task pause request, blocked, Task end

**Task blocker**:
A routable reason that prevents Task advancement and names the required next action, its responsible actor or external condition, and who advances the Task when it clears. A blocked Task retains its Task lease.
_Avoid_: Prose-only wait, Task pause

**Task completion claim**:
The Task lead's fact-form request for human validation, containing an outcome summary, validation evidence, durable changes, known limitations, and a proposed disposition. It does not complete the Task or release its Task lease.
_Avoid_: Task completion, Agent final answer

**Task validation**:
The Human decision to accept a Task completion claim or require correction. Acceptance authorizes Task end toward completion; correction retains the same Environment instance and Task lease for another deliberate advance.
_Avoid_: Agent self-approval, Agent run completion

**Task end**:
The Human-authorized act that normally has the environment worker recycle the Task context directory and then releases the Task lease. Accepted work becomes completed and abandoned work becomes cancelled only after this succeeds. Only Task end ends a Task's hold on its Environment instance; a failed, stopped, or interrupted agent run does not. Force Release is the explicit emergency Task-end exception when the Human accepts that proof or cleanup cannot be completed.
_Avoid_: Stop, cancel

**Task discard**:
The Human decision to abandon a begun Task, including during recovery, and authorize normal Task end toward cancellation. The Task becomes cancelled only after Task end recycles its Task context and releases its lease; the Project workspace and its work remain preserved. Force Release is a separate emergency decision rather than a successful normal discard.
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
A Worker-produced, non-inference observation of the Environment's local capability and engine readiness facts. It never starts a model turn or sends a prompt and is distinct from connectivity heartbeat and real Agent work.
_Avoid_: Heartbeat, smoke run, hidden model call

**Readiness observation receipt**:
A core-issued opaque identity for one atomic, sanitized facts-and-probe commit. The durable receipt snapshots the verified connection identity, epoch, enrollment, lifecycle generation, and optional requirement scope. Historical retrieval preserves that scope and facts but does not grant current authority: current status requires the live enrollment and connection fence. The connection identifier is an internal correlation identity, never a Worker credential. Probe-history ordering is not specified here (#127).
_Avoid_: Browser authority token, current-ready assertion, Worker-supplied identity

**Environment lease**:
A time-bounded right to use an environment instance's lease-requiring capabilities, held either by a durable Task or by a one-round agent run. Uncommitted working files remain with the lease until preserved or discarded.
_Avoid_: Agent environment, lock

**Lease recovery**:
The state an environment instance's lease enters after a timeout, holder loss, or interruption, during which the instance is not reassignable until recovery is explicitly resolved. An unfinished Task's lease stays reserved and only a Human may resume, discard, or Force Release it; one-round Agent run recovery retains its existing holder or Human controls.
_Avoid_: Cleanup, lock timeout

**Force Release**:
The Human-only emergency recovery decision that makes an Environment instance reassignable despite unresolved proof or cleanup after ordinary recovery has been attempted. It permanently records the acknowledged risks and unresolved facts; for a Task-held lease it abandons and cancels the Task through an emergency Task end without deleting the Project workspace.
_Avoid_: Automatic expiry, normal release, lease steal

**Operational event**:
A compact durable fact needed to explain Sprout startup, schema migration, Environment enrollment or connectivity, interruption, reconciliation, recovery, or release without retaining credentials, private infrastructure details, conversation content, or raw logs.
_Avoid_: Log line, Message, Project event
