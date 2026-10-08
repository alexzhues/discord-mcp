/**
 * Production boot-path coverage for `startStdio()`.
 *
 * Every other suite stubs this function out, so the real chain - loadConfig →
 * buildPolicy → wrapRestWithResilience → buildServer → gateway → connect -
 * had zero assertions on it. Here we run it end to end against an in-memory
 * MCP transport and a real `Client`, so dropping `server.connect(transport)`
 * or reordering the `wrapRestWithResilience` arguments fails the suite.
 *
 * `@discord-mcp/core` is only PARTIALLY mocked: everything keeps its real
 * implementation except `createLogger` (replaced by a capturing stub so the
 * ready/warn records are assertable - pino writes straight to fd 2 and would
 * bypass a process.stderr spy) and `createGatewayClient` (which would
 * otherwise open a real Discord websocket).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

const { makeLoggerStub } = vi.hoisted(() => ({
  makeLoggerStub: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@discord-mcp/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@discord-mcp/core')>();
  return {
    ...actual,
    createAuditSink: vi.fn(actual.createAuditSink),
    createLogger: vi.fn(makeLoggerStub),
    createGatewayClient: vi.fn(),
    wrapRestWithResilience: vi.fn(actual.wrapRestWithResilience),
  };
});
vi.mock('../otel.js', () => ({
  startOtel: vi.fn(() => ({ shutdown: vi.fn(async () => {}) })),
}));

import {
  createAuditSink,
  createGatewayClient,
  createLogger,
  wrapRestWithResilience,
} from '@discord-mcp/core';

// macOS uses homedir rather than XDG_CONFIG_HOME for default Activity paths.
// Keep those production calls inside this suite's existing temporary root.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => process.env.XDG_CONFIG_HOME ?? actual.homedir() };
});

import { readActivity, resolveActivityPath } from '../lib/activity.js';
import { startOtel } from '../otel.js';
import { startStdio } from './stdio.js';

const VALID_TOKEN = `Bot ${'a'.repeat(60)}`;
const HALF_OPEN_MS = 12_345;

const savedEnv = { ...process.env };
let activityRoot: string;

type LoggerStub = ReturnType<typeof makeLoggerStub>;

/** The stub returned by the most recent `createLogger()` call. */
function lastLogger(): LoggerStub {
  const results = vi.mocked(createLogger).mock.results;
  return results[results.length - 1]?.value as unknown as LoggerStub;
}

/** Payload of the `discord-mcp ready (stdio)` info record. */
function readyRecord(): Record<string, unknown> {
  const call = lastLogger().info.mock.calls.find((c) => c[1] === 'discord-mcp ready (stdio)');
  expect(call, 'expected a ready log record').toBeDefined();
  return (call as unknown[])[0] as Record<string, unknown>;
}

/** Boots the real server over an in-memory pair and returns a connected client. */
async function boot(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await startStdio({ transport: serverTransport, registerSignalHandlers: false });
  const client = new Client({ name: 'stdio-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function fakeGateway(start: Mock): void {
  vi.mocked(createGatewayClient).mockReturnValue({
    start,
    stop: vi.fn(async () => {}),
  } as unknown as ReturnType<typeof createGatewayClient>);
}

beforeEach(() => {
  vi.clearAllMocks();
  activityRoot = mkdtempSync(join(tmpdir(), 'discord-mcp-stdio-activity-'));
  process.env.APPDATA = activityRoot;
  process.env.XDG_CONFIG_HOME = activityRoot;
  process.env.DISCORD_TOKEN = VALID_TOKEN;
  process.env.MCP_CIRCUIT_HALF_OPEN_AFTER_MS = String(HALF_OPEN_MS);
  process.env.MCP_AUDIT_ENABLED = 'false';
  delete process.env.DISCORD_EXPECTED_BOT_ID;
  delete process.env.GATEWAY;
  delete process.env.OTEL_ENABLED;
  delete process.env.DISCORD_MCP_ACTIVITY;
  delete process.env.MCP_APPROVAL_STATE_DIR;
  delete process.env.MCP_APPROVAL_HMAC_KEY;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(activityRoot, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

describe('startStdio', () => {
  it('cleans up Gateway, audit and OTel once when the client disconnects', async () => {
    process.env.GATEWAY = '1';
    process.env.OTEL_ENABLED = 'true';
    const order: string[] = [];
    const stop = vi.fn(async () => {
      throw new Error('gateway stop failed');
    });
    vi.mocked(createGatewayClient).mockReturnValue({ start: vi.fn(async () => {}), stop });
    const auditShutdown = vi.fn(async () => {
      order.push('audit');
      throw new Error('audit flush failed');
    });
    vi.mocked(createAuditSink).mockReturnValueOnce({ emit: vi.fn(), shutdown: auditShutdown });
    const otelShutdown = vi.fn(async () => {
      order.push('otel');
    });
    vi.mocked(startOtel).mockReturnValueOnce({ shutdown: otelShutdown });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // A supplied transport must never install process hooks, even when the
    // option is omitted. Real SDK close callbacks exercise shutdown re-entry.
    const signalsBefore = process.listenerCount('SIGTERM');
    await startStdio({ transport: serverTransport });
    const client = new Client({ name: 'stdio-close-test', version: '0.0.0' });
    await client.connect(clientTransport);
    await client.close();
    await vi.waitFor(() => expect(otelShutdown).toHaveBeenCalledTimes(1));
    await serverTransport.close();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(auditShutdown).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['audit', 'otel']);
    expect(process.listenerCount('SIGTERM')).toBe(signalsBefore);
    expect(exit).not.toHaveBeenCalled();
  });

  it('cleans up a transport that closes during connect without starting Gateway', async () => {
    process.env.GATEWAY = '1';
    process.env.OTEL_ENABLED = 'true';
    const gateway = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    vi.mocked(createGatewayClient).mockReturnValue(gateway);
    const [, transport] = InMemoryTransport.createLinkedPair();
    const originalClose = vi.fn();
    transport.onclose = originalClose;
    vi.spyOn(transport, 'start').mockImplementation(async () => transport.close());
    await startStdio({ transport, registerSignalHandlers: false });
    expect(originalClose).toHaveBeenCalled();
    expect(gateway.start).not.toHaveBeenCalled();
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startOtel).mock.results.at(-1)?.value.shutdown).toHaveBeenCalledTimes(1);
  });

  it('cleans up resources and preserves the original connect failure', async () => {
    process.env.OTEL_ENABLED = 'true';
    const [, transport] = InMemoryTransport.createLinkedPair();
    vi.spyOn(transport, 'start').mockRejectedValue(new Error('client disappeared'));
    await expect(startStdio({ transport, registerSignalHandlers: false })).rejects.toThrow(
      'client disappeared',
    );
    expect(vi.mocked(startOtel).mock.results.at(-1)?.value.shutdown).toHaveBeenCalledTimes(1);
  });

  it('disconnects while Gateway is still starting', async () => {
    process.env.GATEWAY = '1';
    let finishStart!: () => void;
    const start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    );
    const stop = vi.fn(async () => {
      finishStart();
    });
    vi.mocked(createGatewayClient).mockReturnValue({ start, stop });
    const [clientTransport, transport] = InMemoryTransport.createLinkedPair();
    const booting = startStdio({ transport, registerSignalHandlers: false });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await clientTransport.close();
    await booting;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(lastLogger().info.mock.calls.some((c) => c[1] === 'discord-mcp ready (stdio)')).toBe(
      false,
    );
  });

  it('bounds stalled Gateway cleanup while still flushing audit and OTel', async () => {
    process.env.GATEWAY = '1';
    process.env.OTEL_ENABLED = 'true';
    const stop = vi.fn(() => new Promise<void>(() => {}));
    vi.mocked(createGatewayClient).mockReturnValue({ start: vi.fn(async () => {}), stop });
    const auditShutdown = vi.fn(async () => {});
    vi.mocked(createAuditSink).mockReturnValueOnce({ emit: vi.fn(), shutdown: auditShutdown });
    const client = await boot();
    const otelShutdown = vi.mocked(startOtel).mock.results.at(-1)?.value.shutdown;
    vi.useFakeTimers();
    await client.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(auditShutdown).toHaveBeenCalledTimes(1);
    expect(otelShutdown).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(lastLogger().warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(lastLogger().warn).toHaveBeenCalledExactlyOnceWith(
      { timeoutMs: 5_000 },
      'shutdown timed out',
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not load the OpenTelemetry runtime when telemetry is disabled', async () => {
    const client = await boot();
    try {
      expect(startOtel).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it('starts OpenTelemetry before serving tools when explicitly enabled', async () => {
    process.env.OTEL_ENABLED = 'true';
    const client = await boot();
    try {
      expect(startOtel).toHaveBeenCalledTimes(1);
      expect(lastLogger().info).toHaveBeenCalledWith(
        { otel: 'enabled' },
        'OpenTelemetry SDK started',
      );
    } finally {
      await client.close();
    }
  });

  it('boots the whole chain and serves the registered tools over the transport', async () => {
    const client = await boot();
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      expect(readyRecord()).toMatchObject({ tools: tools.length, gateway: false });
    } finally {
      await client.close();
    }
  });

  it('records one coarse blueprint result without retaining MCP arguments', async () => {
    const client = await boot();
    try {
      const result = await client.callTool({
        name: 'guild_blueprint_evidence',
        arguments: {
          guild_id: 'must-not-be-recorded',
          expected_bot_id: 'must-not-be-recorded',
          plan_id: 'must-not-be-recorded',
        },
      });

      expect(result.isError).toBe(true);
      expect(readActivity()).toEqual([
        expect.objectContaining({
          version: 2,
          kind: 'blueprint',
          stage: 'evidence',
          status: 'error',
          outcome: 'failure',
          transport: 'stdio',
        }),
      ]);
      expect(readFileSync(resolveActivityPath(), 'utf8')).not.toContain('must-not-be-recorded');
    } finally {
      await client.close();
    }
  });

  it('wires the optional durable approval ledger into the stdio server', async () => {
    const approvalDirectory = join(activityRoot, 'approvals');
    process.env.MCP_APPROVAL_STATE_DIR = approvalDirectory;
    process.env.MCP_APPROVAL_HMAC_KEY = 'stdio-approval-ledger-test-secret-0123456789';
    const client = await boot();
    try {
      const result = await client.callTool({
        name: 'components_v2_send',
        arguments: {
          channel_id: '111122223333444455',
          components: [{ type: 10, content: 'durable preview' }],
        },
      });
      expect(result.structuredContent).toMatchObject({
        code: 'PAYLOAD_CONFIRMATION_REQUIRED',
      });
      const state = readFileSync(join(approvalDirectory, 'approvals.json'), 'utf8');
      expect(state).toContain('"version":1');
      expect(state).not.toContain(
        (result.structuredContent as { approval_id: string }).approval_id,
      );
    } finally {
      await client.close();
    }
  });

  it('forwards circuitHalfOpenAfterMs to wrapRestWithResilience', async () => {
    const client = await boot();
    try {
      expect(wrapRestWithResilience).toHaveBeenCalledTimes(1);
      const baseRest = vi.mocked(wrapRestWithResilience).mock.calls[0]?.[0];
      expect(baseRest).toBeDefined();
      const rejectOnRateLimit = baseRest?.options.rejectOnRateLimit;
      expect(rejectOnRateLimit).toEqual(expect.any(Function));
      if (typeof rejectOnRateLimit !== 'function') throw new Error('missing rate-limit filter');
      expect(await rejectOnRateLimit({} as never)).toBe(true);
      // Third arg is optional, so tsc cannot catch its loss - assert it here.
      expect(vi.mocked(wrapRestWithResilience).mock.calls[0]?.[2]).toEqual({
        circuitHalfOpenAfterMs: HALF_OPEN_MS,
      });
    } finally {
      await client.close();
    }
  });

  it('reports gateway: true when the gateway starts', async () => {
    process.env.GATEWAY = '1';
    const start = vi.fn(async () => {});
    fakeGateway(start);

    const client = await boot();
    try {
      expect(start).toHaveBeenCalledTimes(1);
      expect(readyRecord()).toMatchObject({ gateway: true });
      expect(lastLogger().warn).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it('warns and continues in REST-only mode when the gateway fails to start', async () => {
    process.env.GATEWAY = '1';
    fakeGateway(
      vi.fn(async () => {
        throw new Error('gateway boom');
      }),
    );

    const client = await boot();
    try {
      expect(lastLogger().warn).toHaveBeenCalledWith(
        { err: 'gateway boom' },
        'Discord Gateway failed to start - continuing in REST-only mode',
      );
      expect(readyRecord()).toMatchObject({ gateway: false });
      // REST-only continuation: the server is still fully operational.
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});
