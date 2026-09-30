import { describe, expect, it, vi } from 'vitest';
import {
  PayloadConfirmationApprovalReplayed,
  PayloadConfirmationMismatch,
  PayloadConfirmationRequired,
  ValidationError,
} from '../errors/client.js';
import type { MiddlewareContext } from './compose.js';
import { PayloadApprovalLedger, payloadConfirmationMiddleware } from './payload-confirmation.js';

const channelId = '111122223333444455';
const otherChannelId = '111122223333444477';
const messageId = '111122223333444466';
const png = (letter: string): string => `data:image/png;base64,${letter.repeat(8)}`;

function context(
  toolName: 'messages_publish' | 'messages_update',
  args: Record<string, unknown>,
  rawArgs: Record<string, unknown> = args,
): MiddlewareContext<unknown> {
  return {
    tool: { name: toolName, category: 'messages', idempotent: false },
    args,
    meta: new Map([
      ['rawArgs', rawArgs],
      ['toolPiece', { confirmation: 'payload_hash' }],
    ]),
  };
}

async function issue(
  middleware: ReturnType<typeof payloadConfirmationMiddleware>,
  ctx: MiddlewareContext<unknown>,
): Promise<PayloadConfirmationRequired> {
  try {
    await middleware.onCallTool!(ctx, vi.fn());
  } catch (error) {
    expect(error).toBeInstanceOf(PayloadConfirmationRequired);
    return error as PayloadConfirmationRequired;
  }
  throw new Error('expected payload approval');
}

describe('composer payload confirmation', () => {
  it('rejects malformed composer input before issuing an approval', async () => {
    const ledger = new PayloadApprovalLedger();
    const middleware = payloadConfirmationMiddleware({ env: { MCP_DRY_RUN: 'false' }, ledger });
    await expect(
      middleware.onCallTool!(
        context('messages_publish', {
          channel_id: channelId,
          files: [{ filename: 'x', data_uri: 'bad' }],
        }),
        vi.fn(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(ledger.size).toBe(0);
  });

  it('reviews file metadata without exposing base64 bytes', async () => {
    const dataUri = png('A');
    const args = {
      channel_id: channelId,
      content: 'hello',
      files: [{ filename: 'x.png', data_uri: dataUri }],
    };
    const required = await issue(
      payloadConfirmationMiddleware({ env: { MCP_DRY_RUN: 'false' } }),
      context('messages_publish', args),
    );
    expect(JSON.stringify(required.preview)).not.toContain(dataUri);
    expect(required.preview).toMatchObject({ risk_flags: ['files'] });
  });

  it('binds confirmation to file bytes and target channel/message', async () => {
    const ledger = new PayloadApprovalLedger();
    const middleware = payloadConfirmationMiddleware({ env: { MCP_DRY_RUN: 'false' }, ledger });
    const args = {
      channel_id: channelId,
      content: 'hello',
      files: [{ filename: 'x.png', data_uri: png('A') }],
    };
    const required = await issue(middleware, context('messages_publish', args));
    const next = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      middleware.onCallTool!(
        context(
          'messages_publish',
          { ...args, files: [{ filename: 'x.png', data_uri: png('B') }] },
          {
            ...args,
            files: [{ filename: 'x.png', data_uri: png('B') }],
            __confirm: true,
            __confirm_hash: required.payloadHash,
            __confirm_id: required.approvalId,
          },
        ),
        next,
      ),
    ).rejects.toBeInstanceOf(PayloadConfirmationMismatch);
    expect(next).not.toHaveBeenCalled();

    const updateArgs = { channel_id: channelId, message_id: messageId, content: 'edited' };
    const updateApproval = await issue(middleware, context('messages_update', updateArgs));
    await expect(
      middleware.onCallTool!(
        context(
          'messages_update',
          { ...updateArgs, channel_id: otherChannelId },
          {
            ...updateArgs,
            channel_id: otherChannelId,
            __confirm: true,
            __confirm_hash: updateApproval.payloadHash,
            __confirm_id: updateApproval.approvalId,
          },
        ),
        next,
      ),
    ).rejects.toBeInstanceOf(PayloadConfirmationMismatch);
    expect(next).not.toHaveBeenCalled();

    const updateTargetDrift = {
      ...updateArgs,
      message_id: '111122223333444488',
    };
    await expect(
      middleware.onCallTool!(
        context('messages_update', updateTargetDrift, {
          ...updateTargetDrift,
          __confirm: true,
          __confirm_hash: updateApproval.payloadHash,
          __confirm_id: updateApproval.approvalId,
        }),
        next,
      ),
    ).rejects.toBeInstanceOf(PayloadConfirmationMismatch);
    expect(next).not.toHaveBeenCalled();
  });

  it('consumes a valid approval once and blocks replay', async () => {
    const ledger = new PayloadApprovalLedger();
    const middleware = payloadConfirmationMiddleware({ env: { MCP_DRY_RUN: 'false' }, ledger });
    const args = { channel_id: channelId, message_id: messageId, content: 'edited' };
    const required = await issue(middleware, context('messages_update', args));
    const raw = {
      ...args,
      __confirm: true,
      __confirm_hash: required.payloadHash,
      __confirm_id: required.approvalId,
    };
    const next = vi.fn().mockResolvedValue({ ok: true });
    await middleware.onCallTool!(context('messages_update', args, raw), next);
    expect(next).toHaveBeenCalledOnce();
    await expect(
      middleware.onCallTool!(context('messages_update', args, raw), next),
    ).rejects.toBeInstanceOf(PayloadConfirmationApprovalReplayed);
  });
});
