import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { ValidationError } from '../../errors/client.js';
import { defineTool } from '../_lib/defineTool.js';
import { messageJumpUrl } from '../_lib/message-jump-url.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId, MessageId } from '../_lib/snowflake.js';
import { wrapMessages } from '../_lib/untrusted.js';
import {
  messageFields,
  projectMessage,
  type RawMessage,
  readableMessageContent,
} from './_lib/message.js';

const MAX_PAGES = 5;
const MAX_MESSAGES = 500;
const MAX_REPLY_FETCHES = 8;

type MessageReference = {
  message_id?: string;
  channel_id?: string;
  guild_id?: string;
};

type ContextMessage = RawMessage & {
  message_reference?: MessageReference | null;
  referenced_message?: ContextMessage | null;
};

const ReplyReferenceSchema = z.object({
  message_id: MessageId,
  channel_id: ChannelId,
  guild_id: GuildId.optional(),
  resolved: z.boolean(),
  content: z.string().optional(),
  author_name: z.string().optional(),
  citation: z.string().url().optional(),
  reason: z.string().optional(),
});

const CitationSchema = z.object({
  message_id: MessageId,
  channel_id: ChannelId,
  guild_id: GuildId.optional(),
  jump_url: z.string().url().optional(),
  resolved: z.boolean(),
  reason: z.string().optional(),
});

const ContextMessageSchema = z.object({
  id: MessageId,
  channel_id: ChannelId,
  ...messageFields,
  citation: CitationSchema,
  reply_reference: ReplyReferenceSchema.optional(),
});

export default defineTool({
  name: 'messages_context',
  category: 'messages',
  description: [
    '**Purpose**: Read a bounded, citation-ready conversation context from one Discord channel, thread, or forum post.',
    '',
    '**Scope**: Discord does not provide a bot-safe server-wide search through this tool. The server reads only the selected channel and bounded pages.',
    '',
    '**Returns**: Rich projected messages, reply references, guild-aware jump URL citations, scan coverage, and a resumable `next_cursor`.',
    '',
    '**Persistence**: This tool does not create a server-side index or remember conversation history. Reuse `next_cursor` explicitly for the next bounded window.',
    '',
    '**Security**: Discord content remains untrusted. Unreadable reply targets are marked partial rather than inferred.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Channel, thread, or forum post channel to read'),
    scope: z
      .enum(['channel', 'thread', 'forum'])
      .default('channel')
      .describe('How to label the selected channel in the context boundary'),
    guild_id: GuildId.optional().describe(
      'Expected guild for citation validation; never trusted over Discord',
    ),
    query: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Optional case-insensitive substring filter'),
    limit: z.number().int().min(1).max(100).default(50).describe('Messages per page (1-100)'),
    pages: z.number().int().min(1).max(MAX_PAGES).default(1).describe('Pages to scan (1-5)'),
    before: MessageId.optional().describe('Continue toward older messages from this message ID'),
    after: MessageId.optional().describe('Continue toward newer messages from this message ID'),
    around: MessageId.optional().describe(
      'Read one bounded window around this message ID; cannot be combined with cursors or pages > 1',
    ),
  },
  outputSchema: {
    scope: z.object({
      channel_id: ChannelId,
      scope: z.enum(['channel', 'thread', 'forum']),
      guild_id: GuildId.optional(),
      parent_channel_id: ChannelId.optional(),
      channel_type: z.number().int().optional(),
    }),
    messages: z.array(ContextMessageSchema),
    reply_references: z.array(ReplyReferenceSchema),
    query: z.string().optional(),
    scanned_count: z.number().int(),
    returned_count: z.number().int(),
    pages_scanned: z.number().int(),
    next_cursor: MessageId.optional(),
    coverage: z.object({
      complete: z.boolean(),
      partial: z.boolean(),
      direction: z.enum(['older', 'newer', 'around', 'recent']),
      oldest_scanned_id: MessageId.optional(),
      newest_scanned_id: MessageId.optional(),
      budget: z.object({
        pages: z.number().int(),
        messages: z.number().int(),
        reply_fetches: z.number().int(),
      }),
      reasons: z.array(z.string()),
    }),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    if ([args.before, args.after, args.around].filter((value) => value !== undefined).length > 1) {
      throw new ValidationError([
        {
          path: 'before',
          message: 'before, after, and around are mutually exclusive',
          code: 'custom',
        },
      ]);
    }
    if (args.around !== undefined && (args.pages ?? 1) > 1) {
      throw new ValidationError([
        { path: 'pages', message: 'around supports one bounded page only', code: 'custom' },
      ]);
    }

    const limit = args.limit ?? 50;
    const pages = args.pages ?? 1;
    const reasons: string[] = [];
    const direction =
      args.around !== undefined
        ? 'around'
        : args.before !== undefined
          ? 'older'
          : args.after !== undefined
            ? 'newer'
            : 'recent';
    let boundary: Record<string, unknown> | undefined;
    let actualGuildId: string | undefined;
    let parentChannelId: string | undefined;
    let channelType: number | undefined;
    try {
      boundary = (await container.rest.get(Routes.channel(args.channel_id))) as Record<
        string,
        unknown
      >;
      actualGuildId = typeof boundary.guild_id === 'string' ? boundary.guild_id : undefined;
      parentChannelId = typeof boundary.parent_id === 'string' ? boundary.parent_id : undefined;
      channelType = typeof boundary.type === 'number' ? boundary.type : undefined;
      if (
        args.guild_id !== undefined &&
        actualGuildId !== undefined &&
        args.guild_id !== actualGuildId
      )
        reasons.push(
          'requested guild does not match Discord channel guild; citations use Discord state',
        );
    } catch {
      reasons.push('channel metadata could not be read; thread boundary is incomplete');
    }
    if (channelType === 15 || channelType === 16) {
      throw new ValidationError([
        {
          path: 'channel_id',
          message:
            'A forum container cannot be read as a message stream; select a forum post thread.',
          code: 'custom',
        },
      ]);
    }
    const actualScope =
      channelType === 10 || channelType === 11 || channelType === 12 ? 'thread' : 'channel';

    const rawMessages: ContextMessage[] = [];
    let cursor: string | undefined = args.before ?? args.after;
    let pagesScanned = 0;
    for (; pagesScanned < pages; ) {
      const query = new URLSearchParams({ limit: String(limit) });
      if (args.around !== undefined) query.set('around', args.around);
      else if (pagesScanned === 0 && args.before !== undefined) query.set('before', args.before);
      else if (pagesScanned === 0 && args.after !== undefined) query.set('after', args.after);
      else if (cursor !== undefined) query.set(direction === 'older' ? 'before' : 'after', cursor);
      const page = (await container.rest.get(Routes.channelMessages(args.channel_id), {
        query,
      })) as ContextMessage[];
      pagesScanned += 1;
      rawMessages.push(...page);
      if (page.length < limit || page.length === 0) break;
      const ids = page.map((message) => BigInt(message.id));
      const oldestOnPage = ids.reduce((oldest, id) => (id < oldest ? id : oldest));
      const newestOnPage = ids.reduce((newest, id) => (id > newest ? id : newest));
      cursor = (direction === 'newer' ? newestOnPage : oldestOnPage).toString();
      if (rawMessages.length >= MAX_MESSAGES) {
        reasons.push(`message budget reached (${MAX_MESSAGES})`);
        break;
      }
    }
    if (pagesScanned === 0) pagesScanned = 1;
    const uniqueMessages = [
      ...new Map(rawMessages.map((message) => [message.id, message])).values(),
    ];
    const filtered =
      args.query === undefined
        ? uniqueMessages
        : uniqueMessages.filter((message) =>
            readableMessageContent({
              ...message,
              content: typeof message.content === 'string' ? message.content : '',
            })
              .toLowerCase()
              .includes(args.query!.toLowerCase()),
          );

    const replyReferences: z.infer<typeof ReplyReferenceSchema>[] = [];
    let replyFetches = 0;
    const projected: Array<Record<string, unknown>> = [];
    for (const message of filtered) {
      const hasContent = typeof message.content === 'string';
      const hasRichPayload =
        message.components !== undefined ||
        message.embeds !== undefined ||
        message.attachments !== undefined;
      if (!hasContent && !hasRichPayload)
        reasons.push(
          `message ${message.id} content and rich fields were not returned; payload completeness is unknown`,
        );
      let reply_reference: z.infer<typeof ReplyReferenceSchema> | undefined;
      const reference = message.message_reference;
      if (reference?.message_id !== undefined && reference.channel_id !== undefined) {
        const refChannel = reference.channel_id as z.infer<typeof ChannelId>;
        const refMessageId = reference.message_id as z.infer<typeof MessageId>;
        const refGuild = (reference.guild_id ?? actualGuildId) as
          | z.infer<typeof GuildId>
          | undefined;
        if (
          refChannel !== args.channel_id ||
          (reference.guild_id !== undefined && reference.guild_id !== actualGuildId)
        ) {
          reasons.push(`reply target ${refMessageId} is outside the selected context scope`);
          reply_reference = {
            message_id: refMessageId,
            channel_id: refChannel,
            resolved: false,
            reason: 'Referenced message is outside the selected channel boundary',
          };
        } else if (replyFetches < MAX_REPLY_FETCHES) {
          replyFetches += 1;
          try {
            const target = (await container.rest.get(
              Routes.channelMessage(refChannel, refMessageId),
            )) as ContextMessage;
            const citation =
              refGuild !== undefined || channelType === 1 || channelType === 3
                ? await messageJumpUrl({
                    id: target.id,
                    channel_id: refChannel,
                    ...(refGuild === undefined ? {} : { guild_id: refGuild }),
                  })
                : undefined;
            reply_reference = {
              message_id: refMessageId,
              channel_id: refChannel,
              ...(refGuild === undefined ? {} : { guild_id: refGuild }),
              resolved: true,
              content: target.content,
              author_name: target.author.global_name ?? target.author.username,
              ...(citation === undefined ? {} : { citation }),
            };
          } catch {
            reasons.push(`reply target ${refMessageId} was not readable`);
            reply_reference = {
              message_id: refMessageId,
              channel_id: refChannel,
              ...(refGuild === undefined ? {} : { guild_id: refGuild }),
              resolved: false,
              reason: 'Discord did not expose the referenced message',
            };
          }
        } else {
          reasons.push(`reply fetch budget reached (${MAX_REPLY_FETCHES})`);
          reply_reference = {
            message_id: refMessageId,
            channel_id: refChannel,
            ...(refGuild === undefined ? {} : { guild_id: refGuild }),
            resolved: false,
            reason: 'reply fetch budget reached',
          };
        }
        replyReferences.push(reply_reference!);
      }
      const canCite = actualGuildId !== undefined || channelType === 1 || channelType === 3;
      const jumpUrl = canCite
        ? await messageJumpUrl({
            id: message.id,
            channel_id: message.channel_id,
            ...(actualGuildId === undefined ? {} : { guild_id: actualGuildId }),
          })
        : undefined;
      projected.push({
        id: message.id,
        channel_id: message.channel_id,
        ...projectMessage({ ...message, content: hasContent ? message.content : '' }),
        citation: {
          message_id: message.id,
          channel_id: message.channel_id,
          ...(actualGuildId === undefined ? {} : { guild_id: actualGuildId }),
          ...(jumpUrl === undefined
            ? { resolved: false, reason: 'Discord channel metadata was unavailable' }
            : { jump_url: jumpUrl, resolved: true }),
        },
        ...(reply_reference === undefined ? {} : { reply_reference }),
      });
    }
    const messageIds = uniqueMessages.map((message) => BigInt(message.id));
    const oldest =
      messageIds.length === 0
        ? undefined
        : messageIds.reduce((oldestId, id) => (id < oldestId ? id : oldestId)).toString();
    const newest =
      messageIds.length === 0
        ? undefined
        : messageIds.reduce((newestId, id) => (id > newestId ? id : newestId)).toString();
    const budgetExhausted = uniqueMessages.length >= pages * limit;
    if (budgetExhausted)
      reasons.push('requested page budget exhausted; use next_cursor to continue');
    const complete = reasons.length === 0 && !budgetExhausted;
    const nextCursor =
      uniqueMessages.length > 0 && !complete
        ? direction === 'newer'
          ? newest
          : oldest
        : undefined;
    const textMessages = projected.map((message) => ({
      id: String(message.id),
      author: String(message.author_name),
      content: String(message.content ?? ''),
    }));
    const citationLines = projected.map((message) => {
      const citation = message.citation as { jump_url?: string; reason?: string };
      return citation.jump_url
        ? `- ${message.id}: ${citation.jump_url}`
        : `- ${message.id}: citation unavailable (${citation.reason})`;
    });
    const text = `${wrapMessages(textMessages, args.channel_id)}\n\nCitations:\n${citationLines.join('\n') || '- none'}`;
    return dualResult({
      text,
      data: {
        scope: {
          channel_id: args.channel_id,
          scope: actualScope,
          ...(actualGuildId === undefined ? {} : { guild_id: actualGuildId }),
          ...(parentChannelId === undefined ? {} : { parent_channel_id: parentChannelId }),
          ...(channelType === undefined ? {} : { channel_type: channelType }),
        },
        messages: projected,
        reply_references: replyReferences,
        ...(args.query === undefined ? {} : { query: args.query }),
        scanned_count: uniqueMessages.length,
        returned_count: projected.length,
        pages_scanned: pagesScanned,
        ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
        coverage: {
          complete,
          partial: reasons.length > 0,
          direction,
          ...(oldest === undefined ? {} : { oldest_scanned_id: oldest }),
          ...(newest === undefined ? {} : { newest_scanned_id: newest }),
          budget: { pages, messages: MAX_MESSAGES, reply_fetches: replyFetches },
          reasons,
        },
      },
    });
  },
});
