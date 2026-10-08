# Ticket #242: Environment operations design

Status: implementation complete on the ticket branch; the design decisions and current verification evidence are recorded here. The model-issued probe uses an enrolled local Worker fixture and does not establish a separate remote deployment.

## Existing seam and decisions

#241 added `EnvironmentOperations` as the shared authority and routing module for typed Project workspace reads. It validates Project membership, current Project access, Worker enrollment and permission, binding generation, and connection epoch, then calls the enrolled Worker. #242 extends that same seam for edits, patches, commands, durable inspection, and cancellation. The Worker owns path containment, file access, process supervision, Run-context lifecycle, and durable operation outcomes. Host Pi receives typed callbacks only, and its local built-in tools are excluded.

The read route remains lease-free under `read-only-investigation`. A mutating operation pins one authorized Environment and binding for the run, acquires its run-held lease immediately before the first side effect, and reuses that lease across the coherent sequence. Conflict or authority loss stops work without trying another target. The lease stays held through run settlement and Run-context cleanup; unknown remote settlement keeps both lease and Run context protected.

The Core identity store records typed reads, edits, patches, commands, inspections, and cancellation requests. The Worker persists deduplication and outcomes by operation identity and payload fingerprint, so response loss or Worker restart cannot turn a retry into a second mutation. Pi SDK tool-call identity is forwarded through the runner and combined with the durable run identity and pinned binding; reuse with a different payload is rejected. A response loss returns an inspectable uncertain outcome and never triggers automatic replay.

Command output travels as bounded, sequenced progress and a bounded final result over the authenticated Worker connection. Cancellation is persisted as a request; `accepted` is not terminal settlement. Worker-observed process and descendant termination establishes settlement. If termination cannot be established, the outcome is `recovery-required` and the lease and Run context remain protected. A Host Pi process exit alone is not evidence that a remote command stopped.

## Acceptance mapping

1. **Remote-only edit, patch, and command.** Add typed operations to the Worker protocol and Host Pi tool catalog. The Worker resolves every file path within the pinned Project workspace, rejects traversal and host-absolute paths, applies edits/patches on the Worker, and runs bounded commands there. Tests use same-name Sprout-host and Worker sentinels: the local sentinel must be unreadable and unchanged, while the remote Project contains the requested change and command result.

2. **Run-held lease and fixed target.** Pin one authorized Project binding and Worker epoch for the run. Acquire its `agent-run` lease immediately before the first mutation; reuse it for subsequent operations and release only after every operation has settled and Run context cleanup succeeds. Surface holder/recovery conflicts and never substitute another Environment. Exercise contention with a second run.

3. **Durable identity and inspection.** Persist the Core operation identity and fingerprint before sending the Worker request. Persist Worker deduplication and outcome state across Worker restart. `inspect(operationId)` returns the authoritative known result or an explicit unknown/not-found outcome. Same identity with a different fingerprint is refused; an uncertain mutation is inspected, never replayed.

4. **Bounded streaming and cancellation.** Stream bounded output chunks with monotonically increasing sequence numbers and enforce total byte, duration, and result limits. Persist cancellation requests separately from settlement. Inspect after cancellation; if descendants or process state are unknown, return recovery-required and protect the lease and Run context. Worker/host process loss never fabricates remote-stop proof.

5. **Authority and lifecycle refusals.** Before each operation, recheck active Project membership/access, the exact binding generation, approved enrollment and capability permission, and the pinned current connection epoch. Transport loss, revocation, epoch change, or timeout refuses new operations with no Sprout-host shell and no alternate Environment. Recycle Run context separately from the persistent Project workspace, and retain it with a recovering lease when settlement is uncertain.

6. **Chat interruption and projections.** Preserve the existing Human-only Chat interrupt authority and run outcome. Interruption may request Worker cancellation, but it does not claim lease release until Worker settlement and context cleanup are proven. Project/Chat projections show operation status and a held or recovering lease separately from the interrupted run; outputs and diagnostics stay bounded and sanitized.

7. **Runtime/Worker evidence and Pi journey.** Add Runtime and Worker tests for lease contention, patch origin, command streaming, response loss, cancellation uncertainty, revocation/epoch refusal, and cleanup ordering. Extend the bounded Pi probe to make a real edit or patch and run a remote Project test command, with same-name host sentinels. Report scripted fixture, protocol, and model-issued evidence separately. A local Worker fixture is not evidence of an enrolled remote deployment.

## Implementation and evidence

- **Remote-only edits, patches, and commands:** Host Pi exposes the typed tools through the authorized `EnvironmentOperations` route. Worker path checks and the same-name host/Worker sentinel test establish that the host file stays unchanged while the Project workspace receives the edit. Commands start at the authorized Project root, run with a minimal Worker environment, and cannot request a model-supplied `cwd`.
- **Run-held lease and pinned target:** Runtime coverage verifies lazy acquisition, contention reporting, lease reuse, and release only after known command settlement and Run-context cleanup. Transport loss, capability revocation, and stale connection epoch tests refuse work on the pinned binding without trying another Environment.
- **Durable identity and inspection:** Core and Worker operation stores persist identities, payload fingerprints, and outcomes. Coverage verifies response loss inspection, conflicting identity reuse, and no redispatch.
- **Bounded commands and cancellation:** Worker and Pi Host tests cover sequenced output, total output bounds, timeout, cancellation, progress relay, and unresolved process descendants. Unconfirmed settlement returns recovery-required and keeps the lease and Run context protected.
- **Run-context lifecycle and interruption:** Runtime/Worker coverage verifies that temporary state is recycled separately from persistent Project files after known settlement. An interrupted Host run remains marked interrupted while an unresolved remote cancel keeps the lease recovering; later Worker-confirmed termination permits cleanup and release.
- **Visible sanitized outcomes:** Pi tool output becomes Run `tool-output` events, which the existing Run view renders. Worker results bound output, remove Worker-root references and control characters, and use fixed failure codes. The model-issued probe verifies a sanitized final success summary without host or Worker paths.
- **Model-issued journey:** `node scripts/probe-pi-remote-workspace.ts` completed with exactly one `remote_read`, `remote_edit`, and `remote_command`; read/edit results matched; the remote npm test passed; progress sequences were contiguous; command output was 347 bytes and sanitized; the host sentinel stayed unchanged; the remote sentinel changed; the operation binding identities matched; and the lease released. This is model-issued evidence against the probe's enrolled local Worker fixture, not a separate remote deployment.
- **Focused verification:** `npm run typecheck` passed. The focused Pi Host, Worker, Environment Operations, and Runtime suite passed 21/21.
- **Domain and decision records:** `CONTEXT.md` now defines Run context and Remote workspace operation outcomes. The existing lease, Human authority, enrollment/epoch, and readiness ADRs remain consistent; no ADR change was needed.

The full default-suite partition counters will be appended after the requested bounded runs.

## References

Before implementation, `docs/references.md` named AionUi as the engine process/streaming reference and Paperclip as the Project workspace versus temporary execution-area reference. The existing Worker and Environment lease seams take precedence where those designs differ; no reference code is assumed copied.
