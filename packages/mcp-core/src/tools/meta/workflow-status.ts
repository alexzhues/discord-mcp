import { z } from 'zod';
import { getWorkflowEngine } from '../../workflows/registry.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';

const target = z.object({
  profile_id: z.string().trim().min(1).max(128),
  bot_id: z
    .string()
    .regex(/^\d{17,20}$/)
    .optional(),
  guild_id: z
    .string()
    .regex(/^\d{17,20}$/)
    .optional(),
  channel_id: z
    .string()
    .regex(/^\d{17,20}$/)
    .optional(),
});
const output = {
  id: z.string(),
  status: z.string(),
  target,
  current_step: z.number(),
  total_steps: z.number(),
  completed_steps: z.number(),
  cancel_requested: z.boolean(),
  updated_at: z.string(),
  failure: z.object({ code: z.string(), message: z.string() }).optional(),
};

export default defineTool({
  name: 'workflow_status',
  category: 'meta',
  description:
    '**Purpose**: Read a private durable workflow summary bound to the exact profile and target. **Returns**: status and step counts without arguments, results, credentials, or Discord payloads.',
  inputSchema: { id: z.string().regex(/^wf_[0-9a-f]{32}$/), target },
  outputSchema: output,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  idempotent: true,
  handler: async (args, ctx) => {
    const result = await getWorkflowEngine(ctx).status(args.id, args.target as never, ctx as never);
    return dualResult({ text: `Workflow ${args.id}: ${result.status}.`, data: result });
  },
});
