# OAR Pi loader and native-tool policy (#270)

## Disposition

**The OAR Pi route remains blocked.** OAR 0.59.1 exposes `disallowedTools`, not the Pi SDK's `tools` / `noTools` admission controls or loader options. The shared adapter and runner now refuse `runtimeId: 'pi'` before installation probing, vendor session creation, bridge creation or extension loading. There is no configuration or environment bypass. Native Pi selection and native Host-run adapters remain unchanged.

This is a bounded refusal, not a delivered controlled Pi opener. #232 must adopt this shared refusal until a published, pinned upstream policy passes the checks below. It must not add a parallel loader policy or enable Pi OAR with a finite builtin deny list.

## Executed boundary evidence

`node scripts/probe-oar-pi-policy.mjs` uses the installed OAR 0.59.1 runtime and actual bundled Pi session against a synthetic streaming provider. These are **scripted** executions, not model-issued inference. It uses temporary config/project roots, synthetic credentials and filesystem receipts; native records and the dynamically assigned loopback endpoint are deleted. It bypasses Sprout's refusal intentionally to characterize the upstream boundary, not to provide a product escape hatch.

The unrestricted control forces a `bash` call and creates a file. With the seven named builtin tools denied, the provider still forces the same `bash` call; Pi emits the attempted call, the subsequent provider request contains an error tool result, and the file is absent. That proves the measured denial through resource effects. A separate attempt forces a previously unlisted project-extension tool, which creates a file under the same finite deny policy. `disallowedTools: ['*']` denies the forced extension call and advertises zero tools: it can deny everything, but cannot preserve a selected approved tool through an allowlist exception.

A synthetic extension in the ambient agent root creates a receipt in the positive control. Pinning `OAR_PI_AGENT_DIR` to a separate controlled root excludes that receipt, but the project `.pi/extensions` receipt still appears. The root pin replaces the global root; it does not disable discovery at other roots. Passing loader/tool CLI controls through `launchArgs` is refused. Finally, a declared stdio MCP fixture starts a real local Node process and creates a receipt after prompt admission. That child deliberately exits without completing an MCP handshake; the observation establishes process execution only, not a successful MCP tool call.

| Boundary | Can the current route enforce it? | Evidence class and observation | Required host mechanism / limitation |
| --- | --- | --- | --- |
| Named native `bash` exclusion | Yes, for the measured pinned session | scripted: forced call, error result, absent resource; unrestricted control creates it | Version-bound deny policy; do not infer denial of every other capability |
| Global agent/config root replacement | Yes, for the synthetic ambient extension | scripted: ambient receipt exists in control and is absent with controlled root | Host-owned immutable root; credential/provider configuration needs an approved broker or configuration channel |
| Ambient project extension exclusion | No through the published options used here | scripted: project receipt still created with controlled agent root and denied native tools | Upstream loader options that disable discovery at all roots; OS read/execute confinement for hostile extensions |
| Strict approved tool admission | No supported `tools`/`noTools` surface | scripted: unlisted extension call creates resource; wildcard denies all; loader CLI override refused. source-only: SessionOptions and opener mapping | Expose strict SDK tool admission, including refresh/resume/nested calls and approved MCP tools; finite deny lists default new names to available |
| Project MCP restricted to Worker origin | No active Pi route is admitted; upstream origin enforcement is unproved | scripted: explicit upstream stdio server starts local process; adapter tests and real runner reject Pi before opening | Disable ambient server registration and host stdio; permit only Sprout's existing authenticated origin bridge, with binding/lease fences and no local fallback |
| Host files, credentials, rules, skills, packages and provider commands | Unproved; tool denial is not an OS boundary | source-only: OAR pre-trusts cwd and loads resources; no attempted denied-open evidence for these roots | Host filesystem/process/network isolation, controlled loader roots and credential broker; prove each denied attempt separately |
| Sprout refusal | Yes | scripted: fresh/resumed requests fail before bridge access/spawn; real runner returns start error and creates no config/trust root | This refusal is the sole current shared mechanism; remove only after replacement acceptance |

A tool error and an absent advertised tool are different observations. The resource-effect controls establish the former; SDK source filtering supports the registry interpretation, but no claim of enumerating the entire live registry is made. No argv inspection or model tool preference is used as denial evidence.

## Required upstream change

No upstream package was changed, upgraded or patched, and no upstream issue was filed in this attempt. The following is a required upstream proposal, not an implemented OAR feature:

1. Add typed per-session Pi policy to the published contract: strict `tools` and `noTools: 'all'` (or an equivalent default-deny admission primitive), forwarded into `createAgentSessionFromServices`. The approved list must constrain registration, refresh, resume, model calls and nested execution; wildcard exclusions alone have no approved-name exception.
2. Expose a controlled loader/config policy before `createAgentSessionServices`: global and project extension/package discovery disabled, explicit approved factories only, separate controlled agent/config root, and declared handling of instructions/skills/rules. `OAR_PI_AGENT_DIR` alone is insufficient, and pre-trusting cwd must not silently enable ambient loaders.
3. Restrict MCP registration/transport to the approved Worker-origin bridge. Reject stdio configurations and ambient extension registrations before spawning, including on reload/resume. Reuse Sprout's existing bridge/transport; no second transport or vendor parser is needed.
4. Publish a pinned release and repeat real enrolled Worker acceptance: approved read/edit/command effects, denied local capability with unrestricted control, attempted ambient loader and host-stdio denials, supported model/progress/final reply, and unchanged activation/span attribution. #230's separate OAR lifecycle/settlement acceptance remains required.

The executable alternative is the unchanged native Pi adapter. A sandbox may constrain resource effects but does not by itself unregister tools or provide the required loader admission contract. This attempt does not amend AC2 or AC4 into a refusal-only acceptance claim.

## Acceptance disposition

| Ticket #270 AC | Disposition | Evidence / remaining condition |
| --- | --- | --- |
| 1. Determine strict admission feasibility honestly | met (negative answer for published surface) | Real scripted sessions above; typed interface/source mapping lacks admission/loader controls. No universal impossibility claim about future runner/OS policies |
| 2. Native tools unregistered and ambient extensions excluded for real Pi | blocked | Native Bash denial is measured; complete ambient exclusion fails. Requires published controlled opener plus real Worker proof |
| 3. Actually attempted denial and unrestricted positive control | met | Forced Bash error/absent file versus successful unrestricted file creation; wildcard extension denial also executed |
| 4. Worker-origin Project MCP only; no host stdio | blocked for an active Pi session | Upstream local stdio process actually executes. Sprout refuses all Pi OAR sessions; this prevents effects but does not prove active origin enforcement |
| 5. Reconcile #230 and route status | met | This document and the #230 §5.2 addendum explicitly retain the block and name exact prerequisites |
| 6. State upstream ownership; no parser/second transport | met | Required upstream proposal above; no vendor changes, wrapper or alternate transport |
| 7. Bounded standard checks; no deny/allow equivalence | met for command bounds; test gates not all green | Commands/results are recorded in the Work record; incomplete runs and baseline type errors remain non-passes |

## Regression protection and limits

Risk-to-test mapping: direct adapter construction must not admit fresh/resumed Pi or create a bridge; direct runner commands must not reach trust/config creation. Two regression tests protect those distinct entry points. With the shared checks temporarily disabled, both fail (unexpected bridge access and a real `ready` response); restored checks pass. Existing OAR tests cover the unchanged activation/span lifecycle. The scripted provider probe is hand-scheduled external conformance, not a default model-dependent test.

No enrolled Worker Pi OAR success, model-issued denial, full ambient filesystem denial, active Worker-origin-only MCP policy, Windows/Linux policy, or #230 lifecycle settlement proof is claimed. Those remain prerequisites, not inferred from the refusal or the existence of structures.
