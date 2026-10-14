# Environment engine runtime substrate

## Accepted scope

The Environment Worker selects Codex and Pi through the shared `OarEngineAdapter` by default. The adapter choice is recorded in `src/engine/runtime-catalog.ts`; runtime discovery supplies only an executable path and cannot add a runtime to the product catalog. The catalog's accepted Agent work-option entries are Pi, Codex, agy, and OpenCode. agy and OpenCode retain their native Worker adapters until a separate migration is accepted. Claude remains a candidate and is excluded from the product work-option selectors.

Platform acceptance for the switch covers macOS and platform-portable work. Windows evidence is deferred to #282 and remains an unmet prerequisite. The controlled Codex workspace read limitation under the production `read-only` sandbox remains owned by #280; this switch does not resolve it or relax host policy. This Ticket does not implement or alter #225's separate Host-run behavior.

Agent IDs, ordered work options, configuration history, run attribution, session-key slots, leases, and recovery facts remain Sprout-owned. Core, durable records, and the Worker protocol do not depend on OAR session types or raw OAR records. One admitted Environment Worker run owns the OAR runner it starts and supervises; OAR does not add a separate admission path or scheduler.

## Credentials and policy

Codex authentication remains in the Environment host's Codex configuration. Pi uses the host's own Pi configuration as the source of provider, model, and host-extension approval. The Pi policy lease applies the existing empty built-in set, including `codemode`, and allows the authenticated Worker-origin Project MCP bridge. The lease is machine-global and is held until process-tree termination is proved. The runner reasserts that policy and pins the host Pi agent directory before its lazy OAR import.

The Environment Worker has no native Codex or Pi production selection. The retired Pi CLI adapter and its per-turn transport have been removed. The Codex native session implementation remains behind the separate Host-run Codex adapter, which this Ticket does not change; it is not selectable by Environment Workers. OAR remains responsible for Environment Worker vendor protocol transport; Sprout owns admission, session-slot identity, task/run history, usage attribution, and recovery.

A separate Pi session-directory override is unsupported by the OAR Pi route. The Worker reports this as an unsupported control with a current action: remove the override, reconnect, and probe readiness. The run does not start and saved Sprout session keys remain intact.

## Version requirements

- Node.js `>=24.0.0` is required for OAR-backed Worker sessions and their runner.
- This Ticket keeps `@botiverse/oar` at `0.59.1`; dependency adoption beyond that pin belongs to #272.
- The accepted Worker readiness floors are Codex CLI `0.154.0` and Pi CLI `0.86.1`.
- Claude Code `2.1.294` remains candidate readiness metadata and does not enable a production work option.

The shared runtime catalog is the source for these floors, OAR adapter version, Worker capabilities, readiness-probe kind, selection status, platform evidence, and policy identifiers. Product selectors, Worker selection/readiness, and admission read that catalog. Unknown or candidate runtime IDs remain unavailable even if a Worker discovers an executable or reports a ready fact.

## Compatibility hooks

- Codex's environment-specific sandbox is passed through the shared adapter to the runner; the runner sets OAR's sandbox setting before loading the runtime.
- Pi's OAR-supported `OAR_PI_AGENT_DIR` setting is pinned by the runner only after the Pi policy check. The machine-global policy lease verifies the owner record and reports contention only for `EEXIST` with a verified live owner.
- OAR's Pi `Session.id` remains the runtime-native continuation key in Sprout's existing session slot. Resume refusal, retry, usage, root-turn attribution, lease, and recovery rules remain the shared adapter contracts.
- The authenticated Worker-origin MCP bridge remains the only Sprout-provided workspace channel. Its production Codex `read-only` reachability limitation is documented separately in #280.

## Upstream update checks

An OAR or runtime update is not production-ready because it builds or imports successfully. Before changing the accepted version, run the shared adapter, continuation, usage, lease, runner, and recovery contracts; run affected browser/service checks; then perform the affected live acceptance for each changed runtime on the accepted platform scope. Keep model-issued, protocol-only, scripted, and source-only observations separate. An update that changes a contract must first be reconciled with the owning acceptance; do not infer compatibility from an upstream release note or from a different runtime's live result.
