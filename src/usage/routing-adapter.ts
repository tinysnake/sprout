/**
 * Wake-model routing adapter with usage telemetry observation (ADR-0007, ADR-0010, #105).
 *
 * Wraps a RoutingModelPort to measure Sprout wall duration and observe available
 * token/cost telemetry without modifying core routing decisions.
 * Unsupported telemetry is reported as explicitly unavailable, never zero.
 */

import type { RoutingModelPort } from '../collaboration/routing.ts';
import type { DetailedTokenDimensions, ApiEquivalentCostEstimate, BillingBasis } from './model.ts';
import type { UsageService } from './service.ts';

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
  readonly usageService?: UsageService | undefined;
  readonly clock?: { now(): number } | undefined;
}

export class UsageAwareRoutingModelPort implements RoutingModelPort {
  readonly #inner: RoutingModelPort;
  readonly #usageService?: UsageService | undefined;
  readonly #clock: { now(): number };
  #lastTelemetry?: RoutingTelemetry;

  constructor(options: UsageAwareRoutingModelPortOptions) {
    this.#inner = options.inner;
    this.#usageService = options.usageService;
    this.#clock = options.clock ?? { now: () => Date.now() };
  }

  get id(): string {
    return this.#inner.id;
  }

  get lastTelemetry(): RoutingTelemetry | undefined {
    return this.#lastTelemetry;
  }

  async judge(request: {
    readonly batchId: string;
    readonly projectId: string;
    readonly attempt: number;
    readonly context: string;
  }): Promise<string> {
    const startedAt = this.#clock.now();
    try {
      const raw = await this.#inner.judge(request);
      const finishedAt = this.#clock.now();
      const durationMs = Math.max(0, finishedAt - startedAt);

      // Check if raw output or inner port exposes telemetry
      let telemetry: RoutingTelemetry = {
        durationMs,
        source: `routing-model:${this.#inner.id}`,
        sourceVersion: '1.0',
        billingBasis: 'unknown',
      };

      // If the inner port has telemetry or if raw JSON has a usage property
      const innerTelemetry = (this.#inner as unknown as { readonly lastTelemetry?: Partial<RoutingTelemetry> }).lastTelemetry;
      if (innerTelemetry) {
        telemetry = {
          ...telemetry,
          ...innerTelemetry,
          durationMs,
        };
      }

      this.#lastTelemetry = telemetry;

      if (this.#usageService) {
        const attemptId = `${request.batchId}-att-${request.attempt}`;
        void this.#usageService.recordRoutingAttemptActivity(
          {
            id: attemptId,
            batchId: request.batchId,
            attemptNumber: request.attempt,
            modelId: this.#inner.id,
            startedAt,
            finishedAt,
            status: 'succeeded',
          },
          {
            batchId: request.batchId,
            projectId: request.projectId,
            durationMs,
            tokens: telemetry.tokens,
            cost: telemetry.cost,
            billingBasis: telemetry.billingBasis,
            source: telemetry.source,
            sourceVersion: telemetry.sourceVersion,
          },
        );
      }

      return raw;
    } catch (error) {
      const finishedAt = this.#clock.now();
      const durationMs = Math.max(0, finishedAt - startedAt);
      this.#lastTelemetry = {
        durationMs,
        source: `routing-model:${this.#inner.id}`,
        sourceVersion: '1.0',
        billingBasis: 'unknown',
      };

      if (this.#usageService) {
        const attemptId = `${request.batchId}-att-${request.attempt}`;
        void this.#usageService.recordRoutingAttemptActivity(
          {
            id: attemptId,
            batchId: request.batchId,
            attemptNumber: request.attempt,
            modelId: this.#inner.id,
            startedAt,
            finishedAt,
            status: 'failed',
          },
          {
            batchId: request.batchId,
            projectId: request.projectId,
            durationMs,
            source: `routing-model:${this.#inner.id}`,
            sourceVersion: '1.0',
          },
        );
      }

      throw error;
    }
  }
}
