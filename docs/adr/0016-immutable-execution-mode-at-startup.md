# Sprout selects one immutable execution mode at startup

Ticket #225 retains Environment-hosted execution while adding Host-run placement.
Both choices belong to one Sprout process and must be settled before that process
accepts work. A browser setting, stored preference, or live mode switch could make
the Settings page disagree with the Runtime graph and could admit work through a
placement that was not active when authority was checked.

We decided that the Sprout service accepts `--execution-mode`
`environment-hosted` or `host-run`. The argument is parsed before host
configuration, Runtime construction, listeners, engine lookups, and remote
operations. Omission selects `environment-hosted` on every boot. The resolved
mode constructs one frozen execution strategy shared by the existing
RunOrchestrator and Task admission seams. There is no second scheduler or
hot-switchable graph.

`environment-hosted` keeps the current Environment admission and execution
journey. Host-run admission remains explicitly unavailable until its engine and
remote operation capabilities are implemented; it never falls back to
Environment-hosted work. Worker administration, Project authority, Task and run
lifecycle, lease ownership, recovery, and collaboration remain shared Runtime
capabilities.

Operator Settings reports the server's effective mode and explains that a mode
change requires editing the service launch command and restarting Sprout. The
DTO is read-only. Browser transport loss marks the displayed observation stale;
a reconnect causes Settings to fetch a fresh authoritative snapshot. There is no
mode write route, browser preference, configuration watcher, or readiness probe
that performs inference.

**Consequences**

- The Worker CLI does not choose the Sprout process mode. The normal service
  launcher forwards the argument to `src/main.ts`.
- Startup argument errors exit before host configuration is read and before any
  Runtime resource is constructed.
- A Settings read is a non-inference observation of the current process
  configuration. It does not start an engine, submit a run, or request a
  readiness probe.
- Later placement work must keep the one Runtime admission seam and preserve
  Environment enrollment, Project authority, leases, and recovery guarantees.
  ADR-0017 records the selected mode and actual engine host on admitted Runs and
  begun Tasks so a restart cannot silently relabel unfinished work.

**Rejected alternatives**

- Persisting the last selected mode would make omission depend on prior boots and
  could silently change placement after restart.
- Allowing Settings to switch mode would create a second authority path and
  require rebuilding or hot-switching the execution graph.
- Falling back from unavailable Host-run admission to Environment-hosted work
  would execute under a different placement than the Human selected.

**Reference**

`docs/references.md` was checked before implementation. Its listed repositories
have no equivalent process-wide Sprout mode or Environment/lease admission
boundary to adopt. The existing Runtime, RunOrchestrator, and Task admission
seams remain authoritative; no reference code was copied.
