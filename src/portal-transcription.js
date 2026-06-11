// src/portal-transcription.js — the Voice-transcription section's backend.
//
// A dedicated Whisper model (faster-whisper CT2 via pipeline/transcribe-service.py)
// the user downloads ONCE; src/enrich/transcribe-audio.js then prefers it over
// the slow audio-capable-LLM path. Design:
// docs/WHISPER-TRANSCRIPTION-DESIGN-2026-06-11.md.
//
//   GET  /transcription/status    → { health, model, catalog }
//   POST /transcription/download  → { model } — persists the choice, ensures the
//                                   supervisor, proxies the service's /download.
//                                   UI polls /status for progress (pct).
//
// SECURITY: loopback/authed like every /portal router; the only egress is the
// explicit model download from HuggingFace (same class as an Ollama pull).

import express from 'express';
import { ensureTranscribeSupervisor, getTranscriberHealth, transcribeServiceUrl } from './transcribe/supervisor.js';

// Curated stable models (must match transcribe-service.py ALLOWED_MODELS).
const CATALOG = [
  {
    model: 'large-v3-turbo',
    label: 'Whisper large-v3 turbo',
    sizeMB: 1620,
    blurb: 'Best quality — near large-v3 accuracy at 8× speed.',
    minRamGB: 16,
  },
  {
    model: 'small',
    label: 'Whisper small',
    sizeMB: 480,
    blurb: 'Light and fast — great for short voice notes.',
    minRamGB: 0,
  },
];
const CATALOG_MODELS = new Set(CATALOG.map((c) => c.model));

export function portalTranscriptionRouter({ db, userId, authenticatePortalRequest, detectHardware }) {
  if (!db) throw new Error('portalTranscriptionRouter: db required');
  if (typeof authenticatePortalRequest !== 'function') throw new Error('portalTranscriptionRouter: authenticatePortalRequest required');
  const router = express.Router();
  const auth = (req, res) => { const u = authenticatePortalRequest(req); if (!u) { res.status(401).json({ error: 'Unauthorized' }); return null; } return u; };

  async function chosenModel() {
    try { return (await db.users.getSettings(userId))?.transcribeModel || null; } catch { return null; }
  }

  router.get('/transcription/status', async (req, res) => {
    if (!auth(req, res)) return;
    const model = await chosenModel();
    // Re-attach the supervisor after a restart: the user opted in earlier, so
    // the service should be up (ensure is a no-op without a model).
    if (model) ensureTranscribeSupervisor({ model });
    let ramGB = null;
    try { ramGB = detectHardware ? (await detectHardware())?.memoryGB ?? null : null; } catch { /* optional */ }
    const recommended = CATALOG.find((c) => ramGB == null || ramGB >= c.minRamGB)?.model || 'small';
    res.json({
      ok: true,
      health: getTranscriberHealth(),
      model,
      catalog: CATALOG.map((c) => ({ ...c, recommended: c.model === recommended })),
    });
  });

  router.post('/transcription/download', async (req, res) => {
    if (!auth(req, res)) return;
    const model = String(req.body?.model || '').trim();
    if (!CATALOG_MODELS.has(model)) return res.status(400).json({ ok: false, error: 'unknown model' });

    // Persist the choice FIRST so a restart re-attaches the supervisor.
    try {
      const settings = (await db.users.getSettings(userId)) || {};
      await db.users.updateSettings(userId, { ...settings, transcribeModel: model });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'settings write failed' });
    }

    const sup = ensureTranscribeSupervisor({ model });
    sup?.setModel?.(model);
    sup?.nudge?.();

    // Wait briefly for the service to come up, then start the download.
    const base = transcribeServiceUrl();
    const deadline = Date.now() + 20_000;
    let lastErr = 'service unreachable';
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${base}/download`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
          signal: AbortSignal.timeout(3000),
        });
        if (r.status === 202 || r.status === 409) return res.json({ ok: true, model }); // started or already running
        const j = await r.json().catch(() => null);
        lastErr = j?.error || `http-${r.status}`;
        if (r.status === 503) break; // deps_missing — no point retrying
      } catch (e) {
        lastErr = 'service starting…';
      }
      await new Promise((r2) => setTimeout(r2, 1000));
    }
    const health = getTranscriberHealth();
    return res.status(502).json({ ok: false, error: lastErr, health });
  });

  return router;
}

export default portalTranscriptionRouter;
