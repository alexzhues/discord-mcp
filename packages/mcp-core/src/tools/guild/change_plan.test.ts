import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../config.js';
import changePlan from './change_plan.js';

const API = 'https://discord.com/api/v10';
const GUILD = '111111111111111111';
const BOT = '100002088458902020';
const BOT_ROLE = '333333333333333333';
const EDITABLE_ROLE = '444444444444444444';
const MANAGED_ROLE = '555555555555555555';
const HIGH_ROLE = '666666666666666666';
const CHANNEL = '777777777777777777';
const CATEGORY = '888888888888888888';
type PlanResult = {
  structuredContent: {
    status: string;
    plan_ref: string | null;
    approval_id: string | null;
    blockers: Array<{ code: string }>;
    operations: Array<Record<string, unknown>>;
  };
};

function tool() {
  return new changePlan(
    { name: 'guild_change_plan', path: 'inline', root: 'inline', store: null as never },
    { name: 'guild_change_plan', enabled: true },
  );
}

const guild = { id: GUILD, name: 'Test guild' };
const bot = { id: BOT, user: { id: BOT }, roles: [BOT_ROLE] };
const roles = [
  { id: GUILD, position: 0, permissions: '0', name: '@everyone' },
  { id: BOT_ROLE, position: 10, permissions: '268435472', name: 'bot' },
  { id: EDITABLE_ROLE, position: 1, permissions: '0', name: 'member' },
  { id: MANAGED_ROLE, position: 2, permissions: '0', name: 'managed', managed: true },
  { id: HIGH_ROLE, position: 11, permissions: '0', name: 'higher' },
];
const channels = [
  { id: CATEGORY, type: 4, name: 'category', permission_overwrites: [] },
  { id: CHANNEL, type: 0, name: 'general', topic: null, permission_overwrites: [] },
];

function installDiscordFixture(botPermissions = '268435472') {
  const fixtureRoles = roles.map((role) =>
    role.id === BOT_ROLE ? { ...role, permissions: botPermissions } : role,
  );
  server.use(
    http.get('*/users/@me', () => HttpResponse.json({ id: BOT, bot: true, username: 'test-bot' })),
    http.get(`${API}/guilds/${GUILD}`, () => HttpResponse.json(guild)),
    http.get(`${API}/guilds/${GUILD}/members/${BOT}`, () => HttpResponse.json(bot)),
    http.get(`${API}/guilds/${GUILD}/roles`, () => HttpResponse.json(fixtureRoles)),
    http.get(`${API}/guilds/${GUILD}/channels`, () => HttpResponse.json(channels)),
  );
}

async function runPlan(changes: Record<string, unknown>, botPermissions = '268435472') {
  const stateDir = await mkdtemp(join(tmpdir(), 'discord-mcp-change-plan-'));
  const previousConfig = container.config;
  const previousRest = container.rest;
  container.config = loadConfig({
    DISCORD_TOKEN: 'test.discord.token.'.padEnd(64, 'x'),
    MCP_BLUEPRINT_STATE_DIR: stateDir,
  });
  container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
  installDiscordFixture(botPermissions);
  try {
    return (await tool().run(
      { guild_id: GUILD, expected_bot_id: BOT, request: 'Review bounded guild changes', changes },
      { signal: new AbortController().signal },
    )) as PlanResult;
  } finally {
    container.config = previousConfig;
    container.rest = previousRest;
    await rm(stateDir, { recursive: true, force: true });
  }
}

describe('guild_change_plan handler', () => {
  it('creates a ready plan with typed channel, role, and overwrite before/after projections', async () => {
    const result = await runPlan({
      channels: [{ id: CHANNEL, patch: { name: 'support', parent_id: CATEGORY } }],
      roles: [{ id: EDITABLE_ROLE, patch: { name: 'support-team' } }],
      permission_overwrites: [
        { channel_id: CHANNEL, overwrite_id: EDITABLE_ROLE, type: 0, allow: '2048', deny: '0' },
      ],
    });
    expect(result.structuredContent.status).toBe('ready');
    expect(result.structuredContent.plan_ref).toMatch(/^gcp1\.[a-f0-9]{64}$/);
    expect(result.structuredContent.approval_id).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.structuredContent.blockers).toEqual([]);
    expect(result.structuredContent.operations).toHaveLength(3);
    expect(result.structuredContent.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'channel_patch',
          before: expect.objectContaining({ name: 'general' }),
          after: expect.objectContaining({ name: 'support' }),
        }),
        expect.objectContaining({
          kind: 'role_patch',
          before: expect.objectContaining({ name: 'member' }),
          after: expect.objectContaining({ name: 'support-team' }),
        }),
        expect.objectContaining({
          kind: 'permission_overwrite',
          before: null,
          after: expect.objectContaining({ allow: '2048' }),
        }),
      ]),
    );
  });

  it('blocks role, channel, and overwrite requests outside the bot permission scope', async () => {
    const result = await runPlan(
      {
        channels: [{ id: CHANNEL, patch: { topic: 'restricted' } }],
        roles: [{ id: EDITABLE_ROLE, patch: { permissions: '268435456' } }],
        permission_overwrites: [
          { channel_id: CHANNEL, overwrite_id: EDITABLE_ROLE, type: 0, allow: '2048' },
        ],
      },
      '0',
    );
    expect(result.structuredContent.status).toBe('blocked');
    expect(result.structuredContent.blockers.map((item) => item.code)).toEqual(
      expect.arrayContaining(['BOT_MANAGE_CHANNELS', 'ROLE_PERMISSION_SCOPE', 'BOT_MANAGE_ROLES']),
    );
  });

  it.each([
    ['managed role', [{ id: MANAGED_ROLE, patch: { name: 'nope' } }], 'MANAGED_ROLE'],
    ['higher role', [{ id: HIGH_ROLE, patch: { name: 'nope' } }], 'ROLE_HIERARCHY'],
    ['everyone role', [{ id: GUILD, patch: { name: 'everyone-renamed' } }], 'EVERYONE_ROLE_LIMIT'],
  ])('blocks %s edits', async (_label, rolesChange, code) => {
    const result = await runPlan({ channels: [], roles: rolesChange, permission_overwrites: [] });
    expect(result.structuredContent.status).toBe('blocked');
    expect(result.structuredContent.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code })]),
    );
  });

  it.each([
    [
      'missing channel',
      [{ id: '999999999999999999', patch: { name: 'nope' } }],
      'CHANNEL_NOT_FOUND',
    ],
    ['missing role', [{ id: '999999999999999998', patch: { name: 'nope' } }], 'ROLE_NOT_FOUND'],
  ])('blocks a %s', async (_label, channelChanges, code) => {
    const result = await runPlan(
      code === 'ROLE_NOT_FOUND'
        ? { channels: [], roles: channelChanges, permission_overwrites: [] }
        : { channels: channelChanges, roles: [], permission_overwrites: [] },
    );
    expect(result.structuredContent.status).toBe('blocked');
    expect(result.structuredContent.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code })]),
    );
  });

  it('blocks a missing or non-category requested parent', async () => {
    const result = await runPlan({
      channels: [{ id: CHANNEL, patch: { parent_id: '999999999999999999' } }],
      roles: [],
      permission_overwrites: [],
    });
    expect(result.structuredContent.status).toBe('blocked');
    expect(result.structuredContent.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PARENT_NOT_FOUND' })]),
    );
  });

  it('blocks a parent cycle and a missing role overwrite target', async () => {
    const cycle = await runPlan({
      channels: [
        { id: CHANNEL, patch: { parent_id: CATEGORY } },
        { id: CATEGORY, patch: { parent_id: CHANNEL } },
      ],
      roles: [],
      permission_overwrites: [],
    });
    expect(cycle.structuredContent.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PARENT_CYCLE' })]),
    );
    const missing = await runPlan({
      channels: [],
      roles: [],
      permission_overwrites: [
        { channel_id: CHANNEL, overwrite_id: '999999999999999999', type: 0, allow: '2048' },
      ],
    });
    expect(missing.structuredContent.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'ROLE_NOT_FOUND' })]),
    );
  });

  it('projects an existing permission overwrite before and after values', async () => {
    const original = channels[1]!.permission_overwrites;
    channels[1]!.permission_overwrites = [{ id: EDITABLE_ROLE, type: 0, allow: '0', deny: '1024' }];
    try {
      const result = await runPlan({
        channels: [],
        roles: [],
        permission_overwrites: [
          { channel_id: CHANNEL, overwrite_id: EDITABLE_ROLE, type: 0, allow: '2048' },
        ],
      });
      expect(result.structuredContent.operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'permission_overwrite',
            before: expect.objectContaining({ deny: '1024' }),
            after: expect.objectContaining({ allow: '2048' }),
          }),
        ]),
      );
    } finally {
      channels[1]!.permission_overwrites = original;
    }
  });
});
