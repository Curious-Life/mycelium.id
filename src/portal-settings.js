// Local secrets API — the self-hosted equivalent of the cloud product's
// /portal/settings/secret(s) (which lives in reference/ and was never ported).
// Stores into the encrypted secrets table (db.secrets → SYSTEM_KEY at rest).
// Single-user, localhost-only, behind the vault-init guard (no per-request auth).
// Wiring this also un-breaks the existing portal "Connect" buttons
// (ConnectionsChecklist / OnboardingGuide PUT /portal/settings/secret).

import express from 'express';

export function portalSettingsRouter({ db, userId }) {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  // Metadata only — never values.
  router.get('/settings/secrets', async (_req, res) => {
    try {
      res.json({ secrets: await db.secrets.list(userId) });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
    }
  });

  router.put('/settings/secret', async (req, res) => {
    try {
      const { key, value, scope, description } = req.body || {};
      if (!key || typeof value !== 'string' || value.length === 0) {
        return res.status(400).json({ error: 'key and value required' });
      }
      await db.secrets.set(userId, { key, value, scope: scope || 'personal', description: description || null });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
    }
  });

  router.delete('/settings/secret', async (req, res) => {
    try {
      const { key } = req.body || {};
      if (!key) return res.status(400).json({ error: 'key required' });
      const r = await db.secrets.delete(userId, key);
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
    }
  });

  return router;
}
