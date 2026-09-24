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

/**
 * Keywords that name a credential.
 *
 * A caller may write the key with an underscore, a hyphen, or a space
 * (`api_key`, `api-key`, `api key`), and both `credential` and `credentials`
 * are valid. Keeping the keyword in one place means every separator rule below
 * matches the same set of names. The keyword is matched case-insensitively
 * through an inline `(?i:…)` group so the value shapes stay case-sensitive.
 */
const CREDENTIAL_KEYWORD =
  String.raw`password|passwd|pwd|secret|token|api[_-]?\s?key|apikey|access[_-]?\s?key|secret[_-]?\s?key|private[_-]?\s?key|signing[_-]?\s?key|encryption[_-]?\s?key|client[_-]?\s?secret|auth[_-]?\s?token|credentials?`;

/** The credential keyword, case-insensitive, with no value shape attached. */
const KEY = String.raw`(?i:${CREDENTIAL_KEYWORD})`;

/**
 * Model families whose versioned ids are real model ids rather than hostnames.
 *
 * A bare machine hostname and a versioned model id can share a surface
 * (`buildbox-7` versus `gpt-4`), so every host-shaped rule needs this positive
 * allowlist to accept the real id without accepting a host. The same source is
 * used by free text and by the structured identifier categories.
 */
const MODEL_FAMILY_SOURCE =
  String.raw`gpt|chatgpt|o[1-9]|claude|gemini|gemma|palm|codex|pi|deepseek|glm|qwen|llama|mistral|mixtral|grok|sonnet|opus|haiku|command|phi|falcon|yi|kimi|moonshot|antigravity|workbuddy|nova|titan|jamba|dbrx|hermes|wizard|vicuna|zephyr`;

/** The compiled model-family allowlist, anchored at the start of a token. */
const MODEL_FAMILIES = new RegExp(String.raw`^(?:${MODEL_FAMILY_SOURCE})(?:$|[._-])`, 'i');

/**
 * Words that introduce a machine host name.
 *
 * A host name is often an unhyphenated `word+digits` token (`host9`, `node12`,
 * `box3`). That surface collides with ordinary technical vocabulary (`utf8`,
 * `sha256`, `base64`, `win32`), so free text only treats the token as a host when
 * it starts with one of these machine words; the structured identifier
 * categories reject every `word+digits` token through their positive shape.
 */
const MACHINE_PREFIX =
  String.raw`host|hostname|node|box|server|machine|worker|srv|vm|mac|macmini|pc|rpi|raspberry|mini|laptop|desktop|workstation|env|instance`;

/**
 * Ordinary words that may legitimately follow a credential keyword in a decisive
 * reason.
 *
 * A bare-space credential assignment is removed only when the next token is
 * **not** one of these words: `token bucket exhausted` and `password rotation
 * required` are decisive operator text, while `client_secret abcdef` is a leaked
 * value. The list holds English function words plus the vocabulary the product's
 * own readiness reasons use, so it is a positive, reviewable exception rather
 * than a blanket "keep every lowercase word".
 */
const DECISIVE_CONTINUATIONS = [
  // Function words that introduce a phrase rather than a value.
  'a', 'after', 'again', 'against', 'all', 'already', 'also', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'during',
  'for', 'from', 'had', 'has', 'have', 'if', 'in', 'into', 'is', 'it', 'its', 'may', 'must', 'never',
  'no', 'not', 'of', 'on', 'only', 'or', 'our', 'over', 'should', 'since', 'so', 'still', 'than', 'that',
  'the', 'their', 'then', 'there', 'these', 'this', 'those', 'to', 'too', 'under', 'until', 'was', 'were',
  'when', 'while', 'will', 'with', 'without', 'would',
  // Decisive nouns and states the readiness reasons use.
  'age', 'bucket', 'change', 'changed', 'check', 'checks', 'denied', 'error', 'errors', 'expired', 'expiry',
  'failure', 'failures', 'field', 'fields', 'file', 'files', 'history', 'invalid', 'length', 'login', 'logout',
  'manager', 'missing', 'mode', 'name', 'names', 'offline', 'online', 'pending', 'policy', 'probe', 'probes',
  'prompt', 'prompts', 'ready', 'refresh', 'required', 'reset', 'retired', 'rotation', 'rotated', 'scanner',
  'scanning', 'session', 'sessions', 'state', 'status', 'storage', 'store', 'strength', 'type', 'unknown',
  'unavailable', 'value', 'values', 'vault',
].join('|');

/**
 * A **credential-shaped** value token.
 *
 * Used for the bare-space form, where the keyword and the value run together
 * with no punctuation to signal an assignment (`password hunter2`). A value
 * qualifies when it is quoted, carries a non-lowercase character (a digit, an
 * uppercase letter, or a symbol), or is not one of the decisive continuations
 * above — so `client_secret abcdef` loses its value while `token bucket
 * exhausted` and `password rotation required` stay decisive.
 */
const CREDENTIAL_VALUE =
  String.raw`(?:"[^"]*"|'[^']*'|(?=[^\s,;]*[^a-z\s,;])[^\s,;]+|(?!(?i:${DECISIVE_CONTINUATIONS})\b)[^\s,;]+)`;

/**
 * Any single value token.
 *
 * Used where the separator itself signals an assignment — `=`, `:`, or a copula
 * (`is`/`was`/`are`/`were`) — because `api_key is ABCDEF` is unambiguously a
 * value even when the token is a short lowercase word.
 */
const CREDENTIAL_VALUE_ASSIGNED = String.raw`(?:"[^"]*"|'[^']*'|[^\s,;]+)`;

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
  // Absolute host paths run before the credential rules: a path whose basename
  // happens to be a credential word (`/secret`) is a host path, and removing it
  // first stops the bare-space rule from treating the following prose as its
  // value. The POSIX rule is general on purpose: any `/`-rooted path is a host
  // path, so `/srv/...`, `/data/...`, and a bare `/secret` are removed rather
  // than only the enumerated system roots.
  {
    pattern: /(^|[\s"'(=`])((?:\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*))/g,
    replacement: '$1<redacted-path>',
  },
  { pattern: /\b[A-Za-z]:\\[^\s"')`\]]*/g, replacement: '<redacted-path>' },
  { pattern: /\\\\[^\s"')`\]]+/g, replacement: '<redacted-path>' },
  // A named credential assignment is removed as a **whole** key/value pair, not
  // punctuation-stripped: the keyword names the secret and the value must not
  // survive in any form. The separator may be `=`, `:`, a copula (`is`/`was`),
  // or a bare space, and the keyword itself may contain a space (`api key`,
  // `private key`). `passphrase`/`passcode` name a phrase, so their value may
  // span a few words. For every other key the bare-space/copula value must be
  // credential-shaped, so `token bucket exhausted` and `password rotation
  // required` stay decisive instead of being eaten.
  //
  // These run before the standalone `private key` keyword rule so the value of a
  // `private key <value>` assignment cannot survive after the keyword is
  // replaced. An earlier rework replaced only the keyword and left the value,
  // which the review reproduced (`private key AAAAbbbb`).
  {
    pattern: new RegExp(
      String.raw`\b(?i:passphrase|passcode)\b\s*(?::|=|(?i:is|was|are|were))?\s*${CREDENTIAL_VALUE}(?:\s+[^\s,;]+){0,3}`,
      'g',
    ),
    replacement: '<redacted-credential>',
  },
  {
    pattern: new RegExp(String.raw`\b${KEY}\b\s*[:=]\s*${CREDENTIAL_VALUE_ASSIGNED}`, 'g'),
    replacement: '<redacted-credential>',
  },
  {
    pattern: new RegExp(
      String.raw`\b${KEY}\b\s+(?i:is|was|are|were)\s+${CREDENTIAL_VALUE_ASSIGNED}`,
      'g',
    ),
    replacement: '<redacted-credential>',
  },
  {
    pattern: new RegExp(String.raw`\b${KEY}\b\s+${CREDENTIAL_VALUE}`, 'g'),
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
  // A machine-style bare hostname: a hyphenated word with a numeric suffix
  // (`buildbox-7`, `node-01`) or a machine word directly followed by digits
  // (`host9`, `node12`). The rule covers a one-digit suffix too, because a host
  // name is not less sensitive for being short; a leading negative lookahead
  // keeps a real versioned model id (`gpt-4`, `o3-mini`, `claude-3-5-sonnet`)
  // intact instead of eating the vendor/version token. The machine-word prefix on
  // the unhyphenated form keeps ordinary technical vocabulary (`utf8`, `sha256`,
  // `base64`, `win32`) decisive.
  {
    pattern: new RegExp(
      String.raw`(?<![\w.-])(?!(?i:${MODEL_FAMILY_SOURCE})(?:$|[._-]))[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*-\d{1,4}(?![\w.-])`,
      'g',
    ),
    replacement: '<redacted-host>',
  },
  {
    pattern: new RegExp(
      String.raw`(?<![\w.-])(?i:${MACHINE_PREFIX})\d{1,4}(?![\w.-])`,
      'g',
    ),
    replacement: '<redacted-host>',
  },
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

/** The fallbacks for the archive and restore authority decisions (ADR-0008). */
export const DEFAULT_ARCHIVE_REASON =
  'Human archived the Environment instance; enrollment and history are preserved and new work is barred.';
export const DEFAULT_RESTORE_REASON =
  'Human restored the archived Environment instance; its valid enrollment is reused.';

/** The fallback for a compatibility detail and a probe summary. */
export const DEFAULT_COMPATIBILITY_DETAIL = 'The Worker protocol compatibility detail was withheld.';
export const DEFAULT_PROBE_SUMMARY = 'Test summary withheld.';

/** Canonical privacy reduction for one Worker probe's aggregate CLI version. */
export function sanitizeProbeVersion(value: string): string {
  return /^(?:\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?:, \d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)*$/.test(value)
    ? value
    : 'unknown-version';
}

/**
 * The fallback for the readiness summary reason.
 *
 * The summary is normally product-owned text, but the compatibility detail can
 * feed it and a legacy/raw projection can hold anything, so the wire reason
 * passes the same boundary as every other free-text field.
 */
export const DEFAULT_READINESS_SUMMARY = 'The readiness summary reason was withheld as sensitive.';

/**
 * The fallback for a durable enrollment decision whose kind has no specific
 * product-owned text (a legacy row, or a sanitized-to-nothing reason).
 */
export const DEFAULT_DECISION_REASON =
  'The enrollment decision was recorded; its detail was withheld as sensitive.';

/** The fallback for an ordinary recovery decision reason (#88). */
export const DEFAULT_RECOVERY_REASON =
  'The recovery decision was recorded; its detail was withheld as sensitive.';

/**
 * The fallback for a Human Force Release reason (#88).
 *
 * A Force Release reason is mandatory free text and the most likely place for a
 * human to paste a host path or a password while explaining an emergency, so it
 * passes the same boundary as every other durable operator string and falls back
 * to product-owned text rather than persisting a redacted fragment.
 */
export const DEFAULT_FORCE_RELEASE_REASON =
  'The Force Release reason was withheld as sensitive; the override remains recorded.';

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

/**
 * Whether a value is shaped like a bare machine hostname: a word with a short
 * numeric suffix (`buildbox-7`, `node-12`, `host9`). The shape is not decisive
 * on its own — `gpt-4` has it too — so it is combined with the family allowlist.
 */
function looksLikeMachineHost(value: string): boolean {
  return (
    /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*-\d{1,4}$/.test(value) ||
    /^[A-Za-z]+\d{1,4}$/.test(value)
  );
}

/** A versioned model id: host-shaped, but from a known model family. */
function isVersionedModel(value: string): boolean {
  return looksLikeMachineHost(value) && MODEL_FAMILIES.test(value);
}

/** A lowercase word enum: `codex`, `pi`, `agent-run`, but not `host9`. */
const WORD_ENUM = /^[a-z]+(?:[._-][a-z][a-z0-9]*)*$/;

/** A model id: a word enum or an allowlisted versioned model. */
function isModelShaped(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(value)) return false;
  return !looksLikeMachineHost(value) || isVersionedModel(value);
}

/** Whether a cleaned identifier matches the positive shape for its category. */
function matchesIdentifierShape(value: string, kind: IdentifierKind): boolean {
  switch (kind) {
    case 'digest':
      // An opaque one-way hash. A PEM body, a base64 key, or a hostname is not.
      return /^[A-Fa-f0-9]{16,200}$/.test(value);
    case 'engine':
    case 'capability':
      // A lowercase word enum. Each segment starts with a letter, so `host9`,
      // `buildbox-7`, and `node-12` are not accepted as an engine/capability.
      return WORD_ENUM.test(value);
    case 'model':
      return isModelShaped(value);
    case 'generic':
    default:
      // A generic identifier is a word enum or a real model id. A one-digit
      // machine hostname (`buildbox-7`, `host9`) is neither, so it cannot pass
      // merely because it uses identifier characters.
      return WORD_ENUM.test(value) || isModelShaped(value);
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
