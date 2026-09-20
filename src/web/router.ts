import type { ServerResponse } from 'node:http';

/**
 * One HTTP request after the transport has completed authentication and CSRF
 * checks. Domain routers receive no cookie, bearer, CSRF, host, or TLS facts.
 */
export interface ApiRequestContext {
  readonly method: string | undefined;
  readonly response: ServerResponse;
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
  readonly segments: readonly string[];
  /** Present only when the protected transport authenticated one browser session. */
  readonly operatorSessionId?: string;
  /** A JSON object, never the raw HTTP request or its credential-bearing headers. */
  readBody(): Promise<Record<string, unknown>>;
}

/** A domain-owned route set. `true` means the router wrote the response. */
export interface ApiRouter {
  readonly name: string;
  handle(context: ApiRequestContext): Promise<boolean>;
}

/**
 * Compose independently owned domain routers in order.
 *
 * The HTTP transport owns authentication, forgery protection, error shaping,
 * and static files. A domain adds routes by supplying a router here rather
 * than editing a central dispatcher. Duplicate paths remain an explicit
 * composition-order decision, which keeps an accidental shadow observable.
 */
export function composeApiRouters(routers: readonly ApiRouter[]): ApiRouter {
  return {
    name: 'composed-api-router',
    async handle(context: ApiRequestContext): Promise<boolean> {
      for (const router of routers) {
        if (await router.handle(context)) return true;
      }
      return false;
    },
  };
}
