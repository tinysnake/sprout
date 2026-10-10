# Readiness probes never perform model inference

Environment admission needs truthful engine authentication and model-availability facts, but a hidden model request would spend quota, possibly incur cost, and perform work merely because the operator viewed health or a Worker reconnected. Treating an unknown fact as ready would be equally misleading.

We decided that an Environment readiness probe is Worker-executed and strictly non-inference: it may inspect executable/version state, use documented authentication-status operations, and read or fetch non-inference model metadata only when that operation cannot create model usage or cost. It never sends a prompt, starts a model turn, exports a credential, or uses a credential-printing mode. Heartbeat and reconnect do not trigger model work. A required engine or model that cannot be established through such a probe remains `unknown` and is ineligible for admission; it is never promoted to ready by assumption.

Later quota collectors or other observation sources may add current facts with explicit provenance, and a real Human-requested Agent run remains real work rather than a disguised probe. Neither source rewrites the historical readiness fact used by an earlier admission decision.

The Host Claude Code adapter follows the same non-inference boundary. It reads the exact model and configured effort from the read-only Claude Code user settings, checks CLI `2.1.294` and local isolation controls, and confirms configured authentication material is present without printing it. This establishes configuration readiness only: it does not validate the gateway token or the remote model route, and it never sends a prompt. The authorized resolved value is `group/auto-mimo-v2-6-flash[1m]`, a gateway alias that currently maps to a non-Claude model; no Claude-native model availability is claimed. A change to the accepted user configuration after readiness is refused.

**Consequences**

- Codex and Pi probe commands and outputs must be verified against pinned supported versions before implementation; a missing trustworthy operation is planning fog, not permission to weaken the boundary.
- Web-triggered probes execute through the authenticated Worker and report measured results. The browser cannot manufacture latency, authentication, or engine readiness facts.
- An Environment may remain Yellow and unable to admit work until its required engine and model have a trustworthy non-inference readiness source.

**Rejected alternatives**: optimistic admission from `unknown` hides the distinction between unavailable and unobserved; a minimal hidden prompt is still model work; treating executable presence as authentication or model availability collapses independent health dimensions that ADR-0008 and ADR-0009 require.

## Amendment: Explicit Human model authorization (#138)

Because account-level model entitlement cannot be proven by non-inference Worker commands (#114), the Worker approval ceremony introduces explicit per-model Human authorization as a legitimate readiness evidence source with provenance `human-approval`.

- **Evidence source and boundary**: The authorization records an operator's explicit entitlement belief for specific core-owned target models (engine + work model + requirement revision scope). It does not assert measured availability or bypass engine health: probe-measured facts remain distinct (e.g. model state `unknown`), no probe command is run, no prompt or inference turn is issued, and no credentials are read or transmitted.
- **Persistence boundary**: Authorization decisions are independent, append-only evidence snapshots, not Worker observations, probe results, or probe receipts. A cleared snapshot invalidates current entitlement while earlier decisions remain historical; the current Worker observation and its measured facts are unchanged.
- **Shared evaluation**: Shared readiness evaluation treats an `unknown` model availability fact with a matching, unrevoked Human authorization as admissible for Agent-run execution and catalog eligibility. All other unknown dimensions remain admission-blocking.
- **Invalidation**: Revocation or a requirement-scope change (modified target models or agent configuration revision) invalidates authorizations for affected targets, requiring a fresh Human decision.
- **Future collector**: When an automatic quota or account entitlement collector becomes available, it will supersede `human-approval` as the automatic evidence source without rewriting historical admission records.
