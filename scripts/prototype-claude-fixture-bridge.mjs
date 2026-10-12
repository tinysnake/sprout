/** Disposable #229 typed fixture bridge; no general MCP proxy or nested admission. */
import { createInterface } from 'node:readline';
const command = { type: 'object', properties: { executable: { const: 'fixture-origin-command', type: 'string' }, args: { type: 'array', maxItems: 0, items: { type: 'string' } }, cwd: { const: '.', type: 'string' }, timeoutMs: { const: 5000, type: 'integer' } }, required: ['executable', 'args', 'cwd', 'timeoutMs'], additionalProperties: false };
const schema = write => ({ type: 'object', properties: { path: { type: 'string' }, ...(write ? { content: { type: 'string', maxLength: 4096 } } : {}) }, required: write ? ['path', 'content'] : ['path'], additionalProperties: false });
const tools = [
  { name: 'remote_read', description: 'Read only at the work fixture; absolute and escaping paths denied.', inputSchema: schema(false) },
  { name: 'remote_write', description: 'Write only at the work fixture; absolute and escaping paths denied.', inputSchema: schema(true) },
  { name: 'remote_command', description: 'Run only fixture-origin-command with empty args, cwd dot and timeoutMs 5000 at the work origin.', inputSchema: command },
];
const deadline = setTimeout(() => process.exit(2), 145_000);
createInterface({ input: process.stdin }).on('line', async line => {
  try {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    let result;
    if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'disposable-origin-bridge', version: '229.2' } };
    else if (request.method === 'tools/list') result = { tools };
    else if (request.method === 'tools/call') {
      const response = await fetch(process.argv[2], { method: 'POST', body: JSON.stringify(request.params), signal: AbortSignal.timeout(12_000) });
      const value = await response.json();
      result = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: !value.ok };
    } else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unsupported' } }) + '\n'); return; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  } catch { /* Never retain native payloads. */ }
}).on('close', () => { clearTimeout(deadline); process.exit(0); });
