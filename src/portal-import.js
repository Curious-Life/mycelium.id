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
import os from 'node:os';
import path from 'node:path';
import { importObsidianVault } from './ingest/obsidian-import.js';
import { importFullExport } from './ingest/full-export-import.js';
import { processClaudeCodeExport } from './ingest/import-parsers.js';
import { detectSources, readClaudeCodeEntries } from './ingest/detect-sources.js';
import { captureMessage } from './ingest/capture.js';

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

  // POST /import/full-export { dirPath } — ingest a DECRYPTED mycelium-full-export
  // directory straight off disk (GB-scale: streamed, never uploaded). Same
  // localhost-only posture as /import/obsidian folderPath: reads server-local
  // paths, gated by the vault sub-app's loopback/auth middleware.
  router.post('/import/full-export', express.json({ limit: '64kb' }), async (req, res) => {
    try {
      const dirPath = req.body?.dirPath;
      if (typeof dirPath !== 'string' || !dirPath) return res.status(400).json({ ok: false, error: 'dirPath required' });
      const summary = await importFullExport({ db, userId, dirPath, enqueueEnrichment });
      return res.json({ ok: true, ...summary });
    } catch (e) {
      const msg = String(e?.message || e);
      const is400 = /required|invalid_bundle|format|manifest/i.test(msg);
      return res.status(is400 ? 400 : 500).json({ ok: false, error: msg.slice(0, 200) });
    }
  });

  // GET /import/detect — scan this Mac's allowlist of known data-source folders
  // (Obsidian vaults, Claude Code transcripts). Presence + counts + dates ONLY,
  // never content; invoked on the explicit "Scan for data" action. Feeds the
  // catalog's "Found on this Mac — N · Import" CTAs. @see ingest/detect-sources.js.
  router.get('/import/detect', async (_req, res) => {
    try { return res.json({ ok: true, sources: detectSources() }); }
    catch { return res.status(500).json({ ok: false, error: 'detection failed' }); }
  });

  // POST /import/claude-code { folderPath? } — import detected Claude Code session
  // transcripts (~/.claude/projects/**/*.jsonl). Server reads the .jsonl off disk
  // (same loopback posture as /import/obsidian folderPath) and threads each
  // message through captureMessage with its original timestamp.
  router.post('/import/claude-code', async (req, res) => {
    try {
      const folderPath = (typeof req.body?.folderPath === 'string' && req.body.folderPath)
        ? req.body.folderPath : path.join(os.homedir(), '.claude', 'projects');
      const entries = readClaudeCodeEntries(folderPath);
      const capture = (msg) => captureMessage(db, { userId, ...msg }, enqueueEnrichment);
      const summary = await processClaudeCodeExport(entries, { capture });
      return res.json({ ok: true, scanned: entries.length, ...summary });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  });

  return router;
}
