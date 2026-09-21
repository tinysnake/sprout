/**
 * Worker transport rules (#115, ADR-0012).
 *
 * A Worker initiates exactly one authoritative connection to the Sprout
 * instance. Loopback may use plaintext WS; a non-loopback connection must use
 * WSS over the operator-managed private network. Non-loopback plaintext is
 * refused **before any Worker command is accepted**, so a downgraded carrier can
 * never carry a Worker request.
 *
 * The rule is a pure function of two facts — whether the socket is encrypted and
 * whether the peer address is loopback — so both the core (validating an
 * upgrade) and the Worker (choosing a URL) apply the same decision and cannot
 * drift.
 */

/** Whether a peer/host address is loopback (IPv4, IPv6, or a loopback name). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined || address === '') return false;
  const normalized = address.trim().toLowerCase();
  if (normalized === 'localhost') return true;
  // IPv4 loopback 127.0.0.0/8.
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) return true;
  // IPv6 loopback, with or without a zone id, and the IPv4-mapped form.
  const bare = normalized.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true;
  if (bare.startsWith('::ffff:')) return isLoopbackAddress(bare.slice('::ffff:'.length));
  return false;
}

export type WorkerTransportKind = 'ws' | 'wss';

/** One Worker connection's transport facts, as observed at the core. */
export interface WorkerTransportFacts {
  /** True when the socket is TLS-terminated (`wss`). */
  readonly secure: boolean;
  /** The peer address the core observed. */
  readonly remoteAddress: string | undefined;
}

export type WorkerTransportDecision =
  | { readonly allowed: true; readonly kind: WorkerTransportKind }
  | { readonly allowed: false; readonly reason: string };

/**
 * Decide whether an accepted Worker connection may carry Worker commands.
 *
 * Loopback plaintext is allowed; anything else requires TLS. This is checked
 * before the upgrade is accepted, so a refused connection never reaches the
 * JSON-RPC dispatch.
 */
export function decideWorkerTransport(facts: WorkerTransportFacts): WorkerTransportDecision {
  if (facts.secure) return { allowed: true, kind: 'wss' };
  if (isLoopbackAddress(facts.remoteAddress)) return { allowed: true, kind: 'ws' };
  return {
    allowed: false,
    reason:
      'a non-loopback Worker connection must use WSS; plaintext WS is refused before any command is accepted',
  };
}

/**
 * The URL a Worker should dial for one target host.
 *
 * The Worker is the connection initiator, so it chooses the scheme: `wss` for a
 * non-loopback host, `ws` for loopback. A caller that explicitly requests a
 * scheme still cannot force plaintext to a non-loopback host: the rule wins.
 */
export function workerConnectionUrl(input: {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  /** The scheme the operator configured, if any. Defaults from the host. */
  readonly scheme?: WorkerTransportKind;
}): string {
  const loopback = isLoopbackAddress(input.host);
  const scheme: WorkerTransportKind = loopback ? (input.scheme ?? 'ws') : 'wss';
  // A loopback target may never be forced to `wss` if the operator asked for
  // plaintext, but a non-loopback target may never be forced to `ws`.
  const effective = !loopback && input.scheme === 'ws' ? 'wss' : scheme;
  return `${effective}://${formatHost(input.host)}:${input.port}${input.path}`;
}

function formatHost(host: string): string {
  // An IPv6 literal must be bracketed inside a URL authority.
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
