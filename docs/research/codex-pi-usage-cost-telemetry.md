# Research Report: Authoritative Codex and Pi Usage and Cost Telemetry

**Issue**: [#45](https://github.com/tinysnake/sprout/issues/45)

**Research date**: 2026-09-15

**Scope**: Codex CLI `0.154.0` and Pi `0.85.1`, the two engines required by the Local Operator MVP

**Status**: Evidence and non-binding storage vocabulary for the later usage-observability decision; no persistence or Web design is implemented here

## Executive summary

Codex and Pi expose enough information to report useful per-run token usage and an API-equivalent USD estimate, but they do not expose the same facts and neither exposes a final invoice amount.

- **Codex token usage** is provider-reported. `thread/tokenUsage/updated` identifies a thread and turn and carries both cumulative `total` and per-turn `last` breakdowns for input, cached input, cache-write input, output, reasoning output, and total tokens. A resumed thread must use `last`, keyed by `turnId`; using `total` would count old work again. [C1][C2]
- **Codex cost** can be obtained as a provider-backend **estimate**, not a billed fact. Current Codex can export a per-turn `codex.turn_cost` OpenTelemetry event with `usage.estimated_usd`, or return a thread aggregate with optional `estimatedUsageUsdMicros` from `account/usage/read({threadId})`. Both paths are delayed or unavailable in valid configurations. [C3][C4][C5]
- **Pi token usage** is provider-normalized by Pi into `input`, `output`, `cacheRead`, `cacheWrite`, optional `reasoning`, and `totalTokens`. Pi attaches a calculated USD cost breakdown to the same `Usage` object. [P1][P2]
- **Pi cost** is a **harness calculation** from Pi's own model catalogue, not a provider bill. The formula is cache-aware, supports model price tiers, and treats reasoning as a subset of output. Pi continues to display this calculated amount for subscription-backed access and labels it `(sub)`. [P1][P2][P3]
- **Duration** needs two names. Sprout's engine-neutral fact is elapsed wall time from the run's own `createdAt` to `completedAt`. Codex may separately report `turn.durationMs`; Pi's JSON event contract has lifecycle boundaries but no native run-duration field. These values must not be silently substituted for one another. [C6][P4][S1]
- **Subscription-inclusive usage** should retain `billingBasis = subscription_included` while its attributable billed cost remains unavailable. Sprout may still store a clearly labelled API-equivalent estimate. It must not allocate a monthly fee to runs or claim that a subscription run cost exactly zero.
- **Unknown is not zero.** Missing token data, a missing price, an unknown route/tier, or a delayed estimate remains `unavailable` or `pending`. Sprout should not copy a fallback-rate design that manufactures a plausible dollar value for an unknown model.
- **Codex credits are deliberately outside the MVP vocabulary.** The report records that the protocol exposes them, but the MVP should discard them rather than pretend provider-specific quota units are a currency shared by all engines.

The recommended valuation hierarchy is engine-specific:

1. For Codex, prefer the Codex backend's per-turn estimated USD; if unavailable, calculate from a versioned Codex/OpenAI price snapshot only when model, token dimensions, and applicable route/tier are known; otherwise report unavailable.
2. For Pi, use Pi's emitted `usage.cost` and record the Pi/model-catalogue version that produced it. Do not use Pi's catalogue to price a run executed by the Codex engine.
3. Freeze every local or harness valuation at run time. Preserve the token facts and price provenance so history is not silently repriced when a catalogue changes.

## 1. Evidence boundary and reproducibility

### 1.1 Static probes

The following non-generative commands established the installed interfaces without consuming model tokens or account credits:

```sh
codex --version
# codex-cli 0.154.0

codex app-server generate-json-schema --out <temporary-directory>

pi --version
# 0.85.1
```

The generated Codex schema was compared with OpenAI's `rust-v0.154.0` source at commit `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`. The installed Pi package metadata identifies the first-party `earendil-works/pi` repository; npm package `0.85.1` and tag `v0.85.1` resolve to commit `d981de1229ef899957bbe968bc8dcda02a21f477`.

No authenticated account data, user identity, credentials, session content, host path, or new model response was collected. In particular, this research did **not** enable an OTLP exporter or call `account/usage/read` against a real account. Availability and delay behaviour for those paths comes from their first-party schema, implementation, and tests.

### 1.2 Evidence strength

Claims in this report use, in descending order:

1. generated protocol types and tagged first-party source for the measured versions;
2. official product and API pricing documentation;
3. existing sanitized Sprout protocol fixtures and adapter code;
4. pinned source from the repository's Paperclip and Cumora reference projects.

The report does not maintain a historical version matrix. Codex app-server and Pi output are versioned integration surfaces and must be rechecked when either executable changes.

## 2. Terms: facts that must remain distinct

| Term | Meaning | Is it a final bill? |
|---|---|---:|
| `provider_reported_usage` | Token or timing data emitted from the provider-facing engine protocol | No; it is usage telemetry |
| `provider_estimated` | A monetary estimate returned by the provider's backend, as Codex does | **No** |
| `harness_calculated` | A monetary estimate calculated by the engine harness from its model catalogue, as Pi does | **No** |
| `locally_estimated` | A fallback calculated by Sprout from a frozen official-price snapshot | **No** |
| `subscription_included` | The run used access covered by a subscription allowance | Does not make attributable run cost known or zero |
| `metered_api` | The run used usage-priced API access | Still does not turn an estimate into invoice truth |
| `billed` | A settled provider invoice or ledger fact | Not exposed per run by either measured interface |

“Provider-reported” alone is not a sufficient monetary label: Codex itself names the value `estimated`. The storage vocabulary should therefore say `provider_estimated`, not `provider_billed` or merely `reported`.

The MVP's normalized monetary unit is USD only. Provider-native Codex credits are noted as an available source field but intentionally discarded. Sprout should not convert them to USD or generalize them into a cross-provider currency.

## 3. Codex 0.154.0

### 3.1 Per-turn token fields

The public app-server notification is:

```json
{
  "method": "thread/tokenUsage/updated",
  "params": {
    "threadId": "<thread-id>",
    "turnId": "<turn-id>",
    "tokenUsage": {
      "total": { "...": "cumulative thread usage" },
      "last": {
        "totalTokens": 0,
        "inputTokens": 0,
        "cachedInputTokens": 0,
        "cacheWriteInputTokens": 0,
        "outputTokens": 0,
        "reasoningOutputTokens": 0
      },
      "modelContextWindow": null
    }
  }
}
```

All shown numeric fields are required in the current generated type; `cacheWriteInputTokens` has a default for backward-compatible deserialization. `total` and `last` have the same shape. [C1][C2]

Important semantics:

- `inputTokens` comes directly from Responses API `input_tokens`; cached and cache-write counts come from its input details. Preserve those dimensions rather than guessing a price from one undifferentiated prompt count. [C7]
- `reasoningOutputTokens` comes from `output_tokens_details.reasoning_tokens`. It is a breakdown associated with output, so consumers must not blindly add it to `outputTokens`; prefer the provider's `totalTokens` and preserve the reasoning field separately. [C7]
- `tokenUsage.total` is cumulative for the thread. `tokenUsage.last` is the relevant turn measurement. A resumed session therefore does not require subtracting a historical snapshot when `last` and `turnId` are available.
- The notification is separate from `turn/completed`; the terminal turn notification itself is not the token authority. Sprout must correlate by `turnId`, tolerate either arrival order, and allow a terminal failed/interrupted run to retain usage already observed.

#### Current Sprout mismatch

Sprout currently maps Codex `inputTokens` to `promptTokens` and maps completion as `outputTokens + reasoningOutputTokens`. Pi's `input` excludes cache traffic while Codex's raw `inputTokens` contains the provider's input total, and Codex reasoning is exposed as output detail. Consequently, today's three-field `TokenUsage` seam is not sufficiently precise for future cross-engine cost accounting and its Codex completion derivation should be revisited in the implementation ticket. [S2][C7][P1]

This report does not change that seam because issue #45 explicitly excludes persistence implementation.

### 3.2 Native duration fields

`turn/started` and `turn/completed` both carry a `Turn`. The current `Turn` type has optional:

- `startedAt`: Unix seconds;
- `completedAt`: Unix seconds;
- `durationMs`: duration between turn start and completion, if known.

It also carries `status = completed | interrupted | failed | inProgress` and an error only for failed turns. [C6]

Codex command, MCP-tool, and dynamic-tool items may have their own `durationMs`; those are item durations, not the engine turn or Sprout run duration. The stable cross-engine duration remains Sprout's wall-clock interval. Codex's `turn.durationMs` may be stored separately as an optional native fact and compared diagnostically, never silently substituted. [C8][S1]

### 3.3 Provider-estimated monetary cost

Codex 0.154.0 contains two externally useful estimate surfaces.

#### Per-turn OpenTelemetry estimate

The app-server's turn-cost worker waits for a turn to finish, queries a backend by turn ID, requires a `priced` status and coverage of every locally observed response, then records:

- log event `event.name = "codex.turn_cost"`;
- `turn.id`;
- `usage.estimated_usd` as a decimal USD string;
- `turn.interrupted`;
- optional `speed` and `reasoning_effort`;
- counter `codex.turn.cost_microusd`, tagged with turn and conversation identifiers.

The worker supports ChatGPT authentication and API-key authentication, including compatible providers that implement the analytics endpoint. It is not created unless an OTLP log or metrics exporter is configured, and it is disabled for Amazon Bedrock. [C3][C4][C9]

This path is intentionally best-effort:

- backend requests have a 15-second timeout;
- unsuccessful or incomplete prices are retried on a 150-second interval;
- the event is dropped after five stalled polls;
- authentication changes, unsupported providers, process shutdown, and incomplete backend settlement can all leave the cost unavailable;
- the ChatGPT path explicitly treats missing/hidden dollars as missing, not zero. [C3][C5]

Therefore the estimate can arrive well after `turn/completed`. A truthful store needs `pending` as a real cost state and must accept a later update without changing the original token or run-duration facts.

#### Thread aggregate estimate

`account/usage/read` accepts optional `{ "threadId": "..." }`. With a thread ID, its response may contain:

- `estimatedUsageCreditsMicros`;
- nullable `estimatedUsageUsdMicros`;
- groups by model, reasoning effort, and speed, with estimated credits and token dimensions.

This public method requires ChatGPT/Codex-backend authentication; API-key-only authentication is rejected for this method. A 403 or 404 from the thread-usage backend is represented as `threadUsage: null`; other failures remain errors. [C2][C10]

The `{threadId}` extension is present in the generated `0.154.0` schema and source but is not described in the current prose documentation for account-wide token usage. It is therefore a version-pinned integration fact, not a stable assumption to carry across upgrades without regenerating the schema.

The value is a **thread aggregate**, not a run event. Sprout should not present it as per-run cost or derive a turn by subtracting snapshots unless a future version lacks the per-turn path and a separately reviewed algorithm establishes safe identity, ordering, and reset semantics.

Codex credits are not part of the MVP storage recommendation. Their presence should not cause the optional USD value to be treated as available, and Sprout should not invent a credits-to-USD conversion.

### 3.4 Billing route and local fallback

OpenAI's official Codex pricing distinguishes ChatGPT-plan allowance/credits from API-key usage, while API-key runs are charged according to API pricing. API price can vary by model, cached input, service tier, batch/flex/priority mode, and other billable features. [C11][C12]

For that reason a generic `tokens × model rate` fallback is not always truthful. A local Codex estimate is allowed only when the run captured enough dimensions to select the applicable versioned rate. If model, service tier/route, or a required billable dimension is unknown, cost remains unavailable. The Codex-specific price snapshot must not be shared with Pi merely because Pi happens to carry rates for some OpenAI models.

## 4. Pi 0.85.1

### 4.1 JSON event and usage fields

Pi's JSON/RPC wire contract makes `message_end` the authoritative completed message. Streaming `message_update` carries cumulative `usage`, while the final assistant message also contains its final `Usage`; counting every streaming update would multiply one provider call. `agent_settled`, rather than `agent_end`, is the outer run-settlement boundary because retries or queued continuation can follow `agent_end`. [P4][P5]

The first-party `Usage` shape is:

```ts
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number; // subset of output
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

Pi defines `input` as uncached input for the provider adapters relevant here; cached reads and writes are separate. `reasoning`, when available, is explicitly a subset of `output`. [P1][P6]

An Agent run may contain several provider calls: tool-use hops, the final answer, compaction, branch summaries, or tool summaries. Per-run accounting should sum each final completed usage-bearing event exactly once. It should preserve call-level identity when Pi exposes one, rather than aggregate the streaming snapshots.

On session resume, historical session entries are context, not new spend. Only usage-bearing events emitted for the new invocation belong to the new Sprout run. If a future Pi surface returns session-cumulative counters, that different basis must be explicit and delta logic must handle resets; it must not be inferred from a bare number.

### 4.2 Harness-calculated cost

Pi initializes each response's cost fields and calls `calculateCost(model, usage)`. The function:

1. selects a model price tier using total input (`input + cacheRead + cacheWrite`);
2. calculates uncached input, output, cache-read, and cache-write components at their separate per-million-token rates;
3. handles Anthropic one-hour cache writes at twice base input price;
4. sums those components into `usage.cost.total`. [P2]

Some provider adapters then apply route information. For example, Pi's OpenAI Codex adapter adjusts calculated cost for `flex` and `priority` service tiers. [P7]

This is a strong API-equivalent estimate because it is cache-aware and generated by the harness that normalized the provider response. It is still not an invoice value. Pi's interactive footer makes the distinction visible by adding `(sub)` when the selected authentication is subscription-backed while continuing to show the calculated dollar amount. [P3]

For Sprout:

- classify emitted `usage.cost.total` as `harness_calculated`;
- record engine version `0.85.1`, model/provider identity, and the Pi catalogue reference used at run time;
- retain Pi's component costs if available, not only the total;
- treat billing basis (`metered_api`, `subscription_included`, or `unknown`) as independent of valuation provenance;
- do not allocate a subscription fee to the run;
- do not call a subscription run's attributable billed cost zero.

Pi allows custom model definitions and defaults an omitted custom-model cost table to zero rates. Therefore, an emitted zero must not automatically mean “known free.” Zero is available only when the selected catalogue/configuration positively identifies valid zero rates; otherwise the estimate is unavailable. [P8]

### 4.3 Duration, failure, and interruption

Pi's Agent events include `agent_start`, `turn_start`, `turn_end`, `agent_end`, and `agent_settled`, but those event types do not carry a native elapsed duration. Assistant messages have a creation timestamp, not a complete run interval. [P4][P5]

Sprout should therefore use its own run wall duration for cross-engine reporting. It may later store provider-call latency if Pi exposes a reliable field, but that is a different metric.

An assistant message stopped with `error` or `aborted` can still contain usage and calculated cost. Preserve any completed message/compaction usage observed before settlement. A failed tool event alone is not a failed model run; Pi decides whether the agent continues. A malformed stream that supplies no trustworthy usage remains unavailable, never zero.

## 5. Edge-case truth table

| Situation | Token handling | Duration handling | Cost handling |
|---|---|---|---|
| Complete Codex turn | Use `tokenUsage.last`, keyed by `turnId` | Sprout wall duration; optional Codex `turn.durationMs` separately | Provider estimate may be available now or later |
| Complete Pi run | Sum each final usage-bearing call once | Sprout wall duration | Sum Pi component/total costs as `harness_calculated` |
| Cached input | Preserve cache read and cache write separately | No change | Apply the engine-specific cached rate; never price all input at the uncached rate |
| Resumed Codex thread | Never use cumulative `total` as new run usage | Measure only the new Sprout run | Correlate per-turn estimate; do not treat thread aggregate as turn cost |
| Resumed Pi session | Count only newly emitted usage events | Measure only the new invocation | Count only new harness calculations |
| Interrupted run | Retain all observed partial usage | End wall duration at terminal interruption | Codex can label a turn-cost event interrupted; otherwise preserve partial/local estimate or unavailable |
| Failed run | Retain usage emitted before failure | End wall duration at terminal failure | Retain an estimate only for observed usage; failure does not imply zero |
| Cost delayed | Token fact can settle independently | Duration remains final | `pending`, then attach the later estimate by turn/run identity |
| Usage absent | `unavailable`, not a zero-valued usage object | Wall duration may still be available | `unavailable`, not `$0` |
| Model/rate/route unknown | Preserve raw tokens | No change | `unavailable`; do not use a generic fallback model |
| Subscription included | Same token facts | Same duration facts | Attributable billed cost unavailable; API-equivalent estimate may be available and labelled |

An aggregate must expose coverage, such as runs with complete token usage and runs with available cost, so adding known values never hides unknown runs.

### 5.1 Current Sprout baseline and gaps

Sprout already persists a terminal run's wall-clock timestamps and an optional three-field `TokenUsage` (`promptTokens`, `completionTokens`, `totalTokens`). Its history aggregate reports the number of runs that supplied token usage, which is the right precedent for future cost coverage. [S1][S3]

The current adapters do not yet implement the vocabulary recommended below:

- Codex consumes `tokenUsage.last` by `turnId`, but discards cache dimensions and adds `reasoningOutputTokens` to `outputTokens`.
- Pi sums completed assistant and compaction usage, but discards `cacheRead`, `cacheWrite`, `reasoning`, and every `usage.cost` component.
- Neither adapter records billing basis or monetary cost.
- The Codex adapter neither configures/collects the turn-cost OTLP event nor calls the thread-aggregate account-usage method.
- Engine-native duration is not recorded; Sprout currently exposes only its own wall interval.

These are implementation inputs for later tickets, not acceptance failures for this research-only ticket. [S1][S2][S3]

## 6. Recommended cross-engine storage vocabulary

This is vocabulary for issue #50 to decide, not a database schema for this ticket.

### 6.1 Run identity and observation state

- `engine`: `codex | pi`
- `engineVersion`
- `engineSessionId` and `engineTurnId` when available
- `model`, `provider`, and `biller` when known
- `measurementStatus`: `complete | partial | unavailable`
- `observedAt`: when Sprout received the fact

Absence is represented by an absent value plus status, not a structure filled with zeros.

### 6.2 Token dimensions

Preserve the most detailed dimensions supplied by an engine:

- `inputTokens`: provider-reported total input where that semantic is known;
- `uncachedInputTokens`: only when it can be derived without ambiguity;
- `cachedInputTokens`;
- `cacheWriteInputTokens`;
- `outputTokens`;
- `reasoningOutputTokens`: a subset/detail unless a versioned provider contract explicitly says otherwise;
- `totalTokens`: prefer the engine/provider total over a locally reconstructed total;
- `source`: protocol method/event and engine version.

The simple prompt/completion/total view should be derived from these details using an engine-versioned mapping. It must not be the only durable representation used for pricing.

### 6.3 Duration dimensions

- `sproutWallDurationMs`: authoritative cross-engine elapsed time from Sprout's run lifecycle;
- `engineTurnDurationMs`: optional Codex-native duration;
- future provider latency fields must use their own names.

### 6.4 Billing and valuation

- `billingBasis`: `metered_api | subscription_included | unknown`
- `billedCostStatus`: `unavailable` for these measured per-run interfaces unless a future provider supplies an actual settled bill
- `apiEquivalentCostStatus`: `pending | available | unavailable`
- `apiEquivalentUsdMicros`: integer USD micros when available
- `valuationProvenance`: `provider_estimated | harness_calculated | locally_estimated`
- `valuedAt`: the run-time valuation point
- `priceSource`: engine-specific catalogue/backend identifier
- `priceSourceVersion`: Codex/OpenAI snapshot or Pi version/catalogue revision
- `priceDimensions`: the rates, tier/route, and token dimensions actually used, when locally or harness calculated

Codex and Pi valuations remain separate facts even when both are denominated in USD. A late Codex provider estimate should be preferred over a local estimate for selection, but its provenance must not be rewritten to look billed. Whether issue #50 stores both observations or one selected value plus audit history is a persistence decision still to make.

Provider-native quota units such as Codex credits are explicitly excluded from this MVP vocabulary and may be revisited later.

## 7. Reference-project comparison

The repository's reference-first policy requires checking Paperclip and Cumora. These projects offer useful patterns but neither current implementation is an exact fit for the settled Sprout semantics.

### 7.1 Paperclip

At commit `5b913e794315530b95f2bc95dd80e3ebc266b257`, Paperclip generally accepts cost from an adapter/runtime rather than maintaining one universal local price calculator. Its Pi adapter sums Pi's `usage.cost.total`, while its Codex local adapter returns `costUsd: null`. [R1][R2][R3]

Paperclip usefully separates `provider`, `biller`, and `billingType`; it also marks token-bearing events without cost as `unpriced`, and separates inference `cost_events` from broader `finance_events`. [R1][R4][R5]

Sprout should adopt that semantic separation, but not Paperclip's current normalization of `subscription_included` cost to integer `0` cents. Sprout needs an API-equivalent estimate beside an unavailable attributable bill, and micros rather than whole cents to avoid erasing small run costs. [R4][R5]

### 7.2 Cumora

At commit `a0309618b9102fc79221f8580afdd2f2372ab5df`, Cumora calculates cache-aware list-price USD locally from uncached input, cached input, cache creation, and output. It explicitly calls subscription/BYOA dollars “meter-equivalent,” marks seeded rates as estimated, treats only operator-supplied rates as verified, and freezes ledger cost at insertion time while retaining token dimensions. [R6][R7]

Those are useful patterns. Sprout should not adopt Cumora's model-family substring matching or its generic fallback rate for unknown models, because both can produce a plausible but incorrect value. Nor should missing usage be represented as zero cost merely because a separate `measured = false` flag exists; unavailable should remain structurally unavailable. [R6][R7]

## 8. Recommendations for the next decision and implementation tickets

1. Treat detailed provider/harness token dimensions as the durable pricing input; derive the current three-field summary.
2. Fix the Codex completion mapping before using it for pricing; do not add reasoning detail twice.
3. Correlate Codex usage and delayed cost by turn ID and permit terminal partial usage on interrupted/failed runs.
4. Keep Sprout wall duration and optional engine-native duration separately named.
5. Make billing basis orthogonal to API-equivalent valuation provenance.
6. Prefer Codex provider-estimated per-turn USD, then a Codex-specific frozen local estimate only with complete price inputs.
7. Use Pi's emitted cost and Pi catalogue/version; do not reprice Pi history or reuse Pi rates for Codex runs.
8. Store USD micros, valuation time, price source/version, and calculation dimensions. Do not maintain a static price table in this report.
9. Represent delayed, partial, and unavailable explicitly; never use zero as a missing-value sentinel.
10. Do not allocate subscription fees to runs and do not persist Codex credits in the MVP.
11. Report aggregate coverage counts alongside summed token/dollar values.
12. Re-run the static schema/source check whenever either engine version changes.

## 9. Primary sources

### Codex and OpenAI

- **[C1]** OpenAI Codex `rust-v0.154.0`, [`ThreadTokenUsage`, `TokenUsageBreakdown`, and notification types](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)
- **[C2]** OpenAI Codex `rust-v0.154.0`, [`ThreadUsage` and grouped estimate fields](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/app-server-protocol/src/protocol/v2/thread_usage.rs)
- **[C3]** OpenAI Codex `rust-v0.154.0`, [turn-cost worker activation, polling, settlement, and retry policy](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/app-server/src/turn_cost_worker.rs)
- **[C4]** OpenAI Codex `rust-v0.154.0`, [per-turn OpenTelemetry log and micro-USD metric](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/otel/src/events/session_telemetry.rs)
- **[C5]** OpenAI Codex `rust-v0.154.0`, [ChatGPT estimate validation: missing dollars are not zero](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/app-server/src/turn_cost_worker_chatgpt.rs)
- **[C6]** OpenAI Codex `rust-v0.154.0`, [`Turn`, timestamps, duration, status, and error](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs)
- **[C7]** OpenAI Codex `rust-v0.154.0`, [Responses API usage conversion](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/codex-api/src/sse/responses.rs)
- **[C8]** OpenAI Codex `rust-v0.154.0`, [thread item duration fields](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/app-server-protocol/src/protocol/v2/item.rs)
- **[C9]** OpenAI Codex `rust-v0.154.0`, [API-key turn-cost endpoint and response](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/backend-client/src/client/turn_usage.rs)
- **[C10]** OpenAI Codex `rust-v0.154.0`, [`account/usage/read` authentication and null/error handling](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/app-server/src/request_processors/account_processor.rs)
- **[C11]** OpenAI, [Codex pricing and ChatGPT-plan usage](https://developers.openai.com/codex/pricing)
- **[C12]** OpenAI, [API pricing](https://developers.openai.com/api/docs/pricing)

### Pi

- **[P1]** Pi `v0.85.1`, [`Usage` token and cost shape](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/types.ts#L383-L404)
- **[P2]** Pi `v0.85.1`, [`calculateCost`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/models.ts#L891-L910)
- **[P3]** Pi `v0.85.1`, [subscription-aware footer label](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/modes/interactive/components/footer.ts#L128-L145)
- **[P4]** Pi `v0.85.1`, [Agent lifecycle event contract](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/types.ts#L424-L446)
- **[P5]** Pi `v0.85.1`, [JSON event conversion and authoritative `message_end`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/modes/json-event.ts#L40-L60)
- **[P6]** Pi `v0.85.1`, [OpenAI Responses token normalization](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/api/openai-responses-shared.ts#L551-L581)
- **[P7]** Pi `v0.85.1`, [OpenAI Codex service-tier price adjustment](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/api/openai-codex-responses.ts#L594-L630)
- **[P8]** Pi `v0.85.1`, [custom-model price defaults and overrides](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/provider-composer.ts#L103-L165)

### Sprout baseline

- **[S1]** [`src/web/api.ts`](../../src/web/api.ts), `summarizeRunHistory`: terminal wall duration and coverage-aware token totals
- **[S2]** [`src/engine/codex.ts`](../../src/engine/codex.ts) and [`src/engine/pi-protocol.ts`](../../src/engine/pi-protocol.ts): current three-field mappings
- **[S3]** [`src/engine/port.ts`](../../src/engine/port.ts) and [`src/run/model.ts`](../../src/run/model.ts): current engine-neutral usage and durable run vocabulary

### Reference projects

- **[R1]** Paperclip `5b913e7`, [adapter execution cost and billing vocabulary](https://github.com/paperclipai/paperclip/blob/5b913e794315530b95f2bc95dd80e3ebc266b257/packages/adapter-utils/src/types.ts)
- **[R2]** Paperclip `5b913e7`, [Pi cost parsing](https://github.com/paperclipai/paperclip/blob/5b913e794315530b95f2bc95dd80e3ebc266b257/packages/adapters/pi-local/src/server/parse.ts)
- **[R3]** Paperclip `5b913e7`, [Codex local adapter returns unavailable cost](https://github.com/paperclipai/paperclip/blob/5b913e794315530b95f2bc95dd80e3ebc266b257/packages/adapters/codex-local/src/server/execute.ts)
- **[R4]** Paperclip `5b913e7`, [billing and unpriced normalization](https://github.com/paperclipai/paperclip/blob/5b913e794315530b95f2bc95dd80e3ebc266b257/server/src/services/heartbeat.ts)
- **[R5]** Paperclip `5b913e7`, [`cost_events` and `finance_events`](https://github.com/paperclipai/paperclip/tree/5b913e794315530b95f2bc95dd80e3ebc266b257/packages/db/src/schema)
- **[R6]** Cumora `a030961`, [cache-aware meter-equivalent pricing and fallback policy](https://github.com/yetone/cumora/blob/a0309618b9102fc79221f8580afdd2f2372ab5df/server/src/agents/cost.ts)
- **[R7]** Cumora `a030961`, [LLM ledger valuation and measurement status](https://github.com/yetone/cumora/blob/a0309618b9102fc79221f8580afdd2f2372ab5df/server/src/agents/llm-ledger.ts)
