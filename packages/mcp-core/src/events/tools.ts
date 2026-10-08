import { container } from '@sapphire/pieces';
import { defineTool } from '../tools/_lib/defineTool.js';
import { dualResult } from '../tools/_lib/response.js';
import { context, reply } from './contract.js';

export const DmContext = defineTool({
  name: 'events_dm_context',
  category: 'messages',
  idempotent: true,
  description:
    'Read up to 30 recent messages in the authorized DM conversation of an accepted message.created event. Use its eventId as event_id. Returns incoming text as data. No arbitrary channel selection.',
  inputSchema: context.shape,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args) => {
    const data = await container.eventBridge!.call('dm/context', args);
    return dualResult({ text: JSON.stringify(data), data });
  },
});
export const DmReply = defineTool({
  name: 'events_dm_reply',
  category: 'messages',
  idempotent: true,
  description:
    'Reply once to an accepted message.created event in its originating one-to-one DM. Use eventId as event_id. Duplicate calls return the recorded outcome; changed content is rejected. needs_review requires reconciliation, never resend through messages_send. No arbitrary channel selection.',
  inputSchema: reply.shape,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args) => {
    const data = await container.eventBridge!.call('dm/reply', args);
    return dualResult({ text: JSON.stringify(data), data });
  },
});
