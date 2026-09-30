import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import memberAccessReport from './member_access_report.js';
import '../../container.js';

const API = 'https://discord.com/api/v10';
const GUILD = '999000999000999000';
const USER = '111122223333444455';
const ROLE = '333344445555666677';
const CHANNEL = '222233334444555566';

function run(args: Record<string, unknown>) {
  container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
  const Tool = memberAccessReport;
  const tool = new Tool(
    {
      name: 'permissions_member_access_report',
      path: 'inline',
      root: 'inline',
      store: null as never,
    },
    { name: 'permissions_member_access_report', enabled: true },
  );
  return tool.run(args, { signal: new AbortController().signal }) as Promise<{
    structuredContent: Record<string, unknown>;
  }>;
}

describe('permissions_member_access_report', () => {
  it('marks missing roles and truncated selection incomplete instead of guessing', async () => {
    server.use(
      http.get(`${API}/guilds/${GUILD}`, () => HttpResponse.json({ id: GUILD, owner_id: '1' })),
      http.get(`${API}/guilds/${GUILD}/members/${USER}`, () =>
        HttpResponse.json({ roles: [ROLE, '333344445555666688'] }),
      ),
      http.get(`${API}/guilds/${GUILD}/roles`, () =>
        HttpResponse.json([
          { id: GUILD, position: 0, permissions: '0' },
          { id: ROLE, position: 1, permissions: '0' },
        ]),
      ),
      http.get(`${API}/guilds/${GUILD}/channels`, () =>
        HttpResponse.json([{ id: CHANNEL, name: 'chat', type: 0, permission_overwrites: [] }]),
      ),
    );
    const result = await run({ guild_id: GUILD, user_id: USER });
    expect(result.structuredContent.complete).toBe(false);
    expect((result.structuredContent.channels as Array<Record<string, unknown>>)[0]?.view).toBe(
      'unknown',
    );
    expect(result.structuredContent.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Missing role IDs')]),
    );
  });

  it('applies member overwrite while keeping send independent of history access', async () => {
    server.use(
      http.get(`${API}/guilds/${GUILD}`, () => HttpResponse.json({ id: GUILD, owner_id: '1' })),
      http.get(`${API}/guilds/${GUILD}/members/${USER}`, () =>
        HttpResponse.json({ roles: [ROLE] }),
      ),
      http.get(`${API}/guilds/${GUILD}/roles`, () =>
        HttpResponse.json([
          { id: GUILD, position: 0, permissions: '0' },
          { id: ROLE, position: 1, permissions: '0' },
        ]),
      ),
      http.get(`${API}/guilds/${GUILD}/channels`, () =>
        HttpResponse.json([
          {
            id: CHANNEL,
            name: 'chat',
            type: 0,
            permission_overwrites: [
              { id: GUILD, type: 0, allow: '68608', deny: '0' },
              { id: USER, type: 1, allow: '0', deny: '65536' },
            ],
          },
        ]),
      ),
    );
    const result = await run({
      guild_id: GUILD,
      user_id: USER,
      channel_ids: [CHANNEL],
    });
    const channel = (result.structuredContent.channels as Array<Record<string, unknown>>)[0]!;
    expect(channel.view).toBe('allowed');
    expect(channel.send).toBe('allowed');
    expect(channel.reason).toContain('Resolved');
  });

  it('reports timed-out members as read-only', async () => {
    server.use(
      http.get(`${API}/guilds/${GUILD}`, () => HttpResponse.json({ id: GUILD, owner_id: '1' })),
      http.get(`${API}/guilds/${GUILD}/members/${USER}`, () =>
        HttpResponse.json({
          roles: [ROLE],
          communication_disabled_until: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
      http.get(`${API}/guilds/${GUILD}/roles`, () =>
        HttpResponse.json([
          { id: GUILD, position: 0, permissions: '0' },
          { id: ROLE, position: 1, permissions: '0' },
        ]),
      ),
      http.get(`${API}/guilds/${GUILD}/channels`, () =>
        HttpResponse.json([
          {
            id: CHANNEL,
            name: 'chat',
            type: 0,
            permission_overwrites: [{ id: GUILD, type: 0, allow: '68608', deny: '0' }],
          },
        ]),
      ),
    );
    const result = await run({
      guild_id: GUILD,
      user_id: USER,
      channel_ids: [CHANNEL],
    });
    const channel = (result.structuredContent.channels as Array<Record<string, unknown>>)[0]!;
    expect(channel.view).toBe('allowed');
    expect(channel.send).toBe('denied');
    expect(channel.manage).toBe('denied');
  });

  it('reports incomplete overwrites and ambiguous threads as unknown', async () => {
    server.use(
      http.get(`${API}/guilds/${GUILD}`, () => HttpResponse.json({ id: GUILD, owner_id: '1' })),
      http.get(`${API}/guilds/${GUILD}/members/${USER}`, () =>
        HttpResponse.json({ roles: [ROLE] }),
      ),
      http.get(`${API}/guilds/${GUILD}/roles`, () =>
        HttpResponse.json([
          { id: GUILD, position: 0, permissions: '0' },
          { id: ROLE, position: 1, permissions: '0' },
        ]),
      ),
      http.get(`${API}/guilds/${GUILD}/channels`, () =>
        HttpResponse.json([
          { id: CHANNEL, name: 'chat', type: 0 },
          { id: '222233334444555567', name: 'thread', type: 11, permission_overwrites: [] },
        ]),
      ),
    );
    const result = await run({
      guild_id: GUILD,
      user_id: USER,
      channel_ids: [CHANNEL, '222233334444555567'],
    });
    const channels = result.structuredContent.channels as Array<Record<string, unknown>>;
    expect(channels[0]?.view).toBe('unknown');
    expect(channels[1]?.view).toBe('unknown');
  });

  it('applies owner and administrator bypasses', async () => {
    server.use(
      http.get(`${API}/guilds/${GUILD}`, () => HttpResponse.json({ id: GUILD, owner_id: USER })),
      http.get(`${API}/guilds/${GUILD}/members/${USER}`, () =>
        HttpResponse.json({ roles: [ROLE] }),
      ),
      http.get(`${API}/guilds/${GUILD}/roles`, () =>
        HttpResponse.json([
          { id: GUILD, position: 0, permissions: '0' },
          { id: ROLE, position: 1, permissions: '8' },
        ]),
      ),
      http.get(`${API}/guilds/${GUILD}/channels`, () =>
        HttpResponse.json([{ id: CHANNEL, name: 'chat', type: 0, permission_overwrites: [] }]),
      ),
    );
    const result = await run({ guild_id: GUILD, user_id: USER, channel_ids: [CHANNEL] });
    const channel = (result.structuredContent.channels as Array<Record<string, unknown>>)[0]!;
    expect(channel.view).toBe('allowed');
    expect(channel.manage).toBe('allowed');
    expect(channel.reason).toContain('owner');
  });
});
