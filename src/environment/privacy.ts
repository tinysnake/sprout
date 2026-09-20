/**
 * Structured privacy boundary for free-form Environment text (#87, ADR-0009).
 *
 * ADR-0009's durable-diagnostics rule forbids credentials, tokens, hostnames,
 * network addresses or topology, absolute host paths, and unsanitized stderr from
 * ever being persisted or returned. The enrollment domain has three fields that a
 * caller can fill with arbitrary text — an operator's revoke/reset reason, a
 * Worker compatibility detail, and a readiness-probe summary — so they pass
 * through this Module before they reach durable state or the wire contract.
 *
 * The redaction is **structural**: it removes the sensitive categories and keeps
 * the decisive operator-facing remainder, so a reason stays useful ("host
 * retired", "worker protocol 3.0 is newer than the maximum v2") while a leaked
 * path or credential is replaced by a bounded category placeholder. Coverage is
 * general rather than a list of known host roots: any absolute POSIX path, any
 * dotted or machine-style hostname, and any `credential=value` assignment is
 * removed, because the boundary exists precisely for the text nobody
 * anticipated. This Module is deliberately free of `node:*` so the browser wire
 * contract can import it.
 */

/** Categories this boundary removes before text can be persisted or returned. */
const REDACTIONS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  // Private key material first: its body must never be partially exposed. A
  // PEM block is removed whole, before any keyword rule can leave its body.
  {
    pattern: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
    replacement: '<redacted-private-key>',
  },
  { pattern: /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g, replacement: '<redacted-pem-block>' },
  { pattern: /-----BEGIN [A-Z0-9 ]+-----/g, replacement: '<redacted-pem-block>' },
  // A named credential assignment is removed as a **whole** key/value pair, not
  // punctuation-stripped: the keyword names the secret and the value must not
  // survive in any form. The separator may be `=` or `:` (optionally spaced) and
  // the keyword itself may contain a space (`api key`, `private key`);
  // `passphrase`/`passcode` are phrases, so their value may span a few words or
  // follow a copula. A bare-space separator is kept deliberately narrow in the
  // last rule (a quoted value or a long unbroken run) so an ordinary sentence
  // like "token bucket exhausted" or "password rotation required" survives.
  //
  // These run before the standalone `private key` keyword rule so
  // `private_key=secret` is removed entirely rather than leaving the value.
  {
    pattern: /\b(?:passphrase|passcode)\b\s*(?::|=|is|was|are|were)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+(?:\s+[^\s,;]+){0,3})/gi,
    replacement: '<redacted-credential>',
  },
  {
    pattern: /\b(?:password|passwd|pwd|secret|token|api[_-]?\s?key|apikey|access[_-]?\s?key|secret[_-]?\s?key|private[_-]?\s?key|signing[_-]?\s?key|encryption[_-]?\s?key|client[_-]?\s?secret|auth[_-]?\s?token|credential(?:s)?)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    replacement: '<redacted-credential>',
  },
  {
    pattern: /\b(?:password|passwd|pwd|passphrase|passcode|secret|token|api[_-]?\s?key|apikey|access[_-]?\s?key|secret[_-]?\s?key|private[_-]?\s?key|signing[_-]?\s?key|encryption[_-]?\s?key|client[_-]?\s?secret|auth[_-]?\s?token|credential(?:s)?)\b\s+(?:is|was|are|were)\s+(?:"[^"]*"|'[^']*'|\S{12,})/gi,
    replacement: '<redacted-credential>',
  },
  {
    pattern: /\b(?:password|passwd|pwd|passphrase|passcode|secret|token|api[_-]?\s?key|apikey|access[_-]?\s?key|secret[_-]?\s?key|private[_-]?\s?key|signing[_-]?\s?key|encryption[_-]?\s?key|client[_-]?\s?secret|auth[_-]?\s?token|credential(?:s)?)\b\s+(?:"[^"]*"|'[^']*'|\S{12,})/gi,
    replacement: '<redacted-credential>',
  },
  { pattern: /\bprivate[ _-]?key\b/gi, replacement: '<redacted-private-key>' },
  // A named host is the ordinary-hostname case, since a bare word is
  // indistinguishable from prose without this label.
  {
    pattern: /\b(?:host|hostname|server|machine|node|port)\b\s*[:=]\s*[^\s,;]+/gi,
    replacement: '<redacted-host>',
  },
  // Credential-like tokens.
  { pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, replacement: '<redacted-credential>' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: '<redacted-credential>' },
  { pattern: /\bglpat-[A-Za-z0-9_-]{16,}\b/g, replacement: '<redacted-credential>' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '<redacted-credential>' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: '<redacted-credential>' },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, replacement: '<redacted-token>' },
  { pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{12,}/g, replacement: 'Bearer <redacted-credential>' },
  // Absolute host paths. The POSIX rule is general on purpose: any `/`-rooted
  // path is a host path, so `/srv/...`, `/data/...`, and a bare `/secret` are
  // removed rather than only the enumerated system roots.
  {
    pattern: /(^|[\s"'(=`])((?:\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*))/g,
    replacement: '$1<redacted-path>',
  },
  { pattern: /\b[A-Za-z]:\\[^\s"')`\]]*/g, replacement: '<redacted-path>' },
  { pattern: /\\\\[^\s"')`\]]+/g, replacement: '<redacted-path>' },
  // Network identity: URLs, user@host, IPv4/IPv6, private host suffixes.
  { pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s"')`\]]+/gi, replacement: '<redacted-url>' },
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\b/g, replacement: '<redacted-identity>' },
  { pattern: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, replacement: '<redacted-address>' },
  // IPv6 only when it is unambiguous: a `::` compresses, or a group contains a
  // hex letter. A bare colon-separated decimal run (`12:30:45`) is left alone.
  { pattern: /\b(?:[0-9a-fA-F]{1,4}::(?:[0-9a-fA-F:]{0,30})|[0-9a-fA-F]*[a-fA-F][0-9a-fA-F]*(?::[0-9a-fA-F]{0,4}){2,})/g, replacement: '<redacted-address>' },
  { pattern: /\b(?:[A-Za-z0-9-]+\.)+(?:local|internal|lan|home|corp|intranet|localdomain)\b/gi, replacement: '<redacted-host>' },
  // Any dotted host, even one whose suffix is not a known private one: a
  // free-text reason has no legitimate FQDN, and a decisive reason does not need
  // one to stay decisive. The boundaries stop a model identifier like
  // `gpt-5.6-terra` (whose internal `6.terra` is not a host) from matching.
  { pattern: /(?<![\w.-])(?:[A-Za-z][A-Za-z0-9-]*\.)+[A-Za-z]{2,}(?![\w.-])/g, replacement: '<redacted-host>' },
  // A machine-style bare hostname, which carries a multi-digit numeric suffix
  // (`buildbox-07`, `node-01`). Two or more digits are required so a versioned
  // model id (`gpt-4`) is not mistaken for a host, while the boundaries keep a
  // dotted model id (`gpt-5.1-codex`) and an ordinary hyphenated token intact.
  { pattern: /(?<![\w.-])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*-\d{2,}(?![\w.-])/g, replacement: '<redacted-host>' },
  { pattern: /\blocalhost\b/gi, replacement: '<redacted-host>' },
  // Raw diagnostics: stack frames, node internals, and bare stderr markers.
  { pattern: /^\s+at\s+.*(?::\d+:\d+\)?)\s*$/gm, replacement: '' },
  { pattern: /\bnode:internal\/[^\s"')`\]]*/g, replacement: '<redacted-diagnostic>' },
  { pattern: /\b(?:raw stderr|stack trace|internal\/modules)\/?[^\s"')`\]]*/gi, replacement: '<redacted-diagnostic>' },
];

/**
 * Remove every sensitive category from one text value.
 *
 * Exported so a caller that must test the boundary can assert the categories
 * directly rather than reconstructing them through a record.
 */
export function redactSensitiveText(value: string): string {
  let text = value;
  for (const { pattern, replacement } of REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/[ \t]{2,}/g, ' ').trim();
}

export interface SanitizeTextOptions {
  /** The decisive, product-owned text used when the caller supplied nothing usable. */
  readonly fallback: string;
  /** Upper bound retained, so a caller cannot persist an unbounded blob. */
  readonly maxLength?: number;
}

const DEFAULT_MAX_LENGTH = 320;

/**
 * Sanitize one free-form operator or diagnostic string.
 *
 * An empty or all-redacted value falls back to the product-owned reason, so the
 * decisive fact is always present even when the caller's text carried only
 * sensitive material.
 */
export function sanitizeOperatorText(value: string | undefined, options: SanitizeTextOptions): string {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const redacted = redactSensitiveText((value ?? '').trim());
  // A value that reduced to nothing but placeholders, punctuation, digits, and a
  // port is not a decisive reason; fall back to the product-owned text.
  const remainder = redacted.replace(/<redacted-[a-z-]+>/gi, '').replace(/[\s:.,;/0-9-]/g, '');
  if (redacted === '' || remainder === '') {
    return options.fallback;
  }
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, Math.max(1, maxLength - 1)).trimEnd()}\u2026`;
}

/** The fallback used when no caller reason is available for a revoke/reset. */
export const DEFAULT_REVOKE_REASON = 'Human revoked the Worker identity and reconnection authority.';
export const DEFAULT_RESET_REASON = 'Human reset the enrollment; the old Worker identity can no longer reconnect.';

/** The fallback for a compatibility detail and a probe summary. */
export const DEFAULT_COMPATIBILITY_DETAIL = 'The Worker protocol compatibility detail was withheld.';
export const DEFAULT_PROBE_SUMMARY = 'Test summary withheld.';

/**
 * The fallback for a durable enrollment decision whose kind has no specific
 * product-owned text (a legacy row, or a sanitized-to-nothing reason).
 */
export const DEFAULT_DECISION_REASON =
  'The enrollment decision was recorded; its detail was withheld as sensitive.';

/**
 * The category a structured identifier belongs to.
 *
 * Each category has its own positive, safe shape, so a hostname, path, address,
 * or credential cannot pass merely because it happens to use identifier
 * characters. An unknown category falls back to the conservative generic shape.
 */
export type IdentifierKind = 'engine' | 'model' | 'capability' | 'digest' | 'generic';

export interface SanitizeIdentifierOptions {
  readonly fallback: string;
  readonly maxLength?: number;
  /** The identifier category whose safe shape is enforced. Defaults to generic. */
  readonly kind?: IdentifierKind;
}

/**
 * Keep only an identifier that matches its category's safe shape.
 *
 * An identifier is not free text: it has a small, constrained shape and no
 * legitimate reason to carry a hostname, path, address, credential, or key
 * material. The boundary is therefore applied in two stages: first the same
 * structural redaction used for free text, and then a positive shape check for
 * the category. If either stage rejects the value, the product-owned fallback is
 * used — never a punctuation-stripped version that could still contain a
 * credential value (e.g. `password=hunter2correcthorse` must not become
 * `passwordhunter2correcthorse`).
 *
 * - `digest` is an opaque one-way hash: lowercase or uppercase hex only, so a
 *   legacy PEM body or a public key cannot survive as an "identity digest".
 * - `engine` and `capability` are lowercase word enums, so a machine hostname
 *   (`buildbox-07`) or an address cannot masquerade as one.
 * - `model` keeps the vendor/version characters a model id really uses, but the
 *   structural redaction still refuses a hostname or credential in that field.
 */
export function sanitizeIdentifier(value: string, options: SanitizeIdentifierOptions): string {
  const maxLength = options.maxLength ?? 64;
  const kind = options.kind ?? 'generic';
  const trimmed = (value ?? '').trim();
  // Stage 1: the structural boundary. A named credential assignment, a
  // hostname/FQDN, a host path, an address, a URL, or key material is rejected
  // outright rather than reduced to its non-punctuation characters.
  const redacted = redactSensitiveText(trimmed);
  if (redacted !== trimmed || /<redacted-[a-z-]+>/i.test(redacted)) return options.fallback;
  // Stage 2: drop characters no identifier category may contain and bound it.
  const cleaned = trimmed.replace(/[^A-Za-z0-9._-]/g, '').slice(0, maxLength);
  if (cleaned === '') return options.fallback;
  if (!matchesIdentifierShape(cleaned, kind)) return options.fallback;
  return cleaned;
}

/** Whether a cleaned identifier matches the positive shape for its category. */
function matchesIdentifierShape(value: string, kind: IdentifierKind): boolean {
  switch (kind) {
    case 'digest':
      // An opaque one-way hash. A PEM body, a base64 key, or a hostname is not.
      return /^[A-Fa-f0-9]{16,200}$/.test(value);
    case 'engine':
    case 'capability':
      // A lowercase word enum: `codex`, `pi`, `agent-run`. No digits-only segment,
      // so `buildbox-07` and `host-12` are not accepted as an engine/capability.
      return /^[a-z][a-z0-9]*(?:[._-][a-z][a-z0-9]*)*$/.test(value);
    case 'model':
      // A model id may carry version digits (`gpt-5.1-codex`, `claude-3-5-sonnet`).
      // The structural redaction has already rejected a hostname, address, or
      // credential in this field, so no extra shape narrowing is needed here.
      return /^[A-Za-z][A-Za-z0-9._-]*$/.test(value);
    case 'generic':
    default:
      return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
  }
}

/**
 * Keep only a bounded protocol version token (`v2`, `2.1`, `2.1.0-rc1`).
 *
 * A Worker reports its own version, and the compatibility detail embeds it in
 * product text, so an arbitrary string is refused rather than echoed.
 */
export function sanitizeProtocolVersion(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^v?\d+(?:\.\d+){0,3}(?:-[A-Za-z0-9.]{1,16})?$/.exec(value.trim());
  return match === null ? undefined : match[0];
}
