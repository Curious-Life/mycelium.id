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
//
// PATH CONFINEMENT: the folderPath/dirPath modes read server-local files off
// disk. A stolen owner Bearer (over the Tailscale TLS surface) or a malicious
// portal page could otherwise point them at ~/Library/Messages, ~/.ssh, mounted
// volumes, etc. and read those back out of the vault. Every server-supplied
// path is therefore passed through assertImportPathAllowed (detect-sources.js):
// realpath-resolved (collapsing symlink escapes) and required to sit inside the
// allowlist (Obsidian config vaults + ~/.claude/projects + the explicit
// MYCELIUM_IMPORT_ALLOWED_ROOTS out-of-band grant). Anything else → 400,
// fail-closed. The browser `files` mode ships content in the body (no path read)
// and is not subject to confinement.

import express from 'express';
import os from 'node:os';
import path from 'node:path';
import { importObsidianVault } from './ingest/obsidian-import.js';
import { importFullExport } from './ingest/full-export-import.js';
import { processClaudeCodeExport } from './ingest/import-parsers.js';
import { importHermes } from './ingest/hermes-import.js';
import { importOpenClaw } from './ingest/openclaw-import.js';
import { importLocalFiles } from './ingest/local-files-import.js';
import { detectSources, probeSweepAccess, readClaudeCodeEntries, assertImportPathAllowed, hermesPaths, openClawPaths, localSweepRoots } from './ingest/detect-sources.js';
import { captureMessage } from './ingest/capture.js';
import { getImportSource, importCatalog } from './ingest/registry.js';
import { createImportJobRunner } from './ingest/import-job.js';

// ONE error responder for every import route — replaces the per-route is400 regex
// copy-paste. Known caller errors (bad input, denied path, bad bundle) → 4xx;
// everything else → 500. Never leaks a stack. `e.code` is the canonical signal;
// the message regex is the fallback for the legacy importers that only throw text.
function respondImportError(res, e) {
  const msg = String(e?.message || e);
  const code = e?.code;
  let status = 500;
  if (code === 'bad_request' || code === 'invalid_bundle' || code === 'import_path_denied') status = 400;
  else if (/required|not a directory|folderPath|dirPath|files|import_path_denied|invalid_bundle|not found|unknown import/i.test(msg)) status = 400;
  return res.status(status).json({ ok: false, error: msg.slice(0, 200) });
}

export function portalImportRouter({ db, userId, enqueueEnrichment }) {
  const router = express.Router();
  // Browser `files` mode ships note bodies as JSON — and vault images/media as
  // base64 entries (contentBase64), which inflate 4/3 — so the ceiling is
  // generous and env-tunable. folderPath mode (Tauri) sends a tiny body.
  // Per-file/total caps live in importObsidianVault.
  const limitMb = Number(process.env.MYCELIUM_OBSIDIAN_IMPORT_LIMIT_MB) || 256;
  router.use(express.json({ limit: `${limitMb}mb` }));

  // ── Generic import surface (registry-driven, async) ──────────────────────────
  // ONE async background job for every registry source with a `run` — same
  // single-flight + progress + cancel envelope the local-files sweep pioneered,
  // now shared. Adding an import source = a registry entry; no new route.
  //   POST /import/run          { key, ...opts }  → start (idempotent), return progress
  //   GET  /import/run/progress                    → poll
  //   POST /import/run/cancel                       → cooperative stop
  //   GET  /import/catalog                          → the registry (frontend reads this)
  // Publish to the ONE progress surface (design §3.4). Imports were the gap: jobs.js has
  // published clustering/narration for ages, but an import — the longest thing a new user
  // waits on — was visible only to the component that started it (QA item 3).
  //
  // SCOPE, stated honestly — and CORRECTED 2026-07-16 after a second review caught this very
  // comment claiming more than it delivers (the eighth false comment found this session, in
  // the sentence written to retire the seventh; verify the route, not the registry):
  //
  //   COVERED — the async imports: `recent-export` via POST /import/run (the ONLY key the UI
  //     routes here — import/detect.ts ASYNC_RUN_SOURCES), and the local-files sweep below.
  //   NOT COVERED — everything still served by a synchronous POST that holds the request
  //     open: the capture four (obsidian, claude-code, hermes, openclaw) AND `full-export`.
  //     full-export HAS a `run` and is reachable via /import/run in principle, but no product
  //     path takes it: detect.ts has no import-full-export branch, so it ships through its
  //     legacy route (POST /import/full-export) instead. A `run` in the registry is not
  //     evidence that anything calls it.
  //
  // For all of those there is no job to publish, and navigating away kills the request
  // outright — feeding them means making them `run` sources FIRST (the Increment-2 migration
  // registry.js already names), not adding a publish call.
  const jobs = createImportJobRunner({ activityFeed: db?.activityFeed || null, userId });

  router.get('/import/catalog', (_req, res) => res.json({ ok: true, sources: importCatalog() }));

  router.post('/import/run', async (req, res) => {
    try {
      const key = req.body?.key;
      const src = typeof key === 'string' ? getImportSource(key) : null;
      if (!src) return res.status(400).json({ ok: false, error: `unknown import source: ${key}` });
      if (typeof src.run !== 'function') {
        return res.status(400).json({ ok: false, error: `source "${key}" is served by ${src.legacyRoute || 'its own route'}, not /import/run` });
      }
      const snapshot = jobs.start({
        key,
        // The registry's label is a hardcoded CONSTANT per source ('Obsidian', 'Mycelium
        // recent export'), never user input — which is what makes it safe in a stage_label:
        // background_jobs is content-free by contract (db/activity-feed.js §SECURITY).
        label: src.label ? `Importing ${src.label}` : 'Importing your data',
        run: ({ onProgress, shouldCancel }) => src.run(db, { userId, enqueueEnrichment, onProgress, shouldCancel, body: req.body || {} }),
      });
      return res.json({ ok: true, ...snapshot });
    } catch (e) { return respondImportError(res, e); }
  });
  router.get('/import/run/progress', (_req, res) => res.json({ ok: true, ...jobs.progress() }));
  router.post('/import/run/cancel', (_req, res) => res.json({ ok: true, ...jobs.cancel() }));

  router.post('/import/obsidian', async (req, res) => {
    try {
      const { folderPath, files, vaultName } = req.body || {};
      if (!folderPath && !Array.isArray(files)) {
        return res.status(400).json({ ok: false, error: 'folderPath or files[] required' });
      }
      // folderPath reads off server disk — confine it to the import allowlist
      // (fail-closed). `files` mode ships content in the body (no path read).
      const safePath = folderPath ? assertImportPathAllowed(folderPath) : undefined;
      const summary = await importObsidianVault(db, { userId, folderPath: safePath, files, vaultName, enqueueEnrichment });
      return res.json({ ok: true, ...summary });
    } catch (e) {
      const msg = String(e?.message || e);
      // Known caller errors → 400; everything else → 500. Never leak a stack.
      const is400 = /required|not a directory|folderPath|files|import_path_denied/i.test(msg);
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
      // Confine to the import allowlist. A full-export bundle lives outside the
      // Obsidian/Claude roots, so the operator/Tauri shell must grant its parent
      // via MYCELIUM_IMPORT_ALLOWED_ROOTS (see assertImportPathAllowed).
      const safeDir = assertImportPathAllowed(dirPath);
      const summary = await importFullExport({ db, userId, dirPath: safeDir, enqueueEnrichment });
      return res.json({ ok: true, ...summary });
    } catch (e) {
      const msg = String(e?.message || e);
      const is400 = /required|invalid_bundle|format|manifest|import_path_denied/i.test(msg);
      return res.status(is400 ? 400 : 500).json({ ok: false, error: msg.slice(0, 200) });
    }
  });

  // GET /import/detect — scan this Mac's allowlist of known data-source folders
  // (Obsidian vaults, Claude Code transcripts). Presence + counts + dates ONLY,
  // never content; invoked on the explicit "Scan for data" action. Feeds the
  // catalog's "Found on this Mac — N · Import" CTAs. @see ingest/detect-sources.js.
  router.get('/import/detect', async (_req, res) => {
    try {
      const sources = detectSources();
      // ON-5: report broad-sweep roots macOS is currently BLOCKING (TCC prompt
      // pending / access denied) so the UI can distinguish "nothing here" from
      // "we couldn't look yet — grant access + re-scan." basename only (never the
      // full home path) — the presence of "Documents"/"Downloads" is all the UI
      // needs and it keeps the user's home layout out of the response.
      const blocked = probeSweepAccess().map((p) => path.basename(p));
      return res.json({ ok: true, sources, blocked });
    } catch { return res.status(500).json({ ok: false, error: 'detection failed' }); }
  });

  // POST /import/claude-code { folderPath? } — import detected Claude Code session
  // transcripts (~/.claude/projects/**/*.jsonl). Server reads the .jsonl off disk
  // (same loopback posture as /import/obsidian folderPath) and threads each
  // message through captureMessage with its original timestamp.
  router.post('/import/claude-code', async (req, res) => {
    try {
      const folderPath = (typeof req.body?.folderPath === 'string' && req.body.folderPath)
        ? req.body.folderPath : path.join(os.homedir(), '.claude', 'projects');
      // Confine the on-disk read to the import allowlist (fail-closed). The
      // default ~/.claude/projects is itself an allowed root.
      const safePath = assertImportPathAllowed(folderPath);
      // 'clean' (default) imports just the human↔agent conversation; 'full' keeps
      // tool/meta turns too. Either way the full raw line is kept in metadata.raw.
      const mode = req.body?.mode === 'full' ? 'full' : 'clean';
      const entries = readClaudeCodeEntries(safePath);
      const capture = (msg) => captureMessage(db, { userId, ...msg }, enqueueEnrichment);
      const summary = await processClaudeCodeExport(entries, { capture }, { mode });
      return res.json({ ok: true, scanned: entries.length, ...summary });
    } catch (e) {
      const msg = String(e?.message || e);
      const status = /import_path_denied/i.test(msg) ? 400 : 500;
      return res.status(status).json({ ok: false, error: msg.slice(0, 200) });
    }
  });

  // POST /import/hermes { mode? } — import the local Hermes install's conversation
  // history (~/.hermes/state.db) + persona (SOUL.md). The on-disk reads are
  // confined to ~/.hermes via the allowlist (a stolen Bearer can't redirect them).
  router.post('/import/hermes', async (req, res) => {
    try {
      const { statePath, soulPath } = hermesPaths(os.homedir());
      // Confine the DB read to the allowed roots (~/.hermes is an allowed root).
      const safeState = assertImportPathAllowed(statePath);
      // SOUL.md may be absent — only confine+pass it when it actually resolves.
      let safeSoul; try { safeSoul = assertImportPathAllowed(soulPath); } catch { safeSoul = undefined; }
      const mode = req.body?.mode === 'full' ? 'full' : 'clean';
      const summary = await importHermes(db, { userId, statePath: safeState, soulPath: safeSoul, mode, enqueueEnrichment });
      return res.json({ ok: true, ...summary });
    } catch (e) {
      const msg = String(e?.message || e);
      const is400 = /import_path_denied|required|statePath|hermes_state_unreadable/i.test(msg);
      return res.status(is400 ? 400 : 500).json({ ok: false, error: msg.slice(0, 200) });
    }
  });

  // POST /import/openclaw { mode? } — import the local OpenClaw agent's session
  // transcripts (agents/main/sessions/*.jsonl) + workspace memory docs
  // (workspace/*.md). On-disk reads confined to ~/.openclaw via the allowlist.
  router.post('/import/openclaw', async (req, res) => {
    try {
      const { sessionsDir, workspaceDir } = openClawPaths(os.homedir());
      // Confine each dir; either may be absent on a partial install.
      let safeSessions; try { safeSessions = assertImportPathAllowed(sessionsDir); } catch { safeSessions = undefined; }
      let safeWorkspace; try { safeWorkspace = assertImportPathAllowed(workspaceDir); } catch { safeWorkspace = undefined; }
      if (!safeSessions && !safeWorkspace) return res.status(400).json({ ok: false, error: 'openclaw not found' });
      const mode = req.body?.mode === 'full' ? 'full' : 'clean';
      const summary = await importOpenClaw(db, { userId, sessionsDir: safeSessions, workspaceDir: safeWorkspace, mode, enqueueEnrichment });
      return res.json({ ok: true, ...summary });
    } catch (e) {
      const msg = String(e?.message || e);
      const is400 = /import_path_denied|required|sessionsDir|workspaceDir|not found/i.test(msg);
      return res.status(is400 ? 400 : 500).json({ ok: false, error: msg.slice(0, 200) });
    }
  });

  // ── Broad local-files sweep — ASYNC background job with live progress ─────────
  // A sweep of ~/Documents,Pictures,… can be 10k+ files (media read + encrypted +
  // blob-written sequentially), which is minutes of work. Running it inside the
  // POST would hold one request open with NO feedback — indistinguishable from
  // "hung" (the reported bug). So the sweep runs in the BACKGROUND: POST starts it
  // and returns immediately; the UI polls GET …/progress and can POST …/cancel.
  // Single-flight (one sweep at a time — single-user V1); re-POSTing while one runs
  // just returns its progress (idempotent re-click / reconnect after a lost tab).
  //
  // It runs on THE shared import envelope (createImportJobRunner) — the same one
  // /import/run uses. It had a hand-rolled twin until 2026-07-16: the comment above
  // /import/run has claimed the sweep's envelope was "now shared" since the runner was
  // extracted, but the sweep was never actually migrated onto it, so the two drifted —
  // and the sweep, the LONGEST import a new user runs, was the one left off the activity
  // feed (independent review; the exact bug §3.4 exists to kill).
  //
  // Its OWN runner instance, so single-flight is PER-SURFACE: a sweep and an /import/run can
  // run at once. Reviewed on its own merits (2026-07-16) and KEPT — but the reasons are
  // narrower than the first draft of this comment claimed, so here is what was actually found.
  //
  // NOT a corruption risk. The 2026-06-30 "concurrent writers" incident was CROSS-process
  // (db/writer-lock.js's job, never this runner's) and its mechanism is refuted besides
  // (repro-corruption.mjs: concurrent WAL writers are clean; the proven cause was a torn file
  // copy). In-process it cannot arise at all — Node is single-threaded and better-sqlite3 is
  // synchronous, so two imports interleave at awaits but never write at once.
  //
  // NO DUPLICATE ROWS, but the guard is uneven and worth knowing:
  //   • messages + every restore table absorb it (INSERT OR IGNORE); documents too
  //     (UNIQUE(user_id,path) + ON CONFLICT DO UPDATE).
  //   • attachments do NOT — db/attachments.js insert() is a bare INSERT … RETURNING, so a
  //     duplicate id THROWS and local-files-import.js's catch counts it as `failed`. What keeps
  //     that off these two surfaces is that their ids don't practically collide (a sweep's attId
  //     is sha256('local:'+path); an export carries its own, canonically a random 16-byte hex) —
  //     improbable, NOT disjoint, and a coincidence holding a line rather than a design. Do not
  //     lean on it.
  //
  // DUPLICATE BLOBS are the one real cost (disk waste, not integrity) — but only PART of it is
  // this concurrency's fault, and the distinction is what makes the trade honest:
  //   • concurrency's share: local-files-import.js's blobByHash is a one-shot snapshot taken at
  //     sweep start, so it cannot see what a concurrent import lands afterwards. A global gate
  //     WOULD fix this part. (existingAttIds, the next line over, is snapshot-blind in exactly
  //     the same way.)
  //   • not concurrency's share: restore-core.js putBlob()s every attachment with no hash dedup
  //     at all (putBlob names blobs by randomUUID — it is not content-addressed). Sweep-then-
  //     export writes those bytes twice whether or not the two ever overlap. A global gate buys
  //     nothing here.
  // (An earlier draft said the duplication needed "two sweeps of one folder, which single-flight
  // already prevents" — false, and caught in review.)
  //
  // Judged worth it: going global would cost a real capability (sweeping while an export runs)
  // and force these two progress routes to answer for a job the caller never started — to buy
  // back only the first bullet's share of some duplicate bytes. What the concurrency DID cost
  // outright was a feed-id collision — a real bug, fixed at its source in import-job.js
  // (verify:import-activity A7c).
  const sweep = createImportJobRunner({ activityFeed: db?.activityFeed || null, userId });
  // Sweep-only fields the generic envelope has no business knowing about. `truncated` is
  // read by the UI (import/detect.ts SweepProgress); `roots` is informational.
  // NOTE: moving onto the shared envelope WIDENS these routes' responses — they now also
  // carry publicJob's `key`, `cancelled` and `result`. Harmless (asSweep in detect.ts spreads
  // the body, and all three are content-free on an authed route), but it is a real shape
  // change, recorded here rather than left for someone to find.
  let sweepMeta = { roots: 0, truncated: false };
  const publicSweep = () => {
    const p = sweep.progress();
    return p.status === 'idle' ? { status: 'idle' } : { ...p, ...sweepMeta };
  };

  router.post('/import/local-files', async (req, res) => {
    try {
      // Already running → just report progress (idempotent; a re-click re-attaches).
      if (sweep.isRunning()) return res.json({ ok: true, ...publicSweep() });
      const categories = Array.isArray(req.body?.categories) ? req.body.categories : undefined;
      const folderPath = req.body?.folderPath;
      let roots;
      if (typeof folderPath === 'string' && folderPath) {
        roots = [assertImportPathAllowed(folderPath)]; // one picked folder (confined)
      } else {
        // Server-driven sweep: confine each standard root, drop the ones absent.
        roots = [];
        for (const r of localSweepRoots(os.homedir())) {
          try { roots.push(assertImportPathAllowed(r)); } catch { /* not present on this Mac → skip */ }
        }
        if (!roots.length) return res.status(400).json({ ok: false, error: 'no sweepable folders found' });
      }
      sweepMeta = { roots: roots.length, truncated: false };
      // Start the job and return immediately — the work runs detached inside the runner.
      sweep.start({
        key: 'local-files',
        // A CONSTANT — never a scanned path. A stage_label is emitted LIVE to the feed UI
        // (portal-activity.js shape() maps it to `stage`), and the roots are ~/Documents,
        // ~/Pictures… i.e. the user's own filesystem layout.
        label: 'Importing files from this Mac',
        run: async ({ onProgress, shouldCancel }) => {
          let baseTotal = 0, baseProcessed = 0, baseImported = 0, baseDeduped = 0, baseSkipped = 0, baseFailed = 0;
          const acc = { total: 0, processed: 0, imported: 0, deduped: 0, skipped: 0, failed: 0 };
          for (const root of roots) {
            if (shouldCancel()) break;
            const s = await importLocalFiles(db, {
              userId, folderPath: root, categories, enqueueEnrichment, shouldCancel,
              onProgress: (p) => {
                // Fold this root's live counts onto the finished-roots baseline.
                acc.total = baseTotal + p.total; acc.processed = baseProcessed + p.processed;
                acc.imported = baseImported + p.imported; acc.deduped = baseDeduped + p.deduped;
                acc.skipped = baseSkipped + p.skipped; acc.failed = baseFailed + p.failed;
                onProgress(acc);
              },
            });
            baseTotal += s.scanned; baseProcessed = acc.processed;
            baseImported += s.documents.created + s.attachments.imported;
            baseDeduped += s.documents.deduped + s.attachments.deduped;
            baseSkipped += s.skipped.oversize + s.skipped.unreadable + s.skipped.unsafe;
            baseFailed += s.failed;
            sweepMeta.truncated = sweepMeta.truncated || !!s.truncated;
            // Republish the folded baseline: a root that ends between ticks would otherwise
            // leave the last root's live counts as the final word.
            acc.total = baseTotal; acc.imported = baseImported; acc.deduped = baseDeduped;
            acc.skipped = baseSkipped; acc.failed = baseFailed;
            onProgress(acc);
            if (s.cancelled) break;
          }
          return { ...acc, cancelled: shouldCancel() };
        },
      });
      return res.json({ ok: true, ...publicSweep() });
    } catch (e) {
      const msg = String(e?.message || e);
      const is400 = /import_path_denied|required|not a directory|no sweepable/i.test(msg);
      return res.status(is400 ? 400 : 500).json({ ok: false, error: msg.slice(0, 200) });
    }
  });

  // GET /import/local-files/progress — poll the running/last sweep's counts.
  router.get('/import/local-files/progress', (_req, res) => {
    res.json({ ok: true, ...publicSweep() });
  });

  // POST /import/local-files/cancel — request the running sweep stop (cooperative,
  // checked per file). Already-imported files stay (idempotent re-run resumes).
  router.post('/import/local-files/cancel', (_req, res) => {
    sweep.cancel();
    res.json({ ok: true, ...publicSweep() });
  });

  return router;
}
