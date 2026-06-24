// src/portal-ingest.js — owner-authed PUSH ingestion for the native app.
//
// The phone pushes Apple data (health, calendar, reminders, contacts, photos)
// here; every event flows through the ONE ingestion boundary —
// captureMessage(src/ingest/capture.js) — into the stream: encrypted at rest,
// deduped (id PK + content-hash, so re-syncs are idempotent), and enqueued for
// enrichment, exactly like every other source (chat, uploads, Gmail/Linear). It
// is deliberately NOT a per-type side table; "tap into the stream" = one path.
//
// This is the authed-OWNER push companion to the (external, HMAC) webhook kind in
// docs/STREAMS-INGESTION-MCP-DESIGN-2026-06-16.md. Owner-gated (loopback OR the
// owner's static Bearer) because it writes vault plaintext.
import express from 'express';
import { captureMessage } from './ingest/capture.js';

const MAX_BATCH = 1000;

export function portalIngestRouter({ db, userId = 'local-user', enqueueEnrichment, authenticatePortalRequest }) {
  if (typeof authenticatePortalRequest !== 'function') throw new Error('portalIngestRouter: authenticatePortalRequest required');
  const router = express.Router();
  const auth = (req, res) => {
    const u = authenticatePortalRequest(req);
    if (!u) { res.status(401).json({ ok: false, error: 'Unauthorized' }); return null; }
    return u;
  };

  // POST /ingest — batch push into the stream.
  // Body: { events: [{ source, content, createdAt?, id?, role?, messageType?, metadata? }] }
  // Returns { ok, captured, deduped, skipped, total }. Idempotent: identical
  // events (same id or same content) are deduped by captureMessage.
  router.post('/ingest', async (req, res) => {
    if (!auth(req, res)) return;
    const events = Array.isArray(req.body?.events) ? req.body.events : null;
    if (!events) return res.status(400).json({ ok: false, error: 'events[] required' });

    let captured = 0, deduped = 0, skipped = 0;
    for (const e of events.slice(0, MAX_BATCH)) {
      const content = typeof e?.content === 'string' ? e.content.trim() : '';
      if (!content) { skipped++; continue; }
      try {
        const r = await captureMessage(db, {
          userId,
          content,
          role: e.role === 'assistant' ? 'assistant' : 'user',
          messageType: (typeof e.messageType === 'string' && e.messageType) ? e.messageType : 'event',
          source: (typeof e.source === 'string' && e.source) ? e.source : 'apple',
          metadata: (e.metadata && typeof e.metadata === 'object') ? e.metadata : undefined,
          createdAt: e.createdAt || undefined,
          id: (typeof e.id === 'string' && e.id) ? e.id : undefined,
        }, enqueueEnrichment);
        if (r?.deduped) deduped++; else captured++;
      } catch { skipped++; }
    }
    res.json({ ok: true, captured, deduped, skipped, total: events.length });
  });

  return router;
}
