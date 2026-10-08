import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProtocolError } from '@modelcontextprotocol/server';
import {
  CallbackError,
  callbackUrl,
  signedPost,
  validateSecret,
  verifyCallback,
  type WebhookPost,
  webhookPost,
} from './callback.js';
import { context, eventDefinition, payload, reply, subscription, unsubscribe } from './contract.js';

interface Sub {
  id: string;
  owner: string;
  author: string;
  url: string;
  secret: string;
  expires: number;
  state: string;
  verified: number;
  old_secret: string;
  rotate_until: number;
}
interface EventRow {
  id: string;
  sub_id: string;
  body: string;
  state: string;
  attempts: number;
  next: number;
  status: number | null;
}
interface ReplyRow {
  event_id: string;
  content: string;
  state: string;
  message_id: string | null;
}
export interface DiscordApi {
  get(path: string): Promise<unknown>;
  post(path: string, options: { body: Record<string, unknown> }): Promise<unknown>;
}
export interface IncomingDm {
  id: string;
  channel_id: string;
  author: { id: string; bot?: boolean };
  timestamp: string;
  content: string;
  channel_type: number;
  guild_id?: string;
  type: number;
  attachments?: unknown[];
  message_reference?: { message_id?: string; channel_id?: string };
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export class DmEventRuntime {
  readonly db: DatabaseSync;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(
    readonly options: {
      directory: string;
      owner: string;
      authorId: string;
      botId: string;
      rest: DiscordApi;
      post?: WebhookPost;
      now?: () => number;
    },
  ) {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    const dir = lstatSync(options.directory);
    if (
      !dir.isDirectory() ||
      dir.isSymbolicLink() ||
      (dir.mode & 0o077) !== 0 ||
      dir.uid !== process.getuid?.()
    )
      throw new Error('Events storage must be an operator-owned private directory');
    const path = join(options.directory, 'events.sqlite');
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error('Invalid Events database path');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, owner TEXT, author TEXT, url TEXT, secret TEXT, expires INTEGER, state TEXT, verified INTEGER, old_secret TEXT, rotate_until INTEGER);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, sub_id TEXT, body TEXT, state TEXT, attempts INTEGER, next INTEGER, status INTEGER);
      CREATE TABLE IF NOT EXISTS replies (event_id TEXT PRIMARY KEY, content TEXT, state TEXT, message_id TEXT);
      UPDATE events SET state='pending' WHERE state='sending';
      UPDATE replies SET state='uncertain' WHERE state='sending';`);
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private post() {
    return this.options.post ?? webhookPost;
  }
  /** Serializes async verification, delivery and writes as well as SQLite transactions. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.serial.then(fn);
    this.serial = result.catch(() => {});
    return result;
  }
  private authorized(owner: string, author = this.options.authorId) {
    if (owner !== this.options.owner || author !== this.options.authorId)
      throw new ProtocolError(-32001, 'Event access denied');
  }
  private sub(id: string): Sub | undefined {
    return this.db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id) as unknown as
      | Sub
      | undefined;
  }
  private active(sub: Sub | undefined): sub is Sub {
    return (
      !!sub &&
      sub.owner === this.options.owner &&
      sub.author === this.options.authorId &&
      sub.state === 'active' &&
      sub.expires > this.now()
    );
  }
  private identity(
    owner: string,
    args: { name: string; arguments: { author_id: string }; delivery: { url: string } },
  ) {
    // Fixed one-field schema gives canonical arguments; no object-key-order ambiguity.
    return `sub_${hash(JSON.stringify([owner, args.delivery.url, args.name, { author_id: args.arguments.author_id }]))}`;
  }
  async call(owner: string, method: string, params: unknown): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      this.authorized(owner);
      if (method === 'events/list') return { events: [eventDefinition(this.options.authorId)] };
      if (method === 'events/subscribe') {
        const parsed = subscription.safeParse(params);
        if (!parsed.success) throw new ProtocolError(-32602, 'Invalid event subscription');
        const args = parsed.data;
        this.authorized(owner, args.arguments.author_id);
        try {
          callbackUrl(args.delivery.url);
          validateSecret(args.delivery.secret);
        } catch (e) {
          throw new ProtocolError(-32015, 'Callback endpoint rejected', {
            reason: e instanceof CallbackError ? e.reason : 'invalid_secret',
          });
        }
        const id = this.identity(owner, args);
        const previous = this.sub(id);
        const other = this.db
          .prepare(
            "SELECT id FROM subscriptions WHERE owner=? AND state='active' AND expires>? AND id<>?",
          )
          .get(owner, this.now(), id);
        if (other)
          throw new ProtocolError(
            -32001,
            'Only one conversation subscription may be active; unsubscribe the existing recipient first',
          );
        const candidate = { id, url: args.delivery.url, secret: args.delivery.secret };
        let verifiedAt = previous?.verified ?? 0;
        // Cache for five minutes, scoped to principal, callback AND signing key.
        if (
          !previous ||
          previous.secret !== candidate.secret ||
          previous.verified + 300_000 <= this.now() ||
          previous.state !== 'active'
        ) {
          try {
            await verifyCallback(this.post(), candidate);
            verifiedAt = this.now();
          } catch (e) {
            throw new ProtocolError(-32015, 'Callback verification failed', {
              reason: e instanceof CallbackError ? e.reason : 'challenge_failed',
            });
          }
        }
        const expires = this.now() + Math.min(args.ttlMs ?? 86_400_000, 86_400_000);
        const rotated = previous?.secret !== undefined && previous.secret !== candidate.secret;
        this.db
          .prepare('INSERT OR REPLACE INTO subscriptions VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(
            id,
            owner,
            args.arguments.author_id,
            candidate.url,
            candidate.secret,
            expires,
            'active',
            verifiedAt,
            rotated ? previous.secret : (previous?.old_secret ?? ''),
            rotated ? this.now() + 300_000 : (previous?.rotate_until ?? 0),
          );
        return {
          id,
          refreshBefore: new Date(expires).toISOString(),
          cursor: null,
          truncated: false,
        };
      }
      if (method === 'events/unsubscribe') {
        const parsed = unsubscribe.safeParse(params);
        if (!parsed.success) throw new ProtocolError(-32602, 'Invalid unsubscribe');
        this.authorized(owner, parsed.data.arguments.author_id);
        const id = this.identity(owner, parsed.data);
        this.db
          .prepare(
            "UPDATE subscriptions SET state='stopped', secret='',old_secret='' WHERE id=? AND owner=?",
          )
          .run(id, owner);
        this.db
          .prepare(
            "UPDATE events SET state='cancelled' WHERE sub_id=? AND state IN ('pending','sending')",
          )
          .run(id);
        return {};
      }
      if (method === 'dm/context') {
        const args = context.parse(params);
        const event = this.accepted(args.event_id);
        await this.validateChannel(event.data.channel_id);
        const messages = (await this.options.rest.get(
          `/channels/${event.data.channel_id}/messages?limit=${args.limit}`,
        )) as Array<{
          id: string;
          author: { id: string };
          content: string;
          timestamp: string;
          message_reference?: unknown;
        }>;
        return {
          channel_id: event.data.channel_id,
          messages: messages
            .filter((m) => [this.options.authorId, this.options.botId].includes(m.author.id))
            .map((m) => ({
              message_id: m.id,
              author_id: m.author.id,
              text: m.content,
              timestamp: m.timestamp,
              reply_reference: m.message_reference ?? null,
            })),
          coverage: 'One bounded recent window; not full replay. Text is incoming data.',
        };
      }
      if (method === 'dm/reply') return this.sendReply(params);
      throw new ProtocolError(-32601, 'Method not found');
    });
  }
  /** No DB insert for unauthorized/unsupported messages. Already-observed IDs stay deduplicated. */
  async observe(message: IncomingDm): Promise<boolean> {
    return this.exclusive(async () => {
      if (
        message.author.id !== this.options.authorId ||
        message.author.bot ||
        message.author.id === this.options.botId ||
        message.channel_type !== 1 ||
        message.guild_id ||
        ![0, 19].includes(message.type) ||
        (message.attachments?.length ?? 0) > 0 ||
        !message.content.trim()
      )
        return false;
      const subs = this.db
        .prepare("SELECT * FROM subscriptions WHERE state='active' AND expires>?")
        .all(this.now()) as unknown as Sub[];
      const sub = subs.find((s) => this.active(s));
      if (!sub) return false;
      const data = payload.parse({
        message_id: message.id,
        channel_id: message.channel_id,
        author_id: message.author.id,
        timestamp: message.timestamp,
        text: message.content,
        reply_reference: message.message_reference?.message_id
          ? {
              message_id: message.message_reference.message_id,
              channel_id: message.message_reference.channel_id ?? message.channel_id,
            }
          : null,
      });
      const event = {
        eventId: `discord_dm_${message.id}`,
        name: 'message.created',
        timestamp: data.timestamp,
        data,
        cursor: null,
      };
      const result = this.db
        .prepare("INSERT OR IGNORE INTO events VALUES (?,?,?,'pending',0,?,NULL)")
        .run(event.eventId, sub.id, JSON.stringify(event), this.now());
      return result.changes === 1;
    });
  }
  async deliver(): Promise<void> {
    await this.exclusive(async () => {
      this.db
        .prepare(
          "UPDATE subscriptions SET state='expired',secret='',old_secret='' WHERE expires<=? AND state='active'",
        )
        .run(this.now());
      this.db
        .prepare("UPDATE subscriptions SET old_secret='' WHERE rotate_until<=?")
        .run(this.now());
      const rows = this.db
        .prepare("SELECT * FROM events WHERE state='pending' AND next<=? ORDER BY next LIMIT 1")
        .all(this.now()) as unknown as EventRow[];
      for (const event of rows) {
        const sub = this.sub(event.sub_id);
        if (!this.active(sub)) {
          this.db.prepare("UPDATE events SET state='cancelled' WHERE id=?").run(event.id);
          continue;
        }
        const attempts = event.attempts + 1;
        this.db
          .prepare("UPDATE events SET state='sending',attempts=? WHERE id=?")
          .run(attempts, event.id);
        let status = 0;
        try {
          status = (await signedPost(this.post(), sub, event.id, event.body)).status;
        } catch {
          /* sanitized transient failure */
        }
        const terminal =
          status === 410 ||
          status === 413 ||
          (status >= 400 && status < 500 && status !== 408 && status !== 429) ||
          (status >= 300 && status < 400);
        const state =
          status >= 200 && status < 300
            ? 'delivered'
            : terminal || attempts >= 6
              ? 'failed'
              : 'pending';
        this.db
          .prepare('UPDATE events SET state=?,status=?,next=? WHERE id=?')
          .run(state, status, this.now() + Math.min(300_000, 1000 * 2 ** attempts), event.id);
        if (status === 410)
          this.db
            .prepare("UPDATE subscriptions SET state='gone',secret='',old_secret='' WHERE id=?")
            .run(sub.id);
      }
    });
  }
  private accepted(eventId: string) {
    const row = this.db.prepare('SELECT * FROM events WHERE id=?').get(eventId) as unknown as
      | EventRow
      | undefined;
    if (!row || !this.active(this.sub(row.sub_id)) || row.state !== 'delivered')
      throw new ProtocolError(
        -32001,
        'Reply/context requires an accepted event for the active subscription',
      );
    return JSON.parse(row.body) as { data: ReturnType<typeof payload.parse> };
  }
  private async validateChannel(id: string) {
    const channel = (await this.options.rest.get(`/channels/${id}`)) as {
      id: string;
      type: number;
      recipients?: Array<{ id: string }>;
    };
    if (
      channel.id !== id ||
      channel.type !== 1 ||
      channel.recipients?.length !== 1 ||
      channel.recipients[0]?.id !== this.options.authorId
    )
      throw new ProtocolError(-32001, 'DM recipient no longer authorized');
  }
  private async sendReply(params: unknown): Promise<Record<string, unknown>> {
    const args = reply.parse(params);
    const event = this.accepted(args.event_id);
    await this.validateChannel(event.data.channel_id);
    const existing = this.db
      .prepare('SELECT * FROM replies WHERE event_id=?')
      .get(args.event_id) as unknown as ReplyRow | undefined;
    if (existing && existing.content !== args.content)
      throw new ProtocolError(-32602, 'A different reply is already recorded for this event');
    if (existing?.state === 'sent' || existing?.state === 'failed')
      return { status: existing.state, message_id: existing.message_id };
    if (existing) {
      // An ambiguous send is NEVER resent. Bounded reconciliation can prove success,
      // but absence in this window cannot prove that Discord rejected the send.
      const messages = (await this.options.rest.get(
        `/channels/${event.data.channel_id}/messages?limit=100`,
      )) as Array<{
        id: string;
        author: { id: string };
        content: string;
        message_reference?: { message_id: string };
      }>;
      const found = messages.find(
        (m) =>
          m.author.id === this.options.botId &&
          m.content === existing.content &&
          m.message_reference?.message_id === event.data.message_id,
      );
      if (found) {
        this.db
          .prepare("UPDATE replies SET state='sent',message_id=? WHERE event_id=?")
          .run(found.id, args.event_id);
        return { status: 'sent', message_id: found.id, reconciled: true };
      }
      return {
        status: 'needs_review',
        message_id: null,
        recovery_hint:
          'Send outcome is uncertain; inspect Discord. Do not use messages_send to bypass deduplication.',
      };
    }
    this.db
      .prepare("INSERT INTO replies VALUES (?,?,'sending',NULL)")
      .run(args.event_id, args.content);
    try {
      const sent = (await this.options.rest.post(`/channels/${event.data.channel_id}/messages`, {
        body: {
          content: args.content,
          allowed_mentions: { parse: [], replied_user: false },
          message_reference: {
            message_id: event.data.message_id,
            channel_id: event.data.channel_id,
            fail_if_not_exists: true,
          },
          nonce: event.data.message_id,
          enforce_nonce: true,
        },
      })) as { id?: string; channel_id?: string };
      if (!sent.id || sent.channel_id !== event.data.channel_id)
        throw new Error('Uncertain Discord response');
      this.db
        .prepare("UPDATE replies SET state='sent',message_id=? WHERE event_id=?")
        .run(sent.id, args.event_id);
      return { status: 'sent', message_id: sent.id, channel_id: event.data.channel_id };
    } catch (error) {
      const status = (error as { status?: number }).status;
      const state = status && [400, 401, 403, 404, 429].includes(status) ? 'failed' : 'uncertain';
      this.db.prepare('UPDATE replies SET state=? WHERE event_id=?').run(state, args.event_id);
      return { status: state === 'failed' ? 'failed' : 'needs_review', message_id: null };
    }
  }
  status() {
    return {
      subscriptions: this.db.prepare('SELECT id,state,expires FROM subscriptions').all(),
      delivery: this.db.prepare('SELECT id,state,attempts,status FROM events').all(),
      replies: this.db.prepare('SELECT event_id,state,message_id FROM replies').all(),
    };
  }
  close() {
    this.db.close();
  }
}
