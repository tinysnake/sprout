# Sensitive-data sanitization before model export

Research findings for Ticket #178 (blocker of #97, Run scope #77).

Every external claim below was verified by reading the primary source (repository file or
official documentation) at a pinned commit, resolved 2026-09-29. Licenses are as reported by
the repository at that commit. No real secret, host fact, or personal data appears in this
document; all quoted values are synthetic fixtures, regex patterns, or placeholder names.

---

## 1. The problem this research addresses

ADR-0007 imposes a two-sided constraint on the bounded routing context sent to the wake model
(`docs/adr/0007-message-and-wake-routing-semantics.md`, consulted at `278f73cc`):

- **Include** (lines 138–144): each batch input's identifier, kind, author, time, **content**,
  and reply/thread relationship; the Project goal and rules; candidate Agent identifiers,
  responsibilities and collaboration instructions; bounded recent Project-channel context;
  curated Task state; the policy/bounds/truncation markers.
- **Exclude** (lines 153–158): "direct Messages and their replies, Agent-private memory, raw
  reasoning, engine-native sessions, full run transcripts, tool output, credentials, host
  identity, private network facts, or uncurated internal events."

The `human-required` diagnosis on #97 (comment linked from the issue's Dev Pipeline history,
job `m77-diagnostician-a1`) established that the current implementation satisfies neither side
reliably: `src/collaboration/routing-context.ts` (at `099b6372`, branch `m77-ticket-97-r3`)
applies `redactSensitiveText` to otherwise unrestricted strings at lines 151–157, 197, 253,
273, 310, 320, 336–337; `src/environment/privacy.ts` (at `278f73cc`, lines 114–225, function at
line 233) preserves anything outside its enumerated patterns; the coordinator sends the stored
snapshot unchanged (`src/collaboration/coordinator.ts` at `099b6372`, lines 1073–1077,
`this.#routingModel.judge({ … context: current.context … })`). A reviewer's unlabelled
base64 probe survived all three stages and reached the model call. The diagnosis's attribution:
**"an allowed source plus a negative text scan establishes permission to export its contents" is
the recurring false assumption** — a field/source allowlist containing arbitrary strings is not
a value allowlist.

The owner's question for this research: how do established open-source projects sanitize
sensitive data before model/log export, and which of the observed designs correspond to
(closed-format fact projection) versus (owner-defined source contract)?

---

## 2. Taxonomy of approaches

Five families appear in the surveyed projects. For each: where it sits, what it guarantees, and
what it cannot guarantee.

### 2.1 Pattern / entropy scanning (negative detection)

- **Where it sits**: before persistence, before send, or at a logging sink — applied to free
  text of unknown provenance. It is the only family that works on arbitrary prose without a
  schema.
- **Guarantees**: values matching the *known* shapes (vendor key prefixes, credential
  assignments `key=value`, PEM blocks, URLs with userinfo, JWTs) are replaced. Entropy and
  keyword gating raises recall for generic opaque tokens. A cheap keyword/prefix pre-screen can
  be made false-negative-free *for the patterns themselves* (Hermes explicitly derives its
  pre-screen from its pattern list so the gate cannot miss a pattern).
- **Cannot guarantee**: (a) detection of unknown/unlabelled encodings — the F7 base64 probe is
  exactly this class; (b) that ordinary words are not secrets; (c) absence of false positives
  that destroy legitimate content. Codex states the limit in its own doc comment: redaction is
  "done on best effort basis following some well-known REGEX." Gitleaks/detect-secrets treat
  entropy as a *reporting* signal with human triage (baselines/allowlists), not as proof.
- **Evidence**: §3.1.

### 2.2 Source-side allowlist of structured fields (producer-side admission)

- **Where it sits**: at the producer/builder — only enumerated sources/keys are copied into the
  exported artifact; everything else never enters it.
- **Guarantees**: *key-level* fail-closed behavior: an unlisted field cannot leak, because it
  is never rendered. OpenTelemetry's redaction processor documents this explicitly: "The list
  is designed to fail closed. If `allowed_keys` is empty, no attributes are allowed and all
  span attributes are removed."
- **Cannot guarantee**: the *content* of an allowed field that is itself free text. This is
  precisely diagnosis D3. Sentry, LiteLLM's masker, and Cline's cassette recorder all key their
  redaction on field *names* — safe for JSON keys, insufficient for a `Message.body` that a
  member filled with arbitrary prose.
- **Evidence**: §3.2.

### 2.3 Closed-format fact projection with a declassification authority (positive admission)

- **Where it sits**: at the producer, before the exported artifact is even built — a value
  crosses only if it is an instance of a finite, product-owned fact vocabulary; anything
  unrepresentable is withheld, and a designated authority (code or role) decides what the
  vocabulary may express.
- **Guarantees**: a positive admission contract. Because only enumerated fact kinds/enums and
  validated bounded values can be rendered, an opaque base64 string is not *representable* —
  the F7 class cannot cross by construction. This is the only family that answers the
  diagnosis's demand for a value-level contract rather than a growing example list.
- **Cannot guarantee**: utility — content that does not fit the vocabulary disappears from the
  model's view (the diagnosis itself frames this as the owner's product decision: withhold and
  "visibly fail routing when adequate safe facts are unavailable"). It also cannot help data
  that is already free text at the moment of ingestion.
- **Closest analogues in the wild**: OTel's `allowed_keys` fail-closed list (§3.2) applied to
  message-shaped data; LangChain's per-rule `block` strategy (§3.3); Presidio's
  analyzer-results → operator replacement pipeline (§3.3); Codex's type-level
  `RedactedString` (a value that structurally cannot be printed). No surveyed project does
  exactly this for arbitrary chat prose — the closest real-world execution is Magpie's
  deterministic placeholder projection (§3.4), which replaces values by a closed placeholder
  grammar instead of letting raw bytes cross.
- **Evidence**: §3.3.

### 2.4 Output / egress guard at the boundary (choke point)

- **Where it sits**: immediately before bytes leave the trust domain — before the provider
  call, before a log sink leaves the process, before a response returns to the agent.
- **Guarantees**: a single enforced checkpoint; if the boundary is unavoidable, *no* bytes
  cross without being scrubbed, and the scrub can fail closed (Hermes: "Fails CLOSED: if the
  redactor raises, the raw text is never returned" — it returns `[redaction-unavailable]`
  instead). Magpie adds an important refinement: the guard is **reversible** — it masks values
  to stable keyed-hash placeholders on the way out and restores them on the way back, so
  history stays coherent while the vendor never sees the raw bytes.
- **Cannot guarantee**: detection of unknown shapes (inherits §2.1's limits); it does nothing
  for surfaces that bypass the boundary. Hermes documents this failure mode verbatim: its tool
  call arguments were masked at one surface while "the same secret still leaks verbatim
  through tool OUTPUT (file contents, command output, diffs, the compaction block), none of
  which this pass ever touched" — masking also broke replay (model copied `***` into the next
  command), so Hermes *removed* argument-level masking (#43083) and kept secrets out of the
  replayable store by other means.
- **Evidence**: §3.4.

### 2.5 Never-in-band key handling (avoidance)

- **Where it sits**: at infrastructure/producer level — the credential never appears in the
  text, config file, transcript, or history that other mechanisms must then scrub.
- **Guarantees**: for *Sprout-owned* credentials, nothing to leak: a placeholder or short-lived
  token in band, the real key behind an env injection, OS keychain, or a local proxy that swaps
  it at the boundary (Magpie writes its own gateway token into agent settings and injects the
  vendor key server-side; Git credential helpers keep passwords out of the repository; GitHub
  Actions OIDC exchanges a workflow's short-lived token per deployment).
- **Cannot guarantee**: anything about data that arrives in band from humans — a member can
  paste a credential into a Message. Sprout's ADR-0004/ADR-0012 already keep engine-session
  keys and enrollment identities never-in-band; this family therefore narrows the problem to
  third-party/user-pasted content, it does not solve #97 alone.
- **Evidence**: §3.5.

---

## 3. Reference code, pinned and quoted

### 3.1 Family 1 — Pattern / entropy scanning

#### Hermes (owner-named lead) — `NousResearch/hermes-agent`

- Repo: <https://github.com/NousResearch/hermes-agent>, branch `main`,
  commit `3632f9173d218fd24f3fa595d7affa159b0774cd`, license **MIT**.
- Primary file: `agent/redact.py` (1,354 lines at that commit).

How it works — three layers in one module:

1. **Vendor-prefix pattern list.** `_PREFIX_PATTERNS` (line 141 onward) is an ordered list of
   ~60 literal-prefixed regexes (`sk-…`, `ghp_…`, `AKIA…`, `xox[baprs]-…`, `AIza…`, JWTs,
   GitLab families, …). The module comment mandates the pre-screen invariant:
   "Every pattern MUST start with a literal prefix: `_PREFIX_SUBSTRINGS` (the cheap pre-screen
   gate) is derived from these literals and must stay false-negative."
2. **Context-aware assignment passes** for values with *no* vendor prefix: env
   (`_ENV_ASSIGN_RE`), config/INI/YAML (`_CFG_DOTTED_RE`, `_CFG_ANCHORED_RE`,
   `_YAML_ASSIGN_RE`), JSON fields (`_JSON_FIELD_RE`), Python repr fields, URL query params
   (`_SENSITIVE_QUERY_PARAMS`), form bodies, plus an opacity heuristic
   (`_looks_like_opaque_credential`: length ≥ 16 hex, or ≥ 20 token-chars, or ≥ 12 chars with
   2 of 3 character classes).
3. **Exact-value registry for unmodelled secrets** — the vault path (lines 22–74):
   > "Exact secret values that transited a server-side vault fill … Generic credential-shaped
   > regexes cannot catch an arbitrary user password, so the fill path registers the exact
   > bytes and every browser_* tool result … is scrubbed against them before it can reach the
   > model. Memory only: never persisted or logged." Bounded to 64 values per profile,
   > longest-first replacement.

Where it is applied:

- **Monitoring/log egress** — `agent/monitoring/redaction.py`: "One unconditional scrub, no
  modes, no knobs. Every string that leaves the process passes through `redact_for_export`:
  secrets via `agent/redact.py::redact_for_egress` (the single pattern source; **fails CLOSED**
  so a broken redactor never emits the raw string), then PII (e-mail, phone, UUID-shaped ids)."
  `redact_for_egress` (in `agent/redact.py`, line 1152) returns
  `REDACTION_UNAVAILABLE = "[redaction-unavailable]"` on exception.
- **Before storage/history** — `agent/chat_completion_helpers.py`,
  `_assistant_content_for_storage`: assistant content is stripped of think blocks "then redact
  inlined credentials before the message enters history / state.db / gateway delivery".
- **Policy switch**: `HERMES_REDACT_SECRETS` is snapshotted **at import time** so "runtime env
  mutations (e.g. an LLM-generated `export HERMES_REDACT_SECRETS=false`) cannot disable
  redaction mid-session"; `redact_sensitive_text(..., force=True)` bypasses the switch at
  safety boundaries.

Documented **limits** (quotable, from `agent/chat_completion_helpers.py`, lines 1641–1657):

- Tool-call arguments are deliberately *not* redacted, because the dict is replayed to the
  model each turn: masking "poisons that replay: the model reads back its own
  `PGPASSWORD='***' psql ...` call and copies the placeholder into the next tool call".
- "The masking also provided no real protection — the same secret still leaks verbatim through
  tool OUTPUT … Keeping secrets out of the replayable store is a separate tokenization/vault
  concern, not something arg-redaction can deliver without breaking replay."

**Mapping to Sprout.** Hermes is essentially `src/environment/privacy.ts` taken to production
scale, plus two ideas Sprout lacks: the *fail-closed* egress wrapper (`redact_for_egress`)
around `RoutingModelPort.judge`, and the *exact-value registry* — a routing analogue would let
Sprout register values it has already classified as sensitive (e.g. an engine session key that
ever appears in shared prose) so they are scrubbed by identity, not by shape. Hermes's own
#43083 lesson is a direct warning for `routing-context.ts`: scrubbing Message *content* while
manifest fields (responsibilities/collaboration instructions) carry the same strings is the
"one surface masked, another surface leaks" failure the diagnosis already reproduced (7/7
injection points survived).

#### yetone/magpie (owner-named lead)

- Repo: <https://github.com/yetone/magpie>, branch `main`,
  commit `899ddf594ce41ad2458ff071e9ffa66899728ade`, license **MIT**.
- Primary files: `internal/redact/redact.go`, `internal/redact/rules.go`,
  `internal/redact/writer.go`, `internal/gateway/redact.go`.

Mechanism (package doc, `internal/redact/redact.go`):

> "Package redact keeps secrets on the machine. What the gateway sends a vendor has its
> secrets (API keys, private keys, tokens, passwords in connection strings and assignments),
> and when asked personal data and the user's own words, swapped for placeholders like
> `{{API_KEY_k3v9x2mq}}`; what the vendor says back has them swapped back, streams included,
> so the agent and the user see the real thing while the vendor never does."

Key properties, all read at the pinned commit:

- **Two-way boundary.** `internal/gateway/redact.go`: `redacted(w, body)` masks the request
  ("before it goes to a vendor") and wraps the `http.ResponseWriter` so "what the vendor
  answers has them back"; `internal/redact/writer.go` rehydrates streaming responses event by
  event, holding back a split placeholder across SSE deltas so "the text the agent puts
  together is the same".
- **Stable, injective placeholders.** "A placeholder is the same for the same value every time
  (a keyed hash of it), so a conversation's history reads the same turn after turn — what a
  vendor cached of it stays good, and a thinking block's signature still matches the text it
  was made for — and one placeholder is never two values. The values are held in memory only,
  by placeholder… a restart loses nothing."
- **Rule set** (`rules.go`/`redact.go`): `PRIVATE_KEY`, `API_KEY` (`sk-…`, `gh[pousr]_…`,
  `glpat-…`, `AIza…`, `AKIA/ASIA…`, `hf_…`, `gsk_…`, `xai-…`, `SG.…`), `TOKEN` (JWT),
  `PASSWORD` (URL userinfo), `SECRET` (assignment with a secret-named field: `password`,
  `secret`, `token`, `api_key`, `credential`…) — each with `markers` (cheap substring
  pre-screen), `bound` (token-boundary characters, "a key inside a longer word is no key"),
  and a `secretValue`/`notAVariable` validator that rejects `${PASS}`, `process.env`,
  `os.`, and `****`. Optional `personal` rules (email, phone, CN ID, bank card with Luhn) and
  user-declared `Words`/`Rules`.
- **Bounded user-authored vocabulary** (`internal/redact/rules.go`): Settings → Privacy lets
  the user register custom rules for "a secret magpie's own rules don't know, a gateway's key
  say" — capped at `MaxRules = 32`, `maxRegex = 300` chars, with placeholder-kind validation —
  i.e. declassification by explicit, bounded registration rather than by growing regex reach.
- **Failure posture**: if nothing matches (`n == 0`) the body passes unmodified — masking is
  *opportunistic at the boundary*, not fail-closed.

**Limits**: still pattern-driven for secrets (an unlabelled opaque value with no named field
and no vendor prefix is not masked); reversibility means the raw values exist in gateway
memory; `personal` coverage is locale-skewed (CN phone/ID).

**Mapping to Sprout.** Magpie is the clearest existence proof for a *boundary projection*
family: a closed placeholder grammar crosses the boundary, raw bytes do not, and determinism
keeps downstream consumers (history, signatures) stable. Sprout's analogue would be at
`RoutingModelPort.judge` (`coordinator.ts:1073–1077`): render `current.context` through a
deterministic, keyed placeholder/templating step before send. Unlike Magpie, Sprout's wake
model does not need the answer back — rehydration is unnecessary — so the projection can be
one-way, which is strictly simpler.

#### Secret scanners (family representatives)

| Repo | Commit | License | Path |
|---|---|---|---|
| gitleaks/gitleaks | `b58d3f102cf3a2c84cb7f923d05c25c9b1aed84b` | MIT | `config/gitleaks.toml` |
| Yelp/detect-secrets | `5e141933554a0b74e7341841f318be21e895339c` | Apache-2.0 | `detect_secrets/plugins/high_entropy_strings.py`, `detect_secrets/pre_commit_hook.py` |
| trufflesecurity/trufflehog | `48b58d3bf3f02ba17bf23b87f095499bc80c6fd7` | AGPL-3.0 | `pkg/detectors/generic/generic.go`, `pkg/detectors/detectors.go` |
| awslabs/git-secrets | `7d6b970cbd3c216353cb22b383b70c150140662e` | Apache-2.0 | `git-secrets` |

- **gitleaks** — each rule is regex + entropy floor + keyword pre-screen + allowlists. The
  `generic-api-key` rule (`config/gitleaks.toml`, lines 638–656): a keyword-anchored regex,
  `entropy = 3.5`, `keywords = ["access","api","auth","key","credential","creds","passwd","password","secret","token"]`,
  followed by `[[rules.allowlists]]`. 130 `entropy` occurrences in the default config —
  entropy is a *threshold on candidates the keywords already surfaced*, never a standalone
  verdict.
- **detect-secrets** — `HighEntropyStringsPlugin` computes Shannon entropy against a charset
  limit "0.0 to 8.0" on quoted strings and reports findings; the governance mechanism is the
  **baseline**: `pre_commit_hook.py` scans staged files and subtracts the recorded baseline
  (`new_secrets = secrets - args.baseline`), failing only on *new* findings — i.e. human
  adjudication is part of the design.
- **trufflehog** — generic detector: `keywords = []string{"pass","token","cred","secret","key"}`
  pre-filter chunks ("Keywords are used for efficiently pre-filtering chunks"), candidate
  extraction, and an explicit exclude list (UUIDs, hex colors, IPs, dates, versions, MACs,
  paths). `pkg/detectors/detectors.go` shows the discipline around *reporting*: `Result.Redacted`
  exists for display, verification errors are redacted on store (`SetVerificationError`:
  "Any sensitive values should be passed-in as secrets to be redacted"), and
  "verification errors are not exported, to prevent the accidental storage of sensitive
  information in them."
- **git-secrets** — a pre-commit gate: prohibited patterns live in git config
  (`secrets.patterns`, `secrets.providers`), `--add-allowed-pattern` carves explicit
  exceptions, and `--scan-history` checks the past. Producer-side, human-governed.

- **GitHub secret scanning** — official pattern catalogue (documentation, not a repo):
  <https://docs.github.com/en/code-security/reference/secret-security/supported-secret-scanning-patterns>
  (verified HTTP 200 at the redirect target). GitHub publishes 300+ provider-maintained
  patterns as a *detection* service for pushed content — same family, industrialized. No
  public ruleset repository exists (`github/secret-scanning` returns 404), so this source is
  cited as documentation only, without a commit pin.

**Mapping to Sprout.** The scanner family defines what `src/environment/privacy.ts` already is
(pattern list + keyword anchors + value heuristics) and, crucially, what it is *for* in these
projects: **pre-persistence hygiene with human triage**, never a proof of safety at an export
boundary. Sprout's #97 use demands the latter, which none of these projects claim to provide.

### 3.2 Family 2 — Source-side allowlist of structured fields

#### OpenTelemetry Collector `redaction` processor

- Repo: open-telemetry/opentelemetry-collector-contrib, commit
  `af475283d7efcc8b1a038cf83d59a6a227459b71`, license **Apache-2.0**,
  `processor/redactionprocessor/README.md`.

> "This processor deletes span, log, and metric datapoint attributes that don't match a list of
> allowed attributes. It also masks attribute values that match a blocked value list.
> Attributes that aren't on the allowed list are removed before any value checks are done."

Configuration semantics (README example): `allowed_keys` "is designed to fail closed. If
allowed_keys is empty, no attributes are allowed and all span attributes are removed";
`ignored_keys`/`ignored_key_patterns` are explicit escapes; `blocked_values` regexes mask
matching values *of allowed keys* (e.g. card numbers); `allowed_values` re-permits; and
`hash_function: md5` (or any configured hash) replaces masking with hashing. The README also
concedes scope: "The redaction processor is intended as one line of defence rather than the
only compliance measure in place."

**Mapping to Sprout.** This is the precise industrial spelling of "allowlist + value scan" as a
*composition*: keys decide admission (fail-closed, structural), value patterns are a second,
weaker layer, and exceptions are explicit named lists — not silent. Applied to Sprout, the
manifest fields (input identifiers, kinds, times, candidate ids) are `allowed_keys`; Message
*content* is a value of an allowed key and needs either `blocked_values`-style treatment or a
different admission rule. Sprout's current code applies the value scan but has no fail-closed
key list at the value level — the diagnosis's exact gap.

#### Sentry Python SDK event scrubber

- Repo: getsentry/sentry-python, commit `2a499ec49cb07111d4a45cdfd8e75f633f11255e`,
  license **MIT**, `sentry_sdk/scrubber.py` (applied from `sentry_sdk/client.py`,
  `event_scrubber.scrub_event(event)` at line 886, on by default when data collection is
  default).

`DEFAULT_DENYLIST` is a **field-name list** ("stolen from relay"): `password`, `secret`,
`api_key`, `token`, `authorization`, cookies/CSRF names per framework; `DEFAULT_PII_DENYLIST`
adds `ip_address`, `x_forwarded_for`, … — values under those keys are replaced wherever they
appear in the event (headers, cookies, request data), recursively.

**Mapping to Sprout**: the same shape as `ROUTING_CONTEXT_EXCLUSIONS` + field rendering in
`routing-context.ts`, but enforced as *key-name* rules over the serialized object rather than
as prose printed into the prompt. Key-name scrubbing is robust "regardless of the value
format" — for objects.

#### LiteLLM `SensitiveDataMasker`

- Repo: BerriAI/litellm, commit `ffb15f946f586c102bf0359b2fa9ac46b340b658`,
  license **MIT** (enterprise/ directory excepted per `LICENSE`),
  `litellm/litellm_core_utils/sensitive_data_masker.py`.

Key-segment matching with an override list: `_DEFAULT_SENSITIVE_PATTERNS` (`password`,
`secret`, `key`, `token`, `auth`, `authorization`, `cookie`, `credential(s)`, `access`,
`private`, `certificate`, `fingerprint`, `tenancy`) and `non_sensitive_overrides = {"cost"}` —
"`input_cost_per_token` contains 'token' but 'cost' overrides that — it's a pricing field, not
a secret." Masks with visible prefix/suffix (`visible_prefix = 4`, `visible_suffix = 4`).

#### Cline cassette recorder (key-based redaction at a persistence boundary)

- Repo: cline/cline, commit `01176459b7194efa83d2dd8a0c3377e92fbc0719`,
  license **Apache-2.0**, `sdk/packages/shared/src/vcr.ts`.

> "Sanitization is key-based: any JSON key whose name matches a rule gets its value redacted.
> This is more robust than regex-matching values, because it works regardless of the value
> format."

Applied when recording HTTP interactions to cassettes — i.e. **before persistence**, to data
that will later be replayed and read by humans. (Cline additionally runs
`gitleaks git --pre-commit --redact --staged` in `.husky/pre-commit` for repository hygiene.)

#### Gemini CLI environment sanitization

- Repo: google-gemini/gemini-cli, commit `38700b4b38bf387dafded6c97c3f190d084b49e9`,
  license **Apache-2.0**, `packages/core/src/services/environmentSanitization.ts` and
  `packages/core/src/telemetry/sanitize.ts`.

`sanitizeEnvironment(processEnv, config)` keeps only variables that survive
`allowedEnvironmentVariables` / `blockedEnvironmentVariables` (+ `enableEnvironmentVariableRedaction`,
with `ALWAYS_ALLOWED_ENVIRONMENT_VARIABLES` such as `PATH`), so a redacted env snapshot — not
the live environment — is what downstream surfaces see. `sanitizeHookName` strips "full file
paths that may contain usernames / command arguments that may contain credentials, API keys,
tokens" from telemetry by *projecting to the base command name* — a miniature closed-format
projection for one field.

### 3.3 Family 3 — Closed-format fact projection with declassification authority

No surveyed project ships exactly Sprout's proposed mechanism for free chat prose, but four
components exist and are citable:

#### LangChain PII/redaction agent middleware

- Repo: langchain-ai/langchain, commit `a9780cd3dd73135d21d7130b08711685f2700d51`,
  license **MIT**, `libs/langchain_v1/langchain/agents/middleware/_redaction.py` and `pii.py`.

`RedactionStrategy = Literal["block", "redact", "mask", "hash"]` — per-rule, product-owned
strategies including **`block`** (`PIIDetectionError` raised when "configured to block on
detected sensitive values"): a declassification decision expressed as configuration. Detectors
are named functions (`detect_email`, `detect_credit_card` with Luhn, `detect_ip`, `detect_url`).
`pii.py` applies this as `AgentMiddleware` — including a **stream transformer** that holds a
128-character lookback buffer so "PII patterns straddling delta boundaries are caught" and
"the redacted text is what every downstream consumer sees".

**Mapping to Sprout**: the `block` strategy is the LangChain spelling of "withhold rather than
guess" — the #97 option-A behavior (withhold unrepresentable content, fail visibly) — applied
at an agent hook that wraps the model call, i.e. exactly where `RoutingModelPort.judge` sits.

#### Presidio anonymizer

- Repo: microsoft/presidio, commit `d4ccc6bcb6b6a7144336fe93b7839e61e251301b`,
  license **MIT**, `presidio-anonymizer/presidio_anonymizer/anonymizer_engine.py`.

`AnonymizerEngine.anonymize(text, analyzer_results, operators)` replaces detected entities
with per-entity operators (`{"PHONE_NUMBER": OperatorConfig("redact", {})}`), with merge
strategies for overlapping spans. The architecture separates *recognition* (analyzer, pluggable
recognizers) from *declassification* (operators: redact/replace/hash/encrypt, plus a
`deanonymize_engine` for reversibility). This is the canonical "entity → operator → bounded
replacement" pipeline; `docs/samples/deployments/redacting-telemetry` shows it used for log
egress.

#### Codex type-level redaction

- Repo: openai/codex, commit `17a9df60e420b58e3edc55efb1bb052e39492bbc`,
  license **Apache-2.0**, `codex-rs/utils/redacted-string/src/lib.rs`:
  `RedactedString` — "A string whose `Debug` output is redacted": `fmt::Debug` writes
  `<redacted>` unconditionally, so a typed value structurally cannot leak via debug/log
  formatting while the inner value stays available to authorized code paths.

#### NeMo Guardrails model-based PII rails

- Repo: NVIDIA/NeMo-Guardrails, commit `83d03ad529d2be1399f1dede24be59d4381ee42e`,
  license **Apache-2.0** (per `LICENSE.md` SPDX),
  `docs/configure-rails/guardrail-catalog/pii-detection.mdx`.

GLiNER-PII NIM classification on input/output with a confidence `threshold` and a declared
entity list (`email`, `phone_number`, `ssn`, `credit_debit_card`, …), wired as
`rails: input: flows: - gliner detect pii on input`. **Model-based detection** replaces the
regex list with a classifier — better recall on unlabelled formats, at the cost of a
probabilistic gate (no fail-closed guarantee, needs a running model). Citable as the "guardrail
tool" end of the spectrum.

### 3.4 Family 4 — Output / egress guard at the boundary

- **Magpie gateway** — see §3.1 (`internal/gateway/redact.go` + `writer.go`): the boundary is
  the local HTTP hop to the vendor; request masked, response rehydrated, streaming supported.
- **Hermes `redact_for_egress`** — see §3.1: single choke point for "text leaving the process
  for a remote reader", fail-closed to `[redaction-unavailable]`, plus the monitoring module's
  unconditional secret→PII two-stage scrub.
- **LiteLLM callback redaction** — `litellm/litellm_core_utils/secret_redaction.py` owns "the
  compiled regex and the public `redact_string` helper so that any part of the codebase
  (logging, exception mapping, etc.) can scrub secrets from strings" (PEM blocks, `ya29.*`,
  AWS IDs, `Bearer …`, `Basic …`, `sk-…`, URL query `api_key=…`, `x-api-key`, …).
  `redact_messages.py` then scopes it per consumer: callbacks that opt out of
  `message_logging` receive redacted *copies* — "The shared model_call_details is left
  untouched so other callbacks still receive the unredacted response." That is a
  per-egress-destination declassification decision at one boundary.
- **Claude Code (agent product, documented behavior)** — repo anthropics/claude-code, commit
  `684800b206824dfd0cc8a876e8604b20f72c3617`, license **proprietary** (Anthropic Commercial
  Terms; `LICENSE.md`). The redaction implementation is not in the public repo, but
  `CHANGELOG.md` documents the behavior repeatedly: "Fixed redacted logs and transcripts
  showing part of a URL password that contains `@`…"; "Improved MCP connection and OAuth
  debug/error logs so credentials carried in a server's URL or request headers are redacted";
  OpenTelemetry `user_prompt` / `assistant_response` events are "Redacted unless
  `OTEL_LOG_ASSISTANT_RESPONSES=1`"; feedback-survey transcript shares: "Secrets are redacted
  as before". So: transcripts, logs, and telemetry all pass a redaction step before they leave
  the machine — the same choke-point pattern as Hermes, with the algorithm closed.
- **Codex `redact_secrets` call sites** — `codex-rs/secrets/src/sanitizer.rs` (quoted in §3.1
  table below) is applied at export-shaped surfaces found by code search at the pinned commit:
  `memories/write/src/phase1.rs` / `rollout_input.rs` / `phase1_output.rs` (memory/rollout
  summaries: `redact_secrets(serialized)`), `app-server-protocol/src/protocol/item_builders.rs`
  (`command: redact_secrets(shlex_join(command))`), `login/src/gateway_auth_token.rs`
  (rejection details). Also `thread_resume_redaction.rs`: for remote clients, thread/resume
  responses replace MCP tool arguments/results wholesale with `"[redacted]"` — *category-level*
  withholding at an egress surface.
- **Cline/Continue/Claude-Code-adjacent negative results** (recorded for completeness):
  Cline's `apps/vscode/src/sdk/initial-message-sanitizer.ts` is about tool-use pairing, not
  secrets; Continue's `core/util/sanitization.ts` is shell/URL injection hardening. Neither
  repo documents prompt-content secret redaction; Continue's contribution is instead the
  *pre-egress file exclusion* below.

| Repo | Commit | License | Path | One-line description |
|---|---|---|---|---|
| openai/codex | `17a9df60e420b58e3edc55efb1bb052e39492bbc` | Apache-2.0 | `codex-rs/secrets/src/sanitizer.rs` | `pub fn redact_secrets` — "best effort" regexes for Bearer/`sk-`/`AKIA`/`secret=` → `[REDACTED_SECRET]`, with explicit false-positive tests ("Bearer of good news" preserved) |
| BerriAI/litellm | `ffb15f946f586c102bf0359b2fa9ac46b340b658` | MIT | `litellm/litellm_core_utils/secret_redaction.py`, `redact_messages.py` | shared scrub helper + per-callback redacted copies |
| anthropics/claude-code | `684800b206824dfd0cc8a876e8604b20f72c3617` | proprietary | `CHANGELOG.md` | documented redaction of logs, transcripts, OTel events |
| yetone/magpie | `899ddf594ce41ad2458ff071e9ffa66899728ade` | MIT | `internal/gateway/redact.go`, `internal/redact/writer.go` | reversible boundary mask/rehydrate, streaming-safe |

### 3.5 Family 5 — Never-in-band key handling

- **Magpie** — the *inverse* of redaction, and its primary design: agents are configured with a
  local gateway URL and Magpie's own token instead of vendor keys. Code search at the pinned
  commit shows the injection surface: `internal/agent/claude.go`
  (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` in `~/.claude/settings.json`'s `env` block),
  `internal/agent/kimi.go` (`edit.KV{Path: "api_key", Value: gateway.Token}`),
  `internal/agent/hermes.go`, `internal/agent/cline.go`, `internal/agent/agy.go`
  (`GEMINI_API_KEY="<gateway token>"`). The real vendor key is injected by the gateway at the
  loopback boundary, so it never appears in agent config files, shell history, or transcripts.
  `internal/gateway/lan.go` records the threat-model assumption ("The gateway listens on
  loopback and takes any token, which is safe only…").
- **Git credential helpers** — git/git, commit `a018953688f1b10bddf91bff8747068f5f4746a4`,
  license **GPL-2.0** (`COPYING`: "v2, not … v3"), `Documentation/gitcredentials.adoc`:
  credentials are obtained from external helpers (OS keychain, cache, store) or an
  interactive prompt — "credential-generating helper might generate credentials for certain
  servers" — never stored in the repository. The archetype of keeping secrets out of band
  from the artifact.
- **GitHub Actions OIDC** — official documentation,
  <https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect>:
  a workflow receives a short-lived, audience-bound identity token and exchanges it per
  deployment; no long-lived secret is ever present in the workflow's environment. (Documentation
  source, no commit pin.)
- **Sprout already does this** — `docs/adr/0004-engine-session-keys-are-scoped-to-one-environment-slot.md`
  (engine session keys never leave their slot) and
  `docs/adr/0012-production-workers-use-enrollment-backed-outbound-connections.md`
  (enrollment-backed outbound connections) keep Sprout's own credentials never-in-band. This
  family is therefore *already settled* for Sprout-owned secrets; it does not address
  human-pasted secrets in Messages.

---

## 4. Evaluation frame

### 4.1 ADR-0007's two-sided constraint

The include-side (§1, lines 138–144) and exclude-side (lines 153–158) must hold *simultaneously
and verifiably for every attempt*. The Human-inspectable evidence section additionally requires
"the frozen context manifest and all truncation markers", and `routing-context.ts`'s own header
promises "the same window facts always produce the same batches … which is exactly what makes
the automatic retry a judgement of an *identical* snapshot."

| Approach | Include side | Exclude side | Determinism / evidence | Verdict vs ADR-0007 |
|---|---|---|---|---|
| §2.1 Pattern/entropy scan | Preserves content fully | No positive guarantee — F7 survives; exclusions hold only for enumerated shapes | Deterministic, manifest-stable | **Fails exclude side by construction**; matches the #97 attribution |
| §2.2 Source allowlist | Holds for listed sources | Fails inside allowed free-text fields (D3); OTel shows it can be *combined* with value rules | Deterministic | **Insufficient alone** — this is the current design |
| §2.3 Closed-format projection | Partially: only representable content crosses — changes what "content" means | Strong: unrepresentable values cannot cross | Fully deterministic if projection is pure; manifest records the vocabulary | **Conflicts with include-side wording** ("input … content") → owner decision per #51 |
| §2.4 Egress guard | Full content can cross | As strong as its detector — same unknown-shape limits, but at least choke-pointed and fail-closed-able | Must run *before* the snapshot is frozen, or persisted-context == sent-bytes equality (a #97 probe assertion) breaks | Complementary; **cannot be the contract by itself** |
| §2.5 Never-in-band | Irrelevant to Message content | Settles Sprout-owned credentials | Orthogonal | Necessary but **does not address #97** |

### 4.2 The #97 diagnosis's ordered plan

1. **Human decision first**: may assisted routing replace unrestricted prose with a
   "versioned, closed-format routing-fact projection, withholding unrepresentable content and
   visibly failing routing when adequate safe facts are unavailable"? If unrestricted prose
   remains required, the owner must define the authorized source/declassification contract;
   "scan it and assume safe" is not such a contract.
2. **Conditional direction (option A)**: routing-only projection at the producers feeding
   `#messageFact`, `#eventFact`, `#routingContract` and ancestor/recent lookup — finite
   product-owned fact kinds/enums, bounded validated values, generated routing-local aliases
   for caller-controlled identity strings.
3. The taxonomy maps directly: **option A = §2.3**, **option B = §2.2 + §2.4 composed under an
   owner-authored contract**. The survey's contribution is evidence that (a) both compositions
   exist in production systems, (b) every project that ships §2.4 states its detector limits
   honestly, and (c) no project claims §2.1 alone is an export contract.

### 4.3 Terminology and settled-decision conflicts to watch

- **`CONTEXT.md` vocabulary**: "Routing attempt … one wake-model evaluation of one frozen
  routing batch and its bounded Project-shared context" and "Routing batch … the durable,
  frozen set" already fix *what* is evaluated; a projection changes *how inputs are
  represented*, not these nouns — but there is **no settled term** for a declassification
  authority. The nearest existing concept is the producer-declared **routing disposition** of a
  Project event (addressed / wake-eligible / …): Sprout already trusts producers to declare
  *routing treatment* per event; extending that to "declared content class" would reuse the
  established pattern rather than inventing a role. Any new term needs the domain-docs process
  (`docs/agents/domain.md`).
- **ADR-0007 include-side wording**: "each batch input's … content" — option A makes content
  *representable-only*, which is a contract change the diagnosis says "must be explicit and
  owner-approved, not inferred", per the owner-approved #51 resolution promising both sides.
- **Determinism**: a model-based projection (summarizer, NeMo-style classifier) conflicts with
  the frozen-snapshot/retry-identical requirement unless its output is persisted as part of the
  frozen artifact; a pure function projection does not.
- **Evidence equality**: #97's probe asserted `persistedEqualsSent`. An egress guard that
  transforms *at send time* breaks that assertion; running the guard *at snapshot build* (so
  the persisted context is already the guarded bytes) preserves it. Magpie has the analogous
  invariant question in reverse (placeholders persist, values rehydrate).
- **`docs/references.md` policy**: the three standing reference repositories (Cumora,
  Paperclip, AionUi) contain no mature equivalent in this area, so this survey is net-new
  reference material; any adoption would be a *new* reference entry with its own pinned commit
  and attribution, per that file's rules.

---

## 5. Candidate directions (options, not a decision)

The owner decides. Each option lists its citable basis, pros, cons, and adoption cost.

### Option A — Closed-format routing-fact projection (the diagnosis's Option A)

Render only finite, product-owned facts into the routing context; withhold the rest; fail
routing visibly when the facts are inadequate.

- **Code behind it**: OTel `allowed_keys` fail-closed semantics
  (`open-telemetry/opentelemetry-collector-contrib@af475283`, `processor/redactionprocessor/README.md`,
  Apache-2.0); LangChain `block` strategy (`langchain-ai/langchain@a9780cd3`,
  `agents/middleware/_redaction.py` + `pii.py`, MIT); Presidio analyzer→operator separation
  (`microsoft/presidio@d4ccc6bc`, MIT); Gemini CLI field projection
  (`google-gemini/gemini-cli@38700b4b`, `telemetry/sanitize.ts`, Apache-2.0); Codex
  `RedactedString` (`openai/codex@17a9df60`, Apache-2.0, `codex-rs/utils/redacted-string/src/lib.rs`).
- **Pros**: only family with a *positive* admission contract; answers F7 by construction;
  fully deterministic; produces a manifest the Human can audit against a finite vocabulary;
  aligns with ADR-0007's exclusion list as structure, not intent.
- **Cons**: reduces what the wake model can see (diagnosis: this "changes the content available
  for responsibility-based judgement"); requires owner approval against ADR-0007 include-side
  and the #51 promise; largest implementation surface (producers, builder, evidence UI, tests);
  "visible failure when facts are inadequate" changes routing availability semantics.
- **Adoption cost**: high — touches `routing-context.ts` producers, `coordinator.ts` evidence
  rendering, API/browser surfaces, schema/versioning for the projection.

### Option B — Owner-defined source contract + fail-closed boundary scrub (the diagnosis's Option B)

Keep unrestricted prose, but make the contract explicit: enumerated authorized sources; a
value-level admission rule for every string that crosses (fail-closed, with a declared policy
for unknown/opaque values); enforced at snapshot build.

- **Code behind it**: Hermes `redact_for_egress` fail-closed wrapper + import-time policy
  snapshot + exact-value registry (`NousResearch/hermes-agent@3632f917`, `agent/redact.py`,
  `agent/monitoring/redaction.py`, MIT); Magpie boundary masking (`yetone/magpie@899ddf59`,
  `internal/redact/`, MIT); Sentry key denylist (`getsentry/sentry-python@2a499ec4`, MIT);
  Cline key-based cassette redaction (`cline/cline@01176459`, Apache-2.0); OTel
  `blocked_values`/`allowed_values` layering (as above).
- **Pros**: preserves full routing content in the common case; moderate cost; fail-closed
  egress removes the "broken redactor silently passes raw text" failure; exact-value registry
  covers secrets Sprout has already seen; composition pattern (keys → values → exceptions) is
  proven in production telemetry pipelines.
- **Cons**: the detector still cannot guarantee unknown shapes — the diagnosis's core
  objection stands unless the owner's contract *defines* the unknown-value policy (withhold on
  entropy/opacity? route to Human?). False positives will eat legitimate prose (Hermes's long
  false-positive history is the cautionary tale). A contract is a governance artifact the owner
  must author and maintain.
- **Adoption cost**: medium — mostly `privacy.ts` hardening (fail-closed wrapper, opacity
  rule), a boundary re-check at `coordinator.ts` judge-send that preserves
  persisted==sent, plus an owner-authored contract document.

### Option C — Layered split: closed format for manifest/narrative, governed scrub for content

Follow the diagnosis's own leak taxonomy (manifest leaks via candidate responsibilities;
content leaks via excerpts): apply option A's closed-format projection to *all structured and
narrative fields* (goal, rules, responsibilities, collaboration instructions, candidate ids,
event summary/detail — the `#routingContract`/`#eventFact` paths), and keep Message content
free-text under option B's governed rule (opacity/entropy withholding with an explicit
truncation-style marker so the manifest records exactly what was withheld).

- **Code behind it**: the same set as A + B, plus the specific observation that Cline/Sentry
  key-based scrubbing is robust for object fields, while content needs value rules — the
  survey's clearest cross-project division of labor.
- **Pros**: matches where each family actually works (per §2, guarantees are field-shape
  dependent); preserves message nuance better than A; gives the manifest a positive contract
  while content keeps a documented policy; the diagnosis's 7/7 injection data says narrative
  fields are the highest-yield first target.
- **Cons**: two mechanisms to specify, test, and explain; still needs owner approval for the
  content-side withholding rule; risk of split-brain semantics ("why did this rule survive and
  my base64 did not") that the UI must render clearly.
- **Adoption cost**: medium-high — A's machinery for contract fields, B's rules for content,
  one shared manifest vocabulary describing both.

### Option D — Never-in-band hygiene for Sprout-owned secrets (complementary, not sufficient)

Ensure no Sprout-origin credential can appear in shared prose at all: engine/session keys stay
slot-scoped (ADR-0004), enrollment stays outbound-only (ADR-0012), provider keys are injected
via env/OS stores, and any tool output that could echo them is scrubbed at the producer
(Gemini CLI's `sanitizeEnvironment`; Magpie's gateway-token injection pattern).

- **Code behind it**: `yetone/magpie@899ddf59` agent-config injection; Gemini CLI
  `environmentSanitization.ts`; git credential helpers (`git/git@a0189536`, GPL-2.0);
  GitHub Actions OIDC docs; Sprout ADR-0004/ADR-0012.
- **Pros**: removes an entire leak class by construction; aligns with settled ADRs; low risk.
- **Cons**: does not touch human-pasted secrets in Messages — cannot satisfy #97 acceptance 4
  alone.
- **Adoption cost**: low, and mostly already paid; treat as a prerequisite hygiene item inside
  whichever option the owner chooses.

---

## 6. Sources

Every repository/file consulted, with the commit it was read at and its license. External
documentation sources are listed with URLs (no commit exists). All commits resolved
2026-09-29.

| # | Repository | Path(s) | Commit | License |
|---|---|---|---|---|
| 1 | <https://github.com/NousResearch/hermes-agent> | `agent/redact.py`, `agent/monitoring/redaction.py`, `agent/chat_completion_helpers.py` | `3632f9173d218fd24f3fa595d7affa159b0774cd` | MIT |
| 2 | <https://github.com/yetone/magpie> | `internal/redact/redact.go`, `internal/redact/rules.go`, `internal/redact/writer.go`, `internal/gateway/redact.go`; injection surfaces `internal/agent/{claude,kimi,hermes,cline,agy}.go` (located via code search) | `899ddf594ce41ad2458ff071e9ffa66899728ade` | MIT |
| 3 | <https://github.com/gitleaks/gitleaks> | `config/gitleaks.toml` | `b58d3f102cf3a2c84cb7f923d05c25c9b1aed84b` | MIT |
| 4 | <https://github.com/Yelp/detect-secrets> | `detect_secrets/plugins/high_entropy_strings.py`, `detect_secrets/pre_commit_hook.py` | `5e141933554a0b74e7341841f318be21e895339c` | Apache-2.0 |
| 5 | <https://github.com/trufflesecurity/trufflehog> | `pkg/detectors/generic/generic.go`, `pkg/detectors/detectors.go` | `48b58d3bf3f02ba17bf23b87f095499bc80c6fd7` | AGPL-3.0 |
| 6 | <https://github.com/awslabs/git-secrets> | `git-secrets` | `7d6b970cbd3c216353cb22b383b70c150140662e` | Apache-2.0 |
| 7 | <https://github.com/open-telemetry/opentelemetry-collector-contrib> | `processor/redactionprocessor/README.md` | `af475283d7efcc8b1a038cf83d59a6a227459b71` | Apache-2.0 |
| 8 | <https://github.com/getsentry/sentry-python> | `sentry_sdk/scrubber.py`, `sentry_sdk/client.py` | `2a499ec49cb07111d4a45cdfd8e75f633f11255e` | MIT |
| 9 | <https://github.com/microsoft/presidio> | `presidio-anonymizer/presidio_anonymizer/anonymizer_engine.py` | `d4ccc6bcb6b6a7144336fe93b7839e61e251301b` | MIT |
| 10 | <https://github.com/BerriAI/litellm> | `litellm/litellm_core_utils/secret_redaction.py`, `redact_messages.py`, `sensitive_data_masker.py` | `ffb15f946f586c102bf0359b2fa9ac46b340b658` | MIT (`enterprise/` excepted) |
| 11 | <https://github.com/langchain-ai/langchain> | `libs/langchain_v1/langchain/agents/middleware/_redaction.py`, `pii.py` | `a9780cd3dd73135d21d7130b08711685f2700d51` | MIT |
| 12 | <https://github.com/NVIDIA/NeMo-Guardrails> | `docs/configure-rails/guardrail-catalog/pii-detection.mdx`, `LICENSE.md` | `83d03ad529d2be1399f1dede24be59d4381ee42e` | Apache-2.0 |
| 13 | <https://github.com/openai/codex> | `codex-rs/secrets/src/sanitizer.rs`, `codex-rs/utils/redacted-string/src/lib.rs`, `codex-rs/app-server/src/request_processors/thread_resume_redaction.rs`; call sites via code search | `17a9df60e420b58e3edc55efb1bb052e39492bbc` | Apache-2.0 |
| 14 | <https://github.com/google-gemini/gemini-cli> | `packages/core/src/services/environmentSanitization.ts`, `packages/core/src/telemetry/sanitize.ts`, `packages/core/src/context/toolOutputMaskingService.ts` | `38700b4b38bf387dafded6c97c3f190d084b49e9` | Apache-2.0 |
| 15 | <https://github.com/cline/cline> | `sdk/packages/shared/src/vcr.ts`, `apps/vscode/src/sdk/initial-message-sanitizer.ts`, `.husky/pre-commit` | `01176459b7194efa83d2dd8a0c3377e92fbc0719` | Apache-2.0 |
| 16 | <https://github.com/continuedev/continue> | `core/indexing/ignore.ts`, `core/context/providers/OpenFilesContextProvider.ts`, `core/util/sanitization.ts` | `5522c6f44ca0ac3528b37244818fbfa39b5af470` | Apache-2.0 |
| 17 | <https://github.com/anthropics/claude-code> | `CHANGELOG.md`, `LICENSE.md` | `684800b206824dfd0cc8a876e8604b20f72c3617` | Proprietary (Anthropic Commercial Terms) |
| 18 | <https://github.com/protectai/llm-guard> | `README.md` (project **archived** — noted, not relied upon) | `168c1034ffdb33837e7ae6fd6a16b80567c1be03` | MIT |
| 19 | <https://github.com/git/git> | `Documentation/gitcredentials.adoc`, `COPYING` | `a018953688f1b10bddf91bff8747068f5f4746a4` | GPL-2.0 |
| 20 | Continue file-exclusion lists (part of #16) | `core/indexing/ignore.ts`: `DEFAULT_SECURITY_IGNORE_FILETYPES` (`.env*`, `*.pem`, `*.key`, `settings.json`, …) and `DEFAULT_SECURITY_IGNORE_DIRS` (`.aws/`, `.kube/`, `secrets/`, …); `throwIfFileIsSecurityConcern` refuses reads/edits | `5522c6f44ca0ac3528b37244818fbfa39b5af470` | Apache-2.0 |

**Documentation-only sources** (no commit pin available):

- GitHub secret scanning supported patterns:
  <https://docs.github.com/en/code-security/reference/secret-security/supported-secret-scanning-patterns>
  (the former `/introduction/supported-secret-scanning-patterns` URL 301s here; HTTP 200
  verified).
- GitHub Actions OIDC for deployments:
  <https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect>.

**Sprout sources** (this repository):

- `docs/adr/0007-message-and-wake-routing-semantics.md` at `278f73cc` — include list
  (lines 136–152), exclusion list (lines 153–158), human-inspectable evidence, rejected
  alternatives.
- `src/environment/privacy.ts` at `278f73cc` — header (lines 1–19), `REDACTIONS`
  (lines 114–225), `redactSensitiveText` (line 233).
- `src/collaboration/routing-context.ts` at `099b6372` (branch `m77-ticket-97-r3`, Ticket #97
  head; the file does not exist at integration HEAD `278f73cc`) — header, import (line 46),
  render sites (lines 151–157, 197, 253, 273, 310, 320, 336–337).
- `src/collaboration/coordinator.ts` at `099b6372` — `RoutingModelPort.judge` send
  (lines 1073–1077).
- Issue #97 body (acceptance criteria) and the `human-required` diagnosis comment
  (ordered plan, D1–D3 attribution, independent probes).
- `CONTEXT.md`, `AGENTS.md`, `docs/agents/development-loop.md`, `docs/references.md`,
  `docs/adr/0004-…`, `docs/adr/0012-…`.
