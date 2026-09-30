import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadConfig } from '../../config.js';
import {
  createGuildChangePlan,
  GuildChangeRequestSchema,
  loadGuildChangeCheckpoint,
  saveGuildChangeCheckpoint,
  saveGuildChangePlan,
} from './_lib/guild-change.js';
import Apply from './change_apply.js';
import Restore from './change_restore.js';

const guild = '111111111111111111';
const bot = '222222222222222222';
const role = '333333333333333333';
const botRole = '444444444444444444';
const channel = '555555555555555555';
let directory: string;
let previousConfig: typeof container.config;
let previousRest: typeof container.rest;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'guild-live-guard-'));
  previousConfig = container.config;
  previousRest = container.rest;
  container.config = loadConfig({
    DISCORD_TOKEN: 'fake'.padEnd(64, 'x'),
    MCP_BLUEPRINT_STATE_DIR: directory,
  });
});
afterEach(async () => {
  container.config = previousConfig;
  container.rest = previousRest;
  await rm(directory, { recursive: true, force: true });
});

it.each([
  ['restore', 'roles', '0', 'normal', true, 'BOT_MANAGE_ROLES'],
  ['restore', 'channels', '0', 'normal', true, 'BOT_MANAGE_CHANNELS'],
  ['restore', 'roles', '268435472', 'missing', true, 'ROLE_NOT_FOUND'],
  ['restore', 'roles', '268435472', 'managed', true, 'MANAGED_ROLE'],
  ['restore', 'roles', '268435472', 'everyone', true, 'EVERYONE_ROLE_LIMIT'],
  ['restore', 'roles', '268435472', 'higher', true, 'ROLE_HIERARCHY'],
  ['restore', 'roles', '268435472', 'normal', false, 'OPERATION_0_NOT_APPLIED'],
  ['apply', 'permission_overwrites', '16', 'normal', false, 'BOT_MANAGE_ROLES'],
  ['apply', 'roles', '268435472', 'everyone', false, 'EVERYONE_ROLE_LIMIT'],
  ['apply', 'roles', '268435472', 'drift', true, 'OPERATION_0_EXTERNAL_DRIFT'],
  ['apply', 'roles', '8', 'normal', false, null],
  ['restore', 'roles', '8', 'normal', true, null],
] as const)('%s rechecks %s capability %s with a %s resource and applied=%s', async (mode, kind, permissions, condition, applied, blocker) => {
  const targetId = condition === 'everyone' ? guild : role;
  const before = {
    guild: { id: guild },
    bot_roles: [botRole],
    roles: [
      { id: guild, position: 0, permissions: '0', name: 'old' },
      { id: botRole, position: 10, permissions: '268435472', name: 'bot' },
      { id: role, position: 1, permissions: '0', name: 'old', managed: false },
    ],
    channels: [
      {
        id: channel,
        name: 'old',
        permission_overwrites: [{ id: role, type: 0, allow: '0', deny: '0' }],
      },
    ],
  };
  const plan = createGuildChangePlan(
    {
      schema_version: 'guild_change_plan.v1',
      guild_id: guild,
      bot_id: bot,
      request: 'Recheck live authority before an effect',
      changes: GuildChangeRequestSchema.parse({
        [kind]:
          kind === 'permission_overwrites'
            ? [{ channel_id: channel, overwrite_id: role, type: 0, allow: '16' }]
            : [{ id: kind === 'roles' ? targetId : channel, patch: { name: 'after' } }],
      }),
      before,
    },
    container.config.DISCORD_TOKEN,
  );
  const ref = await saveGuildChangePlan(plan, container.config);
  const roles = before.roles
    .filter((item) => condition !== 'missing' || item.id !== role)
    .map((item) => ({
      ...item,
      ...(item.id === botRole ? { permissions } : {}),
      ...(item.id === targetId
        ? {
            name: mode === 'restore' ? 'after' : 'old',
            managed: condition === 'managed',
            position: condition === 'higher' ? 20 : item.position,
          }
        : {}),
    }));
  const channels = [{ id: channel, name: mode === 'restore' ? 'after' : 'old' }];
  let writes = 0;
  container.rest = new REST({
    version: '10',
    retries: 0,
    makeRequest: async (url, init) => {
      const path = decodeURIComponent(new URL(String(url)).pathname);
      if (init?.method === 'PATCH') {
        writes += 1;
        const row = roles.find((item) => path.endsWith(`/roles/${item.id}`));
        const body = JSON.parse(String(init.body)) as { name: string };
        if (row) Object.assign(row, body);
        else Object.assign(channels[0]!, body);
        return Response.json(row ?? channels[0]);
      }
      if (path.endsWith('/users/@me')) return Response.json({ id: bot, bot: true });
      if (path.endsWith(`/guilds/${guild}`)) return Response.json({ id: guild });
      if (path.endsWith('/roles')) return Response.json(roles);
      if (path.endsWith('/channels')) return Response.json(channels);
      if (path.endsWith(`/members/${bot}`)) return Response.json({ roles: [botRole] });
      throw new Error(`Unexpected fixture path: ${path}`);
    },
  }).setToken('fake');
  await saveGuildChangeCheckpoint(
    ref,
    {
      mode: mode === 'restore' && !applied ? 'restore' : 'apply',
      completed: applied ? [0] : [],
      inflight: null,
    },
    container.config,
  );
  const Tool = mode === 'apply' ? Apply : Restore;
  const instance = new Tool(
    { name: `guild_change_${mode}`, path: 'inline', root: 'inline', store: null as never },
    { name: `guild_change_${mode}`, enabled: true },
  );
  const args = {
    guild_id: guild,
    expected_bot_id: bot,
    plan_ref: ref,
    approval_id: plan.approval_id,
    operation_indexes: [0],
  };
  const result = (await instance.run(args, { signal: new AbortController().signal })) as {
    structuredContent: { status: string; blockers?: string[]; blocked?: string[] };
  };
  if (blocker === null) {
    expect(result.structuredContent.status).toBe(mode === 'apply' ? 'complete' : 'completed');
    expect(writes).toBe(1);
  } else {
    expect(result.structuredContent.blockers ?? result.structuredContent.blocked).toContain(
      blocker,
    );
    expect(writes).toBe(0);
  }
  expect((await loadGuildChangeCheckpoint(ref, container.config)).inflight).toBeNull();
});
