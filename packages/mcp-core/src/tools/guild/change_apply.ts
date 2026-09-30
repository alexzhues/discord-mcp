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
  type GuildChangeSnapshot,
  loadGuildChangeCheckpoint,
  loadGuildChangePlan,
  saveGuildChangeCheckpoint,
  snapshotDigest,
} from './_lib/guild-change.js';

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
type RecordValue = Record<string, unknown>;
type ChangeOperation = {
  kind: 'role_patch' | 'channel_patch' | 'permission_overwrite';
  id: string;
  patch: RecordValue;
  before: RecordValue | null;
  after: RecordValue | null;
};

async function currentState(guildId: string, botId: string): Promise<GuildChangeSnapshot> {
  const [guild, bot, roles, channels] = await Promise.all([
    container.rest.get(Routes.guild(guildId)) as Promise<RecordValue>,
    container.rest.get(Routes.guildMember(guildId, botId)) as Promise<RecordValue>,
    container.rest.get(Routes.guildRoles(guildId)) as Promise<RecordValue[]>,
    container.rest.get(Routes.guildChannels(guildId)) as Promise<RecordValue[]>,
  ]);
  return {
    guild,
    bot_roles: Array.isArray(bot.roles) ? (bot.roles as string[]) : [],
    roles,
    channels,
  };
}
function botAccess(
  snapshot: GuildChangeSnapshot,
  plan: Awaited<ReturnType<typeof loadGuildChangePlan>>,
): string | null {
  const roles = new Map(snapshot.roles.map((role) => [String(role.id), role]));
  let permissions = BigInt(String(roles.get(plan.guild_id)?.permissions ?? '0'));
  for (const roleId of snapshot.bot_roles)
    permissions |= BigInt(String(roles.get(roleId)?.permissions ?? '0'));
  const changes = GuildChangeRequestSchema.parse(plan.changes);
  if ((permissions & 8n) === 8n) return null;
  if (changes.roles.length > 0 && (permissions & 268435456n) !== 268435456n)
    return 'BOT_MANAGE_ROLES';
  if (changes.channels.length > 0 && (permissions & 16n) !== 16n) return 'BOT_MANAGE_CHANNELS';
  if (changes.permission_overwrites.length > 0 && (permissions & 268435456n) !== 268435456n)
    return 'BOT_MANAGE_ROLES';
  return null;
}
function roleHierarchyBlocker(
  snapshot: GuildChangeSnapshot,
  op: ChangeOperation,
  guildId: string,
): string | null {
  if (op.kind !== 'role_patch') return null;
  const role = snapshot.roles.find((item) => String(item.id) === op.id);
  if (!role) return 'ROLE_NOT_FOUND';
  if (role.managed === true) return 'MANAGED_ROLE';
  if (op.id === guildId) return 'EVERYONE_ROLE_LIMIT';
  const roles = new Map(snapshot.roles.map((item) => [String(item.id), item]));
  const top = Math.max(0, ...snapshot.bot_roles.map((id) => Number(roles.get(id)?.position ?? 0)));
  if (Number(role.position ?? 0) >= top) return 'ROLE_HIERARCHY';
  const botPermissions = snapshot.bot_roles.reduce(
    (bits, id) => bits | BigInt(String(roles.get(id)?.permissions ?? '0')),
    BigInt(String(roles.get(guildId)?.permissions ?? '0')),
  );
  if (
    op.patch.permissions !== undefined &&
    (botPermissions & 8n) !== 8n &&
    (BigInt(String(op.patch.permissions)) & ~botPermissions) !== 0n
  )
    return 'ROLE_PERMISSION_SCOPE';
  return null;
}
function operationList(plan: Awaited<ReturnType<typeof loadGuildChangePlan>>): ChangeOperation[] {
  const request = GuildChangeRequestSchema.parse(plan.changes);
  return [
    ...request.roles.map((x) => {
      const before = plan.before.roles.find((r) => String(r.id) === x.id) ?? null;
      return {
        kind: 'role_patch' as const,
        id: x.id,
        patch: x.patch as RecordValue,
        before,
        after: before ? { ...before, ...x.patch } : null,
      };
    }),
    ...request.channels.map((x) => {
      const before = plan.before.channels.find((r) => String(r.id) === x.id) ?? null;
      return {
        kind: 'channel_patch' as const,
        id: x.id,
        patch: x.patch as RecordValue,
        before,
        after: before ? { ...before, ...x.patch } : null,
      };
    }),
    ...request.permission_overwrites.map((x) => {
      const channel = plan.before.channels.find((r) => String(r.id) === x.channel_id);
      const before =
        (channel?.permission_overwrites as RecordValue[] | undefined)?.find(
          (o) => String(o.id) === x.overwrite_id,
        ) ?? null;
      return {
        kind: 'permission_overwrite' as const,
        id: `${x.channel_id}/${x.overwrite_id}`,
        patch: x as RecordValue,
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
function fieldsFor(op: ChangeOperation): string[] {
  return op.kind === 'permission_overwrite' ? ['type', 'allow', 'deny'] : Object.keys(op.patch);
}
function sameFields(
  current: RecordValue | null,
  expected: RecordValue | null,
  fields: string[],
): boolean {
  if (current === null || expected === null) return current === expected;
  return fields.every(
    (field) => JSON.stringify(current[field] ?? null) === JSON.stringify(expected[field] ?? null),
  );
}
function resource(state: GuildChangeSnapshot, op: ChangeOperation): RecordValue | null {
  if (op.kind === 'role_patch') return state.roles.find((r) => String(r.id) === op.id) ?? null;
  if (op.kind === 'channel_patch')
    return state.channels.find((r) => String(r.id) === op.id) ?? null;
  const [channelId, overwriteId] = op.id.split('/');
  const channel = state.channels.find((r) => String(r.id) === channelId);
  return (
    (channel?.permission_overwrites as RecordValue[] | undefined)?.find(
      (o) => String(o.id) === overwriteId,
    ) ?? null
  );
}
async function execute(
  op: ChangeOperation,
  guildId: string,
  reason: string,
  pending: string[],
): Promise<void> {
  if (op.kind === 'permission_overwrite') {
    const p = op.patch;
    await container.rest.put(
      Routes.channelPermission(String(p.channel_id), String(p.overwrite_id)),
      {
        body: {
          type: op.after?.type ?? p.type,
          allow: op.after?.allow ?? '0',
          deny: op.after?.deny ?? '0',
        },
        reason,
      },
    );
    return;
  }
  const { position, ...body } = op.patch;
  const bodyToSend = Object.fromEntries(
    Object.keys(body)
      .filter((key) => pending.includes(key))
      .map((key) => [key, body[key]]),
  );
  if (Object.keys(bodyToSend).length > 0)
    await container.rest.patch(
      op.kind === 'role_patch' ? Routes.guildRole(guildId, op.id) : Routes.channel(op.id),
      { body: bodyToSend, reason },
    );
  if (position !== undefined && pending.includes('position'))
    await container.rest.patch(
      op.kind === 'role_patch' ? Routes.guildRoles(guildId) : Routes.guildChannels(guildId),
      { body: [{ id: op.id, position }], reason },
    );
}

export default defineTool({
  name: 'guild_change_apply',
  category: 'guild',
  confirmation: 'payload_hash' as const,
  description:
    '**Purpose**: Apply one approved existing-guild change plan with exact snapshot matching, checkpointed operations, resume, and final readback.**',
  inputSchema: {
    guild_id: GuildId,
    expected_bot_id: UserId,
    plan_ref: z.string(),
    approval_id: Digest,
  },
  outputSchema: {
    status: z.enum(['complete', 'partial', 'blocked']),
    plan_id: Digest.nullable(),
    completed: z.array(z.number().int()),
    remaining: z.number().int().nonnegative(),
    blockers: z.array(z.string()),
    snapshot_id_after: Digest.nullable(),
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
        text: 'Guild change approval does not match the exact target or plan.',
        data: {
          status: 'blocked' as const,
          plan_id: plan.plan_id,
          completed: [],
          remaining: 0,
          blockers: ['PLAN_APPROVAL_MISMATCH'],
          snapshot_id_after: null,
        },
      });
    await verifyExpectedBotIdentity(container.rest, args.expected_bot_id);
    const release = await acquireGuildChangeLock(args.plan_ref, container.config);
    try {
      const operations = operationList(plan);
      const checkpoint = await loadGuildChangeCheckpoint(args.plan_ref, container.config);
      if (checkpoint.mode === 'restore') {
        return dualResult({
          text: 'This plan has entered restore mode and cannot be reapplied.',
          data: {
            status: 'blocked' as const,
            plan_id: plan.plan_id,
            completed: checkpoint.completed,
            remaining: operations.length - checkpoint.completed.length,
            blockers: ['PLAN_RESTORE_MODE'],
            snapshot_id_after: null,
          },
        });
      }
      const completed = [...checkpoint.completed];
      const blockers: string[] = [];
      for (let i = 0; i < operations.length; i++) {
        const op = operations[i]!;
        const live = await currentState(args.guild_id, args.expected_bot_id);
        const accessBlocker = botAccess(live, plan);
        if (accessBlocker) {
          blockers.push(accessBlocker);
          break;
        }
        const fields = fieldsFor(op);
        const current = resource(live, op);
        if (completed.includes(i)) {
          if (!sameFields(current, op.after, fields)) {
            blockers.push(`OPERATION_${i}_EXTERNAL_DRIFT`);
            break;
          }
          continue;
        }
        const hierarchyBlocker = roleHierarchyBlocker(live, op, args.guild_id);
        if (hierarchyBlocker) {
          blockers.push(hierarchyBlocker);
          break;
        }
        const pending = fields.filter((field) => !sameFields(current, op.after, [field]));
        if (pending.length === 0) {
          completed.push(i);
          await saveGuildChangeCheckpoint(
            args.plan_ref,
            { completed, inflight: null },
            container.config,
          );
          continue;
        }
        if (
          pending.some(
            (field) =>
              !sameFields(current, op.before, [field]) && !sameFields(current, op.after, [field]),
          )
        ) {
          blockers.push(`OPERATION_${i}_EXTERNAL_DRIFT`);
          break;
        }
        if (ctx.signal.aborted) {
          blockers.push('CANCELLED');
          break;
        }
        await saveGuildChangeCheckpoint(
          args.plan_ref,
          { completed, inflight: i },
          container.config,
        );
        try {
          await execute(op, args.guild_id, plan.request, pending);
        } catch {
          blockers.push(`OPERATION_${i}_FAILED`);
          break;
        }
        if (ctx.signal.aborted) {
          blockers.push('CANCELLED');
          break;
        }
        if (
          !sameFields(
            resource(await currentState(args.guild_id, args.expected_bot_id), op),
            op.after,
            fields,
          )
        ) {
          blockers.push(`OPERATION_${i}_READBACK_MISMATCH`);
          break;
        }
        completed.push(i);
        await saveGuildChangeCheckpoint(
          args.plan_ref,
          { completed, inflight: null },
          container.config,
        );
      }
      const after = await currentState(args.guild_id, args.expected_bot_id);
      const remaining = operations.length - completed.length;
      return dualResult({
        text:
          remaining === 0 && blockers.length === 0
            ? `Applied and read back ${completed.length} guild change(s).`
            : `Applied ${completed.length} guild change(s); resume only after resolving blockers.`,
        data: {
          status:
            remaining === 0 && blockers.length === 0
              ? ('complete' as const)
              : completed.length
                ? ('partial' as const)
                : ('blocked' as const),
          plan_id: plan.plan_id,
          completed,
          remaining,
          blockers,
          snapshot_id_after: snapshotDigest(after),
        },
      });
    } finally {
      await release();
    }
  },
});
