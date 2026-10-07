# Pi host isolation and separate-origin prototype (#239)

Scope: Run `r225`, Job `r225-pro-worker-a1`, attempt 1. Base `4574a061`.
Disposable experiment only; no production integration. Fact-only final output is
captured in `docs/research/pi-host-isolation-prototype-evidence.json`.

## Verdict

**Blocked; no accepted production route and no model-issued acceptance.**

Pi 1.0.4 can construct an isolated SDK session exposing exactly two typed tools,
`remote_read` and `remote_write`, with explicit empty discovery. A separate,
credential-free, network-denied sandbox process executes those operations in a
scratch origin. Scripted operations and OS negative checks pass. The selected
Job provider/model is absent from the explicit SDK model catalog, and that
provider has no configured authentication in the existing local auth runtime.
`modelPresent=false`, `authConfigured=false`, `modelTurnAttempted=false`.
No model prompt was issued. No other provider/account was substituted.

**Unblock condition:** make the already-authorized Job provider/model available
through a reviewed native Pi 1.0.4 model configuration and existing local
authentication under these isolation/discovery controls, then rerun the probe.
If that route depends on an automatically loaded provider extension, its narrowly
scoped registration must be reviewed and admitted explicitly; enabling ambient
extensions or broad credential-directory access is not the remedy. Installation,
login, credential copying and choosing another account were not attempted.

#240 remains blocked on #239 acceptance. The fixture is reusable by #248 and
#240 for their experiments, but fixture availability does not waive #239 or
#248's engine acceptance. Windows, enrolled remote deployment, and real remote
host behavior remain unproven.

## Reproduction and reusable fixture

Run `node scripts/probe-pi-host-isolation.mjs` with an explicit 180-second command
timeout on the pinned macOS engine host. The script has a 170-second overall
bound, a 130-second engine-child bound, 150-second origin bounds, 10-second RPC
bounds and a 100-second turn-abort request. These are experiment bounds, not
remote-stop acceptance. No listening service or port is used.

- `scripts/prototype-origin-fixture.mjs`: exports `makeOriginFixture`,
  `fileIsolationProfile`, `launchOrigin`, and `operate`; also supplies the origin
  child entrypoint. Host and origin have identical `origin.txt` / `effect.txt`
  names with distinct public synthetic markers. The host has an external read/
  write sentinel and a synthetic credential-sibling sentinel. Cleanup removes
  the disposable directory after children settle.
- `scripts/probe-pi-host-isolation.mjs`: drives scripted negatives, the real Pi
  SDK registration, and an optional real model turn only when the selected
  provider/model/auth and isolation prerequisites are available. It records
  only allowlisted facts, never native events, model text, request bodies,
  credentials, paths or raw stderr. On the engine deadline the supervisor kills
  the local engine process group; origin lifetime is separately supervised.
- The origin is a separate local OS process, reached over correlated stdio
  JSON requests from the supervisor. The isolated engine forwards typed requests
  to that supervisor over a bounded IPC broker; the supervisor launches the
  origin before the engine so the origin does not inherit the engine's denial
  of origin-root access. The engine can reach the origin through this broker
  while its direct origin-marker read is OS-denied. It is **not an enrolled Worker, MCP transport, container,
  separate machine or production remote deployment**. Engine and origin use
  separate file-access profiles, working roots and sanitized environments.
  This deliberately answers origin/control questions without introducing the
  Environment operations Module scheduled for later tickets.

The optional model-issued path asks the model to read the origin marker, write
`REMOTE_MODEL_EFFECT`, explicitly attempt both read and write of the outside
host sentinel, and attempt unavailable native search/image/shell/nested paths.
It observes tool callbacks and final fixture effects rather than accepting an
assistant's assertion of success. A static catalog model may instantiate the
registration-only session when the selected model is missing; it receives **no
prompt**, makes no inference request and supplies only protocol-level evidence.

## Pins and controls

| Item | Pinned observation / policy |
|---|---|
| Pi | Installed CLI/package `1.0.4`; candidate only, no accepted live route |
| Platform | macOS `26.6.2`; no Windows evidence |
| Node | `26.9.0` used by this experiment |
| SDK constructor | `createAgentSession`, explicit `tools: ['remote_read', 'remote_write']`, `noTools: 'builtin'`, `customTools` |
| Discovery | Custom `ResourceLoader` returning no extensions, skills, prompts, agent context or themes; in-memory `SettingsManager` and `SessionManager` |
| OS mechanism | Deprecated macOS `sandbox-exec`, file data reads/writes denied outside explicit roots/files; file metadata is allowed |
| Engine access | Read harness scripts, installed Pi runtime, system runtime roots and the Homebrew runtime tree; read/write scratch host runner; exact existing auth/config files readable, not writable; engine network allowed for inference |
| Origin access | Read its scratch root, harness scripts and runtime roots; write only its scratch root; network denied; no auth/config-file allowance; clean environment with no credential variables |
| Path policy | Relative paths only; deny absolute paths, traversal, symlinks and parent escapes; no arbitrary command, image, search or nested-call operation |
| Auth boundary | Existing local auth file remains local and uncopied; trusted engine auth runtime may read it, work executor cannot; authentication refresh requiring file writes is unsupported by this read-only auth allowance |

The Homebrew tree allowance is a disposable runtime concession, **not a
production minimum-access profile**. Attempts to narrow it to package/library
subtrees aborted Node startup here. Production must inventory and pin required
runtime files and any secrets in allowed runtime roots, and verify that narrower
policy. System configuration reads and file metadata remain allowed; this is
file-content isolation, not metadata confidentiality or a full syscall sandbox.
An initial profile without necessary system ancestor/symlink reads also aborted
startup; adding literal system ancestors allowed execution while the negative
sentinel checks continued to deny file data reads/writes. An unrestricted-read
control launched Node successfully, but is not isolation evidence.

Pinned installed source fingerprints (SHA-256):

- `dist/core/sdk.js`: `c5d5360f061b3b9f70dea1a0a424deb8a9a9417ed32a4c8d88bc9d0bfe7a75f5`
- `dist/core/model-runtime.js`: `da26f76339a031456f6d239a249159231776f760ab4ac538c6b54c417dea6f67`

## Evidence classes and final observations

| Evidence class | Observed result | Limit |
|---|---|---|
| Source-only | Pinned SDK full-control example, SDK option declarations, ModelRuntime declarations/implementation, MCP documentation and CLI parser | Describes controls; does not prove a model turn |
| Scripted | Origin read returned the remote synthetic marker; origin write affected only remote `effect.txt` | Deterministic RPC requests, not model-issued |
| Scripted | Absolute read/write, traversal write, symlink read/write all denied | Tool policy negatives on disposable fixtures |
| Scripted | Origin bypass of tool policy still received OS read/write denial against outside host sentinel | Uses direct open attempts, so path validation cannot explain denial |
| Scripted | Origin direct read of actual existing local auth file denied | No credential content was returned or retained |
| Scripted | Engine process direct sentinel read/write denied; synthetic credential sibling read denied | Engine child running under the candidate profile |
| Scripted | Search, images, shell and nested-call RPC operations visibly unsupported | No remote substitutes are provided for those operations |
| Scripted | Isolated engine broker read reached the remote marker, while direct origin-root read was OS-denied | Supervisor-origin bridge, no model inference |
| Protocol-level | Real Pi SDK active catalog exactly `remote_read`, `remote_write`; discovery empty | Model-visible declarations, not successful model use |
| Protocol-level | Planted ambient extension/config/MCP/context fixtures did not change the catalog; extension effect marker absent | Explicit loader/settings path, not proof of every CLI configuration route |
| Model-issued | **None**; selected model/auth prerequisite unavailable | Acceptance remains blocked |

Final fixture facts: host origin unchanged, host effect unchanged, outside host
sentinel unchanged; remote model effect absent. `accepted=false`. Probe exit zero
means diagnostic execution finished, not acceptance. It is not a production gate.

## Candidate production-facing control contract

1. Construct one immutable engine policy before admitting a Host-run turn:
   engine/version/platform, runner roots, literal auth/config allowances,
   builtin exclusions, explicit discovery, typed operation catalog and selected
   execution origin. Fail closed if any prerequisite or OS negative fails.
2. Use the existing Runtime/EngineSession orchestration seam. The narrow SDK
   route replaces argv discovery with explicit loader/settings/catalog control;
   the #253 CLI route would still require verified builtin exclusion and explicit
   configuration. MCP attachment alone is never builtin exclusion.
3. A remote tool callback forwards validated typed arguments only. The isolated
   origin enforces its root independently; no fallback to local execution,
   another origin, another mode or another account. Native read/write/edit/bash,
   PowerShell, grep/find/ls, images, codemode, nested models and automatic MCP
   discovery stay absent until separately proven replacements exist.
4. Keep authentication in the trusted engine process. Do not serialize credentials
   to work executors or grant them credential-directory reads. Caller APIs that
   bypass tools (for example direct SDK shell methods) must not be exposed to
   model input. This experiment does not implement that production adapter.
5. Later production operations must add enrollment/Project authority, leases,
   generation fencing, durable operation identity, uncertain-outcome inspection
   and Worker-observed cancellation. This prototype provides none of those.
   An accepted abort or a killed host engine is not remote-stop proof.

## Repository verification and missing inputs

- `npm ci --ignore-scripts --no-audit --no-fund`: repository dependencies only;
  no engine/model installation or login.
- `npm run typecheck`, explicit 180-second timeout: exit zero.
- `npm test`, explicit 180-second command timeout: no passing full-suite result.
  The initial tool result reported a command failure with zero passes and no
  useful failure body. Diagnostic reruns still using `npm test`, with a shorter
  120-second internal suite deadline and the required 180-second command bound,
  timed out in browser DOM suites. Timeout candidates included chat routing,
  ChatView, Tasks and Usage tests; candidates are not proven causes. No production
  or test code was changed. Generated timeout diagnostics were removed.
- Final probe: all reported scripted booleans true; Pi registration catalog exact;
  selected model/auth absent, so no model turn and no accepted route.
- Syntax checks and `git diff --check`: clean.

`AGENTS.local.md`, `docs/research/host-run-engines-remote-environment-tools.md`,
`docs/research/225-feasibility-ordering-ticket.md`, and `scripts/probe-*.mjs`
were absent from base `4574a061`. Existing `scripts/probe-*.ts`, repository
instructions, `CONTEXT.md`, the ordering verdict and #253 Work record were
consulted. Missing documents were not reconstructed as authoritative evidence.
Context7 lookup failed to fetch; pinned installed SDK docs/source supplied the
API facts. No model-content artifacts, production workspace edits, merge, push,
engine login or broad OAR replacement occurred.

## Standing integration references consulted

No source code was copied. These references justify reusing explicit adapter
control and fail-closed supervision principles, but none of the consulted slices
supplies this ticket's model-issued isolation proof:

- Cumora `622498370cf76965a18d3c5041b040f0e57237d0`,
  `server/src/agents/computer/engine.ts`: dedicated engine home, fixed bridge,
  version-dependent flags, fail-closed boundaries and explicit opt-in for engines
  without verified isolation. Adopt fail-closed admission; no unsandboxed opt-in
  here because #225 forbids a local fallback.
- AionUi `6744099b279b991c17e31c243f0920477bd31cb6`,
  `docs/prds/conversations/acp/permissions.md`: permission approvals and request
  lifecycle. Approval UI does not substitute for host read isolation, so it is
  outside this disposable fixture's acceptance seam.
- Paperclip `06484b3c4153b6201f1a07304694793b1fdf36dd`,
  `packages/adapters/claude-local/src/server/execute.remote.test.ts`: adapter
  execution-target/SSH bridge composition and workspace transport are mocked
  there. Reuse the separation of engine and execution target as design; do not
  import a mocked remote test as live origin evidence or copy/sync credentials.
