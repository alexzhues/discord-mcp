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
import restore from './change_restore.js';

const guild = '999000999000999000';
const bot = '100002088458902020';
const role = '333344445555666677';
const channel = '222233334444555566';
const targetRole = '444444444444444444';
let stateDir: string;
let previousConfig: typeof container.config;

function tool() {
  const Tool = restore;
  return new Tool(
    { name: 'guild_change_restore', path: 'inline', root: 'inline', store: null as never },
    { name: 'guild_change_restore', enabled: true },
  );
}
async function plan(changes: unknown, before: Record<string, unknown>) {
  const p = createGuildChangePlan(
    {
      schema_version: 'guild_change_plan.v1',
      guild_id: guild,
      bot_id: bot,
      request: 'restore',
      changes: GuildChangeRequestSchema.parse(changes),
      before: before as never,
    },
    'test-token'.padEnd(64, 'x'),
  );
  return { p, ref: await saveGuildChangePlan(p, container.config) };
}
function handlers(
  live: { roles: Record<string, unknown>[]; channels: Record<string, unknown>[] },
  onPut?: (body: unknown) => void,
) {
  server.use(
    http.get('*/users/@me', () => HttpResponse.json({ id: bot, bot: true })),
    http.get(`*/guilds/${guild}`, () => HttpResponse.json({ id: guild })),
    http.get(`*/guilds/${guild}/members/${bot}`, () => HttpResponse.json({ roles: [targetRole] })),
    http.get(`*/guilds/${guild}/roles`, () => HttpResponse.json(live.roles)),
    http.get(`*/guilds/${guild}/channels`, () => HttpResponse.json(live.channels)),
    http.put('*/permissions/*', async ({ request }) => {
      onPut?.(await request.json());
      return HttpResponse.json({});
    }),
    http.delete('*/permissions/*', () => HttpResponse.json({})),
    http.patch('*/roles/*', async ({ request }) => {
      onPut?.(await request.json());
      return HttpResponse.json({});
    }),
    http.patch('*/channels/*', async ({ request }) => {
      onPut?.(await request.json());
      return HttpResponse.json({});
    }),
    http.patch('*/guilds/*/channels', async ({ request }) => {
      onPut?.(await request.json());
      return HttpResponse.json({});
    }),
  );
}
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'guild-restore-safety-'));
  previousConfig = container.config;
  container.config = loadConfig({
    DISCORD_TOKEN: 'test-token'.padEnd(64, 'x'),
    MCP_BLUEPRINT_STATE_DIR: stateDir,
  });
  container.rest = new REST({ version: '10', makeRequest: fetch, retries: 0 }).setToken(
    'fake-token',
  );
});
afterEach(async () => {
  container.config = previousConfig;
  await rm(stateDir, { recursive: true, force: true });
});

it('restores a role inverse without touching omitted fields', async () => {
  const before = {
    guild: { id: guild },
    bot_roles: [targetRole],
    roles: [
      { id: guild, position: 0, permissions: '0' },
      { id: targetRole, position: 10, permissions: '268435476' },
      { id: role, position: 1, name: 'old', permissions: '0', hoist: false },
    ],
    channels: [],
  };
  const { p, ref } = await plan(
    { roles: [{ id: role, patch: { name: 'new', permissions: '4' } }] },
    before,
  );
  const bodies: unknown[] = [];
  const liveRoles = [
    { id: guild, position: 0, permissions: '0' },
    { id: targetRole, position: 10, permissions: '268435476' },
    { id: role, position: 1, name: 'new', permissions: '4', hoist: false },
  ];
  handlers({ roles: liveRoles, channels: [] }, (body) => {
    bodies.push(body);
    Object.assign(liveRoles[2]!, body);
  });
  await saveGuildChangeCheckpoint(
    ref,
    { mode: 'apply', completed: [0], inflight: null },
    container.config,
  );
  const result = await tool().run(
    {
      guild_id: guild,
      expected_bot_id: bot,
      plan_ref: ref,
      approval_id: p.approval_id,
      operation_indexes: [0],
    },
    { signal: new AbortController().signal },
  );
  expect((result as any).structuredContent.restored).toEqual([0]);
  expect(bodies[0]).toMatchObject({ name: 'old', permissions: '0' });
});

it('restores existing and absent permission overwrites with full inverse semantics', async () => {
  const before = {
    guild: { id: guild },
    bot_roles: [targetRole],
    roles: [
      { id: guild, position: 0, permissions: '0' },
      { id: targetRole, position: 10, permissions: '268435476' },
    ],
    channels: [
      { id: channel, permission_overwrites: [{ id: role, type: 0, allow: '4', deny: '8' }] },
    ],
  };
  const { p, ref } = await plan(
    {
      permission_overwrites: [
        { channel_id: channel, overwrite_id: role, type: 0, allow: '16', deny: '32' },
      ],
    },
    before,
  );
  const bodies: unknown[] = [];
  const liveOverwrite = { id: role, type: 0, allow: '16', deny: '32' };
  handlers(
    { roles: before.roles, channels: [{ id: channel, permission_overwrites: [liveOverwrite] }] },
    (body) => {
      bodies.push(body);
      Object.assign(liveOverwrite, body);
    },
  );
  await saveGuildChangeCheckpoint(
    ref,
    { mode: 'apply', completed: [0], inflight: null },
    container.config,
  );
  const result = await tool().run(
    {
      guild_id: guild,
      expected_bot_id: bot,
      plan_ref: ref,
      approval_id: p.approval_id,
      operation_indexes: [0],
    },
    { signal: new AbortController().signal },
  );
  expect((result as any).structuredContent.restored).toEqual([0]);
  expect(bodies[0]).toMatchObject({ type: 0, allow: '4', deny: '8' });
});

it('rejects bad approval and invalid selection without creating restore mode', async () => {
  const before = {
    guild: { id: guild },
    bot_roles: [targetRole],
    roles: [
      { id: guild, position: 0, permissions: '0' },
      { id: targetRole, position: 10, permissions: '268435476' },
    ],
    channels: [],
  };
  const { p, ref } = await plan({ roles: [{ id: role, patch: { name: 'new' } }] }, before);
  handlers({ roles: before.roles, channels: [] });
  const bad = await tool().run(
    {
      guild_id: guild,
      expected_bot_id: bot,
      plan_ref: ref,
      approval_id: `sha256:${'0'.repeat(64)}`,
      operation_indexes: [0],
    },
    { signal: new AbortController().signal },
  );
  expect((bad as any).structuredContent.status).toBe('blocked');
  await saveGuildChangeCheckpoint(
    ref,
    { mode: 'apply', completed: [], inflight: null },
    container.config,
  );
  const invalid = await tool().run(
    {
      guild_id: guild,
      expected_bot_id: bot,
      plan_ref: ref,
      approval_id: p.approval_id,
      operation_indexes: [9],
    },
    { signal: new AbortController().signal },
  );
  expect((invalid as any).structuredContent.status).toBe('blocked');
});

it('blocks inverse on live drift and performs no write', async () => {
  const before = {
    guild: { id: guild },
    bot_roles: [targetRole],
    roles: [
      { id: guild, position: 0, permissions: '0' },
      { id: targetRole, position: 10, permissions: '268435476' },
    ],
    channels: [{ id: channel, name: 'old' }],
  };
  const { p, ref } = await plan({ channels: [{ id: channel, patch: { name: 'new' } }] }, before);
  const writes: unknown[] = [];
  handlers({ roles: before.roles, channels: [{ id: channel, name: 'external' }] }, (body) =>
    writes.push(body),
  );
  await saveGuildChangeCheckpoint(
    ref,
    { mode: 'apply', completed: [0], inflight: null },
    container.config,
  );
  const result = await tool().run(
    {
      guild_id: guild,
      expected_bot_id: bot,
      plan_ref: ref,
      approval_id: p.approval_id,
      operation_indexes: [0],
    },
    { signal: new AbortController().signal },
  );
  expect((result as any).structuredContent.status).toBe('blocked');
  expect(writes).toHaveLength(0);
});

it('blocks a role inverse when the bot lost the required permission before writing', async () => {
  const before = {
    guild: { id: guild },
    bot_roles: [targetRole],
    roles: [
      { id: guild, position: 0, permissions: '0' },
      { id: targetRole, position: 10, permissions: '268435476' },
      { id: role, position: 1, name: 'old', permissions: '4' },
    ],
    channels: [],
  };
  const { p, ref } = await plan({ roles: [{ id: role, patch: { permissions: '0' } }] }, before);
  const writes: unknown[] = [];
  handlers(
    {
      roles: [
        { id: guild, position: 0, permissions: '0' },
        { id: targetRole, position: 10, permissions: '268435472' },
        { id: role, position: 1, name: 'new', permissions: '0' },
      ],
      channels: [],
    },
    (body) => writes.push(body),
  );
  await saveGuildChangeCheckpoint(
    ref,
    { mode: 'apply', completed: [0], inflight: null },
    container.config,
  );
  const result = await tool().run(
    {
      guild_id: guild,
      expected_bot_id: bot,
      plan_ref: ref,
      approval_id: p.approval_id,
      operation_indexes: [0],
    },
    { signal: new AbortController().signal },
  );
  expect(
    (result as { structuredContent: { blocked: string[] } }).structuredContent.blocked,
  ).toContain('ROLE_PERMISSION_SCOPE');
  expect(writes).toHaveLength(0);
});

it('deletes a newly created overwrite when restoring its absent before-state', async () => {
  const before = {
    guild: { id: guild },
    bot_roles: [targetRole],
    roles: [
      { id: guild, position: 0, permissions: '0' },
      { id: targetRole, position: 10, permissions: '268435476' },
    ],
    channels: [{ id: channel, permission_overwrites: [] }],
  };
  const { p, ref } = await plan(
    {
      permission_overwrites: [
        { channel_id: channel, overwrite_id: role, type: 0, allow: '16', deny: '32' },
      ],
    },
    before,
  );
  const liveOverwrite = { id: role, type: 0, allow: '16', deny: '32' };
  const liveOverwrites = [liveOverwrite];
  let deletes = 0;
  handlers({
    roles: before.roles,
    channels: [{ id: channel, permission_overwrites: liveOverwrites }],
  });
  server.use(
    http.delete(`*/channels/${channel}/permissions/${role}`, () => {
      deletes += 1;
      liveOverwrites.splice(0, 1);
      return HttpResponse.json({});
    }),
  );
  await saveGuildChangeCheckpoint(
    ref,
    { mode: 'apply', completed: [0], inflight: null },
    container.config,
  );
  const result = await tool().run(
    {
      guild_id: guild,
      expected_bot_id: bot,
      plan_ref: ref,
      approval_id: p.approval_id,
      operation_indexes: [0],
    },
    { signal: new AbortController().signal },
  );
  expect(
    (result as { structuredContent: { restored: number[] } }).structuredContent.restored,
  ).toEqual([0]);
  expect(deletes).toBe(1);
});

it('keeps apply mode after invalid selection', async () => {
  const before = {
    guild: { id: guild },
    bot_roles: [targetRole],
    roles: [
      { id: guild, position: 0, permissions: '0' },
      { id: targetRole, position: 10, permissions: '268435476' },
    ],
    channels: [],
  };
  const { p, ref } = await plan({ roles: [{ id: role, patch: { name: 'new' } }] }, before);
  handlers({ roles: before.roles, channels: [] });
  await saveGuildChangeCheckpoint(
    ref,
    { mode: 'apply', completed: [], inflight: null },
    container.config,
  );
  await tool().run(
    {
      guild_id: guild,
      expected_bot_id: bot,
      plan_ref: ref,
      approval_id: p.approval_id,
      operation_indexes: [99],
    },
    { signal: new AbortController().signal },
  );
  expect((await loadGuildChangeCheckpoint(ref, container.config)).mode).toBe('apply');
});

it('does not execute later inverses after the first restore REST failure', async () => {
  const second = '333333333333333334';
  const before = {
    guild: { id: guild },
    bot_roles: [targetRole],
    roles: [
      { id: guild, position: 0, permissions: '0' },
      { id: targetRole, position: 10, permissions: '268435476' },
    ],
    channels: [
      { id: channel, name: 'old' },
      { id: second, name: 'old2' },
    ],
  };
  const { p, ref } = await plan(
    {
      channels: [
        { id: channel, patch: { name: 'one' } },
        { id: second, patch: { name: 'two' } },
      ],
    },
    before,
  );
  let writes = 0;
  handlers(
    {
      roles: before.roles,
      channels: [
        { id: channel, name: 'one' },
        { id: second, name: 'two' },
      ],
    },
    () => {
      writes += 1;
    },
  );
  server.use(
    http.patch(`*/channels/${channel}`, () =>
      HttpResponse.json({ error: 'fail' }, { status: 400 }),
    ),
  );
  await saveGuildChangeCheckpoint(
    ref,
    { mode: 'apply', completed: [0, 1], inflight: null },
    container.config,
  );
  const result = await tool().run(
    {
      guild_id: guild,
      expected_bot_id: bot,
      plan_ref: ref,
      approval_id: p.approval_id,
      operation_indexes: [0, 1],
    },
    { signal: new AbortController().signal },
  );
  expect((result as { structuredContent: { status: string } }).structuredContent.status).toBe(
    'blocked',
  );
  expect(writes).toBe(0);
});

it('requires reconciling an in-flight inverse before selecting another operation', async () => {
  const before = {
    guild: { id: guild },
    bot_roles: [targetRole],
    roles: [
      { id: guild, position: 0, permissions: '0' },
      { id: targetRole, position: 10, permissions: '268435476' },
    ],
    channels: [{ id: channel, name: 'old' }],
  };
  const second = '333333333333333334';
  const { p, ref } = await plan(
    {
      channels: [
        { id: channel, patch: { name: 'one' } },
        { id: second, patch: { name: 'two' } },
      ],
    },
    { ...before, channels: [...before.channels, { id: second, name: 'old2' }] },
  );
  const writes: unknown[] = [];
  handlers(
    {
      roles: before.roles,
      channels: [
        { id: channel, name: 'one' },
        { id: second, name: 'two' },
      ],
    },
    (body) => writes.push(body),
  );
  await saveGuildChangeCheckpoint(
    ref,
    { mode: 'restore', completed: [0, 1], inflight: 0 },
    container.config,
  );
  const result = (await tool().run(
    {
      guild_id: guild,
      expected_bot_id: bot,
      plan_ref: ref,
      approval_id: p.approval_id,
      operation_indexes: [1],
    },
    { signal: new AbortController().signal },
  )) as { structuredContent: { status: string; blocked: string[] } };
  expect(result.structuredContent.status).toBe('blocked');
  expect(result.structuredContent.blocked).toContain('RESTORE_RECONCILIATION_REQUIRED');
  expect(writes).toHaveLength(0);
  expect(await loadGuildChangeCheckpoint(ref, container.config)).toMatchObject({
    mode: 'restore',
    inflight: 0,
  });
});
