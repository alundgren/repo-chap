import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { conversationLimits, type ConversationTool } from './conversation-types.js';
import { record } from './conversation-process.js';

/** The loopback server exists only while a Claude turn owns the registered tools. */
export async function openConversationMcp(tools: readonly ConversationTool[], call: (id: string, name: string, args: unknown) => Promise<{ text: string; isError?: boolean }>) {
  const token = randomBytes(32).toString('hex');
  let inflight = 0;
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}` || request.headers.origin || request.url !== '/mcp') { response.writeHead(403).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    if (++inflight > 8) { inflight--; response.writeHead(429).end(); return; }
    let id: unknown;
    const reply = (value: unknown) => { if (!response.destroyed) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, ...value as object })); };
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > conversationLimits.toolArgumentBytes + 4096) { response.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const message: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!record(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') { response.writeHead(400).end(); return; }
      id = message.id;
      if (id === undefined) { response.writeHead(202).end(); return; }
      if (typeof id !== 'string' && !Number.isSafeInteger(id)) { response.writeHead(400).end(); return; }
      switch (message.method) {
        case 'initialize': reply({ result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'repo_chap', version: '0.1.0' } } }); break;
        case 'ping': reply({ result: {} }); break;
        case 'tools/list': reply({ result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } }); break;
        case 'tools/call': {
          if (!record(message.params) || typeof message.params.name !== 'string') { reply({ error: { code: -32602, message: 'Choose a registered authoring tool.' } }); break; }
          const result = await call(String(message.params._meta?.['claudecode/toolUseId'] ?? id), message.params.name, message.params.arguments);
          reply({ result: { content: [{ type: 'text', text: result.text }], isError: result.isError ?? false } }); break;
        }
        default: reply({ error: { code: -32601, message: 'This MCP operation is unavailable.' } });
      }
    } catch { reply({ error: { code: -32603, message: 'The local authoring tool could not complete.' } }); }
    finally { inflight--; }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot open the local authoring tools.');
  return {
    config: { mcpServers: { repo_chap: { type: 'http', url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } },
    close() { server.closeAllConnections(); server.close(); },
  };
}
