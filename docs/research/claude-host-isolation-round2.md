# Claude outer-profile startup diagnosis, round 2 (#250)

Run `r225`, Job `r225-pro-worker-a2`, attempt 2. Evidence tier:
`model-issued (Claude Code CLI pinned at 2.1.294, non-Claude backend via local gateway)`.

## Resource admission

The unchanged profile reproduced the 40-second pre-init deadline, zero native
initialization records and zero model-issued calls. Fixed-label CLI debug facts
showed completed TLS-agent setup and successful scratch config writes before the
stall. A one-second native stack sample showed `std::__call_once` and `_sigtramp`
on the main thread; these symbols identify a native startup loop, not its exact
fault mechanism. Native-only empty-catalog startup initialized, and an open-file
comparison identified the public OS ICU timezone dataset missing from the
profiled process. This comparison is diagnostic, never fallback acceptance.

Admitting only read-data on the literal installed
`/private/var/db/timezone/tz/2026c.1.0/icutz/icutz44l.dat` changed the combined
launch from no initialization to `system/init`. The production profile resolves
installed `icutz` datasets under the fixed OS timezone tree and admits only
canonical files whose basename matches `icutz` + digits + `l.dat`. It adds no
write, directory-content, home, Keychain, Mach-service, temp-root or socket
allowance. An out-of-tree symlink resolves to no allowance.

A candidate write-data allowance on the literal native executable did not fix
startup and was discarded. Mach lookup, user/process operations and network were
already allowed by the inherited `allow default`; no extra rule was justified.
`fs_usage` required root, noninteractive sudo was unavailable, and the unified
log did not expose a CLI denial. No elevation was attempted. Native debug output
and stack addresses remain transient; committed facts use fixed labels only.

The new real Seatbelt regression failed before the profile change, then passed:
public ICU data reads work, writes to that data remain denied, and an unrelated
host sentinel remains unreadable. Existing Host Pi tests: seven pass. Typecheck:
exit 0. Four disjoint default-suite partitions cover 307 files and 2,355 passing
tests: 77/524, 77/606, 77/609, 76/616; zero failures, cancellations, skips or todos.
Each suite had a 175-second internal bound; none timed out. The exact target
manifest and counters are in `claude-prototype-verification-round2.json`.

## Next combined check

Initialization exposed a second failure: native MCP debug records report
`sandbox_apply`, `posix_spawn`, `Operation not permitted` and `EPERM`; the origin
server is failed, its catalog empty and model-issued origin calls absent.
The probe had requested another `sandbox-exec` from the already sandboxed CLI.
The next experiment moves independently isolated bridge launch to the trusted
supervisor and attaches the CLI through a stdio-only Unix-socket connector inside
its existing control root. This does not require a file-profile relaxation.
Combined origin/negative acceptance is still pending at this checkpoint.

Real Claude model behavior and the E7 attribution race remain open. The origin
is a separate local sandbox fixture, never an enrolled remote deployment.
