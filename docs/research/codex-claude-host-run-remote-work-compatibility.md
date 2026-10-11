# Codex and Claude Code feasibility for host-run remote work

## Result and evidence levels

Host-run remote work should be designed for Pi, Codex, and Claude Code from the start. Engine-specific tool control and execution routing belong in adapters; Project access, Environment bindings, leases, and operation recovery remain shared Sprout responsibilities.

The requirement is stronger than asking the model to prefer remote tools: work must have one permitted execution target, and an erroneous tool choice must not expose or modify the real Sprout host workspace. Removing built-in tools is one mechanism. Routing native tools to a selected remote executor is another. OS isolation supplies defense when tools, automatic resource loading, or extensions retain local access.

Evidence gathered:

| Engine | Evidence | Feasibility conclusion | Remaining proof |
| --- | --- | --- | --- |
| Pi SDK 1.0.4 | Passing local MCP registration/switch probe in the parent research note | Native tool replacement and dynamic MCP supply a direct integration route | Real remote work and restrictions through Sprout's CLI adapter |
| Codex CLI 0.159.3 | Installed CLI controls and generated protocol schema; passing app-server/executor probe; upstream routing source | Native executor selection is a credible primary route; MCP plus detached execution and host isolation is a fallback | Model-issued command, patch, image, nested-agent, discovery, and disconnection behavior on a real remote executor |
| Claude Code | Official CLI reference; Agent SDK types and subprocess argument construction; permission and hook documentation | Built-in work tools can be excluded while MCP tools remain; CLI and SDK both have an explicit route | No Claude executable was available on PATH, so live CLI/SDK behavior and model work are not evidenced |

These are feasibility findings, not a production certification. No model turn or real remote development host was used in the new Codex probe.

## Common execution contract

Use one current work binding per bounded run: Project, Environment instance, workspace identity, lease authority when required, and binding generation. Engine tools must route through this binding; tool arguments cannot select arbitrary hosts or assert authority.

A work session should expose a single understandable work plane:

- In an external-tool mode, all file, search, edit, command, image, and editor work uses typed remote tools. Local work tools are absent or refuse execution.
- In a native-executor mode, the engine's normal tools target the selected remote executor. The local Environment is not a second permitted work target.
- No remote failure silently falls back to a local directory, a local shell, another Environment, or a new authentication profile.
- Each request/result records its origin binding. An old request cannot retarget a new machine even if a tool name is reused.
- Local runtime/session files exist in a controlled runner area. They are not a mirror of the Project workspace and are not presented as the remote repository.

Names such as `remote.read_file` and a concise current Environment snapshot improve model understanding, but neither is enforcement. A remote tool is successful only after the remote execution result is known. A local write cannot be reported as remote progress.

Run the engine on the same physical host in a restricted runner process, account, container, or VM. Do not mount the Sprout repository, unrelated Projects, other Agent sessions, broad home directories, SSH agents, or container control sockets into its tool-visible area. Keep necessary authentication/session storage restricted and separate from workspace access. A container by itself is not protection if those resources are mounted into it.

Model authentication can remain configured on runner host(s), without introducing a central secret database. It still requires a version-specific decision about what the engine process and subprocess tools can read. Tool sandboxing often confines subprocesses, not every filesystem operation performed by the engine runtime.

Remote Workers must enforce their own filesystem/process restrictions and Sprout authority. MCP server processes can have privileges outside the engine's built-in tool sandbox. Their ability to write is independently authorized by the remote operation scope and lease.

## Claude Code: external tools with built-ins excluded

The CLI has a direct supported control:

```text
claude -p <prompt> --tools "" --strict-mcp-config --mcp-config <sprout-owned-config>
```

This is the relevant argument shape, not a complete production launch command. Official documentation says `--tools` selects built-in tools and an empty string disables them; the flag does not disable MCP tools. The reference documents an `EndConversation` exception when MCP tools remain, so do not interpret this as literally zero engine tools. That exception does not supply local file or shell work. [C1]

The Agent SDK's corresponding base configuration is:

```python
ClaudeAgentOptions(
    tools=[],
    mcp_servers={"sprout_remote": authorized_mcp_connection},
    strict_mcp_config=True,
    setting_sources=[],
)
```

The SDK source declares `tools=[]` as disabling built-ins, and its subprocess transport turns that list into `--tools ""`. `allowed_tools` is different: it auto-approves matching tools and leaves other tools available. Likewise, `canUseTool` only receives calls not resolved by earlier permission checks; auto-approved calls may never reach it. It is not an all-calls execution firewall. [C2–C4]

Sprout should construct MCP configuration rather than auto-loading the runner's existing Project/user MCP settings. `strict_mcp_config` controls MCP sources; it does not by itself turn off hooks, plugins, memory, instruction discovery, or every managed configuration. Use a controlled local cwd/configuration, verify `setting_sources` behavior, and explicitly examine automatic resource loading. Do not copy the remote repository onto the runner to make discovery work. Remote Project instructions and MCP descriptors can be loaded by the Worker and delivered as scoped context/capabilities.

A `PreToolUse` hook can deny a call before it executes and can inspect allowed server/tool identities. Use it as an additional engine-adapter guard with a fail-closed implementation; enforce the same binding and lease at the remote operation endpoint regardless. Source-provided rules, callbacks, or annotations must not relax Sprout authority. [C3, C5]

Claude's Bash sandbox is not a blanket sandbox for `Read`, `Edit`, `Write`, or remote MCP subprocesses. The SDK explicitly distinguishes Bash sandbox settings from tool-level read/write permission rules. Prefer excluding built-in work tools entirely for the first remote mode. This avoids maintaining a denylist that can omit a newly introduced tool. [C2]

Prototype acceptance:

- Observed initial tool catalog excludes local Bash/Read/Edit/Write/search/notebook/subagent work paths and retains only intended remote tools plus identified harmless engine controls.
- A repository read/edit/test scenario affects only the remote fixture/workspace.
- A prompt requesting the local host sentinel cannot read or modify it, including after an Environment switch, session resume, or an attempted nested-agent operation.
- Remote Project MCP discovery works without runner-side execution of repository-provided commands.
- Logs distinguish model choosing an unavailable tool from an actual remote execution.

A live Claude executable/SDK is the next evidence prerequisite. Do not install or infer account credentials merely to declare compatibility.

## Codex: native executor route and a controlled fallback

### Primary candidate: bind native tools to a remote executor

The installed **Codex CLI 0.159.3** has an experimental `exec-server` command. Its generated app-server schema includes:

- `environment/add` with an Environment identity and executor URL.
- `environment/info` and `environment/status`.
- `thread/start.environments` and `turn/start.environments`, with explicit selected Environment identity and Environment-local cwd.
- An explicit empty Environment list whose documented schema meaning is to disable execution-environment access for the applicable scope.

Upstream executor source exposes process start/read/write/signal/terminate and filesystem read/write/open/walk/remove operations. The core tool plan advertises native commands according to environment selection; `apply_patch` resolves the selected Environment's filesystem before verification/execution. These are evidence for a real native execution seam, not merely another MCP tool beside the original local tools. [X1–X4]

That makes the preferred Codex shape:

```text
host Codex app-server -> selected remote execution adapter -> enrolled Worker/executor
```

The adapter should attach only the leased/authorized remote work target. It must check model-originated selectors and maintain the selected target across retries, parallel calls, nested agents, and switches. Engine-native selection does not replace Sprout enrollment, Project access, lease, or connection fencing.

The executor protocol is Codex-specific. A compatible implementation behind the Sprout Worker could reuse the operations Module, or a remotely supervised Codex exec-server could be a bounded experiment. The latter still requires the executor binary on the work host, though not a full reasoning engine or model login for a direct connection. It is therefore a deployment tradeoff, not identical to an engine-free remote Worker. Upstream registry/relay registration modes may require Codex authentication; do not confuse them with a direct authenticated executor connection. Production needs protected transport and scoped endpoint access. [X1]

Keep the version matrix explicit. `exec-server` is experimental in the installed CLI. Upstream main contains additional environment/tool-policy features that may not match the release. Names such as `stable_environment_tools` are not stability guarantees: upstream marks that specific feature under development. Do not enable it as an assumed released requirement. [X4]

### Fallback: remote MCP plus detached native execution

The installed CLI exposes `features.shell_tool`; the probe confirms it can be disabled. Turning off `unified_exec` is not enough: upstream can retain a one-shot command tool. Disabling shell also does not remove `apply_patch`, whose registration is independent of the shell feature. Image reading and nested Agents need separate examination. [X3]

A candidate external-tool launch combines:

- Explicitly no native work Environment selected, as supported by the pinned version.
- Shell, image, nested-agent, hooks, code execution, and other unnecessary capabilities disabled using verified controls.
- Only approved remote MCP/custom tools registered.
- An isolated runner with no real Project files accessible.
- A dispatch/approval policy that cannot re-enable local work or elevate permissions.

The accepted empty Environment selection is protocol evidence, not a completed proof that every model-visible local tool is absent or every native execution attempt fails. That must be checked with model-issued calls. Upstream also has a Rust extension `ToolPolicy.allowed_tools`, but this is not evidence of an equivalent public CLI/config/app-server allowlist. Do not claim that the current Sprout adapter can use it without a separate integration investigation. [X5]

### Why the current sandbox setting is insufficient

Sprout's existing Codex adapter supplies `sandbox: 'read-only'` and `approvalPolicy: 'never'`. Read-only restricts modification; it is not a statement that only the selected cwd can be read.

The installed-version probe ran a sandboxed command that read a disposable sentinel **outside the workspace**, and that read succeeded. The command was explicitly issued by the test client through `command/exec`; it was not a model tool call. It establishes the breadth of the tested read-only policy, not that a model can call the client RPC directly.

The generated schema also documents host-side `fs/readFile` and an unsandboxed `thread/shellCommand` client operation. These are client interfaces, not necessarily model tools. Sprout must not expose a raw app-server request tool or forward arbitrary model-selected methods into them. The adapter should expose only intended run/execution behavior. [X2]

Use verified deny-read profiles or outer OS isolation to protect host files. Empty cwd and read-only writes alone do not meet the remote-work requirement.

## Installed Codex protocol probe

Run:

```text
node scripts/probe-codex-host-tool-restrictions.mjs
```

An explicit `--codex-binary <path>` can select an installation. The probe uses isolated Codex configuration and disposable workspace/sentinel files. It removes API-key environment variables for its children and makes no model turn. It does not load the normal account/configuration profile.

Observed on **0.159.3**:

1. app-server accepts strict configuration and reports disabled shell, unified exec, image, multi-agent, and hook features.
2. `thread/start` accepts `environments: []`.
3. Sandbox `readOnly` allows the probe's read of the temporary sentinel outside cwd.
4. Standalone exec-server initializes and reads/writes a temporary file via filesystem RPC.
5. Through a temporary loopback WebSocket bridge, app-server successfully attaches that executor using `environment/add`, obtains information, and creates a thread selecting its separate workspace.

The last step uses two processes and different cwd values on one machine. It demonstrates actual protocol attachment, not a network sandbox or complete remote routing proof. It does not exercise a model-produced patch, command, or image call. All temporary processes, listeners, and files are closed/removed by the probe.

## Shared acceptance before production work

Run the same origin-sensitive scenario through all three engines:

- Give local and remote fixtures the same relative filenames but different sentinel contents; a read returns the remote marker and an edit changes only the remote file.
- Ask explicitly to read/write a sentinel outside the permitted host runner area; the attempt is refused and does not leak sentinel content to the model.
- Exercise command execution, shell redirection, search, file patching, image paths, nested Agents, and automatic instructions/skills/MCP loading where supported.
- Switch A to B at a safe request boundary. A calls cannot execute on B, and old file observations are not presented as current B facts.
- Disconnect the remote target. No operation falls back locally; unresolved processes keep the lease in recovery.
- Repeat after native session resume and verify the current catalog and authority are reapplied.

Only an isolated end-to-end model run proves that the intended work paths are usable and the unintended paths are refused. A model merely choosing the remote tool is not evidence that local access is impossible.

Recommended next slices: Claude's live external-tool run and Codex's model-issued native-executor run in parallel, after the common binding/fixture acceptance shape is settled. Pi remains the third adapter on the same acceptance contract. Choose the production Codex route from these results rather than assuming every engine must implement Pi's tool replacement mechanism.

## Primary sources

- **C1 — Claude Code CLI reference:** <https://code.claude.com/docs/en/cli-reference>
- **C2 — Claude Agent SDK Python options and sandbox declarations:** <https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py>
- **C3 — Claude Agent SDK permissions, including callback precedence:** <https://platform.claude.com/docs/en/agent-sdk/permissions>
- **C4 — SDK subprocess argument construction:** <https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/transport/subprocess_cli.py>
- **C5 — Claude Code hook execution and denial:** <https://code.claude.com/docs/en/hooks>
- **X1 — Codex executor transport, lifecycle, authentication and filesystem/process operations:** <https://github.com/openai/codex/blob/0e1520605f67969b58e53762be4d675c036a981d/codex-rs/exec-server/README.md>
- **X2 — Installed app-server schema:** generated using `codex app-server generate-json-schema --experimental --out <temporary-directory>` on 0.159.3; official interface overview: <https://developers.openai.com/codex/app-server/>
- **X3 — Core command and utility tool construction, independent patch registration:** <https://github.com/openai/codex/blob/0e1520605f67969b58e53762be4d675c036a981d/codex-rs/core/src/tools/spec_plan.rs>
- **X4 — Patch routing and feature stages:** <https://github.com/openai/codex/blob/0e1520605f67969b58e53762be4d675c036a981d/codex-rs/core/src/tools/handlers/apply_patch.rs>; <https://github.com/openai/codex/blob/0e1520605f67969b58e53762be4d675c036a981d/codex-rs/features/src/lib.rs>
- **X5 — Internal Rust tool policy, not a demonstrated CLI allowlist:** <https://github.com/openai/codex/blob/0e1520605f67969b58e53762be4d675c036a981d/codex-rs/ext/extension-api/src/tool_policy.rs>
- **X6 — Current Codex configuration reference:** <https://developers.openai.com/codex/config-reference/>

Context7 lookup failed with a fetch error. Critical claims were checked against directly retrieved official documentation, SDK source, pinned Codex source, installed generated schema, and the disposable protocol probe. Upstream source and current docs may describe features newer than the installed version; the evidence levels above preserve that distinction.

Related: [host-run topology, remote Project MCP and switching research](host-run-engines-remote-environment-tools.md), [Codex probe](../../scripts/probe-codex-host-tool-restrictions.mjs), and [Pi MCP-switch probe](../../scripts/probe-host-run-mcp-switch.mjs).
