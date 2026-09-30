import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import { resolveBlueprintStateDirectory } from './blueprint.state-path.js';
import { blueprintSigningSecret } from './blueprint.trust.js';
import { canonicalJson } from './blueprint.validation.js';

const Snowflake = z.string().regex(/^\d{17,20}$/);
export const RolePatchSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    color: z.number().int().min(0).max(0xffffff).optional(),
    permissions: z.string().regex(/^\d+$/).max(20).optional(),
    hoist: z.boolean().optional(),
    mentionable: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'role patch must contain a field');

export const ChannelPatchSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    topic: z.string().max(1024).nullable().optional(),
    nsfw: z.boolean().optional(),
    rate_limit_per_user: z.number().int().min(0).max(21600).optional(),
    parent_id: Snowflake.nullable().optional(),
    position: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'channel patch must contain a field');

// Kept separate from Discord's enormous channel schema: this is the deliberately
// bounded, existing-resource-only change surface.
export const GuildChangeRequestSchema = z
  .object({
    channels: z
      .array(
        z
          .object({
            id: Snowflake,
            patch: ChannelPatchSchema,
          })
          .strict(),
      )
      .max(50)
      .default([]),
    roles: z
      .array(
        z
          .object({
            id: Snowflake,
            patch: RolePatchSchema,
          })
          .strict(),
      )
      .max(50)
      .default([]),
    permission_overwrites: z
      .array(
        z
          .object({
            channel_id: Snowflake,
            overwrite_id: Snowflake,
            type: z.union([z.literal(0), z.literal(1)]),
            allow: z.string().regex(/^\d+$/).max(20).optional(),
            deny: z.string().regex(/^\d+$/).max(20).optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.channels.length === 0 &&
      value.roles.length === 0 &&
      value.permission_overwrites.length === 0
    )
      ctx.addIssue({
        code: 'custom',
        message: 'change request must contain at least one operation',
      });
    const check = (items: readonly { id: string }[], path: string) => {
      const seen = new Set<string>();
      items.forEach((item, index) => {
        if (seen.has(item.id))
          ctx.addIssue({
            code: 'custom',
            path: [path, index, 'id'],
            message: 'duplicate operation target',
          });
        seen.add(item.id);
      });
    };
    check(value.channels, 'channels');
    check(value.roles, 'roles');
    const overwriteSeen = new Set<string>();
    value.permission_overwrites.forEach((item, index) => {
      const key = `${item.channel_id}/${item.overwrite_id}`;
      if (overwriteSeen.has(key))
        ctx.addIssue({
          code: 'custom',
          path: ['permission_overwrites', index],
          message: 'duplicate permission overwrite target',
        });
      overwriteSeen.add(key);
    });
  });

export type GuildChangeRequest = z.infer<typeof GuildChangeRequestSchema>;

export interface GuildChangeSnapshot {
  guild: Record<string, unknown>;
  bot_roles: string[];
  roles: Array<Record<string, unknown>>;
  channels: Array<Record<string, unknown>>;
}

export interface GuildChangePlan {
  schema_version: 'guild_change_plan.v1';
  plan_id: string;
  approval_id: string;
  guild_id: string;
  bot_id: string;
  request: string;
  changes: GuildChangeRequest;
  before: GuildChangeSnapshot;
  created_at: string;
}

export interface GuildChangeCheckpoint {
  mode?: 'apply' | 'restore';
  completed: number[];
  inflight: number | null;
}

const PLAN_RE = /^gcp1\.[a-f0-9]{64}$/;
function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
function refForPlan(planId: string, secret: string): string {
  return `gcp1.${createHmac('sha256', secret).update(`guild-change-ref.v1\0${planId}`).digest('hex')}`;
}
function authTag(plan: GuildChangePlan, secret: string): string {
  return createHmac('sha256', secret)
    .update(`guild-change-plan.v1\0${canonicalJson(plan)}`)
    .digest('hex');
}

export function getGuildChangeContext(config: Config) {
  return {
    directory: resolveBlueprintStateDirectory(config),
    secret: blueprintSigningSecret(config),
  };
}

export function createGuildChangePlan(
  input: Omit<GuildChangePlan, 'plan_id' | 'approval_id' | 'created_at'>,
  _secret: string,
): GuildChangePlan {
  const created_at = new Date().toISOString();
  const base = {
    ...input,
    plan_id: digest({ ...input, created_at, nonce: randomUUID(), kind: 'guild-change-plan.v1' }),
    approval_id: '',
    created_at,
  };
  const plan = {
    ...base,
    approval_id: digest({
      plan_id: base.plan_id,
      changes: base.changes,
      guild_id: base.guild_id,
      bot_id: base.bot_id,
    }),
  };
  return plan;
}

export async function saveGuildChangePlan(plan: GuildChangePlan, config: Config): Promise<string> {
  const { directory, secret } = getGuildChangeContext(config);
  const ref = refForPlan(plan.plan_id, secret);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${ref.slice(5)}.json`);
  const envelope = {
    schema_version: 'guild_change_plan_envelope.v1',
    reference: ref,
    plan,
    auth_tag: authTag(plan, secret),
  };
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(envelope), { mode: 0o600 });
  await rename(tmp, path);
  return ref;
}

export async function loadGuildChangePlan(
  planRef: string,
  config: Config,
): Promise<GuildChangePlan> {
  if (!PLAN_RE.test(planRef)) throw new Error('Invalid guild change plan reference.');
  const { directory, secret } = getGuildChangeContext(config);
  const raw = JSON.parse(await readFile(join(directory, `${planRef.slice(5)}.json`), 'utf8')) as {
    reference: string;
    plan: GuildChangePlan;
    auth_tag: string;
  };
  if (raw.reference !== planRef || !hmacEqual(authTag(raw.plan, secret), raw.auth_tag))
    throw new Error('Guild change plan proof is invalid.');
  return raw.plan;
}

const checkpointAuth = (planRef: string, state: GuildChangeCheckpoint, secret: string) =>
  createHmac('sha256', secret)
    .update(`guild-change-checkpoint.v1\0${planRef}\0${canonicalJson(state)}`)
    .digest('hex');

export async function loadGuildChangeCheckpoint(
  planRef: string,
  config: Config,
): Promise<GuildChangeCheckpoint> {
  const { directory, secret } = getGuildChangeContext(config);
  try {
    const envelope = JSON.parse(
      await readFile(join(directory, `${planRef.slice(5)}.checkpoint.json`), 'utf8'),
    ) as { state: GuildChangeCheckpoint; auth_tag: string };
    if (!hmacEqual(envelope.auth_tag, checkpointAuth(planRef, envelope.state, secret)))
      throw new Error('Guild change checkpoint proof is invalid.');
    return { ...envelope.state, mode: envelope.state.mode ?? 'apply' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { mode: 'apply', completed: [], inflight: null };
    throw error;
  }
}
export async function saveGuildChangeCheckpoint(
  planRef: string,
  state: GuildChangeCheckpoint,
  config: Config,
): Promise<void> {
  const { directory, secret } = getGuildChangeContext(config);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${planRef.slice(5)}.checkpoint.json`);
  const tmp = `${path}.tmp-${process.pid}`;
  const persisted = { ...state, mode: state.mode ?? 'apply' } as GuildChangeCheckpoint;
  await writeFile(
    tmp,
    JSON.stringify({ state: persisted, auth_tag: checkpointAuth(planRef, persisted, secret) }),
    { mode: 0o600 },
  );
  await rename(tmp, path);
}

export async function acquireGuildChangeLock(
  planRef: string,
  config: Config,
): Promise<() => Promise<void>> {
  const { directory } = getGuildChangeContext(config);
  await mkdir(directory, { recursive: true });
  const lock = join(directory, `${planRef.slice(5)}.lock`);
  const claim = async () => {
    await mkdir(lock);
    try {
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), {
        mode: 0o600,
      });
    } catch (error) {
      await rm(lock, { recursive: true, force: true });
      throw error;
    }
  };
  try {
    await claim();
  } catch (initialError) {
    if ((initialError as NodeJS.ErrnoException).code !== 'EEXIST') throw initialError;
    let recovery: Awaited<ReturnType<typeof open>> | undefined;
    try {
      recovery = await open(`${lock}.recover`, 'wx', 0o600);
      await recovery.writeFile(`${process.pid}\n`);
      const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as {
        pid?: number;
      };
      if (!Number.isInteger(owner.pid) || (owner.pid ?? 0) <= 0) throw new Error('missing owner');
      try {
        process.kill(owner.pid!, 0);
        throw new Error('active owner');
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError;
      }
      await rm(lock, { recursive: true, force: true });
      await claim();
    } catch {
      throw new Error('Guild change plan is already active.');
    } finally {
      if (recovery !== undefined) {
        await recovery.close();
        await rm(`${lock}.recover`, { force: true });
      }
    }
  }
  return async () => {
    await rm(lock, { recursive: true, force: true });
  };
}

export function snapshotDigest(snapshot: GuildChangeSnapshot): string {
  return digest(snapshot);
}
export function hmacEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
