## Privacy and sensitive information

Never commit or write any personal or sensitive information into the Git repository or issue tracker (including commit messages, issue bodies, issue comments, pull requests, work records, and documentation).

This rule applies strictly to:
- **Personal and host identities**: Real names, personal email addresses, local machine usernames, and machine hostnames.
- **Local environment paths**: Absolute paths containing user home directories (e.g. `/Users/<user>`, `C:\Users\<user>`). Always use relative paths, `~`, or generic placeholders.
- **Network infrastructure**: Private/local IP addresses (e.g. `10.x.x.x`, `192.168.x.x`), internal domain names, port bindings, and LAN topology.
- **Credentials and secrets**: API keys, authentication tokens, passwords, private keys, and session cookies.

When recording command outputs, probe results, test transcripts, or error logs, always sanitize them before writing: replace specific identities, IPs, and host paths with generic placeholders (such as `<user>@<windows-host>`, `~/.local/bin/...`).

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
