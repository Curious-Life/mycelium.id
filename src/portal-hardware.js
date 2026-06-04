// src/portal-hardware.js — the S6 "Cookbook" portal routes: detect the box,
// recommend a local model that fits, and pull it with streaming progress.
//
// Reads the detected hardware (src/hardware/detect.js), ranks the curated
// catalog by computed fit (recommend.js), and pulls via the local Ollama daemon
// over HTTP (ollama.js — never a shell). After a pull the FRONTEND registers the
// model with the existing POST /portal/providers (no new write path here).
//
// SECURITY: a pull name must be BOTH a valid Ollama tag AND a member of our
// curated catalog — the pull surface is constrained to known-good names, so this
// route can never be used to fetch an arbitrary blob.

import express from 'express';
import { detectHardware } from './hardware/detect.js';
import { recommendModels } from './hardware/recommend.js';
import { createOllamaClient, isValidModelName } from './hardware/ollama.js';
import { CATALOG } from './hardware/catalog.js';

const CATALOG_NAMES = new Set(CATALOG.map((m) => m.name));

/**
 * @param {object} [deps]
 * @param {string} [deps.ollamaUrl]   default http://127.0.0.1:11434
 * @param {typeof fetch} [deps.fetch] injectable (tests)
 * @param {Function} [deps.detect]    injectable detectHardware (tests)
 */
export function portalHardwareRouter({ ollamaUrl, fetch = globalThis.fetch, detect = detectHardware } = {}) {
  const router = express.Router();
  const ollama = createOllamaClient({ baseUrl: ollamaUrl, fetch });

  // GET /hardware — detected specs + whether the local Ollama daemon is up.
  router.get('/hardware', async (_req, res) => {
    try {
      const hardware = await detect();
      res.json({ ok: true, hardware, ollamaUp: await ollama.isUp() });
    } catch { res.status(500).json({ ok: false, error: 'hardware detection failed' }); }
  });

  // GET /hardware/recommend — ranked models for this box, flagged if installed.
  router.get('/hardware/recommend', async (_req, res) => {
    try {
      const hardware = await detect();
      const rec = recommendModels(hardware);
      let installed = [];
      let ollamaUp = false;
      try { installed = await ollama.listInstalled(); ollamaUp = true; }
      catch { ollamaUp = await ollama.isUp(); }
      const have = new Set(installed);
      res.json({
        ok: true,
        hardware,
        ...rec,
        recommendations: rec.recommendations.map((m) => ({ ...m, installed: have.has(m.name) })),
        ollamaUp,
      });
    } catch { res.status(500).json({ ok: false, error: 'recommendation failed' }); }
  });

  // POST /hardware/pull { name } — stream Ollama pull progress as SSE. The name
  // must be a curated-catalog model (defence in depth on the pull surface).
  router.post('/hardware/pull', async (req, res) => {
    const name = String(req.body?.name || '');
    if (!isValidModelName(name) || !CATALOG_NAMES.has(name)) {
      return res.status(400).json({ ok: false, error: 'unknown model' });
    }
    res.set('Content-Type', 'text/event-stream; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.set('Connection', 'keep-alive');
    const send = (ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* client gone */ } };
    try {
      await ollama.pullModel(name, (ev) => send({ status: ev.status, completed: ev.completed, total: ev.total }));
      send({ done: true, ok: true });
    } catch {
      send({ done: true, ok: false, error: 'pull failed' });
    }
    try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* ignore */ }
  });

  return router;
}

export default portalHardwareRouter;
