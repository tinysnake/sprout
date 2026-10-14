# Agent instructions

## Development stage: aggressive restructuring is allowed

The project is in its **initial development stage**. Aggressive refactoring and replacement are acceptable: prefer the clean design over preserving legacy behavior, and do not spend effort on backward compatibility with old features. Breaking changes to internal APIs, storage shapes, and prototypes are expected; make the change that leaves the simplest correct result, and update tests and docs to match. (Preserve authentication, authority, and execution/recovery safety guarantees documented elsewhere in this file and in `docs/adr/`.)

## Current product scope

[ADR-0020](docs/adr/0020-defer-privacy-hardening-and-redaction.md) defers privacy hardening and content redaction to future work. Do not add or expand privacy filtering, masking, sanitization, redaction, or privacy-only tests without a later explicit product decision. Privacy-only gaps are not current acceptance criteria or review blockers. Existing mechanisms do not create a preservation obligation solely for privacy. Authentication, access permissions, Human authority, and execution/recovery safety remain required.

## Repository and issue-tracker publishing hygiene

Never commit or write any personal or sensitive information into the Git repository or issue tracker (including commit messages, issue bodies, issue comments, pull requests, work records, and documentation).

This rule applies strictly to:
- **Personal and host identities**: Real names, personal email addresses, local machine usernames, and machine hostnames.
- **Local environment paths**: Absolute paths containing user home directories (e.g. `/Users/<user>`, `C:\Users\<user>`). Always use relative paths, `~`, or generic placeholders.
- **Network infrastructure**: Private/local IP addresses (e.g. `10.x.x.x`, `192.168.x.x`), internal domain names, port bindings, and LAN topology.
- **Credentials and secrets**: API keys, authentication tokens, passwords, private keys, and session cookies.

Prepare published command excerpts, probe results, test transcripts, and error logs using generic identities, addresses, and paths (such as `<user>@<windows-host>`, `~/.local/bin/...`), and omit actual secrets. This publishing rule does not require developing or preserving product redaction features.

## Tests and command output

Every command must be run with an explicit timeout, and no command may run longer than **3 minutes**.

Run the test suite with `npm test` and an explicit **180-second command timeout**, never with a raw `node --test ...` invocation. `npm test` prints the pass/fail counters and, only when something fails, the failing tests with their reason and location. A raw `node --test` prints every passing test, which floods an agent's context with material it already knows. Use `npm run test:full` only when every test name is genuinely needed, and redirect it to a file instead of reading all of it.

For routine local edits a full run is unnecessary: use `npm run test:quick` after meaningful implementation edits, `npm run test:affected` when implementation work completes or a ticket is reviewed, and the full `npm test` on the final composed result before integration. Membership, triggers, and widening rules are project-owned in `docs/test-selection.md`; `npm run test:audit` proves the tiers still cover the full inventory exactly.

Filter large command output at the shell (`... | tail -40`, `rg -n 'fail|Error|not ok'`) rather than loading the whole output into context.

Each `npm test` run streams sanitized per-run records (results, durations, disposition) to the Git common directory's `observations/test-runs/` and survives worktree reclamation. Inspect them with `node scripts/test-observations.ts`; override the location with `SPROUT_TEST_OBS_DIR`.

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
