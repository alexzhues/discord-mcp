import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import messagesContext from './context.js';
import '../../container.js';

const CHANNEL = '111122223333444401';
const GUILD = '999988887777666601';
const OTHER_GUILD = '999988887777666602';
const DM = '111122223333444402';
const message = (id: string, content: string, extra: Record<string, unknown> = {}) => ({
  id,
  channel_id: CHANNEL,
  content,
  author: { id: '999000999000000001', username: 'author', global_name: 'Author' },
  timestamp: '2026-04-28T12:00:00.000Z',
  edited_timestamp: null,
  ...extra,
});

function tool() {
  return new messagesContext(
    { name: 'messages_context', path: 'inline', root: 'inline', store: null as never },
    { name: 'messages_context', enabled: true },
  );
}

function rest() {
  container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
    'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );
}

describe('messages_context', () => {
  it('reads a bounded 100-message page and returns a resumable older cursor', async () => {
    rest();
    const page = Array.from({ length: 100 }, (_, index) =>
      message(`999000999000${String(100 - index).padStart(6, '0')}`, `message ${index}`),
    );
    server.use(
      http.get(`https://discord.com/api/v10/channels/${CHANNEL}`, () =>
        HttpResponse.json({ id: CHANNEL, guild_id: GUILD, type: 0 }),
      ),
      http.get(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('limit')).toBe('100');
        return HttpResponse.json(page);
      }),
    );
    const result = (await tool().run(
      { channel_id: CHANNEL, limit: 100, pages: 1 },
      { signal: new AbortController().signal },
    )) as { structuredContent: any };
    expect(result.structuredContent.scanned_count).toBe(100);
    expect(result.structuredContent.pages_scanned).toBe(1);
    expect(result.structuredContent.next_cursor).toBe(page.at(-1).id);
    expect(result.structuredContent.coverage.complete).toBe(false);
    expect(result.structuredContent.messages[0].citation.jump_url).toContain(
      `/channels/${GUILD}/${CHANNEL}/`,
    );
  });

  it('continues before and after cursors without claiming the full history', async () => {
    rest();
    server.use(
      http.get(`https://discord.com/api/v10/channels/${CHANNEL}`, () =>
        HttpResponse.json({ id: CHANNEL, guild_id: GUILD, type: 0 }),
      ),
      http.get(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, ({ request }) => {
        const params = new URL(request.url).searchParams;
        if (params.get('before') === '999000999000000010')
          return HttpResponse.json([message('999000999000000009', 'older')]);
        if (params.get('after') === '999000999000000010')
          return HttpResponse.json([message('999000999000000011', 'newer')]);
        return HttpResponse.json([]);
      }),
    );
    const before = (await tool().run(
      { channel_id: CHANNEL, before: '999000999000000010', limit: 10 },
      { signal: new AbortController().signal },
    )) as { structuredContent: any };
    const after = (await tool().run(
      { channel_id: CHANNEL, after: '999000999000000010', limit: 10 },
      { signal: new AbortController().signal },
    )) as { structuredContent: any };
    expect(before.structuredContent.coverage.direction).toBe('older');
    expect(after.structuredContent.coverage.direction).toBe('newer');
    expect(before.structuredContent.coverage.complete).toBe(true);
    expect(after.structuredContent.coverage.complete).toBe(true);
  });

  it('uses Discord guild state for wrong-guild citations and @me for DMs', async () => {
    rest();
    server.use(
      http.get(`https://discord.com/api/v10/channels/${CHANNEL}`, () =>
        HttpResponse.json({ id: CHANNEL, guild_id: GUILD, type: 0 }),
      ),
      http.get(`https://discord.com/api/v10/channels/${DM}`, () =>
        HttpResponse.json({ id: DM, type: 1 }),
      ),
      http.get(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, () =>
        HttpResponse.json([message('999000999000000020', 'guild')]),
      ),
      http.get(`https://discord.com/api/v10/channels/${DM}/messages`, () =>
        HttpResponse.json([{ ...message('999000999000000021', 'dm'), channel_id: DM }]),
      ),
    );
    const wrongGuild = (await tool().run(
      { channel_id: CHANNEL, guild_id: OTHER_GUILD },
      { signal: new AbortController().signal },
    )) as { structuredContent: any };
    const dm = (await tool().run(
      { channel_id: DM, scope: 'thread' },
      { signal: new AbortController().signal },
    )) as { structuredContent: any };
    expect(wrongGuild.structuredContent.messages[0].citation.jump_url).toContain(
      `/channels/${GUILD}/${CHANNEL}/`,
    );
    expect(wrongGuild.structuredContent.coverage.reasons[0]).toContain('does not match');
    expect(dm.structuredContent.messages[0].citation.jump_url).toContain(`/channels/@me/${DM}/`);
    expect(dm.structuredContent.scope.scope).toBe('channel');
  });

  it('uses @me citations for group DMs too', async () => {
    rest();
    server.use(
      http.get(`https://discord.com/api/v10/channels/${DM}`, () =>
        HttpResponse.json({ id: DM, type: 3 }),
      ),
      http.get(`https://discord.com/api/v10/channels/${DM}/messages`, () =>
        HttpResponse.json([{ ...message('999000999000000024', 'group dm'), channel_id: DM }]),
      ),
    );
    const result = (await tool().run(
      { channel_id: DM },
      { signal: new AbortController().signal },
    )) as { structuredContent: any };
    expect(result.structuredContent.messages[0].citation.jump_url).toContain(
      `/channels/@me/${DM}/`,
    );
  });

  it('marks citations unresolved when channel metadata is unavailable', async () => {
    rest();
    server.use(
      http.get(`https://discord.com/api/v10/channels/${CHANNEL}`, () =>
        HttpResponse.json({ message: 'forbidden' }, { status: 403 }),
      ),
      http.get(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, () =>
        HttpResponse.json([message('999000999000000022', 'partial')]),
      ),
    );
    const result = (await tool().run(
      { channel_id: CHANNEL },
      { signal: new AbortController().signal },
    )) as { structuredContent: any };
    expect(result.structuredContent.messages[0].citation).toEqual(
      expect.objectContaining({
        resolved: false,
        reason: expect.stringContaining('metadata'),
      }),
    );
    expect(result.structuredContent.messages[0].citation.jump_url).toBeUndefined();
  });

  it('derives thread scope and rejects forum containers', async () => {
    rest();
    server.use(
      http.get(`https://discord.com/api/v10/channels/${CHANNEL}`, () =>
        HttpResponse.json({ id: CHANNEL, guild_id: GUILD, type: 11 }),
      ),
      http.get(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, () =>
        HttpResponse.json([message('999000999000000023', 'thread')]),
      ),
    );
    const thread = (await tool().run(
      { channel_id: CHANNEL, scope: 'channel' },
      { signal: new AbortController().signal },
    )) as { structuredContent: any };
    expect(thread.structuredContent.scope.scope).toBe('thread');

    server.use(
      http.get(`https://discord.com/api/v10/channels/${CHANNEL}`, () =>
        HttpResponse.json({ id: CHANNEL, guild_id: GUILD, type: 15 }),
      ),
    );
    await expect(
      tool().run({ channel_id: CHANNEL, scope: 'forum' }, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('preserves rich fields, fences untrusted text, and marks unreadable replies partial', async () => {
    rest();
    const rich = message('999000999000000030', '<script>alert(1)</script>', {
      components: [{ type: 10, content: 'component text' }],
      embeds: [{ title: 'embed title' }],
      attachments: [{ id: '999000999000000031', filename: 'file.txt' }],
      message_reference: { message_id: '999000999000000032', channel_id: CHANNEL, guild_id: GUILD },
    });
    server.use(
      http.get(`https://discord.com/api/v10/channels/${CHANNEL}`, () =>
        HttpResponse.json({
          id: CHANNEL,
          guild_id: GUILD,
          type: 11,
          parent_id: '111122223333444499',
        }),
      ),
      http.get(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, () =>
        HttpResponse.json([rich]),
      ),
      http.get(`https://discord.com/api/v10/channels/${CHANNEL}/messages/999000999000000032`, () =>
        HttpResponse.error(),
      ),
    );
    const result = (await tool().run(
      { channel_id: CHANNEL, scope: 'forum', query: 'component' },
      { signal: new AbortController().signal },
    )) as { content: Array<{ text: string }>; structuredContent: any };
    expect(result.structuredContent.scope.parent_channel_id).toBe('111122223333444499');
    expect(result.structuredContent.messages).toHaveLength(1);
    expect(result.structuredContent.messages[0].components).toEqual([
      { type: 10, content: 'component text' },
    ]);
    expect(result.structuredContent.reply_references[0]).toMatchObject({
      resolved: false,
      message_id: '999000999000000032',
    });
    expect(result.structuredContent.coverage.partial).toBe(true);
    expect(result.content[0].text).toContain('<untrusted_discord_messages');
    expect(result.content[0].text).toContain('Citations:');
  });

  it('rejects conflicting cursors and invalid multi-page around reads', async () => {
    const schema = (tool() as any).inputSchema;
    const { z } = await import('zod');
    expect(z.object(schema).safeParse({ channel_id: CHANNEL, limit: 0 }).success).toBe(false);
    await expect(
      tool().run(
        { channel_id: CHANNEL, before: '999000999000000010', after: '999000999000000011' },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      tool().run(
        { channel_id: CHANNEL, around: '999000999000000010', pages: 2 },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
