# Ticket #244 Project MCP evidence

## Implementation evidence

- A Human-selected `claude-code-mcp-json-v1` Project format is inspected in the Worker-bound workspace. Inspection returns sanitized server names and transport only; it does not return commands, arguments, environment values, or host paths.
- The approved enrolled Worker must have `project-mcp` permission, a current Project binding, and the containing active run or Task lease before server discovery can start. A rejected permission case leaves the configured server unlaunched and does not start Host Pi.
- MCP child processes run with `shell: false` in the bound workspace. Their environment contains an allowlist of operating-system variables plus only the Project declaration's explicit values; engine and Worker process environment values are not inherited. Configured environment values are redacted from tool descriptions, schemas, and returned text.
- Discovery exposes typed tool declarations. Core calls retain a fixed Worker-issued origin and validate the argument schema, binding, Worker epoch, and lease. Only MCP tools are implemented. Resources, prompts, server notifications, cancellation, and server-to-client requests are not reported as supported.
- If startup cannot produce a complete supported catalog, Sprout stops the process where possible and returns an actionable failure for a missing dependency, invalid or unsupported configuration, or an empty tool catalog. The Worker tracks each child from spawn, including failed initialization and discovery, and returns an uncertain stop until termination is observed. An uncertain start, call, or stop protects the containing lease through Environment recovery.
- Project inspection is configuration evidence, not MCP runtime readiness. The Project view says dependency and tool availability remain unobserved until an authorized run starts discovery.

## Verification

- `npm run typecheck` passed for the core and Web TypeScript projects.
- Focused suite passed for Worker workspace/MCP operations, Runtime Project MCP, denied startup and dependency failure, Pi tool registration, and Project DOM behavior. See the `npm test` counters recorded with the ticket work record.
- `node scripts/verify-project-mcp-container.ts` passed against a disposable Docker container. It launched the actual `EnvironmentWorker` in the container, created the Project workspace and an MCP dependency in a Docker-managed volume, discovered a typed `resolve-origin` tool, registered it with the Pi tool builder, and completed the tool call through the Worker protocol. The result came from the dependency in the Worker volume. A server-created marker existed in the container's `/tmp` and not in the Sprout host's `/tmp`; the script stopped the MCP process and removed its disposable container and volume.

## Evidence limits

The Docker proof exercises the real container process and stdio MCP protocol, but uses a local `ContainerCarrier` and synthetic lease identity. It does not prove a network-enrolled remote deployment or an approved production Worker ceremony. The Runtime fixture exercises authenticated enrollment, Project authority, and active Task-lease enforcement, but its Worker process is local to the test. No test issued a prompt to a real Pi model, so typed tool selection and calls are not model-issued evidence.
