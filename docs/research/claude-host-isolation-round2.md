# Claude outer-profile startup diagnosis, round 2 (#250)

Run `r225`, Job `r225-pro-worker-a2`, attempt 2. Evidence tier:
**`model-issued (Claude Code CLI pinned at 2.1.294, non-Claude backend via local gateway)`**.

## Outcome

**The combined model-issued origin/negative experiment passed under the outer
profile.** The pinned CLI initialized with exactly `mcp__origin__remote_read` and
`mcp__origin__remote_write`, with the origin connected. Eight model-issued calls
read `REMOTE_ORIGIN`, wrote `REMOTE_MODEL_EFFECT`, checked the effect and denied
absolute host/auth reads and writes plus a symlink escape. The turn exited 0 with
`result/success`. A ninth call after same-session resume read back the effect.
Host origin/effect/sentinel stayed unchanged; ambient discovery canaries stayed
inactive. All scripted engine/bridge/origin host, other-Project and Agent-history
read/write denials passed. The engine alone could read its existing auth settings;
engine auth writes and all bridge/origin auth reads/writes stayed denied.
No credentials were copied. The origin is a separate local sandbox fixture,
**not an enrolled remote deployment**.

The profile-resource blocker is resolved. This does not admit a production Claude
adapter or settle every production prerequisite. Real Claude model behavior and
the E7 attribution race remain open, along with managed-source inventory,
enrollment/Project authority, binding fences, credential refresh and interrupted
session recovery. No merge, push, installation, login or Ticket closure occurred.

## Resource admission and causal evidence

The unchanged profile reproduced the 40-second pre-init deadline, zero native
initialization records and zero model-issued calls. Fixed-label CLI debug facts
showed completed TLS-agent setup and successful scratch config writes before the
stall. A one-second native stack sample showed `std::__call_once` and `_sigtramp`
on the main thread; these symbols indicate a native startup loop, not its exact
fault mechanism. A native-only empty-catalog comparison initialized, and its
open-file inventory identified public OS ICU timezone data missing from the
profiled process. This comparison is diagnostic, never fallback acceptance.

Admitting only read-data on the literal installed
`/private/var/db/timezone/tz/2026c.1.0/icutz/icutz44l.dat` changed the combined
launch from no initialization to `system/init`. It is the only new production
resource admission. `src/engine/host-runtime-files.ts` resolves installed `icutz`
datasets under the fixed OS timezone tree and admits only canonical files whose
basename matches `icutz` + digits + `l.dat`. An out-of-tree directory target or a
file symlink creates no allowance. `isolationProfile` adds literal `file-read-data`
rules for those files; it adds no write, directory-content, home, Keychain,
Mach-service, temp-root or socket allowance. The probe uses the same resolver.

A candidate write-data allowance on the literal native executable did not fix
startup and was discarded. Mach lookup, user/process operations and network were
already allowed by the inherited `allow default`; no extra rule was justified.
The redirected config/temp roots were already writable, with successful atomic
config writes in the debug sequence. `fs_usage` required root; noninteractive sudo
was unavailable. No elevation occurred. Unified logs, including a `debug deny`
profile comparison, exposed no CLI denial. Native debug text, addresses, process
identifiers and payloads remain transient; persisted diagnostics use fixed labels.

## Attachment correction without a profile relaxation

After timezone admission, the original native MCP launch failed. Debug records
reported `sandbox_apply`, `posix_spawn`, `Operation not permitted` and `EPERM`;
the origin server was failed and its catalog empty. The CLI was trying to apply
another Seatbelt profile through a child `sandbox-exec`. The successful topology
launches the bridge independently under its own unchanged profile from the trusted
supervisor. The CLI starts a fixed `/usr/bin/nc -U` stdio connector, which inherits
the CLI's outer profile and forwards bytes to a supervisor-owned Unix socket.
Each accepted connection receives a fresh isolated bridge process. The connector
has no tool logic; the independently isolated bridge retains host/auth denials.
The socket sits in the already admitted disposable engine-control root. No new
socket-path or network allowance was needed. This is host-local prototype wiring,
not an enrolled deployment or a new production adapter.

The first socket location exceeded Darwin's Unix-socket path bound and produced
`EINVAL`; shortening the disposable control directory resolved it without
admitting another directory. A 40-second work-turn bound then observed the exact
catalog and two real calls but expired before readback/negatives; that partial
turn was not counted as passing. The first turn now has a 110-second limit, later
turns up to 40 seconds, all within the existing 170-second supervisor and explicit
180-second command bound. The final complete run did not time out.

## Final evidence and control contract

`claude-host-isolation-prototype-evidence.json` records the final combined run.
`claude-host-isolation-round1-evidence.json` preserves the original combined
failure. Native-only round-1 artifacts remain diagnostic. Reproduce the final
combined check with `CLAUDE_PROBE_PORT` set within the assigned port block and
`node scripts/probe-claude-host-isolation.mjs`, with a 180-second command timeout.
Optional `CLAUDE_PROBE_SAMPLE=1` collects fixed-symbol/open-resource classes;
`CLAUDE_PROBE_EMPTY_CATALOG=1` and `CLAUDE_PROBE_STARTUP_ONLY=1` support bounded
startup comparison. `CLAUDE_PROBE_NATIVE_ONLY=1` still records an explicit gap and
can never supply passing combined acceptance.

| Check | Final combined result |
|---|---|
| Native initial catalog / origin | Exactly two typed MCP tools; connected |
| Model-issued read/change/check | Eight work calls; remote marker, effect and readback observed |
| Model-issued negatives | Host and auth absolute read/write, and symlink read denied |
| Outer file negatives | Host, other-Project, Agent-history reads/writes denied in all three roles; direct engine/bridge origin-file access denied |
| Engine-local authentication | Helper works and invoked; existing auth file only engine-readable and read-only; no copy |
| Automatic/nested paths | Synthetic hook/plugin/skill/context/MCP canaries inactive; only the two typed tools used; scripted shell/nested/traversal denied |
| Resume / catalog transition | Same native session resumes for same origin/catalog; changed empty catalog uses a fresh session |
| Events / usage / interruption | Neutral system/assistant/user/result events and native token dimensions observed; local SIGINT exits 0 without a result, not remote-stop or interrupted-recovery proof |

The control contract from round 1 retains exact catalog verification, empty
builtins, frozen sources/binding, engine-owned auth, separate origin authority and
fail-closed admission. Its unmet combined-profile clause is now evidenced by this
run with the literal ICU allowance and independently launched bridge. Preserve
that launch topology; reintroducing nested `sandbox-exec` reproduces attachment
failure. No native-only, local-work, mode, account or credential fallback is
admitted. Final debug logs still mention `posix_spawn`/`EPERM` for peripheral
startup activity despite successful catalog/turn completion; those fixed labels
are not claimed as a fully inventoried native control surface.

Standing reference consultation remains the round-1 pins and slices (Cumora,
AionUi, Paperclip); none supplies a mature fix for this OS ICU/Seatbelt problem.
No reference code or credential synchronization was adopted. No domain/ADR/UI
projection changed. Metadata access and broad existing system/Homebrew runtime
reads remain inherited limitations, not new allowances. Cross-host enrollment,
production cancellation/fencing, interrupted-session recovery, Windows, native
managed-source inventory, credential refresh, real Claude model behavior and the
E7 root-turn attribution race are still unevidenced.

## Repository verification

The new real Seatbelt regression failed before the profile change and passed
after it: installed ICU data is readable, opening it for write is denied, and an
unrelated host sentinel remains unreadable. Existing Host Pi tests: seven pass.
The production change was reviewed for literal-only public data admission,
canonical path containment, absent-data fail-closed behavior and unchanged write
rules. A typecheck-found optional-array access in the test was corrected before
the final passing check. `npm run typecheck`: exit 0.

Four disjoint default-suite partitions cover **307 files / 2,355 tests**, all
passing: 77 files/524 tests, 77/606, 77/609, 76/616. Zero failures, cancellations,
skips or todos. Each suite had a 175-second internal bound under an explicit
180-second command policy; none timed out. The exact target manifest and counters
are in `claude-prototype-verification-round2.json`. These partitions verify the
final production profile/helper/test change; the disposable attachment correction
is additionally verified by the complete combined model-issued probe. Syntax and
whitespace checks passed. No monolithic suite pass is claimed.
