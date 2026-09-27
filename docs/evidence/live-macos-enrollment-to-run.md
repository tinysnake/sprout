# Live macOS enrollment-to-run evidence

The enrollment-to-run journey is tracked in #121. The following is a separate
verification of the #137 E7 duplicate-start/status fixup, after the LaunchAgent
was active. It records the sanitized live observations from the #137 Work record;
this is not a fresh replay of the #121 journey.

## #121 original partial journey (`fe630e44`)

The original partial-journey evidence is preserved without replacing its
claims: `m113-ticket-121-e7:docs/evidence/live-macos-enrollment-to-run.md`
and the original #121 Work record. This section does not convert that attempt
into a successful Agent run. It established empty-catalog enrollment, real CLI
identity and LaunchAgent, explicit `agent-run` approval, Worker non-inference
probing, and Worker-validated Project access; admission refused its real task
with `no available environment for capability: agent-run` because Codex
readiness was `unknown`. It established neither a run lease nor a session,
usage, or engine event. Same-identity reconnect produced a fresh epoch and
revocation barred reconnect, but competing start was not refused and status
incorrectly reported stopped. These are the original limitations, not
post-decision results. The original record is retained on its branch verbatim.

## #137 fixup: duplicate refusal and authoritative status

The status query showed a connected Worker at epoch 1; a competing foreground
start returned exit 7 without replacing that connection. After a genuine
LaunchAgent restart, the connection advanced from epoch 1 to epoch 2, and
status reflected the new epoch. This checks that host-local duplicate refusal
does not prevent a legitimate same-identity reconnect.

```text
[setup] Enrolling worker via CLI with piped claim secret...
Enroll exit code: 5 (awaiting approval)
[setup] Approving enrollment in Sprout Web/core...
[setup] Installing LaunchAgent service via `sprout worker install-service`...
Install exit code: 0
LaunchAgent installed and loaded in gui/<uid>.
Worker connected outbound to Sprout Gateway (epoch 1).

[step 1] Checking `sprout worker status`:
Exit code: 0
Stdout:
state: connected
epoch: 1
protocol: 3
service: installed and loaded

[step 2] Attempting duplicate `sprout worker start` while LaunchAgent connection is live:
Exit code: 7
Stderr:
sprout worker start: another Sprout Worker for this environment is already running (pid <pid>)
Gateway active connection count remains 1, connection epoch remains 1.

[step 3] Restarting LaunchAgent via `launchctl kickstart -k gui/<uid>/dev.sprout.worker.<hash>`:
Previous connection closed cleanly, reconnect established with epoch 2.

[step 4] Checking `sprout worker status` after restart:
Exit code: 0
Stdout:
state: connected
epoch: 2
protocol: 3
service: installed and loaded
```

## #121 E7-LIVE-001 rework: live superseded-channel fence

On macOS 26.6.2 with Node 26.9.0 and Worker protocol 3, ran
`SPROUT_E7_PORT=<allocated-port> node scripts/live-e7-epoch-fence.ts` against
a fresh isolated SQLite database and the **production** `src/main.ts` runtime.
The script uses
the real authenticated production Web HTTP/CSRF boundary, real
`bin/sprout worker enroll` and `bin/sprout worker start`, and the production
`connectWorkerEnrollment` identity/key-possession connector for a competing
same-identity connection. It contains no fixture Worker, manually fabricated
gateway frame, injected authority, or simulated receipt. The temporary
owner-only Worker identity, database, session and credentials were removed
after the run; no secret, public key, cookie, host path or raw response is logged.
This is a separate bounded replay, not a claim that the earlier Pi run had a
stale in-flight Agent turn.

```text
initial catalog empty: true
real CLI enroll exit: 5
epoch 1 online: true
epoch-1 real Worker probe committed: true
second genuine authenticated connection epoch: 2
epoch-1 Worker exited after gateway closure: 13
enrollment history preserved: true
epoch-1 receipt now non-authoritative: true
durable receipt sequence unchanged: true
durable probe count unchanged across supersession: true
no epoch-1 readiness projected at epoch 2: true
```

The first channel was kept alive as the foreground Worker while a real
core-issued readiness probe committed its epoch-1 receipt. The second
connection proved possession of the **same persisted identity** through the
production handshake (without using the CLI process start, whose host-local
lock rightly refuses a duplicate) and received epoch 2. The foreground
epoch-1 Worker then terminated with exit 13 because its socket was closed.
The historical receipt remained readable but `authorityCurrent` became
`false`; the durable probe count and that receipt's sequence did not advance.
The second authenticated connector was intentionally held open but did not
host a Worker command server, so it did not submit a new probe and is not
claimed as an operational replacement Worker.

**What the production path guarantees:** `WorkerGateway.#handshake` calls
`#epochs.accept` and synchronously `#supersedePriorForInstance`, which
invalidates the old connection and closes its JSON-RPC transport before
publishing the replacement. `EnrollmentWorkerPort` invalidates old adapters
on close; `authorizeObservation` checks the current epoch and instance owner,
and `EnvironmentEnrollmentService.recordReadinessObservation` and the
readiness store re-check that scoped authority at commit. The Worker protocol
has no free-standing worker-to-core `submit facts` JSON-RPC method: readiness
is requested by the core on the accepted channel; turn events/settlement are
notifications associated with an active session. Once the old socket closed,
there was **no stale live channel on which to attempt a later fact RPC**.
Thus the direct live observation is transport closure plus no new durable
fact, **not** an invented stale-RPC error response or a demonstrated
late in-flight write race. The post-close attempted submission is impossible
on that production channel. An in-flight observation racing acceptance is
additionally guarded at the store mutation boundary; this run did not force
that timing race. Owner phone/desktop review (E7-OWNER-002) remains a separate
Human action.

Verification of this rework: `npm test` under a 180-second deadline: 1,436
passed, 0 failed; `npm run typecheck`: pass; `git diff --check` and privacy
scan of the script and evidence (home paths, private addresses, credentials,
personal identities, literal allocated port): pass.

## #121 post-decision re-run on `6eb4f765` (blocked at real admission)

This is a **new live execution**, not a fixture Worker or a replay of the
earlier partial attempt. It did **not** achieve a refusal-free Agent run.
The exact remaining blocker is below; the Human authorization was genuinely
recorded and was not substituted for a contradictory measured model fact.

- macOS 26.6.2, Node 26.9.0, Worker protocol 3, Codex 0.156.0 and Pi
  0.87.1. `npm run web:build` built the production Web. With
  `SPROUT_ENV_SOURCE=enrollment`, an empty isolated SQLite database,
  `SPROUT_PORT=<allocated-port>`, and a host-only Operator credential,
  `npm start` reported `enrollment catalog (no enrolled instances)`.
  Web stayed running throughout enrollment, approval, probe, and attempted
  run. No runtime JSON or fixture Worker was used.
- The authenticated Web session (HttpOnly cookie + CSRF) listed zero
  enrollments. Web `POST /api/environments/enrollments` returned 201 and a
  pending record, separate one-use secret, and bootstrap information.
  The real `sprout worker enroll <loopback>:<allocated-port> <enrollment-id>`
  read the secret from owner-only stdin outside the checkout, generated and
  persisted an owner-only identity, proved key possession, and returned exit
  5 (`Identity proven. Waiting for Human approval`). The Web history recorded
  `identity-claimed` without disclosing the key. The target-model Agent was
  created through production Web **before** approval so its option was in the
  requirement scope at the ceremony.
- Web `POST /api/environments/enrollments/<id>/approve` explicitly supplied
  `capabilityPermissions: {"agent-run":true}` and
  `modelAuthorizations: {"codex":["gpt-5.2-codex"]}`. The durable approved
  decision records both. `sprout worker install-service` installed and loaded
  the actual signed-in-user LaunchAgent; `worker status` reported connected,
  epoch 1, protocol 3. The Worker committed a non-inference readiness receipt
  (protocol OK, source `worker`) showing installed Codex 0.156.0 and Pi
  0.87.1, both engine readiness `ready`; Codex authentication was observed
  via `codex-account-read`. The measured Codex model availability was
  `unknown`, while the **separate** authorization carried provenance
  `human-approval` and matched the current Codex requirement revision.
- Production Project creation and `POST /api/projects/<project>/access` with
  `{ "workspace": { "kind": "default" } }` returned 201. The real Worker
  validated a durable workspace binding and opaque workspace ID through #93.
  It is a Project-access binding, **not** evidence of a prepared run workspace.
- Compatibility was **not** available, with the precise reason:
  `Work model "gpt-5.2-codex" is not available for "codex" on this Environment.`
  The Worker probe's measured `modelIdPresent: false` is the contradictory
  fact: #138's Human authorization does not override an explicit negative
  non-inference observation. The intentional real run (`POST /api/runs`, task
  to write one short workspace file) returned 202 but settled `failed`, with
  zero events and exact failure `no available environment for capability:
  agent-run`. The run remains readable. There is **no** acquired lease, session
  slot, run workspace, run connection epoch, engine result, or usage to verify;
  these cannot be claimed as successful. We did not change the configured
  model, falsify a probe, or weaken strict admission to force this run.
- A competing real `sprout worker start` while the LaunchAgent was connected
  returned exit 7 (`already running (pid <pid>)`); status remained epoch 1.
  `launchctl kickstart -k gui/<uid>/<service-label>` then advanced the same
  identity to epoch 2, with truthful connected status. Direct retrieval of
  the epoch-1 readiness receipt returned `authorityCurrent: false`; a new
  Worker probe was committed at epoch 2 (HTTP 201). There was no running work
  to reconcile. This earlier run did not exercise a stale connection submitting
  facts or journal-based recovery; the subsequent live epoch-fence replay below
  establishes what the production protocol actually permits instead.
- Web revocation returned 200; a further LaunchAgent kickstart yielded
  `state: revoked` and `the Worker enrollment was refused`. The enrollment's
  decisions, historical receipt, failed run, and Project workspace binding
  remained inspectable; the live readiness was cleared. The test LaunchAgent
  was uninstalled. There was no lease/session history because admission had
  never succeeded. Owner phone/desktop visual review remains outstanding:
  this run exercised the actual authenticated Web HTTP/CSRF surface, not a
  visually approved browser ceremony.

### Production CLI seam carried forward

This integration baseline did not include the previous #121 CLI non-inference
probe wiring from `fe630e44`: initially the enrolled CLI had only an
unmeasured `unknown` placeholder and `POST .../probes` returned 500. We
restored the real `worker/main`-equivalent non-inference probe in
`src/worker/cli/worker-cli.ts` and genuinely restarted the LaunchAgent; the
subsequent Worker receipt and explicit probe were committed without simulation.
No admission override was made. The initial empty-catalog replay was repeated
with the target Agent configured **before** approval after discovering that
an approval before the target existed could not authorize a missing target;
only the final replay above is cited for the authorization check.

### Blocker for the Human

With this host's real Codex account probe, `modelIdPresent: false` expressly
refuses the configured `gpt-5.2-codex` despite an otherwise valid Human
approval. A decision or a genuinely different available target is needed;
we did not work around this negative observation. The original #121 goal of
a settled real Agent run and its attributable resources remains unproved.

## #121 resolved-slug replay (admitted; blocked by Codex usage limit)

This replay follows the Human's model choice. The requested `gpt-6-luna` slug
does not occur in the installed Codex bundled catalog; the same catalog lists
`gpt-5.6-luna`, which is the actual luna model slug. I mapped the Human's
intended luna target to `gpt-5.6-luna` and configured that exact slug. This is
an explicit mapping, not evidence that a `gpt-6-luna` model exists.

- `~/.local/bin/codex debug models --bundled` included `gpt-5.6-luna`. The
  production Web was built and the already-running production Sprout process
  from this checkout was reused on its allocated port so the durable journey
  state and connected Worker were preserved. Its enrollment source was
  `enrollment`; no runtime JSON or fixture Worker was used.
- The Human-owned Agent configuration advanced to version 2 with its Codex
  option set to `gpt-5.6-luna` (effort `low`). This requirement revision makes
  the prior `gpt-5.2-codex` authorization inapplicable. A fresh Environment
  instance `e7-resume-macos-luna` was enrolled and claimed by the real CLI;
  explicit authenticated-Web approval granted `agent-run` and
  `gpt-5.6-luna`. The durable model authorization had
  `human-approval` provenance. The Worker-sourced non-inference probe measured
  `modelIdPresent: true`, and the Agent compatibility endpoint reported the
  option `available` for that instance.
- Project access returned 201 and Worker validation established default
  workspace binding `binding-82i0srrh45`, workspace
  `9dbd2aeee278d69957a15612`. Two intentional submissions of the same real
  file-writing task (“Create `hello.txt` … containing exactly `Hello, Sprout!`”)
  each returned 202; strict admission accepted them rather than refusing them.
  Their durable run records identify Environment `e7-resume-macos-luna`, Project
  `e7-journey-project`, Agent `e7-journey-agent`, Codex model `gpt-5.6-luna`,
  configuration version 2, and the Project workspace binding above:

  | Run | Lease | Settled result |
  | --- | --- | --- |
  | `run-mugsgi31-8b8a4d43` | `lease-mugsgi32-49acbc04` | failed |
  | `run-mugsk3b4-b334d6ba` | `lease-mugsk3b5-550cefd5` | failed |

  Both leases identify `e7-resume-macos-luna` and were released at settlement.
  Both runs have zero events, no token-usage facts, and no retained Codex
  session-key slot. The Worker was connected at epoch 1 when the runs were
  submitted; the run records do not persist a per-run connection-epoch field,
  so this is connection-status evidence, not a run-level epoch attribution.
  The Worker-sanitized run result is `the engine turn failed`. The real Codex
  rollout records identify `usage_limit_exceeded` (“You’ve hit your usage
  limit”); provider/account details are intentionally omitted. Admission and
  model authorization therefore succeeded, but no Agent task completed and
  successful execution/resource attribution remains unproved.
- The duplicate foreground `sprout worker start` while the LaunchAgent was
  connected returned exit 7 (`another Sprout Worker ... already running (pid
  <pid>)`). `launchctl kickstart -k gui/<uid>/<service-label>` reconnected the
  same enrolled identity at epoch 2; `worker status` reported connected and
  epoch 2. Revocation returned 200, and a further LaunchAgent restart reported
  `state: revoked` / `the Worker enrollment was refused`. The prior epoch-2
  Worker receipt remained readable with `authorityCurrent: false`; both failed
  runs and the Project workspace binding remained readable. The test
  LaunchAgent was uninstalled after the refusal was verified.
- This is not a successful Agent-run proof. The external blocker is Codex's
  account usage limit, not Sprout admission or missing model authorization.
  A new real task attempt requires the Codex account to have available usage.
  Owner phone/desktop visual review of the Web ceremony remains outstanding;
  approval here was made through the authenticated production Web HTTP/CSRF
  surface.

## #121 Human option B replay (successful Pi Agent run)

After the Codex usage-limit result above, the Human chose option B: switch the
real run to Pi. The Pi target is `deepseek/deepseek-flash`: local `pi
--list-models deepseek-flash` listed provider `deepseek` and model
`deepseek-flash`, and `pi auth check --json --no-refresh --provider deepseek`
reported `status: ready`, `authType: api_key`. Both checks are non-inference;
no credential output or hidden model turn was used to select the target.

- The Worker readiness implementation now measures exact provider/model
  presence from Pi's local `--list-models` output while keeping account/model
  entitlement `unknown`. The Agent configuration advanced to version 4 with
  engine `pi`, work model `deepseek/deepseek-flash`, and effort `low`. This
  requirement revision makes the preceding `gpt-5.6-luna` Codex authorization
  inapplicable. A fresh enrollment `enroll-mugtzyzo-c076b298` for Environment
  `e7-resume-macos-pi` was claimed by the real CLI, then explicitly approved
  through authenticated production Web for `agent-run` and
  `deepseek/deepseek-flash`; the authorization provenance is
  `human-approval`.
- The committed Worker receipt at epoch 2 reports Pi 0.87.1 installed and
  authenticated, `authType: api_key`, `source: pi-auth-check`, and
  `modelIdPresent: true` for target `deepseek/deepseek-flash`. Model entitlement
  remains `unknown`, as expected; the revision-current Human authorization
  supplies the explicit admission decision. Agent compatibility reported this
  Pi option `available`. Project access returned 201 and validated the default
  workspace binding `binding-y5nfdovjcc`, workspace
  `9dbd2aeee278d69957a15612`.
- The intentional prompt to create `hello.txt` containing exactly
  `Hello, Sprout!` returned 202 and settled `completed` as run
  `run-mugufbpe-4c637292`. The durable run record identifies Environment
  `e7-resume-macos-pi`, Project `e7-journey-project`, Agent
  `e7-journey-agent`, Pi model `deepseek/deepseek-flash`, configuration version
  4, and the workspace binding above. Its lease
  `lease-mugufbpf-8d595670` identifies that Environment and is released. One
  durable Pi session-key slot remains for that Agent and Environment. The run
  contains 69 events and provider-reported usage of 5,856 prompt tokens, 200
  completion tokens, and 11,688 total tokens. The Worker was connected at epoch
  2 when submitted, corroborated by the epoch-2 Worker receipt; the run schema
  does not store a per-run connection-epoch field. The workspace file was read
  back and matched the requested contents exactly.
- The duplicate-start refusal (exit 7) remains evidenced in the #137 fixup
  section above. For this Pi enrollment, the connected Worker advanced from
  epoch 1 to epoch 2 after a real LaunchAgent restart. After the successful
  run, revocation returned 200; a further LaunchAgent restart reported
  `state: revoked` and `the Worker enrollment was refused`. The epoch-2 receipt
  remained readable with `authorityCurrent: false`, and the completed run,
  released lease, Pi session slot, and Project workspace binding remained
  inspectable. The test LaunchAgent was uninstalled after the refusal check.

## Original #121 partial-journey record (verbatim from `fe630e44`)

This is a **partial** production-path record, not a claim that an Agent ran. The
observed Engine readiness was `unknown`, so admission refused the intentional
task. No fixture Worker, scripted Worker, hidden model turn, or substituted
readiness fact was used. Identifiers below are synthetic labels for the live
records, not secrets or host identity.

### Setup and enrollment

- Host: macOS 26.6.2, Node 26.9.0, npm 11.19.1; Worker protocol `3`.
  Installed engines reported Codex `0.156.0` and Pi `0.87.1`. The pinned
  non-inference probe contracts are Codex `0.154.0` and Pi `0.86.1`.
- Built the production Web (`npm run web:build`), then started `npm start` with
  `SPROUT_ENV_SOURCE=enrollment`, an isolated empty SQLite database,
  `SPROUT_PORT=<allocated-port>`, and a host-only Operator credential. The
  startup report said `enrollment catalog (no enrolled instances)`. No runtime
  JSON was supplied or edited, and Sprout stayed running during enrollment,
  grant, probe, and the attempted run.
- Authenticated to the production Web boundary using `POST /api/auth/session`;
  the issued HttpOnly session cookie and CSRF proof were used for subsequent
  Human-command HTTP requests. `GET /api/environments/enrollments` returned
  zero. `POST /api/environments/enrollments` created one macOS pending record
  with `agent-run` requested; the Web bootstrap command resolved to
  `sprout worker enroll <loopback>:<allocated-port> <enrollment-id>` and its
  separate, one-use secret was returned only at creation. Neither secret nor
  cookie is in this record. The secret was kept owner-only outside the checkout
  and piped to CLI stdin, never placed in argv.
- `cat <private-claim-file> | SPROUT_WORKER_HOME=<private-state-dir> node bin/sprout worker enroll <loopback>:<allocated-port> <enrollment-id>`
  reported `Identity proven. Waiting for Human approval` (documented exit 5).
  The one-use claim was consumed; host-local identity and config were
  owner-only (`0600`). Web recorded `identity-claimed`, a digest rather than
  a public/private key, and a still-pending enrollment.
- `POST /api/environments/enrollments/<id>/approve` explicitly granted
  `agent-run: true` after claim. The durable `approved` decision remained in
  history. `sprout worker install-service` installed and loaded a signed-in-user
  LaunchAgent; its real outbound connection was accepted at epoch 1. A CLI
  defect initially prevented re-exec (`new Promise<number>` in a `.js` file);
  removing the TypeScript generic allowed the real service to start. A second
  CLI defect exposed by this journey was that its foreground Worker omitted
  the production non-inference readiness probe. Wiring the existing Worker
  probe into this entry point produced a real, committed readiness receipt after
  a LaunchAgent restart (no simulated facts).

### Observed readiness, workspace, and refusal

- The Web readiness route returned macOS, approved `agent-run`, online
  connection, compatible protocol `3`, work safety `clear`, Codex/Pi engine
  versions and probe provenance, and a Worker-produced non-inference probe
  (`source: worker`, `protocolOk: true`). An explicit authenticated
  `POST /api/environments/enrollments/<id>/probes` returned 201 with a committed
  receipt. Both engine readiness values remained `unknown`, not ready: installed
  versions do not match the pinned authentication probes; account model
  entitlement is independently `unknown` even with a pinned version.
- A production Project was created, granted this enrolled instance with a
  default workspace selection through `POST /api/projects/<project>/access`,
  and returned 201 with a Worker-validated durable binding and workspace ID.
  The Project, Agent, membership, and binding were created through the
  authenticated production API, not a runtime JSON edit. The binding survived
  revocation. Workspace preparation **for a run** was not reached.
- A real Codex Agent option configured `gpt-5.2-codex` and the Operator
  submitted an intentional file-writing prompt via `POST /api/runs`. The run
  settled `failed`, with zero events and the exact product failure
  `no available environment for capability: agent-run`. The Agent's
  compatibility endpoint separately explained:
  `Engine "codex" readiness is unknown on this Environment.` This is correct
  strict admission, not permission to bypass ADR-0013 by inferring a probe
  turn. The run has no acquired lease, session slot, Worker execution epoch,
  usage, result from an engine, or prepared run workspace: **none may be
  attributed to it**. The Project access binding is not a run binding.

### Restart, revocation, and limits

- A real `launchctl kickstart -k gui/<uid>/<service-label>` restarted the
  LaunchAgent. Same-key reconnect produced a new epoch (5 then 6 in the
  captured restart), a new Worker readiness observation, and no Sprout
  restart. `GET /api/environments/enrollments/<id>/receipts/<old-observation>`
  still returned historical epoch-5 evidence but marked
  `authorityCurrent: false`. There was no uncertain work or journal turn to
  reconcile, so no claim of journal-based recovery or non-replay is made.
- A separate `sprout worker start` while the service was active returned 0 and
  established another epoch instead of refusing a duplicate; `worker status`
  had reported `stopped` despite a running LaunchAgent process and a live
  connection. This is an **additional live process-ownership/status defect**,
  not a successful duplicate-connection-fence proof. Older observations were
  non-authoritative, but an attempted stale fact submission was not exercised.
- `POST /api/environments/enrollments/<id>/revoke` returned revoked. A later
  service kickstart did not restore online authority; the CLI reported
  `state: revoked` and `the Worker enrollment was refused`. The historical
  readiness receipt remained readable with `authorityCurrent: false`, the
  Project access/binding remained listed, and the failed run remained
  inspectable. There was no lease or engine session to preserve. The test
  LaunchAgent was uninstalled after the revocation check.
- Browser UI review could not be completed: the local browser required a
  human remote-debugging consent. All recorded Web commands used the actual
  authenticated production HTTP surface and CSRF boundary; they are **not**
  evidence that the desktop/phone approval ceremony was visually reviewed.
  Owner phone/desktop review is outstanding.

### Verification and blocker question

- `npm test -- src/worker/cli/worker-cli.macos.test.ts src/worker/readiness.test.ts`:
  23 passed, 0 failed. `npm test` (180-second alarm): 1,406 passed, 0 failed.
  `npm run typecheck`: pass. `npm run web:build`: pass (chunk-size warning).
- The CLI entry-point re-exec regression is asserted in the macOS CLI test;
  the live Worker probe and receipt above exercised the production CLI rather
  than a test fixture. See `bin/sprout` and `src/worker/cli/worker-cli.ts`.
- Human question: **What accepted non-inference account-entitlement evidence
  source, or explicit product decision, should permit admission for the real
  configured Codex model without treating `unknown` as ready?** The installed
  CLI versions also need a separately verified, pinned probe contract (or
  access to the currently pinned versions). Separately investigate the
  live LaunchAgent duplicate-start/status ownership defect before claiming
  duplicate fencing.
