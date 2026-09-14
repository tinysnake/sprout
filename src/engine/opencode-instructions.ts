import { resolve } from 'node:path';

/**
 * Making a Sprout-written contract file readable by `opencode`.
 *
 * `opencode run` discovers standing instructions from `AGENTS.md`, `CLAUDE.md`,
 * and `CONTEXT.md`, searched upward from the working directory (verified against
 * `opencode 1.18.30` from the binary's own instruction loader). A file with any
 * other name — Sprout's fallback `SPROUT-PROJECT-CONTRACT.md`, which exists so a
 * user's `AGENTS.md` is never clobbered — is **not** read by that discovery.
 *
 * `opencode` does have a second, explicit surface: the config key `instructions`
 * is a list of paths whose contents are injected as standing instructions. That
 * surface is reachable without touching any file the user owns: the environment
 * variable `OPENCODE_CONFIG_CONTENT` carries a config document inline, and it is
 * **merged over** the loaded config rather than replacing it (verified live:
 * the effective `instructions` list is the user's entries followed by Sprout's).
 *
 * This module builds that overlay. It never removes or rewrites an existing
 * `OPENCODE_CONFIG_CONTENT`: the operator's document is parsed, Sprout's path is
 * appended if it is not already present, and the result is re-serialized. A
 * document that cannot be parsed as a JSON object is left byte-identical and the
 * caller is told the registration failed, so a fallback delivery can be reported
 * `unavailable` instead of being claimed as reaching the engine.
 */

/** The `opencode` environment variable that carries an inline config document. */
export const OPENCODE_CONFIG_CONTENT_ENV = 'OPENCODE_CONFIG_CONTENT';

export interface InstructionRegistration {
  /**
   * The environment overlay that registers {@link path}, or `undefined` when the
   * operator's config document could not be merged.
   */
  readonly env: Readonly<Record<string, string>> | undefined;
  /** Why registration failed, set only when `env` is `undefined`. */
  readonly reason?: string;
}

/**
 * Build an environment overlay that registers `path` as an `opencode`
 * instruction source.
 *
 * The path is resolved to an absolute one first: `opencode` resolves a relative
 * `instructions` entry by globbing from the project root, so an absolute path is
 * the only form that cannot be reinterpreted.
 */
export function registerOpenCodeInstructionPath(request: {
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly path: string;
}): InstructionRegistration {
  const absolute = resolve(request.path);
  const existing = request.env?.[OPENCODE_CONFIG_CONTENT_ENV];

  if (existing === undefined || existing.trim() === '') {
    return { env: { [OPENCODE_CONFIG_CONTENT_ENV]: serialize({ instructions: [absolute] }) } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(existing) as unknown;
  } catch (error) {
    return {
      env: undefined,
      reason:
        `${OPENCODE_CONFIG_CONTENT_ENV} is not valid JSON, so Sprout did not rewrite it ` +
        `(${errorMessage(error)})`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      env: undefined,
      reason: `${OPENCODE_CONFIG_CONTENT_ENV} is not a JSON object, so Sprout did not rewrite it`,
    };
  }

  const document = { ...(parsed as Record<string, unknown>) };
  const declared = document['instructions'];
  if (declared !== undefined && !Array.isArray(declared)) {
    return {
      env: undefined,
      reason:
        `${OPENCODE_CONFIG_CONTENT_ENV} declares a non-array "instructions", so Sprout did not ` +
        `rewrite it`,
    };
  }
  // Every entry the operator declared is carried through unchanged — including
  // one Sprout does not understand — so the overlay only ever appends. Dropping
  // or normalizing an entry would silently edit the operator's configuration.
  const instructions = declared === undefined ? [] : [...(declared as readonly unknown[])];
  if (!instructions.includes(absolute)) instructions.push(absolute);

  return {
    env: { [OPENCODE_CONFIG_CONTENT_ENV]: serialize({ ...document, instructions }) },
  };
}

function serialize(document: Record<string, unknown>): string {
  return JSON.stringify(document);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
