import { ScriptedEngineAdapter } from '../src/engine/scripted.ts';
import { EnvironmentWorker } from '../src/worker/server.ts';

const worker = new EnvironmentWorker({
  environmentInstanceId: process.env.SPROUT_ENV_INSTANCE ?? 'ticket244-container-worker',
  engines: new Map([['scripted', new ScriptedEngineAdapter({ turns: [] })]]),
  input: process.stdin,
  output: process.stdout,
  ...(process.env.SPROUT_WORKSPACE_ROOT !== undefined ? { workspaceRoot: process.env.SPROUT_WORKSPACE_ROOT } : {}),
});
process.stdin.on('error', () => undefined);
process.stdin.on('close', () => { void worker.shutdown(); });
