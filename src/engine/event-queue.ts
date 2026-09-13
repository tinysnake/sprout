import type { AgentRunEvent } from './port.ts';

/**
 * Bridges push-style engine events into an async iterable.
 *
 * Run events are consumed by a `for await` loop while an engine pushes them from
 * stream callbacks, so a push-to-pull buffer is required. A failure is turned
 * into a thrown error, which is how a caller learns about it without a second
 * channel. Shared by the in-worker engine adapters and the core-side worker
 * client, since both face the same shape.
 */
export class EventQueue implements AsyncIterable<AgentRunEvent> {
  readonly #items: AgentRunEvent[] = [];
  readonly #waiters: ((result: IteratorResult<AgentRunEvent>) => void)[] = [];
  #done = false;
  #error: Error | undefined;

  push(event: AgentRunEvent): void {
    if (this.#done) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.#items.push(event);
  }

  end(): void {
    if (this.#done) return;
    this.#done = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  fail(error: Error): void {
    if (this.#done) return;
    this.#done = true;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentRunEvent> {
    return {
      next: () => {
        const queued = this.#items.shift();
        if (queued) return Promise.resolve({ value: queued, done: false });
        if (this.#error) return Promise.reject(this.#error);
        if (this.#done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}
