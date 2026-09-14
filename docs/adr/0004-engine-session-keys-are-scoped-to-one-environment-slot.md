# Engine session keys are stored per agent, engine, environment instance, and working directory

Cross-run context continuation means handing a later run the engine session key
of an earlier one. That key is engine-native and opaque, but where it is valid is
not: research (#19) established that a key is issued by one engine, recorded in
one environment's engine store, and — for Pi and `opencode` — coupled to the
working directory it was created in. A key reused outside those bounds either
resumes the wrong conversation or fails.

We decided the durable record's identity is the tuple
`(agent, engine, environment instance, working directory)`, and that a run may
only reuse a key whose entire tuple matches. The identifying string is the JSON
encoding of that tuple rather than a delimiter-joined string, so a working
directory containing the delimiter cannot collide with another slot.

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

- A run that moves to a different environment instance or working directory
  simply starts a fresh session; there is no cross-environment hand-off here
  (that is a separate ticket).
- The worker protocol carries the same two neutral fields, so the resume seam
  crosses the worker boundary without exposing any engine concept (ADR-0003).
- Verification of resumption (detecting a changed `agy` id or a fresh Pi session)
  is implicit in persisting the used key rather than the offered one.
