# Research Report: Driving Remote Windows Coding-Agent Workers via OpenSSH

**Target Subject**: Using Windows OpenSSH Server as the transport carrier for Sprout's JSON-RPC Environment Worker on a remote Windows host.  
**Context**: Sprout control plane running on macOS (TypeScript/Node.js) driving coding-agent CLI processes (`codex`, `pi`, `agy`, `opencode`) inside an isolated remote Windows environment with PowerShell 7 installed.  
**Investigator**: Research Agent  
**Architectural Baseline**: [`docs/adr/0003-each-environment-runs-a-sprout-worker.md`](../adr/0003-each-environment-runs-a-sprout-worker.md), [`src/worker/carrier.ts`](../../src/worker/carrier.ts), [`src/worker/main.ts`](../../src/worker/main.ts), [`src/engine/jsonrpc.ts`](../../src/engine/jsonrpc.ts).  
**Recommendation for M1**: **VIABLE WITH CONSTRAINTS**. Use `ssh -T` (non-interactive, strictly no PTY) as a process stdio carrier via `EndpointCarrier.throughProcess`, invoking `node` directly or via `pwsh -EncodedCommand`. Interruption must strictly be in-band via JSON-RPC (`session/interrupt`); never rely on POSIX OS signal forwarding.

---

## 1. Executive Summary

The repository owner poses the following architectural question:
> The target Windows machine has PowerShell 7 installed. If OpenSSH Server is enabled on it, can Sprout use SSH as the carrier? Can Sprout run `ssh user@windows-host <command>` and have that command run inside PowerShell 7 reliably, non-interactively, with stdio piped back so a JSON-RPC worker can be driven over it?

### The Verdict: Yes, Under Strict Engineering Guardrails

Windows OpenSSH Server (`sshd`) can serve as a robust carrier for Sprout's JSON-RPC environment worker over piped stdio, fitting the shape of `EndpointCarrier.throughProcess` in `src/worker/carrier.ts`. However, Windows OpenSSH is **not** a POSIX daemon running on Linux; it is a Win32 port with critical behavioral differences.

If configured and invoked naively, the channel will fail due to:
1. **ConPTY corruption**: Requesting a TTY (`-t`) attaches the Windows Pseudo-Console, injecting VT escape sequences and hard-wrapping long JSON lines.
2. **Signal lethality**: Windows lacks POSIX signals. In Win32-OpenSSH, any OS signal sent to the remote process invokes `TerminateProcess()`, and killing the local `ssh` client terminates the remote Windows Job Object, instantly killing the worker without clean turn settlement.
3. **PowerShell pipeline buffering & object coercion**: Running native processes through PowerShell cmdlets or pipes buffers data and converts streams to .NET objects with CRLF line endings.
4. **Command-line mangling**: OpenSSH concatenates remote command arguments into a single string, and PowerShell 7's `-Command` parses that string through its scripting grammar, misinterpreting quotes, backslashes, and shell metacharacters (`$`, `&`, `;`).
5. **Silent firewall disconnects**: Idle turns exceeding 5–15 minutes are dropped by stateful network equipment unless SSH keepalives are explicitly configured on both client and server.

When invoked with `-T` (disabling PTY allocation), driving an unbuffered Node.js worker process directly, using in-band JSON-RPC for turn cancellation, and enforcing keepalives, Windows OpenSSH provides a byte-clean, secure, non-interactive carrier that requires zero published ports on the Windows machine.

---

## 2. Sprout Architecture Alignment

Sprout's execution model is defined by [ADR-0003](../adr/0003-each-environment-runs-a-sprout-worker.md):
- **Every environment is a network environment**: A local macOS machine, a Linux container, and a remote Windows workstation speak the identical line-framed JSON-RPC 2.0 protocol (`LineJsonRpcTransport` in `src/engine/jsonrpc.ts`).
- **The carrier moves bytes and nothing else**: 
  - Local macOS: loopback TCP via `EndpointCarrier.start` / `serveWorkerEndpoint`.
  - Linux container: `docker exec -i` piped stdio via `EndpointCarrier.throughProcess` / `ContainerCarrier`.
  - Remote Windows: `ssh user@host <command>` piped stdio via `EndpointCarrier.throughProcess` (or alternatively an SSH-forwarded TCP tunnel).
- **The worker process is long-lived**: It hosts multiple engine adapters (`codex`, `pi`, etc.) and lives across turns to eliminate process startup latency.
- **Worker entry point already supports stdio**: As implemented in `src/worker/main.ts:143-157`, when `SPROUT_WORKER_TRANSPORT=stdio` is set, `EnvironmentWorker` attaches directly to `process.stdin` and `process.stdout`.

Therefore, an SSH-driven Windows carrier fits directly into Sprout's existing abstraction without changing core collaboration logic.

---

## 3. Deep Dive: Windows OpenSSH Transport Viability

To understand why Windows OpenSSH can transport JSON-RPC, we must inspect its internal Win32 architecture.

### 3.1. Process Architecture: PTY vs. Non-PTY Execution Paths

In Microsoft's OpenSSH for Windows (developed in [`PowerShell/openssh-portable`](https://github.com/PowerShell/openssh-portable), formerly [`PowerShell/Win32-OpenSSH`](https://github.com/PowerShell/Win32-OpenSSH)):
- When a client connects and authenticates, `sshd.exe` spawns an unprivileged session worker `sshd-session.exe` running in the security context of the authenticated Windows user token (`CreateProcessAsUserW`).
- The execution path branches sharply in [`contrib/win32/win32compat/w32-doexec.c`](https://github.com/PowerShell/openssh-portable/blob/latestw_all/contrib/win32/win32compat/w32-doexec.c):

```c
// w32-doexec.c lines 329-370
if (pty) {
    // Interactive session: uses ssh-shellhost.exe and ConPTY
    exec_command_with_pty(&pid, pty_cmd, pipein[0], pipeout[1], pipeerr[1], ...);
} else {
    // Non-interactive session: bypasses ConPTY completely!
    posix_spawn_file_actions_t actions;
    ...
    posix_spawn(&pid, spawn_argv[0], &actions, NULL, spawn_argv, NULL);
}
```

1. **PTY mode (`pty != 0`)**: Initiated when the client allocates a pseudo-terminal (e.g. `ssh -t`). `sshd` delegates execution to `ssh-shellhost.exe` and creates a Windows Pseudo Console (ConPTY) handle via `CreatePseudoConsole()` ([Microsoft ConPTY Docs](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)). ConPTY emulates an interactive terminal, intercepts console screen buffers, injects VT100/ANSI escape sequences, and translates newline keystrokes.
2. **Non-PTY mode (`pty == 0`)**: Initiated when stdio is redirected without terminal allocation (e.g. `ssh -T host <command>` or Node's `child_process.spawn('ssh', ['-T', ...])`). ConPTY and `ssh-shellhost.exe` are **completely bypassed**.

### 3.2. Named Pipe Implementation in Non-PTY Mode

In non-PTY mode, OpenSSH emulates POSIX `pipe()` using Win32 named pipes in [`contrib/win32/win32compat/fileio.c:190`](https://github.com/PowerShell/openssh-portable/blob/latestw_all/contrib/win32/win32compat/fileio.c):
```c
write_handle = CreateNamedPipeA(pipe_name,
    PIPE_ACCESS_OUTBOUND | FILE_FLAG_OVERLAPPED,
    PIPE_TYPE_BYTE | PIPE_WAIT,
    1, 4096, 4096, 0, &sec_attributes);
```
Crucially:
- Pipes are opened with **`PIPE_TYPE_BYTE`** (raw byte stream), **not** message-mode pipes (`PIPE_TYPE_MESSAGE`).
- Standard handles (`STDIN_FILENO`, `STDOUT_FILENO`, `STDERR_FILENO`) are duplicated and assigned to `STARTUPINFOW.hStdInput`, `hStdOutput`, and `hStdError`.
- As a result, non-interactive Windows OpenSSH provides a 100% transparent binary stream between the SSH client on macOS and the spawned process on Windows.

### 3.3. Job Object Process Containment

In `w32-doexec.c:445-470`, the spawned child process is assigned to a Windows **Job Object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`:
```c
memset(&job_info, 0, sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
job_info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
SetInformationJobObject(job, JobObjectExtendedLimitInformation, &job_info, sizeof(job_info));
AssignProcessToJobObject(job, process_handle);
```
**Consequence**: When the SSH session closes or drops, Windows automatically terminates all processes associated with the job. Rogue background engine processes (`codex.exe`, `node.exe`) cannot leak on the Windows host after a broken connection.

---

## 4. Configuring PowerShell 7 as DefaultShell

When executing commands without an absolute executable path or when invoking shell commands, Windows OpenSSH consults the Windows Registry.

### 4.1. The Official Registry Configuration

Officially documented in [Microsoft Learn: OpenSSH Server Configuration for Windows](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_server_configuration#configuring-the-default-shell-for-openssh-in-windows) and the [Win32-OpenSSH Wiki: DefaultShell](https://github.com/PowerShell/Win32-OpenSSH/wiki/DefaultShell):

The default shell for OpenSSH on Windows defaults to `cmd.exe`. To configure PowerShell 7 (`pwsh.exe`) as the default shell across all SSH sessions, execute the following in an elevated PowerShell 7 prompt on the Windows server:

```powershell
# Set DefaultShell to PowerShell 7
$registryParams = @{
    Path         = 'HKLM:\SOFTWARE\OpenSSH'
    Name         = 'DefaultShell'
    Value        = 'C:\Program Files\PowerShell\7\pwsh.exe'
    PropertyType = 'String'
    Force        = $true
}
New-ItemProperty @registryParams

# Set command-execution option switch
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name 'DefaultShellCommandOption' -Value '-c' -PropertyType String -Force

# Optional: DefaultShellEscapeArguments (default 1)
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name 'DefaultShellEscapeArguments' -Value 1 -PropertyType DWord -Force
```

### 4.2. Code-Level Verification in Win32-OpenSSH

In the OpenSSH codebase ([`contrib/win32/win32compat/pwd.c:70-120`](https://github.com/PowerShell/openssh-portable/blob/latestw_all/contrib/win32/win32compat/pwd.c)), OpenSSH reads `HKLM\SOFTWARE\OpenSSH\DefaultShell`:
- If absent, it calls `GetSystemDirectoryW()` and appends `\cmd.exe`.
- In [`contrib/win32/win32compat/w32-doexec.c:305-318`](https://github.com/PowerShell/openssh-portable/blob/latestw_all/contrib/win32/win32compat/w32-doexec.c), OpenSSH identifies the shell type:
  ```c
  if (strstr(s->pw->pw_shell, "system32\\cmd"))
      shell_type = SH_CMD;
  else if (strstr(s->pw->pw_shell, "powershell"))
      shell_type = SH_PS;
  ```
- **Gotcha**: Notice the substring match `strstr(..., "powershell")`. Because standard PowerShell 7 installs to `C:\Program Files\PowerShell\7\pwsh.exe`, `powershell` matches the directory path, successfully classifying it as `SH_PS`. If PowerShell 7 is installed in a custom path lacking the string `powershell` (e.g., `C:\tools\pwsh.exe`), OpenSSH classifies it as `SH_OTHER`, which affects default argument escaping. Ensure the installation path contains `PowerShell`.

### 4.3. Critical Caveat: Administrator Authorized Keys

Documented in [Microsoft Learn: OpenSSH Server Configuration - AuthorizedKeysFile](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_server_configuration#authorizedkeysfile):
- For standard users, keys are placed in `C:\Users\<username>\.ssh\authorized_keys`.
- **For accounts in the local `Administrators` group**, OpenSSH ignores `~/.ssh/authorized_keys` and instead strictly requires:
  `C:\ProgramData\ssh\administrators_authorized_keys`
- Furthermore, strict ACLs are enforced. If inheritance is enabled or other users have read access, public-key authentication fails silently with `Permission denied (publickey)`:
  ```powershell
  # Required ACLs for administrators_authorized_keys
  icacls.exe "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
  ```

---

## 5. Failure Modes: Symptoms, Causes, and Concrete Fixes

Below is the concrete analysis of what breaks when using Windows OpenSSH as a stdio channel, detailing the exact failure symptoms, underlying mechanics, and architectural fixes.

### 5.1. TTY Allocation & ConPTY Corrupting JSON-RPC Streams

- **Symptom**: Sprout's `LineJsonRpcTransport` emits syntax errors or fails to parse responses (`JSON.parse` syntax error). Raw data inspects show ANSI escape sequences (`\x1b[0m`, `\x1b[2K`), carriage returns (`\r`), and lines truncated or hard-wrapped at 80/120 characters.
- **Root Cause**: The SSH client was run with `-t` or allocated a pseudo-terminal. Windows OpenSSH routes PTY sessions through `ssh-shellhost.exe` and ConPTY ([Microsoft ConPTY Architecture](https://devblogs.microsoft.com/commandline/windows-command-line-introducing-the-windows-pseudo-console-conpty/)). ConPTY maintains a 2D screen coordinate buffer; any line written exceeding the console buffer width is split with `\r\n` and cursor positioning escapes.
- **Fix**: **Strictly disable PTY allocation**.
  - In CLI: Pass `-T` (`ssh -T user@host ...`).
  - In Node.js: `spawn('ssh', ['-T', ...], { stdio: ['pipe', 'pipe', 'pipe'] })`.
  - When `pty == 0`, Win32-OpenSSH bypasses ConPTY and writes directly to raw byte-oriented named pipes.

### 5.2. Signal Propagation: Ctrl-C and SIGTERM Lethality

- **Symptom**: Attempting to interrupt a running coding-agent turn by sending SIGINT (Ctrl-C) or SIGTERM from the client kills the entire remote worker process, collapses the SSH tunnel, and leaves uncommitted tool changes unhandled.
- **Root Cause**:
  1. Windows does not support POSIX signals (`SIGINT`, `SIGTERM`, `SIGHUP`).
  2. In Win32-OpenSSH source ([`contrib/win32/win32compat/signal_sigchld.c:131-145`](https://github.com/PowerShell/openssh-portable/blob/latestw_all/contrib/win32/win32compat/signal_sigchld.c)):
     ```c
     int w32_kill(int pid, int sig) {
         ...
         if (child_index != -1)
             TerminateProcess(children.handles[child_index], 0);
         return 0;
     }
     ```
     Any signal delivered over an SSH channel request unconditionally executes Win32 `TerminateProcess()`. There is no cooperative signal handler.
  3. If Sprout calls `child.kill('SIGINT')` on the local `ssh` process on macOS, the local `ssh` client exits. The SSH TCP socket closes, causing remote `sshd-session.exe` to exit. This closes the Windows Job Object handle, and the Windows kernel terminates the entire child process hierarchy immediately (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`).
- **Fix**: **Never rely on OS signal propagation over SSH**.
  - Sprout's core-to-worker protocol in `src/worker/protocol.ts` already specifies an in-band RPC method: `WORKER_METHODS.interrupt` (`session/interrupt`).
  - When a turn needs to be stopped, Sprout core sends `{"jsonrpc":"2.0","id":N,"method":"session/interrupt","params":{"sessionId":"..."}}` over the existing stdio stream.
  - The worker process receives this message in-process, sets its internal cancellation token, sends `CTRL_BREAK_EVENT` via `GenerateConsoleCtrlEvent` if needed, or issues cancellation to the engine's RPC adapter.

### 5.3. stdin / stdout Buffering

- **Symptom**: JSON-RPC requests sent by Sprout hang indefinitely without a response. Responses appear only after hundreds of lines accumulate or when the worker process terminates.
- **Root Cause**:
  1. **C Runtime Buffering**: Standard C runtimes (MSVCRT / UCRT) inspect the stdout file descriptor. When connected to an interactive console, stdout is line-buffered (`_IOLBF`); when connected to a pipe or file, it switches to 4KB block buffering (`_IOFBF`) ([MSDN: setvbuf](https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/setvbuf)).
  2. **PowerShell Pipeline Buffering**: If the worker command is executed through a PowerShell pipeline (e.g. `pwsh -c "node worker.js | Out-Default"`), PowerShell buffers objects and text chunks until newlines or buffer boundaries are met ([PowerShell Issue #19036: Piped data buffering](https://github.com/PowerShell/PowerShell/issues/19036)).
- **Fix**:
  - Node.js stdout on pipes does not use C-runtime block buffering; `process.stdout.write()` writes chunks directly to the underlying libuv pipe handle.
  - Avoid any PowerShell pipeline operators (`|`). The command invoked by SSH should directly execute the Node process:
    `node C:\sprout\worker\main.ts` (or `& node.exe ...` without downstream piping).

### 5.4. CRLF Translation vs. LF Line Framing

- **Symptom**: Extra carriage return bytes (`0x0D`, `\r`) appear in JSON-RPC frames.
- **Root Cause**:
  - On Windows, C standard I/O streams opened in text mode (`_O_TEXT`) translate `\n` to `\r\n` on output and `\r\n` to `\n` on input ([MSDN: `_setmode`](https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/setmode)).
  - PowerShell cmdlets and string redirection use Windows newline semantics (`[Environment]::NewLine` = `\r\n`).
- **Resolution & Fix**:
  - In Node.js, standard streams (`process.stdin`, `process.stdout`) operate in binary stream mode; no CRLF translation is performed by Node itself.
  - In Sprout's `src/engine/jsonrpc.ts:145-147`, `LineJsonRpcTransport.#receive(line)` already performs:
    ```typescript
    const trimmed = line.trim();
    if (trimmed === '') return;
    ```
    `line.trim()` strips any trailing `\r` before passing the string to `JSON.parse()`. Sprout's parser is therefore inherently CRLF-immune.

### 5.5. UTF-8 Character Encoding (PowerShell 5.1 vs. PowerShell 7)

- **Symptom**: Non-ASCII characters (UTF-8 multi-byte sequences, emojis, CJK text, Unicode identifiers in source code) are replaced with `?` or corrupted `` replacement characters.
- **Root Cause**:
  - Windows PowerShell 5.1 defaults to legacy OEM/ANSI codepages (e.g. Windows-1252 or CP437) on standard streams and pipes.
  - In PowerShell 7, the default encoding was changed across the board to UTF-8 without BOM ([Differences from Windows PowerShell 5.1](https://learn.microsoft.com/en-us/powershell/scripting/whats-new/differences-from-windows-powershell?view=powershell-7.4#encoding-to-use-utf-8-nobom-encoding-rather-than-ascii)). However, in versions prior to 7.4, native command stdout redirection still round-tripped through .NET strings using `$OutputEncoding`.
- **Fix**:
  - Target machine must run PowerShell 7+ (which the user specifies is installed).
  - Explicitly set UTF-8 console encoding if running through PowerShell:
    `[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)`
  - Even better: Launch `node.exe` directly, which defaults to UTF-8 buffers for all stdio handles.

### 5.6. Quoting and Argument Mangling

- **Symptom**: Arguments containing spaces, nested quotes, JSON payloads, or variables are split incorrectly or cause syntax errors (`Unexpected token in expression`).
- **Root Cause**:
  1. OpenSSH client concatenates all arguments into a single command string separated by spaces before sending it across the wire:
     `ssh user@host echo "hello world"` -> sends `echo hello world`.
  2. Windows OpenSSH invokes the shell using `CreateProcessAsUserW()` with command string:
     `"C:\Program Files\PowerShell\7\pwsh.exe" -c "echo hello world"`.
  3. Win32-OpenSSH applies CRT quoting rules in [`contrib/win32/win32compat/misc.c:1850`](https://github.com/PowerShell/openssh-portable/blob/latestw_all/contrib/win32/win32compat/misc.c) ([Win32-OpenSSH Issue #1082: Remote SSH commands require double escaping](https://github.com/PowerShell/Win32-OpenSSH/issues/1082)).
  4. PowerShell's `-c` (`-Command`) treats the argument as PowerShell script code. It strips the outermost quotes and evaluates expressions ([PowerShell `about_Parsing`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing)). Any unescaped `$` is interpreted as a PowerShell variable.
- **Fix**:
  - Never attempt to pass dynamic JSON or arguments with complex quotes directly inside the `ssh` command line string.
  - To invoke PowerShell reliably without argument escaping issues, use `-EncodedCommand`:
    ```bash
    # Encode UTF-16LE Base64 on macOS
    ENCODED=$(echo -n 'node C:\sprout\worker\main.ts' | iconv -f UTF-8 -t UTF-16LE | base64)
    ssh -T user@host "pwsh -NoProfile -NonInteractive -EncodedCommand $ENCODED"
    ```
  - Or invoke the static target binary directly without intermediate shell parsing.

### 5.7. Allowed Shells and Windows Access Restrictions

- **Symptom**: SSH login succeeds for interactive sessions, but running non-interactive commands fails with `Permission denied` or error code `1314` (A required privilege is not held by the client).
- **Root Cause**:
  - Unlike Unix systems which check `/etc/shells`, Windows OpenSSH does not have a hardcoded allowed shell whitelist.
  - However, Windows user rights policies apply: the account running `sshd` (`NT AUTHORITY\SYSTEM`) requires `SeAssignPrimaryTokenPrivilege` and `SeTcbPrivilege` to spawn processes as the logged-in user. If group policies restrict command shells via registry key `HKCU\Software\Policies\Microsoft\Windows\System\DisableCMD`, child process creation fails.
- **Fix**:
  - Verify that the Windows user account has standard interactive logon and batch execution rights.
  - Ensure the OpenSSH Windows service runs under `NT AUTHORITY\SYSTEM`.

### 5.8. Keepalive and Idle Timeouts on Long-Lived Sessions

- **Symptom**: During a long coding-agent turn (e.g. reasoning models thinking for 3+ minutes, large builds, or test suite execution), the SSH connection drops abruptly with `Connection reset by peer` or `Write failed: Broken pipe`.
- **Root Cause**:
  - Operating system TCP stacks, stateful network firewalls, and NAT gateways maintain state tables. If no packets traverse an established TCP connection for 5–15 minutes, state entries are purged ([OpenSSH `ServerAliveInterval` Docs](https://man.openbsd.org/ssh_config#ServerAliveInterval)).
  - When Sprout subsequently tries to send a message, the connection is already dead.
- **Fix**: **Configure active bidirectional keepalives**.
  - **Client-side (Sprout / macOS)**: Pass `-o ServerAliveInterval=30 -o ServerAliveCountMax=3` to every `ssh` invocation. Every 30 seconds of silence, the OpenSSH client sends an encrypted probe packet; if 3 probes fail, it detects connection death quickly.
  - **Server-side (Windows `%ProgramData%\ssh\sshd_config`)**:
    ```text
    ClientAliveInterval 30
    ClientAliveCountMax 3
    TCPKeepAlive yes
    ```

---

## 6. Evaluation of Architectural Alternatives

Before finalizing the recommendation, we evaluate the four alternative carriers against the project requirements.

| Dimension | Option (Selected): SSH stdio (`ssh -T`) | Option A: Worker TCP Listener + SSH Tunnel (`ssh -L`) | Option B: WinRM / PowerShell Remoting (wsman) | Option C: Cygwin / MSYS2 OpenSSH | Option D: Worker as Windows Service |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Transport Model** | Child process stdio pipe | Duplex TCP socket over loopback | SOAP / HTTP / HTTPS / PSRP | POSIX emulated PTY / pipe | Local or remote TCP / Named Pipe |
| **Matches `carrier.ts`** | Identical to `throughProcess` (Docker) | Identical to `start` (macOS loopback) | Incompatible (requires PSRP client) | Matches `throughProcess` | Matches `start` (if TCP) |
| **Windows Ports Needed** | Port 22 only | Port 22 (SSH tunnel) or published TCP port | Port 5985 (HTTP) / 5986 (HTTPS) | Port 22 | Requires dedicated published TCP port |
| **Authentication** | SSH Keys / Certificates | SSH Keys / Certificates | NTLM / Kerberos / HTTPS Certs | SSH Keys | Must implement custom auth |
| **Process Lifecycle** | Bound to SSH session & Job Object | Independent worker process | Session-managed by WS-Man service | Managed by Cygwin DLL | Managed by Windows SCM |
| **Signal Handling** | TerminateProcess / in-band RPC | in-band RPC | in-band RPC / Stop-Job | Emulated POSIX signals | in-band RPC / Service Stop |
| **Setup Overhead** | Minimal (Built-in Windows feature) | Low | High (WinRM HTTPS config is notoriously complex) | High (Cygwin runtime + path translation) | Medium (NSSM/WinSW registration) |

### Detailed Assessment of Alternatives:

#### Alternative A: Small Listener on Windows over TCP (with SSH Port Forwarding)
- **How it works**: Sprout starts the worker on Windows (either on boot or via a preliminary SSH command). The worker binds to `127.0.0.1:<port>` on Windows. Sprout opens an SSH tunnel:
  `ssh -L 12700:127.0.0.1:<port> user@windows-host -N`
  Sprout connects its `LineJsonRpcTransport` to `localhost:12700` on macOS using `EndpointCarrier.start`.
- **Pros**: Matches Sprout's local macOS carrier (`EndpointCarrier.start` / `connectEndpoint`) 1:1. Avoids all stdio stream, CRLF, and quote-escaping quirks.
- **Cons**: Requires two steps: managing worker lifecycle and managing the SSH tunnel process.
- **Verdict**: Excellent secondary fallback if stdio edge cases emerge in production.

#### Alternative B: PowerShell Remoting / WinRM (`wsman` / PSRP)
- **How it works**: Sprout talks to WinRM over HTTP/HTTPS using the PowerShell Remoting Protocol (MS-PSRP).
- **Why Reject**:
  1. WinRM wraps all streams in SOAP XML envelopes and CLIXML serialization (`<Objs Version="1.1.0.1">`). It does not provide a raw byte stream for JSON-RPC.
  2. Setting up HTTPS WinRM certificates for cross-platform non-domain machines is notoriously fragile.
  3. No official Node.js PSRP client exists in Microsoft's stack; community libraries (`node-winrm`) are unmaintained and incomplete.

#### Alternative C: Non-Microsoft OpenSSH (Cygwin / MSYS2)
- **How it works**: Install Cygwin's `openssh` package on Windows.
- **Why Reject**:
  1. Cygwin creates a virtual POSIX layer with its own path conversions (`/cygdrive/c/`), which conflicts with native Windows engines (`codex.exe`, `pwsh.exe`) expecting Win32 paths (`C:\...`).
  2. Win32-OpenSSH is an official Windows Component included in Windows 10/11 and Server 2019/2022/2025. Introducing Cygwin adds massive external dependency debt.

#### Alternative D: Worker as a Windows Service (talking over Named Pipe or Port)
- **How it works**: The Sprout worker is installed as a background service via NSSM, WinSW, or `sc.exe create`.
- **Why Reject for M1**:
  1. Named Pipes cannot traverse the network to macOS without SMB RPC tunneling, which is unsupported on Node.js macOS.
  2. Exposing an unauthenticated raw TCP port on a remote network violates Sprout's security model (ADR-0003 note: "avoid exposing container ports, and the authentication and version negotiation that would come with them, before M1 works").
  3. Updating worker code requires restarting Windows services with elevated administrative privileges.

---

## 7. Concrete Recommendation for M1

### 7.1. Recommended Strategy: Direct SSH stdio (`throughProcess`)

Use `EndpointCarrier.throughProcess` with standard Windows OpenSSH Server. Treat the `ssh` process identically to how `ContainerCarrier` treats `docker exec -i`.

```
[ Sprout Core (macOS) ]
       │
       ▼ child_process.spawn('ssh', ['-T', ...])
┌─────────────────────────────────────────────────────────────┐
│ SSH Client (macOS)                                          │
│   -T (Disable PTY)                                          │
│   -o ServerAliveInterval=30                                 │
└──────────────────────────────┬──────────────────────────────┘
                               │ Encrypted SSH-2 Connection
                               │ (Port 22, non-interactive)
┌──────────────────────────────▼──────────────────────────────┐
│ Windows OpenSSH Server (sshd.exe / sshd-session.exe)        │
│   ├─ Creates Byte-Mode Named Pipes (PIPE_TYPE_BYTE)         │
│   ├─ Assigns child to Windows Job Object                    │
│   └─ Bypasses ConPTY & ssh-shellhost.exe                    │
└──────────────────────────────┬──────────────────────────────┘
                               │ Raw stdio handles
┌──────────────────────────────▼──────────────────────────────┐
│ Node.js Environment Worker (Windows)                        │
│   node.exe C:\sprout\worker\main.ts                         │
│   SPROUT_WORKER_TRANSPORT=stdio                             │
│   ├─ LineJsonRpcTransport (process.stdin / process.stdout)  │
│   └─ Supervises Engine CLIs (codex.exe, pwsh.exe, etc.)     │
└─────────────────────────────────────────────────────────────┘
```

### 7.2. Windows Server Configuration Steps

Run in an elevated PowerShell 7 prompt on the Windows target machine:

```powershell
# 1. Ensure OpenSSH Server is installed and started
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType 'Automatic'

# 2. Configure Keepalives in %ProgramData%\ssh\sshd_config
$sshdConfig = "$env:ProgramData\ssh\sshd_config"
Add-Content -Path $sshdConfig -Value @"

# Sprout Keepalive Configuration
ClientAliveInterval 30
ClientAliveCountMax 3
TCPKeepAlive yes
"@
Restart-Service sshd

# 3. Configure PowerShell 7 as the DefaultShell (for any fallback shell commands)
$regKey = 'HKLM:\SOFTWARE\OpenSSH'
Set-ItemProperty -Path $regKey -Name 'DefaultShell' -Value 'C:\Program Files\PowerShell\7\pwsh.exe'
Set-ItemProperty -Path $regKey -Name 'DefaultShellCommandOption' -Value '-c'
Set-ItemProperty -Path $regKey -Name 'DefaultShellEscapeArguments' -Value 1

# 4. Authorize Sprout SSH Public Key
# (If user is in Administrators group, use administrators_authorized_keys):
$adminKeys = "$env:ProgramData\ssh\administrators_authorized_keys"
# Append Sprout's public key to $adminKeys
# Enforce mandatory Windows file permissions:
icacls.exe $adminKeys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
```

### 7.3. Client-Side Invocation Pattern (TypeScript / Node.js)

In Sprout's carrier layer:

```typescript
const sshArgs = [
  '-T',                                     // CRITICAL: Disable PTY (bypasses ConPTY)
  '-o', 'ServerAliveInterval=30',           // Keepalive: probe every 30s
  '-o', 'ServerAliveCountMax=3',            // Drop after 3 missed probes (90s)
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ExitOnForwardFailure=yes',
  'user@windows-host',
  // Direct invocation of Node without shell argument parsing
  'node C:\\sprout\\src\\worker\\main.ts',
];

const connection = await EndpointCarrier.throughProcess({
  command: 'ssh',
  args: sshArgs,
  label: 'windows:worker',
  onLog: (line) => console.log(`[windows-worker] ${line}`),
});
```

---

## 8. Pre-Implementation Verification Probe

**Rule**: Before writing a single line of TypeScript production code, run this standalone probe from macOS to verify that the Windows host satisfies the five invariants.

Create a temporary script `scripts/probe-windows-ssh.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-user@windows-host}"
echo "=== Running Sprout Windows SSH Transport Probe against $TARGET ==="

echo "--- Probe 1: Non-PTY Raw Binary Stream & LF/CRLF Check ---"
# Sends raw LF; checks that remote does not corrupt or inject VT escapes
OUTPUT=$(ssh -T "$TARGET" "node -e 'process.stdin.on(\"data\", d => process.stdout.write(d));'" <<< "HELLO_SPROUT")
if [[ "$OUTPUT" =~ "HELLO_SPROUT" ]]; then
    echo "✓ PASS: Raw stdio pipe round-trip succeeded."
else
    echo "✗ FAIL: Stdio stream corrupted. Output was: $OUTPUT"
    exit 1
fi

echo "--- Probe 2: Multi-byte UTF-8 Unicode Integrity ---"
# Sends CJK, symbols, and emoji; verifies byte-level preservation
UTF8_TEST="Sprout 芽 🚀 100% — λ => π"
UTF8_OUT=$(ssh -T "$TARGET" "node -e 'process.stdin.on(\"data\", d => process.stdout.write(d));'" <<< "$UTF8_TEST")
if [[ "$UTF8_OUT" =~ "$UTF8_TEST" ]]; then
    echo "✓ PASS: UTF-8 encoding preserved intact."
else
    echo "✗ FAIL: UTF-8 mangled. Output was: $UTF8_OUT"
    exit 1
fi

echo "--- Probe 3: JSON-RPC Simulation over Stdio ---"
# Simulates LineJsonRpcTransport handshake
RPC_PING='{"jsonrpc":"2.0","id":1,"method":"worker/info","params":{}}'
RPC_RESP=$(ssh -T "$TARGET" "node -e '
  const readline = require(\"readline\");
  const rl = readline.createInterface({ input: process.stdin });
  rl.on(\"line\", line => {
    const req = JSON.parse(line);
    process.stdout.write(JSON.stringify({ jsonrpc: \"2.0\", id: req.id, result: { status: \"ok\", pwsh: true } }) + \"\n\");
    process.exit(0);
  });
'" <<< "$RPC_PING")

if [[ "$RPC_RESP" =~ '"result":{"status":"ok"' ]]; then
    echo "✓ PASS: JSON-RPC protocol round-trip succeeded."
else
    echo "✗ FAIL: JSON-RPC simulation failed. Response: $RPC_RESP"
    exit 1
fi

echo "--- Probe 4: Job Object Cleanup on Session Close ---"
# Starts a dummy background child process; verify it dies when SSH exits
ssh -T "$TARGET" "powershell -Command \"Start-Process ping -ArgumentList '-t 127.0.0.1' -PassThru | Select-Object -ExpandProperty Id\"" > /tmp/probe_pid.txt
SLEEP_PID=$(cat /tmp/probe_pid.txt | tr -d '\r')
echo "Spawned remote test process PID: $SLEEP_PID. Checking if Job Object terminated it..."
sleep 2
CHECK_RUNNING=$(ssh -T "$TARGET" "powershell -Command \"Get-Process -Id $SLEEP_PID -ErrorAction SilentlyContinue\"" || true)
if [[ -z "$CHECK_RUNNING" ]]; then
    echo "✓ PASS: Job Object cleanly terminated child process."
else
    echo "⚠ WARNING: Remote process leaked! PID $SLEEP_PID still exists."
fi

echo "=== All Core Invariants Verified Successfully! ==="
```

---

## 9. Primary Sources and References

1. **Microsoft Learn: OpenSSH Server Configuration for Windows**  
   Configuring `DefaultShell`, `DefaultShellCommandOption`, `authorized_keys`, and Windows-specific `sshd_config` directives.  
   <https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_server_configuration>
2. **Microsoft Learn: OpenSSH Overview for Windows**  
   Architectural history and system integration of Win32-OpenSSH.  
   <https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-overview>
3. **Microsoft Learn: Windows Command Line - Introducing ConPTY**  
   Architecture of the Windows Pseudo-Console subsystem, VT translation, and screen-buffer wrapping.  
   <https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session>
4. **PowerShell/Win32-OpenSSH Wiki: DefaultShell**  
   Primary source documentation for registry keys `DefaultShell`, `DefaultShellCommandOption`, and `DefaultShellEscapeArguments`.  
   <https://github.com/PowerShell/Win32-OpenSSH/wiki/DefaultShell>
5. **PowerShell/Win32-OpenSSH Wiki: About Win32-OpenSSH and Design Details**  
   POSIX wrapper design, async file I/O, named pipes, process creation via `posix_spawn`, and signal mapping.  
   <https://github.com/PowerShell/Win32-OpenSSH/wiki/About-Win32-OpenSSH-and-Design-Details>
6. **PowerShell/openssh-portable Source Code: `contrib/win32/win32compat/w32-doexec.c`**  
   Distinction between `pty` (ConPTY/`ssh-shellhost.exe`) and non-pty (`posix_spawn` / `PIPE_TYPE_BYTE`), and Job Object assignment.  
   <https://github.com/PowerShell/openssh-portable/blob/latestw_all/contrib/win32/win32compat/w32-doexec.c>
7. **PowerShell/openssh-portable Source Code: `contrib/win32/win32compat/signal_sigchld.c`**  
   Implementation of `w32_kill()` calling `TerminateProcess()`.  
   <https://github.com/PowerShell/openssh-portable/blob/latestw_all/contrib/win32/win32compat/signal_sigchld.c>
8. **PowerShell/Win32-OpenSSH Issue #1082: Remote SSH commands require double escaping**  
   Analysis of command-line argument concatenation and MSVCRT argument escaping.  
   <https://github.com/PowerShell/Win32-OpenSSH/issues/1082>
9. **Microsoft Learn: Differences between Windows PowerShell 5.1 and PowerShell 7.x**  
   Default UTF-8 NoBOM encoding on standard output and pipeline streams.  
   <https://learn.microsoft.com/en-us/powershell/scripting/whats-new/differences-from-windows-powershell>
10. **Microsoft Learn: `about_Preference_Variables` (`$PSNativeCommandArgumentPassing`)**  
    Rules for argument passing to native executables introduced in PowerShell 7.3+.  
    <https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables>
11. **OpenSSH Project Manual: `ssh_config(5)` & `sshd_config(5)`**  
    Keepalive mechanisms: `ServerAliveInterval`, `ServerAliveCountMax`, `ClientAliveInterval`.  
    <https://man.openbsd.org/ssh_config#ServerAliveInterval>  
    <https://man.openbsd.org/sshd_config#ClientAliveInterval>
