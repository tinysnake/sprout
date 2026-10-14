---
Status: accepted
---

# Defer privacy hardening and content redaction to future work

The project owner has decided that privacy hardening and content redaction are future work. Earlier privacy requirements consumed disproportionate development and review effort and distracted from Sprout's current collaboration, execution, and Environment coordination goals. The owner explicitly directed that Agents must not deliberately build redaction features for privacy in the current stage.

## Current decision

Privacy hardening and content redaction are not acceptance criteria or review gates for the current product stage, including M2 and the early-use checkpoint. Agents must not add or expand filtering, masking, sanitization, redaction, privacy-specific projections, or privacy-only tests solely for privacy unless a later explicit product decision authorizes that work. This applies to model context, shared conversations and handoffs, Engine output, persistence, diagnostics, logs, and exports.

Existing privacy mechanisms may remain as implementation facts. Their presence creates no obligation to preserve, extend, or re-prove them solely for privacy. This documentation change does not remove those mechanisms or change runtime behavior. When implementation work changes them, update the affected documentation and obsolete tests under the new contract; do not skip required checks or report a failing suite as passing.

Context selection, bounded payloads, typed product records, and concise projections remain useful where required for relevance, token efficiency, understandable results, stable interfaces, or execution correctness. They must not become replacement names for an implicit privacy gate. Sprout does not promise that arbitrary model inputs, shared text, or diagnostic output are free of sensitive information.

Authentication, Project/WG membership and access permissions, Human decision authority, Worker identity and connection fencing, Engine execution controls, session ownership, leases, recovery, durability, idempotency, and truthful evidence retain their own contracts. Deferring privacy work does not authorize a new actor to read a protected conversation or perform an operation. Host-local credential ownership remains an execution/configuration responsibility, not a requirement to develop content scanners.

Repository and issue-tracker publishing hygiene remains governed by `AGENTS.md`: use generic examples and omit actual credentials and personal or private infrastructure details from published artifacts. Preparing such excerpts is not a product redaction feature and does not require building one.

## Authority and supersession

Authority: the project owner's explicit decision to remove privacy from current hard requirements, prohibit deliberately building privacy redaction features, and classify privacy attention and redaction as future plans, followed by authorization to apply that decision to documents and unfinished issues.

This decision supersedes privacy-specific preservation, filtering, exclusion, projection, diagnostic, and verification requirements in earlier ADRs and current specifications, including ADR-0001, ADR-0006, ADR-0007, ADR-0009, ADR-0015, ADR-0016, ADR-0017, and ADR-0019. It also supersedes blanket instructions to preserve all earlier privacy guarantees. Their independent authority, architectural, relevance, and execution requirements remain effective. Historical decisions, implementation observations, work records, and accepted evidence describe what was required or observed at the time and are not rewritten.

The development loop and roadmap apply this decision to planning, review, and acceptance. A privacy-only gap cannot block work, assembly, downstream implementation, or delivery under the current stage. Unfinished issues carrying superseded requirements must be amended and active assignments notified before their next review.

## Future work

Privacy controls, model-data protection, sensitive-content detection and redaction, diagnostic privacy, and dedicated privacy reviews belong to future product planning. Reintroducing any of them requires a later explicit product decision with a bounded goal, acceptance criteria, and justified investment; reaching a milestone or encountering an old requirement does not reactivate them automatically.
