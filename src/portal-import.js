// Portal import routes beyond the ZIP/file upload surface (src/portal-uploads.js).
//
//   POST /api/v1/portal/import/obsidian
//     { folderPath }                              — Tauri native folder picker
//     { files:[{relPath,content,mtime?}], vaultName? } — browser webkitdirectory
//   → walks/reads *.md and ingests each note as a document + a memory.
//
// Localhost-only, no per-request auth (the vault-init guard in server-rest.js
// 503s these until the vault is open). Encryption + dedup happen downstream in
// importObsidianVault → saveDocument / captureMessage.

import express from 'express';
import { importObsidianVault } from './ingest/obsidian-import.js';

export function portalImportRouter({ db, userId, enqueueEnrichment }) {
  const router = express.Router();
  // Browser `files` mode ships note bodies as JSON — and vault images/media as
  // base64 entries (contentBase64), which inflate 4/3 — so the ceiling is
  // generous and env-tunable. folderPath mode (Tauri) sends a tiny body.
  // Per-file/total caps live in importObsidianVault.
  const limitMb = Number(process.env.MYCELIUM_OBSIDIAN_IMPORT_LIMIT_MB) || 256;
  router.use(express.json({ limit: `${limitMb}mb` }));

  router.post('/import/obsidian', async (req, res) => {
    try {
      const { folderPath, files, vaultName } = req.body || {};
      if (!folderPath && !Array.isArray(files)) {
        return res.status(400).json({ ok: false, error: 'folderPath or files[] required' });
      }
      const summary = await importObsidianVault(db, { userId, folderPath, files, vaultName, enqueueEnrichment });
      return res.json({ ok: true, ...summary });
    } catch (e) {
      const msg = String(e?.message || e);
      // Known caller errors → 400; everything else → 500. Never leak a stack.
      const is400 = /required|not a directory|folderPath|files/i.test(msg);
      return res.status(is400 ? 400 : 500).json({ ok: false, error: msg.slice(0, 200) });
    }
  });

  return router;
}
