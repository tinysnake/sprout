# Ticket #245 HTTP Project MCP evidence

## Worker protocol fixture

The named assertion `Worker starts and calls a remote-origin HTTP MCP server directly with bounded typed tools and private authorization` in `src/worker/workspace-file-operations.test.ts` runs the real `EnvironmentWorker` through the local Worker carrier. It checks initialization, the initialized notification, Server-Sent Events tool discovery, a typed invocation, and session cleanup. Its proxy trap receives zero requests while the selected origin receives the MCP exchanges. It verifies the configured authorization at that origin and checks that the endpoint, headers, and session identifier do not appear in the discovered catalog or result text.

## Uncertain HTTP tool-call result

The named assertion `an HTTP MCP call whose effect succeeds but response is lost remains uncertain until confirmed recovery` in `src/runtime-project-mcp-uncertain.test.ts` records the remote effect before dropping the tool-call response. It checks that the outward result remains the sanitized `failed/server-error`, the same durable operation identity is stored as `uncertain`, and a competing lease is refused while the containing lease is `recovering`. The existing Environment recovery flow refuses release before reconnect and retained evidence, then releases that same lease when the evidence is confirmed. The operation row keeps its `uncertain` state after recovery so the unknown remote effect is not rewritten as known success or failure.

## Redirect behavior

The named assertion `Worker refuses same-origin and cross-origin HTTP MCP redirects without forwarding authorization or session identifiers` in `src/worker/workspace-file-operations.test.ts` covers a same-origin redirect path and a second fixture at a different origin. Startup returns a visible blocked/unavailable result in both cases. Both targets receive zero requests, including the configured authorization and the session identifier supplied on the redirect response.

## Model-issued coexistence

`node scripts/probe-pi-host-run-task.ts` passed with a bounded real Pi Host-run Task using a locally enrolled Worker fixture. The probe checks `requiredOperationsComplete`, `runSettledSafely`, `taskEndedSafely`, and its final `accepted` condition for one Task-held lease across remote read, edit, command, stdio MCP, and HTTP MCP calls. It also checks that the edit persists and the lease is released after the Task ends. This is model-issued evidence through a local fixture, not evidence from a separately network-enrolled Environment.

The model used the local Anthropic-compatible gateway. The probe's Worker fixture is locally enrolled and does not represent a separately deployed remote Environment.

## Scope limits

Project configuration stays in the Worker-bound workspace and the engine receives only the validated typed catalog, as checked by the Worker protocol assertion above. The direct-origin and redirect assertions cover the selected test origin, the absence of a Sprout-host proxy request, and refusal to follow same-origin or cross-origin redirects. Non-Project resource restrictions for remote servers remain deferred by the #225 MVP scope decision and are not claimed.

## Default test suite partition ledger

The default inventory was generated from `src/**/*.test.ts` and `web/src/**/*.test.ts`, sorted by path, then assigned by sorted file position modulo 16. The 16 partition commands each invoked `npm test -- <partition files>` with a 180-second command timeout. All partitions completed without timeout. The 315 unique files were covered exactly once and passed 2,415 tests; there were no failures, cancellations, or skips. `SPROUT_TEST_TIMEOUT_LOG` was not set. Durations below are TAP `duration_ms` values, rounded to two decimal places.

### P01

- Files (20): `src/agent/identity.test.ts`, `src/collaboration/run-interruption-events.test.ts`, `src/engine/opencode-instructions.test.ts`, `src/environment/enrollment.test.ts`, `src/environment/worker-transport.test.ts`, `src/run/admission.test.ts`, `src/run/sqlite-store.test.ts`, `src/runtime-gateway-e2.test.ts`, `src/runtime-reconnect-retry.test.ts`, `src/store/read-state-migration.test.ts`, `src/test-summary.test.ts`, `src/web/chat-read-router.test.ts`, `src/web/project-access-router.test.ts`, `src/worker/cli/scheduled-task.test.ts`, `src/worker/gateway-protocol-refusal.test.ts`, `web/src/adapters/message-api.test.ts`, `web/src/app/production-environment-recovery.dom.test.ts`, `web/src/modules/chat/unread-state.test.ts`, `web/src/prototype/agents-archive-responsive.dom.test.ts`, `web/src/prototype/settings.dom.test.ts`
- Results: 156/156 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 7.26 s.

### P02

- Files (20): `src/agent/sqlite-store.test.ts`, `src/collaboration/sqlite-store.test.ts`, `src/engine/opencode.test.ts`, `src/environment/pool.test.ts`, `src/execution-mode.test.ts`, `src/run/binding-generation.test.ts`, `src/runtime-agent-list-parity.test.ts`, `src/runtime-gateway-startup.test.ts`, `src/runtime-remote-workspace.test.ts`, `src/store/schema-migration-rollback.test.ts`, `src/usage/routing-adapter.test.ts`, `src/web/chat-run-router.test.ts`, `src/web/project-router.test.ts`, `src/worker/cli/worker-cli-readiness.test.ts`, `src/worker/main.test.ts`, `web/src/adapters/operator-api.test.ts`, `web/src/app/production-feed.dom.test.ts`, `web/src/modules/chat/views/ChatView.dom.test.ts`, `web/src/prototype/agents-collaboration-guards.dom.test.ts`, `web/src/prototype/shell.dom.test.ts`
- Results: 133/133 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 30.35 s.

### P03

- Files (20): `src/auth/service.test.ts`, `src/collaboration/task-group-wake.test.ts`, `src/engine/pi-host-tools.test.ts`, `src/environment/post-approval-authorization-race.test.ts`, `src/host-config.test.ts`, `src/run/engine-retry.test.ts`, `src/runtime-authority-fencing-lifecycle.test.ts`, `src/runtime-host-containing-lease.test.ts`, `src/runtime-revocation-recovery.test.ts`, `src/store/schema-migration-safety.test.ts`, `src/usage/service.test.ts`, `src/web/conversation-router.test.ts`, `src/web/task-admission-router.test.ts`, `src/worker/cli/worker-cli-recovery.test.ts`, `src/worker/private-file-call-sites.test.ts`, `web/src/adapters/operator-session-api.test.ts`, `web/src/app/production-journey-wire.test.ts`, `web/src/modules/environments/adapters/production-adapter.test.ts`, `web/src/prototype/agents-dialogs-navigation.dom.test.ts`, `web/src/prototype/tasks-view.dom.test.ts`
- Results: 205/205 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 9.64 s.

### P04

- Files (20): `src/collaboration/agent-task-group.test.ts`, `src/collaboration/wake.test.ts`, `src/engine/pi-host.test.ts`, `src/environment/privacy.test.ts`, `src/operations/diagnostics.test.ts`, `src/run/error-termination.test.ts`, `src/runtime-authority-fencing-refusals.test.ts`, `src/runtime-host-run-task.test.ts`, `src/runtime-run-admission.test.ts`, `src/store/schema.test.ts`, `src/usage/sqlite-store.test.ts`, `src/web/environment-router-enrollment-privacy.test.ts`, `src/web/task-control-router.test.ts`, `src/worker/cli/worker-cli-reset-service.test.ts`, `src/worker/readiness.test.ts`, `web/src/adapters/project-api.test.ts`, `web/src/app/production-journeys.dom.test.ts`, `web/src/modules/environments/authorize-models.dom.test.ts`, `web/src/prototype/agents-keyboard.dom.test.ts`, `web/src/prototype/usage.dom.test.ts`
- Results: 194/194 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 22.23 s.

### P05

- Files (20): `src/collaboration/coordinator.test.ts`, `src/conversation/service.test.ts`, `src/engine/pi-protocol.test.ts`, `src/environment/readiness-observation-migration.test.ts`, `src/operations/environment-operations.test.ts`, `src/run/failure-reason.test.ts`, `src/runtime-catalog-republish.test.ts`, `src/runtime-human-model-authorization.test.ts`, `src/runtime-sqlite-reopen.test.ts`, `src/store/task-group-message-migration.test.ts`, `src/usage/valuation.test.ts`, `src/web/environment-router-force-release-archive.test.ts`, `src/web/task-controls-contract.test.ts`, `src/worker/cli/worker-cli-setup-status.test.ts`, `src/worker/recovery-fence.test.ts`, `web/src/adapters/routing-api.test.ts`, `web/src/app/production-settings-navigation.dom.test.ts`, `web/src/modules/environments/control-boundary.test.ts`, `web/src/prototype/agents-routing-cancellation.dom.test.ts`, `web/src/recipient-refresh.test.ts`
- Results: 112/112 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 12.36 s.

### P06

- Files (20): `src/collaboration/integration-delivery-scope.test.ts`, `src/conversation/sqlite-store.test.ts`, `src/engine/pi-runner-events.test.ts`, `src/environment/readiness-observation.test.ts`, `src/operations/module.test.ts`, `src/run/hand-off.test.ts`, `src/runtime-compatibility-admission.test.ts`, `src/runtime-operator-diagnostics.test.ts`, `src/runtime-target-evidence.test.ts`, `src/task/admission.test.ts`, `src/web/agent-router.test.ts`, `src/web/environment-router-machine-claim.test.ts`, `src/web/usage-privacy.test.ts`, `src/worker/cli/worker-cli-status-validation.test.ts`, `src/worker/recovery-journal.test.ts`, `web/src/adapters/run-api.test.ts`, `web/src/app/production.dom.test.ts`, `web/src/modules/environments/environments.privacy.test.ts`, `web/src/prototype/agents-task-authority.dom.test.ts`, `web/src/shell/connection.test.ts`
- Results: 137/137 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 19.99 s.

### P07

- Files (20): `src/collaboration/integration.test.ts`, `src/conversation/store.test.ts`, `src/engine/pi-spawn-failure.test.ts`, `src/environment/readiness-workflow-concurrency.test.ts`, `src/operations/remote-operation-store.test.ts`, `src/run/orchestrator-host-pi.test.ts`, `src/runtime-compatibility-control.test.ts`, `src/runtime-post-approval-model-authorization.test.ts`, `src/runtime-wire-matrix.test.ts`, `src/task/context.test.ts`, `src/web/api-messages.test.ts`, `src/web/environment-router-probe-readiness.test.ts`, `src/web/usage-router.test.ts`, `src/worker/cli/worker-cli.integration.test.ts`, `src/worker/supervisor.test.ts`, `web/src/adapters/task-admission-contract.test.ts`, `web/src/app/routes.dom.test.ts`, `web/src/modules/environments/environments.service.test.ts`, `web/src/prototype/agents-task-completion.dom.test.ts`, `web/src/shell/navigation.test.ts`
- Results: 174/174 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 72.09 s.

### P08

- Files (20): `src/collaboration/probe.test.ts`, `src/conversation/task-group.test.ts`, `src/engine/pi.test.ts`, `src/environment/readiness.test.ts`, `src/project/access-validation.test.ts`, `src/run/orchestrator-restart-environment.test.ts`, `src/runtime-compatibility-selection.test.ts`, `src/runtime-project-authority.test.ts`, `src/runtime-worker-recovery.test.ts`, `src/task/control-service.test.ts`, `src/web/api-projects.test.ts`, `src/web/environment-router-reconnect-recovery.test.ts`, `src/web/views.test.ts`, `src/worker/cli/worker-cli.macos.test.ts`, `src/worker/worker-delivery-readiness.test.ts`, `web/src/adapters/task-api.test.ts`, `web/src/main.dom.test.ts`, `web/src/modules/environments/environments.states.test.ts`, `web/src/prototype/agents-wake-management.dom.test.ts`, `web/src/shell/shell.dom-tab-keyboard.test.ts`
- Results: 148/148 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 19.80 s.

### P09

- Files (20): `src/collaboration/read-state.test.ts`, `src/engine/agy-contract-hook.test.ts`, `src/engine/turn-failure.test.ts`, `src/environment/recovery-receipt.test.ts`, `src/project/access.test.ts`, `src/run/orchestrator-workspace-binding.test.ts`, `src/runtime-composition.test.ts`, `src/runtime-project-mcp-denied.test.ts`, `src/runtime-worker-shutdown.test.ts`, `src/task/environment-lifecycle.test.ts`, `src/web/api-reply-projection.test.ts`, `src/web/environment-router-revocation-claim.test.ts`, `src/web/worker-readiness-api-epoch.test.ts`, `src/worker/cli/worker-cli.test.ts`, `src/worker/worker-resume-contract.test.ts`, `web/src/adapters/task-proposal-api.test.ts`, `web/src/modules/agents/adapters/production-adapter.test.ts`, `web/src/modules/environments/register-host.dom.test.ts`, `web/src/prototype/agents.dom.test.ts`, `web/src/shell/shell.dom.test.ts`
- Results: 156/156 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 29.87 s.

### P10

- Files (20): `src/collaboration/reconcile.test.ts`, `src/engine/agy.test.ts`, `src/environment/archive.test.ts`, `src/environment/recovery-service-force-release.test.ts`, `src/project/authority.test.ts`, `src/run/orchestrator.test.ts`, `src/runtime-config.test.ts`, `src/runtime-project-mcp-uncertain.test.ts`, `src/store/db-adapter-reopen.test.ts`, `src/task/model.test.ts`, `src/web/api-routing.test.ts`, `src/web/environment-router.test.ts`, `src/web/worker-readiness-api.test.ts`, `src/worker/cli/worker-cli.windows.test.ts`, `src/worker/worker.test.ts`, `web/src/adapters/task-proposal-contract.test.ts`, `web/src/modules/agents/agents.dom-edit-flow.test.ts`, `web/src/modules/projects/adapters/production-adapter.test.ts`, `web/src/prototype/chat.dom.test.ts`, `web/src/task-controls.test.ts`
- Results: 161/161 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 20.94 s.

### P11

- Files (20): `src/collaboration/routing-batch.test.ts`, `src/engine/codex-lifecycle-sandbox.test.ts`, `src/environment/catalog-persistence.test.ts`, `src/environment/recovery-service.test.ts`, `src/project/bridged-registry.test.ts`, `src/run/project-contract.test.ts`, `src/runtime-conversation-scopes.test.ts`, `src/runtime-project-workspace.test.ts`, `src/store/db-composed-adapters.test.ts`, `src/task/proposal-contract.test.ts`, `src/web/api-runs.test.ts`, `src/web/feed-collaboration.test.ts`, `src/worker/agent-task-group-bridge.test.ts`, `src/worker/container.test.ts`, `src/worker/workspace-file-operations.test.ts`, `web/src/adapters/usage-api.test.ts`, `web/src/modules/agents/agents.dom.test.ts`, `web/src/modules/settings/adapters/production-adapter.test.ts`, `web/src/prototype/environments.dom-responsive-privacy.test.ts`, `web/src/transport/browser-transport.test.ts`
- Results: 137/137 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 14.29 s.

### P12

- Files (19): `src/collaboration/routing-context.test.ts`, `src/engine/codex-protocol.test.ts`, `src/environment/catalog.test.ts`, `src/environment/recovery.test.ts`, `src/project/contract.test.ts`, `src/run/reconnect-retry.test.ts`, `src/runtime-durable-task-agent.test.ts`, `src/runtime-readiness-observation.test.ts`, `src/store/db-connection-pragmas.test.ts`, `src/task/proposal-migration.test.ts`, `src/web/api-sse-2.test.ts`, `src/web/feed-projection.test.ts`, `src/worker/agent-task-group-privacy.test.ts`, `src/worker/engine-selection.test.ts`, `src/worker/workspace.test.ts`, `web/src/app/production-accessibility-overlays.dom.test.ts`, `web/src/modules/agents/agents.privacy.test.ts`, `web/src/modules/settings/settings.dom.test.ts`, `web/src/prototype/environments.dom.test.ts`
- Results: 164/164 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 26.89 s.

### P13

- Files (19): `src/collaboration/routing-integration.test.ts`, `src/engine/codex.test.ts`, `src/environment/enrollment-claim.test.ts`, `src/environment/worker-epoch.test.ts`, `src/project/creation-service.test.ts`, `src/run/recovery.test.ts`, `src/runtime-enrollment.test.ts`, `src/runtime-readiness-receipts.test.ts`, `src/store/db-migration-diagnostics.test.ts`, `src/task/proposal.test.ts`, `src/web/api-sse.test.ts`, `src/web/feed-restart.test.ts`, `src/worker/carrier.test.ts`, `src/worker/enrollment-port.test.ts`, `web/src/adapters/agent-api.test.ts`, `web/src/app/production-chat-dates.dom.test.ts`, `web/src/modules/agents/agents.service.test.ts`, `web/src/modules/tasks/tasks.dom.test.ts`, `web/src/prototype/feed-presets-keyboard.dom.test.ts`
- Results: 129/129 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 60.19 s.

### P14

- Files (19): `src/collaboration/routing-judgement.test.ts`, `src/engine/contract-file.test.ts`, `src/environment/enrollment-restart-concurrent-claims.test.ts`, `src/environment/worker-proof.test.ts`, `src/project/project.test.ts`, `src/run/session-continuation-failure.test.ts`, `src/runtime-environment-pool.test.ts`, `src/runtime-reconnect-retry-crash.test.ts`, `src/store/db-task-lease-transaction.test.ts`, `src/task/service-restart-reconciliation.test.ts`, `src/web/api-static.test.ts`, `src/web/feed-router.test.ts`, `src/worker/cli/host-state-crash-recovery.test.ts`, `src/worker/environment-worker.test.ts`, `web/src/adapters/conversation-api.test.ts`, `web/src/app/production-chat-reply.dom.test.ts`, `web/src/modules/agents/control-boundary.test.ts`, `web/src/modules/usage/usage.dom.test.ts`, `web/src/prototype/feed-routing.dom.test.ts`
- Results: 123/123 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 27.26 s.

### P15

- Files (19): `src/collaboration/routing-reconcile.test.ts`, `src/engine/instructions-channel.test.ts`, `src/environment/enrollment-restart-durable-privacy.test.ts`, `src/environment/worker-readiness-observation-concurrency-boundary.test.ts`, `src/project/sqlite-access-store.test.ts`, `src/run/session-continuation.test.ts`, `src/runtime-evidence-scoping.test.ts`, `src/runtime-reconnect-retry-durable.test.ts`, `src/store/db.test.ts`, `src/task/service.test.ts`, `src/web/api-tasks.test.ts`, `src/web/feed-runtime.test.ts`, `src/worker/cli/host-state-lock-recovery.test.ts`, `src/worker/gateway-channel-commands.test.ts`, `web/src/adapters/environment-api.test.ts`, `web/src/app/production-connection-archive.dom.test.ts`, `web/src/modules/chat/adapters/production-adapter.test.ts`, `web/src/modules/usage/usage.service.test.ts`, `web/src/prototype/feed.dom.test.ts`
- Results: 132/132 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 9.68 s.

### P16

- Files (19): `src/collaboration/run-failure-events.test.ts`, `src/engine/jsonrpc.test.ts`, `src/environment/enrollment-restart.test.ts`, `src/environment/worker-readiness-observation.test.ts`, `src/project/sqlite-authority-store.test.ts`, `src/run/session-key-store.test.ts`, `src/runtime-execution-mode.test.ts`, `src/runtime-reconnect-retry-shutdown.test.ts`, `src/store/execution-placement-migration.test.ts`, `src/task/store.test.ts`, `src/web/api.test.ts`, `src/web/feed-task-groups.test.ts`, `src/worker/cli/host-state.test.ts`, `src/worker/gateway-identity-epoch.test.ts`, `web/src/adapters/feed-api.test.ts`, `web/src/app/production-dialogs-cards.dom.test.ts`, `web/src/modules/chat/evidence.test.ts`, `web/src/prototype/agents-admission-archive.dom.test.ts`, `web/src/prototype/project.dom.test.ts`
- Results: 154/154 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 8.72 s.
