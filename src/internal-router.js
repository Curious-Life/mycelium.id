// Internal router — loopback-only support endpoints for the channel-daemon
// (packages/channel-daemon). NOT part of the MCP tool surface: these are the
// two vault operations the egress chokepoint needs but that aren't tools —
// recording an egress-audit row and resolving channel authority.
//
// Security posture (V1): mounted under the same no-auth localhost REST surface
// as /api/v1/captureMessage (same-machine trust boundary). If the REST surface
// is ever exposed to a network, these MUST move behind the OAuth-HTTP gate with
// the rest of /api/v1 — they read/write vault tables.
//
// The egress-audit endpoint accepts ONLY a content HASH + length, never the
// message body (CLAUDE.md §1) — the daemon hashes before it calls.
import express from 'express';

/**
 * @param {object} deps
 * @param {object} deps.db        wired vault db (needs db.egressAudit + db.identityChannels)
 * @param {string} deps.userId
 */
export function internalRouter({ db, userId }) {
  const router = express.Router();
  // JSON parsing is scoped to the POST route ONLY — installing it router-wide
  // would parse (and reject malformed) bodies for every request that flows
  // through this router on its way to apiRouter, stealing apiRouter's JSON-error
  // envelope and leaking the SPA HTML fallback on bad input.
  const json = express.json({ limit: '256kb' });

  // POST /api/v1/internal/egress-audit — append one audit row. Fire-and-forget
  // on the daemon side; we still 200 fast and let the namespace swallow its own
  // write errors (it never throws — egress-audit.js).
  router.post('/api/v1/internal/egress-audit', json, async (req, res) => {
    const e = req.body || {};
    if (!e.contentHash || typeof e.contentLength !== 'number' || !e.channelId || !e.decision) {
      return res.status(400).json({ ok: false, error: 'contentHash, contentLength, channelId, decision required' });
    }
    // Defense in depth: reject anything that looks like a plaintext body slipped in.
    if ('content' in e || 'text' in e) {
      return res.status(400).json({ ok: false, error: 'audit must not carry plaintext content' });
    }
    if (!db?.egressAudit?.record) return res.status(503).json({ ok: false, error: 'egress-audit unavailable' });
    await db.egressAudit.record({ agentId: e.agentId || 'personal-agent', ...e });
    res.json({ ok: true });
  });

  // GET /api/v1/internal/channel-authority?kind=&id= — fail-closed deliverability.
  // A target is deliverable iff identity_channels has a non-revoked row for it
  // with delivery_enabled = 1 (opt-in). The daemon already short-circuits the
  // operator's own DM via owner-bootstrap, so this covers every other target.
  router.get('/api/v1/internal/channel-authority', async (req, res) => {
    const kind = String(req.query.kind || '');
    const id = String(req.query.id || '');
    if (!kind || !id) return res.status(400).json({ allowed: false, reason: 'kind-and-id-required' });
    if (!db?.identityChannels?.getByChannel) return res.status(503).json({ allowed: false, reason: 'authority-unavailable' });
    try {
      const row = await db.identityChannels.getByChannel(kind, id);
      if (!row) return res.json({ allowed: false, reason: 'not-bound' });
      if (row.revoked_at) return res.json({ allowed: false, reason: 'revoked' });
      if (row.delivery_enabled !== 1) return res.json({ allowed: false, reason: 'delivery-not-enabled' });
      return res.json({ allowed: true, reason: 'registry', ownerUserId: row.owner_user_id || null });
    } catch (err) {
      // Fail closed on any lookup error.
      console.error('[internal-router] channel-authority lookup failed:', err.message);
      return res.status(500).json({ allowed: false, reason: 'authority-error' });
    }
  });

  return router;
}
