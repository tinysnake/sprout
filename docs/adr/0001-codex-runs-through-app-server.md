# Codex runs through the app-server JSON-RPC transport

Codex offers two non-interactive surfaces and they are not equivalent. `codex exec --json` is a one-shot process, but it does **not stream**: a whole turn yields exactly four events (`thread.started`, `turn.started`, `item.completed`, `turn.completed`) and the agent message arrives as one complete blob after generation finishes. `codex app-server --listen stdio://` speaks JSON-RPC over stdio and emits `item/started` and `item/completed` per item, including `commandExecution` tool calls as they occur.

We decided to run Codex through **app-server**, because `docs/goal.md` makes "the human can always observe, interrupt, and correct agents" a product principle, and blob delivery defeats that for the engine we expect to use most. The cost is that Sprout must supervise a long-lived child process — start it, health-check it, and restart it — and must tolerate a run dying mid-turn. We accepted that cost, and it is now a requirement on O4's recovery work rather than a surprise.

The alternative — ship Pi first and defer Codex — was rejected because O1's claim is that one run interface covers two real engines; proving it against a single engine would defer the hardest part of the design.

**Consequences**: a Codex run is not a single child process. Sprout needs a session-supervision component, and O4's recovery check must cover daemon death, not just an interrupted run. Pi needs no equivalent, so the shared interface must not assume that every engine has a matching lifecycle.

**Note on engine scope**: M1 in `docs/roadmap.md` names Codex and Pi, but a run interface is only proven by more than two adapters. `agy` (Antigravity) is installed locally and is a third real engine; `opencode` was installed during this investigation. Broadening the adapter set is tracked through #6 rather than silently expanding M1.
