import { z } from 'zod';

export const snowflake = z.string().regex(/^\d{17,20}$/);
export const filters = z.strictObject({ author_id: snowflake });
export const subscription = z.object({
  name: z.literal('message.created'),
  arguments: filters,
  delivery: z.strictObject({ mode: z.literal('webhook'), url: z.string(), secret: z.string() }),
  ttlMs: z.number().int().positive().nullable().optional(),
  cursor: z.null().optional(),
});
export const unsubscribe = subscription.omit({ ttlMs: true, cursor: true }).extend({
  delivery: z.strictObject({ mode: z.literal('webhook'), url: z.string() }),
});
export const payload = z.strictObject({
  message_id: snowflake,
  channel_id: snowflake,
  author_id: snowflake,
  timestamp: z.iso.datetime({ offset: true }),
  text: z.string().min(1).max(4000),
  reply_reference: z.strictObject({ message_id: snowflake, channel_id: snowflake }).nullable(),
});
export const reply = z.strictObject({ event_id: z.string(), content: z.string().min(1).max(2000) });
export const context = z.strictObject({
  event_id: z.string(),
  limit: z.number().int().min(1).max(30).default(20),
});
export function eventDefinition(authorId: string) {
  return {
    name: 'message.created',
    description:
      'A plain-text direct message to this bot from the one operator-authorized Discord account. Retrieve bounded history with events_dm_context and reply with events_dm_reply using event_id. No replay after listener downtime.',
    delivery: ['webhook'],
    inputSchema: z.toJSONSchema(filters.extend({ author_id: z.literal(authorId) })),
    payloadSchema: z.toJSONSchema(payload),
  };
}
export interface EventBridge {
  call(method: string, params: unknown): Promise<Record<string, unknown>>;
}
