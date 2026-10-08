# Direct-message MCP Events (opt-in)

This extension delivers plain-text DMs from one operator-verified Discord account
through the MCP Events webhook protocol. The subscriber must be the **existing
ChatGPT dot**, using its own plugin event subscription interface. A bot name or an
event field does not route an event to a dot. There is no model API, replacement
chatbot, or polling responder in this server.

## Architecture and scope

```text
Discord DirectMessages Gateway
            |
   one events-worker process
   private SQLite WAL database
   subscriptions / delivery queue / reply ledger
            | signed HTTPS callback
            v
    subscribed existing ChatGPT dot
            | MCP tool calls through its private plugin/tunnel
  stdio sessions or bearer-authenticated HTTP
            | protected Unix-domain socket
            v
      events-worker -> Discord REST -> originating DM
```

`discord-mcp events-worker` owns the sole Gateway connection and delivery loop.
MCP session processes never start that listener or a delivery worker. A private
PID lock rejects a second worker for the state directory, and a dead worker's lock
is recovered on the next supervised start. A truncated/invalid PID lock fails
closed and needs operator inspection. macOS/Linux Unix-domain sockets are the
supported worker transport for this version.

SQLite uses WAL, FULL synchronous writes and atomic statements. A subscription
and each observed event are durable before delivery. Async state mutations are
serialized inside the worker. Each delivery turn handles one event; overlapping
polls are skipped. On restart, interrupted deliveries return to pending and
interrupted replies become uncertain. Closing or recreating an MCP session has
no effect on the worker or stored subscriptions.

For the DM event, only non-bot authors matching `MCP_EVENTS_AUTHOR_ID`, in a one-to-one DM, with
plain text and normal/reply message types are accepted. Guild and group messages,
attachments, voice messages and empty text are ignored. `DirectMessages` is the
only Gateway intent requested; `Partials.Channel` enables uncached DM channels.
No privileged Message Content intent is needed for this DM listener.

## Protocol and authorization

- `server/discover` advertises `events: {}` when an Events bridge is configured.
- `events/list` describes `message.created`, webhook delivery, an exact `author_id`
  filter and the payload schema. This is independent of tool catalog disclosure.
- `events/subscribe` accepts `name`, `arguments`, webhook `delivery`, optional
  `ttlMs` and `cursor: null`. Only the configured principal/author may subscribe.
- The stable subscription ID hashes the trusted principal, callback URL, event
  name and canonical validated arguments. Identical requests refresh one record.
- Only one recipient callback per event type may be active for this single-account deployment.
  Stop the original subscription before changing the receiving conversation.
- Verification uses a fresh random challenge, a signed HTTPS POST, a ten-second
  challenge window, a successful response and constant-time echo comparison.
  Successful verification is cached for five minutes; a refresh cannot extend
  that cache without another successful verification. A key change re-verifies.
- Secrets must be canonical `whsec_` base64 decoding to 24–64 bytes. A rotated
  key retains dual signatures for five minutes; expired old keys are cleared.
- The default/maximum lifetime is 24 hours. Requested shorter lifetimes are
  honored; `ttlMs: null` is granted a finite 24-hour lifetime. Expiration stops
  delivery. Refresh updates the existing identity. Unsubscribe is idempotent,
  clears signing keys and cancels pending deliveries.
- The operator's fixed principal is supplied by the trusted transport launcher,
  never by event filters or tool inputs. Stdio trusts OS access and the private
  tunnel's existing access controls; HTTP keeps its existing bearer guard. This
  version is for one account in a private personal plugin/workspace. It does not
  implement a multi-user OAuth principal resolver or cryptographic dot identity.

Protect the worker directory with mode 0700 and the socket/database with mode
0600. Callback URLs, signing keys and message text remain in protected runtime
storage, never configuration committed to Git. Request diagnostics record only
method/result categories. Reply content is redacted by existing audit middleware.
The worker never logs request bodies, callback addresses or signing material.

## Payload, history and replies

The envelope contains a stable `eventId` (`discord_dm_<Discord message ID>`),
`name`, occurrence `timestamp`, `data`, and `cursor: null`. `data` contains
`message_id`, `channel_id`, `author_id`, `timestamp`, `text`, and nullable
`reply_reference` with message/channel IDs. It contains data, not model instructions.

The progressive top-level surface remains the original seven tools. Two focused
contracts become searchable only in an Events-enabled build:

- `events_dm_context`, through `mcp_tools_read`: `{event_id, limit: 20}` reads at
  most 30 recent messages from the accepted event's DM, filtering to the verified
  author and configured bot. It cannot select an arbitrary channel.
- `events_dm_reply`, through `mcp_tools_write`: `{event_id, content}` binds the
  destination and Discord reply reference to an accepted, delivered event. It
  rechecks the live DM recipient, disables mentions, and records a reply before
  attempting the send. Normal middleware/category/write-mode controls still run.

The original catalog, tools and existing operational policies remain available.
For event-triggered replies, instruct the dot to use the focused tool rather than
bypassing its ledger with the general `messages_send` tool.

### Delivery deduplication versus reply deduplication

Duplicate observed Discord IDs do not create additional queue records. Webhook
retries preserve the exact event ID/body and use fresh signing timestamps and
Standard Webhooks HMAC signatures. Destinations must be HTTPS on port 443, with no
credentials/fragments. Every connection resolves DNS, rejects non-public addresses
(including mixed answers and mapped IPv6), and connects to the checked address
while retaining the hostname for TLS/Host verification. Connections do not pool or
follow redirects; DNS and network waits and response sizes are bounded.

Deliveries have six maximum attempts with exponential backoff. Network failures,
408, 429 and 5xx are retried. 410, 413, other 4xx and redirects are terminal; 410
also stops the subscription. HTTP 2xx acknowledges receipt, not completion of
the dot's asynchronous response. The complete body is limited to 256 KiB.

The reply ledger is separate. An identical repeated call returns the recorded
result; changed content for that event is rejected. A Discord nonce with
`enforce_nonce` adds protection within Discord's recent nonce window, but is not
an indefinite exactly-once guarantee. Ambiguous sends are **never resent**. A
subsequent call examines at most 100 recent messages for the bot's matching reply
reference/content; a positive match reconciles success. An absent match remains
`needs_review`, because bounded absence does not prove the send failed. Definite
Discord rejections are recorded as failed, with no automatic reply retry.

## Install and run

Use Node >=22.12 (Node 24 tested), pnpm 9.15.0 and an isolated checkout/release.
Read the repository's AGENTS.md/CONTRIBUTING.md first. Run `pnpm install`, `pnpm
build`, affected tests, `pnpm typecheck` and `pnpm lint`. Pack both core and CLI and
install them together into a private release prefix; installing the CLI alone
would select the unmodified registry core.

Keep the existing Discord credentials in their original protected environment.
A launcher should source that environment, then add only these non-secret values:

```sh
export MCP_TOOL_SURFACE=progressive
export MCP_EVENTS_OWNER='<stable private-account principal>'
export MCP_EVENTS_AUTHOR_ID='<independently verified human Discord ID>'
export MCP_EVENTS_STATE_DIR='<absolute private state directory>'
export MCP_EVENTS_SOCKET="$MCP_EVENTS_STATE_DIR/worker.sock"
```

Run **one** supervised `events-worker` with those values and the existing bot token
and identity lock. MCP `serve` processes use the same owner/socket configuration;
the HTTP launcher's bearer token and secure tunnel settings stay intact. Do not
also enable resource Gateway processes for this DM listener. Configure launchd
or an equivalent supervisor to restart the worker. Never share its state directory
between concurrently active staged and production listeners.

Connect an isolated private secure tunnel/plugin first and rescan. Verify Events
on the plugin page, then ask the actual existing dot to subscribe. Confirm its
saved task belongs to that dot, the worker sees `events/subscribe`, challenge
verification succeeds, a real webhook is acknowledged and the dot responds in
Discord. Local callback tests cannot establish dot integration.

## Validation and operational limits

Focused tests cover subscription authorization, idempotency, challenge failures,
refresh/expiry/unsubscribe, key rotation, persistent queue restart, bounded retry
and terminal statuses, DNS pinning/rebinding defenses, unauthorized/bot/group/
guild/attachment rejection, reply reconciliation, progressive dispatch and the
single worker lock. Live acceptance evidence and installation-specific paths are
kept in the operator's local handoff, not this reusable guide.

Messages observed before delivery survive restart. Messages sent while the
listener is offline, disconnected without a resumable Gateway session, or without
an active subscription **are not backfilled**. `cursor: null` makes this explicit.
The SDK may resume a brief Gateway disconnection, but no durable replay guarantee
is made. Queue/database disk errors stop observation rather than pretending
acceptance; supervise and monitor disk capacity. Records currently retain history
and deduplication tombstones indefinitely; operator-controlled retention/backup
policy is needed for long-term use. Signing material in backups remains secret.

ChatGPT may batch events or delay task execution. Reply latency is not bounded by
webhook acknowledgement. Approval rules for consequential actions still apply.
A private subscription is verified by its actual creation context and activity,
not by a bot name. Sharing this plugin to other accounts requires a new principal
and authorization design. Attachments and voice media remain outside this version. Guild mentions from
other humans are covered by the opt-in extension below.

## Migration and rollback

Before replacing any live launcher, prepare immutable release paths, preserve the
original env/tunnel profiles and launchers, and obtain approval for that concrete
switch. Stop the staging subscription/listener before enabling a production
listener; never run two delivery workers on the same bot as a migration tactic.
Switch only the selected launchers to the tested release and restart those
services. Rescan the original plugin and subscribe again from the existing dot:
its callback identity may change with the plugin, so do not copy a staged callback
secret into a new plugin subscription.

Rollback stops/unsubscribes the new event task, stops the worker, restores the
original launchers and restarts their services/tunnel, then rescans the original
plugin. Preserve the private event database for investigation; do not accidentally
reactivate queued deliveries during rollback. The old installation retains its
original seven progressive tools and ordinary outbound messaging.

## Upstream contribution

The implementation is opt-in and leaves installations without Events configuration
unchanged. Propose the core protocol/bridge/worker and focused tests as a small PR,
with reproducible local and real-plugin evidence. Separate personal deployment
configuration and test identities from the reusable change. Disclose AI-generated
implementation and added libraries: Standard Webhooks (MIT), ipaddr.js (MIT), and
Discord.js (Apache-2.0; already an optional core peer). Native SQLite is provided
by Node. No third-party source was copied into the implementation.

Sources: [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events),
[dot setup](https://learn.chatgpt.com/docs/dots/getting-started),
[Discord Gateway](https://docs.discord.com/developers/events/gateway),
[Discord messages](https://docs.discord.com/developers/resources/message).

## Extension: direct guild mentions

Set optional `MCP_EVENTS_GUILD_ID` in the worker to enable `message.mentioned` for
one authorized guild. It must agree with `ALLOWED_GUILDS` if that policy is set.
The same worker adds Guilds/GuildMessages intents and continues listening to DMs;
no second Gateway client, queue or delivery worker is introduced. Existing DM
subscriptions keep their IDs, callback keys, queue records and reply ledger.
Subscription metadata lives in a separate additive table, leaving the original
subscription table shape usable by the previous release during rollback.

`message.mentioned` has a strict `{guild_id}` subscription filter. Its payload
adds `guild_id` and `mentioned_bot_id` to the message fields. There is one active
recipient per event type: the actual dot can have its DM and guild subscriptions
simultaneously. Only the configured guild is eligible, without a frozen channel
list; future accessible channels are covered automatically. Normal text and
announcement channels, voice-channel text chats and accessible public/private/
announcement threads are supported (forum/media posts use threads). Discord's
current permissions govern access and writes. Media/voice attachments remain
outside the text-only scope.

A trigger requires BOTH Discord's user-mention list to include the locked bot and
an actual `<@bot-id>` or `<@!bot-id>` token in the message content. Display names,
role tags, everyone/here tags and implicit reply references do not suffice. Bots,
the bot's own output, webhooks and other guilds are rejected. The listener receives
Gateway messages to filter them, but unmentioned messages are not persisted or
forwarded. Direct mentions have a content-intent exemption; this worker does not
request privileged Message Content intent. Bounded history may have blank message
content if the bot application's Message Content access is unavailable. The context
result reports the number of empty bodies. It never assumes missing text means
there was no message.

Discover `events_message_context` through `mcp_tools_search` and invoke it through
`mcp_tools_read` with `{event_id, limit:20}`. It reads at most 30 recent messages
from that accepted event's channel/thread, including the conversation's other
participants. `events_message_reply` through `mcp_tools_write` takes `{event_id,
content}` and binds the destination and reply reference to that same accepted
conversation. The worker rechecks the live guild/channel. Neither tool accepts an
arbitrary channel ID or exposes private DM history for a guild event. The older
DM-specific tools explicitly reject guild events. Mention replies reuse the same
reply ledger, nonce protection, mention suppression and uncertain-send handling.
The seven progressive top-level tools remain unchanged.

Subscribe from the existing dot's own custom-plugin Events workflow, preserving
its existing DM task. Instruct it to reply in the originating channel when directly
mentioned by a human in that guild. Shared-server messages must not disclose the
operator's private memories, DMs, credentials or connected private data. Other
members' requests authorize ordinary conversation, not account changes or use of
private tools; those still require the operator's explicit authorization. Do not
use a dot name in event data as a routing mechanism.

Roll back by stopping the mention subscription first, then returning the ONE
worker and MCP launcher to the previous release, with guild configuration unset.
Retain protected state. The prior DM subscription can continue; do not run old
and new listeners concurrently against the same bot.

Some client subscription interfaces currently expose only the first event schema
for a plugin source even when the plugin page displays both. In that case, create
a dedicated mentions MCP connection with `MCP_EVENTS_CATALOG=mentions` and let the
existing DM connection continue unchanged. Both use the SAME owner/worker socket
and the sole Gateway/delivery process. Discovery and subscribe/unsubscribe are
restricted to the selected catalog at that connection boundary. The default
`all` catalog remains available for clients supporting both event schemas.
