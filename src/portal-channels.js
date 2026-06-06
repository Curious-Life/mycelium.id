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

export function portalChannelsRouter({ db, userId }) {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  const getS = (k) => db.secrets.get(userId, k);
  const hasS = (k) => db.secrets.has(userId, k);
  const setS = (k, v) => db.secrets.set(userId, { key: k, value: v, scope: 'personal', description: 'channel setting' });
  const delS = (k) => db.secrets.delete(userId, k);

  // GET /channels — current state (hasX only) + authorized groups.
  router.get('/channels', async (_req, res) => {
    try {
      res.json({
        enabled: (await getS('CHANNEL_ENABLED')) === '1',
        telegram: { hasToken: await hasS('TELEGRAM_BOT_TOKEN'), ownerId: (await getS('OWNER_TELEGRAM_ID')) || null },
        discord: { hasToken: await hasS('DISCORD_BOT_TOKEN'), ownerId: (await getS('OWNER_DISCORD_ID')) || null },
        agent: { hasKey: await hasS('ANTHROPIC_API_KEY'), model: (await getS('CHANNEL_AGENT_MODEL')) || null },
        groups: (await db.telegramGroups.list(userId)).map((g) => ({ id: g.id, title: g.title || null })),
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
        if (discord.token) await setS('DISCORD_BOT_TOKEN', String(discord.token));
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
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  // DELETE /channels/groups/:id — revoke an authorized group (soft delete).
  router.delete('/channels/groups/:id', async (req, res) => {
    try {
      await db.telegramGroups.revoke(String(req.params.id));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  return router;
}
