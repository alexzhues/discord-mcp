import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { eventDefinition } from './events/contract.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

it('advertises Events and preserves progressive tools across concurrent MCP sessions', async () => {
  const call = vi.fn(async (method: string) =>
    method === 'events/list'
      ? { events: [eventDefinition('111122223333444481')] }
      : { status: 'sent', message_id: '111122223333444485' },
  );
  const config = loadConfig({
    DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    LOG_LEVEL: 'fatal',
    MCP_TOOL_SURFACE: 'progressive',
  });
  const clients: Client[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const build = await buildServer({
        rest: new REST({ version: '10', makeRequest: fetch }).setToken('fake'),
        logger: createLogger(config),
        config,
        eventBridge: { call },
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client(
        { name: 'events-probe', version: '1' },
        { versionNegotiation: { mode: 'auto' } },
      );
      clients.push(client);
      await Promise.all([build.server.connect(b), client.connect(a)]);
      expect(build.server.getCapabilities()).toMatchObject({ events: {}, tools: {} });
      expect((await client.listTools()).tools).toHaveLength(7);
      const result = await client.request(
        { method: 'events/list', params: {} },
        z.object({ events: z.array(z.unknown()) }),
      );
      expect(result.events).toHaveLength(1);
      const search = await client.callTool({
        name: 'mcp_tools_search',
        arguments: { query: 'events_dm_reply' },
      });
      expect(search.structuredContent).toMatchObject({
        matches: [{ name: 'events_dm_reply', dispatcher: 'mcp_tools_write' }],
      });
      expect(
        await client.callTool({
          name: 'mcp_tools_read',
          arguments: { tool: 'events_dm_reply', args: { event_id: 'x', content: 'x' } },
        }),
      ).toMatchObject({ isError: true });
      expect(
        await client.callTool({
          name: 'mcp_tools_write',
          arguments: {
            tool: 'events_dm_reply',
            args: { event_id: 'discord_dm_111122223333444484', content: 'Hi' },
          },
        }),
      ).toMatchObject({ structuredContent: { status: 'sent' } });
    }
    expect(call.mock.calls.filter((c) => c[0] === 'dm/reply')).toHaveLength(3);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
  }
});
