import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../config.js';
import changeApply from '../change_apply.js';
import changeRestore from '../change_restore.js';
import {
  createGuildChangePlan,
  GuildChangeRequestSchema,
  loadGuildChangeCheckpoint,
  loadGuildChangePlan,
  saveGuildChangeCheckpoint,
  saveGuildChangePlan,
  snapshotDigest,
} from './guild-change.js';

describe('guild change plan contracts', () => {
  it('rejects tampered plan/checkpoint proofs and malformed references', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'guild-change-proof-'));
    const config = loadConfig({
      DISCORD_TOKEN: 'fake'.padEnd(64, 'x'),
      MCP_BLUEPRINT_STATE_DIR: directory,
    });
    try {
      const plan = createGuildChangePlan(
        {
          schema_version: 'guild_change_plan.v1',
          guild_id: '111111111111111111',
          bot_id: '222222222222222222',
          request: 'review',
          changes: GuildChangeRequestSchema.parse({
            channels: [{ id: '333333333333333333', patch: { name: 'new' } }],
          }),
          before: { guild: { id: '111111111111111111' }, bot_roles: [], roles: [], channels: [] },
        },
        'unused',
      );
      const ref = await saveGuildChangePlan(plan, config);
      expect((await loadGuildChangePlan(ref, config)).approval_id).toBe(plan.approval_id);
      await expect(loadGuildChangePlan('../outside', config)).rejects.toThrow(
        'Invalid guild change plan reference',
      );
      const path = join(directory, `${ref.slice(5)}.json`);
      const envelope = JSON.parse(await readFile(path, 'utf8'));
      envelope.plan.guild_id = '444444444444444444';
      await writeFile(path, JSON.stringify(envelope));
      await expect(loadGuildChangePlan(ref, config)).rejects.toThrow('proof is invalid');
      await saveGuildChangeCheckpoint(ref, { completed: [0], inflight: null }, config);
      const checkpointPath = join(directory, `${ref.slice(5)}.checkpoint.json`);
      const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
      checkpoint.auth_tag = '0';
      await writeFile(checkpointPath, JSON.stringify(checkpoint));
      await expect(loadGuildChangeCheckpoint(ref, config)).rejects.toThrow('proof is invalid');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('preserves omitted fields by keeping the typed change surface sparse', () => {
    const changes = GuildChangeRequestSchema.parse({
      channels: [{ id: '111111111111111111', patch: { name: 'chat' } }],
    });
    expect(changes.channels[0]?.patch).toEqual({ name: 'chat' });
    expect(changes.roles).toEqual([]);
    expect(changes.permission_overwrites).toEqual([]);
  });

  it('binds the approval to the exact plan target and changes', () => {
    const input = {
      schema_version: 'guild_change_plan.v1' as const,
      guild_id: '111111111111111111',
      bot_id: '222222222222222222',
      request: 'Rename the public chat',
      changes: GuildChangeRequestSchema.parse({
        channels: [{ id: '333333333333333333', patch: { name: 'chat' } }],
      }),
      before: {
        guild: { id: '111111111111111111' },
        bot_roles: [],
        roles: [],
        channels: [],
      },
    };
    const first = createGuildChangePlan(input, 'secret');
    const second = createGuildChangePlan(input, 'secret');
    expect(first.plan_id).not.toBe(second.plan_id);
    expect(first.approval_id).not.toBe(second.approval_id);
    expect(first.approval_id).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('changes the snapshot digest when live state changes', () => {
    expect(
      snapshotDigest({
        guild: { id: '1' },
        bot_roles: [],
        roles: [],
        channels: [],
      }),
    ).not.toBe(
      snapshotDigest({
        guild: { id: '2' },
        bot_roles: [],
        roles: [],
        channels: [],
      }),
    );
  });

  it('resumes after the first operation succeeds and the second write fails', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'guild-change-test-'));
    const guild = '999000999000999000';
    const bot = '100002088458902020';
    const role = '333344445555666677';
    const channel = '222233334444555566';
    let roleName = 'target';
    let topic = 'old';
    let channelPosition = 3;
    let positionFailures = 1;
    let rolePatches = 0;
    let channelPatches = 0;
    let positionPatches = 0;
    let rolePosition = 1;
    let overwriteAllow = '0';
    let overwriteDeny = '1024';
    let overwriteWrites = 0;
    server.use(
      http.get('*/users/@me', () => HttpResponse.json({ id: bot, bot: true })),
      http.get(`https://discord.com/api/v10/guilds/${guild}`, () =>
        HttpResponse.json({ id: guild, owner_id: '1' }),
      ),
      http.get(`https://discord.com/api/v10/guilds/${guild}/members/${bot}`, () =>
        HttpResponse.json({
          user: { id: bot },
          roles: ['444444444444444444'],
        }),
      ),
      http.get(`https://discord.com/api/v10/guilds/${guild}/roles`, () =>
        HttpResponse.json([
          { id: guild, position: 0, permissions: '0' },
          { id: '444444444444444444', position: 10, permissions: '268435472' },
          { id: role, position: rolePosition, permissions: '0', name: roleName },
        ]),
      ),
      http.get(`https://discord.com/api/v10/guilds/${guild}/channels`, () =>
        HttpResponse.json([
          {
            id: channel,
            guild_id: guild,
            type: 0,
            name: 'chat',
            topic,
            position: channelPosition,
            permission_overwrites: [
              { id: role, type: 0, allow: overwriteAllow, deny: overwriteDeny },
            ],
          },
        ]),
      ),
      http.patch(
        `https://discord.com/api/v10/guilds/${guild}/roles/${role}`,
        async ({ request }) => {
          roleName = String(((await request.json()) as Record<string, unknown>).name);
          rolePatches++;
          return HttpResponse.json({ id: role, name: roleName });
        },
      ),
      http.patch(`*/channels/${channel}`, async ({ request }) => {
        channelPatches++;
        topic = String(((await request.json()) as Record<string, unknown>).topic);
        return HttpResponse.json({ id: channel, topic });
      }),
      http.patch(`https://discord.com/api/v10/guilds/${guild}/channels`, async ({ request }) => {
        positionPatches++;
        if (positionFailures-- > 0)
          return HttpResponse.json({ error: 'temporary' }, { status: 400 });
        const body = (await request.json()) as Array<Record<string, unknown>>;
        channelPosition = Number(body[0]?.position);
        return HttpResponse.json([{ id: channel, position: channelPosition }]);
      }),
      http.put(`*/channels/${channel}/permissions/${role}`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body).toEqual({ type: 0, allow: '2048', deny: '1024' });
        overwriteAllow = String(body.allow);
        overwriteDeny = String(body.deny);
        overwriteWrites += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const previousConfig = container.config;
    container.config = loadConfig({
      DISCORD_TOKEN: 'test-token'.padEnd(64, 'x'),
      MCP_BLUEPRINT_STATE_DIR: stateDir,
    });
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
    try {
      const plan = createGuildChangePlan(
        {
          schema_version: 'guild_change_plan.v1',
          guild_id: guild,
          bot_id: bot,
          request: 'rename and document',
          changes: GuildChangeRequestSchema.parse({
            roles: [{ id: role, patch: { name: 'renamed' } }],
            channels: [{ id: channel, patch: { topic: 'new', position: 5 } }],
            permission_overwrites: [
              { channel_id: channel, overwrite_id: role, type: 0, allow: '2048' },
            ],
          }),
          before: {
            guild: { id: guild, owner_id: '1' },
            bot_roles: ['444444444444444444'],
            roles: [
              { id: guild, position: 0, permissions: '0' },
              {
                id: '444444444444444444',
                position: 10,
                permissions: '268435472',
              },
              { id: role, position: 1, permissions: '0', name: 'target' },
            ],
            channels: [
              {
                id: channel,
                guild_id: guild,
                type: 0,
                name: 'chat',
                topic: 'old',
                position: 3,
                permission_overwrites: [{ id: role, type: 0, allow: '0', deny: '1024' }],
              },
            ],
          },
        },
        'test-token'.padEnd(64, 'x'),
      );
      const ref = await saveGuildChangePlan(plan, container.config);
      const Tool = changeApply;
      const tool = new Tool(
        {
          name: 'guild_change_apply',
          path: 'inline',
          root: 'inline',
          store: null as never,
        },
        { name: 'guild_change_apply', enabled: true },
      );
      rolePosition = 11;
      const drifted = (await tool.run(
        { guild_id: guild, expected_bot_id: bot, plan_ref: ref, approval_id: plan.approval_id },
        { signal: new AbortController().signal },
      )) as { structuredContent: { blockers: string[] } };
      expect(drifted.structuredContent.blockers).toContain('ROLE_HIERARCHY');
      expect(rolePatches + channelPatches + overwriteWrites).toBe(0);
      rolePosition = 1;
      const first = (await tool.run(
        {
          guild_id: guild,
          expected_bot_id: bot,
          plan_ref: ref,
          approval_id: plan.approval_id,
        },
        { signal: new AbortController().signal },
      )) as { structuredContent: { status: string; completed: number[] } };
      expect(first.structuredContent.status).toBe('partial');
      expect(first.structuredContent.completed).toEqual([0]);
      const Restore = changeRestore;
      const restore = new Restore(
        { name: 'guild_change_restore', path: 'inline', root: 'inline', store: null as never },
        { name: 'guild_change_restore', enabled: true },
      );
      const refused = (await restore.run(
        {
          guild_id: guild,
          expected_bot_id: bot,
          plan_ref: ref,
          approval_id: plan.approval_id,
          operation_indexes: [0],
        },
        { signal: new AbortController().signal },
      )) as { structuredContent: { blocked: string[] } };
      expect(refused.structuredContent.blocked).toContain('APPLY_RECONCILIATION_REQUIRED');
      expect((await loadGuildChangeCheckpoint(ref, container.config)).mode).toBe('apply');
      const second = (await tool.run(
        {
          guild_id: guild,
          expected_bot_id: bot,
          plan_ref: ref,
          approval_id: plan.approval_id,
        },
        { signal: new AbortController().signal },
      )) as { structuredContent: { status: string } };
      expect(second.structuredContent.status).toBe('complete');
      expect(rolePatches).toBe(1);
      expect(channelPatches).toBe(1);
      expect(positionPatches).toBe(2);
      expect(roleName).toBe('renamed');
      expect(topic).toBe('new');
      expect(channelPosition).toBe(5);
      expect(overwriteDeny).toBe('1024');
      expect(overwriteWrites).toBe(1);
    } finally {
      container.config = previousConfig;
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('restores only changed fields and re-enters safely after a lost response', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'guild-restore-test-'));
    const guild = '999000999000999000';
    const bot = '100002088458902020';
    const channel = '222233334444555566';
    let name = 'new';
    const topic = 'caller-edit';
    let patches = 0;
    let position = 5;
    let positionFailures = 1;
    let positions = 0;
    server.use(
      http.get('*/users/@me', () => HttpResponse.json({ id: bot, bot: true })),
      http.get(`https://discord.com/api/v10/guilds/${guild}`, () =>
        HttpResponse.json({ id: guild, owner_id: '1' }),
      ),
      http.get(`https://discord.com/api/v10/guilds/${guild}/members/${bot}`, () =>
        HttpResponse.json({ roles: ['444444444444444444'] }),
      ),
      http.get(`https://discord.com/api/v10/guilds/${guild}/roles`, () =>
        HttpResponse.json([
          { id: guild, position: 0, permissions: '0' },
          { id: '444444444444444444', position: 10, permissions: '268435472' },
        ]),
      ),
      http.get(`https://discord.com/api/v10/guilds/${guild}/channels`, () =>
        HttpResponse.json([
          { id: channel, type: 0, name, topic, position, permission_overwrites: [] },
        ]),
      ),
      http.patch(`*/channels/${channel}`, async ({ request }) => {
        patches++;
        const body = (await request.json()) as Record<string, unknown>;
        name = String(body.name ?? name);
        return HttpResponse.json({ id: channel, name, topic });
      }),
      http.patch(`https://discord.com/api/v10/guilds/${guild}/channels`, async ({ request }) => {
        positions += 1;
        if (positionFailures-- > 0)
          return HttpResponse.json({ error: 'temporary' }, { status: 400 });
        const body = (await request.json()) as Array<{ id: string; position: number }>;
        position = body[0]!.position;
        return HttpResponse.json([]);
      }),
    );
    const previousConfig = container.config;
    container.config = loadConfig({
      DISCORD_TOKEN: 'test-token'.padEnd(64, 'x'),
      MCP_BLUEPRINT_STATE_DIR: stateDir,
    });
    container.rest = new REST({ version: '10', makeRequest: fetch, retries: 0 }).setToken(
      'fake-token',
    );
    try {
      const plan = createGuildChangePlan(
        {
          schema_version: 'guild_change_plan.v1',
          guild_id: guild,
          bot_id: bot,
          request: 'rename channel',
          changes: GuildChangeRequestSchema.parse({
            channels: [{ id: channel, patch: { name: 'new', position: 5 } }],
          }),
          before: {
            guild: { id: guild, owner_id: '1' },
            bot_roles: ['444444444444444444'],
            roles: [
              { id: guild, position: 0, permissions: '0' },
              { id: '444444444444444444', position: 10, permissions: '268435472' },
            ],
            channels: [
              {
                id: channel,
                type: 0,
                name: 'old',
                topic: 'old',
                position: 3,
                permission_overwrites: [],
              },
            ],
          },
        },
        'test-token'.padEnd(64, 'x'),
      );
      const ref = await saveGuildChangePlan(plan, container.config);
      await saveGuildChangeCheckpoint(ref, { completed: [0], inflight: null }, container.config);
      const Tool = changeRestore;
      const tool = new Tool(
        { name: 'guild_change_restore', path: 'inline', root: 'inline', store: null as never },
        { name: 'guild_change_restore', enabled: true },
      );
      const restored = (await tool.run(
        {
          guild_id: guild,
          expected_bot_id: bot,
          plan_ref: ref,
          approval_id: plan.approval_id,
          operation_indexes: [0],
        },
        { signal: new AbortController().signal },
      )) as { structuredContent: { restored: number[] } };
      expect(restored.structuredContent.restored).toEqual([]);
      expect(patches).toBe(1);
      expect(name).toBe('old');
      expect(position).toBe(5);
      const resumed = (await tool.run(
        {
          guild_id: guild,
          expected_bot_id: bot,
          plan_ref: ref,
          approval_id: plan.approval_id,
          operation_indexes: [0],
        },
        { signal: new AbortController().signal },
      )) as { structuredContent: { restored: number[] } };
      expect(resumed.structuredContent.restored).toEqual([0]);
      expect(patches).toBe(1);
      expect(positions).toBe(2);
      expect(position).toBe(3);
      const ApplyTool = changeApply;
      const applyTool = new ApplyTool(
        { name: 'guild_change_apply', path: 'inline', root: 'inline', store: null as never },
        { name: 'guild_change_apply', enabled: true },
      );
      const reapplied = (await applyTool.run(
        { guild_id: guild, expected_bot_id: bot, plan_ref: ref, approval_id: plan.approval_id },
        { signal: new AbortController().signal },
      )) as { structuredContent: { status: string; blockers: string[] } };
      expect(reapplied.structuredContent.status).toBe('blocked');
      expect(reapplied.structuredContent.blockers).toContain('PLAN_RESTORE_MODE');
      expect(patches).toBe(1);
      await saveGuildChangeCheckpoint(
        ref,
        { mode: 'restore', completed: [], inflight: 0 },
        container.config,
      );
      const reentered = (await tool.run(
        {
          guild_id: guild,
          expected_bot_id: bot,
          plan_ref: ref,
          approval_id: plan.approval_id,
          operation_indexes: [0],
        },
        { signal: new AbortController().signal },
      )) as { structuredContent: { restored: number[] } };
      expect(reentered.structuredContent.restored).toEqual([0]);
      expect(patches).toBe(1);
      await saveGuildChangeCheckpoint(
        ref,
        { mode: 'restore', completed: [0], inflight: null },
        container.config,
      );
      name = 'external';
      const blocked = (await tool.run(
        {
          guild_id: guild,
          expected_bot_id: bot,
          plan_ref: ref,
          approval_id: plan.approval_id,
          operation_indexes: [0],
        },
        { signal: new AbortController().signal },
      )) as { structuredContent: { blocked: string[] } };
      expect(blocked.structuredContent.blocked).toContain('OPERATION_0_EXTERNAL_DRIFT');
      expect(patches).toBe(1);
      expect(topic).toBe('caller-edit');
    } finally {
      container.config = previousConfig;
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
