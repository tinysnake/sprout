# Sprout

Sprout coordinates persistent agents, collaborative projects, and heterogeneous work environments while keeping those concepts independent from one another.

## Language

**Sprout instance**:
A running installation that forms the control boundary for its teams, projects, agents, and environments.
_Avoid_: Server, backend

**Team**:
The shared management boundary containing projects, agents, environments, integrations, and dynamic operational state.
_Avoid_: Backend, Sprout instance

**Project**:
A collaboration space in which human and agent members pursue a defined goal under shared rules.
_Avoid_: Project group, group chat

**Project channel**:
The shared conversation through which a project's people and agents coordinate.
_Avoid_: Project, group

**Wake policy**:
The project-level rule that decides whether an unaddressed project-channel message remains informational or is evaluated by a wake model for Agent recipients. Direct messages and explicit Agent mentions bypass this policy and wake their recipients.
_Avoid_: Notification setting, workflow

**Project contract**:
The facts, goals, responsibilities, rules, permissions, environment access, and completion criteria presented to agents collaborating in a project.
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

**Agent run**:
One bounded activation of an agent in response to a message, task, or system event. A run executing inside a Task is a nested activation: it neither acquires nor releases that Task's environment lease.
_Avoid_: Agent, task

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
A durable unit of multi-run or automated work that preserves its goal, state, constraints, and results across agent runs. A Task owns one environment lease for its whole duration.
_Avoid_: Message, agent run

**Task proposal**:
A Task suggested by a human or agent that has not received permission to begin. It holds no environment lease and cannot start an agent run until a human approves its Task begin.
_Avoid_: Running task, autonomous task

**Task lead**:
The project member entrusted by a human at Task begin to coordinate agent work within that Task's goal, constraints, membership, and selected environment.
_Avoid_: Task owner, scheduler

**Task begin**:
The human-authorized act that selects one environment instance for a Task, acquires that instance's Task lease, and has the environment worker create the Task context directory.
_Avoid_: Start, first agent run

**Task end**:
The explicit act that has the environment worker recycle the Task context directory and then releases the Task lease. Only Task end ends a Task's hold on its environment; a failed, stopped, or interrupted agent run does not.
_Avoid_: Stop, cancel

**Task lease**:
The one environment lease a Task holds from Task begin to Task end, covering idle, blocked, and human-validation gaps. Agent runs nested inside the Task reuse it and neither acquire nor release it.
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

**Environment worker**:
The Sprout-owned process inside one environment instance that starts and supervises engine sessions on behalf of agent runs. It supervises an engine CLI; it does not implement an agent runtime.
_Avoid_: Agent, daemon, backend

**Environment lease**:
A time-bounded right to use an environment instance's lease-requiring capabilities, held either by a durable Task or by a one-round agent run. Uncommitted working files remain with the lease until preserved or discarded.
_Avoid_: Agent environment, lock

**Lease recovery**:
The state an environment instance's lease enters after a timeout, holder loss, or interruption, during which the instance is not reassignable until its holder or an operator explicitly resolves it. An unfinished Task's lease stays reserved through recovery and is never silently reassigned.
_Avoid_: Cleanup, lock timeout
