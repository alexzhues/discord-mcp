import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ValidationError } from '../../../errors/client.js';
import { validateComponentsV2 } from '../../components-v2/_lib/validator.js';

const DATA_URI =
  /^data:([A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/u;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PARTS = 10;

const HttpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//u.test(value), 'URL must use http(s)');
const ImageUrl = z.string().refine((value) => {
  if (value.startsWith('attachment://'))
    return value.length > 13 && FILE_NAME.test(value.slice(13));
  try {
    return /^https?:\/\//u.test(new URL(value).toString());
  } catch {
    return false;
  }
}, 'URL must use http(s) or a valid attachment reference');
const EmbedField = z
  .object({
    name: z.string().min(1).max(256),
    value: z.string().min(1).max(1024),
    inline: z.boolean().optional(),
  })
  .strict();
const Embed = z
  .object({
    title: z.string().max(256).optional(),
    type: z.literal('rich').optional(),
    description: z.string().max(4096).optional(),
    url: HttpUrl.optional(),
    timestamp: z.string().datetime({ offset: true }).optional(),
    color: z.number().int().min(0).max(0xffffff).optional(),
    footer: z
      .object({ text: z.string().min(1).max(2048), icon_url: ImageUrl.optional() })
      .strict()
      .optional(),
    image: z.object({ url: ImageUrl }).strict().optional(),
    thumbnail: z.object({ url: ImageUrl }).strict().optional(),
    author: z
      .object({
        name: z.string().min(1).max(256),
        url: HttpUrl.optional(),
        icon_url: ImageUrl.optional(),
      })
      .strict()
      .optional(),
    fields: z.array(EmbedField).max(25).optional(),
  })
  .strict()
  .refine(
    (embed) => Object.values(embed).some((value) => value !== undefined),
    'embed must contain at least one field',
  );

const PollQuestion = z.object({ text: z.string().min(1).max(300) }).strict();
const PollAnswer = z
  .object({
    poll_media: z
      .object({
        text: z.string().min(1).max(55),
        emoji: z
          .object({
            id: z
              .string()
              .regex(/^\d{17,20}$/u)
              .optional(),
            name: z.string().min(1).optional(),
          })
          .strict()
          .refine(
            (emoji) => (emoji.id === undefined) !== (emoji.name === undefined),
            'emoji requires exactly one of id or name',
          )
          .optional(),
      })
      .strict(),
  })
  .strict();
const Poll = z
  .object({
    question: PollQuestion,
    answers: z.array(PollAnswer).min(2).max(10),
    duration: z.number().int().min(1).max(768).default(24),
    allow_multiselect: z.boolean().optional(),
    layout_type: z.literal(1).default(1),
  })
  .strict();

const FileInput = z
  .object({
    filename: z.string().regex(FILE_NAME),
    data_uri: z.string().regex(DATA_URI),
    description: z.string().max(1024).optional(),
  })
  .strict();

const AllowedMentions = z
  .object({
    parse: z
      .array(z.enum(['users', 'roles', 'everyone']))
      .max(3)
      .default([]),
    users: z
      .array(z.string().regex(/^\d{17,20}$/u))
      .max(100)
      .optional(),
    roles: z
      .array(z.string().regex(/^\d{17,20}$/u))
      .max(100)
      .optional(),
  })
  .strict()
  .superRefine((mentions, context) => {
    if (mentions.parse.includes('users') && mentions.users !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['users'],
        message: 'users cannot be combined with parse:users',
      });
    if (mentions.parse.includes('roles') && mentions.roles !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['roles'],
        message: 'roles cannot be combined with parse:roles',
      });
  });

export const COMPOSER_INPUT_SCHEMA = z
  .object({
    content: z.string().max(20_000).optional(),
    embeds: z.array(Embed).max(10).optional(),
    components: z.array(z.unknown()).max(40).optional(),
    poll: Poll.optional(),
    files: z.array(FileInput).max(10).optional(),
    allowed_mentions: AllowedMentions.optional(),
    tts: z.boolean().optional(),
  })
  .strict();

export type ComposerArgs = z.input<typeof COMPOSER_INPUT_SCHEMA>;

export interface RawFile {
  readonly filename: string;
  readonly data: Buffer;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string;
  readonly description?: string;
}
export type ComposerRawFile = RawFile;

export interface ComposerPart {
  readonly mode: 'classic' | 'components_v2';
  readonly body: Record<string, unknown>;
  readonly files: RawFile[];
  readonly fileMetadata: Array<{
    readonly filename: string;
    readonly content_type: string;
    readonly size: number;
    readonly sha256: string;
    readonly description?: string;
  }>;
}

export interface ComposerResult {
  readonly parts: readonly ComposerPart[];
  readonly preview: Record<string, unknown>;
  readonly fingerprint: Record<string, unknown>;
  readonly attachmentReferences: string[];
}

function issue(message: string): never {
  throw new ValidationError([{ path: 'message', message, code: 'custom' }]);
}

function chunks(value: string): string[] {
  if (value.length === 0) return [];
  const result: string[] = [];
  for (let i = 0; i < value.length; i += 2000) {
    let end = Math.min(i + 2000, value.length);
    if (
      end < value.length &&
      value.charCodeAt(end - 1) >= 0xd800 &&
      value.charCodeAt(end - 1) <= 0xdbff
    )
      end -= 1;
    result.push(value.slice(i, end));
    i = end - 2000;
  }
  return result;
}

function embedText(embed: z.infer<typeof Embed>): number {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    (embed.author?.name.length ?? 0) +
    (embed.fields?.reduce((sum, field) => sum + field.name.length + field.value.length, 0) ?? 0)
  );
}

export function attachmentReferences(value: unknown): string[] {
  return [...refs(value)].sort();
}

function refs(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) refs(item, result);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (
        (key === 'url' || key === 'icon_url') &&
        typeof item === 'string' &&
        item.startsWith('attachment://')
      )
        result.add(item.slice(13));
      else refs(item, result);
    }
  }
  return result;
}

function parseFiles(files: readonly z.infer<typeof FileInput>[]): ComposerRawFile[] {
  const names = new Set<string>();
  const parsed = files.map((file) => {
    if (names.has(file.filename)) issue(`duplicate filename ${file.filename}`);
    names.add(file.filename);
    const match = DATA_URI.exec(file.data_uri);
    if (match === null) issue(`invalid base64 data URI for ${file.filename}`);
    const encoded = match[2]!;
    if (encoded.length % 4 === 1) issue(`invalid base64 data URI for ${file.filename}`);
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    const size = Math.floor((encoded.length * 3) / 4) - padding;
    if (size <= 0) issue(`file ${file.filename} is empty`);
    return { file, encoded, mime: match[1]!, size };
  });
  if (parsed.some((entry) => entry.size > MAX_FILE_BYTES)) issue('file exceeds 2 MiB');
  if (parsed.reduce((sum, entry) => sum + entry.size, 0) > MAX_FILE_BYTES)
    issue('aggregate file size exceeds 2 MiB');
  return parsed.map(({ file, encoded, mime, size }) => {
    const data = Buffer.from(encoded, 'base64');
    if (data.length !== size || data.toString('base64') !== encoded)
      issue(`invalid canonical base64 data URI for ${file.filename}`);
    return {
      filename: file.filename,
      data,
      contentType: mime,
      size,
      sha256: createHash('sha256').update(data).digest('hex'),
      ...(file.description === undefined ? {} : { description: file.description }),
    };
  });
}

function attach(body: Record<string, unknown>, files: readonly ComposerRawFile[]): void {
  if (files.length === 0) return;
  body.attachments = files.map((file, index) => ({
    id: String(index),
    filename: file.filename,
    ...(file.description === undefined ? {} : { description: file.description }),
  }));
}

export function composeMessage(
  args: unknown,
  options: { readonly edit?: boolean } = {},
): ComposerResult {
  const parsed = COMPOSER_INPUT_SCHEMA.safeParse(args);
  if (!parsed.success)
    issue(parsed.error.issues.map((item) => `${item.path.join('.')}: ${item.message}`).join('; '));
  const value = parsed.data;
  if (options.edit === true && value.poll !== undefined)
    issue('poll cannot be edited by the composer');
  if (options.edit === true && value.tts !== undefined)
    issue('tts cannot be edited by the composer');
  const files = parseFiles(value.files ?? []);
  const byName = new Map(files.map((file) => [file.filename, file]));
  const classicParts: Record<string, unknown>[] = [];
  const contentParts = chunks(value.content ?? '');
  const embeds = value.embeds ?? [];
  const hasContent = Object.hasOwn(value, 'content');
  const hasEmbeds = Object.hasOwn(value, 'embeds');
  if (embeds.reduce((sum, embed) => sum + embedText(embed), 0) > 6000)
    issue('embed text exceeds aggregate 6000 character limit');
  if (contentParts.length > 0) {
    classicParts.push({
      content: contentParts[0],
      ...(hasEmbeds ? { embeds } : {}),
      ...(value.poll === undefined ? {} : { poll: value.poll }),
    });
    for (const content of contentParts.slice(1)) classicParts.push({ content });
  } else if (embeds.length > 0 || value.poll !== undefined || (options.edit && hasContent)) {
    classicParts.push({
      ...(hasContent ? { content: value.content ?? '' } : {}),
      ...(hasEmbeds ? { embeds } : {}),
      ...(value.poll === undefined ? {} : { poll: value.poll }),
    });
  } else if (options.edit && (hasContent || hasEmbeds)) {
    classicParts.push({
      ...(hasContent ? { content: value.content ?? '' } : {}),
      ...(hasEmbeds ? { embeds } : {}),
    });
  }
  const v2Parts: Record<string, unknown>[] = [];
  if (value.components !== undefined) {
    if (!(options.edit && value.components.length === 0)) {
      const validation = validateComponentsV2(value.components, {
        attachmentNames: files.map((file) => file.filename),
        allowFileAttachments: options.edit === true,
      });
      if (!validation.valid)
        issue(validation.issues.map((item) => `${item.path}: ${item.message}`).join('; '));
    }
    v2Parts.push({ flags: 1 << 15, components: value.components });
  }
  if (options.edit && files.length === 0 && classicParts.length === 0 && v2Parts.length === 0)
    issue('edit requires at least one changed field');
  if (files.length > 0 && classicParts.length === 0 && v2Parts.length === 0) classicParts.push({});
  if (!options.edit && classicParts.length === 0 && v2Parts.length === 0)
    issue('at least one message payload is required');
  const bodies = [...classicParts, ...v2Parts];
  if (options.edit && bodies.length > 1)
    issue('edit payload must produce exactly one message part');
  if (bodies.length > MAX_PARTS) issue(`message would produce more than ${MAX_PARTS} parts`);
  const referenced = new Set<string>();
  for (const body of bodies) {
    for (const name of refs(body, referenced)) referenced.add(name);
  }
  if (!options.edit)
    for (const name of referenced)
      if (!byName.has(name)) issue(`attachment://${name} has no supplied file`);
  const normalizedMentions = value.allowed_mentions ?? { parse: [] };
  const parts: ComposerPart[] = bodies.map((body, index) => {
    const partFiles = files.filter(
      (file) => referenced.has(file.filename) && refs(body).has(file.filename),
    );
    if (index === 0) {
      for (const file of files) if (!referenced.has(file.filename)) partFiles.push(file);
    }
    const out: Record<string, unknown> = {
      ...body,
      allowed_mentions: normalizedMentions,
      ...(value.tts === undefined ? {} : { tts: value.tts }),
    };
    attach(out, partFiles);
    return {
      mode: out.flags === 1 << 15 ? 'components_v2' : 'classic',
      body: out,
      files: partFiles,
      fileMetadata: partFiles.map((file) => ({
        filename: file.filename,
        content_type: file.contentType,
        size: file.size,
        sha256: file.sha256,
        ...(file.description === undefined ? {} : { description: file.description }),
      })),
    };
  });
  const filePreview = files.map((file) => ({
    filename: file.filename,
    content_type: file.contentType,
    size: file.size,
    sha256: file.sha256,
  }));
  const fingerprint = {
    parts: parts.map((part) => ({
      body: part.body,
      files: part.fileMetadata,
    })),
  };
  return {
    parts,
    preview: {
      part_count: parts.length,
      modes: parts.map((part) => (part.body.flags === 1 << 15 ? 'components_v2' : 'classic')),
      parts: parts.map((part) => ({ mode: part.mode, body: part.body, files: part.fileMetadata })),
      content: value.content ?? null,
      embeds: value.embeds ?? [],
      components: value.components ?? null,
      poll: value.poll ?? null,
      files: filePreview,
    },
    fingerprint,
    attachmentReferences: attachmentReferences({
      components: value.components,
      embeds: value.embeds,
      poll: value.poll,
    }),
  };
}
