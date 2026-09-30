import { buildCatalogServer } from '@discord-mcp/core';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const { server } = await buildCatalogServer();
serveStdio(() => server, { legacy: 'serve' });
