---
Status: accepted
---

# Project MCP tools stay on the approved Environment Worker

A Human-selected Project MCP configuration may expose typed tools to a Host-run Pi session. The approved Environment Worker resolves the bound Project workspace and starts stdio servers there. For a declared HTTP server, the Worker opens a direct HTTP(S) connection from its own network origin to the configured URL; Sprout does not proxy, rewrite, or follow redirects. Static configured headers, including authorization, are sent only to that URL. The Worker never returns endpoint URLs, headers, credentials, or raw configuration through inspection, logs, records, projections, or model context.

Both transports use the same Project authority, enrolled Worker permission, binding generation, and containing run or Task lease. Core stores opaque process/session and operation identities. Tool discovery is staged before the next model request, and the session publishes the complete validated catalog at one request boundary. Each standalone catalog carries a generation fence; a later binding closes the earlier session and rejects new work from stale tools, while origin-pinned workspace inspection and Environment recovery remain available for unresolved operations.

The supported manifest subset is the Claude Code `.mcp.json` `mcpServers` object with stdio entries containing `command`, optional `args`, and optional `env`, or HTTP entries containing `type: "http"`, `url`, and optional static `headers`. HTTP supports JSON-RPC POST for initialize, tools/list, and tools/call, the initialized notification, bounded JSON or Server-Sent Events responses, and session DELETE when the server assigns a session id. It does not follow redirects or use a Sprout-host proxy. Results are bounded and redact configured secret values and endpoint details. The stdio child receives only an allowlist of non-secret operating-system environment variables plus its explicit Project environment.

Only discovered tools are exposed. Resources, prompts, cancellation, subscriptions, and server-to-client requests are not claimed. Unsupported response media, oversized streams, malformed catalogs, and unsupported server requests fail closed. A missing dependency, invalid declaration, denied or unreachable HTTP endpoint, unsupported feature, or empty tool catalog produces a bounded startup failure. The Worker records stdio children and HTTP sessions before initialization or discovery; a failed HTTP initialization whose session cannot be identified or stopped remains uncertain. A stop is certain only after termination or remote session closure is confirmed. An uncertain startup, tool outcome, or stop keeps the containing lease protected through Environment recovery.

Readiness reports configuration inspection facts, not server availability: startup and discovery happen only after lease-authorized run admission. Non-Project resource restrictions for remote HTTP servers remain deferred under the #225 scope decision and are not claimed here.

This extends the #244 typed stdio seam without moving configuration to the Sprout host. No reference code is copied; the existing Worker, Environment Operations, Engine tool, and lease boundaries govern both transports.
