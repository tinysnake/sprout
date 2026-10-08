---
Status: superseded in part by ADR-0018
---

# Sprout selects one immutable execution mode at startup

Ticket #225 retains Environment-hosted execution while adding Host-run placement. Ticket #240 completes the bounded Message-to-reply journey for Pi on the Sprout host. Both choices belong to one Sprout process and must be settled before that process accepts work. A browser setting, stored preference, or live mode switch could make Settings disagree with the Runtime graph and could admit work through a placement that was not active when authority was checked.

The Sprout service accepts `--execution-mode environment-hosted` or `--execution-mode host-run`. The argument is parsed before host configuration, Runtime construction, listeners, engine lookups, and remote operations. Omission selects `environment-hosted` on every boot. The resolved mode constructs one frozen execution strategy shared by run and Task admission. There is no second scheduler or hot-switchable graph.

`environment-hosted` retains the existing Environment admission and execution journey. In `host-run`, a one-round Message run uses the Sprout-host Pi profile only after Project membership, exact model authority, supported effort, non-inference readiness, and isolation controls are established. Host-run admission does not resolve an Environment, contact a Worker, or acquire a lease. Its durable run record names `host-run` and the opaque Engine host profile. Its session key is partitioned by execution mode and host profile. Task admission remains unavailable in Host-run mode because Tasks require an Environment workspace and lease.

The Host Pi profile uses the already installed pinned SDK and explicitly registered provider, reads engine authentication without writing it, selects only the configured exact model, disables built-in tools and ambient discovery, and runs under macOS file isolation. Message runs receive the Project contract as standing instructions, but have no Project workspace tools and cannot read or write native host work paths. If installation, authentication, the exact model, or any isolation control is unavailable or unknown, the Message run is refused before engine acceptance. Sprout never substitutes an account, model, execution mode, or Environment. For a selected Project MCP configuration, the Host Pi may receive typed tools whose fixed origin is the approved Environment Worker and whose calls use the containing run or Task lease; it never launches the configured server on the Sprout host.

Operator Settings reports the server's effective mode and a non-inference Host Pi readiness summary. A Settings read may refresh the local readiness observation; it never performs a model turn or contacts an Environment Worker. Browser transport loss marks the displayed observation stale; reconnecting fetches a fresh authoritative snapshot. There is no mode write route, browser preference, or configuration watcher.

**Consequences**

- The Worker CLI does not choose the Sprout process mode. The normal service launcher forwards the argument to `src/main.ts`.
- Startup argument errors exit before host configuration is read and before any Runtime resource is constructed.
- Host readiness is scoped to the Sprout Engine profile and remains independent from Environment readiness. A Project's Environment access cannot authorize a host model or host filesystem access.
- Host-run Messages keep the shared RunOrchestrator, Project membership checks, event streaming, reply projection, usage recording, and interruption lifecycle. Environment enrollment, leases, and recovery remain unchanged for Environment-hosted runs. Selected Project MCP tools retain the approved Worker's origin and use the containing Environment lease; a failed or uncertain server startup protects that lease through Environment recovery.
- Tasks continue to require Environment-hosted mode; Host-run does not create Task context or a Task lease.
- A Settings read is a non-inference observation of the current process configuration. It may refresh the local Host Pi readiness observation, but does not start an engine, submit a run, perform a model turn, or request an Environment Worker readiness probe.
- Placement work keeps the one Runtime admission seam and preserves Environment enrollment, Project authority, leases, and recovery guarantees. ADR-0017 records the selected mode and actual engine host/profile on admitted Runs and begun Tasks so a restart cannot silently relabel unfinished work.

**Rejected alternatives**

- Persisting the last selected mode would make omission depend on prior boots and could silently change placement after restart.
- Allowing Settings to switch mode would create a second authority path and require rebuilding or hot-switching the execution graph.
- Falling back from unavailable Host-run admission to Environment-hosted work would execute under a different placement than the Human selected.
- Reusing Environment readiness or Project Environment access for the Sprout-host engine would conflate Engine-host authority with work Environment authority.

**Reference**

`docs/references.md` was checked before implementation. Its listed repositories have no equivalent process-wide Sprout mode or Environment/lease admission boundary to adopt. The existing Runtime, RunOrchestrator, and Task admission seams remain authoritative; no reference code was copied.
