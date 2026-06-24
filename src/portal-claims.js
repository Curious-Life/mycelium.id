// src/portal-claims.js — portal surface for Persona-Claims (PersonaTree
// adoption). Two read-only, owner-gated endpoints mounted under /api/v1/portal:
//
//   GET /claims/current                      → active claims (confidence, type, support)
//   GET /claims/series?claim_id=&granularity= → one claim's confidence over time
//
// Reads go through the auto-decrypting db.claims namespace, so ciphertext never
// reaches a response (every sensitive column is in ENCRYPTED_FIELDS). Structural
// keys (window_end, granularity, status) are plaintext. Mirrors the shape of
// portalMeasurementRouter's /frequency/series so ClaimsView can reuse
// TimeSeries.svelte. See docs/PERSONA-CLAIMS-DESIGN-2026-06-06.md §3.9.
import express from 'express';
import { toConfidence } from './claims/confidence.js';

const VALID_GRANULARITIES = new Set(['day', 'week', 'month', 'quarter']);

export function portalClaimsRouter({ db, userId, authenticatePortalRequest }) {
  if (!db?.claims) throw new Error('portalClaimsRouter: db.claims required');
  if (typeof userId !== 'string') throw new Error('portalClaimsRouter: userId required');
  if (typeof authenticatePortalRequest !== 'function') {
    throw new Error('portalClaimsRouter: authenticatePortalRequest required');
  }
  const router = express.Router();
  const fail = (res, code = 500, error = 'request failed') => res.status(code).json({ error });
  const owner = (req, res) => {
    const u = authenticatePortalRequest(req);
    if (!u || !u.id) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    return u;
  };

  // GET /claims/current — active claims, highest confidence first.
  router.get('/claims/current', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      const rows = await db.claims.listActive(u.id, { limit: 100 });
      const claims = rows
        .map((c) => ({
          id: c.id,
          claim_type: c.claimType,
          content: c.content,
          confidence: c.confidenceLogodds == null ? null : toConfidence(c.confidenceLogodds),
          support_count: c.support?.messages?.length ?? 0,
          last_evidence_at: c.lastEvidenceAt,
        }))
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
      res.set('Cache-Control', 'no-store');
      res.json({ claims });
    } catch { fail(res, 500, 'Failed to load claims'); }
  });

  // GET /claims/series — one claim's confidence trajectory at a granularity.
  router.get('/claims/series', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      const claimId = String(req.query.claim_id || '');
      if (!claimId) return res.status(400).json({ error: 'claim_id is required' });
      const granularity = String(req.query.granularity || 'week');
      if (!VALID_GRANULARITIES.has(granularity)) {
        return res.status(400).json({ error: `granularity must be one of: ${[...VALID_GRANULARITIES].join(', ')}` });
      }
      const claim = await db.claims.getById(u.id, claimId);
      if (!claim) return res.status(404).json({ error: 'claim not found' });
      const rows = await db.claims.readSeries(u.id, claimId, granularity, { limit: 365 });
      const series = rows.map((s) => ({
        window_end: s.windowEnd,
        window_start: s.windowStart,
        confidence: s.confidence,        // sigmoid, or null → TimeSeries breaks the line
        delta_kind: s.deltaKind,
        evidence_count: s.evidenceCount,
      }));
      res.set('Cache-Control', 'no-store');
      res.json({
        claim: { id: claim.id, claim_type: claim.claimType, content: claim.content },
        granularity, series,
      });
    } catch { fail(res, 500, 'Failed to load claim series'); }
  });

  return router;
}

export default portalClaimsRouter;
