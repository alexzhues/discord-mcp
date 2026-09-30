import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';
import type { WorkflowSummary } from './workflows/engine.js';
import type { WorkflowTarget } from './workflows/types.js';

const bot = '111111111111111111';
const guild = '222222222222222222';
const channels = ['333333333333333333', '444444444444444444'];
const outside = '555555555555555555';
const identity = { id: bot, username: 'acceptance', global_name: null, avatar: null, bot: true };
let directory: string;
let clients: Client[];

async function connect(
  access: string,
  category: string,
  makeRequest: NonNullable<ConstructorParameters<typeof REST>[0]>['makeRequest'],
) {
  const config = loadConfig({
    DISCORD_TOKEN: 'fake'.padEnd(64, 'x'),
    DISCORD_MCP_ACCESS_TOKEN: access.repeat(64),
    MCP_BLUEPRINT_STATE_DIR: directory,
    MCP_CATEGORIES: category,
    MCP_AUDIT_ENABLED: 'false',
    LOG_LEVEL: 'fatal',
  });
  const rest = new REST({ version: '10', makeRequest }).setToken(config.DISCORD_TOKEN);
  const { server } = await buildServer({
    config,
    logger: createLogger(config),
    rest,
    transport: 'http',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'workflow-integration', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return client;
}

async function status(client: Client, id: string, target: WorkflowTarget) {
  const result = await client.callTool({ name: 'workflow_status', arguments: { id, target } });
  expect(result.isError).toBe(false);
  return result.structuredContent as unknown as WorkflowSummary;
}

async function terminal(client: Client, id: string, target: WorkflowTarget, expected: string) {
  let result: WorkflowSummary | undefined;
  await vi.waitFor(
    async () => {
      result = await status(client, id, target);
      expect(result.status).toBe(expected);
    },
    { timeout: 10_000 },
  );
  return result!;
}

async function start(
  client: Client,
  target: WorkflowTarget,
  steps: Array<{ tool: string; args: Record<string, unknown> }>,
) {
  const result = await client.callTool({ name: 'workflow_start', arguments: { target, steps } });
  expect(result.isError).toBe(false);
  return String(result.structuredContent!.id);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'discord-workflow-server-'));
  clients = [];
});
afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe('durable workflows through the MCP server', () => {
  it('outlives a request, isolates credentials, and applies category gates to each step', async () => {
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let reads = 0;
    const first = await connect('a', 'users', async () => {
      if (++reads === 1) {
        entered();
        await pending;
      }
      return Response.json(identity);
    });
    const target = { profile_id: 'acceptance' };
    const id = await start(first, target, [
      { tool: 'users_get_current', args: {} },
      { tool: 'users_get', args: { user_id: bot } },
    ]);
    try {
      await started;
      const same = await connect('a', 'users', async () => Response.json(identity));
      expect((await status(same, id, target)).status).toBe('running');
      const other = await connect('b', 'users', async () => Response.json(identity));
      expect(
        (await other.callTool({ name: 'workflow_status', arguments: { id, target } })).isError,
      ).toBe(true);
      expect(
        (
          await same.callTool({
            name: 'workflow_status',
            arguments: { id, target: { profile_id: 'another' } },
          })
        ).isError,
      ).toBe(true);
      await first.close();
      release();
      const completed = await terminal(same, id, target, 'completed');
      expect(completed.completed_steps).toBe(2);
      expect(reads).toBe(2);
      expect(completed).not.toHaveProperty('steps');
      const restrictedTarget = { ...target, guild_id: guild };
      const restricted = await start(same, restrictedTarget, [
        { tool: 'guild_modify', args: { guild_id: guild, name: 'never change' } },
      ]);
      expect((await terminal(same, restricted, restrictedTarget, 'failed')).failure?.code).toBe(
        'SCOPE_REJECTED',
      );
      expect(
        (
          await same.callTool({
            name: 'workflow_start',
            arguments: {
              target: { profile_id: 'wrong-bot', bot_id: outside },
              steps: [{ tool: 'users_get_current', args: {} }],
            },
          })
        ).isError,
      ).toBe(true);
    } finally {
      release();
    }
  });

  it('binds guild and channel targets before history reads or broader writes', async () => {
    let histories = 0;
    const client = await connect('c', 'messages,channels', async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/messages')) {
        histories += 1;
        return Response.json([]);
      }
      if (path.endsWith(`/guilds/${guild}/channels`)) return Response.json([]);
      if (path.includes('/webhooks/'))
        return Response.json({ guild_id: guild, channel_id: channels[1] });
      if (path.endsWith('/users/@me')) return Response.json(identity);
      const id = path.split('/').at(-1);
      return Response.json({
        id,
        type: 0,
        guild_id: id === outside ? '666666666666666666' : guild,
      });
    });
    const target = { profile_id: 'guild', guild_id: guild };
    const id = await start(
      client,
      target,
      channels.map((channel_id) => ({ tool: 'messages_read', args: { channel_id } })),
    );
    expect((await terminal(client, id, target, 'completed')).completed_steps).toBe(2);
    const cross = await start(client, target, [
      { tool: 'messages_read', args: { channel_id: outside } },
    ]);
    expect((await terminal(client, cross, target, 'failed')).failure?.code).toBe(
      'WORKFLOW_TARGET_REJECTED',
    );
    expect(histories).toBe(2);
    const implicitGuild = await start(client, target, [{ tool: 'channels_list', args: {} }]);
    await terminal(client, implicitGuild, target, 'completed');
    const single = { profile_id: 'channel', channel_id: channels[0] };
    const one = await start(client, single, [
      { tool: 'messages_read', args: { channel_id: channels[0] } },
    ]);
    await terminal(client, one, single, 'completed');
    expect(histories).toBe(3);
    const wider = await start(client, single, [
      { tool: 'guild_modify', args: { guild_id: guild, name: 'never change' } },
    ]);
    expect((await terminal(client, wider, single, 'failed')).failure?.code).toBe(
      'WORKFLOW_TARGET_REJECTED',
    );
    const webhook = await start(client, single, [
      { tool: 'webhooks_get', args: { webhook_id: outside } },
    ]);
    expect((await terminal(client, webhook, single, 'failed')).failure?.code).toBe(
      'WORKFLOW_TARGET_REJECTED',
    );
    const unbound = { profile_id: 'unbound' };
    const unresolved = await start(client, unbound, [{ tool: 'guild_get', args: {} }]);
    expect((await terminal(client, unresolved, unbound, 'failed')).failure?.code).toBe(
      'WORKFLOW_TARGET_REJECTED',
    );
    const wrongGuild = await client.callTool({
      name: 'workflow_start',
      arguments: {
        target: { ...single, guild_id: outside },
        steps: [{ tool: 'messages_read', args: { channel_id: channels[0] } }],
      },
    });
    expect(wrongGuild.isError).toBe(true);
    expect(histories).toBe(3);
  });
});
