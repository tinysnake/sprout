# Host Claude remote-origin conformance (#251)

## Result

A real model-issued Host-run activation completed through the production
`HostClaudeEngineAdapter`, the shared `RunOrchestrator`, and an enrolled
Environment Worker created for a disposable fixture. The run used Claude Code CLI
`2.1.294` on macOS. The exact read-only user-configured model was
`group/auto-mimo-v2-6-flash[1m]`; this gateway alias maps to a non-Claude model.
The result proves the pinned Claude Code CLI protocol and Sprout adapter path for
that configured backend. It does not claim Claude-native model behavior.

The Human-authorized model value was projected from Claude Code's user settings
into the isolated CLI settings file. The adapter passed no `--model` or
`--effort` override. It did not copy authentication material; the CLI's helper
read it from the original settings during the turn.

## Observed work

- The CLI initialized with the adapter's expected remote MCP catalog and the run
  emitted native tool-call, tool-output, and final message events. The adapter
  rejects any unexpected builtin or remote tool in that initial catalog.
- The model read the synthetic marker from `origin.txt` through the selected
  Environment workspace, passed it to the Project MCP tool, and replaced `READY`
  in `proof.txt` with that marker through the remote workspace edit operation.
  Both resulting fixture files contained the expected marker.
- The model attempted to read `../host-sentinel.txt` through the workspace tool.
  Shared Environment Operations refused the request with `invalid-path` before
  Worker execution; the sibling sentinel remained unchanged. The adapter's
  macOS isolation regression separately verifies that a Host sentinel cannot be
  read or written by the engine process.
- The model-issued MCP and workspace operations settled, and the standalone
  run-held Environment lease was released. The run completed with observed usage
  of 2,223 input and 362 output tokens.
- The complete fixture and enrolled Worker were disposed after the run. The
  bounded reproduction is `node scripts/claude-host-conformance.mjs` with an
  explicit 180-second command timeout.

## Scope

The Worker used the authenticated enrollment handshake and Environment authority
inside the shared Runtime, but ran on the same physical host as Sprout. This is
not cross-host deployment evidence. The run was a standalone activation; Task
lease reuse and Task lifecycle are covered by the deterministic shared Runtime
scenario in `src/runtime-host-run-task.test.ts`, not by this model call.

The successful call confirms that this exact configured alias was reachable for
one run. Non-inference readiness checks local CLI version, exact model and effort,
authentication-configuration presence, and local isolation controls; it does not
validate the gateway credential or remote route. The conformance run does not
settle E7 attribution, Claude-native model behavior, Windows, interrupted-session
recovery, restart recovery, or cross-host Worker operation.

No endpoint, credential, account identity, host path, or prompt transcript is
retained in the repository.

## Reproduction result

The bounded probe reported `passed`, version `2.1.294`, platform `macOS`, the
resolved configured model above, the completed typed workspace and Project MCP
operations, the refused traversal, unchanged sentinel, released lease, and token
usage. The latest run observed 2,223 input and 362 output tokens. No inference beyond those observations is claimed.

**Decision boundary:** the evidence is model-issued through Claude Code with the
Human-authorized non-Claude gateway alias. It is not evidence from a Claude-native
model.
