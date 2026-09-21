# Production Workers use enrollment-backed outbound connections

M1 proved ADR-0003's one-Worker-per-Environment execution seam with Core-started loopback, container-exec, and SSH-tunnel carriers, but the M2 Web enrollment records do not create those configured Workers, register them for execution, or make them schedulable. The accepted page can therefore describe and approve an Environment that no Agent run can ever use.

We decided that every production Environment instance, including one on the Sprout host, enters execution through one enrollment-backed path. Web first creates a short-lived pending enrollment; the host CLI generates and retains the Worker key, claims the enrollment with a one-use secret read outside the command line, and proves key possession. Once approved, the Worker initiates and maintains a bidirectional WebSocket connection to the Sprout instance. Loopback may use WS; a non-loopback connection requires WSS over the operator-managed private network. Application authentication, revocation, and a monotonic Worker connection epoch apply in both cases. The existing neutral Worker JSON-RPC remains the execution protocol carried by that connection.

This supersedes ADR-0003 only where it describes production carrier initiation and a Core-started configured Worker. ADR-0003's deeper decisions remain: each Environment instance runs one long-lived Sprout Worker, engines execute behind that Worker, and the core collaboration logic knows no platform-specific process-start rule. A new authenticated connection replaces the prior epoch; when work may still be active, replacement enters reconciliation rather than proving the old engine stopped.

**Consequences**

- The durable Environment catalog, dynamic Worker registry, Environment admission projection, and lease pool use enrolled instances rather than one startup-configured instance.
- Enrollment, Worker authentication, and Worker commands use a distinct machine path; Workers never reuse the Human browser cookie or CSRF authority.
- Pending, offline, incompatible, archived, and recovering instances remain durable catalog entries but cannot admit new work.
- No legacy static Environment is silently approved or migrated. There is no existing product Environment data to preserve; other Project, Task, run, and collaboration data remains untouched.
- The M1 container exec carrier remains a test and development carrier. Container enrollment and product operation are deferred and are not a macOS or Windows acceptance gate.

**Rejected alternatives**: keeping both configured and enrolled production paths would make management and execution refer to different Environment objects; Core-initiated remote dialing would require address and inbound-network management that the Web-led flow is intended to avoid; automatically trusting an old configured Worker would bypass identity proof and Human approval.
