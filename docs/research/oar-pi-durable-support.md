# OAR's current Pi Durable support

## Conclusion

`botiverse/oar` does not currently integrate Pi Durable. Its Pi runtime embeds the ordinary `@earendil-works/pi-coding-agent` SDK in process. It has researched Pi Durable's recovery contract, but has not adopted the separate harness.

The inspected default branch and latest repository tag are both **v0.28.0**, commit `86323f089734bdc55cb4cb087bc7e5e7ee1cff9c`, committed on 2026-10-07. The package manifest also declares `0.28.0`. The workspace selects Pi coding-agent SDK **1.0.4**. This is a source inspection, not a live OAR integration test. [O1–O5]

## Direct evidence

1. **Explicit documentation.** `docs/runtimes/pi.md` states: “Neither upgrade adopts the separate experimental Pi Durable harness.” It distinguishes ordinary conversation continuity from unfinished execution recovery. Its later version checks report continued SDK upgrades through 1.0.4 without an adapter change. [O1]
2. **Dependencies.** The library depends on `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`, both with the range `^1.0.2`; the workspace lock selects `1.0.4`. There is no `@earendil-works/pi-durable` dependency in the manifests or lockfile. Upgrading the coding-agent SDK to 1.0 does not implicitly adopt Pi Durable. [O2, O3]
3. **Execution code.** `packages/oar/src/runtimes/pi/open.ts` imports the coding-agent SDK and opens its `AgentSession` with native services and a `SessionManager`. It does not open a Pi Durable Harness or its checkpoint storage. The Pi documentation explicitly describes this as an in-process SDK integration, not a CLI subprocess. [O1, O4]
4. **Repository-wide search.** Mentions of “Pi Durable” occur in the Pi runtime documentation, version-check reports, and crash-resume research. No adapter or executable integration imports `pi-durable`. [O1, O6, O7]

## Why OAR mentions Pi Durable

OAR's `docs/runtimes/crash-resume.md` uses Pi Durable's recovery contract as a set of questions for existing runtimes: whether admitted input survives, whether partial output persists, what happens to an interrupted tool, and whether queued input survives. Its introduction says:

> OAR resumes a conversation by its native id; it does not resume execution.

The report describes live experiments on Claude, Codex, and Pi. Those are upstream observations at the specified versions, not guarantees established by this Sprout investigation. [O6]

| Runtime in that experiment | Version | Relevant observed behavior |
| --- | --- | --- |
| Pi | Coding-agent SDK 0.99.2 | Conversation input and completed assistant message survive; unconsumed steer and adapter-held queued input are lost; reopening does not restart the interrupted tool or automatically continue work. |
| Codex | 0.158.0 | Interrupted tool is not replayed; native queued input survives and starts a new turn automatically on reopen. |
| Claude | 2.1.284 | Interrupted tool is recorded with an uncertainty error; queued input is adapter-held and lost; a stopped background task can emit a notification/result on reopen. |

The report covers a killed process tree, including descendants. It does not prove that killing only a host process fences all external execution. It also records an open Claude result-attribution defect, so its experiment should be read as evidence with limits. [O6]

## Relevance to Sprout

OAR and Pi Durable address different seams:

- **OAR** unifies control and observation of existing agent runtimes, including Codex and ordinary Pi. It is a potential reference or dependency for Sprout's engine-adapter layer.
- **Pi Durable** owns an agent loop, its model/tool tasks, and its checkpointed execution. Adopting it would require a new engine integration and recovery-policy validation.
- **Sprout** retains Project and Task authority, Agent-run admission, Environment leases, authenticated Workers, fencing, reconciliation, and Human recovery decisions.

OAR cannot currently deliver Pi Durable's execution-checkpoint behavior to Sprout. Its cross-runtime crash-resume findings are nevertheless useful when evaluating adapters. In particular, the observed Codex queued-input auto-start conflicts with Sprout's no-automatic-run-replay policy if a future adapter exposes native queueing without an admission boundary. Any adoption needs version-specific verification; this finding does not establish that Sprout's current Codex adapter uses that queue. [O6, S1]

A Pi Durable runtime could theoretically be added behind OAR's runtime interface. No such adapter exists in the inspected version, and interface compatibility alone would not preserve all durable task, background-work, and recovery semantics. This is an architectural possibility, not announced upstream support.

## Previous report search and investigation limits

No previous `botiverse/oar` research report was found in Sprout's current Markdown files, historical research filenames across available Git refs, or the available Markdown history using the exact repository string. The historical Orca/Multica comparison concerns another project and is not an OAR report. This search does not rule out a report in another checkout, repository, or external notes.

Context7 lookup failed with `fetch failed`. The search-assisted preliminary result was outdated about the Pi version and execution mode; the conclusion above was checked against the directly downloaded repository source, current commit metadata, and tags. GitHub's latest-release endpoint returned 404; therefore the version is established from the repository tag and package manifest, not a GitHub Release object. No dependencies were installed into Sprout and no product code changed.

## Sources

All OAR code/document links are pinned to the inspected commit.

- **O1 — Pi runtime documentation:** <https://github.com/botiverse/oar/blob/86323f089734bdc55cb4cb087bc7e5e7ee1cff9c/docs/runtimes/pi.md>
- **O2 — Library manifest:** <https://github.com/botiverse/oar/blob/86323f089734bdc55cb4cb087bc7e5e7ee1cff9c/packages/oar/package.json>
- **O3 — Workspace lock:** <https://github.com/botiverse/oar/blob/86323f089734bdc55cb4cb087bc7e5e7ee1cff9c/pnpm-lock.yaml>
- **O4 — Pi session opening:** <https://github.com/botiverse/oar/blob/86323f089734bdc55cb4cb087bc7e5e7ee1cff9c/packages/oar/src/runtimes/pi/open.ts>
- **O5 — Version tag:** <https://github.com/botiverse/oar/tree/v0.28.0>
- **O6 — Crash-resume investigation:** <https://github.com/botiverse/oar/blob/86323f089734bdc55cb4cb087bc7e5e7ee1cff9c/docs/runtimes/crash-resume.md>
- **O7 — Pi 1.0 upgrade investigation:** <https://github.com/botiverse/oar/blob/86323f089734bdc55cb4cb087bc7e5e7ee1cff9c/experiments/runtime-version-checks/2026-10-02.md>
- **S1 — Sprout recovery policy:** [ADR-0009](../adr/0009-self-hosted-operation-and-recovery-promises.md)
- **Related investigation:** [Pi Durable's fit with Sprout](pi-durable-sprout-fit.md)
