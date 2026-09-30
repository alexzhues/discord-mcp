import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { verifyExpectedBotIdentity } from '../../identity-lock.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, UserId } from '../_lib/snowflake.js';
import {
  acquireGuildChangeLock,
  GuildChangeRequestSchema,
  loadGuildChangeCheckpoint,
  loadGuildChangePlan,
  saveGuildChangeCheckpoint,
} from './_lib/guild-change.js';

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
type R = Record<string, unknown>;
type Op = {
  kind: 'role_patch' | 'channel_patch' | 'permission_overwrite';
  id: string;
  patch: R;
  before: R | null;
  after: R | null;
};
function operations(plan: Awaited<ReturnType<typeof loadGuildChangePlan>>): Op[] {
  const request = GuildChangeRequestSchema.parse(plan.changes);
  return [
    ...request.roles.map((x) => {
      const before = plan.before.roles.find((r) => String(r.id) === x.id) ?? null;
      return {
        kind: 'role_patch' as const,
        id: x.id,
        patch: x.patch as R,
        before,
        after: before ? { ...before, ...x.patch } : null,
      };
    }),
    ...request.channels.map((x) => {
      const before = plan.before.channels.find((r) => String(r.id) === x.id) ?? null;
      return {
        kind: 'channel_patch' as const,
        id: x.id,
        patch: x.patch as R,
        before,
        after: before ? { ...before, ...x.patch } : null,
      };
    }),
    ...request.permission_overwrites.map((x) => {
      const before =
        (
          plan.before.channels.find((r) => String(r.id) === x.channel_id)?.permission_overwrites as
            | R[]
            | undefined
        )?.find((o) => String(o.id) === x.overwrite_id) ?? null;
      return {
        kind: 'permission_overwrite' as const,
        id: `${x.channel_id}/${x.overwrite_id}`,
        patch: x as R,
        before,
        after: {
          type: x.type,
          allow: x.allow ?? String(before?.allow ?? '0'),
          deny: x.deny ?? String(before?.deny ?? '0'),
        },
      };
    }),
  ];
}
function fields(op: Op): string[] {
  return op.kind === 'permission_overwrite' ? ['type', 'allow', 'deny'] : Object.keys(op.patch);
}
function same(current: R | null, expected: R | null, keys: string[]): boolean {
  if (current === null || expected === null) return current === expected;
  return keys.every(
    (key) => JSON.stringify(current[key] ?? null) === JSON.stringify(expected[key] ?? null),
  );
}
async function state(guildId: string, botId: string) {
  const [roles, channels, bot] = await Promise.all([
    container.rest.get(Routes.guildRoles(guildId)) as Promise<R[]>,
    container.rest.get(Routes.guildChannels(guildId)) as Promise<R[]>,
    container.rest.get(Routes.guildMember(guildId, botId)) as Promise<R>,
  ]);
  return {
    roles,
    channels,
    bot_roles: Array.isArray(bot.roles) ? (bot.roles as string[]) : [],
  };
}
function botAccess(
  current: Awaited<ReturnType<typeof state>>,
  plan: Awaited<ReturnType<typeof loadGuildChangePlan>>,
): string | null {
  const roles = new Map(current.roles.map((role) => [String(role.id), role]));
  let permissions = BigInt(String(roles.get(plan.guild_id)?.permissions ?? '0'));
  for (const roleId of current.bot_roles)
    permissions |= BigInt(String(roles.get(roleId)?.permissions ?? '0'));
  if ((permissions & 8n) === 8n) return null;
  const changes = GuildChangeRequestSchema.parse(plan.changes);
  if (
    (changes.roles.length > 0 || changes.permission_overwrites.length > 0) &&
    (permissions & 268435456n) !== 268435456n
  )
    return 'BOT_MANAGE_ROLES';
  if (changes.channels.length > 0 && (permissions & 16n) !== 16n) return 'BOT_MANAGE_CHANNELS';
  return null;
}
function roleHierarchyBlocker(
  current: Awaited<ReturnType<typeof state>>,
  op: Op,
  guildId: string,
): string | null {
  if (op.kind !== 'role_patch') return null;
  const role = current.roles.find((item) => String(item.id) === op.id);
  if (!role) return 'ROLE_NOT_FOUND';
  if (role.managed === true) return 'MANAGED_ROLE';
  if (op.id === guildId) return 'EVERYONE_ROLE_LIMIT';
  const roles = new Map(current.roles.map((item) => [String(item.id), item]));
  const top = Math.max(0, ...current.bot_roles.map((id) => Number(roles.get(id)?.position ?? 0)));
  if (Number(role.position ?? 0) >= top) return 'ROLE_HIERARCHY';
  const botPermissions = current.bot_roles.reduce(
    (bits, id) => bits | BigInt(String(roles.get(id)?.permissions ?? '0')),
    BigInt(String(roles.get(guildId)?.permissions ?? '0')),
  );
  if (
    op.patch.permissions !== undefined &&
    (botPermissions & 8n) !== 8n &&
    (BigInt(String(op.before?.permissions ?? '0')) & ~botPermissions) !== 0n
  )
    return 'ROLE_PERMISSION_SCOPE';
  return null;
}
function resource(current: Awaited<ReturnType<typeof state>>, op: Op): R | null {
  if (op.kind === 'role_patch') return current.roles.find((r) => String(r.id) === op.id) ?? null;
  if (op.kind === 'channel_patch')
    return current.channels.find((r) => String(r.id) === op.id) ?? null;
  const [channel, overwrite] = op.id.split('/');
  return (
    (
      current.channels.find((r) => String(r.id) === channel)?.permission_overwrites as
        | R[]
        | undefined
    )?.find((r) => String(r.id) === overwrite) ?? null
  );
}
async function inverse(op: Op, guildId: string, pending: string[]): Promise<void> {
  if (op.kind === 'permission_overwrite') {
    const p = op.patch;
    if (!op.before)
      await container.rest.delete(
        Routes.channelPermission(String(p.channel_id), String(p.overwrite_id)),
      );
    else
      await container.rest.put(
        Routes.channelPermission(String(p.channel_id), String(p.overwrite_id)),
        {
          body: {
            type: op.before.type,
            allow: op.before.allow ?? '0',
            deny: op.before.deny ?? '0',
          },
        },
      );
    return;
  }
  const body = Object.fromEntries(
    pending
      .filter((key) => key !== 'position' && op.before?.[key] !== undefined)
      .map((key) => [key, op.before![key]]),
  );
  if (Object.keys(body).length > 0)
    await container.rest.patch(
      op.kind === 'role_patch' ? Routes.guildRole(guildId, op.id) : Routes.channel(op.id),
      { body },
    );
  if (pending.includes('position') && op.before?.position !== undefined)
    await container.rest.patch(
      op.kind === 'role_patch' ? Routes.guildRoles(guildId) : Routes.guildChannels(guildId),
      { body: [{ id: op.id, position: op.before.position }] },
    );
}

export default defineTool({
  name: 'guild_change_restore',
  category: 'guild',
  confirmation: 'payload_hash' as const,
  description:
    '**Purpose**: Restore selected supported inverses from an existing-guild change plan after a separate review. This is selective restoration, not whole-guild rollback.**',
  inputSchema: {
    guild_id: GuildId,
    expected_bot_id: UserId,
    plan_ref: z.string(),
    approval_id: Digest,
    operation_indexes: z.array(z.number().int().nonnegative()).min(1).max(100),
  },
  outputSchema: {
    status: z.enum(['completed', 'partial', 'blocked']),
    restored: z.array(z.number().int()),
    blocked: z.array(z.string()),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args, ctx) => {
    const plan = await loadGuildChangePlan(args.plan_ref, container.config);
    if (
      plan.guild_id !== args.guild_id ||
      plan.bot_id !== args.expected_bot_id ||
      plan.approval_id !== args.approval_id
    )
      return dualResult({
        text: 'Restore approval does not match the exact target or plan.',
        data: { status: 'blocked' as const, restored: [], blocked: ['PLAN_APPROVAL_MISMATCH'] },
      });
    await verifyExpectedBotIdentity(container.rest, args.expected_bot_id);
    const release = await acquireGuildChangeLock(args.plan_ref, container.config);
    try {
      const ops = operations(plan);
      const checkpoint = await loadGuildChangeCheckpoint(args.plan_ref, container.config);
      if (checkpoint.mode !== 'restore' && checkpoint.inflight !== null) {
        return dualResult({
          text: 'Apply reconciliation is required before restore.',
          data: {
            status: 'blocked' as const,
            restored: [],
            blocked: ['APPLY_RECONCILIATION_REQUIRED'],
          },
        });
      }
      const selectedValid = args.operation_indexes.some(
        (index) => ops[index] !== undefined && checkpoint.completed.includes(index),
      );
      if (checkpoint.mode !== 'restore' && !selectedValid) {
        return dualResult({
          text: 'Restore requires a completed applied operation.',
          data: { status: 'blocked' as const, restored: [], blocked: ['OPERATION_NOT_APPLIED'] },
        });
      }
      if (checkpoint.inflight !== null && !args.operation_indexes.includes(checkpoint.inflight)) {
        return dualResult({
          text: 'The in-flight inverse must be reconciled before selecting another operation.',
          data: {
            status: 'blocked' as const,
            restored: [],
            blocked: ['RESTORE_RECONCILIATION_REQUIRED'],
          },
        });
      }
      if (checkpoint.mode !== 'restore') {
        checkpoint.mode = 'restore';
        await saveGuildChangeCheckpoint(args.plan_ref, checkpoint, container.config);
      }
      const restored: number[] = [];
      const blocked: string[] = [];
      const selected =
        checkpoint.inflight === null
          ? args.operation_indexes
          : [
              checkpoint.inflight,
              ...args.operation_indexes.filter((index) => index !== checkpoint.inflight),
            ];
      for (const index of selected) {
        if (ctx.signal.aborted) {
          blocked.push('CANCELLED');
          break;
        }
        const op = ops[index];
        if (!op) {
          blocked.push(`OPERATION_${index}_NOT_FOUND`);
          continue;
        }
        if (checkpoint.inflight === index) {
          const inflightLive = await state(args.guild_id, args.expected_bot_id);
          const inflightResource = resource(inflightLive, op);
          if (same(inflightResource, op.before, fields(op))) {
            restored.push(index);
            checkpoint.completed = checkpoint.completed.filter((item) => item !== index);
            checkpoint.inflight = null;
            await saveGuildChangeCheckpoint(args.plan_ref, checkpoint, container.config);
            continue;
          }
        }
        if (!checkpoint.completed.includes(index)) {
          blocked.push(`OPERATION_${index}_NOT_APPLIED`);
          continue;
        }
        const live = await state(args.guild_id, args.expected_bot_id);
        const accessBlocker = botAccess(live, plan);
        if (accessBlocker) {
          blocked.push(accessBlocker);
          continue;
        }
        const hierarchyBlocker = roleHierarchyBlocker(live, op, args.guild_id);
        if (hierarchyBlocker) {
          blocked.push(hierarchyBlocker);
          continue;
        }
        const current = resource(live, op);
        const changedFields = fields(op);
        const pending = changedFields.filter((key) => !same(current, op.before, [key]));
        const resuming =
          checkpoint.inflight === index &&
          changedFields.every(
            (key) => same(current, op.before, [key]) || same(current, op.after, [key]),
          );
        if (!same(current, op.after, changedFields) && !resuming) {
          blocked.push(`OPERATION_${index}_EXTERNAL_DRIFT`);
          continue;
        }
        checkpoint.inflight = index;
        await saveGuildChangeCheckpoint(args.plan_ref, checkpoint, container.config);
        try {
          await inverse(op, args.guild_id, pending);
        } catch {
          blocked.push(`OPERATION_${index}_RESTORE_FAILED`);
          break;
        }
        if (
          !same(
            resource(await state(args.guild_id, args.expected_bot_id), op),
            op.before,
            fields(op),
          )
        ) {
          blocked.push(`OPERATION_${index}_READBACK_MISMATCH`);
          break;
        }
        restored.push(index);
        checkpoint.completed = checkpoint.completed.filter((item) => item !== index);
        checkpoint.inflight = null;
        await saveGuildChangeCheckpoint(args.plan_ref, checkpoint, container.config);
      }
      return dualResult({
        text: restored.length
          ? `Restored ${restored.length} selected change inverse(s) with readback.`
          : 'No change inverse was restored.',
        data: {
          status:
            restored.length === 0
              ? ('blocked' as const)
              : blocked.length
                ? ('partial' as const)
                : ('completed' as const),
          restored,
          blocked,
        },
      });
    } finally {
      await release();
    }
  },
});
