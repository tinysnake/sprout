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

**Project contract**:
The facts, goals, responsibilities, rules, permissions, environment access, and completion criteria presented to agents collaborating in a project.
_Avoid_: Prompt, chat agreement

**Project membership**:
The relationship that gives a human or agent its responsibilities and collaboration instructions within one project.
_Avoid_: Agent role

**Agent**:
A persistent worker identity with its own capabilities, model configuration, and private memory, independent of any environment instance or project.
_Avoid_: Process, bot instance, environment agent

**Agent run**:
One bounded activation of an agent in response to a message, task, or system event.
_Avoid_: Agent, task

**Work model**:
The model an agent uses for its primary reasoning and work.
_Avoid_: Brain, main model

**Wake model**:
The lower-cost model that decides whether a project-channel message should start an agent run.
_Avoid_: Cerebellum, small model

**Task**:
A durable unit of multi-run or automated work that preserves its goal, state, constraints, and results across agent runs.
_Avoid_: Message, agent run

**Environment definition**:
A description of a kind of work environment, including its capabilities, platform, capacity, and provisioning mode.
_Avoid_: Machine, environment instance

**Environment instance**:
An actual physical system, VM, or container made available for work under an environment definition.
_Avoid_: Environment definition, workspace

**Environment lease**:
A time-bounded right for an agent run to modify an environment instance or use its capacity-intensive development capabilities. Uncommitted working files remain with the lease until preserved or discarded.
_Avoid_: Agent environment, lock
