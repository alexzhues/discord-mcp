import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import {
  DmEventRuntime,
  type IncomingDm,
  loadConfig,
  verifyExpectedBotIdentity,
} from '@discord-mcp/core';
import { REST } from '@discordjs/rest';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

/** OS-local singleton lock. Never delete a live process's lock/socket. */
export function acquireWorkerLock(directory: string): () => void {
  const path = join(directory, 'worker.pid');
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink()) throw new Error('Invalid worker lock');
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error('Incomplete worker lock; inspect it before recovery');
    try {
      process.kill(pid, 0);
      throw new Error('An Events worker already owns this state directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    // Only the PID known to be dead can be removed. Competing starters then
    // contend on O_EXCL; only one succeeds. No service/session auto-spawning.
    if (Number(readFileSync(path, 'utf8')) === pid) unlinkSync(path);
  }
  const fd = openSync(path, 'wx', 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return () => {
    if (Number(readFileSync(path, 'utf8')) === process.pid) unlinkSync(path);
  };
}
export async function eventsWorkerAction(): Promise<void> {
  process.umask(0o077);
  const config = loadConfig();
  const directory = config.MCP_EVENTS_STATE_DIR;
  const socket = config.MCP_EVENTS_SOCKET;
  const owner = config.MCP_EVENTS_OWNER;
  const authorId = config.MCP_EVENTS_AUTHOR_ID;
  if (
    !directory?.startsWith('/') ||
    !socket ||
    socket !== join(directory, 'worker.sock') ||
    !owner ||
    !/^\d{17,20}$/.test(authorId ?? '') ||
    !config.DISCORD_EXPECTED_BOT_ID
  )
    throw new Error(
      'Events worker requires absolute private state/socket paths, owner, verified author and expected bot ID',
    );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = lstatSync(directory);
  if (dir.isSymbolicLink() || (dir.mode & 0o077) !== 0 || dir.uid !== process.getuid?.())
    throw new Error('Events directory must be operator-owned and mode 0700');
  const release = acquireWorkerLock(directory);
  let runtime: DmEventRuntime | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const client = new Client({
    intents: [GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
  });
  let fatal = false;
  let delivering = false;
  const report = () => {
    process.stderr.write('Events operation failed; inspect sanitized delivery status.\n');
  };
  const api = new REST({
    version: '10',
    retries: 0,
    timeout: 10_000,
    rejectOnRateLimit: () => true,
  }).setToken(config.DISCORD_TOKEN.replace(/^Bot /, ''));
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/') {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 65_536) {
          res.writeHead(413).end();
          req.destroy();
          return;
        }
      }
      const envelope = JSON.parse(body);
      const method = [
        'events/list',
        'events/subscribe',
        'events/unsubscribe',
        'dm/context',
        'dm/reply',
      ].includes(envelope.method)
        ? envelope.method
        : 'unknown';
      process.stderr.write(`${JSON.stringify({ event: 'events_request', method })}\n`);
      const result = await runtime!.call(envelope.owner, envelope.method, envelope.params);
      process.stderr.write(`${JSON.stringify({ event: 'events_result', method, status: 'ok' })}\n`);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result }));
    } catch (error) {
      const typed = error as { code?: number; data?: unknown };
      const reason = (typed.data as { reason?: unknown } | undefined)?.reason;
      process.stderr.write(
        `${JSON.stringify({
          event: 'events_rejected',
          code: typeof typed.code === 'number' ? typed.code : -32602,
          reason: [
            'invalid_url',
            'invalid_secret',
            'challenge_failed',
            'timeout_or_connection_failed',
            'dns_failed',
            'non_public_address',
            'response_too_large',
            'connection_failed',
          ].includes(String(reason))
            ? reason
            : 'request_rejected',
        })}\n`,
      );
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: {
            code: typeof typed.code === 'number' ? typed.code : -32602,
            message: 'Events request rejected',
            ...(typed.data ? { data: typed.data } : {}),
          },
        }),
      );
    }
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    await client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime?.exclusive(async () => {
      runtime?.close();
    });
    if (existsSync(socket)) unlinkSync(socket);
    release();
  };
  try {
    if (existsSync(socket)) {
      if (!lstatSync(socket).isSocket()) throw new Error('Invalid worker socket');
      unlinkSync(socket);
    }
    await verifyExpectedBotIdentity(api, config.DISCORD_EXPECTED_BOT_ID);
    runtime = new DmEventRuntime({
      directory,
      owner,
      authorId: authorId!,
      botId: config.DISCORD_EXPECTED_BOT_ID,
      rest: api,
    });
    client.on('messageCreate', (message) => {
      const dm: IncomingDm = {
        id: message.id,
        channel_id: message.channelId,
        author: { id: message.author.id, bot: message.author.bot },
        timestamp: message.createdAt.toISOString(),
        content: message.content,
        channel_type: message.channel.type,
        ...(message.guildId ? { guild_id: message.guildId } : {}),
        type: message.type,
        attachments: [...message.attachments.values()],
        ...(message.reference
          ? {
              message_reference: {
                ...(message.reference.messageId ? { message_id: message.reference.messageId } : {}),
                channel_id: message.reference.channelId,
              },
            }
          : {}),
      };
      void runtime!.observe(dm).catch(() => {
        fatal = true;
        report();
        void stop().then(() => {
          process.exitCode = 1;
        });
      });
    });
    client.on('error', report);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, () => {
        chmodSync(socket, 0o600);
        resolve();
      });
    });
    server.requestTimeout = 30_000;
    await client.login(config.DISCORD_TOKEN.replace(/^Bot /, ''));
    timer = setInterval(() => {
      if (!fatal && !stopping && !delivering) {
        delivering = true;
        void runtime!
          .deliver()
          .catch(report)
          .finally(() => {
            delivering = false;
          });
      }
    }, 1000);
    process.on('SIGTERM', () => {
      void stop();
    });
    process.on('SIGINT', () => {
      void stop();
    });
    process.stderr.write('Discord DM Events worker ready.\n');
  } catch {
    await stop();
    throw new Error('Events worker startup failed');
  }
}
