# Ticket #245 HTTP Project MCP evidence

## Worker protocol fixture

`src/worker/workspace-file-operations.test.ts` starts the real `EnvironmentWorker` through the local Worker carrier and a disposable HTTP MCP origin. The fixture exercises initialization, the initialized notification, Server-Sent Events tool discovery, a typed tool call, and session cleanup. A proxy trap is configured through the Worker process environment; the selected origin receives the MCP exchanges and the trap receives zero requests. The fixture checks the configured authorization header at the origin and verifies that endpoint details, headers, and the session identifier are absent from the discovered tool catalog and result text.

This is protocol-level evidence from a local Worker fixture. It proves the Worker transport reaches the selected test origin directly without the configured host proxy. It is not evidence from a separately network-enrolled Environment.

## Model-issued coexistence

`node scripts/probe-pi-host-run-task.ts` passed with a bounded real Pi Host-run Task using a locally enrolled Worker fixture. One Task-held lease remained active for remote read, edit, command, stdio MCP, and HTTP MCP operations. Both MCP calls used their advertised typed tools and returned the expected fixture results; the HTTP origin received the configured authorization on its supported MCP exchanges. The Task ended safely, the Project workspace edit persisted, and the lease was released. The model turn had a 90-second deadline.

The model used the local Anthropic-compatible gateway. This is model-issued evidence through a locally enrolled Worker fixture, not evidence from a separately deployed or network-enrolled remote Environment.

## Scope limits

The Project configuration remains in the Worker-bound workspace; the engine receives only the validated typed catalog. No Sprout-host HTTP proxy, endpoint rewriting, redirects, or host-local MCP configuration copy is used. Restrictions on non-Project resources reachable through the remote server remain deferred by the #225 scope decision and are not claimed here.

## Default test suite partition ledger

The inventory was generated from `src/**/*.test.ts` and `web/src/**/*.test.ts`, sorted by path, and assigned round-robin to 16 disjoint partitions. All commands used `npm test -- <partition files>` with a 180-second command timeout. Durations are the TAP `duration_ms` values. The 314 unique files produced 2,413 passing tests, with zero failures, skips, or cancellations.

### P01

- Files (20): `src/agent/identity.test.ts`, `src/collaboration/run-interruption-events.test.ts`, `src/engine/opencode-instructions.test.ts`, `src/environment/enrollment.test.ts`, `src/environment/worker-transport.test.ts`, `src/run/admission.test.ts`, `src/run/sqlite-store.test.ts`, `src/runtime-gateway-e2.test.ts`, `src/runtime-remote-workspace.test.ts`, `src/store/schema-migration-rollback.test.ts`, `src/usage/routing-adapter.test.ts`, `src/web/chat-run-router.test.ts`, `src/web/project-router.test.ts`, `src/worker/cli/worker-cli-readiness.test.ts`, `src/worker/main.test.ts`, `web/src/adapters/operator-api.test.ts`, `web/src/app/production-feed.dom.test.ts`, `web/src/modules/chat/views/ChatView.dom.test.ts`, `web/src/prototype/agents-collaboration-guards.dom.test.ts`, `web/src/prototype/shell.dom.test.ts`
- Results: 169/169 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 25.24 s.

### P02

- Files (20): `src/agent/sqlite-store.test.ts`, `src/collaboration/sqlite-store.test.ts`, `src/engine/opencode.test.ts`, `src/environment/pool.test.ts`, `src/execution-mode.test.ts`, `src/run/binding-generation.test.ts`, `src/runtime-agent-list-parity.test.ts`, `src/runtime-gateway-startup.test.ts`, `src/runtime-revocation-recovery.test.ts`, `src/store/schema-migration-safety.test.ts`, `src/usage/service.test.ts`, `src/web/conversation-router.test.ts`, `src/web/task-admission-router.test.ts`, `src/worker/cli/worker-cli-recovery.test.ts`, `src/worker/private-file-call-sites.test.ts`, `web/src/adapters/operator-session-api.test.ts`, `web/src/app/production-journey-wire.test.ts`, `web/src/modules/environments/adapters/production-adapter.test.ts`, `web/src/prototype/agents-dialogs-navigation.dom.test.ts`, `web/src/prototype/tasks-view.dom.test.ts`
- Results: 115/115 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 6.53 s.

### P03

- Files (20): `src/auth/service.test.ts`, `src/collaboration/task-group-wake.test.ts`, `src/engine/pi-host-tools.test.ts`, `src/environment/post-approval-authorization-race.test.ts`, `src/host-config.test.ts`, `src/run/engine-retry.test.ts`, `src/runtime-authority-fencing-lifecycle.test.ts`, `src/runtime-host-containing-lease.test.ts`, `src/runtime-run-admission.test.ts`, `src/store/schema.test.ts`, `src/usage/sqlite-store.test.ts`, `src/web/environment-router-enrollment-privacy.test.ts`, `src/web/task-control-router.test.ts`, `src/worker/cli/worker-cli-reset-service.test.ts`, `src/worker/readiness.test.ts`, `web/src/adapters/project-api.test.ts`, `web/src/app/production-journeys.dom.test.ts`, `web/src/modules/environments/authorize-models.dom.test.ts`, `web/src/prototype/agents-keyboard.dom.test.ts`, `web/src/prototype/usage.dom.test.ts`
- Results: 243/243 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 18.78 s.

### P04

- Files (20): `src/collaboration/agent-task-group.test.ts`, `src/collaboration/wake.test.ts`, `src/engine/pi-host.test.ts`, `src/environment/privacy.test.ts`, `src/operations/diagnostics.test.ts`, `src/run/error-termination.test.ts`, `src/runtime-authority-fencing-refusals.test.ts`, `src/runtime-host-run-task.test.ts`, `src/runtime-sqlite-reopen.test.ts`, `src/store/task-group-message-migration.test.ts`, `src/usage/valuation.test.ts`, `src/web/environment-router-force-release-archive.test.ts`, `src/web/task-controls-contract.test.ts`, `src/worker/cli/worker-cli-setup-status.test.ts`, `src/worker/recovery-fence.test.ts`, `web/src/adapters/routing-api.test.ts`, `web/src/app/production-settings-navigation.dom.test.ts`, `web/src/modules/environments/control-boundary.test.ts`, `web/src/prototype/agents-routing-cancellation.dom.test.ts`, `web/src/recipient-refresh.test.ts`
- Results: 135/135 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 7.12 s.

### P05

- Files (20): `src/collaboration/coordinator.test.ts`, `src/conversation/service.test.ts`, `src/engine/pi-protocol.test.ts`, `src/environment/readiness-observation-migration.test.ts`, `src/operations/environment-operations.test.ts`, `src/run/failure-reason.test.ts`, `src/runtime-catalog-republish.test.ts`, `src/runtime-human-model-authorization.test.ts`, `src/runtime-target-evidence.test.ts`, `src/task/admission.test.ts`, `src/web/agent-router.test.ts`, `src/web/environment-router-machine-claim.test.ts`, `src/web/usage-privacy.test.ts`, `src/worker/cli/worker-cli-status-validation.test.ts`, `src/worker/recovery-journal.test.ts`, `web/src/adapters/run-api.test.ts`, `web/src/app/production.dom.test.ts`, `web/src/modules/environments/environments.privacy.test.ts`, `web/src/prototype/agents-task-authority.dom.test.ts`, `web/src/shell/connection.test.ts`
- Results: 152/152 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 15.59 s.

### P06

- Files (20): `src/collaboration/integration-delivery-scope.test.ts`, `src/conversation/sqlite-store.test.ts`, `src/engine/pi-runner-events.test.ts`, `src/environment/readiness-observation.test.ts`, `src/operations/module.test.ts`, `src/run/hand-off.test.ts`, `src/runtime-compatibility-admission.test.ts`, `src/runtime-operator-diagnostics.test.ts`, `src/runtime-wire-matrix.test.ts`, `src/task/context.test.ts`, `src/web/api-messages.test.ts`, `src/web/environment-router-probe-readiness.test.ts`, `src/web/usage-router.test.ts`, `src/worker/cli/worker-cli.integration.test.ts`, `src/worker/supervisor.test.ts`, `web/src/adapters/task-admission-contract.test.ts`, `web/src/app/routes.dom.test.ts`, `web/src/modules/environments/environments.service.test.ts`, `web/src/prototype/agents-task-completion.dom.test.ts`, `web/src/shell/navigation.test.ts`
- Results: 187/187 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 68.31 s.

### P07

- Files (20): `src/collaboration/integration.test.ts`, `src/conversation/store.test.ts`, `src/engine/pi-spawn-failure.test.ts`, `src/environment/readiness-workflow-concurrency.test.ts`, `src/operations/remote-operation-store.test.ts`, `src/run/orchestrator-host-pi.test.ts`, `src/runtime-compatibility-control.test.ts`, `src/runtime-post-approval-model-authorization.test.ts`, `src/runtime-worker-recovery.test.ts`, `src/task/control-service.test.ts`, `src/web/api-projects.test.ts`, `src/web/environment-router-reconnect-recovery.test.ts`, `src/web/views.test.ts`, `src/worker/cli/worker-cli.macos.test.ts`, `src/worker/worker-delivery-readiness.test.ts`, `web/src/adapters/task-api.test.ts`, `web/src/main.dom.test.ts`, `web/src/modules/environments/environments.states.test.ts`, `web/src/prototype/agents-wake-management.dom.test.ts`, `web/src/shell/shell.dom-tab-keyboard.test.ts`
- Results: 134/134 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 17.51 s.

### P08

- Files (20): `src/collaboration/probe.test.ts`, `src/conversation/task-group.test.ts`, `src/engine/pi.test.ts`, `src/environment/readiness.test.ts`, `src/project/access-validation.test.ts`, `src/run/orchestrator-restart-environment.test.ts`, `src/runtime-compatibility-selection.test.ts`, `src/runtime-project-authority.test.ts`, `src/runtime-worker-shutdown.test.ts`, `src/task/environment-lifecycle.test.ts`, `src/web/api-reply-projection.test.ts`, `src/web/environment-router-revocation-claim.test.ts`, `src/web/worker-readiness-api-epoch.test.ts`, `src/worker/cli/worker-cli.test.ts`, `src/worker/worker-resume-contract.test.ts`, `web/src/adapters/task-proposal-api.test.ts`, `web/src/modules/agents/adapters/production-adapter.test.ts`, `web/src/modules/environments/register-host.dom.test.ts`, `web/src/prototype/agents.dom.test.ts`, `web/src/shell/shell.dom.test.ts`
- Results: 149/149 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 26.17 s.

### P09

- Files (20): `src/collaboration/read-state.test.ts`, `src/engine/agy-contract-hook.test.ts`, `src/engine/turn-failure.test.ts`, `src/environment/recovery-receipt.test.ts`, `src/project/access.test.ts`, `src/run/orchestrator-workspace-binding.test.ts`, `src/runtime-composition.test.ts`, `src/runtime-project-mcp-denied.test.ts`, `src/store/db-adapter-reopen.test.ts`, `src/task/model.test.ts`, `src/web/api-routing.test.ts`, `src/web/environment-router.test.ts`, `src/web/worker-readiness-api.test.ts`, `src/worker/cli/worker-cli.windows.test.ts`, `src/worker/worker.test.ts`, `web/src/adapters/task-proposal-contract.test.ts`, `web/src/modules/agents/agents.dom-edit-flow.test.ts`, `web/src/modules/projects/adapters/production-adapter.test.ts`, `web/src/prototype/chat.dom.test.ts`, `web/src/task-controls.test.ts`
- Results: 145/145 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 15.30 s.

### P10

- Files (20): `src/collaboration/reconcile.test.ts`, `src/engine/agy.test.ts`, `src/environment/archive.test.ts`, `src/environment/recovery-service-force-release.test.ts`, `src/project/authority.test.ts`, `src/run/orchestrator.test.ts`, `src/runtime-config.test.ts`, `src/runtime-project-workspace.test.ts`, `src/store/db-composed-adapters.test.ts`, `src/task/proposal-contract.test.ts`, `src/web/api-runs.test.ts`, `src/web/feed-collaboration.test.ts`, `src/worker/agent-task-group-bridge.test.ts`, `src/worker/container.test.ts`, `src/worker/workspace-file-operations.test.ts`, `web/src/adapters/usage-api.test.ts`, `web/src/modules/agents/agents.dom.test.ts`, `web/src/modules/settings/adapters/production-adapter.test.ts`, `web/src/prototype/environments.dom-responsive-privacy.test.ts`, `web/src/transport/browser-transport.test.ts`
- Results: 143/143 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 7.86 s.

### P11

- Files (19): `src/collaboration/routing-batch.test.ts`, `src/engine/codex-lifecycle-sandbox.test.ts`, `src/environment/catalog-persistence.test.ts`, `src/environment/recovery-service.test.ts`, `src/project/bridged-registry.test.ts`, `src/run/project-contract.test.ts`, `src/runtime-conversation-scopes.test.ts`, `src/runtime-readiness-observation.test.ts`, `src/store/db-connection-pragmas.test.ts`, `src/task/proposal-migration.test.ts`, `src/web/api-sse-2.test.ts`, `src/web/feed-projection.test.ts`, `src/worker/agent-task-group-privacy.test.ts`, `src/worker/engine-selection.test.ts`, `src/worker/workspace.test.ts`, `web/src/app/production-accessibility-overlays.dom.test.ts`, `web/src/modules/agents/agents.privacy.test.ts`, `web/src/modules/settings/settings.dom.test.ts`, `web/src/prototype/environments.dom.test.ts`
- Results: 164/164 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 21.29 s.

### P12

- Files (19): `src/collaboration/routing-context.test.ts`, `src/engine/codex-protocol.test.ts`, `src/environment/catalog.test.ts`, `src/environment/recovery.test.ts`, `src/project/contract.test.ts`, `src/run/reconnect-retry.test.ts`, `src/runtime-durable-task-agent.test.ts`, `src/runtime-readiness-receipts.test.ts`, `src/store/db-migration-diagnostics.test.ts`, `src/task/proposal.test.ts`, `src/web/api-sse.test.ts`, `src/web/feed-restart.test.ts`, `src/worker/carrier.test.ts`, `src/worker/enrollment-port.test.ts`, `web/src/adapters/agent-api.test.ts`, `web/src/app/production-chat-dates.dom.test.ts`, `web/src/modules/agents/agents.service.test.ts`, `web/src/modules/tasks/tasks.dom.test.ts`, `web/src/prototype/feed-presets-keyboard.dom.test.ts`
- Results: 155/155 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 52.86 s.

### P13

- Files (19): `src/collaboration/routing-integration.test.ts`, `src/engine/codex.test.ts`, `src/environment/enrollment-claim.test.ts`, `src/environment/worker-epoch.test.ts`, `src/project/creation-service.test.ts`, `src/run/recovery.test.ts`, `src/runtime-enrollment.test.ts`, `src/runtime-reconnect-retry-crash.test.ts`, `src/store/db-task-lease-transaction.test.ts`, `src/task/service-restart-reconciliation.test.ts`, `src/web/api-static.test.ts`, `src/web/feed-router.test.ts`, `src/worker/cli/host-state-crash-recovery.test.ts`, `src/worker/environment-worker.test.ts`, `web/src/adapters/conversation-api.test.ts`, `web/src/app/production-chat-reply.dom.test.ts`, `web/src/modules/agents/control-boundary.test.ts`, `web/src/modules/usage/usage.dom.test.ts`, `web/src/prototype/feed-routing.dom.test.ts`
- Results: 117/117 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 25.01 s.

### P14

- Files (19): `src/collaboration/routing-judgement.test.ts`, `src/engine/contract-file.test.ts`, `src/environment/enrollment-restart-concurrent-claims.test.ts`, `src/environment/worker-proof.test.ts`, `src/project/project.test.ts`, `src/run/session-continuation-failure.test.ts`, `src/runtime-environment-pool.test.ts`, `src/runtime-reconnect-retry-durable.test.ts`, `src/store/db.test.ts`, `src/task/service.test.ts`, `src/web/api-tasks.test.ts`, `src/web/feed-runtime.test.ts`, `src/worker/cli/host-state-lock-recovery.test.ts`, `src/worker/gateway-channel-commands.test.ts`, `web/src/adapters/environment-api.test.ts`, `web/src/app/production-connection-archive.dom.test.ts`, `web/src/modules/chat/adapters/production-adapter.test.ts`, `web/src/modules/usage/usage.service.test.ts`, `web/src/prototype/feed.dom.test.ts`
- Results: 127/127 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 6.86 s.

### P15

- Files (19): `src/collaboration/routing-reconcile.test.ts`, `src/engine/instructions-channel.test.ts`, `src/environment/enrollment-restart-durable-privacy.test.ts`, `src/environment/worker-readiness-observation-concurrency-boundary.test.ts`, `src/project/sqlite-access-store.test.ts`, `src/run/session-continuation.test.ts`, `src/runtime-evidence-scoping.test.ts`, `src/runtime-reconnect-retry-shutdown.test.ts`, `src/store/execution-placement-migration.test.ts`, `src/task/store.test.ts`, `src/web/api.test.ts`, `src/web/feed-task-groups.test.ts`, `src/worker/cli/host-state.test.ts`, `src/worker/gateway-identity-epoch.test.ts`, `web/src/adapters/feed-api.test.ts`, `web/src/app/production-dialogs-cards.dom.test.ts`, `web/src/modules/chat/evidence.test.ts`, `web/src/prototype/agents-admission-archive.dom.test.ts`, `web/src/prototype/project.dom.test.ts`
- Results: 146/146 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 6.45 s.

### P16

- Files (19): `src/collaboration/run-failure-events.test.ts`, `src/engine/jsonrpc.test.ts`, `src/environment/enrollment-restart.test.ts`, `src/environment/worker-readiness-observation.test.ts`, `src/project/sqlite-authority-store.test.ts`, `src/run/session-key-store.test.ts`, `src/runtime-execution-mode.test.ts`, `src/runtime-reconnect-retry.test.ts`, `src/store/read-state-migration.test.ts`, `src/test-summary.test.ts`, `src/web/chat-read-router.test.ts`, `src/web/project-access-router.test.ts`, `src/worker/cli/scheduled-task.test.ts`, `src/worker/gateway-protocol-refusal.test.ts`, `web/src/adapters/message-api.test.ts`, `web/src/app/production-environment-recovery.dom.test.ts`, `web/src/modules/chat/unread-state.test.ts`, `web/src/prototype/agents-archive-responsive.dom.test.ts`, `web/src/prototype/settings.dom.test.ts`
- Results: 132/132 passed; 0 failed; 0 cancelled; 0 skipped.
- Duration: 7.27 s.
