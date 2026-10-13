import { EngineStartError } from './port.ts';

/** Published OAR 0.59.1 cannot enforce Pi's required loader and tool admission policy. */
export function assertOarRuntimePolicy(runtimeId: string): void {
  if (runtimeId === 'pi') {
    throw new EngineStartError(
      'OAR Pi route is blocked: requires strict tools/noTools admission, ambient loader exclusion, and Worker-origin-only MCP; see #270',
    );
  }
}
