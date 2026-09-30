import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../../errors/client.js';
import { composeMessage } from './composer.js';

const dataUri = (value: string, type = 'text/plain') =>
  `data:${type};base64,${Buffer.from(value).toString('base64')}`;

describe('composeMessage', () => {
  it('treats attachment-looking prose as text and clears combined empty fields', () => {
    const text = 'attachment://this-is-example-text';
    const draft = composeMessage({ content: text, embeds: [{ description: text }] });
    expect(draft.attachmentReferences).toEqual([]);
    expect(draft.parts[0]!.body.content).toBe(text);
    const clear = composeMessage({ content: '', embeds: [] }, { edit: true });
    expect(clear.parts[0]!.body).toMatchObject({ content: '', embeds: [] });
  });
  it('chunks long classic content and puts unreferenced files on the first part', () => {
    const result = composeMessage({
      content: 'x'.repeat(4001),
      files: [{ filename: 'note.txt', data_uri: dataUri('hello') }],
    });
    expect(result.parts).toHaveLength(3);
    expect(result.parts[0]!.body.content).toHaveLength(2000);
    expect(result.parts[0]!.files.map((file) => file.filename)).toEqual(['note.txt']);
    expect(result.preview.files).toEqual([
      expect.objectContaining({ filename: 'note.txt', size: 5, content_type: 'text/plain' }),
    ]);
  });

  it('splits classic payload and V2 payload into separate messages', () => {
    const result = composeMessage({
      content: 'classic',
      components: [{ type: 10, content: 'v2' }],
    });
    expect(result.parts.map((part) => part.body.flags ?? 0)).toEqual([0, 1 << 15]);
    expect(result.preview.modes).toEqual(['classic', 'components_v2']);
  });

  it('validates polls and rejects dangling attachment references', () => {
    expect(() =>
      composeMessage({
        embeds: [{ image: { url: 'attachment://missing.png' } }],
      }),
    ).toThrow(ValidationError);
    expect(() =>
      composeMessage({
        poll: {
          question: { text: 'Pick one' },
          answers: [{ poll_media: { text: 'A' } }],
          duration: 24,
          layout_type: 1,
        },
      }),
    ).toThrow(ValidationError);
  });

  it('allows a V2 File only when its supplied attachment matches', () => {
    const result = composeMessage({
      components: [{ type: 13, file: { url: 'attachment://report.txt' } }],
      files: [{ filename: 'report.txt', data_uri: dataUri('report') }],
    });
    expect(result.parts[0]!.body.attachments).toEqual([
      expect.objectContaining({ filename: 'report.txt' }),
    ]);
    expect(() =>
      composeMessage({ components: [{ type: 13, file: { url: 'attachment://x.txt' } }] }),
    ).toThrow(ValidationError);
  });

  it('keeps edit mode to one part and rejects an empty patch', () => {
    expect(() => composeMessage({}, { edit: true })).toThrow(ValidationError);
    expect(() => composeMessage({ content: 'x'.repeat(2001) }, { edit: true })).toThrow(
      ValidationError,
    );
    expect(() =>
      composeMessage(
        {
          poll: {
            question: { text: 'Q' },
            answers: [{ poll_media: { text: 'A' } }, { poll_media: { text: 'B' } }],
            duration: 1,
            layout_type: 1,
          },
        },
        { edit: true },
      ),
    ).toThrow(ValidationError);
  });

  it('preserves combined sparse clear fields and exposes safe ordered preview parts', () => {
    const cleared = composeMessage({ content: 'new', embeds: [] }, { edit: true });
    expect(cleared.parts[0]!.body).toMatchObject({
      content: 'new',
      embeds: [],
      allowed_mentions: { parse: [] },
    });
    expect(cleared.preview.parts).toEqual([
      expect.objectContaining({
        mode: 'classic',
        body: expect.objectContaining({ content: 'new', embeds: [] }),
      }),
    ]);
    const replaced = composeMessage(
      { content: '', embeds: [{ title: 'replacement' }] },
      { edit: true },
    );
    expect(replaced.parts[0]!.body).toMatchObject({
      content: '',
      embeds: [{ title: 'replacement' }],
    });
  });

  it('rejects malformed target URLs, empty embeds, and mention parse conflicts', () => {
    expect(() => composeMessage({ embeds: [{ url: 'https://' }] })).toThrow(ValidationError);
    expect(() => composeMessage({ embeds: [{ image: { url: 'not a url' } }] })).toThrow(
      ValidationError,
    );
    expect(() => composeMessage({ embeds: [{}] })).toThrow(ValidationError);
    expect(() =>
      composeMessage({
        content: 'x',
        allowed_mentions: { parse: ['users'], users: ['111122223333444455'] },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      composeMessage({
        content: 'x',
        allowed_mentions: { parse: ['roles'], roles: ['111122223333444455'] },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects an empty send and preserves an embeds-only clear edit', () => {
    expect(() => composeMessage({})).toThrow(ValidationError);
    const cleared = composeMessage({ embeds: [] }, { edit: true });
    expect(cleared.parts[0]!.body).toMatchObject({ embeds: [], allowed_mentions: { parse: [] } });
  });

  it('does not expose file bytes in preview or fingerprint', () => {
    const result = composeMessage({
      content: 'x',
      files: [{ filename: 'a.txt', data_uri: dataUri('secret') }],
    });
    expect(JSON.stringify(result.preview)).not.toContain('c2VjcmV0');
    expect(JSON.stringify(result.fingerprint)).not.toContain('c2VjcmV0');
  });

  it('preserves surrogate pairs while chunking at the 2000 boundary', () => {
    const content = `${'x'.repeat(1999)}😀${'y'.repeat(2000)}`;
    const result = composeMessage({ content });
    const chunks = result.parts.map((part) => part.body.content as string);
    expect(chunks.join('')).toBe(content);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.some((chunk) => chunk.includes('😀'))).toBe(true);
  });

  it('rejects unsafe file boundaries and size limits', () => {
    const invalid = [
      { filename: 'bad.txt', data_uri: 'data:text/plain;base64,abc' },
      { filename: 'empty.txt', data_uri: 'data:text/plain;base64,' },
      { filename: 'same.txt', data_uri: dataUri('a') },
      { filename: 'same.txt', data_uri: dataUri('b') },
    ];
    for (const files of [invalid.slice(0, 1), invalid.slice(1, 2), invalid.slice(2)]) {
      expect(() => composeMessage({ content: 'x', files })).toThrow(ValidationError);
    }
    const large = dataUri('x'.repeat(2 * 1024 * 1024 + 1), 'application/octet-stream');
    expect(() =>
      composeMessage({ content: 'x', files: [{ filename: 'large.bin', data_uri: large }] }),
    ).toThrow(ValidationError);
    const aggregate = dataUri('x'.repeat(1_048_577), 'application/octet-stream');
    expect(() =>
      composeMessage({
        content: 'x',
        files: [
          { filename: 'a.bin', data_uri: aggregate },
          { filename: 'b.bin', data_uri: aggregate },
        ],
      }),
    ).toThrow(ValidationError);
  });

  it('rejects too many compiled parts after adding a V2 part', () => {
    expect(() =>
      composeMessage({ content: 'x'.repeat(20_000), components: [{ type: 10, content: 'v2' }] }),
    ).toThrow(ValidationError);
  });

  it('enforces aggregate embed text and poll emoji constraints', () => {
    expect(() =>
      composeMessage({
        embeds: [{ description: 'a'.repeat(3001) }, { description: 'b'.repeat(3001) }],
      }),
    ).toThrow(ValidationError);
    for (const emoji of [{ id: '111122223333444455', name: 'both' }, {}, { id: 'bad' }]) {
      expect(() =>
        composeMessage({
          poll: {
            question: { text: 'Q' },
            answers: [{ poll_media: { text: 'A', emoji } }, { poll_media: { text: 'B' } }],
          },
        }),
      ).toThrow(ValidationError);
    }
    const defaults = composeMessage({
      poll: {
        question: { text: 'Q' },
        answers: [{ poll_media: { text: 'A' } }, { poll_media: { text: 'B' } }],
      },
    });
    expect(defaults.parts[0]!.body.poll).toMatchObject({ duration: 24, layout_type: 1 });
  });

  it('counts embed field names and values toward the aggregate limit', () => {
    const fields = [
      ...Array.from({ length: 4 }, () => ({ name: 'n'.repeat(256), value: 'v'.repeat(1024) })),
      { name: 'n'.repeat(256), value: 'v'.repeat(624) },
    ];
    const withinLimit = composeMessage({ embeds: [{ fields }] });
    expect(withinLimit.parts).toHaveLength(1);
    fields[4]!.value += 'v';
    expect(() => composeMessage({ embeds: [{ fields }] })).toThrow(ValidationError);
  });

  it('supports safe file-only and clear-field edits while rejecting tts edits', () => {
    const fileOnly = composeMessage(
      { files: [{ filename: 'poster.png', data_uri: dataUri('png', 'image/png') }] },
      { edit: true },
    );
    expect(fileOnly.parts).toHaveLength(1);
    expect(() => composeMessage({ components: [] }, { edit: true })).not.toThrow();
    expect(() => composeMessage({ content: 'x', tts: true }, { edit: true })).toThrow(
      ValidationError,
    );
  });
});
