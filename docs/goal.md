# Sprout Long-Term Goal

## Product vision

Sprout is a self-hosted multi-agent collaboration and environment scheduling platform for technical leads and software teams. It turns agents into persistent worker identities that are independent of any device, so multiple humans and agents can collaborate across heterogeneous development environments with the project goal, responsibilities, and rules made explicit before work starts.

The core value of Sprout is not simply "letting multiple agents chat", but providing a unified, persistent, token-efficient, and human-controllable collaboration plane for long-horizon multi-agent work.

## Problems to solve

Large-scale game development and similar work depend on high-resource development environments. A single editor may consume tens of gigabytes of memory, so multiple agents working in parallel often require several real machines. Existing approaches typically have the following problems:

1. Agents are bound to development machines and cannot move between devices as the same persistent worker identity.
2. Every machine requires installing and configuring the whole set of agents again.
3. The same agent cannot carry its configuration, memory, and work context across devices.
4. Different agents lack stable facts, decisions, progress, and results shared across the project.
5. Group chat only provides message passing; goals, responsibilities, collaboration rules, and work environments still have to be renegotiated repeatedly in conversation.
6. Scarce environments lack unified allocation and lease management, making resource conflicts and lost work likely.
7. It is hard for humans to understand, control, and correct the work of multiple agents from a single entry point.

## Long-term target users

Sprout serves technical leads and software teams that need to manage multiple coding agents and multiple kinds of development environments at the same time. A team may contain multiple human members and multiple agents, and can run Sprout on infrastructure it controls itself.

## Long-term product outcomes

### Agents decoupled from devices

An agent has a stable identity, capabilities, model configuration, and memory, and does not belong to a particular development machine, a particular project, or a particular process. The same agent can take on different responsibilities in different projects and continue working across compatible environments.

### Heterogeneous environments form a shared resource pool

Physical devices, virtual machines, and containers can join a team through a unified model. The platform allocates environments safely according to capabilities, capacity, provisioning mode, and current state, while supporting fixed, shared, and cloneable resources.

Scarce capabilities are protected by leases. Uncommitted work is never silently lost or handed to another worker because a lease expires, an agent is interrupted, or an environment disconnects before that work is saved or abandoned.

### Collaboration mode settled before work begins

A project makes its goal, participants, responsibilities, rules, permissions, available environments, and acceptance criteria explicit before work starts. Global defaults, individual agent configuration, project configuration, the project `AGENTS.md`, and dynamic team facts together form the project collaboration agreement presented to agents.

When a convention is defined in more than one place, the precedence is "project > individual > global". Sprout provides the relevant facts, rules, and current state, and agents decide for themselves how to act, rather than the platform interpreting all collaboration semantics.

### Context can persist over the long term

Messages, project facts, decisions, task state, run results, hand-off summaries, and agent-private memory can persist across runs. Sprout trims and assembles context according to the current work, avoiding replaying all history on every wake-up.

Agents share curated project facts, decisions, progress, and results with one another, and do not directly share each other's uncurated private memory or raw reasoning.

### Natural and restrained multi-agent communication

Humans and agents, and agents with one another, can communicate directly, and project members can also collaborate through shared channels. A message with an explicit recipient directly wakes the target agent; group chat can use low-cost judgement and routing based on tasks, responsibilities, events, threads, and topics to reduce unnecessary model calls.

### One-round work and long-horizon work coexist

Ordinary questions and one-off work can be completed directly by a single agent run. Work that requires multiple rounds of progress, waiting for conditions, or automated execution uses durable tasks to preserve its goal, constraints, state, and results.

### Humans retain control

Humans can understand, from a cross-platform client, which project, messages, tasks, environments, and leases each agent is working on, inspect process and results, and stop, correct, or retry work. The interaction style stays close to ordinary communication tools, rather than requiring humans to operate a complex scheduling system.

## Product principles

When trade-offs arise, decide in the following order:

1. Agents decoupled from devices.
2. Environment allocation is correct, and unfinished work is not silently lost.
3. Project goals, responsibilities, and collaboration rules are explicit before work starts.
4. Humans can always observe, interrupt, and correct agents.
5. Context can persist across devices and across runs.
6. Reduce meaningless model calls and token consumption.
7. Expand automation and adapter coverage only after the above capabilities are reliable.

## Product boundaries

Sprout is a collaboration and control plane. It manages agents, projects, messages, context, tasks, environment allocation, and run state, but does not itself implement:

- large language models;
- agent runtimes;
- containers, virtual machines, or operating systems;
- code hosting platforms;
- general-purpose office project management systems.

These capabilities are integrated through adapters or existing infrastructure. Git repositories and uncommitted files live in development environments; what Sprout stores is the state and context needed to coordinate work, not copies of code repositories.

Sprout's long-term primary direction is self-hostable multi-person team collaboration. Whether it also offers a cloud SaaS, and which open-source or commercial model it adopts, are not established commitments of the current long-term goal.

## Long-term success signals

Sprout's long-term goal is proven when the following results hold consistently in real projects:

1. A team only has to define an agent once, after which it can work continuously across multiple compatible environments.
2. Multiple agents can collaborate under pre-determined responsibilities and rules, without relying on repeated prompting to hold the organization together.
3. Scarce development devices can be shared safely and efficiently, and interruption does not cause work to be silently lost.
4. Project context can accumulate over the long term while keeping each run's token consumption within a relevant range.
5. Humans can understand and control the entire multi-agent workflow from a single entry point.
6. New agent implementations and environment types can be integrated through stable seams without requiring the core collaboration logic to be rewritten.

## Current product stage

The current medium-term goal, stage scope, acceptance criteria, and implementation evidence are recorded in `docs/roadmap.md`. This file tracks no stage-specific plan; whenever a medium-term goal is completed, the next stage's outcome roadmap should be chosen anew based on this file.
