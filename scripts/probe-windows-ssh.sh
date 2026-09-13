#!/usr/bin/env bash
# Probe the Windows environment transport before any carrier code is written.
#
# Usage: scripts/probe-windows-ssh.sh user@windows-host [port]
#
# Verifies, in order, each invariant the Windows carrier depends on. Every probe
# prints its evidence; a failure names the next action, not just the symptom.
# Run from the Sprout repo on macOS. Requires: ssh, sftp (local node not needed:
# the probe scripts run on the remote host).
#
# Design notes, each earned by a live failure against the real host:
# - Remote scripts are deployed as real files over sftp and executed, never
#   passed inline: inline `node -e` does not survive PowerShell's argument
#   mangling (Win32-OpenSSH issue #1082). Deploying files is what the real
#   carrier does anyway.
# - sftp reads commands from a batch file (-b). A heredoc piped into sftp's
#   stdin is NOT reliable inside command substitution, and put-lines have ended
#   up executed by bash itself (`put: command not found`).
# - The daemon stand-in starts detached via WMI Win32_Process: PowerShell
#   background jobs die with the SSH session (Windows Job Object semantics),
#   which is exactly the property the real daemon must escape.
set -uo pipefail

TARGET="${1:?usage: probe-windows-ssh.sh user@windows-host [port]}"
FWD_PORT="${2:-12731}"
REMOTE_WIN='C:\sprout-probe'
# Path forms differ per tool and this cost a live run to learn:
# - sftp treats `C:/...` as RELATIVE (it becomes /C:/Users/<user>/C:/...); its
#   absolute form needs a leading slash: /C:/sprout-probe
# - PowerShell rejects /C:/... outright; it wants C:\sprout-probe or C:/...
# Deployments therefore use SFTP_FWD; remote shell commands use PS_FWD.
SFTP_FWD='/C:/sprout-probe'
PS_FWD='C:/sprout-probe'
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
pass=0; fail=0

ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
head() { printf '\n== %s ==\n' "$1"; }
remote() { ssh -o BatchMode=yes -o ServerAliveInterval=30 -T "$TARGET" "$@"; }

# Deploy one local file to the remote host. sftp -b takes a batch file; the
# destination path must use forward slashes.
deploy_file() {
  local src="$1" dest="$2"
  local batch="$WORK/sftp-batch.txt"
  printf 'put %s %s\n' "$src" "$dest" > "$batch"
  sftp -o BatchMode=yes -b "$batch" "$TARGET" >/dev/null 2>&1
}

# ---------------------------------------------------------------- probe files

cat > "$WORK/stdin-echo.js" <<'EOF'
// Byte-for-byte stdin-to-stdout pipe. No encoding layer, no newline fixing:
// whatever arrives must come back identical.
process.stdin.pipe(process.stdout);
EOF

cat > "$WORK/echo-server.js" <<'EOF'
// A stand-in for the Sprout worker daemon: bound to the Windows loopback only.
const net = require('net');
net.createServer((socket) => socket.pipe(socket))
  .listen(Number(process.argv[2]), '127.0.0.1');
EOF

head "Probe 1: SSH connectivity and default shell"
shell_info=$(remote '$PSVersionTable.PSVersion.ToString(); [System.Environment]::OSVersion.VersionString' 2>&1 | LC_ALL=C tr -d '\r')
ssh_status=${PIPESTATUS[0]}
if [ "$ssh_status" -ne 0 ]; then
  bad "ssh failed (exit $ssh_status): $shell_info"
  bad "check: server running, key authorized (Administrators group needs C:\\ProgramData\\ssh\\administrators_authorized_keys with strict ACLs)"
  exit 1
fi
if echo "$shell_info" | LC_ALL=C grep -qE 'PSReadLine|profile\.ps1'; then
  bad "ssh works, but the remote PowerShell profile errors in non-interactive sessions and pollutes every channel:"
  echo "$shell_info" | head -4 | sed 's/^/       /'
  bad "fix on the Windows host: wrap the PSReadLine lines in Microsoft.PowerShell_profile.ps1 in: if ([Environment]::UserInteractive) { ... }"
  echo
  exit 1
fi
ok "ssh reachable; remote reports: $(echo "$shell_info" | tr '\n' ' ')"
echo "$shell_info" | LC_ALL=C grep -q '^7\.' && ok "default shell is PowerShell 7" \
  || bad "default shell is not PowerShell 7 — set HKLM:\\SOFTWARE\\OpenSSH\\DefaultShell to pwsh.exe (docs/research/windows-ssh.md §4)"

head "Probe 2: sftp deployment (directory creation + put + read-back)"
remote "New-Item -ItemType Directory -Force -Path $REMOTE_WIN | Out-Null" >/dev/null 2>&1
printf 'sprout-probe %s\n' "$(date -u +%FT%TZ)" > "$WORK/probe.txt"
if deploy_file "$WORK/probe.txt" "$SFTP_FWD/probe.txt"; then
  back=$(remote "Get-Content $PS_FWD/probe.txt" 2>/dev/null | LC_ALL=C tr -d '\r')
  grep -q 'sprout-probe' <<< "$back" && ok "file deployed and read back intact" \
    || bad "file landed but content differs: '$back'"
else
  bad "sftp put failed — check the Windows host has OpenSSH's sftp server subsystem enabled"
fi

head "Probe 3: node on the remote PATH"
node_ver=$(remote 'node --version' 2>/dev/null | LC_ALL=C tr -d '\r')
[[ "$node_ver" =~ ^v[0-9]+ ]] && ok "node $node_ver on PATH" \
  || bad "node not on the SSH session's PATH: '$node_ver' — the daemon will need its absolute path or a machine-level PATH entry"

head "Probe 4: byte-clean round-trip through sshd (non-PTY)"
printf '{"jsonrpc":"2.0","id":7,"params":{"text":"芽 🚀 λ — 100%%"}}' > "$WORK/payload.bin"
if deploy_file "$WORK/stdin-echo.js" "$SFTP_FWD/stdin-echo.js"; then
  remote "node $PS_FWD/stdin-echo.js" < "$WORK/payload.bin" > "$WORK/resp.bin" 2>/dev/null
  if cmp -s "$WORK/payload.bin" "$WORK/resp.bin"; then
    ok "bytes identical both directions (UTF-8, no CRLF injection, no VT escapes)"
  else
    bad "stream corrupted:"; diff "$WORK/payload.bin" "$WORK/resp.bin" | head -4 | sed 's/^/       /'
  fi
else
  bad "could not deploy stdin-echo.js — Probe 2 must pass first"
fi

head "Probe 5: loopback daemon reachable through an SSH forward"
if ! deploy_file "$WORK/echo-server.js" "$SFTP_FWD/echo-server.js"; then
  bad "could not deploy echo-server.js — Probe 2 must pass first"
  echo; exit 1
fi
# Start detached via WMI: the process is parented to WmiPrvSE, outside the SSH
# session's Job Object, so it survives the session — the property the real
# daemon depends on. (PowerShell `&` creates a session-bound job that dies with
# the session; this was verified live in an earlier probe run.)
remote "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='node $PS_FWD/echo-server.js $FWD_PORT'} | Out-Null" >/dev/null 2>&1
sleep 2
bound=$(remote "(Get-NetTCPConnection -LocalPort $FWD_PORT -State Listen -ErrorAction SilentlyContinue).LocalAddress" 2>/dev/null | LC_ALL=C tr -d '\r' | sort -u | paste -sd, -)
if [ -z "$bound" ]; then
  bad "nothing listening on $FWD_PORT on the Windows host — echo-server.js did not start"
  echo; exit 1
fi
ssh -N -L "$FWD_PORT:127.0.0.1:$FWD_PORT" -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 "$TARGET" &
fwd_pid=$!
sleep 1
printf 'sprout-tunnel-ok' > "$WORK/tunnel-payload.bin"
# Timeout lives inside the node client below; macOS's non-interactive PATH has
# no GNU timeout, and this cost a live run to learn.
node -e "
const net = require('net');
const fs = require('fs');
const payload = fs.readFileSync(process.argv[1]);
const c = net.connect($FWD_PORT, '127.0.0.1', () => c.write(payload));
let buf = Buffer.alloc(0);
c.setTimeout(8000, () => { c.destroy(); process.exit(1); });
c.on('data', d => { buf = Buffer.concat([buf, d]); if (buf.length >= payload.length) c.end(); });
c.on('error', () => process.exit(1));
c.on('close', () => process.stdout.write(buf));
" "$WORK/tunnel-payload.bin" > "$WORK/tunnel-resp.bin" 2>/dev/null
kill "$fwd_pid" 2>/dev/null
if cmp -s "$WORK/tunnel-payload.bin" "$WORK/tunnel-resp.bin"; then
  ok "loopback daemon reachable through ssh -L, byte round-trip intact"
else
  bad "tunnel round-trip failed (empty or corrupted response)"
fi

head "Probe 6: bound to loopback only, and cleaned up on request"
if [ "$bound" = "127.0.0.1" ]; then
  ok "daemon bound to 127.0.0.1 only (no published port, per ADR-0003)"
else
  bad "daemon bound to non-loopback address: $bound — it MUST bind 127.0.0.1"
fi
remote "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*echo-server.js*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" >/dev/null 2>&1
sleep 1
still=$(remote "(Get-NetTCPConnection -LocalPort $FWD_PORT -State Listen -ErrorAction SilentlyContinue).LocalAddress" 2>/dev/null | LC_ALL=C tr -d '\r')
if [ -z "$still" ]; then
  ok "daemon stopped cleanly via SSH (provisioning channel works for lifecycle)"
else
  bad "echo server still listening after Stop-Process — check manually: Get-Process node"
fi

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32mAll %d probes passed.\033[0m The transport invariants hold; carrier code may proceed.\n' "$pass"
else
  printf '\033[31m%d passed, %d failed.\033[0m Fix the failures above and re-run before writing carrier code.\n' "$pass" "$fail"
  exit 1
fi
