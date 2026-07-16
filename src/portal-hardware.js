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
import { ONBOX_TASKS } from './inference/resolve.js';   // deleting a LOCAL file may only revoke LOCAL approvals
import { createOllamaDaemon } from './hardware/ollama-daemon.js';
import { CATALOG } from './hardware/catalog.js';

const CATALOG_NAMES = new Set(CATALOG.map((m) => m.name));

/**
 * @param {object} [deps]
 * @param {string} [deps.ollamaUrl]   default http://127.0.0.1:11434
 * @param {typeof fetch} [deps.fetch] injectable (tests)
 * @param {Function} [deps.detect]    injectable detectHardware (tests)
 * @param {object} [deps.daemon]      injectable ollama-daemon (tests); default
 *                                    is a lazy adopt-or-spawn controller.
 * @param {object} [deps.db]          vault DAL — needed to clear a deleted model's
 *                                    APPROVAL (see the delete route). Optional so
 *                                    existing test mounts keep working; absent ⇒ the
 *                                    delete still frees the disk, it just can't
 *                                    persist the decline.
 * @param {string} [deps.userId]      owner id for the settings write.
 */
export function portalHardwareRouter({ ollamaUrl, fetch = globalThis.fetch, detect = detectHardware, daemon, db = null, userId = null } = {}) {
  const router = express.Router();
  const ollama = createOllamaClient({ baseUrl: ollamaUrl, fetch });
  const ollamaDaemon = daemon || createOllamaDaemon({ baseUrl: ollamaUrl, fetch });

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
        // Distinguishes "installed but stopped" (we auto-start) from "not
        // installed" (UI shows a guided-install link instead of a dead button).
        ollamaInstalled: ollamaDaemon.isInstalled(),
      });
    } catch { res.status(500).json({ ok: false, error: 'recommendation failed' }); }
  });

  // POST /hardware/start — lazily bring the local Ollama daemon up (adopt if a
  // daemon is already running; otherwise spawn `ollama serve`). Returns the
  // outcome so the UI can show "started" / "install Ollama" / "couldn't start".
  router.post('/hardware/start', async (_req, res) => {
    try { res.json({ ...(await ollamaDaemon.ensureUp()) }); }
    catch { res.status(500).json({ ok: false, error: 'start failed' }); }
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
      // Auto-start the daemon first: adopt if running, else spawn `ollama serve`,
      // DOWNLOADING the Ollama runtime first if it isn't installed. Download
      // progress is streamed as a status line. If it can't come up, surface WHY
      // (not_installed / checksum_mismatch / unsupported_platform / start_timeout)
      // and stop — never attempt a pull against a dead daemon.
      send({ status: 'starting ollama…' });
      const up = await ollamaDaemon.ensureUp((pct) => send({ status: 'downloading Ollama…', completed: pct, total: 100 }));
      if (!up.ok) {
        send({ done: true, ok: false, error: up.reason || 'ollama_unavailable' });
      } else {
        await ollama.pullModel(name, (ev) => send({ status: ev.status, completed: ev.completed, total: ev.total }));
        send({ done: true, ok: true });
      }
    } catch {
      send({ done: true, ok: false, error: 'pull failed' });
    }
    try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* ignore */ }
  });

  /**
   * Unset every per-task approval that names `deleted`, so the delete is a DURABLE decline.
   *
   * Read-modify-write: `db.users.updateSettings` REPLACES the whole settings blob, so we must
   * merge rather than write a fresh object — anything else would silently drop unrelated
   * settings (the bare-UPDATE class of bug that already dropped taskModels once on a fresh
   * vault; see db/users.js:41).
   *
   * Matches the model name EXACTLY: `settings.taskModels.<task>.model` holds the string the
   * owner approved, and it is the same string this route just deleted. No base/tag fuzziness —
   * a loose match here would clear an approval for a model that still exists.
   *
   * ⚠️ ON-BOX TASKS ONLY. This deletes a LOCAL FILE, so it may only revoke LOCAL approvals.
   * Filtering every task by name alone silently re-routed CLOUD tasks: a provider serving an
   * open model under the same name (`narrate: {providerId:'regolo-1', model:'qwen3.5:4b'}`)
   * had its model nulled by a local disk operation, falling back to the provider default —
   * a remote behaviour change nobody asked for (independent re-review, 2026-07-16).
   *
   * Runs BEFORE the disk delete (see the route), so a failure here is cheap: nothing has been
   * destroyed yet and the caller aborts. Returns { cleared, persisted } — `persisted:false`
   * means the revoke did NOT land, and the caller MUST NOT proceed to delete the file.
   */
  async function clearApprovalsFor(deleted) {
    if (!db?.users || !userId) return { cleared: [], persisted: true };
    try {
      const settings = (await db.users.getSettings(userId)) || {};
      const taskModels = settings.taskModels;
      if (!taskModels || typeof taskModels !== 'object' || Array.isArray(taskModels)) return { cleared: [], persisted: true };
      const cleared = Object.keys(taskModels)
        .filter((task) => ONBOX_TASKS.has(task) && taskModels[task]?.model === deleted);
      if (!cleared.length) return { cleared: [], persisted: true };
      const next = {
        ...settings,
        taskModels: Object.fromEntries(Object.entries(taskModels).map(([task, cfg]) => (
          cleared.includes(task) ? [task, { ...cfg, model: null }] : [task, cfg]
        ))),
      };
      await db.users.updateSettings(userId, next);
      return { cleared, persisted: true };
    } catch {
      return { cleared: [], persisted: false };   // the delete stands; the DECLINE did not
    }
  }

  // Delete a model FROM DISK (frees space). Destructive + irreversible — the UI gates it
  // behind an explicit confirm. HTTP-only (Ollama's DELETE /api/delete, never `ollama rm`),
  // charset-validated, and only for a model that is ACTUALLY installed (honest 404 + a
  // second guard so a name can only ever name a real installed model).
  router.post('/hardware/delete', async (req, res) => {
    const name = String(req.body?.name || '');
    if (!isValidModelName(name)) return res.status(400).json({ ok: false, error: 'invalid model name' });
    try {
      let installed = [];
      try { installed = await ollama.listInstalled(); } catch { /* daemon down → nothing installed */ }
      if (!installed.includes(name)) return res.status(404).json({ ok: false, error: 'not installed' });

      // ⚠️ REVOKE FIRST, DELETE LAST — the order is the safety property, not a style choice.
      //
      // Deleting the file first and revoking after leaves a window where the model is GONE but
      // the vault still thinks the owner wants it. The drainer resolves that approval, finds
      // the model absent, and does the correct thing for an approved-and-absent model: it
      // FETCHES it (§3.10d.2). So a failed settings write turned the owner's delete into an
      // immediate unconsented 3.4GB re-download — the exact class M1/M3 forbid, and worse than
      // the restart-later version it replaced. Probed:
      //     DELETE (write fails) → 200 {"ok":true,"declinePersisted":false}
      //     after delete         → ok | pulls=1 pulled=["qwen3.5:4b"]
      // Reporting the failure was not enough; the download had already started.
      //
      // Revoking first makes the bad window impossible: no approval ⇒ nothing to resolve ⇒
      // nothing to fetch, whatever happens next. If the revoke fails we delete NOTHING and say
      // so — the owner keeps a working model and can retry, which is the fail-closed answer.
      const { cleared, persisted } = await clearApprovalsFor(name);
      if (!persisted) {
        return res.status(500).json({ ok: false, error: 'could not revoke the approval — nothing was deleted' });
      }

      const r = await ollama.deleteModel(name);
      if (!r.ok) {
        // The approval is already revoked and we do NOT roll it back: a compensating write can
        // fail too, and re-approving something that is still on disk is a one-click, fully
        // recoverable state — whereas an un-revoked approval is a silent download.
        return res.status(r.notFound ? 404 : 502).json({
          ok: false,
          error: r.notFound ? 'not installed' : 'delete failed',
          ...(cleared.length ? { clearedApprovals: cleared } : {}),
        });
      }
      // THE DELETE IS ALSO A DECLINE — persist it (§3.10c/§3.10d).
      //
      // Freeing the disk while LEAVING `settings.taskModels.<task>.model` naming the deleted
      // model left two holes the drainer alone could not close, because its guard is in-memory:
      //   • the next restart re-pulls the 3.4GB unasked — approved + absent is indistinguishable
      //     from a first fetch, and restarts are routine (Tauri relaunch; the watchdog respawns
      //     on SIGKILL in ~25s). "Never re-pull" silently expired one process later.
      //   • the remedy the drainer's own health message advertises ("re-approve it in Settings")
      //     was a NO-OP: the approval was never cleared, so re-picking it wrote the identical
      //     string and changed nothing.
      // Clearing it here makes the decline DURABLE and the remedy REAL: the setting is unset ⇒
      // resolveLabelModel() returns null ⇒ nothing resolves, nothing pulls, health reads the
      // existing 'no_model' — and re-approving is a genuine change that re-consents the pull.
      //
      // ⚠️ SAFE BECAUSE IT IS EXPLICIT. This clears an approval only on the owner's own
      // deliberate delete of a model this route just verified installed and removed — never on
      // an INFERENCE. The drainer must not do this: a spurious empty `ollama list` (a real blip
      // shape) would erase a live approval on a false negative.
      return res.json({ ok: true, ...(cleared.length ? { clearedApprovals: cleared } : {}) });
    } catch { return res.status(500).json({ ok: false, error: 'delete failed' }); }
  });

  return router;
}

export default portalHardwareRouter;
