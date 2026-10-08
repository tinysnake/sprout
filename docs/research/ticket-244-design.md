# Ticket #244 design note

This note maps #244's acceptance criteria to the existing #241 and Worker seams before implementation. It records design intent, not behavior evidence.

## Supported configuration

The Project authority version explicitly selects one format and one Project-relative file: the Claude Code `.mcp.json` `mcpServers` shape, restricted to stdio entries with `command`, optional `args`, and optional `env`. No HTTP transport, per-entry `cwd`, shell expansion, or implicit format detection. A repository file alone is inert; only a Human-authored Project selection makes that configuration eligible. Repository commands cannot change Project authority.

The Worker reads and validates the selected file remotely. Its inspection result contains sanitized server names and stdio transport descriptors, not commands, arguments, environment values, or host paths. Parse, unsupported-format, and missing-file states remain distinct. Runtime startup reports missing dependencies, unsupported servers, invalid declarations, and empty tool catalogs with actionable bounded outcomes.

## Execution and authority

Extend the shared `EnvironmentOperations` Module behind Runtime/Worker with MCP inspect, start, call, inspect-operation, cancel, and stop operations. It resolves the current Project access and workspace binding, enrolled Worker, connection epoch, binding generation, capability permission, and lease owner before discovery can launch a server. It never falls back to a host process.

The enrolled Worker resolves the authorized Project workspace path locally and spawns each stdio server there with shell execution disabled and only an allowlist of operating-system environment variables plus explicit Project values. Configured values are redacted from tool descriptions, schemas, and results. Runtime persists opaque process/operation identity with Project, binding generation, Worker epoch, and containing run or Task identity; tool results are bounded and sanitized. Binding revocation fences later calls and stops the process where possible. An uncertain stop remains protected under the shared Environment operation recovery rules. Runtime startup requires a complete supported tool catalog; missing dependencies, partial discovery, unsupported servers, and empty catalogs fail before Pi receives a session. Browser inspection is configuration evidence only and never claims server or tool readiness.

A one-round run uses its already acquired run lease. A run inside a Task reuses the Task-held lease. MCP does not create a scheduler or acquire a second lease. Lease ownership follows that run or Task through server lifetime and cleanup. A new lease-requiring Project MCP capability is checked before discovery can launch a process.

## Typed Pi tools and capabilities

Worker discovery produces an origin-bound catalog. Runtime passes actual tool names, descriptions, and validated JSON input schemas through the Engine session request. Pi registers one custom tool declaration per discovered tool and allowlists only those names. The model supplies tool arguments only; a trusted catalog mapping selects the server and validates the schema and binding/lease identity on every call. Results and errors are bounded and sanitized before returning to Pi.

Capability reporting reflects the negotiated server behavior. This slice exposes discovered tools; it does not claim resources, prompts, server notifications, cancellation, or server-to-client requests unless each is implemented and exercised. Unsupported or conflicting declarations are reported as such. Worker-side cancellation and shutdown require observed termination before releasing protected work. Browser/tool readiness is projected from the live selected binding, Worker epoch, declared capability, and discovered tools, not from configuration presence alone.

## Existing seams and reference check

`src/operations/environment-operations.ts` already owns Project membership/access, binding generation, enrollment/epoch checks, operation identity, bounded results, and the lease-free exception for explicitly granted read/search. `src/worker/workspace-file-operations.ts` resolves opaque workspace identity and executes only within the Worker's selected root. `src/engine/pi-host-runner.mjs` already registers typed Pi `customTools` from JSON schemas and routes calls through an origin-preserving bridge; this is the model for typed registration, not a place to spawn MCP servers.

ADR-0003 keeps process creation in the Environment Worker; ADR-0005 assigns a lease to the containing Task or run; ADR-0006 keeps repository proposals separate from Human authority; ADR-0012 requires the current enrolled connection epoch; ADR-0013 keeps readiness non-inference. The reference policy names AionUi for engine process integration. Its process-host topology cannot replace the Worker/lease boundary here; no reference code is copied. A pinned source review remains an implementation check before adopting any lower-level lifecycle detail.

## Evidence status

`docs/evidence/ticket-244-project-mcp.md` records focused tests and a disposable Docker Worker proof. The Docker proof exercises a real container process, Worker protocol, local workspace dependency resolution, and typed Pi tool call, but uses a direct local container carrier and synthetic lease identity. The Runtime integration uses an authenticated local Worker fixture for enrollment, authority, and Task lease enforcement. Neither fixture proves a network-enrolled remote deployment or a model-issued call.
