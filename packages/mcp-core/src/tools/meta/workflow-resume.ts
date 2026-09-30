import { z } from 'zod';
import { getWorkflowEngine } from '../../workflows/registry.js';
import type { WorkflowInvokeContext } from '../../workflows/types.js';
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
export default defineTool({
  name: 'workflow_resume',
  category: 'meta',
  description:
    '**Purpose**: Explicitly resume a durable workflow after review. **Safety**: uncertain non-idempotent in-flight steps become needs_review and are never replayed automatically; only policy-declared safe idempotent steps may be retried.',
  inputSchema: { id: z.string().regex(/^wf_[0-9a-f]{32}$/), target },
  outputSchema: {
    id: z.string(),
    status: z.string(),
    target,
    current_step: z.number(),
    total_steps: z.number(),
    completed_steps: z.number(),
    cancel_requested: z.boolean(),
    updated_at: z.string(),
    failure: z.object({ code: z.string(), message: z.string() }).optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    const run = ctx as unknown as WorkflowInvokeContext;
    const result = await getWorkflowEngine(run).resume(args.id, args.target as never, run);
    return dualResult({
      text: `Workflow ${args.id} resume accepted; current status is ${result.status}.`,
      data: result,
    });
  },
});
