# Pi host isolation and separate-origin prototype (#239)

Scope: Run `r225`, Job `r225-pro-worker-a2`, rework r2. Base `4574a061`,
inherited r1 commit `699cec1a`. Disposable experiment only; no production
integration. Final allowlisted facts are in
`docs/research/pi-host-isolation-prototype-evidence.json`.

## Verdict and rework triage

**The bounded model-issued route passes on Pi 1.0.4 / macOS.** The unchanged
selected provider/model, `magpie` / `codex/gpt-6.1-sol`, makes six typed calls:
remote marker read, remote effect write, denied host sentinel read/write, and
denied engine credential-file read/write. All three host markers remain
unchanged. This is a separate local sandbox origin, never an enrolled remote
deployment or an accepted production adapter. Ticket acceptance belongs to the
Orchestrator; this report does not close #239 or change dependency state.

I read the complete r1 Dispatch and Work record and all four inherited artifacts
before edits. The actual problem was an incomplete engine runtime configuration,
not demonstrated missing external auth. r1 pointed ModelRuntime at a nonexistent
fixture-local catalog, disabled network catalog refresh, omitted the selected
provider's registration, and used default auth storage that locks even reads
under a profile denying lock writes. The resulting `modelPresent=false` /
`authConfigured=false` was not sufficient evidence of a missing prerequisite.
No inference was attempted, so r1 could not meet model-issued acceptance.

The session resolves `PI_PROVIDER=magpie`, `PI_MODEL=codex/gpt-6.1-sol`.
One initial environment observation did not return PI_MODEL; it was rechecked
before configuring any turn. The SDK provider id is exactly `magpie`, supplied
by the existing `pi-magpie` provider factory; `codex` in the model id is not an
instruction to substitute the SDK's `openai-codex` provider. Engine-host auth and
cached catalog already contain this route. A read-only native runtime diagnostic
without the factory still returned false/false; explicit registration of the
reviewed factory made both true. Missing provider registration is therefore a
live-isolated cause; catalog-path and lock-reader faults are additional source
findings, not separately measured attribution of each r1 false flag.
No provider/model/account was substituted.

## Corrected engine-local authentication route

Only the engine gets literal read allowances for the existing `auth.json`,
`models.json` (when present), and `models-store.json`. Its HOME and
PI_CODING_AGENT_DIR remain the scratch runner, preventing accidental home-based
resource discovery; explicit storage objects supply the authorized engine data.
No credentials or catalog/config contents are copied into scratch directories,
broker requests, committed artifacts, or origin processes.

The pinned SDK's `ReadOnlyAuthStorage` reads the existing auth file without
creating locks. An explicit read-only ModelsStore reads the existing host catalog
and rejects write/delete. Catalog network refresh stays disabled. The existing
`pi-magpie/provider.ts` factory is explicitly registered with
`registerNativeProvider`, then refreshed with `allowNetwork:false`. Only its
reviewed `provider.ts`, `catalog.ts`, `constants.ts`, `gateway.ts`, and
`package.json` have literal engine read allowances. A Node resolve hook binds
its `@earendil-works/pi-ai/compat` import to the pinned Pi release, avoiding its
checkout's unrelated dependency tree. The extension `index.ts` is never imported:
no UI hooks, commands, quota/routing-file helpers, shell helper calls, or ambient
extension discovery run. Imported gateway helper definitions include CLI/file
helpers; factory auth/catalog/inference paths do not invoke them. Those helpers
are not model tools.

A first sandbox attempt after the storage/factory change failed before provider
registration because the factory resolved dependencies outside admitted runtime
roots. Binding only its pi-ai import to the pinned release fixed startup without
allowing the provider checkout's node_modules or broad credential-directory reads.
The final engine can read auth but cannot open it for writing. The origin's
direct OS auth read/write and config/catalog reads are denied. The model's work
tool auth read/write requests are denied independently by origin path policy.
Auth refresh that needs credential writes remains unsupported.

## Reproduction and reusable fixture

Run `node scripts/probe-pi-host-isolation.mjs` with an explicit 180-second timeout
from this checkout on the existing engine host. The reviewed factory checkout
must already exist: the default relative path is `../pi-extensions/pi-magpie`;
`PI_PROBE_PROVIDER_ROOT` can name that same existing checkout elsewhere. The
script does not install or log in to an engine/provider, resolve another model,
or fall back to another account. Missing prerequisites produce a blocker.
`PI_PROBE_PACKAGE_ROOT` can name the existing pinned Pi package.

The script has a 170-second overall bound, a 130-second engine process-group kill,
150-second origin bounds, 10-second RPC bounds, and a 100-second turn-abort request.
These are local experiment bounds, not remote-stop acceptance. No listener or
service port is used. Prompts, model text, events, raw stderr, auth values,
endpoint addresses and host paths are not retained in the artifacts. Safe stage
and error-code classifications distinguish startup failure from absent auth.

`scripts/prototype-origin-fixture.mjs` remains the r1 shared fixture: host and
origin have same-name `origin.txt` and `effect.txt` with distinct synthetic
markers. Outside-host and credential-sibling sentinels support direct OS checks.
The supervisor launches the credential-free, network-denied origin before the
engine and forwards only correlated read/write IPC. Direct engine access to the
origin marker is OS-denied; typed calls reach it through the supervisor broker.
The origin independently validates relative paths and denies absolute paths,
traversal, symlinks and parent escapes. Cleanup follows child settlement.

## Declared controls and unsupported paths

| Item | Observation / policy |
|---|---|
| Pi | Existing CLI and package `1.0.4`; live SDK route demonstrated |
| Platform / Node | macOS `26.6.2`, Node `26.9.0`; Windows unproven |
| Selected identity | `magpie` / `codex/gpt-6.1-sol`, exact SDK identity checked before prompting |
| Tool catalog | Exactly `remote_read`, `remote_write`; explicit `tools`, `noTools:'builtin'`, `customTools` |
| Discovery | Empty ResourceLoader extensions, skills, prompts, agent context, themes; in-memory settings/session |
| OS isolation | Deprecated macOS sandbox-exec: file-data reads/writes denied except explicit roots/files; metadata allowed |
| Engine | Scratch read/write; script/runtime/system trees read-only; literal provider/auth/config/catalog files read-only; inference network allowed |
| Origin | Own scratch root and harness/runtime reads; writes only own scratch root; network denied; no auth/config/catalog allowance |
| Exclusions | Native read/write/edit/bash/PowerShell, search/grep/find/ls, image operations, codemode/nested models and automatic MCP discovery absent |
| Unsupported replacements | Origin RPC image/search/shell/nested operations return unsupported; no alternate executor is supplied |

The Homebrew runtime tree allowance inherited from r1 is broad and read-only;
production must inventory necessary runtime files and secrets before adopting a
narrower profile. System configuration reads and file metadata remain allowed.
This proves file-content denial against the declared sentinels, not a full
syscall sandbox or metadata confidentiality. Cwd or write isolation alone cannot
explain the direct read denials. The trusted engine may read its own auth; its
work tools cannot. MCP attachment is not builtin-tool exclusion.

## Evidence classes

| Class | Observed evidence | Limit |
|---|---|---|
| Source-only | SDK registration/discovery controls; locked default auth/model storage; ReadOnlyAuthStorage; explicit Magpie factory/auth/catalog/stream paths | Source review is not a turn |
| Scripted | Same-name remote marker read and remote-only write; absolute read/write, traversal write, symlink read/write denied | Deterministic requests, not model-issued |
| Scripted | Direct engine and origin OS sentinel opens for read/write denied; origin actual auth read/write and config/catalog reads denied | OS negatives bypass tool validation; no data returned |
| Protocol-level | Exact two-tool catalog, empty loader, planted ambient extension/config/MCP/context did not change catalog or create marker | Does not prove every possible CLI discovery route |
| Protocol-level | Search/image/shell/nested RPC rejected; builtin paths excluded from model catalog | Model narration about unsupported tools is not relied upon |
| Model-issued | Six observed SDK tool callbacks; remote content read/effect write; host sentinel and actual auth read/write denied | A real turn against a separate local process; no enrolled/cross-host proof |
| Final fixture state | Host origin/effect/sentinel unchanged; remote model effect present | Fact-only summary `accepted=true` denotes this prototype's gate |

The updated acceptance gate additionally requires exact model identity, explicit
provider registration, engine auth readability/write denial, discovery checks,
and both model-issued credential denials. No assistant assertion substitutes for
observed callbacks or fixture effects.

## Candidate production-facing control contract

1. Freeze engine version/platform, selected provider/model/account route, explicit
   provider registration, auth/config/catalog file allowances, runner roots,
   discovery controls, builtin exclusion and typed catalog before a turn. Fail
   closed on missing prerequisites or any OS negative. The trusted engine owns
   authentication; work tools never receive credential storage or credential values.
2. Reuse the Runtime/EngineSession seam with an explicit SDK loader/settings/catalog
   adapter. Do not interpret MCP attachment or CLI cwd as builtin exclusion or host
   read isolation. The provider factory is a reviewed control-plane dependency,
   not general extension loading.
3. Forward validated typed operations only to the selected origin, whose boundary
   enforces its own root. Never fall back locally, switch mode/origin/account, or
   expose SDK shell methods to model input. Admit other operations only after
   separate replacement/isolation evidence.
4. Production still needs enrollment/Project authority, leases, generation fencing,
   durable operation identity, uncertain-outcome inspection and Worker-observed
   cancellation. Neither an accepted abort nor killing the local engine proves a
   remote operation stopped. This prototype implements none of those controls.

## Pinned primary sources

SHA-256 fingerprints of reviewed installed SDK files:

- `dist/core/sdk.js`: `c5d5360f061b3b9f70dea1a0a424deb8a9a9417ed32a4c8d88bc9d0bfe7a75f5`
- `dist/core/model-runtime.js`: `da26f76339a031456f6d239a249159231776f760ab4ac538c6b54c417dea6f67`
- `dist/core/auth-storage.js`: `0b45029901579032b19273a1427f63b622df8e1aaf9ea185eb932c0d4898998c`
- `dist/core/models-store.js`: `acef4e29470ea2ed5adc4f8e8d4981e9214c79ebf4e7eba4ad705ff81da68ed4`

SHA-256 fingerprints of the existing explicitly admitted provider source:

- `pi-magpie/provider.ts`: `23e1afbbf69aea8404d600c029e94fa915c8fd81b3ab96e17e687365563c7e80`
- `pi-magpie/catalog.ts`: `a6467bb8366b9b52462ace44f3ef528c2036fe5bf0eeb69215107b70e135920d`
- `pi-magpie/constants.ts`: `92fbbba1c4ad0aa96eaf35d407fe76b837bc19bdb9d1f2614cb751ecc5618d89`
- `pi-magpie/gateway.ts`: `fcf9c535364ab7b54713bf9079d0419018be639362306d66011e7843646443e8`

These are consulted fingerprints; the disposable script does not enforce source
hashes. Production immutable admission must pin/verify those dependencies.
Context7 CLI lookup was unavailable without installing a package; no installation
was performed. Pinned installed SDK declarations/source and the reviewed existing
provider source supplied API facts.

## Repository verification

- `npm run typecheck`: exit 0, explicit 180-second command bound.
- Final model probe: `accepted=true`, six model-issued tool calls, exact selected
  identity and every recorded negative/control/final-fixture boolean true. An
  earlier successful turn preceded the exact-identity assertion; the recorded
  artifact is the final rerun with that assertion.
- Ticket `npm test`: explicit 180-second subprocess timeout; terminated by
  SIGKILL after 180010 ms. The suite also emitted its own 180000-ms timeout
  diagnostic. No pass/fail counters or passing full-suite result were obtained.
  Final candidates: `web/src/shell/shell.dom.test.ts`, including the phone-header
  connection-status/theme-control test at line 206. Candidates are not causes.
- Base `4574a061`: extracted with `git archive` into a temporary directory and
  linked to the same repository dependencies; no existing checkout was touched.
  `npm test` used an explicit 180-second outer subprocess timeout and 175000-ms
  internal suite deadline to leave time for its diagnostic. Exit 124 after
  175459 ms, no passing counters. Candidates included `routes.dom.test.ts`
  (idle Message/Project-event announcements, line 1099), `tasks.dom.test.ts`
  (blocker responsibility kinds, line 1084), and Agents prototype DOM suites.
  The five-second deadline difference is explicit; this is a reproduced bounded
  full-suite timeout on base, not proof of one identical hung test or its cause.
- `git diff 4574a061 -- src web package.json package-lock.json
  scripts/test-summary.ts scripts/test-progress-reporter.mjs`: no differences.
  Production, tests, manifests and the suite runner are identical to base. The
  timeout reproduces without the prototype artifacts being imported by tests.
- Probe syntax and `git diff --check`: pass. No production or test code changed.

Full-suite verification remains incomplete; neither record is claimed green.
The test timeout is pre-existing under this environment's bounded suite runs;
its precise cause is unresolved. Raw logs and machine paths are not committed.

## Standing integration references

The r1 reference consultation is inherited, with no copied source. The rework
changes explicit native provider/auth admission only; none of these reference
slices supplies model-issued isolation proof:

- Cumora `622498370cf76965a18d3c5041b040f0e57237d0`,
  `server/src/agents/computer/engine.ts`: adopt explicit engine admission and
  fail-closed boundaries; no unsandboxed opt-in under #225.
- AionUi `6744099b279b991c17e31c243f0920477bd31cb6`,
  `docs/prds/conversations/acp/permissions.md`: request/approval lifecycle;
  approval UI cannot replace host read isolation.
- Paperclip `06484b3c4153b6201f1a07304694793b1fdf36dd`,
  `packages/adapters/claude-local/src/server/execute.remote.test.ts`: engine/target
  separation as design; mocked transport is not live remote evidence and no
  credential synchronization is adopted.

Remaining fog: production minimum runtime reads, auth refresh requiring writes,
Windows isolation, enrolled cross-host deployment and cancellation/fencing remain
unproven. Existing r1 missing-input observations remain historical; no missing
document was reconstructed as an authority.
