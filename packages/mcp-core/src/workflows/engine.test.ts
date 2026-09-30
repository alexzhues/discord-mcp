import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from './engine.js';
import { WorkflowStore } from './store.js';

const target = {
  profile_id: 'profile-main',
  bot_id: '1541991481491988572',
  guild_id: '123456789012345678',
};
const ok: CallToolResult = {
  isError: false,
  content: [{ type: 'text', text: 'ok' }],
  structuredContent: { ok: true },
};
const context = (
  invoke: (tool: string, args: unknown, signal: AbortSignal) => Promise<CallToolResult>,
  trustedTarget = target,
  authorizeStep?: (
    tool: string,
    args: Record<string, unknown>,
    target: typeof trustedTarget,
  ) => Promise<void>,
) => ({
  invoke,
  trustedTarget,
  ...(authorizeStep === undefined ? {} : { authorizeStep }),
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-'));
  const store = new WorkflowStore(dir, 'workflow-test-integrity-key-01234567890123456789');
  const engine = new WorkflowEngine({
    store,
    resolvePolicy: (tool) => ({
      idempotent: tool.endsWith('_read'),
      retry_safe: tool.endsWith('_read'),
    }),
  });
  return { dir, store, engine };
}

describe('WorkflowEngine', () => {
  it('requires review when an unsafe effect succeeds but its checkpoint write fails', async () => {
    const f = await fixture();
    const put = f.store.put.bind(f.store);
    let writes = 0;
    const invoke = vi.fn().mockResolvedValue(ok);
    const spy = vi.spyOn(f.store, 'put').mockImplementation(async (record) => {
      if (++writes === 4) throw new Error('Checkpoint replacement failed');
      await put(record);
    });
    try {
      const started = await f.engine.start(
        { target, steps: [{ tool: 'messages_send', args: {} }] },
        context(invoke),
      );
      await vi.waitFor(
        async () => {
          const record = await f.store.get(started.id);
          expect(record?.status).toBe('needs_review');
          expect(record?.failure?.code).toBe('WORKFLOW_ENGINE_ERROR');
        },
        { timeout: 10_000 },
      );
      await f.engine.resume(started.id, target, context(invoke));
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('persists before execution and returns an operation id immediately', async () => {
    const f = await fixture();
    try {
      let release!: (result: CallToolResult) => void;
      const gate = new Promise<CallToolResult>((resolve) => {
        release = resolve;
      });
      const result = await f.engine.start(
        { target, steps: [{ tool: 'messages_send', args: { content: 'x' } }] },
        context(async () => gate),
      );
      expect(result.id).toMatch(/^wf_[0-9a-f]{32}$/);
      expect(result.status).toBe('queued');
      expect((await f.store.get(result.id))?.steps[0]?.state).toBe('pending');
      release(ok);
      await vi.waitFor(
        async () => expect((await f.store.get(result.id))?.status).toBe('completed'),
        { timeout: 10_000 },
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('marks an in-flight non-idempotent step for review after a fresh engine resumes', async () => {
    const f = await fixture();
    try {
      let release!: (result: CallToolResult) => void;
      const pending = new Promise<CallToolResult>((resolve) => {
        release = resolve;
      });
      const started = await f.engine.start(
        { target, steps: [{ tool: 'messages_send', args: { content: 'x' } }] },
        context(async () => pending),
      );
      for (
        let i = 0;
        i < 1000 && (await f.store.get(started.id))?.steps[0]?.state !== 'in_flight';
        i += 1
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      release(ok);
      for (let i = 0; i < 1000 && (await f.store.get(started.id))?.status !== 'completed'; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
      const inFlight = await f.store.get(started.id);
      if (inFlight === undefined) throw new Error('checkpoint disappeared');
      await f.store.put({
        ...inFlight,
        status: 'running',
        current_step: 0,
        steps: [{ ...inFlight.steps[0]!, state: 'in_flight' }],
      });
      const fresh = new WorkflowEngine({
        store: f.store,
        resolvePolicy: () => ({ idempotent: false, retry_safe: false }),
      });
      const reviewed = await fresh.resume(
        started.id,
        target,
        context(async () => ok),
      );
      expect(reviewed.status).toBe('needs_review');
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('allows an explicit resume retry only for policy-declared idempotent steps', async () => {
    const f = await fixture();
    try {
      const first = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue(ok);
      const started = await f.engine.start(
        { target, steps: [{ tool: 'channels_read', args: {} }] },
        context(first),
      );
      for (let i = 0; i < 1000 && (await f.store.get(started.id))?.status !== 'failed'; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
      const resumed = await f.engine.resume(started.id, target, context(first));
      expect(['queued', 'running', 'completed']).toContain(resumed.status);
      expect((await f.store.get(started.id))?.steps[0]?.state).toBe('pending');
      for (let i = 0; i < 1000 && (await f.store.get(started.id))?.status === 'running'; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  it('pauses before effect when the persisted retry policy changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-policy-'));
    let policyCalls = 0;
    const store = new WorkflowStore(dir, 'workflow-test-integrity-key-01234567890123456789');
    const invoke = vi.fn().mockResolvedValue(ok);
    const engine = new WorkflowEngine({
      store,
      resolvePolicy: () => {
        policyCalls += 1;
        return policyCalls === 1
          ? { idempotent: true, retry_safe: true }
          : { idempotent: false, retry_safe: false };
      },
    });
    try {
      const started = await engine.start(
        { target, steps: [{ tool: 'channels_read', args: {} }] },
        context(invoke),
      );
      for (let i = 0; i < 1000 && (await store.get(started.id))?.status !== 'needs_review'; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect((await store.get(started.id))?.status).toBe('needs_review');
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('rejects missing records and trusted-context drift for status/cancel/resume', async () => {
    const f = await fixture();
    try {
      await expect(f.engine.status('wf_0123456789abcdef0123456789abcdef', target)).rejects.toThrow(
        /Workflow not found/,
      );
      const started = await f.engine.start(
        { target, steps: [{ tool: 'channels_read', args: {} }] },
        context(async () => ok),
      );
      const wrongContext = context(async () => ok, { ...target, guild_id: '999999999999999999' });
      await expect(f.engine.status(started.id, target, wrongContext)).rejects.toThrow(
        /trusted server/,
      );
      await expect(f.engine.cancel(started.id, target, wrongContext)).rejects.toThrow(
        /trusted server/,
      );
      await expect(f.engine.resume(started.id, target, wrongContext)).rejects.toThrow(
        /trusted server/,
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('rejects forged ids, target drift, traversal, nested execution, and oversized definitions', async () => {
    const f = await fixture();
    try {
      await expect(f.engine.status('../secrets', target)).rejects.toThrow(/Invalid workflow ID/);
      await expect(
        f.engine.start(
          { target, steps: [{ tool: 'mcp_pipeline', args: {} }] },
          context(async () => ok),
        ),
      ).rejects.toThrow(/Nested/);
      await expect(
        f.engine.start(
          { target: { profile_id: '../private' }, steps: [{ tool: 'channels_read', args: {} }] },
          context(async () => ok),
        ),
      ).rejects.toThrow(/trusted server/);
      await expect(
        f.engine.start(
          { target, steps: [{ tool: 'channels_read', args: { guild_id: '999999999999999999' } }] },
          context(async () => ok),
        ),
      ).rejects.toThrow(/target drift/);
      await expect(
        f.engine.start(
          {
            target,
            steps: Array.from({ length: 129 }, () => ({ tool: 'channels_read', args: {} })),
          },
          context(async () => ok),
        ),
      ).rejects.toThrow(/128/);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  it('cancels cooperatively during an effect and preserves the terminal cancellation', async () => {
    const f = await fixture();
    try {
      let release!: (result: CallToolResult) => void;
      const gate = new Promise<CallToolResult>((resolve) => {
        release = resolve;
      });
      const started = await f.engine.start(
        { target, steps: [{ tool: 'messages_send', args: { content: 'x' } }] },
        context(async () => gate),
      );
      for (
        let i = 0;
        i < 1000 && (await f.store.get(started.id))?.steps[0]?.state !== 'in_flight';
        i += 1
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(
        (
          await f.engine.cancel(
            started.id,
            target,
            context(async () => ok),
          )
        ).status,
      ).toBe('cancel_requested');
      expect(
        (
          await f.engine.status(
            started.id,
            target,
            context(async () => ok),
          )
        ).status,
      ).toBe('cancel_requested');
      release(ok);
      for (let i = 0; i < 1000 && (await f.store.get(started.id))?.status !== 'cancelled'; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await f.store.get(started.id))?.status).toBe('cancelled');
      expect(
        (
          await f.engine.cancel(
            started.id,
            target,
            context(async () => ok),
          )
        ).status,
      ).toBe('cancelled');
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('rejects active resume without resetting the running checkpoint', async () => {
    const f = await fixture();
    try {
      let release!: (result: CallToolResult) => void;
      const gate = new Promise<CallToolResult>((resolve) => {
        release = resolve;
      });
      const started = await f.engine.start(
        { target, steps: [{ tool: 'messages_send', args: { content: 'x' } }] },
        context(async () => gate),
      );
      for (
        let i = 0;
        i < 1000 && (await f.store.get(started.id))?.steps[0]?.state !== 'in_flight';
        i += 1
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(
        f.engine.resume(
          started.id,
          target,
          context(async () => ok),
        ),
      ).rejects.toThrow(/already being executed/);
      expect((await f.store.get(started.id))?.steps[0]?.state).toBe('in_flight');
      release(ok);
      for (let i = 0; i < 1000 && (await f.store.get(started.id))?.status === 'running'; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('never replays an uncertain non-idempotent error on resume', async () => {
    const f = await fixture();
    try {
      const uncertain: CallToolResult = {
        isError: true,
        content: [{ type: 'text', text: 'upstream timeout' }],
        structuredContent: { code: 'DISCORD_TIMEOUT', retriable: true },
      };
      const invoke = vi.fn().mockResolvedValue(uncertain);
      const started = await f.engine.start(
        { target, steps: [{ tool: 'messages_send', args: { content: 'x' } }] },
        context(invoke),
      );
      for (let i = 0; i < 300 && (await f.store.get(started.id))?.status !== 'needs_review'; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await f.store.get(started.id))?.status).toBe('needs_review');
      const resumed = await f.engine.resume(started.id, target, context(invoke));
      expect(resumed.status).toBe('needs_review');
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('allows a guild-bound workflow to authorize multiple channels', async () => {
    const f = await fixture();
    try {
      const guildTarget = {
        profile_id: target.profile_id,
        bot_id: target.bot_id,
        guild_id: target.guild_id,
      };
      const invoke = vi.fn().mockResolvedValue(ok);
      const authorizeStep = vi.fn().mockResolvedValue(undefined);
      const started = await f.engine.start(
        {
          target: guildTarget,
          steps: [
            {
              tool: 'messages_send',
              args: { guild_id: target.guild_id, channel_id: '111111111111111111' },
            },
            {
              tool: 'messages_send',
              args: { guild_id: target.guild_id, channel_id: '222222222222222222' },
            },
          ],
        },
        context(invoke, guildTarget, authorizeStep),
      );
      for (let i = 0; i < 1000 && (await f.store.get(started.id))?.status !== 'completed'; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await f.store.get(started.id))?.status).toBe('completed');
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(authorizeStep).toHaveBeenCalledTimes(2);
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('rejects a cross-guild step before invoking it', async () => {
    const f = await fixture();
    try {
      const invoke = vi.fn().mockResolvedValue(ok);
      await expect(
        f.engine.start(
          {
            target,
            steps: [
              {
                tool: 'messages_send',
                args: { guild_id: '999999999999999999', channel_id: '111111111111111111' },
              },
            ],
          },
          context(invoke),
        ),
      ).rejects.toThrow(/target drift/);
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('fails closed for a channel step without a guild authorizer', async () => {
    const f = await fixture();
    try {
      await expect(
        f.engine.start(
          {
            target,
            steps: [{ tool: 'messages_send', args: { channel_id: '111111111111111111' } }],
          },
          context(async () => ok),
        ),
      ).rejects.toThrow(/trusted guild binding and step authorizer/);
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('pauses on an incomplete successful response and does not continue', async () => {
    const f = await fixture();
    try {
      const invoke = vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: 'text', text: 'partial' }],
        structuredContent: { status: 'partial' },
      } satisfies CallToolResult);
      const started = await f.engine.start(
        {
          target,
          steps: [
            { tool: 'messages_send', args: {} },
            { tool: 'messages_send', args: {} },
          ],
        },
        context(invoke),
      );
      for (let i = 0; i < 300 && (await f.store.get(started.id))?.status !== 'needs_review'; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await f.store.get(started.id))?.status).toBe('needs_review');
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('rejects an authorizer scope before invoking the tool', async () => {
    const f = await fixture();
    try {
      const invoke = vi.fn().mockResolvedValue(ok);
      const authorize = vi.fn().mockRejectedValue(new Error('scope denied'));
      const started = await f.engine.start(
        {
          target: { ...target, guild_id: target.guild_id },
          steps: [
            {
              tool: 'messages_send',
              args: { guild_id: target.guild_id, channel_id: '111111111111111111' },
            },
          ],
        },
        context(invoke, target, authorize),
      );
      for (let i = 0; i < 1000 && (await f.store.get(started.id))?.status !== 'failed'; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await f.store.get(started.id))?.failure?.code).toBe('WORKFLOW_TARGET_REJECTED');
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
