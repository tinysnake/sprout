# Agent instructions

## Development stage: aggressive restructuring is allowed

The project is in its **initial development stage**. Aggressive refactoring and replacement are acceptable: prefer the clean design over preserving legacy behavior, and do not spend effort on backward compatibility with old features. Breaking changes to internal APIs, storage shapes, and prototypes are expected; make the change that leaves the simplest correct result, and update tests and docs to match. (Do not break privacy, authority, and safety guarantees documented elsewhere in this file and in `docs/adr/`.)

## Privacy and sensitive information

Never commit or write any personal or sensitive information into the Git repository or issue tracker (including commit messages, issue bodies, issue comments, pull requests, work records, and documentation).

This rule applies strictly to:
- **Personal and host identities**: Real names, personal email addresses, local machine usernames, and machine hostnames.
- **Local environment paths**: Absolute paths containing user home directories (e.g. `/Users/<user>`, `C:\Users\<user>`). Always use relative paths, `~`, or generic placeholders.
- **Network infrastructure**: Private/local IP addresses (e.g. `10.x.x.x`, `192.168.x.x`), internal domain names, port bindings, and LAN topology.
- **Credentials and secrets**: API keys, authentication tokens, passwords, private keys, and session cookies.

When recording command outputs, probe results, test transcripts, or error logs, always sanitize them before writing: replace specific identities, IPs, and host paths with generic placeholders (such as `<user>@<windows-host>`, `~/.local/bin/...`).

## Tests and command output

Every command must be run with an explicit timeout, and no command may run longer than **3 minutes**.

Run the test suite with `npm test` and an explicit **180-second command timeout**, never with a raw `node --test ...` invocation. `npm test` prints the pass/fail counters and, only when something fails, the failing tests with their reason and location. A raw `node --test` prints every passing test, which floods an agent's context with material it already knows. Use `npm run test:full` only when every test name is genuinely needed, and redirect it to a file instead of reading all of it.

Filter large command output at the shell (`... | tail -40`, `rg -n 'fail|Error|not ok'`) rather than loading the whole output into context.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The repository uses the five default canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses a single-context layout. See `docs/agents/domain.md`.

### Reference repositories

Before implementing a feature, check `docs/references.md` for reference repositories with mature equivalent designs.

### Development control loop

When evaluating next work, selecting a roadmap outcome, assigning or accepting a task, recording implementation results, or replanning after completed work, follow `docs/agents/development-loop.md`.

### Human preview

Before preparing a human-facing preview, starting or stopping its service, or retaining or discarding its state, follow `docs/agents/preview.md`. Ask the Human before closing an existing instance or resolving a port conflict.
