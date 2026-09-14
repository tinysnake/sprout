#!/usr/bin/env bash
# Deploy and run the Sprout worker on a Windows host over SSH.
#
# Usage: scripts/deploy-windows.sh user@windows-host [command]
#   commands: deploy | start | stop | status | health | restart (default: deploy)
#
# What it does, in the shape the transport probe verified end to end:
#   deploy  — sftp the worker source to the host
#   start   — start the worker daemon detached via WMI (it must outlive the
#             SSH session; a PowerShell background job dies with the session)
#   health  — probe the daemon's loopback endpoint through an SSH forward
#   stop    — stop the daemon over SSH
#
# SSH is the provisioning and debugging channel only. The runtime path is the
# core connecting through an SSH local forward to the daemon's loopback endpoint
# (ADR-0003: every environment is a network environment; no published port).
#
# Learned the hard way, encoded here (see the probe for the full stories):
# - sftp needs /C:/... for absolute Windows paths; PowerShell wants C:/...
# - sftp commands go through a batch file (-b), never a piped heredoc
# - remote scripts deploy as files; inline `node -e` does not survive PowerShell
#   argument mangling
set -uo pipefail

TARGET="${1:?usage: deploy-windows.sh user@windows-host [deploy|start|stop|status|health|restart]}"
COMMAND="${2:-deploy}"
# Where the worker lives on the Windows host (POSIX-style for PowerShell).
REMOTE_WIN='C:/sprout-daemon'
# sftp's absolute form for the same directory.
SFTP_ROOT='/C:/sprout-daemon'
# Local port for the health-check forward.
HEALTH_PORT="${SPROUT_HEALTH_PORT:-12740}"
# Files the worker needs. Worker source is deployed as plain source files: the
# daemon runs the same code the core ships, so a skew is a deploy problem.
WORKER_FILES=(
  src/worker/main.ts
  src/worker/server.ts
  src/worker/protocol.ts
  src/worker/supervisor.ts
  src/worker/carrier.ts
  src/worker/client.ts
  src/worker/jsonrpc.ts
  src/worker/container-carrier.ts
  src/engine/port.ts
  src/engine/event-queue.ts
  src/engine/jsonrpc.ts
  src/engine/codex.ts
  src/engine/codex-protocol.ts
  src/engine/pi.ts
  src/engine/pi-protocol.ts
  src/engine/agy.ts
  src/engine/agy-protocol.ts
  src/engine/opencode.ts
  src/engine/opencode-protocol.ts
  src/engine/scripted.ts
  src/ids.ts
  package.json
)

ok()  { printf '  \033[32mOK\033[0m  %s\n' "$1"; }
bad() { printf '  \033[31mERR\033[0m %s\n' "$1"; }

remote() { ssh -o BatchMode=yes -o ServerAliveInterval=30 -T "$TARGET" "$@"; }

# Deploy one local file to the remote directory.
deploy_file() {
  local src="$1" dest="$2"
  local batch
  batch=$(mktemp)
  printf 'put %s %s\n' "$src" "$dest" > "$batch"
  sftp -o BatchMode=yes -b "$batch" "$TARGET" >/dev/null 2>&1
  local status=$?
  rm -f "$batch"
  return $status
}

remote_dir() {
  remote "New-Item -ItemType Directory -Force -Path $REMOTE_WIN | Out-Null" >/dev/null 2>&1
}

cmd_deploy() {
  echo "== deploying worker source to $TARGET:$REMOTE_WIN =="
  remote_dir || { bad "could not create $REMOTE_WIN"; return 1; }

  # Mirror the repo's src/ layout on the remote so relative imports resolve.
  local dirs=('src/worker' 'src/engine')
  local failed=0
  for dir in "${dirs[@]}"; do
    local win_dir="$REMOTE_WIN/$dir"
    local sftp_dir="$SFTP_ROOT/$dir"
    remote "New-Item -ItemType Directory -Force -Path $win_dir | Out-Null" >/dev/null 2>&1
    for file in "$dir"/*.ts; do
      local base
      base=$(basename "$file")
      if deploy_file "$file" "$sftp_dir/$base"; then
        ok "$file"
      else
        bad "$file"
        failed=1
      fi
    done
  done

  if [ $failed -eq 0 ]; then
    ok "all worker files deployed"
  else
    bad "some files failed to deploy"
  fi
  return $failed
}

cmd_start() {
  echo "== starting daemon on $TARGET =="
  remote_dir || { bad "could not create $REMOTE_WIN"; return 1; }
  # Deploy first: a stale daemon is a deploy problem, not a silent skew.
  cmd_deploy >/dev/null || { bad "deploy failed; not starting"; return 1; }

  # WMI start, detached: parented to WmiPrvSE, outside the SSH session's Job
  # Object, so it survives the session (verified by the transport probe).
  # Bind 127.0.0.1 only — the published-port boundary ADR-0003 relies on.
  # The daemon has no console, so its readiness address AND its stderr go to
  # files the provisioning channel can read. The launch itself is a .cmd file
  # deployed over sftp: inline cmd.exe /c set ... arguments do not survive
  # PowerShell mangling (same lesson as node -e in the transport probe).
  local launcher; launcher=$(mktemp -t sprout-daemon-cmd)
  {
    printf '@echo off\r\n'
    printf 'set SPROUT_READY_FILE=%s\\worker-ready.json\r\n' "$REMOTE_WIN"
    printf 'set SPROUT_ENV_INSTANCE=%s\r\n' "${SPROUT_WINDOWS_INSTANCE:-windows-dev}"
    [ -n "${SPROUT_WINDOWS_CODEX_HOME:-}" ] && printf 'set CODEX_HOME=%s\r\n' "$SPROUT_WINDOWS_CODEX_HOME"
    printf 'node %s/src/worker/main.ts > %s/daemon-out.txt 2> %s/daemon-err.txt\r\n' "$REMOTE_WIN" "$REMOTE_WIN" "$REMOTE_WIN"
  } > "$launcher"
  deploy_file "$launcher" "$SFTP_ROOT/start-daemon.cmd" || { bad "could not deploy the launcher"; return 1; }
  remote "Remove-Item $REMOTE_WIN/worker-ready.json -ErrorAction SilentlyContinue" >/dev/null 2>&1
  # The scheduled task is the primary launch path: it also provides boot
  # autostart and restart-on-failure, and `start` through it keeps one launch
  # story. WMI is the fallback when the task has not been installed.
  if remote "if (Get-ScheduledTask -TaskName 'SproutWorkerDaemon' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >/dev/null 2>&1; then
    remote "Start-ScheduledTask -TaskName 'SproutWorkerDaemon'" >/dev/null 2>&1
  else
    remote "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='$REMOTE_WIN/start-daemon.cmd'} | Out-Null" >/dev/null 2>&1
  fi
  sleep 3
  if remote "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*sprout-daemon*main.ts*' }).ProcessId" 2>/dev/null | LC_ALL=C grep -qE '[0-9]'; then
    ok "daemon started"
    cmd_status
  else
    bad "daemon did not start — check the Windows host manually"
    return 1
  fi
}

cmd_stop() {
  echo "== stopping daemon on $TARGET =="
  remote "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*sprout-daemon*main.ts*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" >/dev/null 2>&1
  sleep 1
  if remote "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*sprout-daemon*main.ts*' }).ProcessId" 2>/dev/null | LC_ALL=C grep -qE '[0-9]'; then
    bad "daemon still running after Stop-Process"
    return 1
  fi
  ok "daemon stopped"
}

cmd_status() {
  echo "== daemon status on $TARGET =="
  local pid
  pid=$(remote "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*sprout-daemon*main.ts*' }).ProcessId" 2>/dev/null | LC_ALL=C tr -d '\r' | LC_ALL=C grep -E '^[0-9]+$' | head -1)
  if [ -n "$pid" ]; then
    ok "daemon running (pid $pid)"
  else
    bad "daemon not running"
    return 1
  fi
}

cmd_health() {
  echo "== health check: daemon endpoint through an SSH forward =="
  # Find the port the daemon bound (it prints SPROUT_WORKER_READY ... on stdout,
  # but a detached WMI process has no console; the worker writes its port to a
  # file instead — see cmd_start's daemon launch arguments).
  local ready_file="$REMOTE_WIN/worker-ready.json"
  local ready_json
  ready_json=$(remote "Get-Content $ready_file -ErrorAction SilentlyContinue" 2>/dev/null | LC_ALL=C tr -d '\r')
  if [ -z "$ready_json" ]; then
    bad "no readiness file at $ready_file — is the daemon running? (try: $0 $TARGET start)"
    return 1
  fi
  local port
  port=$(printf '%s' "$ready_json" | node -e "
let raw=''; process.stdin.on('data', d => raw += d);
process.stdin.on('end', () => {
  const m = raw.match(/\\{[\\s\\S]*\\}/);
  if (!m) { process.exit(1); }
  try { process.stdout.write(String(JSON.parse(m[0]).port)); } catch { process.exit(1); }
});
")
  if [ -z "$port" ]; then
    bad "could not read a port from $ready_file: '$ready_json'"
    return 1
  fi

  # Forward and probe. The handshake (worker/info) is the real health check.
  ssh -N -L "$HEALTH_PORT:127.0.0.1:$port" -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 "$TARGET" &
  local fwd_pid=$!
  sleep 2
  local info
  info=$(node -e "
const net = require('net');
const socket = net.connect($HEALTH_PORT, '127.0.0.1');
socket.setTimeout(8000, () => { console.error('timeout'); socket.destroy(); process.exit(1); });
let buffer = '';
socket.on('connect', () => {
  socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'worker/info', params: {} }) + '\n');
});
socket.on('data', (chunk) => {
  buffer += chunk.toString();
  if (buffer.includes('\n')) { process.stdout.write(buffer); process.exit(0); }
});
socket.on('error', (e) => { console.error(e.message); process.exit(1); });
" 2>&1)
  kill "$fwd_pid" 2>/dev/null

  if printf '%s' "$info" | LC_ALL=C grep -q '"result"'; then
    ok "worker/info handshake over the tunnel: $info"
  else
    bad "handshake failed: $info"
    return 1
  fi
}

cmd_restart() {
  cmd_stop || true
  cmd_start
}

# Install (or refresh) the scheduled task that starts the daemon at logon and
# restarts it on failure. Idempotent: -Force overwrites.
cmd_install_autostart() {
  local script; script=$(mktemp -t sprout-autostart-ps1)
  cat > "$script" <<'PS1'
$action = New-ScheduledTaskAction -Execute 'C:\sprout-daemon\start-daemon.cmd' -WorkingDirectory 'C:\sprout-daemon'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'SproutWorkerDaemon' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Output "registered: SproutWorkerDaemon (at logon for $env:USERNAME, restart x3)"
PS1
  deploy_file "$script" "$SFTP_ROOT/install-autostart.ps1" || { bad "could not deploy the autostart installer"; return 1; }
  local out
  out=$(remote "powershell -NoProfile -ExecutionPolicy Bypass -File $REMOTE_WIN/install-autostart.ps1" 2>&1 | LC_ALL=C tr -d '\r')
  if echo "$out" | LC_ALL=C grep -q 'registered'; then
    ok "$out"
  else
    bad "autostart registration failed: $out"
    return 1
  fi
}

case "$COMMAND" in
  deploy)  cmd_deploy ;;
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  health)  cmd_health ;;
  restart) cmd_restart ;;
  install-autostart) cmd_install_autostart ;;
  *) bad "unknown command: $COMMAND (use deploy|start|stop|status|health|restart|install-autostart)"; exit 2 ;;
esac
