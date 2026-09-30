import { z } from 'zod';
import { LOCAL_ACCESS } from '../../access/requirements.js';
import { defineTool } from '../_lib/defineTool.js';
import { fingerprintPayload } from '../_lib/payload-fingerprint.js';
import { dualResult } from '../_lib/response.js';
import { COMPOSER_INPUT_SCHEMA, composeMessage } from './_lib/composer.js';

export default defineTool({
  name: 'messages_compose',
  category: 'messages',
  access: LOCAL_ACCESS,
  description:
    '**Purpose**: Compose and preview a complete Discord announcement locally: text, typed embeds, uploaded files, polls, and Components V2. Long text and incompatible classic/V2 layouts become ordered message parts.\n\n**When to use**: Prepare a rich announcement, tournament post, report, or survey before publishing.\n\n**Files**: Supply bounded base64 data URIs; preview returns filenames, sizes, and hashes without file bytes.\n\n**Next**: Present the draft, then call messages_publish with the same fields to obtain its target-bound approval.\n\n**Returns**: {part_count, draft_hash, preview}. No Discord request or write.',
  inputSchema: COMPOSER_INPUT_SCHEMA.shape,
  outputSchema: {
    part_count: z.number().int(),
    draft_hash: z.string(),
    preview: z.record(z.string(), z.unknown()),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  idempotent: true,
  handler: async (args) => {
    const composed = composeMessage(args);
    return dualResult({
      text: `Draft contains ${composed.parts.length} ordered message part(s). Review the structured preview before publishing.`,
      data: {
        part_count: composed.parts.length,
        draft_hash: fingerprintPayload(composed.fingerprint),
        preview: composed.preview,
      },
    });
  },
});
