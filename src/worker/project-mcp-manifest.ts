import { sanitizeIdentifier } from '../environment/privacy.ts';

export type ProjectMcpManifestServer =
  | {
      readonly transport: 'stdio';
      readonly name: string;
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    }
  | {
      readonly transport: 'http';
      readonly name: string;
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    };

export type ParsedProjectMcpManifest =
  | { readonly status: 'valid'; readonly servers: readonly ProjectMcpManifestServer[] }
  | { readonly status: 'unsupported' };

const MAX_SERVER_COUNT = 16;
const MAX_HTTP_URL_LENGTH = 2_048;
const MAX_HEADER_COUNT = 32;
const MAX_HEADER_VALUE_LENGTH = 8_192;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_HTTP_HEADERS = new Set([
  'accept', 'connection', 'content-length', 'content-type', 'host',
  'mcp-protocol-version', 'mcp-session-id', 'origin', 'proxy-authorization', 'proxy-connection', 'transfer-encoding',
]);

/** Parse the deliberately small, Human-selected subset of the Project MCP manifest. */
export function parseProjectMcpManifest(value: unknown): ParsedProjectMcpManifest {
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'mcpServers') || !isRecord(value.mcpServers)) {
    return { status: 'unsupported' };
  }
  const entries = Object.entries(value.mcpServers);
  if (entries.length > MAX_SERVER_COUNT) return { status: 'unsupported' };
  const servers: ProjectMcpManifestServer[] = [];
  const safeNames = new Set<string>();
  for (const [name, declaration] of entries) {
    const safeName = sanitizeManifestName(name);
    if (!safeName || safeNames.has(safeName)) return { status: 'unsupported' };
    const server = parseServer(name, declaration);
    if (!server) return { status: 'unsupported' };
    safeNames.add(safeName);
    servers.push(server);
  }
  return { status: 'valid', servers };
}

/** Values used only inside the Worker to redact HTTP origin and authorization details. */
export function projectMcpServerSecrets(server: ProjectMcpManifestServer): readonly string[] {
  if (server.transport === 'stdio') return Object.values(server.env).filter(value => value.length > 0);
  const endpoint = new URL(server.url);
  return [
    server.url, endpoint.origin, endpoint.host, endpoint.hostname, endpoint.pathname, endpoint.search,
    ...Object.values(server.headers),
  ].filter(value => value.length > 1);
}

function parseServer(name: string, value: unknown): ProjectMcpManifestServer | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === undefined || value.type === 'stdio') {
    if (Object.keys(value).some(key => !['type', 'command', 'args', 'env'].includes(key)) ||
        typeof value.command !== 'string' || value.command.trim() === '' || value.command.length > 512 ||
        value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 100 || value.args.some(arg => typeof arg !== 'string' || arg.length > 4_096)) ||
        value.env !== undefined && !validEnvironment(value.env)) return undefined;
    return {
      transport: 'stdio', name, command: value.command,
      args: (value.args as string[] | undefined) ?? [],
      env: (value.env as Record<string, string> | undefined) ?? {},
    };
  }
  if (value.type !== 'http' || Object.keys(value).some(key => !['type', 'url', 'headers'].includes(key)) ||
      typeof value.url !== 'string' || value.url.length === 0 || value.url.length > MAX_HTTP_URL_LENGTH ||
      value.headers !== undefined && !validHeaders(value.headers)) return undefined;
  try {
    const endpoint = new URL(value.url);
    if ((endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') || endpoint.hostname === '' ||
        endpoint.username !== '' || endpoint.password !== '' || endpoint.hash !== '') return undefined;
  } catch { return undefined; }
  return { transport: 'http', name, url: value.url, headers: (value.headers as Record<string, string> | undefined) ?? {} };
}

function validEnvironment(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.keys(value).length <= 64 &&
    Object.entries(value).every(([key, entry]) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) && typeof entry === 'string' && entry.length <= 4_096);
}

function validHeaders(value: unknown): value is Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > MAX_HEADER_COUNT) return false;
  const names = new Set<string>();
  for (const [name, headerValue] of Object.entries(value)) {
    const normalized = name.toLowerCase();
    if (!HEADER_NAME.test(name) || RESERVED_HTTP_HEADERS.has(normalized) || names.has(normalized) ||
        typeof headerValue !== 'string' || headerValue.length > MAX_HEADER_VALUE_LENGTH || /[\r\n\u0000]/.test(headerValue)) return false;
    names.add(normalized);
  }
  return true;
}

function sanitizeManifestName(name: string): string | undefined {
  const safe = sanitizeIdentifier(name, { fallback: '', kind: 'generic', maxLength: 64 });
  return safe === '' ? undefined : safe;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import { sanitizeIdentifier } from '../environment/privacy.ts';
