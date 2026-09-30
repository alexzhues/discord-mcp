import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { buildServer, createLogger, loadConfig } from '../dist/index.js';

const state = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-acceptance-'));
const user = {
  id: '111111111111111111',
  username: 'acceptance',
  global_name: null,
  avatar: null,
  bot: true,
};
const target = { profile_id: 'acceptance' };
const clients = [];
let unblock;
let started;
const entered = new Promise((resolve) => {
  started = resolve;
});
const pending = new Promise((resolve) => {
  unblock = resolve;
});
let reads = 0;
const config = (access, extra = {}) =>
  loadConfig({
    DISCORD_TOKEN: 'Bot fake.acceptance.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    DISCORD_MCP_ACCESS_TOKEN: access.repeat(64),
    MCP_BLUEPRINT_STATE_DIR: state,
    MCP_AUDIT_ENABLED: 'false',
    LOG_LEVEL: 'fatal',
    MCP_CATEGORIES: 'users',
    ...extra,
  });
async function connect(access, gated = false) {
  const cfg = config(access);
  const rest = new REST({
    version: '10',
    makeRequest: async () => {
      reads += 1;
      if (gated && reads === 1) {
        started();
        await pending;
      }
      return Response.json(user);
    },
  }).setToken(cfg.DISCORD_TOKEN);
  const { server } = await buildServer({
    config: cfg,
    logger: createLogger(cfg),
    rest,
    transport: 'http',
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'workflow-acceptance', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  clients.push(client);
  return client;
}
async function status(client, id, binding = target) {
  const result = await client.callTool({
    name: 'workflow_status',
    arguments: { id, target: binding },
  });
  assert.equal(result.isError, false);
  return result.structuredContent;
}
async function until(fn, expected) {
  for (let i = 0; i < 100; i += 1) {
    const value = await fn();
    if (value.status === expected) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Workflow did not reach ${expected}`);
}
try {
  const first = await connect('a', true);
  const accepted = await first.callTool({
    name: 'workflow_start',
    arguments: {
      target,
      steps: [
        { tool: 'users_get_current', args: {} },
        { tool: 'users_get', args: { user_id: user.id } },
      ],
    },
  });
  assert.equal(accepted.isError, false);
  const id = accepted.structuredContent.id;
  assert.match(id, /^wf_[0-9a-f]{32}$/);
  await entered;
  const sameCaller = await connect('a');
  assert.equal((await status(sameCaller, id)).status, 'running');
  const otherCaller = await connect('b');
  const denied = await otherCaller.callTool({ name: 'workflow_status', arguments: { id, target } });
  assert.equal(denied.isError, true);
  await first.close();
  unblock();
  const completed = await until(() => status(sameCaller, id), 'completed');
  assert.equal(completed.completed_steps, 2);
  assert.equal(reads, 2);
  const guild = '222222222222222222';
  const channels = ['333333333333333333', '444444444444444444'];
  const outside = '555555555555555555';
  const guildTarget = { profile_id: 'guild-acceptance', guild_id: guild };
  let historyReads = 0;
  const scopedConfig = config('c', { MCP_CATEGORIES: 'messages' });
  const scopedRest = new REST({
    version: '10',
    makeRequest: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/messages')) {
        historyReads += 1;
        return Response.json([]);
      }
      const channel = path.split('/').at(-1);
      return Response.json({
        id: channel,
        type: 0,
        guild_id: channel === outside ? '666666666666666666' : guild,
      });
    },
  }).setToken(scopedConfig.DISCORD_TOKEN);
  const { server: scopedServer } = await buildServer({
    config: scopedConfig,
    logger: createLogger(scopedConfig),
    rest: scopedRest,
    transport: 'http',
  });
  const [scopedClientTransport, scopedServerTransport] = InMemoryTransport.createLinkedPair();
  const scopedClient = new Client({ name: 'scope-acceptance', version: '0.0.0' });
  await Promise.all([
    scopedServer.connect(scopedServerTransport),
    scopedClient.connect(scopedClientTransport),
  ]);
  clients.push(scopedClient);
  const multiple = await scopedClient.callTool({
    name: 'workflow_start',
    arguments: {
      target: guildTarget,
      steps: channels.map((channel_id) => ({ tool: 'messages_read', args: { channel_id } })),
    },
  });
  assert.equal(multiple.isError, false);
  assert.equal(
    (
      await until(
        () => status(scopedClient, multiple.structuredContent.id, guildTarget),
        'completed',
      )
    ).completed_steps,
    2,
  );
  assert.equal(historyReads, 2);
  const crossGuild = await scopedClient.callTool({
    name: 'workflow_start',
    arguments: {
      target: guildTarget,
      steps: [{ tool: 'messages_read', args: { channel_id: outside } }],
    },
  });
  assert.equal(crossGuild.isError, false);
  const scopeBlocked = await until(
    () => status(scopedClient, crossGuild.structuredContent.id, guildTarget),
    'failed',
  );
  assert.equal(scopeBlocked.failure.code, 'WORKFLOW_TARGET_REJECTED');
  assert.equal(historyReads, 2);
  const singleTarget = { profile_id: 'channel-acceptance', channel_id: channels[0] };
  const single = await scopedClient.callTool({
    name: 'workflow_start',
    arguments: {
      target: singleTarget,
      steps: [{ tool: 'messages_read', args: { channel_id: channels[0] } }],
    },
  });
  assert.equal(single.isError, false);
  assert.equal(
    (
      await until(
        () => status(scopedClient, single.structuredContent.id, singleTarget),
        'completed',
      )
    ).completed_steps,
    1,
  );
  assert.equal(historyReads, 3);
  const wider = await scopedClient.callTool({
    name: 'workflow_start',
    arguments: {
      target: singleTarget,
      steps: [{ tool: 'guild_modify', args: { guild_id: guild, name: 'must never change' } }],
    },
  });
  assert.equal(wider.isError, false);
  assert.equal(
    (await until(() => status(scopedClient, wider.structuredContent.id, singleTarget), 'failed'))
      .failure.code,
    'WORKFLOW_TARGET_REJECTED',
  );
  assert.equal(historyReads, 3);
  assert.equal('results' in completed, false);
  assert.equal('steps' in completed, false);

  const restrictedTarget = { ...target, guild_id: '222222222222222222' };
  const restricted = await sameCaller.callTool({
    name: 'workflow_start',
    arguments: {
      target: restrictedTarget,
      steps: [
        {
          tool: 'guild_modify',
          args: { guild_id: restrictedTarget.guild_id, name: 'must never change' },
        },
      ],
    },
  });
  assert.equal(restricted.isError, false);
  const blocked = await until(
    () => status(sameCaller, restricted.structuredContent.id, restrictedTarget),
    'failed',
  );
  assert.equal(blocked.failure.code, 'SCOPE_REJECTED');
  assert.equal(blocked.completed_steps, 0);
  assert.equal(reads, 2);
  process.stdout.write(
    'Workflow acceptance passed: immediate handle, request disconnect, durable cross-server status, caller isolation, middleware category gate, and private output.\n',
  );
} finally {
  unblock();
  await Promise.all(clients.map((client) => client.close()));
  await rm(state, { recursive: true, force: true });
}
