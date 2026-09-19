# Operator identity and browser sessions

Ticket #84 establishes Sprout's one **operator identity** boundary (see
`CONTEXT.md` and ADR-0009). It is not a Human-account system: one Sprout
instance has one operator identity, and desktop and phone browsers hold
separate sessions of that identity.

## Host-only initialization and recovery

`SPROUT_OPERATOR_CREDENTIAL` is a host-only input. It has no default and is
read through `HostConfiguration`, never runtime JSON. On a new durable store it
initializes the operator identity. Supplying the same value after a normal
restart keeps existing sessions. Supplying a different host-local value is
recovery/rotation: it replaces the stored verifier and invalidates every browser
session. No Web API can initialize, recover, rotate, or export this input.

The durable store retains an scrypt verifier and salt, not the host input. It
retains SHA-256 digests for browser bearer and request-forgery values, not their
raw values. Each session persists a finite 30-day absolute deadline and a
rolling 12-hour idle deadline. Activity may refresh only the idle deadline and
never beyond the absolute deadline. Expired sessions are rejected, removed from
active listings, and revocable cleanup records their expiry. Session list records
expose only non-authorizing session references and timestamps so a browser can
select one to revoke.

## Browser boundary

`POST /api/auth/session` accepts the credential in a request body, never a URL.
On success it writes a `HttpOnly`, `SameSite=Strict`, path-scoped session cookie
with `Max-Age` and `Expires` limited to the current finite deadline, and returns
a separate request-forgery value for the browser to send as `X-Sprout-Csrf` on
every state-changing API request. TLS sockets also receive the `Secure` cookie
flag; host-local HTTP omits it because browsers reject `Secure` cookies over
that supported local transport.

All `/api` reads and commands require a valid browser session in the composed
runtime, except this credential exchange. All state-changing commands also
require request-forgery proof. The browser boundary fixes Human attribution to
the one operator identity; JSON cannot claim Human authority for an anonymous,
Agent, or Worker caller.

`GET /api/auth/sessions` lists active sessions. An authenticated browser can
revoke one through `POST /api/auth/sessions/:id/revoke`, revoke every other
session through `POST /api/auth/sessions/revoke-others`, or sign itself out with
`DELETE /api/auth/session`. Each command requires request-forgery proof.

These endpoints deliberately do not add a settings page or a general API
transport/page contract; that work remains outside Ticket #84.
