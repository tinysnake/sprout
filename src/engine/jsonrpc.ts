import type { Readable, Writable } from 'node:stream';

/**
 * Line-framed JSON-RPC 2.0 over a pair of streams.
 *
 * This is the transport Codex's `app-server` speaks (ADR-0001). It is a deep
 * module on purpose: correlation of responses, notification dispatch, protocol
 * errors, and the server-must-never-hang-silently rule all live here, so the
 * Codex adapter above only deals in method names and payloads.
 */

export interface JsonRpcNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface JsonRpcServerRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params: unknown;
}

export interface JsonRpcTransport {
  request<T>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: (notification: JsonRpcNotification) => void): () => void;
  onServerRequest(handler: (request: JsonRpcServerRequest) => void): () => void;
  /** Send a result for a server-initiated request. */
  respond(id: number | string, result: unknown): void;
  /** Send an error for a server-initiated request. */
  respondError(id: number | string, code: number, message: string): void;
  close(): void;
}

export class JsonRpcError extends Error {
  override readonly name = 'JsonRpcError';
  readonly code: number;
  readonly method: string;

  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message}`);
    this.code = code;
    this.method = method;
  }
}

export interface JsonRpcTransportOptions {
  readonly input: Readable;
  readonly output: Writable;
  /** Called when the underlying stream ends, so callers can fail pending calls. */
  readonly onClose?: (reason: string) => void;
}

interface PendingCall {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class LineJsonRpcTransport implements JsonRpcTransport {
  readonly #output: Writable;
  readonly #pending = new Map<number, PendingCall>();
  readonly #notifications = new Set<(notification: JsonRpcNotification) => void>();
  readonly #serverRequests = new Set<(request: JsonRpcServerRequest) => void>();
  readonly #onClose: ((reason: string) => void) | undefined;
  #nextId = 1;
  #closed = false;
  #buffer = '';

  constructor(options: JsonRpcTransportOptions) {
    this.#output = options.output;
    this.#onClose = options.onClose;

    // Manual line buffering rather than `readline`: it keeps no extra handle on
    // the stream, so a finished run cannot keep the process alive.
    options.input.on('data', (chunk: Buffer | string) => this.#receiveChunk(chunk.toString()));
    options.input.on('end', () => this.#failAll('transport closed'));
    options.input.on('close', () => this.#failAll('transport closed'));
    options.input.on('error', () => this.#failAll('transport closed'));
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new JsonRpcError(method, -32_000, 'transport closed'));
    }
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.#write({ jsonrpc: '2.0', id, method, params: params ?? null });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    this.#write({ jsonrpc: '2.0', method, params: params ?? null });
  }

  onNotification(handler: (notification: JsonRpcNotification) => void): () => void {
    this.#notifications.add(handler);
    return () => {
      this.#notifications.delete(handler);
    };
  }

  onServerRequest(handler: (request: JsonRpcServerRequest) => void): () => void {
    this.#serverRequests.add(handler);
    return () => {
      this.#serverRequests.delete(handler);
    };
  }

  respond(id: number | string, result: unknown): void {
    this.#write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.#write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  close(): void {
    this.#closed = true;
    this.#failAll('transport closed');
    this.#notifications.clear();
    this.#serverRequests.clear();
    this.#output.end();
  }

  #write(message: Record<string, unknown>): void {
    this.#output.write(`${JSON.stringify(message)}\n`);
  }

  /** Split incoming bytes into complete lines; a partial line waits for more. */
  #receiveChunk(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#receive(line);
      newline = this.#buffer.indexOf('\n');
    }
  }

  #receive(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // A non-JSON line is engine chatter on the protocol channel. Ignoring it
      // keeps one stray line from failing an otherwise healthy run.
      return;
    }

    const id = message.id;
    const method = message.method;

    if (typeof method === 'string' && id !== undefined && id !== null) {
      for (const handler of this.#serverRequests) {
        handler({ id: id as number | string, method, params: message.params });
      }
      return;
    }

    if (typeof method === 'string') {
      for (const handler of this.#notifications) {
        handler({ method, params: message.params });
      }
      return;
    }

    if (typeof id === 'number') {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      const error = message.error as { code?: number; message?: string } | undefined;
      if (error) {
        pending.reject(new JsonRpcError(pending.method, error.code ?? -32_603, error.message ?? 'unknown error'));
        return;
      }
      pending.resolve(message.result);
    }
  }

  #failAll(reason: string): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.reject(new JsonRpcError(pending.method, -32_000, reason));
    }
    this.#onClose?.(reason);
  }
}
