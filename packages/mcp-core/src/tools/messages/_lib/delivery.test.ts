import { HTTPError, type REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../container.js';
import { loadConfig } from '../../../config.js';
import { createLogger } from '../../../logger.js';
import messagesCompose from '../compose.js';
import { publishMessage, updateMessage } from './delivery.js';

const CHANNEL = '112233445566778899';
const GUILD = '112233445566778800';
const BOT = '112233445566778801';
const MESSAGE = '112233445566778802';
const OLD_FILE = '112233445566778803';
const NEW_FILE = '112233445566778804';
const signal = new AbortController().signal;
const newFile = {
  filename: 'rules.txt',
  data_uri: 'data:text/plain;base64,aGVsbG8=',
  description: 'Tournament rules',
};

describe('composer delivery and preservation', () => {
  let stored: Map<string, Record<string, unknown>>;
  let post: ReturnType<typeof vi.fn>;
  let patch: ReturnType<typeof vi.fn>;
  let get: ReturnType<typeof vi.fn>;
  let nextId: bigint;

  function message(body: Record<string, unknown> = {}, id = MESSAGE) {
    return {
      id,
      channel_id: CHANNEL,
      guild_id: GUILD,
      author: { id: BOT, username: 'test-bot' },
      timestamp: '2026-10-01T00:00:00.000Z',
      edited_timestamp: null,
      content: '',
      embeds: [],
      components: [],
      attachments: [],
      flags: 0,
      tts: false,
      ...body,
    };
  }

  function uploaded(
    options: { body: Record<string, unknown>; files?: Array<{ name: string; data: Buffer }> },
    old: Record<string, unknown>,
  ) {
    const attachments = (
      options.body.attachments as
        | Array<{ id: string; filename: string; description?: string }>
        | undefined
    )?.map((file) => {
      const upload = options.files?.find((item) => item.name === file.filename);
      if (file.id.length > 10)
        return (old.attachments as Array<{ id: string }>).find((item) => item.id === file.id);
      return {
        ...file,
        id: NEW_FILE,
        size: upload?.data.length ?? 0,
        url: `https://cdn.example.test/${file.filename}`,
      };
    });
    const result = {
      ...old,
      ...options.body,
      ...(attachments === undefined ? {} : { attachments }),
    };
    if (result.poll !== undefined) {
      const { duration: _duration, ...poll } = result.poll as Record<string, unknown>;
      result.poll = { ...poll, answers: poll.answers };
    }
    return result;
  }

  beforeEach(() => {
    stored = new Map();
    nextId = BigInt(MESSAGE);
    post = vi.fn(async (_route: string, options: Parameters<typeof uploaded>[0]) => {
      const id = String(nextId++);
      const result = uploaded(options, message({}, id));
      stored.set(id, result);
      return result;
    });
    patch = vi.fn(async (route: string, options: Parameters<typeof uploaded>[0]) => {
      const id = route.split('/').at(-1)!;
      const result = uploaded(options, stored.get(id)!);
      result.edited_timestamp = '2026-10-01T01:00:00.000Z';
      stored.set(id, result);
      return result;
    });
    get = vi.fn(async (route: string) => {
      if (route === Routes.user('@me')) return { id: BOT, bot: true };
      return stored.get(route.split('/').at(-1)!);
    });
    container.rest = { get, post, patch } as unknown as REST;
    container.config = loadConfig({
      DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      LOG_LEVEL: 'fatal',
    });
    container.logger = createLogger(container.config);
  });

  it('composes a real draft without contacting Discord or echoing upload bytes', async () => {
    const tool = new messagesCompose(
      { name: 'messages_compose', path: 'inline', root: 'inline', store: null as never },
      { name: 'messages_compose', enabled: true },
    );
    const result = await tool.run({ content: 'Tournament', files: [newFile] }, { signal });
    expect(JSON.stringify(result)).toContain('rules.txt');
    expect(JSON.stringify(result)).not.toContain(newFile.data_uri);
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('publishes content, embed, poll and real bytes in one classic part with independent readback', async () => {
    const result = await publishMessage(
      {
        channel_id: CHANNEL,
        content: 'Tournament',
        embeds: [{ title: 'Schedule' }],
        poll: {
          question: { text: 'Which day?' },
          answers: [{ poll_media: { text: 'Saturday' } }, { poll_media: { text: 'Sunday' } }],
        },
        files: [newFile],
      },
      signal,
    );
    expect(result).toMatchObject({
      status: 'complete',
      sent_count: 1,
      requested_count: 1,
      receipts: [{ verification: 'verified' }],
    });
    expect(post.mock.calls[0]![1].files[0]).toMatchObject({
      key: 'files[0]',
      name: 'rules.txt',
      contentType: 'text/plain',
      data: Buffer.from('hello'),
    });
    expect(post.mock.calls[0]![1].body.allowed_mentions).toEqual({ parse: [] });
    expect(get).toHaveBeenCalledWith(`/channels/${CHANNEL}/messages/${MESSAGE}`, { signal });
    expect(result.receipts[0]!.jump_url).toBe(
      `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
    );
  });

  it('splits mixed V2 and classic drafts into ordered legal requests', async () => {
    const result = await publishMessage(
      {
        channel_id: CHANNEL,
        content: 'Announcement',
        components: [{ type: 10, content: 'Rich card' }],
      },
      signal,
    );
    expect(result.status).toBe('complete');
    expect(result.sent_count).toBe(2);
    expect(post.mock.calls[0]![1].body).toMatchObject({ content: 'Announcement' });
    expect(post.mock.calls[1]![1].body).toMatchObject({
      flags: 32768,
      components: [{ type: 10, content: 'Rich card' }],
    });
    expect(post.mock.calls[1]![1].body).not.toHaveProperty('content');
  });

  it('retains receipts and stops after a later write fails', async () => {
    post
      .mockImplementationOnce(async (_route, options) => {
        const result = uploaded(options, message());
        stored.set(MESSAGE, result);
        return result;
      })
      .mockRejectedValueOnce(new Error('connection lost'));
    const result = await publishMessage(
      {
        channel_id: CHANNEL,
        content: 'Announcement',
        components: [{ type: 10, content: 'Rich card' }],
      },
      signal,
    );
    expect(result).toMatchObject({
      status: 'partial',
      sent_count: 1,
      requested_count: 2,
      failed_part: 2,
      failed_part_outcome: 'unknown',
      receipts: [{ message_id: MESSAGE }],
    });
    expect(result.next_action).toContain('Do not resend');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('reports failed readback as unverified without retrying a successful send', async () => {
    get.mockRejectedValue(new Error('readback unavailable'));
    const result = await publishMessage({ channel_id: CHANNEL, content: 'Announcement' }, signal);
    expect(result).toMatchObject({
      status: 'unverified',
      sent_count: 1,
      receipts: [{ message_id: MESSAGE, verification: 'unavailable' }],
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each([
    [403, 'rejected'],
    [502, 'unknown'],
  ])('keeps an HTTP %s outcome as %s without automatically retrying', async (status, outcome) => {
    post.mockRejectedValue(
      new HTTPError(status as number, 'Failure', 'POST', 'https://discord.com/api/v10/test', {
        files: undefined,
        json: undefined,
      }),
    );
    const result = await publishMessage({ channel_id: CHANNEL, content: 'Announcement' }, signal);
    expect(result).toMatchObject({
      status: 'partial',
      sent_count: 0,
      failed_part: 1,
      failed_part_outcome: outcome,
      receipts: [],
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('verifies an attachment reference after Discord replaces it with a CDN URL', async () => {
    post.mockImplementation(async (_route, options) => {
      const result = uploaded(options, message());
      result.embeds = [{ image: { url: 'https://cdn.example.test/rules.txt' } }];
      stored.set(MESSAGE, result);
      return result;
    });
    const result = await publishMessage(
      {
        channel_id: CHANNEL,
        embeds: [{ image: { url: 'attachment://rules.txt' } }],
        files: [newFile],
      },
      signal,
    );
    expect(result.status).toBe('complete');
    expect(result.receipts[0]!.verification).toBe('verified');
  });

  it('reports content mismatch independently from successful publication', async () => {
    get.mockImplementation(async () => message({ content: 'different' }));
    const result = await publishMessage({ channel_id: CHANNEL, content: 'Announcement' }, signal);
    expect(result).toMatchObject({
      status: 'unverified',
      receipts: [{ verification: 'mismatch', mismatch_fields: ['content'] }],
    });
  });

  it('updates text while keeping omitted embeds and attachments', async () => {
    stored.set(
      MESSAGE,
      message({
        content: 'old',
        embeds: [{ title: 'Keep me' }],
        attachments: [
          {
            id: OLD_FILE,
            filename: 'poster.png',
            size: 12,
            url: 'https://cdn.example.test/poster.png',
          },
        ],
      }),
    );
    const result = await updateMessage(
      { channel_id: CHANNEL, message_id: MESSAGE, content: 'new' },
      signal,
    );
    expect(result.status).toBe('complete');
    expect(patch.mock.calls[0]![1].body).not.toHaveProperty('embeds');
    expect(patch.mock.calls[0]![1].body).not.toHaveProperty('attachments');
    expect(stored.get(MESSAGE)).toMatchObject({
      content: 'new',
      embeds: [{ title: 'Keep me' }],
      attachments: [{ id: OLD_FILE }],
    });
    expect(patch.mock.calls[0]![1].body.allowed_mentions).toEqual({ parse: [] });
  });

  it('reads first and retains all old files when appending a multipart upload', async () => {
    stored.set(
      MESSAGE,
      message({
        content: 'keep',
        attachments: [
          {
            id: OLD_FILE,
            filename: 'poster.png',
            size: 12,
            url: 'https://cdn.example.test/poster.png',
            description: 'Poster',
          },
        ],
      }),
    );
    const result = await updateMessage(
      { channel_id: CHANNEL, message_id: MESSAGE, files: [newFile] },
      signal,
    );
    expect(result.status).toBe('complete');
    expect(patch.mock.calls[0]![1].body.attachments).toEqual([
      { id: OLD_FILE, filename: 'poster.png', description: 'Poster' },
      { id: '0', filename: 'rules.txt', description: 'Tournament rules' },
    ]);
    expect(stored.get(MESSAGE)).toMatchObject({
      content: 'keep',
      attachments: [{ id: OLD_FILE }, { id: NEW_FILE }],
    });
    expect(get.mock.invocationCallOrder[0]).toBeLessThan(patch.mock.invocationCallOrder[0]!);
  });

  it('rejects a hidden signed Discord CDN reference before appending files', async () => {
    stored.set(
      MESSAGE,
      message({
        embeds: [
          {
            image: {
              url: `https://cdn.discordapp.com/attachments/${CHANNEL}/999999999999999999/old.png?ex=abc&is=def&hm=123`,
            },
          },
        ],
      }),
    );
    await expect(
      updateMessage({ channel_id: CHANNEL, message_id: MESSAGE, files: [newFile] }, signal),
    ).rejects.toMatchObject({
      issues: [{ message: expect.stringContaining('absent from the attachment list') }],
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it.each([
    `https://media.discordapp.net/attachments/${CHANNEL}/999999999999999999/card.png?ex=abc`,
    'attachment://card.png',
  ])('rejects an unlisted media reference nested in a V2 component: %s', async (url) => {
    stored.set(
      MESSAGE,
      message({
        flags: 32768,
        components: [
          {
            type: 11,
            media: { url },
          },
        ],
      }),
    );
    await expect(
      updateMessage({ channel_id: CHANNEL, message_id: MESSAGE, files: [newFile] }, signal),
    ).rejects.toMatchObject({
      issues: [{ message: expect.stringContaining('absent from the attachment list') }],
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it('retains a listed Discord CDN reference while appending a file', async () => {
    stored.set(
      MESSAGE,
      message({
        embeds: [
          {
            image: {
              url: `https://cdn.discordapp.com/attachments/${CHANNEL}/${OLD_FILE}/poster.png?ex=abc`,
            },
          },
        ],
        attachments: [
          {
            id: OLD_FILE,
            filename: 'poster.png',
            size: 12,
            url: `https://cdn.discordapp.com/attachments/${CHANNEL}/${OLD_FILE}/poster.png`,
          },
        ],
      }),
    );
    const result = await updateMessage(
      { channel_id: CHANNEL, message_id: MESSAGE, files: [newFile] },
      signal,
    );
    expect(result.status).toBe('complete');
    expect(patch.mock.calls[0]![1].body.attachments).toEqual([
      { id: OLD_FILE, filename: 'poster.png' },
      { id: '0', filename: 'rules.txt', description: 'Tournament rules' },
    ]);
  });

  it('allows external HTTP media while appending a file', async () => {
    stored.set(
      MESSAGE,
      message({ embeds: [{ image: { url: 'https://images.example.test/poster.png' } }] }),
    );
    const result = await updateMessage(
      { channel_id: CHANNEL, message_id: MESSAGE, files: [newFile] },
      signal,
    );
    expect(result.status).toBe('complete');
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('reports an uploaded file omitted from readback as unverified', async () => {
    stored.set(MESSAGE, message());
    patch.mockResolvedValue(message({ attachments: [] }));
    const result = await updateMessage(
      { channel_id: CHANNEL, message_id: MESSAGE, files: [newFile] },
      signal,
    );
    expect(result).toMatchObject({
      status: 'unverified',
      sent_count: 1,
      receipts: [{ verification: 'mismatch', mismatch_fields: ['attachments'] }],
    });
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('reports a retained attachment missing from readback as a mismatch', async () => {
    stored.set(
      MESSAGE,
      message({
        attachments: [
          {
            id: OLD_FILE,
            filename: 'poster.png',
            size: 12,
            url: 'https://cdn.example.test/poster.png',
          },
        ],
      }),
    );
    patch.mockImplementation(async (_route, options) => {
      const result = uploaded(options, stored.get(MESSAGE)!);
      result.attachments = (result.attachments as Array<Record<string, unknown>>).filter(
        (file) => file.filename !== 'poster.png',
      );
      stored.set(MESSAGE, result);
      return result;
    });
    const result = await updateMessage(
      { channel_id: CHANNEL, message_id: MESSAGE, files: [newFile] },
      signal,
    );
    expect(result).toMatchObject({
      status: 'unverified',
      receipts: [{ verification: 'mismatch', mismatch_fields: ['retained_attachments'] }],
    });
  });

  it('references an existing attachment during an embed update', async () => {
    stored.set(
      MESSAGE,
      message({
        attachments: [
          {
            id: OLD_FILE,
            filename: 'poster.png',
            size: 12,
            url: 'https://cdn.example.test/poster.png',
          },
        ],
      }),
    );
    const result = await updateMessage(
      {
        channel_id: CHANNEL,
        message_id: MESSAGE,
        embeds: [{ title: 'Poster', image: { url: 'attachment://poster.png' } }],
      },
      signal,
    );
    expect(result.status).toBe('complete');
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('does not treat attachment-looking prose as an attachment reference', async () => {
    stored.set(MESSAGE, message());
    const result = await updateMessage(
      {
        channel_id: CHANNEL,
        message_id: MESSAGE,
        content: 'attachment://poster.png is example text.',
        embeds: [{ description: 'attachment://poster.png is example text.' }],
      },
      signal,
    );
    expect(result.status).toBe('complete');
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]![1].body).toMatchObject({
      content: 'attachment://poster.png is example text.',
      embeds: [{ description: 'attachment://poster.png is example text.' }],
    });
  });

  it('sends explicit empty content and embeds when clearing both fields', async () => {
    stored.set(MESSAGE, message({ content: 'old', embeds: [{ title: 'old' }] }));
    const result = await updateMessage(
      { channel_id: CHANNEL, message_id: MESSAGE, content: '', embeds: [] },
      signal,
    );
    expect(result.status).toBe('complete');
    expect(patch.mock.calls[0]![1].body).toMatchObject({ content: '', embeds: [] });
    expect(stored.get(MESSAGE)).toMatchObject({ content: '', embeds: [] });
  });

  it('rejects a foreign-authored message before patching', async () => {
    stored.set(MESSAGE, message({ author: { id: GUILD } }));
    await expect(
      updateMessage({ channel_id: CHANNEL, message_id: MESSAGE, content: 'new' }, signal),
    ).rejects.toMatchObject({
      issues: [{ message: expect.stringContaining('authored by this bot') }],
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it('rejects an active bot identity that does not match the locked bot', async () => {
    stored.set(MESSAGE, message());
    container.config = loadConfig({
      DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      DISCORD_EXPECTED_BOT_ID: '112233445566778899',
      LOG_LEVEL: 'fatal',
    });
    await expect(
      updateMessage({ channel_id: CHANNEL, message_id: MESSAGE, content: 'new' }, signal),
    ).rejects.toMatchObject({
      issues: [{ message: expect.stringContaining('does not match the locked bot identity') }],
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it('rejects an invalid active bot identity response before patching', async () => {
    stored.set(MESSAGE, message());
    get.mockImplementation(async (route: string) => {
      if (route === Routes.user('@me')) return {};
      return stored.get(route.split('/').at(-1)!);
    });
    await expect(
      updateMessage({ channel_id: CHANNEL, message_id: MESSAGE, content: 'new' }, signal),
    ).rejects.toMatchObject({
      issues: [{ message: expect.stringContaining('verifiable active bot identity') }],
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it('rejects a missing attachment reference before patching', async () => {
    stored.set(MESSAGE, message());
    await expect(
      updateMessage(
        {
          channel_id: CHANNEL,
          message_id: MESSAGE,
          embeds: [{ image: { url: 'attachment://missing.png' } }],
        },
        signal,
      ),
    ).rejects.toMatchObject({
      issues: [{ message: expect.stringContaining('available attachment') }],
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it('preserves V2 mode and blocks writing classic fields to V2 messages', async () => {
    stored.set(MESSAGE, message({ flags: 32768, components: [{ type: 10, content: 'old' }] }));
    await expect(
      updateMessage({ channel_id: CHANNEL, message_id: MESSAGE, content: 'new' }, signal),
    ).rejects.toMatchObject({
      issues: [{ message: expect.stringContaining('V2 flag cannot be removed') }],
    });
    expect(patch).not.toHaveBeenCalled();
    const result = await updateMessage(
      { channel_id: CHANNEL, message_id: MESSAGE, components: [{ type: 10, content: 'new' }] },
      signal,
    );
    expect(result.status).toBe('complete');
  });

  it('rejects converting a classic message to Components V2', async () => {
    stored.set(MESSAGE, message());
    await expect(
      updateMessage(
        { channel_id: CHANNEL, message_id: MESSAGE, components: [{ type: 10, content: 'new' }] },
        signal,
      ),
    ).rejects.toMatchObject({
      issues: [{ message: expect.stringContaining('instead of converting an existing classic') }],
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it('rejects ambiguous attachment filenames before an upload', async () => {
    stored.set(
      MESSAGE,
      message({
        attachments: [
          {
            id: OLD_FILE,
            filename: 'rules.txt',
            size: 12,
            url: 'https://cdn.example.test/rules.txt',
          },
        ],
      }),
    );
    await expect(
      updateMessage({ channel_id: CHANNEL, message_id: MESSAGE, files: [newFile] }, signal),
    ).rejects.toMatchObject({
      issues: [{ message: expect.stringContaining('different filenames') }],
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it('refuses to append a file when Discord omitted the existing attachment list', async () => {
    stored.set(MESSAGE, message({ attachments: undefined }));
    await expect(
      updateMessage({ channel_id: CHANNEL, message_id: MESSAGE, files: [newFile] }, signal),
    ).rejects.toMatchObject({
      issues: [{ message: expect.stringContaining('retaining files cannot be proved') }],
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it('refuses an edit that would exceed Discord attachment limits', async () => {
    stored.set(
      MESSAGE,
      message({
        attachments: Array.from({ length: 10 }, (_, index) => ({
          id: String(BigInt(OLD_FILE) + BigInt(index)),
          filename: `old-${index}.txt`,
          size: 1,
          url: `https://cdn.example.test/old-${index}.txt`,
        })),
      }),
    );
    await expect(
      updateMessage({ channel_id: CHANNEL, message_id: MESSAGE, files: [newFile] }, signal),
    ).rejects.toMatchObject({
      issues: [{ message: expect.stringContaining('exceed 10 attachments') }],
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it('does not hide a replay-safe JSON PATCH failure behind an unverified receipt', async () => {
    stored.set(MESSAGE, message());
    patch.mockRejectedValue(
      new HTTPError(502, 'Bad Gateway', 'PATCH', 'https://discord.com/api/v10/test', {
        files: undefined,
        json: undefined,
      }),
    );
    await expect(
      updateMessage({ channel_id: CHANNEL, message_id: MESSAGE, content: 'new' }, signal),
    ).rejects.toBeInstanceOf(HTTPError);
    expect(get).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('keeps an accepted update receipt when its independent readback fails', async () => {
    stored.set(MESSAGE, message());
    get
      .mockResolvedValueOnce(message())
      .mockResolvedValueOnce({ id: BOT })
      .mockRejectedValueOnce(new Error('readback failed'));
    const result = await updateMessage(
      { channel_id: CHANNEL, message_id: MESSAGE, content: 'new' },
      signal,
    );
    expect(result).toMatchObject({
      status: 'unverified',
      sent_count: 1,
      receipts: [{ message_id: MESSAGE, verification: 'unavailable' }],
    });
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('retains the known message identity when an accepted edit response is malformed', async () => {
    stored.set(MESSAGE, message());
    patch.mockImplementation(async () => {
      stored.set(
        MESSAGE,
        message({ content: 'new', edited_timestamp: '2026-10-01T01:00:00.000Z' }),
      );
      return {};
    });
    const result = await updateMessage(
      { channel_id: CHANNEL, message_id: MESSAGE, content: 'new' },
      signal,
    );
    expect(result).toMatchObject({
      status: 'complete',
      sent_count: 1,
      receipts: [
        { message_id: MESSAGE, timestamp: '2026-10-01T01:00:00.000Z', verification: 'verified' },
      ],
    });
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('returns the existing link and readback when an upload was applied but its response was lost', async () => {
    stored.set(MESSAGE, message());
    patch.mockImplementation(async (_route, options) => {
      stored.set(MESSAGE, uploaded(options, message()));
      throw Object.assign(new Error('connection lost after update'), { code: 'ECONNRESET' });
    });
    const result = await updateMessage(
      { channel_id: CHANNEL, message_id: MESSAGE, files: [newFile] },
      signal,
    );
    expect(result).toMatchObject({
      status: 'unverified',
      sent_count: 0,
      failed_part_outcome: 'unknown',
      receipts: [{ message_id: MESSAGE, verification: 'verified' }],
    });
    expect(patch).toHaveBeenCalledTimes(1);
    expect(result.next_action).toContain('do not repeat the upload');
  });
});
