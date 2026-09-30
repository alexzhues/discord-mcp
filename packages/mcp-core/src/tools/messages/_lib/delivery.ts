import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { ValidationError } from '../../../errors/client.js';
import { formatErrorForUser } from '../../../errors/format.js';
import { classifyDiscordError } from '../../../rest/errors.js';
import { messageJumpUrl } from '../../_lib/message-jump-url.js';
import { MessageId } from '../../_lib/snowflake.js';
import { type ComposerArgs, type ComposerPart, composeMessage } from './composer.js';

const Snapshot = z.looseObject({
  id: MessageId,
  channel_id: MessageId,
  guild_id: MessageId.optional(),
  timestamp: z.string(),
  edited_timestamp: z.string().nullable().optional(),
  author: z.looseObject({ id: MessageId }).optional(),
  attachments: z
    .array(
      z.looseObject({
        id: MessageId,
        filename: z.string(),
        size: z.number().nonnegative(),
        url: z.string(),
        proxy_url: z.string().optional(),
        description: z.string().nullable().optional(),
      }),
    )
    .optional(),
  flags: z.number().int().optional(),
});
type MessageSnapshot = z.infer<typeof Snapshot>;

export const Receipt = z.object({
  part: z.number().int(),
  message_id: MessageId,
  channel_id: MessageId,
  jump_url: z.string().url(),
  timestamp: z.string(),
  verification: z.enum(['verified', 'mismatch', 'unavailable']),
  mismatch_fields: z.array(z.string()),
});
export const DELIVERY_OUTPUT_SCHEMA = {
  status: z.enum(['complete', 'partial', 'unverified']),
  requested_count: z.number().int(),
  sent_count: z.number().int(),
  receipts: z.array(Receipt),
  failed_part: z.number().int().optional(),
  failed_part_outcome: z.enum(['rejected', 'unknown']).optional(),
  failure: z.object({ code: z.string(), retry_after_ms: z.number().optional() }).optional(),
  next_action: z.string(),
};
const Delivery = z.object(DELIVERY_OUTPUT_SCHEMA);
export type DeliveryResult = z.infer<typeof Delivery>;

function invalid(path: string, message: string): never {
  throw new ValidationError([{ path, message, code: 'MESSAGE_COMPOSER_INVALID' }]);
}

function requestData(part: ComposerPart, signal: AbortSignal) {
  return {
    body: part.body,
    signal,
    ...(part.files.length === 0
      ? {}
      : {
          files: part.files.map((file, index) => ({
            key: `files[${index}]`,
            name: file.filename,
            data: file.data,
            contentType: file.contentType,
          })),
        }),
  };
}

function snapshot(raw: unknown, channelId: string, messageId?: string): MessageSnapshot {
  const parsed = Snapshot.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.channel_id !== channelId ||
    (messageId !== undefined && parsed.data.id !== messageId)
  ) {
    invalid('message_id', 'Discord did not return the expected message identity and metadata.');
  }
  return parsed.data;
}

function hasUnlistedMedia(value: unknown, attachments: MessageSnapshot['attachments']): boolean {
  if (Array.isArray(value)) return value.some((item) => hasUnlistedMedia(item, attachments));
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => {
    if ((key === 'url' || key === 'icon_url') && typeof item === 'string') {
      if (item.startsWith('attachment://'))
        return !attachments?.some((file) => file.filename === item.slice(13));
      const match =
        /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/\d+\/(\d+)\//u.exec(
          item,
        );
      if (match !== null) return !attachments?.some((file) => file.id === match[1]);
    }
    return hasUnlistedMedia(item, attachments);
  });
}

function matches(
  expected: unknown,
  actual: unknown,
  attachments: MessageSnapshot['attachments'],
): boolean {
  if (expected === actual) return true;
  if (typeof expected === 'string' && expected.startsWith('attachment://')) {
    const file = attachments?.find((item) => item.filename === expected.slice(13));
    return (
      file !== undefined &&
      (actual === file.url || actual === file.proxy_url || actual === expected)
    );
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => matches(item, actual[index], attachments))
    );
  }
  if (expected !== null && typeof expected === 'object') {
    return (
      actual !== null &&
      typeof actual === 'object' &&
      Object.entries(expected).every(([key, value]) =>
        matches(value, (actual as Record<string, unknown>)[key], attachments),
      )
    );
  }
  return expected === actual;
}

export function mismatchedFields(part: ComposerPart, actual: MessageSnapshot): string[] {
  const result: string[] = [];
  for (const key of ['content', 'embeds', 'components', 'tts'] as const) {
    if (key in part.body && !matches(part.body[key], actual[key], actual.attachments))
      result.push(key);
  }
  if (
    typeof part.body.flags === 'number' &&
    ((actual.flags ?? 0) & part.body.flags) !== part.body.flags
  )
    result.push('flags');
  if (part.body.poll !== undefined) {
    const poll = part.body.poll as Record<string, unknown>;
    const { duration: _duration, ...expected } = poll;
    if (!matches(expected, actual.poll, actual.attachments)) result.push('poll');
  }
  if (Array.isArray(part.body.attachments)) {
    for (const retained of part.body.attachments as Array<{ id: string; filename: string }>) {
      if (
        retained.id.length > 10 &&
        !actual.attachments?.some(
          (file) => file.id === retained.id && file.filename === retained.filename,
        )
      )
        result.push('retained_attachments');
    }
  }
  for (const expected of part.fileMetadata) {
    if (
      !actual.attachments?.some(
        (file) =>
          file.filename === expected.filename &&
          file.size === expected.size &&
          (expected.description === undefined || file.description === expected.description),
      )
    )
      result.push('attachments');
  }
  return [...new Set(result)];
}

async function receipt(
  part: ComposerPart,
  written: MessageSnapshot,
  index: number,
  signal: AbortSignal,
) {
  let verification: 'verified' | 'mismatch' | 'unavailable' = 'unavailable';
  let mismatchFields: string[] = [];
  let timestamp = written.edited_timestamp ?? written.timestamp;
  try {
    const raw = await container.rest.get(Routes.channelMessage(written.channel_id, written.id), {
      signal,
    });
    const readback = snapshot(raw, written.channel_id, written.id);
    timestamp = readback.edited_timestamp ?? readback.timestamp;
    mismatchFields = mismatchedFields(part, readback);
    verification = mismatchFields.length === 0 ? 'verified' : 'mismatch';
  } catch {
    // A failed verification must retain the write receipt so the caller does not duplicate it.
  }
  return {
    part: index,
    message_id: written.id,
    channel_id: written.channel_id,
    jump_url: await messageJumpUrl({
      id: written.id,
      channel_id: written.channel_id,
      ...(written.guild_id === undefined ? {} : { guild_id: written.guild_id }),
    }),
    timestamp,
    verification,
    mismatch_fields: mismatchFields,
  };
}

export async function publishMessage(
  args: ComposerArgs & { channel_id: string },
  signal: AbortSignal,
): Promise<DeliveryResult> {
  const { channel_id: channelId, ...draft } = args;
  const composed = composeMessage(draft);
  const receipts: z.infer<typeof Receipt>[] = [];
  for (const [index, part] of composed.parts.entries()) {
    let written: MessageSnapshot;
    try {
      const raw = await container.rest.post(
        Routes.channelMessages(channelId),
        requestData(part, signal),
      );
      written = snapshot(raw, channelId);
    } catch (error) {
      const formatted = formatErrorForUser(error, {
        toolName: 'messages_publish',
        transport: 'stdio',
      });
      const failure = formatted.structuredContent as Record<string, unknown>;
      return {
        status: 'partial',
        requested_count: composed.parts.length,
        sent_count: receipts.length,
        receipts,
        failed_part: index + 1,
        failed_part_outcome:
          typeof failure.status === 'number' && failure.status >= 400 && failure.status < 500
            ? 'rejected'
            : 'unknown',
        failure: {
          code: String(failure.code),
          ...(typeof failure.retry_after_ms === 'number'
            ? { retry_after_ms: failure.retry_after_ms }
            : {}),
        },
        next_action:
          'Inspect the returned links and channel history before preparing a new approval for any missing parts. Do not resend the entire draft.',
      };
    }
    receipts.push(await receipt(part, written, index + 1, signal));
  }
  const verified = receipts.every((item) => item.verification === 'verified');
  return {
    status: verified ? 'complete' : 'unverified',
    requested_count: composed.parts.length,
    sent_count: receipts.length,
    receipts,
    next_action: verified
      ? 'All message parts match independent Discord readback.'
      : 'The messages were sent. Inspect the returned links or use messages_get to verify them; do not resend.',
  };
}

export async function updateMessage(
  args: ComposerArgs & { channel_id: string; message_id: string },
  signal: AbortSignal,
): Promise<DeliveryResult> {
  const { channel_id: channelId, message_id: messageId, ...draft } = args;
  const composed = composeMessage(draft, { edit: true });
  const part = composed.parts[0]!;
  const current = snapshot(
    await container.rest.get(Routes.channelMessage(channelId, messageId), { signal }),
    channelId,
    messageId,
  );
  const botResult = z
    .looseObject({ id: MessageId })
    .safeParse(await container.rest.get(Routes.user('@me'), { signal }));
  if (!botResult.success)
    invalid('message_id', 'Discord did not return a verifiable active bot identity.');
  const bot = botResult.data;
  if (current.author?.id !== bot.id)
    invalid('message_id', 'Only a message authored by this bot can be updated.');
  if (
    container.config.DISCORD_EXPECTED_BOT_ID !== undefined &&
    container.config.DISCORD_EXPECTED_BOT_ID !== bot.id
  )
    invalid('message_id', 'The active Discord bot does not match the locked bot identity.');
  const existingV2 = ((current.flags ?? 0) & (1 << 15)) !== 0;
  if (existingV2 && (draft.content !== undefined || draft.embeds !== undefined))
    invalid(
      'components',
      'Update this Components V2 message through components; its V2 flag cannot be removed.',
    );
  if (!existingV2 && part.mode === 'components_v2')
    invalid(
      'components',
      'Publish a new Components V2 message instead of converting an existing classic message.',
    );
  for (const name of composed.attachmentReferences) {
    const available =
      part.files.some((file) => file.filename === name) ||
      current.attachments?.filter((file) => file.filename === name).length === 1;
    if (!available)
      invalid('files', `attachment://${name} does not identify an available attachment.`);
  }
  if (part.files.length > 0) {
    if (current.attachments === undefined)
      invalid(
        'files',
        'Discord omitted the existing attachment list; retaining files cannot be proved.',
      );
    if (hasUnlistedMedia([current.embeds, current.components], current.attachments))
      invalid(
        'files',
        'Discord media references an attachment absent from the attachment list; publish a new message instead of risking loss of retained files.',
      );
    if (current.attachments.length + part.files.length > 10)
      invalid('files', 'The updated message would exceed 10 attachments.');
    if (
      part.files.some((file) => current.attachments!.some((old) => old.filename === file.filename))
    )
      invalid('files', 'New files must have different filenames from the retained attachments.');
    part.body.attachments = [
      ...current.attachments.map(({ id, filename, description }) => ({
        id,
        filename,
        ...(description == null ? {} : { description }),
      })),
      ...(part.body.attachments as unknown[]),
    ];
  }
  if (part.mode === 'components_v2') part.body.flags = (current.flags ?? 0) | (1 << 15);
  let raw: unknown;
  try {
    raw = await container.rest.patch(
      Routes.channelMessage(channelId, messageId),
      requestData(part, signal),
    );
  } catch (error) {
    const ambiguous = classifyDiscordError(error, {
      method: 'patch',
      hasFiles: part.files.length > 0,
    });
    const formatted = formatErrorForUser(error, {
      toolName: 'messages_update',
      transport: 'stdio',
    });
    const failure = formatted.structuredContent as Record<string, unknown>;
    if (ambiguous?.replaySafe !== false && failure.code !== 'CANCELLED') throw error;
    const inspected = await receipt(part, current, 1, signal);
    return {
      status: 'unverified',
      requested_count: 1,
      sent_count: 0,
      receipts: [inspected],
      failed_part: 1,
      failed_part_outcome: 'unknown',
      failure: { code: String(failure.code) },
      next_action:
        'Discord did not confirm the edit. Inspect the returned message and readback status before preparing any fresh approval; do not repeat the upload blindly.',
    };
  }
  const parsed = Snapshot.safeParse(raw);
  // The accepted PATCH already targets a known message. Preserve its link even
  // when the response is incomplete; independent readback still verifies the edit.
  const written =
    parsed.success && parsed.data.channel_id === channelId && parsed.data.id === messageId
      ? parsed.data
      : current;
  const updated = await receipt(part, written, 1, signal);
  return {
    status: updated.verification === 'verified' ? 'complete' : 'unverified',
    requested_count: 1,
    sent_count: 1,
    receipts: [updated],
    next_action:
      updated.verification === 'verified'
        ? 'The updated fields match independent Discord readback.'
        : 'The edit was accepted. Inspect the returned link or use messages_get to verify it; do not repeat the upload.',
  };
}
