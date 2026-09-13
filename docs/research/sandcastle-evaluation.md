# Research Report: Evaluating Sandcastle as an Isolation Backend for a Herdr-Based Pi Orchestrator

**Target Subject**: [`mattpocock/sandcastle`](https://github.com/mattpocock/sandcastle) (analyzed at release `v0.12.0`, commit `e99f832`)  
**Investigator**: Background Research Agent  
**Context**: Project-local GitHub-Issue orchestrator that launches one Pi worker per Herdr tab, running multiple modifying tickets concurrently with isolated branches/worktrees, safe integration, crash recovery, and compatibility with an already-dirty primary working tree.  
**Recommendation for v1**: **REJECT**. Use direct `git worktree` management coordinated with Herdr.

---

## Executive Summary

Sandcastle (`@ai-hero/sandcastle`) is a TypeScript toolkit designed to execute AI coding agents inside sandboxed environments (Docker, Podman, Vercel, Daytona, or host-level `no-sandbox`) with automated prompt expansion, iteration loops, and commit collection.

While Sandcastle internally wraps `git worktree` for its `branch` and `merge-to-head` strategies, **it is architecturally mismatched as an isolation backend for a Herdr-multiplexed orchestrator**:

1. **Role Inversion / Supervisor Conflict**: Sandcastle is structured to *be* the top-level process supervisor. Its `run()` launches headless CLI processes (`pi -p --mode json ...`), monitors stdout for `<promise>COMPLETE</promise>` signals, and controls stdin/stdout. Herdr is *also* a process supervisor and terminal multiplexer that spawns interactive shell panes, manages PTYs, and provides its own `herdr_agent` abstraction. Attempting to use Sandcastle alongside Herdr results in two supervisors competing for the agent lifecycle.
2. **Incompatibility with Dirty Primary Worktrees**: Sandcastle's only automatic integration mechanism (`merge-to-head`) merges directly into the primary repository working directory (`cwd: hostRepoDir`) using `git merge`. If the primary worktree has uncommitted modifications, `git merge` fails with conflict errors or pollutes uncommitted user edits.
3. **Concurrency Hazards**: The `merge-to-head` strategy is documented by Sandcastle maintainers as strictly unsafe for concurrent execution due to races on the primary git index and HEAD (`ADR 0018`). While the `branch` strategy supports distinct branches, worktree locking (`ADR 0007`) was never implemented in code, risking silent collisions if two tasks share a branch.
4. **Crash Recovery Gaps**: Crashed runs leave worktree directories in `.sandcastle/worktrees/` registered in git. Sandcastle's `pruneStale()` method explicitly ignores worktrees that are still known to `git worktree list`, meaning abandoned worktrees leak indefinitely on disk until manual intervention.
5. **Superfluous Overhead for Zero Isolation Benefit**: Under `no-sandbox`, Sandcastle provides no container or filesystem isolation beyond standard OS file access. If container isolation (`docker`) were used on macOS, Herdr cannot attach to containerized agents without complex wrapper scripts, and Docker bind mounts across macOS/Linux VM boundaries incur severe I/O latency.

Direct orchestration of plain `git worktree` via Node's `child_process` alongside Herdr `tab_create(cwd)` is simpler, robust against dirty trees, carries zero runtime dependencies, and avoids the pre-1.0 architectural churn of Sandcastle.

---

## 1. What Sandcastle Actually Abstracts

Sandcastle is a focused end-to-end driver for single-session or batched AI agent runs. It abstracts four distinct subsystems:

### 1.1. Agent Invocation and Output Parsing (`src/AgentProvider.ts`)
Sandcastle provides built-in adapters for specific agent CLIs: Claude Code, Codex, Cursor, OpenCode, GitHub Copilot CLI, and Mario Zechner's Pi (`pi`).
For Pi, `AgentProvider.ts:646-658` builds the command:
```bash
pi -p --mode json --model <model> [--thinking <level>] [--session <id>]
```
It streams NDJSON from stdout, parsing events (`session`, `message_update`, `tool_execution_start`, `agent_error`, `agent_end`) into internal data structures (`src/AgentProvider.ts:544-618`). It also implements session persistence transfer between host and sandbox (`makePiSessionStorage`, `src/AgentProvider.ts:494-542`).

### 1.2. Sandbox Providers (`src/SandboxProvider.ts`)
Sandcastle defines an execution SPI (`SandboxProvider`) with three variants:
- **Bind-Mount Providers** (`docker`, `podman`): Start a container bind-mounting the host worktree to `/workspace` and bind-mounting `.git` directories.
- **Isolated Providers** (`vercel`, `daytona`): Launch remote microVMs and sync changes via git patches (`src/syncIn.ts`, `src/syncOut.ts`).
- **No-Sandbox Provider** (`sandboxes/no-sandbox.ts`): Spawns commands directly on the host using `child_process.spawn("sh", ["-c", command])` or `cmd.exe`.

### 1.3. Execution Orchestrator (`src/Orchestrator.ts`)
Manages iteration loops (`maxIterations`), detects completion markers (`<promise>COMPLETE</promise>`), validates structured JSON output via Standard Schema/Zod (`Output.object`), and enforces an idle timeout (`idleTimeoutSeconds`, default 600s) and a hanging-process completion timeout (`completionTimeoutSeconds`, default 60s, `ADR 0019`).

### 1.4. Worktree Lifecycle (`src/WorktreeManager.ts`, `src/createWorktree.ts`)
Creates git worktrees under `<hostRepoDir>/.sandcastle/worktrees/<name>/`, copies host files (`copyToWorktree`), checks for uncommitted changes, and cleans up clean worktrees on close.

### 1.5. What It Does Not Abstract
- It does **not** provide terminal multiplexing, tabs, or pane management.
- It does **not** integrate with external multiplexers like Herdr or tmux.
- Its CLI (`src/cli.ts`) is strictly for scaffolding (`sandcastle init`) and image building (`sandcastle docker build-image`); it has no headless daemon or task runner CLI.

---

## 2. Lifecycle and Filesystem / Git Isolation

### 2.1. Filesystem Isolation
- **With `docker()` / `podman()`**:
  The sandbox runs in a Linux container. The host worktree is bind-mounted directly into the container (`mountUtils.ts`). Files modified inside the container immediately modify the host disk.
  *macOS Constraint*: Bind mounts run across the Darwin host / Linux VM boundary (via VirtioFS or gRPC-FUSE). Heavy I/O workloads (`node_modules`, builds, tests) suffer significant latency compared to native APFS.
- **With `noSandbox()`**:
  Processes run directly on the host with the caller's UID and permissions (`sandboxes/no-sandbox.ts:60-120`). **There is zero filesystem isolation.** The agent can inspect or modify any file accessible to the user account.

### 2.2. Git Isolation
- Git worktrees share the primary repository's object database (`.git/objects`) and reference store (`.git/refs`), while maintaining isolated working trees, indexes (`.git/worktrees/<name>/index`), and `HEAD` references.
- To prevent locking issues during `git worktree add`, Sandcastle passes global config flags (`WorktreeManager.ts:18-22`):
  ```typescript
  const NO_CONFIG_LOCK_FLAGS = [
    "-c", "branch.autoSetupMerge=false",
    "-c", "push.autoSetupRemote=false",
  ];
  ```
- Sandcastle requires worktrees to live strictly under `<repoDir>/.sandcastle/worktrees/`. The maintainer has explicitly classified custom prefix/path configuration as **out of scope** (`.out-of-scope/configurable-namespace-prefix.md`).

---

## 3. Worker Working Directory (CWD) and Herdr Co-existence

### 3.1. Worktree Path Discovery
When calling `createWorktree(options)`, Sandcastle returns a `Worktree` instance:
```typescript
export interface Worktree {
  readonly branch: string;
  readonly worktreePath: string; // Absolute path on host
  run(options: WorktreeRunOptions): Promise<WorktreeRunResult>;
  interactive(options: WorktreeInteractiveOptions): Promise<InteractiveResult>;
  createSandbox(options: WorktreeCreateSandboxOptions): Promise<Sandbox>;
  close(): Promise<CloseResult>;
}
```
(`src/createWorktree.ts:205-217`).

The returned `worktreePath` can technically be passed to Herdr:
```typescript
herdr_layout({ action: "tab_create", cwd: wt.worktreePath, label: "ticket-123" });
```

### 3.2. The Inherent Supervisor Conflict
Once Herdr creates the tab, Herdr owns the shell pane and process lifecycle:
- Herdr starts Pi via `herdr_agent start(pane, kind: "pi")`.
- Herdr submits prompts via `herdr_agent prompt`.
- Herdr monitors completion via `herdr_agent wait` and reads terminal output via `herdr_agent read`.

If the orchestrator uses Herdr to launch and manage the worker, **none of Sandcastle's execution functions (`wt.run()`, `wt.interactive()`, `Orchestrator.ts`) can be used**:
- `wt.run()` runs headless, spawning its own process and expecting direct stdio pipes.
- `wt.interactive()` assumes stdio is bound to the Node process terminal (`InteractiveExecOptions`, `sandboxes/no-sandbox.ts:133-155`).
- Sandcastle cannot "attach" to a process running inside a Herdr pane.

Using Sandcastle here reduces it to a glorified `git worktree add` script while pulling in `@effect/platform`, `@effect/platform-node`, and `effect`.

---

## 4. Branch, Commit, and Merge Behavior

Sandcastle defines three branch strategies (`CONTEXT.md:45-66`, `src/SandboxLifecycle.ts:390-530`):

| Strategy | Worktree Created? | Branch Used | Post-Run Merge Action |
| :--- | :--- | :--- | :--- |
| `head` | No | Host's current branch | None (modifies host repo directly) |
| `branch` | Yes (`.sandcastle/worktrees/<branch>`) | Named branch provided by caller | **None**. Commits remain on that branch. |
| `merge-to-head` | Yes (`.sandcastle/worktrees/sandcastle-<ts>-<suffix>`) | Temp branch (`sandcastle/<ts>-<suffix>`) | **Merges into host current branch** via `git merge`, then deletes temp branch. |

### 4.1. Commit Ownership
Sandcastle **never automatically commits files** left behind by an agent.
In `SandboxLifecycle.ts:425-433`, it simply queries git for existing commits:
```typescript
const { stdout } = await execAsync(
  `git rev-list "${baseHead}..HEAD" --count`,
  { cwd: hostSideWorktreePath },
);
```
If an agent edits files but fails to run `git commit`, Sandcastle detects zero new commits. When the worktree closes, it detects uncommitted changes, marks it dirty, and leaves it unmerged on disk.

### 4.2. Merge Execution
In `merge-to-head` mode, Sandcastle performs the merge directly in `hostRepoDir` (`src/SandboxLifecycle.ts:446-455`):
```typescript
await execAsync(`git merge "${resolvedBranch}"`, {
  cwd: hostRepoDir,
});
```
This is a standard host-level `git merge`.

---

## 5. Dirty-Tree Behavior (Primary Repo and Worktree)

### 5.1. Behavior When the Primary Host Repo is Dirty
In real-world developer setups, the primary repository working directory frequently has uncommitted edits, stashes, or untracked test files.

- **`merge-to-head` Fails**:
  If the host working tree has uncommitted modifications to any file affected by the branch, `git merge` halts with:
  ```
  error: Your local changes to the following files would be overwritten by merge...
  Please commit your changes or stash them before you merge.
  ```
  Sandcastle catches this and throws a `SyncError` (`src/SandboxLifecycle.ts:456-466`):
  `Merge of '<resolvedBranch>' onto '<hostCurrentBranch>' failed. The temporary branch '<resolvedBranch>' has been preserved.`
  Even if the modified files do not conflict, running `git merge` in a dirty working directory intermingles ticket commits with the developer's in-progress uncommitted work.
- **`branch` Strategy Avoids Primary Dirty Tree During Creation**:
  When creating a worktree with `branchStrategy: { type: "branch", branch: "feature" }`, Sandcastle calls:
  `git worktree add -b feature <worktreePath> HEAD` (`src/WorktreeManager.ts:365-376`).
  Because it forks from `HEAD` (the latest commit object), uncommitted changes in the host working directory do not leak into the worktree.
- **Primary Checkout Conflict**:
  If the primary working tree happens to already have the requested ticket branch checked out, `git worktree add` refuses to proceed, and Sandcastle throws a hard error (`src/WorktreeManager.ts:348-360`):
  `Branch '<branch>' is already checked out in worktree at '<path>'... Pick a different branch, or switch the main working tree to a different branch before re-running.`

### 5.2. Behavior When the Worktree Itself is Dirty
- **On Close**: `wt.close()` executes `hasUncommittedChanges()` (`src/createWorktree.ts:266-281`). If uncommitted or untracked files remain, the worktree is preserved on disk, returning `{ preservedWorktreePath: worktreeInfo.path }`. It is only deleted if completely clean.
- **On Reuse**: Under ADR 0003, if a worktree already exists for a named branch and contains uncommitted changes, Sandcastle logs a warning and reuses it as-is without refreshing from `origin` (`src/WorktreeManager.ts:339-346`).

---

## 6. Concurrency Evaluation

Can the orchestrator run multiple modifying tickets concurrently using Sandcastle?

### 6.1. `merge-to-head` Concurrency: Strictly Broken
Documented authoritatively in `docs/adr/0018-fork-is-session-only.md` and `CHANGELOG.md:95`:
> *"The default `head` and `merge-to-head` strategies are **not** safe for concurrent forks: `head` shares the host working directory across all children, and `merge-to-head` races child merges against one another and HEAD."*

If two tickets finish around the same time, both attempt `git merge` in `hostRepoDir`, racing on `.git/index.lock` and clobbering each other's merge base.

### 6.2. `branch` Concurrency: Unlocked Hazard
If the orchestrator assigns an explicit, unique branch to each ticket (`ticket-101`, `ticket-102`), each gets an independent worktree in `.sandcastle/worktrees/`.

However:
- **Locking is Missing in Code**: While `docs/adr/0007-worktree-locking.md` was drafted to introduce file locks under `.sandcastle/locks/<name>.lock`, searching the codebase reveals that `.sandcastle/locks` was **never implemented**. If two tasks or processes mistakenly reference the same branch name, Sandcastle will hand both processes the exact same worktree directory with only a console warning (`WorktreeManager.ts:340`).
- **Terminal Display Contention**: Sandcastle's built-in `Display` engine (`src/Display.ts`) uses `@clack/prompts` and raw ANSI escapes designed for single-session terminal takeover. Concurrent runs in the same Node process corrupt the terminal unless configured with `logging: "file"`.

---

## 7. Cleanup and Crash Recovery

### 7.1. Normal Teardown
`wt.close()` or `await using wt = ...` checks if the worktree has uncommitted changes. Clean worktrees are removed via `git worktree remove --force <worktreePath>` (`src/WorktreeManager.ts:430-438`). Dirty worktrees are kept on disk.

### 7.2. Process Crash / Abrupt Termination
If the orchestrator process terminates abruptly (unhandled exception, SIGKILL, power loss, OOM):
1. **No Async Work on Exit**: Sandcastle registers process signal handlers in `src/shutdownRegistry.ts`. Because Node cannot await async operations inside `exit` or `SIGINT` handlers, `createSandbox.ts:1072-1076` only executes a synchronous log:
   ```typescript
   const forceCleanup = () => {
     console.error(`\nWorktree preserved at ${worktreePath}`);
     console.error(`  To review: cd ${worktreePath}`);
     console.error(`  To clean up: git worktree remove --force ${worktreePath}`);
   };
   ```
2. **Failure of `pruneStale()` to Clean Stale Worktrees**:
   On restart, Sandcastle provides `WorktreeManager.pruneStale()` (`src/WorktreeManager.ts:444-510`).
   However, `pruneStale()` performs:
   ```typescript
   yield* execGit(["worktree", "prune"], repoDir);
   // ...
   const worktreeList = yield* execGit(["worktree", "list", "--porcelain"], repoDir);
   const activeWorktreePaths = new Set(...);
   for (const entry of entries) {
     if (isDir && isOrphanedWorktreePath(entryPath, activeWorktreePaths)) {
       yield* fs.remove(entryPath, ...);
     }
   }
   ```
   Notice the logic: `isOrphanedWorktreePath` checks if the directory is absent from `git worktree list`. But when a process crashes, the worktree directory **still exists** and is **still registered in git**. Therefore, git does not prune it, `activeWorktreePaths` contains it, and `pruneStale()` **skips it entirely**.
3. **Leaked Worktrees**: In any timestamped or auto-generated branch scenario, crashed worktrees permanently leak on disk in `.sandcastle/worktrees/` until cleaned up by manual developer intervention.

---

## 8. macOS Environment Requirements

When evaluating Sandcastle on macOS:

| Requirement | `noSandbox()` Mode | `docker()` Mode |
| :--- | :--- | :--- |
| **Prerequisites** | Node.js 18+, Git, Pi CLI | Docker Desktop / OrbStack, Git, Node.js 18+ |
| **Architecture** | Native Darwin (arm64 / x86_64) | Container must support Linux arm64 or run via Rosetta 2 emulation |
| **File Permissions** | Native macOS permissions | UID misalignment (macOS UID 501 vs Linux UID 1000) requires git `safe.directory` override (`SandboxLifecycle.ts:250`) |
| **I/O Overhead** | Native APFS speed | Significant overhead across macOS hypervisor VirtioFS layer |
| **Herdr Integration** | Compatible with Herdr tab cwd | Incompatible: Herdr cannot execute `pi` inside the container without custom container wrappers |

---

## 9. Maturity, Maintenance, and Dependency Risks

1. **Pre-1.0 Versioning (`v0.12.0`)**: Sandcastle is in active development with frequent breaking changes across minor releases (e.g. branch strategy rewrites, workspace-to-worktree renames in `v0.11.x`, and public API shifts).
2. **Heavy Effect-ts Stack**: Sandcastle is written entirely on the `effect` ecosystem (`@effect/platform`, `@effect/platform-node`, `@effect/cli`, `@effect/printer`). While it bundles dependencies via `tsup`, debugging errors or customizing behavior requires working through Effect's fiber and generator abstractions.
3. **Bot-Driven Maintenance**: A large portion of commits and PR merges in the repo are authored by automated agents (`sandcastle-agent[bot]`), resulting in rapid feature addition but occasionally leaving planned architectural designs unimplemented (such as ADR 0007 locks).
4. **Rigid Configuration Boundaries**: As documented in `.out-of-scope/configurable-namespace-prefix.md`, Sandcastle explicitly rejects allowing callers to configure `.sandcastle` directory naming or path prefixes.

---

## 10. Direct Comparison: Plain `git worktree` vs. Sandcastle

For the specific use case of a **project-local GitHub-Issue orchestrator driving Pi workers via Herdr tabs**:

| Evaluation Vector | Sandcastle (`@ai-hero/sandcastle`) | Plain `git worktree` + Herdr Orchestrator |
| :--- | :--- | :--- |
| **Supervisor Role** | Competes with Herdr. Sandcastle expects to own the process, PTY, and iteration loop. | Complements Herdr. Orchestrator provisions worktree; Herdr manages PTY and Pi worker. |
| **Worker CWD Setup** | `createWorktree()` creates `<repo>/.sandcastle/worktrees/<name>`. | Direct `git worktree add -b issue-N .worktrees/issue-N <baseRef>`. |
| **Dirty Primary Worktree** | `merge-to-head` fails or corrupts host tree. `branch` strategy provides no merge mechanism. | **100% Safe**. Base commits fork from `origin/main` or clean ref; integration occurs in a separate staging worktree or via PR (`gh pr create`). |
| **Concurrent Tickets** | Unsafe on `merge-to-head`. Unlocked on `branch`. | Fully isolated. Each ticket has its own directory, branch, and Herdr tab. Git additions can be sequenced with a 5-line promise queue. |
| **Integration Step** | Blind `git merge` in host repo. | Decoupled and flexible: push branch to remote, open GitHub PR, or rebase in an isolated `.worktrees/_integration` staging tree. |
| **Crash Recovery** | `pruneStale()` ignores crashed active worktrees. Directory names leak. | Orchestrator reconciles `.worktrees/issue-*` against issue database/GitHub API on startup; removes abandoned worktrees cleanly with `git worktree remove --force`. |
| **Filesystem Isolation** | None in `no-sandbox`. High I/O overhead & Herdr incompatibility in `docker()`. | Host filesystem with branch-level isolation (identical to Sandcastle's `no-sandbox`). |
| **Dependencies** | Bundled `effect`, `@clack/prompts`, Node platform runtime (~1.2 MB). | Zero external dependencies. Standard Node `child_process.execFile("git", ...)`. |

---

## 11. Final Recommendation: REJECT for v1

### Rationale
Sandcastle was built to solve a different problem: headless single-agent scripting and containerized benchmark loops (e.g. running Claude Code inside Docker from a single command line script).

It was **not** designed to act as an invisible filesystem isolation layer underneath an external multiplexer like Herdr.
- If you use Sandcastle's execution layer (`run` / `interactive`), it displaces Herdr's core value proposition (tab management, visual inspection, PTY control, interactive sub-agent commands).
- If you use only Sandcastle's worktree layer (`createWorktree`), you inherit all of its architectural constraints (rigid `.sandcastle/worktrees` location, inability to integrate safely with a dirty primary worktree, broken crash cleanup, and heavyweight Effect runtime) while gaining nothing that cannot be achieved with three standard `git` CLI invocations:

```bash
# 1. Create worker worktree cleanly off base branch (immune to dirty primary tree)
git worktree add -b "issue-${ID}" ".worktrees/issue-${ID}" "origin/main"

# 2. Launch in Herdr
# herdr_layout(action: "tab_create", cwd: path.resolve(".worktrees/issue-${ID}"), label: "issue-${ID}")
# herdr_agent(action: "start", pane: paneId, kind: "pi")

# 3. Clean integration when done (without touching dirty primary tree)
git -C ".worktrees/issue-${ID}" push origin "issue-${ID}"
gh pr create --head "issue-${ID}" --base main ...
git worktree remove --force ".worktrees/issue-${ID}"
```

### Recommendation for v1 Architecture
1. **Reject Sandcastle** as a dependency for the orchestrator.
2. **Implement an internal `WorktreeService`** in the orchestrator using native `git worktree add`, `git worktree remove`, and `git worktree list --porcelain`.
3. Anchor worktrees to a dedicated local directory (e.g. `.worktrees/` or `.pi/worktrees/`, added to `.gitignore`).
4. Perform all merging, rebasing, or PR submissions from the worker worktree or a dedicated clean staging worktree, ensuring the developer's primary working tree remains completely untouched regardless of its dirty state.
