/**
 * Discord inbound gateway — lazy-imports discord.js (an OPTIONAL dep, like the
 * Agent SDK). The gateway is a stateful WS protocol with heartbeat/resume/zombie
 * footguns; discord.js handles them battle-tested, so we don't hand-roll it.
 * Egress stays raw-fetch REST (discord-api.js) — discord.js is ONLY for inbound.
 *
 * Requires the privileged MESSAGE_CONTENT intent (enable it in the Discord dev
 * portal) to read message text in guilds; DMs always include content.
 *
 * ── D-014: the gateway KNOWS whether it is connected, and says so ─────────────
 * The operator's words: "discord shows as connected even though it is not
 * connected."
 *
 * ROOT CAUSE: `start()` was fire-and-forget — index.js calls it as
 * `gateway.start().catch(console.error)` — and NOTHING downstream recorded the
 * outcome. The daemon process survives a failed gateway (the Telegram poller and
 * the egress routes keep running), so `/healthz` kept answering `ok`, and the
 * settings UI painted "Connected" off a STORED FLAG (`hasToken`: a bot token
 * exists in the vault). Three independent layers, none of which had ever observed
 * a live Discord socket. The most common way to hit it: `discord.js` is an
 * optional dependency and is NOT installed in this tree, so `loadDiscordJs()`
 * throws on every start and inbound Discord has never worked — while the UI said
 * "Connected".
 *
 * THE FIX (an honest probe, not a stored flag): this module owns a small state
 * machine and exposes `state()`. It is the ONLY place that can truthfully say
 * "connected", because it is the only place holding the socket.
 *
 *   idle          — never started
 *   connecting    — start() is in flight, login not yet acknowledged
 *   ready         — discord.js emitted ClientReady: a live gateway session EXISTS
 *   disconnected  — was ready, the socket dropped (discord.js is retrying)
 *   failed        — start() threw (module missing, bad token, disallowed intents)
 *
 * `ready` is the ONLY state any surface may render as "connected", and it is
 * reachable exclusively from the ClientReady event. Everything else fails closed
 * to "not connected". `reason` is a fixed enum-ish code plus a short message; it
 * never carries vault content (CLAUDE.md §1) — only Discord/library diagnostics.
 */
import { normalizeDiscordMessage } from './discord-normalize.js';

async function loadDiscordJs() {
  try {
    return await import('discord.js');
  } catch (e) {
    const err = new Error('channel-daemon: discord.js is required for the Discord inbound gateway (npm i discord.js). Underlying: ' + e.message);
    err.code = 'module_missing';
    throw err;
  }
}

/** The states a caller may render as "connected". Exactly one. */
export const DISCORD_CONNECTED_STATES = Object.freeze(['ready']);

/**
 * @param {object} deps
 * @param {string} deps.botToken
 * @param {(msg:object)=>Promise<void>} deps.handleInbound
 * @param {string} [deps.logPrefix]
 * @param {() => Promise<object>} [deps.loadLib]  injectable discord.js loader (tests)
 */
export function createDiscordGateway({ botToken, handleInbound, logPrefix = 'channel-daemon', loadLib = loadDiscordJs }) {
  if (!botToken) throw new TypeError('createDiscordGateway: botToken required');
  if (typeof handleInbound !== 'function') throw new TypeError('createDiscordGateway: handleInbound required');
  let client = null;

  // The honest state. Starts `idle` — NOT `ready`, and never optimistically
  // promoted: only the ClientReady event may set `ready` (fail closed).
  let _state = 'idle';
  let _reason = null;      // short machine code, e.g. 'module_missing' | 'login_failed'
  let _message = null;     // short human detail; library/Discord text only, never vault content
  let _readyAt = null;

  const set = (state, reason = null, message = null) => {
    _state = state;
    _reason = reason;
    _message = message ? String(message).slice(0, 200) : null;
    if (state !== 'ready') _readyAt = null;
  };

  return {
    /**
     * The ONE truthful answer to "is Discord connected?". Callers must treat
     * anything other than `state === 'ready'` as NOT connected.
     * @returns {{state:string, connected:boolean, reason:string|null, message:string|null, readyAt:number|null}}
     */
    state() {
      return { state: _state, connected: _state === 'ready', reason: _reason, message: _message, readyAt: _readyAt };
    },

    async start() {
      set('connecting');
      let lib;
      try {
        lib = await loadLib();
      } catch (e) {
        // The optional dep is absent → inbound Discord CANNOT work. Record it and
        // rethrow so index.js still logs; the state is what the UI reads.
        set('failed', e?.code || 'module_missing', e?.message);
        throw e;
      }
      const { Client, GatewayIntentBits, Partials, Events } = lib;
      try {
        client = new Client({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent, // privileged — enable in dev portal
            GatewayIntentBits.DirectMessages,
          ],
          partials: [Partials.Channel], // required to receive DMs
        });
        client.on(Events.MessageCreate, async (msg) => {
          try {
            const norm = normalizeDiscordMessage(msg);
            if (!norm || norm.isBot) return; // never react to bot messages (loop guard)
            await handleInbound(norm);
          } catch (e) {
            console.error(`[${logPrefix}] discord inbound error: ${e.message}`);
          }
        });
        // ⭐ The ONLY transition into `ready`. A live gateway session exists.
        client.once(Events.ClientReady, (c) => {
          set('ready');
          _readyAt = Date.now();
          console.log(`[${logPrefix}] discord gateway ready as ${c.user?.tag}`);
        });
        // The socket dropping after a successful login is NOT "still connected".
        // discord.js reconnects on its own, and ClientReady fires again on resume —
        // so this is honestly `disconnected`, not `failed`.
        const onDrop = (label) => () => {
          if (_state === 'ready' || _state === 'connecting') set('disconnected', 'socket_closed', label);
        };
        client.on?.(Events.ShardDisconnect ?? 'shardDisconnect', onDrop('gateway socket closed'));
        client.on?.(Events.Invalidated ?? 'invalidated', () => set('failed', 'session_invalidated', 'Discord invalidated the session'));
        client.on('error', (e) => console.error(`[${logPrefix}] discord client error: ${e.message}`));

        await client.login(botToken);
        // login() resolving means the token was ACCEPTED, not that the gateway is
        // usable — ClientReady is still pending (and DisallowedIntents can still
        // kill it). So we deliberately do NOT set 'ready' here.
      } catch (e) {
        // Bad token, disallowed privileged intents, network refusal…
        set('failed', e?.code === 'module_missing' ? 'module_missing' : 'login_failed', e?.message);
        throw e;
      }
    },

    async stop() {
      try { await client?.destroy(); } catch { /* */ }
      set('idle');
    },
  };
}
