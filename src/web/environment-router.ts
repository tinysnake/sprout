import type { ApiRequestContext, ApiRouter } from './router.ts';
import {
  EnrollmentError,
  type EnrollmentEngineFact,
} from '../environment/enrollment.ts';
import { workerIdentityDigest } from '../environment/enrollment-identity.ts';
import type { EnvironmentEnrollmentService } from '../environment/enrollment-service.ts';
import type {
  CompatibilityFact,
  ConnectionFact,
  EngineReadinessFact,
  ProbeResultFact,
} from '../environment/readiness.ts';
import { toEnrollmentView, toEnvironmentReadinessView } from './views.ts';

/**
 * The Environment enrollment and readiness router (#87).
 *
 * A domain-owned route set composed through the #85 additive seam rather than a
 * central dispatcher. Every route delegates to the enrollment service, so the
 * Human-approval, duplicate-identity, revocation, reset, and readiness rules have
 * exactly one implementation and the transport keeps none.
 *
 * Privacy: no route accepts or returns a private key, engine credential,
 * hostname, address, topology, or absolute path. A Worker presents a public key
 * once; only its digest is retained, and the wire contract never echoes the key.
 */

export interface EnvironmentRouterOptions {
  readonly enrollments: EnvironmentEnrollmentService;
}

export function createEnvironmentRouter(options: EnvironmentRouterOptions): ApiRouter {
  const { enrollments } = options;

  return {
    name: 'environment-enrollment',
    async handle(context: ApiRequestContext): Promise<boolean> {
      const { method, pathname, segments } = context;

      // POST /api/environments/enrollments — request a pending enrollment.
      if (method === 'POST' && pathname === '/api/environments/enrollments') {
        const body = await context.readBody();
        const environmentInstanceId = stringField(body, 'environmentInstanceId');
        const displayName = stringField(body, 'displayName');
        const publicKey = stringField(body, 'publicKey');
        const platform = stringField(body, 'platform');
        if (
          environmentInstanceId === undefined ||
          displayName === undefined ||
          publicKey === undefined ||
          platform === undefined
        ) {
          return json(context, 400, {
            error: 'environmentInstanceId, displayName, publicKey, and platform are required',
          });
        }
        const capabilityRequests = stringArray(body, 'capabilityRequests');
        if (capabilityRequests === undefined) {
          return json(context, 400, { error: 'capabilityRequests must be an array of strings' });
        }
        const engines = parseEngineFacts(body['engines']);
        if (engines === 'invalid') {
          return json(context, 400, { error: 'engines must be an array of engine facts' });
        }
        const protocolVersion = stringField(body, 'protocolVersion');
        try {
          const result = await enrollments.requestEnrollment({
            environmentInstanceId,
            displayName,
            publicKey,
            platform,
            ...(protocolVersion !== undefined ? { protocolVersion } : {}),
            capabilityRequests,
            engineFacts: engines,
          });
          return json(context, 201, {
            enrollment: toEnrollmentView(result.enrollment),
            bootstrap: result.bootstrap,
          });
        } catch (error) {
          return enrollmentFailure(context, error);
        }
      }

      // GET /api/environments/enrollments — list durable enrollments.
      if (method === 'GET' && pathname === '/api/environments/enrollments') {
        return json(context, 200, {
          enrollments: (await enrollments.list()).map(toEnrollmentView),
        });
      }

      // GET /api/environments/enrollments/:id — inspect one enrollment.
      if (
        method === 'GET' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments'
      ) {
        const enrollment = await enrollments.get(segments[3] ?? '');
        if (enrollment === undefined) return json(context, 404, { error: 'unknown enrollment' });
        return json(context, 200, { enrollment: toEnrollmentView(enrollment) });
      }

      // POST /api/environments/enrollments/:id/connect — Worker identity proof.
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments' &&
        segments[4] === 'connect'
      ) {
        const body = await context.readBody();
        // A connection proves possession by presenting the public key; the digest
        // is derived here so the wire never carries a caller-chosen identity.
        const publicKey = stringField(body, 'publicKey');
        if (publicKey === undefined) {
          return json(context, 400, { error: 'publicKey is required' });
        }
        const connection = parseConnection(body['connection']);
        if (connection === 'invalid') {
          return json(context, 400, { error: 'connection must be a connection fact' });
        }
        const compatibility = parseCompatibility(body['compatibility']);
        if (compatibility === 'invalid') {
          return json(context, 400, { error: 'compatibility must be a compatibility fact' });
        }
        const engines = parseReadinessEngines(body['engines']);
        if (engines === 'invalid') {
          return json(context, 400, { error: 'engines must be an array of readiness facts' });
        }
        try {
          const outcome = await enrollments.connectWorker({
            enrollmentId: segments[3] ?? '',
            identityDigest: workerIdentityDigest(publicKey),
            connection,
            compatibility,
            engines,
          });
          return json(context, 200, {
            outcome: outcome.outcome,
            requiresHumanApproval: outcome.requiresHumanApproval,
            enrollment: toEnrollmentView(outcome.enrollment),
          });
        } catch (error) {
          return enrollmentFailure(context, error);
        }
      }

      // POST /api/environments/enrollments/:id/approve — one Human approval.
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments' &&
        segments[4] === 'approve'
      ) {
        const body = await context.readBody();
        const permissions = booleanRecord(body['capabilityPermissions']);
        if (permissions === 'invalid') {
          return json(context, 400, { error: 'capabilityPermissions must be a record of booleans' });
        }
        try {
          const result = await enrollments.approve(segments[3] ?? '', {
            capabilityPermissions: permissions,
          });
          return json(context, 200, { enrollment: toEnrollmentView(result.enrollment) });
        } catch (error) {
          return enrollmentFailure(context, error);
        }
      }

      // POST /api/environments/enrollments/:id/revoke
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments' &&
        segments[4] === 'revoke'
      ) {
        const body = await context.readBody();
        try {
          const revoked = await enrollments.revoke(segments[3] ?? '', stringField(body, 'reason') ?? '');
          return json(context, 200, { enrollment: toEnrollmentView(revoked) });
        } catch (error) {
          return enrollmentFailure(context, error);
        }
      }

      // POST /api/environments/enrollments/:id/reset — fresh identity reset.
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments' &&
        segments[4] === 'reset'
      ) {
        const body = await context.readBody();
        try {
          const reset = await enrollments.reset(segments[3] ?? '', stringField(body, 'reason') ?? '');
          return json(context, 200, { enrollment: toEnrollmentView(reset) });
        } catch (error) {
          return enrollmentFailure(context, error);
        }
      }

      // POST /api/environments/enrollments/:id/permissions — capability permission.
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments' &&
        segments[4] === 'permissions'
      ) {
        const body = await context.readBody();
        const capability = stringField(body, 'capability');
        const allowed = body['allowed'];
        if (capability === undefined || typeof allowed !== 'boolean') {
          return json(context, 400, { error: 'capability and boolean allowed are required' });
        }
        try {
          const updated = await enrollments.setCapabilityPermission(segments[3] ?? '', capability, allowed);
          return json(context, 200, { enrollment: toEnrollmentView(updated) });
        } catch (error) {
          return enrollmentFailure(context, error);
        }
      }

      // GET /api/environments/enrollments/:id/readiness — facts plus summary.
      if (
        method === 'GET' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments' &&
        segments[4] === 'readiness'
      ) {
        try {
          const assembled = await enrollments.readiness(segments[3] ?? '');
          return json(context, 200, {
            readiness: toEnvironmentReadinessView({
              environmentInstanceId: assembled.enrollment.environmentInstanceId,
              readiness: assembled.readiness,
              summary: assembled.summary,
            }),
            probes: await enrollments.listProbes(segments[3] ?? ''),
          });
        } catch (error) {
          return enrollmentFailure(context, error);
        }
      }

      // POST /api/environments/enrollments/:id/probes — record a probe result.
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'environments' &&
        segments[2] === 'enrollments' &&
        segments[4] === 'probes'
      ) {
        const body = await context.readBody();
        const probe = parseProbe(body);
        if (probe === 'invalid') {
          return json(context, 400, { error: 'probe fields are invalid' });
        }
        try {
          const recorded = await enrollments.recordProbe(segments[3] ?? '', probe);
          return json(context, 201, { probe: recorded });
        } catch (error) {
          return enrollmentFailure(context, error);
        }
      }

      return false;
    },
  };
}

function json(context: ApiRequestContext, status: number, payload: unknown): true {
  context.response.writeHead(status, { 'content-type': 'application/json' });
  context.response.end(JSON.stringify(payload));
  return true;
}

function enrollmentFailure(context: ApiRequestContext, error: unknown): true {
  if (error instanceof EnrollmentError) {
    const status = error.code === 'unknown-enrollment' ? 404 : 409;
    return json(context, status, { error: error.message, code: error.code });
  }
  return json(context, 500, { error: 'environment enrollment could not be completed' });
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function stringArray(body: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = body[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return undefined;
  return value as readonly string[];
}

function booleanRecord(value: unknown): Readonly<Record<string, boolean>> | 'invalid' {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'invalid';
  const record: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'boolean') return 'invalid';
    record[key] = entry;
  }
  return record;
}

function parseConnection(value: unknown): ConnectionFact | 'invalid' {
  if (value === undefined) return { state: 'never-connected' };
  if (typeof value !== 'object' || value === null) return 'invalid';
  const state = (value as Record<string, unknown>)['state'];
  if (
    state !== 'never-connected' &&
    state !== 'online' &&
    state !== 'reconnecting' &&
    state !== 'offline'
  ) {
    return 'invalid';
  }
  const lastConfirmedAt = (value as Record<string, unknown>)['lastConfirmedAt'];
  if (lastConfirmedAt !== undefined && typeof lastConfirmedAt !== 'number') return 'invalid';
  return {
    state,
    ...(lastConfirmedAt !== undefined ? { lastConfirmedAt } : {}),
  };
}

function parseCompatibility(value: unknown): CompatibilityFact | 'invalid' {
  if (value === undefined) return { state: 'unknown' };
  if (typeof value !== 'object' || value === null) return 'invalid';
  const state = (value as Record<string, unknown>)['state'];
  if (state !== 'unknown' && state !== 'compatible' && state !== 'incompatible') return 'invalid';
  const workerProtocolVersion = (value as Record<string, unknown>)['workerProtocolVersion'];
  if (workerProtocolVersion !== undefined && typeof workerProtocolVersion !== 'string') return 'invalid';
  const detail = (value as Record<string, unknown>)['detail'];
  if (detail !== undefined && typeof detail !== 'string') return 'invalid';
  return {
    state,
    ...(workerProtocolVersion !== undefined ? { workerProtocolVersion } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}

function parseEngineFacts(value: unknown): readonly EnrollmentEngineFact[] | 'invalid' {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return 'invalid';
  const facts: EnrollmentEngineFact[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return 'invalid';
    const record = entry as Record<string, unknown>;
    const engine = record['engine'];
    if (typeof engine !== 'string' || engine === '') return 'invalid';
    const models = record['models'];
    if (models !== undefined && (!Array.isArray(models) || !models.every((m) => typeof m === 'string'))) {
      return 'invalid';
    }
    facts.push({
      engine,
      installed: record['installed'] === true,
      authenticated: record['authenticated'] === true,
      models: (models as readonly string[] | undefined) ?? [],
    });
  }
  return facts;
}

function parseReadinessEngines(value: unknown): readonly EngineReadinessFact[] | 'invalid' {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return 'invalid';
  const facts: EngineReadinessFact[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return 'invalid';
    const record = entry as Record<string, unknown>;
    const engine = record['engine'];
    if (typeof engine !== 'string' || engine === '') return 'invalid';
    const readiness = record['readiness'];
    if (
      readiness !== 'ready' &&
      readiness !== 'login-required' &&
      readiness !== 'missing' &&
      readiness !== 'unknown'
    ) {
      return 'invalid';
    }
    const models = parseModelAvailability(record['models']);
    if (models === 'invalid') return 'invalid';
    const required = record['required'];
    if (required !== undefined && typeof required !== 'boolean') return 'invalid';
    const installed = record['installed'];
    if (installed !== undefined && typeof installed !== 'boolean') return 'invalid';
    facts.push({ engine, installed: installed === true, readiness, required: required === true, models });
  }
  return facts;
}

function parseModelAvailability(
  value: unknown,
): { readonly state: 'available' | 'none' | 'unknown'; readonly models: readonly string[] } | 'invalid' {
  if (value === undefined) return { state: 'unknown', models: [] };
  if (typeof value !== 'object' || value === null) return 'invalid';
  const record = value as Record<string, unknown>;
  const state = record['state'];
  if (state !== 'available' && state !== 'none' && state !== 'unknown') return 'invalid';
  const models = record['models'];
  if (models !== undefined && (!Array.isArray(models) || !models.every((m) => typeof m === 'string'))) {
    return 'invalid';
  }
  return { state, models: (models as readonly string[] | undefined) ?? [] };
}

function parseProbe(value: Record<string, unknown>): ProbeResultFact | 'invalid' {
  const { at, latencyMs, protocolOk, enginesOk, summary } = value;
  if (
    typeof at !== 'number' ||
    typeof latencyMs !== 'number' ||
    typeof protocolOk !== 'boolean' ||
    typeof enginesOk !== 'boolean' ||
    typeof summary !== 'string'
  ) {
    return 'invalid';
  }
  return { at, latencyMs, protocolOk, enginesOk, summary };
}

/** Re-exported so a caller can build the durable observation from parsed facts. */
export type { EngineReadinessFact };
