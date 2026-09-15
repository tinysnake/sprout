# Research report: secure macOS and Windows Environment enrollment

**Issue:** #47  
**Research date:** 2026-09-15  
**Status:** options and evidence for a later product decision; this report does not select product behaviour

## Executive summary

Sprout can reconcile its existing Windows SSH-tunnel evidence with Web-led
onboarding without making SSH the product protocol. The strongest candidate is
one Sprout-owned, versioned Worker protocol with two possible carriers:

1. a Worker-initiated authenticated HTTPS/WebSocket connection to a Core
   rendezvous/control endpoint; and
2. a direct TLS/WebSocket connection over loopback, a permitted LAN, or an
   operator-managed private overlay when both sides can reach one another.

The first option is the better fit for a Web-led flow and for hosts behind
NAT. The second avoids a relay dependency when the operator has a suitable
private network. Both can carry the same protocol. A relay or overlay should
transport an already authenticated Worker connection; it should not become the
source of Sprout identity or engine credentials.

The current Windows implementation proves a useful baseline: a user-session
Worker daemon binds loopback and the Core reaches it through an SSH local
forward. SSH is encrypted and authenticated, but it couples runtime reachability
to SSH account/key setup and is a poor fit for routine Web enrollment. Keep it as
a provisioning, diagnostics, or compatibility carrier rather than treating the
existing tunnel as the final enrollment experience.

The security model must keep five facts separate:

| Fact | Owner and credential | What it authorizes | What Sprout must not infer |
| --- | --- | --- | --- |
| Worker identity | Worker-generated key pair; private key remains on the host | This process is the enrolled Worker for one Environment/Core relationship | That the host is trusted for every capability |
| Transport security | TLS/WSS, or an equivalent authenticated private carrier | Confidentiality, integrity, endpoint/channel binding | That an encrypted channel implies Human approval |
| Human approval | A short-lived enrollment transaction approved in the Core Web UI | The Human accepts this Worker for the intended Environment | That approval logs an engine in |
| Engine login | Codex/Pi (or another engine) login state managed by the Environment user | The local engine may make provider calls | That the Core may read, copy, or store the credential |
| Environment capability permission | Core/Environment configuration and Human-controlled policy | Which engines, workspace, and operations this Environment may expose | That an installed or logged-in binary is automatically permitted |

This is a research comparison, not an installer or pairing-protocol design.

## 1. Scope, decisions, and threat model

### Settled scope for this comparison

- The target is local macOS and Windows use; there is no public-Internet Sprout
  deployment or multi-Human authorization requirement.
- Windows 11 Home is the minimum supported edition for this work; Pro is
  preferred. Windows Server is not a separate target for the current product
  decision.
- macOS support should follow the versions Apple currently lists in its
  security releases, rather than a hard-coded historical list. Apple publishes
  security releases separately from its version-identification guidance
  ([Apple security releases](https://support.apple.com/en-us/100100), accessed
  2026-09-15; [find the installed macOS version](https://support.apple.com/en-us/109033),
  accessed 2026-09-15).
- A Web-led flow may require one host-side bootstrap action. The Web UI may
  create and approve an enrollment transaction, but it cannot install a
  process, grant a firewall exception, or complete an engine's interactive
  login without a host-side action.
- Engine credentials are wholly Environment-managed. The Core never acquires,
  transports, stores, or asks the Worker to export them. The Worker exposes only
  neutral readiness/capability facts.
- A Worker starts in the signed-in user's context after sign-in. A system/root
  service is not the default because it cannot uniformly see the interactive
  user's engine login, keychain, or workspace.
- Third-party network credentials are host-local. Their control planes or relays
  are allowed, but Sprout Worker ports must not be directly exposed to the
  public Internet.
- Device authorization is preferred. A CLI fallback may use a one-use,
  short-lived, revocable token; it must not leave a persistent enrollment secret
  in shell history or a long-lived config file.
- mDNS/DNS-SD may help discovery but is not trust, identity, or approval.
- One Worker belongs to one Core. Re-enrollment to another Core requires an
  explicit reset/unenroll rather than silently transferring ownership.

### Threat model

The important adversary is an attacker on the same LAN who can observe traffic,
spoof discovery, attempt to impersonate a Worker/Core, replay enrollment data,
or reconnect after revocation. The design should also account for Internet
outages, sleep/NAT changes, duplicate enrollment, and protocol skew.

A malicious administrator of the Environment host is out of scope for this
boundary: that administrator can inspect the Worker process, its private key,
the user's engine state, and the workspace. No transport choice can protect
host-local secrets from that administrator. The Core is likewise assumed not to
be a compromised process; a compromised Core is allowed to be out of scope.

### Security invariants

Every candidate should preserve these invariants:

1. Enrollment proves possession of a newly generated Worker private key, not
   merely knowledge of a display name, IP address, mDNS record, or short code.
2. The enrollment transaction is bound to the intended Core and Environment,
   expires quickly, and cannot be reused after approval, rejection, or reset.
3. Runtime authentication is separate from Human approval and is checked again
   after reconnect. Revocation must prevent a previously enrolled key from
   reconnecting, even if the carrier remains reachable.
4. The Worker private key and engine credentials remain on the Environment host.
5. No candidate requires a Sprout daemon port to be directly reachable from the
   public Internet.
6. A lost channel becomes an explicit unavailable/recovering state; it is not
   silently treated as a settled run.

The OAuth 2.0 Device Authorization Grant is a useful standards analogy for a
browser/device code flow: the device obtains a short-lived user code and the
Human approves on another device ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628),
June 2019). It does not by itself solve Worker key binding, revocation, or
Sprout capability permission, so adopting it would still require Sprout-owned
semantics.

## 2. Current Sprout baseline

ADR-0003 makes the Worker protocol uniform and leaves only the carrier to each
Environment ([ADR-0003](../adr/0003-each-environment-runs-a-sprout-worker.md)).
The current line-framed JSON-RPC methods are in
[`src/worker/protocol.ts`](../../src/worker/protocol.ts): `worker/info`, session
start/run/interrupt/close, and context prepare/recycle. The current `worker/info`
result identifies the Environment instance and configured engine descriptions,
but it has no enrollment identity, authentication, protocol-version, or
capability-permission fields.

The current carriers are:

- local loopback TCP via [`src/worker/carrier.ts`](../../src/worker/carrier.ts);
- container exec stdio, with no published port, via
  [`src/worker/container-carrier.ts`](../../src/worker/container-carrier.ts);
- Windows loopback daemon plus SSH local forwarding via
  [`src/worker/windows-carrier.ts`](../../src/worker/windows-carrier.ts).

The repository's Windows evidence in
  [`docs/research/windows-ssh.md`](windows-ssh.md) and its linked #5
  verification established that a
physical Windows 11 host can run a detached user-session Worker, start it at
logon, host Codex and Pi, and expose only a loopback endpoint through an SSH
`-L` tunnel. That evidence also established that SSH is a carrier, not a
change to the Worker protocol.

This baseline proves transport feasibility, not enrollment product usability:

- an operator must already have a usable SSH account/key path;
- the Core reads a readiness file over a provisioning channel and opens a
  locally selected forward;
- the Worker has no cryptographic Sprout identity or version negotiation;
- the Web product has no enrollment transaction or approval step;
- the Core currently learns configured engine adapters, not a neutral split of
  engine login, installation, and capability permission.

The desired Web flow can therefore wrap the existing deployment as a temporary
carrier: Web creates an Environment record, the Human performs host bootstrap,
and the SSH-backed Worker reports online. That is a valid migration/fallback,
but not evidence that SSH should remain the normal runtime path.

## 3. Host and startup facts

### macOS

Apple documents launch daemons and agents as separate launch-time mechanisms;
agents run in a user's login context while daemons are system-level jobs
([Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html),
archived Apple documentation, accessed 2026-09-15). Apple's newer
[`ServiceManagement`](https://developer.apple.com/documentation/servicemanagement)
framework is the supported API surface for managing login items and services
(accessed 2026-09-15).

Implications for a user-context Worker:

- install and update the Worker and engine binaries for the intended user;
- register a per-user launch agent/login item, not a root daemon by default;
- start after login and restart on unexpected exit;
- read the same user-local keychain/configuration/workspace that an interactive
  Codex or Pi login uses;
- keep the Worker private key and local enrollment state in user-owned storage
  with restrictive permissions.

Homebrew can be a supported convenience installer for a development build.
Its `services` command manages background processes through the platform's
service mechanism ([Homebrew manpage, `services`](https://docs.brew.sh/Manpage#services-subcommand),
accessed 2026-09-15). It is not a substitute for an enrollment identity or
revocation protocol.

### Windows 11

The product support floor is Windows 11 Home, with Pro preferred. The platform
requirements are maintained by Microsoft ([Windows 11 specifications](https://www.microsoft.com/en-us/windows/windows-11-specifications),
accessed 2026-09-15). Windows Task Scheduler can create a task triggered by a
user logon; Microsoft documents both the scheduler model and the `schtasks`
command ([Task Scheduler examples](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-1-0-examples),
accessed 2026-09-15; [`schtasks`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks),
accessed 2026-09-15).

Implications:

- install the Worker and engines in the intended user's context;
- use a logon-triggered scheduled task for the default lifecycle;
- do not assume a LocalSystem/service process can consume the interactive
  user's engine login, keychain-equivalent stores, or workspace;
- use PowerShell for the one-time bootstrap and diagnostics, but launch the
  Worker directly rather than putting its JSON stream through a shell pipeline;
- keep private enrollment material in user-controlled storage with Windows ACLs;
- treat sleep, logoff, task disablement, and user profile changes as explicit
  availability states.

WinGet is a possible update/install mechanism, not a required dependency. Its
official documentation covers install/manage and upgrade operations
([Use WinGet](https://learn.microsoft.com/en-us/windows/package-manager/winget/),
accessed 2026-09-15; [`winget upgrade`](https://learn.microsoft.com/en-us/windows/package-manager/winget/upgrade),
accessed 2026-09-15). A PowerShell script, a self-built binary, or an existing
package manager can be used while the product has no commercial code-signing
requirement. Unsigned distribution increases host trust/Gatekeeper/Defender
friction and should be made visible, not hidden as a transport concern.

Microsoft documents Windows OpenSSH installation and configuration as optional
Windows components ([Get started with OpenSSH Server for Windows](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse),
accessed 2026-09-15; [OpenSSH server configuration](https://learn.microsoft.com/en-us/windows-server/administration/OpenSSH/openssh-server-configuration),
accessed 2026-09-15). SSH availability should not be made a prerequisite for a
non-SSH Worker carrier.

### Steps that necessarily remain on the Environment host

The Web/Core can prepare instructions, show status, and record completion. It
cannot perform these actions without a host-side agent or explicit host
interaction:

| Host action | Why it is host-local | May Web automate the instructions? |
| --- | --- | --- |
| Install Node/Worker and engine binaries | Writes local files and executes code | Yes, through a copy/paste or download-and-run bootstrap |
| Choose the user and workspace | The process must have the intended filesystem/security context | Yes, by asking the Human to confirm local choices |
| Log Codex/Pi in | Provider credentials and browser/keychain state belong to the user and host | It may show “login required”; it must not handle the secret |
| Register launch agent or scheduled task | Requires local OS registration and user-session choice | Yes, via a host command or local helper |
| Approve firewall/overlay/relay access | Changes host/network policy and may require provider credentials | Yes, by giving provider-specific instructions |
| Generate/store Worker private key | The private key must never transit the Core | A host bootstrap must generate it locally |
| Reset/unenroll local state | Removes or invalidates host-local identity material | Yes, with Human confirmation and a host command |

## 4. Candidate enrollment lifecycle

The following is a comparison baseline, not a committed protocol. It gives the
later implementation ticket concrete seams to evaluate.

### Web-led flow

1. The Human creates an Environment enrollment attempt in Web. Core creates a
   short-lived, one-use transaction bound to the Core, Environment, expected
   Worker protocol range, and an expiration time.
2. Web presents a host bootstrap command or package/download instruction. The
   command contains no engine credential and no reusable enrollment secret.
3. On the host, the bootstrap validates platform/runtime prerequisites, creates
   a Worker key pair locally, stores the private key with host ACLs, installs the
   Worker and engines as requested, and registers the user-session startup.
4. The Worker connects using a candidate carrier or prints a short code/URL for
   the Human. The code is only a lookup handle for the pending transaction; it
   is not proof of identity.
5. Web shows the pending Worker facts. The Human approves the expected host in
   Web. Core and Worker complete a challenge-response proving private-key
   possession and bind the approved public key to the Environment.
6. Worker reports protocol/build compatibility, configured capabilities, and
   neutral engine readiness. Core records only the approved Worker identity and
   those portable facts.
7. Later reconnects use the enrolled key and transport authentication. They do
   not create a new Human approval unless the identity was reset, revoked, or
   replaced.

The browser/device-code shape follows the useful separation in RFC 8628, while
the key proof is Sprout-specific. For a CLI fallback, the Human can paste a
short-lived one-use token into the host bootstrap or provide it through a
non-persistent input channel. The bootstrap should consume it once, never echo
it, and avoid putting it in a command line that normal shell history records.

### What “online” means

Enrollment should not mark a Worker online merely because a process started or a
port answered. The state should progress through independently observable facts:

1. carrier reachable;
2. transport authenticated and bound to the enrolled Worker key;
3. protocol compatible;
4. Environment capability permission accepted;
5. engine executable discovered;
6. engine login/readiness known; and
7. a harmless engine start/readiness probe succeeds when the adapter supports
   one.

This prevents “installed”, “logged in”, “permitted”, and “currently runnable”
from collapsing into one misleading green status.

## 5. Connectivity options

All options below should carry the same Worker protocol. The Web/API layer
should not know whether bytes arrived through loopback, a LAN socket, a mesh, or
a relay.

### Option A — loopback/direct private TCP with authenticated TLS/WebSocket

The Worker listens on loopback for a same-host Core, or on a deliberately
firewalled private interface for a directly reachable host. The application
protocol can remain line-framed JSON-RPC over a byte stream, or be framed inside
WebSocket. WebSocket is a standardized message framing protocol
([RFC 6455](https://www.rfc-editor.org/rfc/rfc6455), December 2011); TLS 1.3 is
specified by [RFC 8446](https://www.rfc-editor.org/rfc/rfc8446), August 2018.

For a LAN form, transport encryption alone is insufficient. The Core must pin
the Worker public key/certificate discovered during approved enrollment, or use
mutual authentication, and the Worker must similarly authenticate the Core.
The listener must be firewall-scoped to the intended private network, never
bound to a public interface by default. An mDNS/DNS-SD record can advertise a
candidate endpoint, but mDNS explicitly concerns local-link discovery
([RFC 6762](https://www.rfc-editor.org/rfc/rfc6762), February 2013; service
discovery [RFC 6763](https://www.rfc-editor.org/rfc/rfc6763), February 2013), not
authentication.

**Advantages:** no relay dependency, low latency, simple same-host model, easy
to test against the existing loopback carrier.  
**Costs:** inbound reachability and firewall/certificate handling; direct LAN
discovery can be spoofed; it does not solve NAT or changing networks.

### Option B — Worker-initiated outbound WSS/control connection

The Worker dials an approved Core endpoint over outbound HTTPS/WSS, maintains a
heartbeat, and reconnects with bounded backoff. Core sends only authenticated,
authorized Worker commands over that connection. The Worker need not listen on
an inbound public port; a LAN attacker sees encrypted traffic and cannot become
the Core without passing Core/Worker authentication.

This is the most natural fit for Web-led onboarding: the host bootstrap needs
only outbound access, while the Core can show pending, online, reconnecting,
revoked, and incompatible states. It is also the best fit for hosts whose
address changes or which sit behind NAT.

**Advantages:** no inbound Worker port, works across NAT/private networks,
single application carrier, Web can observe lifecycle.  
**Costs:** requires a reachable Core rendezvous/control service; an Internet
outage makes the Environment temporarily unavailable unless a separate private
carrier is configured; the control service becomes availability and metadata
infrastructure. Reconnect must re-authenticate and re-check revocation.

This option is not a public multi-tenant deployment proposal. The control
endpoint can be self-hosted/local to the operator, and a relay may carry only
encrypted/authenticated Sprout traffic. No central Codex/Pi credential is
needed.

### Option C — Managed private overlay

Tailscale or ZeroTier can provide a private, operator-managed path over which
Option A's authenticated application protocol runs. Tailscale documents that
traffic may be direct between nodes or traverse its encrypted DERP relay when a
direct path is unavailable ([traffic routing through Tailscale](https://tailscale.com/docs/concepts/traffic-routing-through-tailscale),
accessed 2026-09-15; [DERP servers](https://tailscale.com/docs/reference/derp-servers),
accessed 2026-09-15). ZeroTier documents its virtual-network protocol and root
infrastructure ([ZeroTier documentation](https://docs.zerotier.com/), accessed
2026-09-15; [roots](https://docs.zerotier.com/roots/), accessed 2026-09-15).

**Advantages:** avoids opening a normal LAN listener to arbitrary local peers;
can provide direct paths with a relay fallback; provider handles difficult NAT
cases.  
**Costs:** provider account, node authorization, client lifecycle, and outage
become host/operator concerns; overlay membership is not Sprout Human approval;
the application still needs its own Worker identity, TLS/key pinning, protocol
version, and revocation. Provider credentials and node keys stay on the host or
in the operator's private network administration, not in Sprout engine state.

This option is compatible with the “common protocol instead of SSH” preference,
but should remain optional. Do not treat a Tailscale/ZeroTier IP or membership
as proof that the correct Worker is connected.

### Option D — Cloudflare Tunnel/Access-style outbound connector

Cloudflare Tunnel's connector model is an outbound connector from the private
network to Cloudflare; its documented use is to publish private applications
without exposing an inbound origin listener ([Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/),
accessed 2026-09-15). Service tokens are a separate Access credential
mechanism ([service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/),
accessed 2026-09-15).

**Advantages:** outbound-only host connectivity, a mature HTTPS edge, and
provider access policy.  
**Costs:** the normal shape is a public hostname/edge policy even when the
origin is private; this adds a third-party identity and policy plane that is
larger than Sprout's local-operator need. A Cloudflare token authenticates to
Cloudflare, not necessarily to the intended Sprout Worker. It therefore still
needs Sprout key binding, approval, and revocation.

Cloudflare is a viable operator-selected carrier for Option B, not a reason to
make Sprout Worker ports public and not a replacement for the Worker protocol.

### Option E — Existing Windows SSH tunnel

The current evidence uses SSH to provision/debug the Windows daemon and to
forward a local Core port to a loopback Worker endpoint. Microsoft documents
the Windows OpenSSH server and configuration above. The repository evidence
also records the Windows-specific guardrails: no PTY for JSON, keepalives,
detached user-session startup, and in-band Worker interruption rather than
assuming POSIX signal forwarding.

**Advantages:** already exercised; encrypted/authenticated; no public Worker
listener; can be a useful bootstrap and emergency diagnostic path.  
**Costs:** SSH account/key provisioning is a separate Human workflow; Windows
shell, service, logon, and key ACL behaviour add failure modes; Web cannot
meaningfully enroll a host that has not already been SSH-prepared; reconnect,
revocation, and duplicate identity are coupled to SSH configuration unless
Sprout adds a second identity layer.

**Reconciliation:** preserve `SshTunnelCarrier` as a compatibility carrier
while a new carrier uses the same Worker protocol. A Web-led enrollment can
use SSH as the one-time bootstrap if that is the operator's choice, but the
runtime should not assume SSH, and SSH authorization must not be mistaken for
Sprout Human approval. This meets the existing evidence without selecting SSH
as final product behaviour.

### Comparison matrix

| Candidate | Inbound Worker port | Works behind NAT | Web-led fit | LAN attacker protection | Internet outage | Operational burden |
| --- | --- | --- | --- | --- | --- | --- |
| Loopback | No | Same host only | Good after host bootstrap | Host boundary | Local Core can continue | Low |
| Direct private TLS/WSS | Usually yes, firewall-scoped | No | Moderate | TLS + pinned Worker/Core identity required | Continues if private path works | Medium |
| Outbound WSS | No | Yes | Strong | TLS + Worker/Core identity + command authorization | Temporarily unavailable, auto-reconnect | Medium; needs control endpoint |
| Tailscale/ZeroTier + private TLS/WSS | Overlay-dependent | Usually yes, relay fallback | Moderate | Overlay is defense-in-depth, not Sprout identity | Provider-dependent | High; host provider auth |
| Cloudflare Tunnel/Access | No origin port | Yes | Moderate | Edge policy plus Sprout identity | Temporarily unavailable | High; third-party policy |
| SSH local tunnel | No public Worker port | Via SSH reachability | Weak/moderate | SSH auth + encrypted tunnel; Sprout identity still absent today | Unavailable | Existing, but Windows-specific |

## 6. Capability and engine-authentication detection

The Worker is the only component that can honestly inspect the Environment's
local engine state. The Core should receive a sanitized, stable projection such
as:

- engine identifier and adapter version;
- executable found/not found and version string, where available;
- capability permission: allowed, denied, or not configured;
- authentication readiness: authenticated, login required, unavailable, or
  unknown;
- last probe time and a neutral reason suitable for Human display;
- actual start/readiness result when a safe probe is supported.

The explicit auth state is preferable when an engine offers a stable, non-secret
status check. Otherwise, report an abstract `unknown`/`ready` capability and
let a real start prove or reject readiness. Never scrape or transmit a token,
cookie, auth file, provider account identifier, keychain item, or raw engine
stderr to Core.

Codex's authentication contract is owned by the Codex CLI and its published
documentation ([Codex authentication](https://github.com/openai/codex/blob/main/docs/authentication.md),
accessed 2026-09-15). Pi's authentication and provider configuration are likewise
owned by its coding-agent package ([Pi coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md),
accessed 2026-09-15). These sources support keeping login on the host; they do
not authorize Sprout to normalize or copy provider credentials.

Capability permission is a different Core fact. An installed and authenticated
Codex binary may still be disabled for this Environment, and a permitted engine
may be temporarily unavailable because its binary, workspace, provider, or
login is not ready. `worker/info` should eventually expose these neutral facts
without leaking engine-native protocol details into Core.

## 7. Lifecycle and failure matrix

| Case | Required observable result | Candidate-independent handling to evaluate |
| --- | --- | --- |
| Host first starts | `pending` until key proof, approval, compatible protocol, and capability facts complete | User-session launch agent/task; no “online because process exists” shortcut |
| Normal reconnect | Same Worker identity resumes after transport authentication | Heartbeat, bounded backoff, re-check revocation and protocol compatibility |
| Offline/Core unreachable | Environment shows unavailable/reconnecting; no false success | Worker retries automatically; outbound candidate is unavailable without its control endpoint, while a private carrier may continue |
| Direct channel lost during a turn | Explicit channel loss; run is not silently settled | Compare “Worker continues and buffers” with “interrupt and use existing lease/run recovery”; do not redesign the lease in this ticket |
| Duplicate enrollment, same key | Idempotent reconnect or visible already-enrolled state | Do not create a second Environment identity for the same Worker key |
| Duplicate enrollment, new key | Reject while old binding is active | Require explicit reset/unenroll and a new Human approval; one Worker belongs to one Core |
| Revocation | Existing sessions/commands stop according to current run-recovery semantics; future handshakes fail | Revoke Core binding and carrier authorization; invalidate pending transactions; host unenroll removes local key/config |
| Version mismatch | Visible incompatible state before work starts | Handshake protocol version and feature range before `worker/info`; offer upgrade/downgrade instructions, never silently guess |
| Engine login expires | Worker remains enrolled but engine readiness becomes `login-required`/`unknown` | Human logs in on host; Core never receives the credential |
| Binary missing/permission denied | Worker remains reachable but capability is unavailable | Distinguish install, permission, auth, and runtime probe errors |
| Sleep/logoff/task disabled | Worker becomes unavailable with a reason | On next user login, restart and reconnect; preserve durable Core state |
| Reset/re-enroll | Old identity cannot reconnect | Human-confirmed host-local wipe plus Core revocation, then a fresh key and approval |

Two decisions intentionally remain open for a later task. First, whether a
disconnected Worker is allowed to finish an in-flight engine turn and buffer
events, or whether Core should interrupt and let existing run recovery classify
the outcome. Second, the exact lease interaction. This research only requires
that the carrier report the disconnect and that the existing durable recovery
path remain authoritative; it does not redesign the Environment lease model.

## 8. Decision options for follow-up work

These are prioritized investigation options, not a product selection.

### Option 1: one protocol, outbound WSS as the primary remote carrier

Add a Worker identity/handshake seam and a Web-led enrollment transaction, then
make the Worker dial Core over authenticated WSS. Keep loopback for same-host
operation and retain SSH as a compatibility/bootstrap carrier.

- Best alignment with Web onboarding, NAT, reconnect, and no public Worker port.
- Requires a self-hosted/local rendezvous or relay component and explicit
  offline/reconnect UX.
- Most natural place to enforce revocation, duplicate binding, and protocol
  version before `worker/info`.

### Option 2: one protocol, direct private TLS/WSS with optional mesh

Keep Core-initiated/direct connectivity as the primary path. Offer Tailscale or
ZeroTier as operator-managed private reachability, with mDNS only as a
convenience discovery layer.

- Lowest central infrastructure and can work during an Internet outage when
  the private path remains available.
- More host/network/firewall setup and poorer Web-only experience across NAT.
- Still requires Sprout key binding; overlay membership is not approval.

### Option 3: staged migration from the current SSH carrier

Put the Web enrollment record, short-lived approval transaction, Worker identity,
and capability projection around the existing Windows daemon/tunnel first. Add
the common authenticated carrier later.

- Smallest immediate change and reuses live Windows evidence.
- Preserves SSH's setup burden and does not fully deliver routine Web-led
  onboarding; should be labelled compatibility/fallback rather than the target
  architecture.

### Option 4: provider connector adapter

Support a user-selected Cloudflare Tunnel/Access or equivalent connector as a
carrier for Option 1, without making it mandatory.

- Useful for operators already running that provider and for difficult NAT.
- Adds external policy, billing/availability, and credential lifecycle; it is
  not a substitute for Sprout's identity or approval.

The next production ticket should choose one option only after deciding the
reconnect/in-flight-turn policy and the minimum Worker handshake fields. None
of those choices is selected by this report.

## 9. Reference designs checked

The following are pinned, mature design references rather than vendor primary
sources for Sprout requirements. They were inspected at the commits below.

### Cumora

- Repository: [yetone/cumora](https://github.com/yetone/cumora)
- Commit: [`a0309618b9102fc79221f8580afdd2f2372ab5df`](https://github.com/yetone/cumora/tree/a0309618b9102fc79221f8580afdd2f2372ab5df)
- Relevant files: [desktop onboarding](https://github.com/yetone/cumora/blob/a0309618b9102fc79221f8580afdd2f2372ab5df/src/desktop/Onboarding.tsx),
  [computer daemon](https://github.com/yetone/cumora/blob/a0309618b9102fc79221f8580afdd2f2372ab5df/server/src/agents/computer/daemon.ts),
  and [computer registry](https://github.com/yetone/cumora/blob/a0309618b9102fc79221f8580afdd2f2372ab5df/server/src/agents/computer/registry.ts).
- Adoptable pattern: a browser-led host bootstrap, outbound daemon heartbeat,
  reconnect, server-side device status, and a distinction between installed
  but blocked engines and runnable engines.
- Deliberate deviation: its inspected pairing/reattachment path includes
  persistent device-token behaviour. Sprout's agreed direction requires a
  short-lived, one-use enrollment transaction and explicit reset/re-enrollment;
  Cumora's token lifecycle must not be copied as product policy.

### Paperclip

- Repository: [paperclipai/paperclip](https://github.com/paperclipai/paperclip)
- Commit: [`5b913e794315530b95f2bc95dd80e3ebc266b257`](https://github.com/paperclipai/paperclip/tree/5b913e794315530b95f2bc95dd80e3ebc266b257)
- Relevant design references: [runner architecture](https://github.com/paperclipai/paperclip/blob/5b913e794315530b95f2bc95dd80e3ebc266b257/doc/architecture/paperclip-runner.md),
  [durable recovery](https://github.com/paperclipai/paperclip/blob/5b913e794315530b95f2bc95dd80e3ebc266b257/packages/paperclip-runner/docs/durable-recovery.md),
  [durable transport](https://github.com/paperclipai/paperclip/blob/5b913e794315530b95f2bc95dd80e3ebc266b257/packages/paperclip-runner/runner/DURABLE_TRANSPORT.md),
  and [protocol compatibility](https://github.com/paperclipai/paperclip/blob/5b913e794315530b95f2bc95dd80e3ebc266b257/packages/paperclip-runner/docs/protocol-compatibility.md).
- Adoptable pattern: an outbound authenticated WebSocket, short-lived bootstrap
  ticket, connection lease, protocol negotiation, durable outbox/ACK, and
  bounded reconnect/recovery.
- Deliberate deviation: Paperclip also contains SSH-based remote workspace
  paths. Those are evidence that SSH is useful in some deployment seams, not a
  reason to select SSH for Sprout's Worker enrollment or runtime carrier.

## 10. Source register and limits

Primary platform/standards sources were checked on 2026-09-15. Mutable vendor
documentation is recorded by URL and access date; the GitHub reference designs
are recorded by immutable commit above.

- Apple: [security releases](https://support.apple.com/en-us/100100), [launchd
  jobs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html),
  and [ServiceManagement](https://developer.apple.com/documentation/servicemanagement).
- Microsoft: [Windows 11 specifications](https://www.microsoft.com/en-us/windows/windows-11-specifications),
  [Task Scheduler](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-1-0-examples),
  [WinGet](https://learn.microsoft.com/en-us/windows/package-manager/winget/),
  and [OpenSSH for Windows](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse).
- Standards: [RFC 8628 device authorization](https://www.rfc-editor.org/rfc/rfc8628),
  [RFC 6455 WebSocket](https://www.rfc-editor.org/rfc/rfc6455), [RFC 8446 TLS
  1.3](https://www.rfc-editor.org/rfc/rfc8446), [RFC 6762 mDNS](https://www.rfc-editor.org/rfc/rfc6762),
  and [RFC 6763 DNS-SD](https://www.rfc-editor.org/rfc/rfc6763).
- Network providers: [Tailscale traffic routing](https://tailscale.com/docs/concepts/traffic-routing-through-tailscale),
  [Tailscale DERP](https://tailscale.com/docs/reference/derp-servers), [ZeroTier
  documentation](https://docs.zerotier.com/), and [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/).
- Engines: [Codex authentication](https://github.com/openai/codex/blob/main/docs/authentication.md)
  and [Pi coding-agent documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md).

Limits of the evidence:

- Provider connectivity and access-control behaviour changes with account plan,
  client version, administrator policy, and network conditions. A follow-up
  prototype must test the chosen carrier on supported macOS and Windows hosts.
- This report does not claim that Windows Home/Pro, a specific macOS release,
  or any provider guarantees a particular engine's login UX. Engine readiness
  remains an Environment-local adapter fact.
- No installer, pairing protocol, lease redesign, public deployment, or
  multi-Human authorization was implemented here.
