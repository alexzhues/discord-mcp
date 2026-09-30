import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { HttpResponse, http } from 'msw';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from './audit/schema.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { PayloadApprovalLedger } from './middleware/payload-confirmation.js';
import { buildPolicy } from './rest/policy.js';
import { wrapRestWithResilience } from './rest/resilient.js';
import { buildServer } from './server.js';

const API = 'https://discord.com/api/v10';
const CHANNEL_ID = '112233445566778899';
const MESSAGE_ID = '999000999000999000';
const BOT_ID = '111122223333444455';
const FILE_DATA_URI = 'data:text/plain;base64,SGVsbG8gY29tcG9zZXI=';
const FILE_BYTES = Buffer.from('Hello composer');

const oldAttachment = {
  id: '888000888000888000',
  filename: 'rules.txt',
  description: 'Existing rules',
  content_type: 'text/plain',
  size: 11,
  url: 'https://cdn.example/rules.txt',
};

function messageFromPayload(payload: Record<string, unknown>, id = MESSAGE_ID) {
  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments.map((item, index) => {
        const entry = item as { filename: string; description?: string };
        return {
          id: index === 0 ? '777000777000777000' : '777000777000777001',
          filename: entry.filename,
          ...(entry.description === undefined ? {} : { description: entry.description }),
          content_type: 'text/plain',
          size: FILE_BYTES.length,
          url: `https://cdn.example/${entry.filename}`,
        };
      })
    : [];
  return {
    id,
    channel_id: CHANNEL_ID,
    author: { id: BOT_ID },
    timestamp: '2026-10-01T00:00:00.000Z',
    edited_timestamp: null,
    ...payload,
    attachments,
  };
}

function composerArgs() {
  return {
    channel_id: CHANNEL_ID,
    content: 'Weekend tournament announcement',
    embeds: [{ title: 'Bracket', description: 'Saturday at 20:00 KST.' }],
    files: [{ filename: 'rules.txt', data_uri: FILE_DATA_URI, description: 'Rules' }],
    allowed_mentions: { parse: [] },
  };
}

describe('message composer MCP integration', () => {
  let client: Client;
  let postCalls = 0;
  let patchCalls = 0;
  let fetchCalls = 0;
  let publishedPayload: Record<string, unknown> | undefined;
  let updatedPayload: Record<string, unknown> | undefined;
  let updatedMessage: Record<string, unknown> | undefined;
  let auditEvents: AuditEvent[] = [];
  const previousDryRun = process.env.MCP_DRY_RUN;

  beforeAll(async () => {
    process.env.MCP_DRY_RUN = 'false';
    const config = loadConfig({
      DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      MCP_DRY_RUN: 'false',
      MCP_WRITE_MODE: 'allow',
      MCP_AUDIT_ENABLED: 'true',
      LOG_LEVEL: 'fatal',
    });
    const rest = wrapRestWithResilience(
      new REST({
        version: '10',
        makeRequest: fetch,
        retries: 0,
        rejectOnRateLimit: () => true,
      }).setToken('fake-token'),
      buildPolicy(config),
    );
    const built = await buildServer({
      rest,
      logger: createLogger(config),
      config,
      payloadApprovalLedger: new PayloadApprovalLedger(() => Date.parse('2026-09-30T12:00:00Z')),
    });
    built.auditSink.emit = async (event) => {
      auditEvents.push(event);
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'message-composer-it', version: '0.0.0' });
    await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  }, 120_000);

  beforeEach(() => {
    postCalls = 0;
    patchCalls = 0;
    fetchCalls = 0;
    publishedPayload = undefined;
    updatedPayload = undefined;
    updatedMessage = undefined;
    auditEvents = [];
    server.resetHandlers();
    server.use(
      http.post(`${API}/channels/${CHANNEL_ID}/messages`, async ({ request }) => {
        postCalls += 1;
        const form = await request.formData();
        publishedPayload = JSON.parse(String(form.get('payload_json')));
        const file = form.get('files[0]');
        expect(file).toBeInstanceOf(File);
        expect(Buffer.from(await (file as File).arrayBuffer())).toEqual(FILE_BYTES);
        return HttpResponse.json(messageFromPayload(publishedPayload));
      }),
      http.get(`${API}/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`, () => {
        fetchCalls += 1;
        return HttpResponse.json(messageFromPayload(publishedPayload ?? { content: '' }));
      }),
      http.get(`${API}/users/:userId`, () => HttpResponse.json({ id: BOT_ID, bot: true })),
    );
  });

  afterAll(async () => {
    await client.close();
    if (previousDryRun === undefined) delete process.env.MCP_DRY_RUN;
    else process.env.MCP_DRY_RUN = previousDryRun;
  });

  it('composes an offline mixed classic/V2 preview without network or data URI leakage', async () => {
    const result = await client.callTool({
      name: 'messages_compose',
      arguments: {
        content: 'Tournament announcement',
        embeds: [{ title: 'Bracket' }],
        poll: {
          question: { text: 'Format?' },
          answers: [{ poll_media: { text: 'Swiss' } }, { poll_media: { text: 'Finals' } }],
          duration: 24,
        },
        components: [{ type: 10, content: 'Register below' }],
        files: [{ filename: 'rules.txt', data_uri: FILE_DATA_URI }],
      },
    });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ part_count: 2 });
    expect(JSON.stringify(result)).not.toContain('data_uri');
    expect(JSON.stringify(result)).not.toContain(FILE_DATA_URI);
    expect(fetchCalls).toBe(0);
    expect(postCalls).toBe(0);
  });

  it('requires target-bound approval before multipart publish and verifies GET readback', async () => {
    const args = composerArgs();
    const preview = await client.callTool({ name: 'messages_publish', arguments: args });
    expect(preview.structuredContent).toMatchObject({ code: 'PAYLOAD_CONFIRMATION_REQUIRED' });
    expect(postCalls).toBe(0);

    const approval = preview.structuredContent as { payload_hash: string; approval_id: string };
    const published = await client.callTool({
      name: 'messages_publish',
      arguments: {
        ...args,
        __confirm: true,
        __confirm_hash: approval.payload_hash,
        __confirm_id: approval.approval_id,
      },
    });

    expect(published.isError, JSON.stringify(published)).toBe(false);
    expect(published.structuredContent, JSON.stringify(published)).toMatchObject({
      status: 'complete',
      sent_count: 1,
    });
    expect(postCalls).toBe(1);
    expect(fetchCalls).toBe(1);
    expect(JSON.stringify(published)).not.toContain('data_uri');
    expect(JSON.stringify(auditEvents)).not.toContain(FILE_DATA_URI);
    expect(publishedPayload).toMatchObject({ content: args.content, embeds: args.embeds });
  });

  it('requires approval before update and preserves old plus new attachments in multipart PATCH', async () => {
    const current = {
      ...messageFromPayload({ content: 'Old announcement' }),
      attachments: [oldAttachment],
    };
    server.use(
      http.get(`${API}/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`, () =>
        HttpResponse.json(updatedMessage ?? current),
      ),
      http.patch(`${API}/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`, async ({ request }) => {
        patchCalls += 1;
        const form = await request.formData();
        updatedPayload = JSON.parse(String(form.get('payload_json')));
        const file = form.get('files[0]');
        expect(file).toBeInstanceOf(File);
        expect(Buffer.from(await (file as File).arrayBuffer())).toEqual(FILE_BYTES);
        updatedMessage = {
          ...messageFromPayload(updatedPayload),
          attachments: [
            oldAttachment,
            {
              id: '777000777000777001',
              filename: 'new-rules.txt',
              content_type: 'text/plain',
              size: FILE_BYTES.length,
              url: 'https://cdn.example/new-rules.txt',
            },
          ],
        };
        return HttpResponse.json(updatedMessage);
      }),
    );
    const args = {
      channel_id: CHANNEL_ID,
      message_id: MESSAGE_ID,
      content: 'Updated announcement',
      files: [{ filename: 'new-rules.txt', data_uri: FILE_DATA_URI }],
    };
    const preview = await client.callTool({ name: 'messages_update', arguments: args });
    expect(preview.structuredContent).toMatchObject({ code: 'PAYLOAD_CONFIRMATION_REQUIRED' });
    expect(patchCalls).toBe(0);

    const approval = preview.structuredContent as { payload_hash: string; approval_id: string };
    const updated = await client.callTool({
      name: 'messages_update',
      arguments: {
        ...args,
        __confirm: true,
        __confirm_hash: approval.payload_hash,
        __confirm_id: approval.approval_id,
      },
    });

    expect(updated.isError, JSON.stringify(updated)).toBe(false);
    expect(updated.structuredContent, JSON.stringify(updated)).toMatchObject({
      status: 'complete',
      sent_count: 1,
    });
    expect(patchCalls).toBe(1);
    expect(updatedPayload?.attachments).toEqual([
      {
        id: oldAttachment.id,
        filename: oldAttachment.filename,
        description: oldAttachment.description,
      },
      { id: '0', filename: 'new-rules.txt' },
    ]);
    expect(JSON.stringify(updated)).not.toContain('data_uri');
    expect(JSON.stringify(auditEvents)).not.toContain(FILE_DATA_URI);
  });

  it('rejects poll and TTS edits before PATCH', async () => {
    server.use(
      http.get(`${API}/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`, () =>
        HttpResponse.json(messageFromPayload({ content: 'Current' })),
      ),
    );
    const result = await client.callTool({
      name: 'messages_update',
      arguments: {
        channel_id: CHANNEL_ID,
        message_id: MESSAGE_ID,
        poll: {
          question: { text: 'Cannot edit' },
          answers: [{ poll_media: { text: 'A' } }, { poll_media: { text: 'B' } }],
        },
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(patchCalls).toBe(0);
  });

  it('does not replay a multipart PATCH after an ambiguous response and still returns a readback link', async () => {
    const current = {
      ...messageFromPayload({ content: 'Keep announcement' }),
      attachments: [oldAttachment],
    };
    server.use(
      http.get(`${API}/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`, () =>
        HttpResponse.json(updatedMessage ?? current),
      ),
      http.patch(`${API}/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`, async ({ request }) => {
        patchCalls += 1;
        const form = await request.formData();
        const payload = JSON.parse(String(form.get('payload_json')));
        updatedMessage = {
          ...current,
          ...payload,
          attachments: [
            oldAttachment,
            {
              id: '777000777000777001',
              filename: 'new-rules.txt',
              size: FILE_BYTES.length,
              url: 'https://cdn.example/new-rules.txt',
            },
          ],
        };
        return HttpResponse.json({ code: 0, message: 'Response lost at gateway' }, { status: 502 });
      }),
    );
    const args = {
      channel_id: CHANNEL_ID,
      message_id: MESSAGE_ID,
      files: [{ filename: 'new-rules.txt', data_uri: FILE_DATA_URI }],
    };
    const preview = await client.callTool({ name: 'messages_update', arguments: args });
    const approval = preview.structuredContent as { payload_hash: string; approval_id: string };
    const result = await client.callTool({
      name: 'messages_update',
      arguments: {
        ...args,
        __confirm: true,
        __confirm_hash: approval.payload_hash,
        __confirm_id: approval.approval_id,
      },
    });
    expect(result.isError, JSON.stringify(result)).toBe(false);
    expect(result.structuredContent).toMatchObject({
      status: 'unverified',
      sent_count: 0,
      failed_part_outcome: 'unknown',
      receipts: [{ message_id: MESSAGE_ID, verification: 'verified' }],
    });
    expect(patchCalls).toBe(1);
  });
});
