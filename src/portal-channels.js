// src/portal-channels.js — the /portal/channels backend for the Channels
// settings pane (Telegram bot token + owner, the assistant model key, and the
// list of authorized groups). All secret values are stored in the encrypted
// `secrets` table (SYSTEM_KEY at rest) under the SAME key names the channel-daemon
// reads from env; the daemon hydrates them via /api/v1/internal/channel-config.
//
// SECURITY: the GET response NEVER returns a secret value — only `hasToken` /
// `hasKey` booleans + non-secret fields (owner id, model, group titles).
// Localhost-only, single-user, behind the vault-init guard (no per-request auth),
// same posture as portal-settings.js.
import express from 'express';
import { createPairingStore } from './channels/pairing-store.js';
import { honestChannelConnection } from './channels/supervisor.js';

export function portalChannelsRouter({ db, userId, channelSup }) {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  const getS = (k) => db.secrets.get(userId, k);
  const hasS = (k) => db.secrets.has(userId, k);
  const setS = (k, v) => db.secrets.set(userId, { key: k, value: v, scope: 'personal', description: 'channel setting' });
  const delS = (k) => db.secrets.delete(userId, k);
  const pairing = createPairingStore({ db });

  // Per-channel access policy (mode + allowlist), default open.
  const accessOf = async (kind, id) => (db.channelAccess ? (await db.channelAccess.get(kind, String(id))) : null) || { mode: 'open', allowedSenders: [] };

  // GET /channels — current state (hasX only) + authorized groups/channels (each
  // with its access policy) + the routing/tuning knobs (non-secret config).
  router.get('/channels', async (_req, res) => {
    try {
      const groups = await Promise.all((await db.telegramGroups.list(userId)).map(async (g) => ({ id: g.id, title: g.title || null, access: await accessOf('telegram-group', g.id) })));
      const discordChannels = db.identityChannels?.listByKind
        ? await Promise.all((await db.identityChannels.listByKind('discord')).map(async (c) => ({ id: c.channel_value, name: c.display_name || null, access: await accessOf('discord', c.channel_value) })))
        : [];
      const enabled = (await getS('CHANNEL_ENABLED')) === '1';
      const tgToken = await hasS('TELEGRAM_BOT_TOKEN');
      const dcToken = await hasS('DISCORD_BOT_TOKEN');
      // D-014 — an HONEST per-channel connection state, not the stored-token flag.
      // `hasToken` stays in the payload (the connect form needs "a token is saved"),
      // but it is NO LONGER the thing the UI may call "Connected": `connection.state`
      // is, and it is `connected` only when the daemon reports a LIVE gateway for
      // that platform. Derived here, once, so the UI cannot re-invent the rule.
      const health = channelSup ? channelSup.getHealth() : { status: 'unknown', message: null, detail: null, transports: {} };
      const connectionOf = (platform, hasToken) => honestChannelConnection({ platform, hasToken, enabled, health });
      res.json({
        enabled,
        telegram: { hasToken: tgToken, ownerId: (await getS('OWNER_TELEGRAM_ID')) || null, connection: connectionOf('telegram', tgToken) },
        discord: { hasToken: dcToken, ownerId: (await getS('OWNER_DISCORD_ID')) || null, connection: connectionOf('discord', dcToken) },
        agent: { hasKey: await hasS('ANTHROPIC_API_KEY'), model: (await getS('CHANNEL_AGENT_MODEL')) || null },
        routing: {
          router: (await getS('CHANNEL_ROUTER')) || '',
          ollamaModel: (await getS('CHANNEL_OLLAMA_MODEL')) || '',
          ollamaUrl: (await getS('OLLAMA_URL')) || '',
          coalesceMs: (await getS('CHANNEL_COALESCE_MS')) || '',
          rateLimitMax: (await getS('CHANNEL_RATELIMIT_MAX')) || '',
          rateLimitWindowMs: (await getS('CHANNEL_RATELIMIT_WINDOW_MS')) || '',
          sensitivePatterns: (await getS('CHANNEL_SENSITIVE_PATTERNS')) || '',
        },
        groups,
        discordChannels,
        // Live daemon state so the UI shows whether the bridge is actually running
        // (not just whether a token is stored). { status, message, detail, transports }.
        daemon: health,
      });
    } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  // PUT /channels — save. Empty string clears a field (delete). Keys present in
  // the body but empty are removed; absent keys are left untouched.
  router.put('/channels', async (req, res) => {
    try {
      const { enabled, telegram, discord, agent } = req.body || {};
      if (enabled !== undefined) await setS('CHANNEL_ENABLED', enabled ? '1' : '0');
      if (telegram && typeof telegram === 'object') {
        if (telegram.token) await setS('TELEGRAM_BOT_TOKEN', String(telegram.token));
        if (telegram.ownerId !== undefined) {
          const v = String(telegram.ownerId).trim();
          if (v) await setS('OWNER_TELEGRAM_ID', v); else await delS('OWNER_TELEGRAM_ID');
        }
      }
      if (discord && typeof discord === 'object') {
        // D-129: the token clears on empty like every other field (the route's own
        // contract: "Empty string clears a field"). Without this branch, the supervisor's
        // blocked-config health line told the user to "remove the Discord token" — an
        // action this screen could not perform (independent review, 2026-08-03).
        if (discord.token !== undefined) {
          const v = String(discord.token).trim();
          if (v) await setS('DISCORD_BOT_TOKEN', v); else await delS('DISCORD_BOT_TOKEN');
        }
        if (discord.ownerId !== undefined) {
          const v = String(discord.ownerId).trim();
          if (v) await setS('OWNER_DISCORD_ID', v); else await delS('OWNER_DISCORD_ID');
        }
      }
      if (agent && typeof agent === 'object') {
        if (agent.apiKey) await setS('ANTHROPIC_API_KEY', String(agent.apiKey));
        if (agent.model !== undefined) {
          const v = String(agent.model).trim();
          if (v) await setS('CHANNEL_AGENT_MODEL', v); else await delS('CHANNEL_AGENT_MODEL');
        }
      }
      // Routing & tuning knobs (Track A). Empty string clears a field.
      const routing = req.body?.routing;
      if (routing && typeof routing === 'object') {
        const map = {
          router: 'CHANNEL_ROUTER', ollamaModel: 'CHANNEL_OLLAMA_MODEL', ollamaUrl: 'OLLAMA_URL',
          coalesceMs: 'CHANNEL_COALESCE_MS', rateLimitMax: 'CHANNEL_RATELIMIT_MAX',
          rateLimitWindowMs: 'CHANNEL_RATELIMIT_WINDOW_MS', sensitivePatterns: 'CHANNEL_SENSITIVE_PATTERNS',
        };
        for (const [field, key] of Object.entries(map)) {
          if (routing[field] === undefined) continue;
          const v = String(routing[field]).trim();
          if (v) await setS(key, v); else await delS(key);
        }
      }
      // Apply the change to the running daemon WITHOUT an app restart: (re)start
      // it if now enabled + tokened, stop it if disabled, restart to pick up a new
      // token/model (the daemon reads its config from the vault only at boot).
      try { channelSup?.reload(); } catch { /* supervisor optional (e.g. tests) */ }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  // GET /channels/pairing — pending Telegram pairing requests (design D2). The
  // user messaged the bot while no owner was bound; the daemon minted a code and
  // replied it to them. Here the app lists those pending codes so the owner can
  // approve one. NEVER returns the raw sender id — only code/platform/who/when.
  router.get('/channels/pairing', async (_req, res) => {
    try { res.json({ pending: await pairing.list(userId) }); }
    catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  // POST /channels/pairing/approve { code } — bind OWNER_TELEGRAM_ID to the sender
  // behind that code, consume the pending entry, and reload the daemon so replies
  // start flowing WITHOUT an app restart. 404 if the code is unknown/expired.
  router.post('/channels/pairing/approve', async (req, res) => {
    try {
      const code = String(req.body?.code || '').trim();
      if (!code) return res.status(400).json({ error: 'code required' });
      const match = await pairing.approve(userId, code);
      if (!match) return res.status(404).json({ error: 'unknown or expired code' });
      await setS('OWNER_TELEGRAM_ID', String(match.senderId));
      try { channelSup?.reload(); } catch { /* supervisor optional (e.g. tests) */ }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  // PUT /channels/access — set a channel's access policy (mode + allowlist).
  router.put('/channels/access', async (req, res) => {
    try {
      const { kind, id, mode, allowedSenders } = req.body || {};
      if (!kind || !id) return res.status(400).json({ error: 'kind and id required' });
      if (!db?.channelAccess?.set) return res.status(503).json({ error: 'channel-access unavailable' });
      await db.channelAccess.set(String(kind), String(id), { mode, allowedSenders });
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  // DELETE /channels/groups/:id — revoke an authorized telegram group (soft delete).
  router.delete('/channels/groups/:id', async (req, res) => {
    try {
      await db.telegramGroups.revoke(String(req.params.id));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  // DELETE /channels/discord/:id — disallow a discord channel (delivery off).
  router.delete('/channels/discord/:id', async (req, res) => {
    try {
      await db.identityChannels.setFlag('discord', String(req.params.id), 'delivery_enabled', false);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  return router;
}
