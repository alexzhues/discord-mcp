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
  saveGuildChangePlan,
} from './_lib/guild-change.js';
import apply from './change_apply.js';

const guild = '111111111111111111';
const bot = '222222222222222222';
const role = '333333333333333333';
const botRole = '444444444444444444';
const channel = '555555555555555555';
let directory: string;
let previousConfig: typeof container.config;
let previousRest: typeof container.rest;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'guild-apply-safety-'));
  previousConfig = container.config;
  previousRest = container.rest;
  container.config = loadConfig({
    DISCORD_TOKEN: 'fake'.padEnd(64, 'x'),
    MCP_BLUEPRINT_STATE_DIR: directory,
  });
  container.rest = new REST({ version: '10', makeRequest: fetch, retries: 0 }).setToken('fake');
});
afterEach(async () => {
  container.config = previousConfig;
  container.rest = previousRest;
  await rm(directory, { recursive: true, force: true });
});

it.each([
  ['lost role management', '0', { name: 'new' }, false, true, false, false, 'BOT_MANAGE_ROLES'],
  ['managed role', '268435472', { name: 'new' }, true, true, false, false, 'MANAGED_ROLE'],
  ['missing role', '268435472', { name: 'new' }, false, false, false, false, 'ROLE_NOT_FOUND'],
  [
    'permission grant outside bot scope',
    '268435472',
    { permissions: '4' },
    false,
    true,
    false,
    false,
    'ROLE_PERMISSION_SCOPE',
  ],
  ['cancelled before effect', '268435472', { name: 'new' }, false, true, false, true, 'CANCELLED'],
  [
    'unacknowledged readback',
    '268435472',
    { name: 'new' },
    false,
    true,
    false,
    false,
    'OPERATION_0_READBACK_MISMATCH',
  ],
  [
    'external drift',
    '268435472',
    { name: 'new' },
    false,
    true,
    true,
    false,
    'OPERATION_0_EXTERNAL_DRIFT',
  ],
] as const)('blocks %s without advancing its checkpoint', async (_label, permissions, patch, managed, present, drift, aborted, blocker) => {
  const roles = [
    { id: guild, position: 0, permissions: '0' },
    { id: botRole, position: 10, permissions },
    ...(present
      ? [{ id: role, position: 1, name: drift ? 'external' : 'old', permissions: '0', managed }]
      : []),
  ];
  let writes = 0;
  container.rest = new REST({
    version: '10',
    retries: 0,
    makeRequest: async (url, init) => {
      const path = decodeURIComponent(new URL(String(url)).pathname);
      if (init?.method === 'PATCH') {
        writes += 1;
        // A 2xx response without the expected state must remain uncertain.
        return Response.json({});
      }
      if (path.endsWith('/users/@me')) return Response.json({ id: bot, bot: true });
      if (path.endsWith(`/guilds/${guild}`)) return Response.json({ id: guild });
      if (path.endsWith('/roles')) return Response.json(roles);
      if (path.endsWith('/channels')) return Response.json([{ id: channel, name: 'general' }]);
      if (path.endsWith(`/members/${bot}`)) return Response.json({ roles: [botRole] });
      throw new Error(`Unexpected fixture path: ${path}`);
    },
  }).setToken('fake');
  const plan = createGuildChangePlan(
    {
      schema_version: 'guild_change_plan.v1',
      guild_id: guild,
      bot_id: bot,
      request: 'review',
      changes: GuildChangeRequestSchema.parse({ roles: [{ id: role, patch }] }),
      before: {
        guild: { id: guild },
        bot_roles: [botRole],
        roles: [{ id: role, position: 1, name: 'old', permissions: '0' }],
        channels: [],
      },
    },
    'unused',
  );
  const ref = await saveGuildChangePlan(plan, container.config);
  const Tool = apply;
  const tool = new Tool(
    { name: 'guild_change_apply', path: 'inline', root: 'inline', store: null as never },
    { name: 'guild_change_apply', enabled: true },
  );
  const controller = new AbortController();
  if (aborted) controller.abort();
  const result = await tool.run(
    { guild_id: guild, expected_bot_id: bot, plan_ref: ref, approval_id: plan.approval_id },
    { signal: controller.signal },
  );
  expect(
    (result as { structuredContent: { blockers: string[] } }).structuredContent.blockers,
  ).toContain(blocker);
  expect(writes).toBe(blocker === 'OPERATION_0_READBACK_MISMATCH' ? 1 : 0);
  const checkpoint = await loadGuildChangeCheckpoint(ref, container.config);
  expect(checkpoint.completed).toEqual([]);
  expect(checkpoint.inflight).toBe(blocker === 'OPERATION_0_READBACK_MISMATCH' ? 0 : null);
});
