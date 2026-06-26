// Portal system routes — OS-level toggles the app configures on the user's behalf.
//
//   GET  /api/v1/portal/system/keep-awake   → { supported, active, enabled, onAC?, ... }
//   POST /api/v1/portal/system/keep-awake { enabled } → persist the preference AND
//        start/stop the live assertion in THIS process (the always-on server that
//        holds it — see src/system/keep-awake.js).
//
// Localhost-only, behind the vault sub-app's auth/loopback guard (like the other
// portal routers). The setting persists in users.settings.keepAwake.enabled.

import express from 'express';
import { execFile } from 'node:child_process';
import { keepAwakeStatus, startKeepAwake, stopKeepAwake } from './system/keep-awake.js';

const log = (m) => console.error(`[mycelium] ${m}`);

/** Best-effort: is the Mac on AC power? null when unknown / not macOS. */
function detectOnAC() {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve(null);
    try {
      execFile('pmset', ['-g', 'batt'], { timeout: 1500 }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        resolve(/'AC Power'/.test(stdout));
      });
    } catch { resolve(null); }
  });
}

export function portalSystemRouter({ db, userId }) {
  const router = express.Router();
  router.use(express.json({ limit: '8kb' }));

  router.get('/system/keep-awake', async (_req, res) => {
    let enabled = true; // default ON; only an explicit false disables it
    try { enabled = (await db.users.getSettings(userId))?.keepAwake?.enabled !== false; } catch { /* default */ }
    const onAC = await detectOnAC();
    res.json({ ok: true, enabled, onAC, ...keepAwakeStatus() });
  });

  router.post('/system/keep-awake', async (req, res) => {
    // Default ON: anything but an explicit false enables.
    const enabled = !(req.body?.enabled === false || req.body?.enabled === 'false');
    // Persist (read-modify-write — updateSettings replaces the whole blob).
    try {
      const s = (await db.users.getSettings(userId)) || {};
      await db.users.updateSettings(userId, { ...s, keepAwake: { ...(s.keepAwake || {}), enabled } });
    } catch (e) { log(`keep-awake: setting not persisted (${e?.message || e})`); }
    // Apply live in this process.
    const status = enabled ? startKeepAwake({ logger: log }) : stopKeepAwake({ logger: log });
    const onAC = await detectOnAC();
    res.json({ ok: true, enabled, onAC, ...status });
  });

  return router;
}
