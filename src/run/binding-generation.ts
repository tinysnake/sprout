import type { BindingGenerationFence } from '../environment/binding-generation-fence.ts';

export interface StagedBindingGeneration extends BindingGenerationFence {
  /** Atomically make this staged catalog the only live catalog for its scope. */
  publish(): void;
  /** Withdraw the generation once its bounded activation has ended. */
  revoke(): void;
}

/**
 * Serializes bounded Host-run activations that share one native conversation
 * and publishes their remote tool grants only after a complete session catalog
 * has been registered and validated.
 */
export class BindingGenerationRegistry {
  readonly #published = new Map<string, number>();
  readonly #tails = new Map<string, Promise<void>>();

  async withLock<T>(scope: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(scope) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#tails.set(scope, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(scope) === tail) this.#tails.delete(scope);
    }
  }

  stage(scope: string): StagedBindingGeneration {
    const previous = this.#published.get(scope) ?? 0;
    const generation = previous + 1;
    let published = false;
    let revoked = false;
    return {
      generation,
      isCurrent: () => published && !revoked && this.#published.get(scope) === generation,
      publish: () => {
        if (revoked || (this.#published.get(scope) ?? 0) !== previous) {
          throw new Error('binding catalog changed while this generation was staged');
        }
        this.#published.set(scope, generation);
        published = true;
      },
      revoke: () => { revoked = true; },
    };
  }
}
