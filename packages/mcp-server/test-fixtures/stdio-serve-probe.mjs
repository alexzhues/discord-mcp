import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

let factoryCalls = 0;
const handle = serveStdio(
  () => {
    factoryCalls += 1;
    const server = new Server(
      { name: 'discord-mcp-stdio-probe', version: `factory-${factoryCalls}` },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler('tools/list', async () => ({
      tools: [
        {
          name: 'probe',
          description: `A credential-free stdio protocol probe (factory ${factoryCalls}).`,
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }));
    return server;
  },
  { legacy: 'serve' },
);
process.once('SIGTERM', () => void handle.close());
