# Research & Design: Final Answer Selection Across Coding-Agent Engines

**Target Seam**: `src/engine/port.ts` (`AgentRunEvent`, `EngineTurnResult`), `src/run/model.ts`, `src/web/api.ts`, `web/src/main.ts`  
**Investigator**: Background Research & Architecture Agent  
**Context**: Sprout O1 outcome (`docs/roadmap.md`), Cumora-derived run seam (`src/engine/port.ts`), recorded live failure in `src/engine/pi.test.ts` ("a trailing off-task assistant message overrides the real answer"), and product principle 4 in `docs/goal.md` ("Humans can understand, interrupt, and correct agents").  
**Status**: Proposal / Specification

---

## Executive Summary

When a coding-agent CLI executes a turn, it rarely produces just one clean assistant message. A typical run involves:
1. **Interim commentary** (preambles before tool invocations, e.g. *"Let me inspect `src/index.ts`"*).
2. **Tool executions** (commands, file operations, web searches).
3. **The definitive answer** (the conclusion presented to the user upon completing the task).
4. **Trailing assistant messages** (off-task warnings, asynchronous MCP health alerts, plugin telemetry, or follow-up turn responses).

Currently, Sprout's four engine adapters handle multiple assistant messages inconsistently:
- **`agy`** takes the explicit `result.response` from the engine's final JSON frame.
- **`pi`** takes the *last* assistant message in the process stream. When an unmanaged MCP server warning was injected at the end of a run, `pi` overwrote the valid result `"pi-e2e-ok"` with `"The UnityMCP server is currently unreachable."` (`src/engine/pi.test.ts:306`).
- **`codex`** takes the last `agentMessage`, ignoring the protocol's own `phase: "commentary" | "final_answer"` classification.
- **`opencode`** concatenates *all* text chunks across all provider hops, mixing pre-tool commentary and final answer into a single compound string.
- Meanwhile, the Web client (`web/src/main.ts`) does not render `run.result.text` at all; it renders `run.events` as a list of list items, appending `(final)` to any event flagged with `final: true`. Yet across the four adapters, `final: true` is emitted on every hop (`opencode`), on every completed message (`codex`), or never (`agy`, `pi`).

### Summary of Investigation Findings

| Engine | Transport / Mode | Machine-Readable Signal? | Exact Field & Discriminator | Pre-tool Commentary Distinguishable? | Trailing Messages Distinguishable? |
|---|---|---|---|---|---|
| **Codex** | `app-server` (JSON-RPC) | **Yes** (when emitted) | `item.phase === "final_answer"` vs `"commentary"` (`ItemCompletedNotification`) | **Yes** via `phase: "commentary"` | **Yes** if trailing message lacks `final_answer` |
| **Pi** | `--mode json` (NDJSON) | **No** | *None*. Pi CLI itself naively selects the last assistant message | **Yes** via `stopReason: "toolUse"` & tool events | **No** (both answer and trailing messages have `stopReason: "stop"`) |
| **`agy`** | `stream-json` (NDJSON) | **Yes** (authoritative) | `frame.event === "result"` & `result.response` (string) | **Yes** (`step_type: "agent_response"` vs `result`) | **Yes** (`result` frame is unique and terminal) |
| **`opencode`** | `run --format json` (NDJSON) | **Yes** (step level) | `step_finish.part.reason === "stop"` vs `"tool-calls"` | **Yes** (`reason: "tool-calls"` flags commentary) | **Partial** (last step with `reason: "stop"` before idle) |

### The Honest Truth
**Pi cannot tell us.** Pi's internal agent loop emits assistant messages for every turn, including unsolicited turns triggered by background extensions or follow-up queues. Pi provides no machine-readable tag distinguishing the user's answer from trailing messages, and Pi's own CLI implementation (`getLastAssistantText`) naively takes the last assistant message. Codex's own protocol schema explicitly documents that models do not emit `phase` consistently and requires callers to treat `None` as phase unknown.

Therefore, **any single uniform rule across all engines cannot rely solely on the engine to tell us: the system must combine explicit protocol facts where available with a principled, engine-neutral heuristic fallback.**

---

## 1. Engine Primary Source Investigations

### 1.1. OpenAI Codex (`app-server`)

#### Primary Sources
- Generated protocol schema: `codex app-server generate-json-schema --out /tmp/codex-schema` (v2 schemas).
- Protocol files:
  - `/tmp/codex-schema/v2/ItemCompletedNotification.json`
  - `/tmp/codex-schema/v2/TurnCompletedNotification.json`
- Local probe & adapter: `src/engine/codex-protocol.ts`, `src/engine/codex-protocol.test.ts`.

#### Protocol Facts
Codex's `app-server` communicates via JSON-RPC notifications. During a turn (`turn/started` to `turn/completed`), items arrive as `item/started`, `item/*/delta`, and `item/completed`.

In `/tmp/codex-schema/v2/ItemCompletedNotification.json`, an item of type `agentMessage` has the following schema (`AgentMessageThreadItem`):
```json
{
  "type": "object",
  "title": "AgentMessageThreadItem",
  "required": ["id", "text", "type"],
  "properties": {
    "type": { "enum": ["agentMessage"] },
    "id": { "type": "string" },
    "text": { "type": "string" },
    "phase": {
      "anyOf": [
        { "$ref": "#/definitions/MessagePhase" },
        { "type": "null" }
      ],
      "default": null
    }
  }
}
```

The definition of `MessagePhase` in `/tmp/codex-schema/v2/ItemCompletedNotification.json:607-625` states:
```json
"MessagePhase": {
  "description": "Classifies an assistant message as interim commentary or final answer text.\n\nProviders do not emit this consistently, so callers must treat `None` as \"phase unknown\" and keep compatibility behavior for legacy models.",
  "oneOf": [
    {
      "description": "Mid-turn assistant text (for example preamble/progress narration).\n\nAdditional tool calls or assistant output may follow before turn completion.",
      "enum": ["commentary"],
      "type": "string"
    },
    {
      "description": "The assistant's terminal answer text for the current turn.",
      "enum": ["final_answer"],
      "type": "string"
    }
  ]
}
```

Furthermore, in `TurnCompletedNotification.json`, the terminal notification carries `turn: Turn`. `Turn` contains `id: string`, `status: TurnStatus` (`completed`, `interrupted`, `failed`), and `items: ThreadItem[]`. There is no dedicated `response` string on `Turn`; the text remains inside the thread items.

#### Answer to Question 2 (Codex)
- **Is there a machine-readable signal?** **Yes, conditionally.**
  - **Field**: `item.phase` on `item/completed` where `item.type === "agentMessage"`.
  - **Values**:
    - `"final_answer"`: Explicitly signifies the terminal answer to the user.
    - `"commentary"`: Explicitly signifies interim commentary/preamble before tool calls.
    - `null` / omitted: The schema specifically states: *"Providers do not emit this consistently, so callers must treat `None` as 'phase unknown' and keep compatibility behavior for legacy models."*
- **What CAN be observed when `phase` is null/omitted?**
  - Item chronology relative to tools: `turn.items` preserves exact execution order. An `agentMessage` followed by `commandExecution` items within the same turn is pre-tool commentary. An `agentMessage` that settles the turn after tool activity (not followed by tools) represents the final answer.

---

### 1.2. Pi (`--mode json`)

#### Primary Sources
- CLI binary: `/opt/homebrew/bin/pi` (version `0.85.1`).
- Package source: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/`.
  - Core agent loop: `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` (and source map `agent-loop.ts`).
  - Bundle chunk: `dist/bundle/chunks/chunk-JVUZSMYM.js`.
- Local test case: `src/engine/pi.test.ts:306` ("a trailing off-task assistant message overrides the real answer").

#### Protocol Facts
When invoked with `--mode json --print --session-id <id> <prompt>`, Pi runs an iterative loop in `agent-loop.ts`:
```typescript
while (true) {
  await emit({ type: "turn_start" });
  if (pendingMessages.length > 0) {
    for (const message of pendingMessages) {
      await emit({ type: "message_start", message });
      await emit({ type: "message_end", message });
      currentContext.messages.push(message);
      newMessages.push(message);
    }
    pendingMessages = [];
  }
  const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
  newMessages.push(message);
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    await emit({ type: "turn_end", message, toolResults: [] });
    await emit({ type: "agent_end", messages: newMessages });
    return;
  }
  const toolCalls = message.content.filter(c => c.type === "toolCall");
  const toolResults: Message[] = [];
  if (toolCalls.length > 0) {
    const executedToolBatch = await executeToolCalls(currentContext, message, config, signal, emit);
    toolResults.push(...executedToolBatch.messages);
    hasMoreToolCalls = !executedToolBatch.terminate;
    for (const result of toolResults) currentContext.messages.push(result);
  }
  await emit({ type: "turn_end", message, toolResults });
  if (await config.shouldStopAfterTurn?.(lastCompletedTurn)) {
    await emit({ type: "agent_end", messages: newMessages });
    return;
  }
  pendingMessages = (await config.getSteeringMessages?.()) || [];
  if (!hasMoreToolCalls && pendingMessages.length === 0) {
    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }
    break;
  }
}
await emit({ type: "agent_end", messages: newMessages });
```
When the loop exits, the session emits `agent_settled`.

#### Why the Live Test Failed
In `src/engine/pi.test.ts:306`, Pi emitted:
1. Turn 1: Tool execution (`tool_execution_start`, `tool_execution_end`, `message_end` with tool calls).
2. Turn 2: Real answer (`message_end` with text `"pi-e2e-ok"`, `stopReason: "stop"`). At this point, the user prompt's tool loop was satisfied and `toolResults` was empty.
3. Turn 3: An extension (specifically `pi-mcp`) injected a follow-up message into the queue notifying the agent that `UnityMCP` was unreachable. Pi's loop detected `pendingMessages.length > 0`, executed an extra turn, and the LLM responded with: `"The UnityMCP server is currently unreachable."` (`stopReason: "stop"`).
4. Settle: `agent_settled`.

Because `src/engine/pi-protocol.ts:88` naively updated `state.finalText` on *every* `message_end`, Turn 3's MCP warning overwrote Turn 2's `"pi-e2e-ok"`.

#### How Pi Itself Resolves the Final Answer
In Pi's own source code (`chunk-JVUZSMYM.js:3163498`), `session.getLastAssistantText()` is implemented as:
```javascript
getLastAssistantText() {
  let lastAssistant = this.messages.slice().reverse().find(m2 => {
    if (m2.role !== "assistant") return false;
    let msg = m2;
    return !(msg.stopReason === "aborted" && msg.content.length === 0);
  });
  if (!lastAssistant) return;
  let text = "";
  for (let content of lastAssistant.content)
    content.type === "text" && (text += content.text);
  return text;
}
```
Furthermore, when running in text mode (`chunk-JVUZSMYM.js:3902136`), Pi outputs `state.messages[state.messages.length - 1]`.

Pi itself has no concept of distinguishing an off-task assistant message from an on-task assistant message. To Pi, Turn 3 was simply the latest turn in the conversation.

#### Answer to Question 2 (Pi)
- **Is there a machine-readable signal?** **No.**
  - There is no field, enum, or flag in Pi's protocol (`message_end`, `turn_end`, `agent_end`, `agent_settled`) that marks a message as `"final_answer"`, `"result"`, or `"answer"`.
- **What CAN be observed?**
  1. **Pre-tool commentary vs answer**:
     - Pre-tool commentary messages have `stopReason === "toolUse"` and `message.content` containing `{ type: "toolCall" }`.
     - An answer turn has `stopReason === "stop"` and `content` containing only text (`{ type: "text" }`), with `turn_end.toolResults` being empty (`[]`).
  2. **Injected trailing turns**:
     - When a trailing turn occurs after the answer, Pi emits `message_start`/`message_end` for an incoming message (`role: "user"` or `"custom"`), followed by a subsequent `turn_start` and assistant `message_start`.
     - The first pure-text assistant turn with empty tool results directly answered the user prompt's execution chain. Any turn following an unsolicited `user`/`custom` injection is an out-of-band reaction.

---

### 1.3. Antigravity / `agy` (`--output-format stream-json`)

#### Primary Sources
- CLI binary: `~/.local/bin/agy` (version `1.2.2`, Mach-O arm64 executable).
- Local probe & adapter: `src/engine/agy-protocol.ts`, `src/engine/agy.test.ts`.

#### Protocol Facts
`agy` in `stream-json` mode emits line-delimited JSON frames:
- `{"event": "init", "conversation_id": "...", "init": {...}}`
- `{"event": "step_update", "step_update": {"step_type": "user_input" | "agent_response" | "tool", "state": "ACTIVE" | "DONE", ...}}`
  - When `step_type === "agent_response"`, incremental text arrives on `text_delta`.
  - When `step_type === "tool"`, arguments arrive on `ACTIVE` and output on `DONE`.
- `{"event": "result", "result": {"conversation_id": "...", "status": "SUCCESS", "response": "...", "duration_seconds": 1.2, "num_turns": 1}}`

#### Answer to Question 2 (`agy`)
- **Is there a machine-readable signal?** **Yes, definitive and authoritative.**
  - **Frame**: `event === "result"`.
  - **Field**: `frame.result.response` (type: `string`).
  - **Status**: `frame.result.status` (e.g. `"SUCCESS"`).
- **Distinction from interim / trailing messages**:
  - `result.response` is published exactly once when the entire run settles.
  - Interim text in `step_update` is explicitly streaming delta progress. `agy` does not emit trailing assistant messages after the `result` frame.

---

### 1.4. OpenCode (`run --format json`)

#### Primary Sources
- CLI binary: `/opt/homebrew/bin/opencode` (version `1.18.30`, single-file bun executable).
- Disassembled bundle modules: `chunk-pw5p538k.js`, `chunk-awr5yyef.js`.
- Local probe & adapter: `src/engine/opencode-protocol.ts`, `src/engine/opencode.test.ts`.

#### Protocol Facts
Inside `opencode`, the event stream emitted by `run --format json` processes `message.part.updated` events:
- `text` events are emitted when a text part finishes (`J.type === "text" && J.time?.end`):
  `{"type": "text", "sessionID": "...", "part": {"id": "...", "type": "text", "text": "...", "time": {"start": ..., "end": ...}}}`
- `tool_use` events are emitted when a tool completes or fails.
- `step_finish` events are emitted at the boundary of each provider hop:
  `{"type": "step_finish", "sessionID": "...", "part": {"id": "...", "type": "step-finish", "reason": "...", "tokens": {...}, "cost": ...}}`

In `chunk-awr5yyef.js:73506899`, the schema for `step-finish` is:
```typescript
vx = W.Literals(["stop", "length", "tool-calls", "content-filter", "error", "unknown"])
StepFinishPart = {
  type: "step-finish",
  reason: vx,
  cost: number,
  tokens: { total, input, output, reasoning, cache }
}
```
In `chunk-pw5p538k.js:65862745`:
- When the model decides to invoke tools, the LLM finishes with `reason: "tool-calls"`.
- When the model provides final text without tool calls, the LLM finishes with `reason: "stop"`.
- When the session becomes idle (`session.status` with `type === "idle"`), the JSON stream closes and the process exits with status code 0.

#### Answer to Question 2 (`opencode`)
- **Is there a machine-readable signal?** **Yes, at the hop level.**
  - **Frame**: `type === "step_finish"`.
  - **Field**: `part.reason` (type: `string`, enum: `["stop", "tool-calls", "length", "content-filter", "error", "unknown"]`).
  - **Values**:
    - `part.reason === "tool-calls"`: Indicates the preceding `text` part in this hop was commentary preceding a tool call.
    - `part.reason === "stop"`: Indicates the preceding `text` part in this hop was completed without tool calls.
- **Current Sprout Bug**: `src/engine/opencode-protocol.ts:61` unconditionally accumulates `state.text += text` and marks every hop `final: true`. If OpenCode outputs commentary before a tool and an answer after, Sprout concatenates both into `state.text`.
- **Distinction from trailing messages**: In `opencode run`, the process exits immediately upon reaching the idle state following the terminal `stop` step.

---

## 2. Comparative Matrix: Signals & Observability

| Feature | Codex (`app-server`) | Pi (`--mode json`) | `agy` (`stream-json`) | OpenCode (`run --format json`) |
|---|---|---|---|---|
| **Authoritative Frame** | None (items inside turn) | None (process exits on settle) | `{"event": "result"}` | None (process exits on idle) |
| **Dedicated Response Field** | None (`ThreadItem.text`) | None (`content[].text`) | `result.response` | None (`part.text`) |
| **Finality Classifier** | `item.phase === "final_answer"` | **None** | Frame identity (`result`) | `step_finish.part.reason === "stop"` |
| **Commentary Classifier** | `item.phase === "commentary"` | `stopReason === "toolUse"` | `step_type === "agent_response"` | `step_finish.part.reason === "tool-calls"` |
| **Signal Reliability** | Partial (schema: `None` possible) | **Zero** (no native signal) | **100%** | High (per-hop finish reason) |
| **Trailing Message Source** | Multi-item turns | Injected follow-up prompts | None | None (single turn process) |
| **Trailing Message Identifiable?** | Yes (lacks `final_answer`) | Only by turn sequence / injection | N/A (no trailing messages) | Yes (hops after `stop` require subagents) |

---

## 3. Design: The Neutral Run-Event Model & Selection Rule

### 3.1. Why the Current Model is Broken

Sprout's existing contract in `src/engine/port.ts` declares:
```typescript
export type AgentRunEvent =
  | { readonly type: 'message'; readonly text: string; readonly final: boolean }
  | { readonly type: 'tool-call'; readonly name: string; readonly detail: string }
  | { readonly type: 'tool-output'; readonly text: string }
  | { readonly type: 'notice'; readonly text: string };

export interface EngineTurn {
  readonly events: AsyncIterable<AgentRunEvent>;
  readonly completion: Promise<EngineTurnResult>;
}

export type EngineTurnResult =
  | { readonly status: 'completed'; readonly text: string }
  | { readonly status: 'interrupted' }
  | { readonly status: 'failed'; readonly message: string };
```

There are three architectural contradictions in this design:

1. **Semantic Overloading of `final: boolean`**:
   Does `final: true` mean *"this chunk completes this message block (not a streaming delta)"* OR does it mean *"this message is the run's final answer to the user"*?
   - `opencode-protocol.ts` used it for block completion: *"Marked final so a caller can tell where a hop's text ended, even though more hops may follow."*
   - `codex-protocol.ts` emitted deltas with `final: false`, then emitted the full text with `final: true`.
   - `agy-protocol.ts` and `pi-protocol.ts` emitted deltas with `final: false` and *never* emitted `final: true`.
   - `web/src/main.ts` assumed `final: true` meant the terminal answer, appending `(final)` to the UI output.

2. **Split Brain Between `events` and `completion`**:
   The terminal answer lives in `EngineTurnResult.text` (resolved via `turn.completion`), but the Web client never displays `run.result.text`. The Web client displays `run.events`. If an adapter fails to set `final: true` on an event, the UI never highlights the answer.

3. **Adapter-Level Guessing without Guidelines**:
   Because the core lacked a unified rule for answer selection, each adapter improvised:
   - `agy` used `result.response`.
   - `codex` used `state.finalText` (last agent message).
   - `pi` used `state.finalText` (last assistant message, allowing trailing warnings to override).
   - `opencode` concatenated all text across hops.

---

### 3.2. Evaluation of Event Model Alternatives

We evaluate three design alternatives for `AgentRunEvent`:

#### Alternative A: Add a Dedicated `result` Event
```typescript
export type AgentRunEvent =
  | { readonly type: 'message'; readonly text: string; readonly delta?: boolean }
  | { readonly type: 'tool-call'; readonly name: string; readonly detail: string }
  | { readonly type: 'tool-output'; readonly text: string }
  | { readonly type: 'notice'; readonly text: string }
  | { readonly type: 'result'; readonly text: string };
```
- **Semantics**: `message` represents interim commentary and streaming output. `result` represents the single authoritative answer to the prompt.
- **Cost**:
  - `src/engine/port.ts`: Add `result` event variant.
  - `web/src/main.ts`: Update `describe()` to format `result` distinctly (e.g. rendered in a primary result card).
  - `src/run/model.ts` & `src/run/sqlite-store.ts`: Zero database migration cost (events are stored as JSON strings).

#### Alternative B: Adopt Codex's `phase` Classification on `message`
```typescript
export type AgentRunEvent =
  | { readonly type: 'message'; readonly text: string; readonly phase: 'commentary' | 'final_answer'; readonly delta: boolean }
  | { readonly type: 'tool-call'; readonly name: string; readonly detail: string }
  | { readonly type: 'tool-output'; readonly text: string }
  | { readonly type: 'notice'; readonly text: string };
```
- **Semantics**: Generalizes Codex's concept across all engines.
- **Cost**: Requires adapters for engines that do not have native phases (`pi`, `opencode`) to synthesize them heuristically.

#### Alternative C: Clarify Existing `final: boolean` + Elevate `run.result.text` in Web Client
- **Semantics**:
  - Keep `AgentRunEvent`: `{ type: 'message', text: string, final: boolean }`.
  - Enforce strict semantic contract: `final: true` is reserved **exclusively** for the run's final answer. All streaming deltas and mid-run commentaries must be `final: false`.
  - The Web client must render `run.result.text` prominently in the UI when `run.status === 'completed'`.
- **Cost**: Minimal diff. No type union breakage; only requires protocol adapter fixes and UI template enhancement.

---

## 4. Recommendation & Selection Rule

### 4.1. The Unified Selection Rule: "Tool-Exhaustion Terminal Selection with Explicit Override"

The rule is structured in two tiers:

```
+-----------------------------------------------------------------------+
| TIER 1: AUTHORITATIVE ENGINE PROTOCOL SIGNAL                         |
| If the engine emits an explicit final answer field:                  |
| - agy: frame.result.response                                          |
| - Codex: item/completed with item.phase === "final_answer"            |
| - opencode: text associated with step_finish.reason === "stop"       |
| -> Take this text as the run's answer. Cannot be overridden.         |
+-----------------------------------------------------------------------+
                                  |
                        (Signal not present / Pi / legacy Codex)
                                  v
+-----------------------------------------------------------------------+
| TIER 2: TOOL-EXHAUSTION TERMINAL HEURISTIC                           |
| If the engine does not provide a protocol signal:                     |
| 1. In a run with tool activity:                                       |
|    The answer is the FIRST pure-text assistant message emitted after  |
|    all tool executions settle (empty tool calls / stopReason 'stop'). |
|    Any subsequent assistant message without preceding tool activity   |
|    is classified as trailing notice/noise (type: 'notice').           |
| 2. In a run without tool activity:                                    |
|    The answer is the assistant message preceding any unsolicited      |
|    external prompt injection, falling back to the last message.       |
+-----------------------------------------------------------------------+
```

### 4.2. How the Rule Operates Across the Four Engines

1. **`agy`**:
   - Matches Tier 1 (`result.response`).
   - Succeeded by design.

2. **Codex**:
   - If the model emits `phase`: Matches Tier 1 (`phase === "final_answer"`). Commentary before tools (`phase === "commentary"`) is never mistaken for the answer.
   - If `phase` is `null` (legacy models): Falls back to Tier 2. The post-tool pure-text message is taken as the answer.

3. **OpenCode**:
   - Matches Tier 1 (`step_finish` with `reason === "stop"`).
   - Commentary preceding tools (`reason === "tool-calls"`) is emitted with `final: false`.
   - Concatenation of all hops is eliminated; only the terminal step text is selected as `EngineTurnResult.text`.

4. **Pi**:
   - Matches Tier 2 (Tool-Exhaustion Terminal Heuristic):
     - Turn 1 (Tool Call): Assistant emits tool call. `stopReason === "toolUse"`. Handled as tool progress (`final: false`).
     - Turn 2 (Real Answer): Tool completes. Assistant outputs `"pi-e2e-ok"`. `stopReason === "stop"` and `toolResults === []`. This closes the tool-execution loop. `state.finalText` is set to `"pi-e2e-ok"`.
     - Turn 3 (Trailing Warning): MCP server warning injected. Assistant outputs `"The UnityMCP server is currently unreachable."`. Because `state.finalText` was already sealed by the post-tool terminal message and no intervening tool calls occurred, this message is mapped to `{ type: 'notice', text: '...' }` rather than overwriting `state.finalText`!
     - Settle: `agent_settled` completes with `text: "pi-e2e-ok"`.

---

## 5. Explicit Trade-offs & Edge Cases

No heuristic over an uninformative engine is perfect. We document the known trade-offs honestly:

### Trade-off 1: Multi-Hop Text Without Tools
*Scenario*: An agent is asked to write an essay or perform pure reasoning. The model chooses to emit its answer across two consecutive text hops without using any tools (e.g. Hop 1: outline, Hop 2: full text).
- **Behavior**: Under Tier 2, if no tools were used, the rule takes the message preceding unsolicited injections or the last message. If the engine uses multiple hops without user injection, taking the last message works, but taking the first message would truncate the response.
- **Mitigation**: Tier 2 distinguishes runs with tool activity from runs without tool activity. In tool-less runs, recency (or concatenation of hops) remains the default unless an unsolicited injection is detected.

### Trade-off 2: Legitimate Trailing Corrections vs Unsolicited Noise
*Scenario*: An agent emits a response, but a linter or test extension automatically detects a syntax error and prompts the agent to correct itself in Turn 3.
- **Behavior**: If the extension's intervention was legitimate and desired, Tier 2 would classify Turn 2 as the answer and Turn 3 as trailing notice.
- **Mitigation**: Sprout O1 explicitly requires that **Sprout owns the agent run and context, not the host CLI installation** (`docs/roadmap.md`). Sprout workers should launch Pi with `--no-extensions` (`src/engine/pi.ts`) so host-level MCP servers and third-party extensions cannot inject unmanaged background turns into Sprout's execution loop.

### Trade-off 3: Legacy Codex Models with Preamble But No Tools
*Scenario*: A legacy model on Codex (emitting `phase: null`) outputs: *"I will solve this math puzzle..."* (Message 1), then outputs *"The solution is 42."* (Message 2), without calling any tools.
- **Behavior**: If Tier 2 took the first message, it would pick the preamble.
- **Mitigation**: For runs without tool activity, the rule takes the *last* assistant message in the turn, ensuring multi-part or preamble text resolves to the final conclusion.

---

## 6. Implementation Impact on Sprout Codebase

### 6.1. Seam Specifications (`src/engine/`)

1. **`src/engine/port.ts`**:
   - Clarify `AgentRunEvent` documentation: `final: true` on `message` must be emitted **only** for the terminal answer message. Streaming deltas and interim commentaries must have `final: false`.

2. **`src/engine/pi-protocol.ts`**:
   - Update `PiTurnState` to track `toolActivity: boolean` and `sealed: boolean`.
   - When a completed assistant message arrives with pure text (`stopReason === 'stop'`) after tool executions, lock `state.finalText` and set `state.sealed = true`.
   - If subsequent assistant messages arrive without new tool executions, emit them as `{ type: 'notice', text: ... }` and do not overwrite `state.finalText`.

3. **`src/engine/codex-protocol.ts`**:
   - In `item/completed`, inspect `item.phase`:
     - If `item.phase === "final_answer"`: set `state.finalText = item.text`, emit `{ type: 'message', text: item.text, final: true }`.
     - If `item.phase === "commentary"`: emit `{ type: 'message', text: item.text, final: false }`.
     - If `item.phase` is missing/null: apply Tier 2 heuristic.

4. **`src/engine/opencode-protocol.ts`**:
   - In `mapOpenCodeEvent`, inspect `part.reason` on `step_finish`:
     - If `reason === "tool-calls"`: previous text was commentary (`final: false`).
     - If `reason === "stop"`: previous text was the terminal answer (`final: true`), set `state.finalText = text`.
   - Do not concatenate all hop texts into `state.text`.

5. **`src/engine/pi.ts`**:
   - Pass `--no-extensions` in `#turnArgs()` to isolate Sprout worker runs from unmanaged host extensions.

### 6.2. Web Client & UI (`web/src/main.ts`)
- In `render(run: RunView)`:
  - Add a dedicated `<div class="run-result">` element that displays `run.result.text` prominently when `run.status === 'completed'`.
  - Keep the `.events` list as the step-by-step progress audit log.

### 6.3. Persistence & Store (`src/run/model.ts`, `src/run/sqlite-store.ts`)
- **Cost: Zero.** `AgentRun.result` already holds `EngineTurnResult` (`{ status, text }`). SQLite stores `events` and `result` as serialized JSON strings. No database schema migration is required.

---

## 7. Verification Plan

When implementation begins, the rule will be verified by:
1. **Pi Trailing Message Test (`src/engine/pi.test.ts`)**:
   - Update the test to verify that the real answer `"pi-e2e-ok"` is preserved as `result.text`, while the trailing MCP warning is mapped to a `notice` event.
2. **Codex Phase Classification Test (`src/engine/codex-protocol.test.ts`)**:
   - Add a test replaying an `item/completed` with `phase: "commentary"`, followed by tool execution, followed by `phase: "final_answer"`.
   - Verify `result.text` matches only the `final_answer`.
3. **OpenCode Multi-Hop Test (`src/engine/opencode.test.ts`)**:
   - Add a test replaying a two-hop turn (Hop 1: pre-tool text + `tool-calls`; Hop 2: answer text + `stop`).
   - Verify `result.text` contains only Hop 2's answer, not the concatenated text.
4. **Web Client Component Test**:
   - Verify that `run.result.text` is displayed distinctly from intermediate progress events.
