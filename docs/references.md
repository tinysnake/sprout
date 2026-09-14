# Reference repositories

Sprout does not develop in a vacuum. Two open-source MIT repositories are standing reference objects: when a feature area has a mature equivalent in one of them, that design (or code) is adopted by default instead of being built from zero. Deviations must be justified in the ticket's work record.

## Policy

- **Reference-first**: before implementing a feature, check the repositories below for an equivalent design. If a mature equivalent exists, adopt it by default; departing from it requires a stated reason.
- **Design or code**: references are used both for API/architecture/behaviour design and for direct code reuse. Cumora and Paperclip are MIT-licensed; AionUi is Apache-2.0. Copying is permitted under both, with the obligations below.
- **Attribution for copied code**: any file copied or ported from a reference repository must carry a header comment stating the source repository, the original path, and the commit hash it was taken from, plus the license notice (MIT notice; for Apache-2.0 also retain any NOTICE content and mark modified files as changed). The work record's `Changes` section registers the copy as well.
- **Pinned at time of use**: each act of referencing records the commit hash consulted at that moment (in the work record or file header). This file links the repositories but does not track upstream drift.
- **Domain language and seams win**: where a reference design conflicts with `CONTEXT.md` terminology or an established Sprout seam (engine port, environment worker, store interfaces), the Sprout model takes precedence, and the conflict is resolved explicitly in the work record rather than silently bending our language to fit a reference.

## Repositories

### Cumora

- **Repository**: <https://github.com/yetone/cumora>
- **License**: MIT
- **What it is**: cross-platform team chat where AI agents are first-class teammates, with cloud or bring-your-own agent brains.
- **Absorbed so far**:
  - The engine run seam (`EngineAdapter`/`EngineSession`) shaped `src/engine/port.ts` (see that file's header and ADR-0002).

### Paperclip

- **Repository**: <https://github.com/paperclipai/paperclip>
- **License**: MIT
- **What it is**: an open-source app for managing agents at work (teams, projects, agent management).
- **Absorbed so far**: none yet. Expected reference areas: team/project/agent permission models, agent run management, and task organisation. It has no equivalent to Sprout's environment lease model, so that area remains Sprout-original.

### AionUi

- **Repository**: <https://github.com/iOfficeAI/AionUi>
- **License**: Apache-2.0
- **What it is**: an open-source desktop cowork app that integrates 20+ CLI agents (Claude Code, Codex, OpenCode, and others) as assistants.
- **Absorbed so far**: none yet. **Primary expected reference area: engine integration code** — how a host application spawns, communicates with, streams from, supervises, and resumes each CLI agent (process/transport management, JSON output parsing, session handling, permission/CLI-flag plumbing). This is exactly Sprout's engine adapter layer (`src/engine/port.ts` and its adapters), so its implementation should be broadly checked against AionUi (and against how Cumora and Paperclip embed agent CLIs) before any new adapter work, to avoid re-stepping on known pitfalls.
