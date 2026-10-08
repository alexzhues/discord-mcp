import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createEventBridge } from './bridge.js';

it('provides event-specific plugin catalogs over one shared worker and rejects cross-catalog subscriptions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'event-catalog-'));
  const socket = join(directory, 'worker.sock');
  let requests = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    requests++;
    expect(parsed.owner).toBe('operator');
    res.end(
      JSON.stringify({
        result: { events: [{ name: 'message.created' }, { name: 'message.mentioned' }] },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const dm = createEventBridge(socket, 'operator', 'dm'),
      mention = createEventBridge(socket, 'operator', 'mentions'),
      all = createEventBridge(socket, 'operator');
    expect(await dm.call('events/list', {})).toEqual({ events: [{ name: 'message.created' }] });
    expect(await mention.call('events/list', {})).toEqual({
      events: [{ name: 'message.mentioned' }],
    });
    expect((await all.call('events/list', {})).events).toHaveLength(2);
    await expect(dm.call('events/subscribe', { name: 'message.mentioned' })).rejects.toMatchObject({
      code: -32001,
    });
    await expect(
      mention.call('events/subscribe', { name: 'message.created' }),
    ).rejects.toMatchObject({ code: -32001 });
    expect(requests).toBe(3);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
