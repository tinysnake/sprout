---
Status: accepted
Supersedes: Task admission restrictions in ADR-0016 and ADR-0017
---

# Host-run Tasks retain their Task-held Environment lease

A Task may use Host-run Pi only when the process has established the local Pi model and isolation controls and the Task lifecycle has an active lease on an approved Worker with explicit `agent-run` permission. The Task remains the lease owner; Project MCP uses that lease when selected and does not acquire a second lease. The Host-run run record names the Sprout Pi profile, while the Task continues to name its Worker placement and retains its environment, workspace, and lease through settlement or recovery. No model, mode, account, environment, or host-process fallback is allowed.

Worker model-engine readiness is not required for this Task path because inference stays on the Sprout host. Worker connection, protocol, Task capability permission, recovery safety, Project access, selected MCP format, and `project-mcp` permission remain independently authoritative. An uncertain MCP startup, tool outcome, or stop protects the existing Task lease through Environment recovery.

This supersedes only the Task-admission restrictions in ADR-0016 and ADR-0017. Their startup-only mode, placement-recording, session-key, and recovery decisions remain in force.
