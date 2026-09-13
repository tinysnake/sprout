#!/usr/bin/env bash
# Probe the Windows environment transport before any carrier code is written.
#
# Usage: scripts/probe-windows-ssh.sh user@windows-host [port]
#
# Verifies, in order, each invariant the Windows carrier depends on. Every probe
# prints its evidence; a failure names the next action, not just the symptom.
# Run from the Sprout repo on macOS. Requires: ssh, sftp, node (local).
set -uo pipefail

TARGET="${1:?usage: probe-windows-ssh.sh user@windows-host [port]}"
FWD_PORT="${2:-12731}"
REMOTE_DIR='C:/sprout-probe'
pass=0; fail=0

ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
head() { printf '\n== %s ==\n' "$1"; }

head "Probe 1: SSH connectivity and default shell"
shell_info=$(ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=accept-new -T "$TARGET" '$PSVersionTable.PSVersion.ToString(); [System.Environment]::OSVersion.VersionString' 2>&1 | tr -d '\r')
if [ $? -eq 0 ] && [ -n "$shell_info" ]; then
  ok "ssh reachable; remote reports: $(echo "$shell_info" | tr '\n' ' ')"
  echo "$shell_info" | grep -q '^7\.' && ok "default shell is PowerShell 7" \
    || bad "default shell is not PowerShell 7 — set HKLM:\SOFTWARE\OpenSSH\DefaultShell to pwsh.exe (docs/research/windows-ssh.md §4)"
else
  bad "ssh failed: $shell_info"
  bad "check: server running, key authorized (Administrators group needs C:\ProgramData\ssh\administrators_authorized_keys with strict ACLs)"
  exit 1
fi

head "Probe 2: sftp file deployment"
tmpf=$(mktemp); printf 'sprout-probe %s\n' "$(date -u +%FT%TZ)" > "$tmpf"
if sftp -o BatchMode=yes "$TARGET" >/dev/null 2>&1 <<SFTP
put "$tmpf" $REMOTE_DIR/probe.txt
SFTP
then
  back=$(ssh -T "$TARGET" "Get-Content $REMOTE_DIR/probe.txt" 2>&1 | tr -d '\r')
  grep -q 'sprout-probe' <<< "$back" && ok "sftp put + read-back round-trip" || bad "file landed but content differs: $back"
else
  bad "sftp put failed — create the directory on the Windows host first: mkdir $REMOTE_DIR"
fi
rm -f "$tmpf"

head "Probe 3: node exists on the Windows host"
node_ver=$(ssh -T "$TARGET" 'node --version' 2>&1 | tr -d '\r')
[[ "$node_ver" =~ ^v[0-9]+ ]] && ok "node $node_ver on PATH" \
  || bad "node not on the SSH session's PATH: '$node_ver' — the daemon will need its absolute path or a machine-level PATH entry"

head "Probe 4: byte-clean round-trip through sshd (non-PTY)"
payload='{"jsonrpc":"2.0","id":7,"params":{"text":"芽 🚀 λ — 100%"}}'
echo "$payload" | ssh -T "$TARGET" 'node -e "process.stdin.setEncoding(\"utf8\");process.stdin.on(\"data\",d=>process.stdout.write(d))"' > /tmp/probe-rt.txt 2>/dev/null
if cmp -s <(echo "$payload") /tmp/probe-rt.txt; then
  ok "bytes identical both directions (UTF-8, no CRLF injection, no VT escapes)"
else
  bad "stream corrupted:"; diff <(echo "$payload") /tmp/probe-rt.txt | head -4 | sed 's/^/       /'
fi

head "Probe 5: loopback endpoint reachable through an SSH forward"
# Simulates the M1 shape: a daemon bound to the Windows loopback, reached via ssh -L.
ssh -T "$TARGET" "node -e \"const l=require('net').createServer(s=>{s.on('data',d=>s.write(d))});l.listen($FWD_PORT,'127.0.0.1',()=>console.log('up'))\" > $REMOTE_DIR/probe-echo.log 2>&1 & sleep 2; Get-Content $REMOTE_DIR/probe-echo.log" > /tmp/probe-listen.txt 2>&1
grep -q 'up' /tmp/probe-listen.txt || { bad "could not start loopback echo server on the Windows host: $(cat /tmp/probe-listen.txt)"; echo; exit 1; }
ssh -f -N -L "$FWD_PORT:127.0.0.1:$FWD_PORT" -o ExitOnForwardFailure=yes "$TARGET"
fwd_pid=$!
sleep 2
resp=$(echo "sprout-tunnel-ok" | timeout 10 node -e "
const net = require('net');
const c = net.connect($FWD_PORT, '127.0.0.1', () => {});
let buf='';
c.on('data', d => { buf += d; c.end(); });
c.on('error', e => { console.error(e.message); process.exit(1); });
c.on('close', () => { process.stdout.write(buf); });
" 2>&1)
kill "$fwd_pid" 2>/dev/null
grep -q 'sprout-tunnel-ok' <<< "$resp" && ok "loopback endpoint reachable through ssh -L (byte round-trip)" \
  || bad "tunnel round-trip failed: '$resp'"
ssh -T "$TARGET" "Get-Process node -ErrorAction SilentlyContinue | Where-Object {(Get-CimInstance Win32_Process -Filter \"ProcessId=\$(\$_.Id)\").CommandLine -like '*$FWD_PORT*'} | Stop-Process -Force" >/dev/null 2>&1

head "Probe 6: no published port on the Windows LAN interface"
bound=$(ssh -T "$TARGET" "Get-NetTCPConnection -LocalPort $FWD_PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalAddress" 2>/dev/null | tr -d '\r' | sort -u | paste -sd, -)
if [ -z "$bound" ]; then
  ok "nothing listening (echo server already stopped — lifecycle cleanup works)"
elif [ "$bound" = "127.0.0.1" ]; then
  ok "bound to loopback only"
else
  bad "listener bound to non-loopback address: $bound — the daemon MUST bind 127.0.0.1 (ADR-0003, no published ports)"
fi

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32mAll %d probes passed.\033[0m The transport invariants hold; carrier code may proceed.\n' "$pass"
else
  printf '\033[31m%d passed, %d failed.\033[0m Fix the failures above and re-run before writing carrier code.\n' "$pass" "$fail"
  exit 1
fi
