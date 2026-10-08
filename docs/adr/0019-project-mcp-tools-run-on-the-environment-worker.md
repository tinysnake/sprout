---
Status: accepted
---

# Project MCP tools stay on the approved Environment Worker

A Human-selected Project MCP configuration may expose typed tools to a Host-run Pi session. We decided that the Sprout host will never launch the configured stdio servers: the approved Environment Worker resolves the bound Project workspace, starts and supervises each server there, and validates every call against that Worker-issued tool catalog and the containing run or Task lease. This preserves origin-local dependencies and keeps MCP process authority inside the existing Environment boundary.

Only discovered tools are exposed. Results are bounded and redact configured secret values; the child receives only an allowlist of non-secret operating-system environment variables plus the Project's explicit MCP environment. Readiness reports configuration inspection facts, not server availability: startup and discovery happen only after lease-authorized run admission. MCP notifications, resources, prompts, cancellation, and server-to-client requests are not claimed unless implemented and observed.

If startup cannot prove a supported tool catalog, Sprout stops any process it can identify. The Worker records each child identity as soon as it is spawned, before initialization or tool discovery, so a failed launch or discovery remains available for retrying cleanup. A stop is certain only after termination is observed. A missing dependency, invalid configuration, unsupported server declaration, or empty tool catalog produces an actionable run failure. An uncertain startup, tool outcome, or stop keeps the containing lease protected through Environment recovery.
