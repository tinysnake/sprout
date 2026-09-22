# Readiness probes never perform model inference

Environment admission needs truthful engine authentication and model-availability facts, but a hidden model request would spend quota, possibly incur cost, and perform work merely because the operator viewed health or a Worker reconnected. Treating an unknown fact as ready would be equally misleading.

We decided that an Environment readiness probe is Worker-executed and strictly non-inference: it may inspect executable/version state, use documented authentication-status operations, and read or fetch non-inference model metadata only when that operation cannot create model usage or cost. It never sends a prompt, starts a model turn, exports a credential, or uses a credential-printing mode. Heartbeat and reconnect do not trigger model work. A required engine or model that cannot be established through such a probe remains `unknown` and is ineligible for admission; it is never promoted to ready by assumption.

Later quota collectors or other observation sources may add current facts with explicit provenance, and a real Human-requested Agent run remains real work rather than a disguised probe. Neither source rewrites the historical readiness fact used by an earlier admission decision.

**Consequences**

- Codex and Pi probe commands and outputs must be verified against pinned supported versions before implementation; a missing trustworthy operation is planning fog, not permission to weaken the boundary.
- Web-triggered probes execute through the authenticated Worker and report measured results. The browser cannot manufacture latency, authentication, or engine readiness facts.
- An Environment may remain Yellow and unable to admit work until its required engine and model have a trustworthy non-inference readiness source.

**Rejected alternatives**: optimistic admission from `unknown` hides the distinction between unavailable and unobserved; a minimal hidden prompt is still model work; treating executable presence as authentication or model availability collapses independent health dimensions that ADR-0008 and ADR-0009 require.
