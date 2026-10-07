import type { OperatorDiagnostics } from '../operations/module.ts';
import type { ApiRouter } from './router.ts';
export function createOperatorRouter(operations: OperatorDiagnostics): ApiRouter {
  return { name: 'operator-diagnostics', async handle(context) {
    if (context.pathname !== '/api/operator/settings' && context.pathname !== '/api/operator/diagnostics') return false;
    if (!context.operatorSessionId) { context.response.writeHead(401).end(); return true; }
    if (context.method !== 'GET') { context.response.writeHead(405).end(); return true; }
    const body = context.pathname.endsWith('/settings') ? await operations.settings(context.operatorSessionId) : await operations.export();
    context.response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    context.response.end(JSON.stringify(body));
    return true;
  } };
}
