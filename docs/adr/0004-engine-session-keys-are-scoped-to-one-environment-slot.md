# Engine session keys are scoped by placement, work area, and authorization

Cross-run context continuation means handing a later run the engine session key
of an earlier one. That key is engine-native and opaque, but where it is valid is
not: research (#19) established that a key is issued by one engine, recorded in
one engine host's session store, and — for Pi and `opencode` — coupled to the
working directory it was created in. A key reused outside those bounds can
resume the wrong conversation or fail.

We decided the durable record's identity includes the Agent, engine, execution
mode, actual engine host and profile, Environment instance, working directory,
and the authorized Conversation, Routing batch, or Task that owns the continuation.
This prevents a mode change, host/profile change, different work area, or unrelated
conversation from receiving a prior native key. The identifying string is the
JSON encoding of that tuple, so delimiters in an identifier cannot collide with
another slot.

**Sprout never assumes resumption succeeded.** It persists the key the run
*actually used*, not the key it was handed, and it reads that key after the turn
settles — engines that assign their own key (`agy`, `opencode`) only reveal it on
the stream. **A refused key degrades to a fresh session instead of failing the
run.** Pi and `agy` fall back themselves (soft), while Codex and `opencode` fail
hard. Retrying those is safe and is done only when the engine *explicitly
refuses* the supplied key: a refused session start carries the neutral
`EngineResumeRefusedError`, and a refused resume reported through a turn carries
`resumeRefused` on the failed turn result. The core forgets the key and retries
once, fresh, **only** for those. Any other failure with a stored key — a failed
initialization, a missing binary, an authentication failure, a transport failure,
or a valid resume whose first turn fails without a refusal — is reported as a real
failure and leaves the stored key in place, so an unrelated problem can neither be
hidden behind a silent retry nor discard a usable continuation key.

Stored behind an explicit `SessionKeyStore` interface with an in-memory and a
SQLite implementation (ADR-0002). The resume input crosses the engine port as one
field, `resumeSessionKey`, and the engine-reported key returns as one field,
`engineSessionKey`; the refusal crosses as the neutral `EngineResumeRefusedError`
(or a `resumeRefused` turn result). The worker protocol carries the same neutral
classification as a protocol error code, so the retry decision survives the
worker boundary without exposing which engine refused.

**Rejected alternatives**: keying only by `(agent, engine)` would reuse a key
across environments and directories where it is meaningless. Retrying a
resume-key refusal unconditionally would repeat a run whose engine had already
executed tools. Retrying *any* failure that supplied a key (the first cut of this
ticket) would discard a valid key and hide an unrelated engine failure behind a
fresh-session retry. Treating a stale key as a run failure would surface an
engine-storage detail to the user for a condition Sprout can recover from itself.
Persisting the supplied key rather than the used key would keep re-offering a key
the engine has already refused.

**Consequences**

- A run that moves to a different Environment instance, engine host/profile,
  working directory, or authorized Conversation, Routing batch, or Task starts a
  fresh session; there is no cross-environment hand-off here (that is a separate ticket).
- A run without an authorized scope receives no stored session key.
- The worker protocol carries the same two neutral fields, so the resume seam
  crosses the worker boundary without exposing any engine concept (ADR-0003).
- Verification of resumption (detecting a changed `agy` id or a fresh Pi session)
  is implicit in persisting the used key rather than the offered one.
