# Claude on the shared supervised OAR adapter (#268)

## Disposition

Claude is registered as an explicit macOS candidate on `OarEngineAdapter`. Production selection remains unchanged, including the native `claude-host.ts` implementation. No Claude production environment switch was added. Candidate composition uses the `claude` dependency parameter in `createEnvironmentWorkerEngines`.

The measured combination is OAR 0.59.1, Claude Code 2.1.294, Node 26.11.1, macOS. Worker and runner require Node 24+. Non-inference readiness runs `--version` and `auth status --json`, emits only version/authentication facts, and leaves model entitlement unknown. Existing enrollment model authorization and #269 admission remain authoritative. The live Message used the existing host model and effort without substitution; it is an existing gateway route, not evidence of a Claude-native backend.

## Boundary verdicts

`scripted` means a controlled provider response or process fixture; `model-issued` means an actual model response. `protocol-only` establishes a normalized event fact without resource authority. `source-only` establishes code structure, not execution.

| Boundary | OAR enforcement verdict | Evidence | Required host mechanism / limitation |
| --- | --- | --- | --- |
| `disallowedTools` / `--disallowed-tools` | Enforces the measured Bash exclusion in Claude 2.1.294; no universal exclusion claim | scripted: controlled provider forces a Bash call, real CLI returns an error tool_result, no target file is created, Bash is not advertised | Version-bound explicit deny policy; independently test additional capabilities; OS sandbox for malicious/ambient execution |
| `additionalDirectories` / `--add-dir` | Expands access; does not confine it | source-only forwarding; scripted real Bash writes outside cwd and every additional directory | OS filesystem policy, separate execution roots, symlink/traversal confinement |
| Twelve inherited parent-session markers | Removes all twelve inherited markers; explicit env can restore eleven | scripted child executable observes actual environment; `CLAUDECODE` alone remains absent after explicit override | Host env allowlist and separate credential broker; this is not full environment sanitization |
| Managed `launchArgs` collisions | Rejects the measured permission-mode override before spawning | scripted: real launch function rejects `UnsupportedOptionError`, child receipt is absent | Host must validate all remaining flags; not every host flag is rejected |
| Permission approval / hard-coded bypass | Cannot supply a restrictive permission mode through OAR | source-only bypass; scripted forced Bash executes without approval; override refused before resource effect | OS sandbox and bounded tool authority; do not treat approval as isolation |
| `--tools` | Not automatically emitted; explicit host passthrough can enforce the measured empty builtin set | scripted: explicit `--tools ''` refuses a forced Bash call with an error result and no file effect | Validated host argument policy plus broader behavioral probes; not an OS isolation claim |
| `--bare` | Not automatically enabled; explicit launchArgs accepted | scripted: default SessionStart hook creates a receipt; explicit bare fixture suppresses it | Host policy must be declared and checked; bare alone does not prove managed policy denial |
| `--strict-mcp-config` (not `--strict-mcp`) | Not automatically enabled; explicit passthrough accepted; loader enforcement unproved | scripted real CLI session accepts the flag; no managed-MCP experiment | Explicit MCP inventory/transport policy plus OS process/network isolation; managed MCP needs separate proof |
| `--setting-sources` | Not automatically constrained; explicit empty-sources launchArgs accepted | scripted real CLI launches; no complete settings/policy denial proof | Explicit settings source policy plus denial of undeclared filesystem reads |
| Rules-file read denial | Not established; default route loads synthetic CLAUDE.md | scripted provider sees the synthetic rule in actual request context | OS read denial for rules roots; prove denied open, not just absent prompt text |
| Automatic plugin discovery | Unproved | source-only: no automatic bare/source restriction; no plugin execution experiment | Deny plugin roots/entrypoints and validate loader policy with attempted discovery |
| LSP trigger / entry | Unproved | source-only; no LSP attempt in this round | Deny LSP executable entry and socket/network access; instrument a real trigger |
| OS-managed policy | Unproved | source-only; no managed-policy host fixture | Dedicated host profile and an attempted managed-policy read/load denial |
| Managed MCP | Unproved | source-only; no managed-MCP execution fixture | Managed-MCP deny policy and attempted process/transport denial |
| Host-run remote authority | Refused by the candidate before runner spawn; OAR isolation itself remains unproved | scripted adapter contract test, zero spawns | Complete the placement/isolation proof under #225 before enabling Host-run |

The Ticket's claim that the four missing flags are never passed needs a qualification: OAR does not automatically emit them, but `launchArgs` passes host-supplied flags verbatim unless managed-collision validation rejects them. The bare/empty-sources probe actually executes this passthrough. No executable wrapper or alternate Claude transport was introduced. Historical 0.35.0 comparisons were supplied by the Ticket and were not rerun here; conclusions above come from installed 0.59.1 source and executions.

Primary local sources: `node_modules/@botiverse/oar/dist/runtimes/claude/{launch,launch-args,environment,installation,projection,content}.js`. Official CLI reference consulted: <https://code.claude.com/docs/en/cli-reference>. Context7 was unavailable; no dependency installation was attempted.

## Executable evidence

- `node scripts/probe-oar-claude-boundaries.mjs`: real Claude CLI driven by a scripted Messages provider; eight provider requests across denied-tool, ambient-loader, unrestricted-tool and explicit-host-flags controls. All phases complete. Positive control writes outside the allowed-directory list, so a missing resource effect in the denied case is distinguishable from a broken provider fixture. Native records and credentials stay in memory/on the host; output contains reduced booleans only.
- `node scripts/probe-oar-claude-message.ts`: real enrolled, approved, authenticated Worker over the production enrollment channel, real shared adapter/runner, real provider route, SQLite Runtime persistence and Message projection. One admitted run completes, two streaming text events occur, Project instructions/model/effort reach the adapter, normalized model event matches requested model, final answer matches the Project rule, one reply persists and remains one after reconcile. Token usage and detailed usage are present. The disposable local database is removed after verification; the emitted reduced observations preserve evidence, not raw records.
- `src/engine/oar-claude.test.ts`: candidate-only selection, current platform restriction, root-message final answer selection while retaining commentary progress, cumulative usage deltas, refusal before remote-authority spawn, strict version/auth readiness and private auth-output omission.
- `src/environment/readiness-observation.test.ts`: memory/SQLite red-to-green evidence for the context-qualified model identifier already admitted by `sanitizeIdentifier`. Before the fix, both backends rejected `[1m]` with `false !== true`; after the fix, supported qualifiers survive unchanged and arbitrary/zero qualifiers remain refused. The live route initially could not commit readiness for its existing model; it succeeds after this narrow grammar correction. No alternative admission predicate was added.

Detailed usage keeps cache-read and cache-write input dimensions per turn. The existing normalized runner path, root/child attribution, error/tool sanitization and Worker result sanitization remain in use. No raw OAR record subscription is used by the production adapter.

## Remaining Host-run prerequisites owned by #225

1. A declared host OS isolation profile for Claude and every descendant: deny host credentials, other sessions, unrelated files, loader roots, local fallback commands, and undeclared transports, while allowing only runtime necessities and the chosen authenticated provider route.
2. A credential broker or equivalent host-local mechanism that lets the engine authenticate without exposing credential files/material to builtin tools, hooks, plugins, MCP children or remote tools. Environment marker cleanup does not supply this.
3. A validated loader policy with actual attempted denial for rules reads, automatic plugins, LSP entry, OS-managed policy and managed MCP. Explicit bare/tools/settings/strict-MCP flags are candidates for policy inputs, not acceptance evidence by themselves.
4. Approved immutable remote binding, lease/generation/connection fences and allowed operations, with actual remote resource effects, rejected traversal/symlink/nested access, and no local fallback when the origin disconnects. The shared MCP bridge alone does not prove this placement policy.
5. Version/platform-specific execution and supervisor stop/recovery evidence under that same policy, including child teardown and safe session resumption only within unchanged authority. Windows/Linux Claude candidate execution is unproved.
6. Independent replacement acceptance and production selection decision. Retire native Claude only after acceptance; this candidate does not authorize retirement.

#225 was not edited, closed, or made dependent on #268. This implementation does not claim Host-run placement. AC4's complete host-authority outcome remains unproved even though the actual tool-exclusion negative case succeeds. Broad-suite completion and the existing typecheck baseline are recorded in the Work record, not relabeled as passes.
