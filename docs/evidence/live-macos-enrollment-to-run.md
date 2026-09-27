# Live macOS enrollment-to-run evidence

The enrollment-to-run journey is tracked in #121. The following is a separate
verification of the #137 E7 duplicate-start/status fixup, after the LaunchAgent
was active. It records the sanitized live observations from the #137 Work record;
this is not a fresh replay of the #121 journey.

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
