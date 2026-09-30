import { describe, expect, it } from 'vitest';
import { resolveToolAccessRequirement } from './requirements.js';

describe('composer access requirements', () => {
  it('keeps offline draft composition local and credential free', () => {
    expect(resolveToolAccessRequirement('messages_compose', {})).toMatchObject({
      auth: 'none',
      scope: 'local',
      permissions: [],
    });
  });

  it('requires only base send/readback permissions for text publication', () => {
    expect(
      resolveToolAccessRequirement('messages_publish', { content: 'hello' })?.permissions,
    ).toEqual(['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY']);
  });

  it('requires permissions for the exact richer actions being requested', () => {
    const permissions = resolveToolAccessRequirement('messages_publish', {
      embeds: [{}],
      files: [{}],
      poll: {},
      tts: true,
    })?.permissions;
    expect(permissions).toEqual([
      'VIEW_CHANNEL',
      'SEND_MESSAGES',
      'READ_MESSAGE_HISTORY',
      'EMBED_LINKS',
      'ATTACH_FILES',
      'SEND_POLLS',
      'SEND_TTS_MESSAGES',
    ]);
    expect(
      resolveToolAccessRequirement('messages_publish', { tts: false })?.permissions,
    ).not.toContain('SEND_TTS_MESSAGES');
  });

  it('does not require MANAGE_MESSAGES to update the bot own announcement', () => {
    const permissions = resolveToolAccessRequirement('messages_update', {
      content: 'new',
      files: [{}],
    })?.permissions;
    expect(permissions).toContain('ATTACH_FILES');
    expect(permissions).not.toContain('MANAGE_MESSAGES');
    expect(permissions).not.toContain('SEND_POLLS');
  });
});
