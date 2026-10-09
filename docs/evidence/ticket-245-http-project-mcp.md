# Ticket #245 HTTP Project MCP evidence

## Worker protocol fixture

`src/worker/workspace-file-operations.test.ts` starts the real `EnvironmentWorker` through the local Worker carrier and a disposable HTTP MCP origin. The fixture exercises initialization, the initialized notification, Server-Sent Events tool discovery, a typed tool call, and session cleanup. A proxy trap is configured through the Worker process environment; the selected origin receives the MCP exchanges and the trap receives zero requests. The fixture checks the configured authorization header at the origin and verifies that endpoint details, headers, and the session identifier are absent from the discovered tool catalog and result text.

This is protocol-level evidence from a local Worker fixture. It proves the Worker transport reaches the selected test origin directly without the configured host proxy. It is not evidence from a separately network-enrolled Environment.

## Model-issued coexistence

`node scripts/probe-pi-host-run-task.ts` passed with a bounded real Pi Host-run Task using a locally enrolled Worker fixture. One Task-held lease remained active for remote read, edit, command, stdio MCP, and HTTP MCP operations. Both MCP calls used their advertised typed tools and returned the expected fixture results; the HTTP origin received the configured authorization on its supported MCP exchanges. The Task ended safely, the Project workspace edit persisted, and the lease was released. The model turn had a 90-second deadline.

The model used the local Anthropic-compatible gateway. This is model-issued evidence through a locally enrolled Worker fixture, not evidence from a separately deployed or network-enrolled remote Environment.

## Scope limits

The Project configuration remains in the Worker-bound workspace; the engine receives only the validated typed catalog. No Sprout-host HTTP proxy, endpoint rewriting, redirects, or host-local MCP configuration copy is used. Restrictions on non-Project resources reachable through the remote server remain deferred by the #225 scope decision and are not claimed here.
