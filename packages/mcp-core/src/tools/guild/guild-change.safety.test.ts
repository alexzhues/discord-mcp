import { describe, expect, it } from 'vitest';
import { GuildChangeRequestSchema } from './_lib/guild-change.js';

const id = '111111111111111111';

describe('guild change safety contracts', () => {
  it('rejects empty and duplicate operation requests', () => {
    expect(() => GuildChangeRequestSchema.parse({})).toThrow();
    expect(() =>
      GuildChangeRequestSchema.parse({
        channels: [
          { id, patch: { name: 'one' } },
          { id, patch: { name: 'two' } },
        ],
      }),
    ).toThrow(/duplicate/i);
    expect(() =>
      GuildChangeRequestSchema.parse({
        roles: [
          { id, patch: { name: 'one' } },
          { id, patch: { name: 'two' } },
        ],
      }),
    ).toThrow(/duplicate/i);
    expect(() =>
      GuildChangeRequestSchema.parse({
        permission_overwrites: [
          { channel_id: id, overwrite_id: '222222222222222222', type: 0 },
          { channel_id: id, overwrite_id: '222222222222222222', type: 0 },
        ],
      }),
    ).toThrow(/duplicate/i);
  });

  it('bounds Discord permission bitfields before any REST operation', () => {
    expect(() =>
      GuildChangeRequestSchema.parse({
        roles: [{ id, patch: { permissions: '1'.repeat(21) } }],
      }),
    ).toThrow();
  });

  it('keeps the overwrite contract complete even when the request changes one field', () => {
    const parsed = GuildChangeRequestSchema.parse({
      permission_overwrites: [
        { channel_id: id, overwrite_id: '222222222222222222', type: 0, allow: '4' },
      ],
    });
    expect(parsed.permission_overwrites[0]).toMatchObject({ type: 0, allow: '4' });
    expect(parsed.permission_overwrites[0]?.deny).toBeUndefined();
  });

  it('keeps role and channel targets distinct so hierarchy checks can fail closed', () => {
    const parsed = GuildChangeRequestSchema.parse({
      roles: [{ id, patch: { name: 'role' } }],
      channels: [{ id: '333333333333333333', patch: { name: 'channel' } }],
    });
    expect(parsed.roles).toHaveLength(1);
    expect(parsed.channels).toHaveLength(1);
  });

  it('rejects unknown nested fields in every operation', () => {
    expect(() =>
      GuildChangeRequestSchema.parse({
        channels: [{ id, patch: { name: 'ok' }, unexpected: true }],
      }),
    ).toThrow();
  });
});
