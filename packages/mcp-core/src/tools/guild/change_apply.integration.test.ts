import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadConfig } from '../../config.js';
import {
  createGuildChangePlan,
  GuildChangeRequestSchema,
  loadGuildChangeCheckpoint,
  saveGuildChangeCheckpoint,
  saveGuildChangePlan,
} from './_lib/guild-change.js';
import apply from './change_apply.js';

const guild = '999000999000999000';
const bot = '100002088458902020';
const role = '333344445555666677';
const channel = '222233334444555566';
const botRole = '444444444444444444';
let dir: string;
let previous: typeof container.config;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'guild-apply-safety-'));
  previous = container.config;
  container.config = loadConfig({
    DISCORD_TOKEN: 'test-token'.padEnd(64, 'x'),
    MCP_BLUEPRINT_STATE_DIR: dir,
  });
  container.rest = new REST({ version: '10', makeRequest: fetch, retries: 0 }).setToken(
    'fake-token',
  );
});
afterEach(async () => {
  container.config = previous;
  await rm(dir, { recursive: true, force: true });
});

function tool() {
  const Tool = apply;
  return new Tool(
    { name: 'guild_change_apply', path: 'inline', root: 'inline', store: null as never },
    { name: 'guild_change_apply', enabled: true },
  );
}
async function fixture(
  changes: unknown,
  liveRoles = [
    { id: guild, position: 0, permissions: '0' },
    { id: botRole, position: 10, permissions: '268435476' },
    { id: role, position: 1, name: 'old', permissions: '0' },
  ],
  liveChannels = [{ id: channel, name: 'old', topic: 't' }],
) {
  const before = {
    guild: { id: guild },
    bot_roles: [botRole],
    roles: liveRoles,
    channels: liveChannels,
  };
  const p = createGuildChangePlan(
    {
      schema_version: 'guild_change_plan.v1',
      guild_id: guild,
      bot_id: bot,
      request: 'apply',
      changes: GuildChangeRequestSchema.parse(changes),
      before,
    },
    'test-token'.padEnd(64, 'x'),
  );
  const ref = await saveGuildChangePlan(p, container.config);
  return { p, ref, before };
}
function mock(
  liveRoles: Record<string, unknown>[],
  liveChannels: Record<string, unknown>[],
  writes: unknown[] = [],
) {
  server.use(
    http.get('*/users/%40me', () => HttpResponse.json({ id: bot, bot: true })),
    http.get(`*/guilds/${guild}`, () => HttpResponse.json({ id: guild })),
    http.get(`*/guilds/${guild}/members/${bot}`, () => HttpResponse.json({ roles: [botRole] })),
    http.get(`*/guilds/${guild}/roles`, () => HttpResponse.json(liveRoles)),
    http.get(`*/guilds/${guild}/channels`, () => HttpResponse.json(liveChannels)),
    http.patch('*/channels/*', async ({ request }) => {
      writes.push(await request.json());
      return HttpResponse.json({});
    }),
    http.patch('*/guilds/*/channels', async ({ request }) => {
      writes.push(await request.json());
      return HttpResponse.json({});
    }),
    http.patch('*/roles/*', async ({ request }) => {
      writes.push(await request.json());
      return HttpResponse.json({});
    }),
  );
}

it('blocks a bad approval before any REST write', async () => {
  const { p, ref, before } = await fixture({ channels: [{ id: channel, patch: { name: 'new' } }] });
  const writes: unknown[] = [];
  mock(before.roles, before.channels, writes);
  const result = await tool().run(
    {
      guild_id: guild,
      expected_bot_id: bot,
      plan_ref: ref,
      approval_id: `sha256:${'0'.repeat(64)}`,
    },
    { signal: new AbortController().signal },
  );
  expect((result as { structuredContent: { status: string } }).structuredContent.status).toBe(
    'blocked',
  );
  expect(writes).toHaveLength(0);
  expect(p.approval_id).not.toBe(`sha256:${'0'.repeat(64)}`);
});

it('blocks a role when the bot loses role management before apply', async () => {
  const { p, ref, before } = await fixture(
    { roles: [{ id: role, patch: { name: 'new', permissions: '4' } }] },
    [
      { id: guild, position: 0, permissions: '0' },
      { id: botRole, position: 0, permissions: '0' },
      { id: role, position: 10, name: 'old', permissions: '4' },
    ],
    [],
  );
  const writes: unknown[] = [];
  mock(before.roles, before.channels, writes);
  const result = await tool().run(
    { guild_id: guild, expected_bot_id: bot, plan_ref: ref, approval_id: p.approval_id },
    { signal: new AbortController().signal },
  );
  expect(
    (result as { structuredContent: { status: string; blockers: string[] } }).structuredContent
      .status,
  ).toBe('blocked');
  expect(writes).toHaveLength(0);
});

it('marks an already-after operation completed without writing', async () => {
  const { p, ref, before } = await fixture(
    { channels: [{ id: channel, patch: { name: 'new' } }] },
    undefined,
    [{ id: channel, name: 'new', topic: 't' }],
  );
  const writes: unknown[] = [];
  mock(before.roles, before.channels, writes);
  const result = await tool().run(
    { guild_id: guild, expected_bot_id: bot, plan_ref: ref, approval_id: p.approval_id },
    { signal: new AbortController().signal },
  );
  expect((result as { structuredContent: { status: string } }).structuredContent.status).toBe(
    'complete',
  );
  expect(writes).toHaveLength(0);
});

it('does not continue after cancellation is observed after a write', async () => {
  const { p, ref, before } = await fixture({ channels: [{ id: channel, patch: { name: 'new' } }] });
  const writes: unknown[] = [];
  mock(before.roles, before.channels, writes);
  const controller = new AbortController();
  server.use(
    http.patch(`*/channels/${channel}`, async ({ request }) => {
      writes.push(await request.json());
      controller.abort();
      return HttpResponse.json({});
    }),
  );
  const result = await tool().run(
    { guild_id: guild, expected_bot_id: bot, plan_ref: ref, approval_id: p.approval_id },
    { signal: controller.signal },
  );
  expect(writes).toHaveLength(1);
  expect(
    (result as { structuredContent: { blockers: string[] } }).structuredContent.blockers,
  ).toContain('CANCELLED');
  expect((await loadGuildChangeCheckpoint(ref, container.config)).inflight).toBe(0);
  expect((result as { structuredContent: { status: string } }).structuredContent.status).toBe(
    'blocked',
  );
});

it('blocks channel edits after channel management is removed', async () => {
  const { p, ref, before } = await fixture(
    { channels: [{ id: channel, patch: { name: 'new' } }] },
    [
      { id: guild, position: 0, permissions: '0' },
      { id: botRole, position: 10, permissions: '268435456' },
    ],
  );
  const writes: unknown[] = [];
  mock(before.roles, before.channels, writes);
  const result = await tool().run(
    { guild_id: guild, expected_bot_id: bot, plan_ref: ref, approval_id: p.approval_id },
    { signal: new AbortController().signal },
  );
  expect(
    (result as { structuredContent: { blockers: string[] } }).structuredContent.blockers,
  ).toContain('BOT_MANAGE_CHANNELS');
  expect(writes).toHaveLength(0);
});

it('does not apply a restore-mode checkpoint', async () => {
  const { p, ref, before } = await fixture({ channels: [{ id: channel, patch: { name: 'new' } }] });
  const writes: unknown[] = [];
  mock(before.roles, before.channels, writes);
  await saveGuildChangeCheckpoint(
    ref,
    { mode: 'restore', completed: [0], inflight: null },
    container.config,
  );
  const result = await tool().run(
    { guild_id: guild, expected_bot_id: bot, plan_ref: ref, approval_id: p.approval_id },
    { signal: new AbortController().signal },
  );
  expect(
    (result as { structuredContent: { status: string; blockers: string[] } }).structuredContent
      .blockers,
  ).toContain('PLAN_RESTORE_MODE');
  expect(writes).toHaveLength(0);
});
