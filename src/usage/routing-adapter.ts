/**
 * Wake-model telemetry adapter (ADR-0007, ADR-0010).
 * Measurement is correlated to the coordinator-owned attempt id. Only the
 * coordinator's awaited settlement observer persists usage: raw model success
 * is not routing success, and a late timed-out response is not a new activity.
 */
import type { RoutingModelPort } from '../collaboration/routing.ts';
import type { DetailedTokenDimensions, ApiEquivalentCostEstimate, BillingBasis } from './model.ts';

export interface RoutingTelemetry {
  readonly durationMs: number;
  readonly tokens?: DetailedTokenDimensions | undefined;
  readonly cost?: ApiEquivalentCostEstimate | undefined;
  readonly billingBasis?: BillingBasis | undefined;
  readonly source?: string | undefined;
  readonly sourceVersion?: string | undefined;
}

export interface UsageAwareRoutingModelPortOptions {
  readonly inner: RoutingModelPort;
  readonly clock?: { now(): number } | undefined;
}

export class UsageAwareRoutingModelPort implements RoutingModelPort {
  readonly #inner: RoutingModelPort;
  readonly #clock: { now(): number };
  readonly #active = new Set<string>();
  readonly #telemetry = new Map<string, RoutingTelemetry>();
  #lastTelemetry?: RoutingTelemetry;

  constructor(options: UsageAwareRoutingModelPortOptions) {
    this.#inner = options.inner;
    this.#clock = options.clock ?? { now: () => Date.now() };
  }

  get id(): string { return this.#inner.id; }
  get lastTelemetry(): RoutingTelemetry | undefined { return this.#lastTelemetry; }

  /** Called exactly at coordinator settlement, including timeout/invalid output. */
  takeTelemetry(attemptId: string): RoutingTelemetry | undefined {
    this.#active.delete(attemptId);
    const telemetry = this.#telemetry.get(attemptId);
    this.#telemetry.delete(attemptId);
    return telemetry;
  }

  async judge(request: Parameters<RoutingModelPort['judge']>[0]): Promise<string> {
    const startedAt = this.#clock.now();
    this.#active.add(request.attemptId);
    try {
      return await this.#inner.judge(request);
    } finally {
      // Ignore a late response after the coordinator has already settled timeout.
      if (this.#active.has(request.attemptId)) {
        const innerTelemetry = this.#inner.telemetryForAttempt?.(request.attemptId);
        const telemetry: RoutingTelemetry = {
          source: `routing-model:${this.#inner.id}`, sourceVersion: '1.0', billingBasis: 'unknown',
          ...innerTelemetry,
          durationMs: Math.max(0, this.#clock.now() - startedAt),
        };
        this.#lastTelemetry = telemetry;
        this.#telemetry.set(request.attemptId, telemetry);
      }
    }
  }
}
