# M1 uses TypeScript, Node, and SQLite

Sprout's M1 implementation uses TypeScript on Node for the application, SQLite for durable local persistence, and TypeScript with Vite for the Web client. This stack keeps the first vertical slice in one language and lets the highest-risk part—the engine adapter layer—reuse patterns from Cumora's existing TypeScript implementation instead of translating those details into another runtime.

The chosen stack satisfies the seven constraints established by #9:

1. Node can spawn and supervise Codex's long-lived `app-server` process, including health checks and restarts.
2. Node can spawn Pi, `agy`, and `opencode` as one-shot processes and consume their output incrementally where the engine supports it.
3. Node streams can parse the engines' JSONL and JSON-RPC-over-stdio protocols.
4. Sprout can control cloneable environments through the Docker CLI without exposing Docker-specific behaviour to callers.
5. SQLite provides restart-safe local storage for M1 messages, tasks, runs, and leases.
6. Node can push run progress and Agent status to the Web client; the transport remains a later interface decision.
7. Engine, environment, and persistence implementations can sit behind independently testable interfaces, so tests need not launch a real engine or environment.

SQLite must be isolated behind a persistence interface rather than treated as the domain model. Reconsider a server database when Sprout enters multi-user self-hosting, requires remote database deployment, or measured write concurrency makes SQLite a real bottleneck.

The Web client uses TypeScript and Vite, but this decision does not select a UI library, HTTP framework, progress transport, or ORM. Those choices remain with the slices that first need evidence from them.

**Rejected alternatives**: C#/.NET offers strong process and asynchronous-stream support and is more familiar to the project owner, but would split the client and application languages and require translating the most subtle adapter behaviour without a matching reference implementation. Rust offers the strongest low-level process control but has the highest solo-MVP delivery cost and no matching reference. Splitting the domain and adapters across runtimes would add an IPC seam and duplicate shared types before M1 has evidence that either cost is warranted.
