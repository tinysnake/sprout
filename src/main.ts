import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseHostConfiguration } from './host-config.ts';
import { createSproutRuntime, MissingEnvironmentEngineError } from './runtime.ts';
import { SchemaError } from './store/schema.ts';

/**
 * The M1 runtime entry point.
 *
 * This entry point holds only five things: **configuration**, **runtime
 * construction**, **listening**, **reconciliation**, and **signal handling**.
 * The complete object graph — stores, the environment worker port, the run
 * orchestrator, the Task lifecycle, the collaboration coordinator, and the Web
 * transport — is assembled by the runtime Module (`src/runtime.ts`) behind one
 * caller-facing seam, so this file no longer names a store, a carrier, or a
 * service.
 *
 * Since ADR-0003 the concrete adapter this build names is a **worker**, not an
 * engine: engines are spawned and supervised inside the environment by its
 * worker, and the core only orchestrates. Configuration is host facts rather
 * than product decisions, so it is read once from the environment by the
 * host-configuration Module and consumed as a typed result here.
 */

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');

const configuration = parseHostConfiguration(process.env, { projectRoot });

let runtime;
try {
  runtime = await createSproutRuntime({ configuration, projectRoot });
} catch (error) {
  // A missing configured engine is the one construction failure the operator is
  // meant to see as a startup refusal rather than a crash. The runtime already
  // closed its worker channels before throwing.
  if (error instanceof MissingEnvironmentEngineError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  if (error instanceof SchemaError) {
    process.stderr.write(`Sprout database schema error:\n${error.message}\n\n${error.guidance}\n`);
    process.exit(1);
  }
  throw error;
}

const { port: boundPort } = await runtime.api.listen(configuration.port);

/**
 * Reconcile leftover durable state after a restart, before serving.
 *
 * The runtime owns the one observable order: runs are reconciled first so an
 * orphaned run is already settled as failed and can never have a reply
 * fabricated for it, then Task environment lifecycle, then the collaboration
 * write path (#26). The pass is idempotent, so a clean restart changes nothing.
 */
await runtime.reconcile();

process.stdout.write(runtime.startupReport(boundPort));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // The runtime closes in the one observable order: the Web surface (which
    // holds SSE streams open), then the environment worker channels, then the
    // store. A *container* is not destroyed here: `rm` is the only irrecoverable
    // action (#4), so its lifecycle is an explicit operator decision.
    void runtime.close().then(() => {
      process.exit(0);
    });
  });
}
