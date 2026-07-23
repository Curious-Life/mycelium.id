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
import { createOllamaClient, isValidModelName, classifyOllamaFault } from './hardware/ollama.js';
import { ONBOX_TASKS } from './inference/resolve.js';   // deleting a LOCAL file may only revoke LOCAL approvals
import { createOllamaDaemon } from './hardware/ollama-daemon.js';
import { CATALOG } from './hardware/catalog.js';
import { normalizeHealth } from './system/service-state.js';

const CATALOG_NAMES = new Set(CATALOG.map((m) => m.name));

// Actionable copy for a version-incompatible runtime (a 412 on pull, or a too-old daemon we
// refused to adopt). Kept here so the SSE carries the remedy verbatim even if a client doesn't
// map the fault CODE — the point of N2 is that this must NOT read as the generic "check your
// network". Mirrors drainer.js FAULT_MESSAGE[INCOMPATIBLE_RUNTIME] + IntelligenceFlow's copy.
const INCOMPATIBLE_RUNTIME_MSG = 'Your Ollama runtime is too old for this model — upgrade Ollama, or let Mycelium manage its own.';

// POST /hardware/retry answer budget (LOW-6): how long we let a bring-up run before answering with
// the honest in-progress health rather than blocking on a multi-hundred-MB runtime download. The
// download itself continues in the daemon's single-flight; the client polls GET /hardware/ollama.
// Read at request time (not frozen at import) so a gate can drive the bounded path with a small budget.
const retryBringupBudgetMs = () => Number(process.env.MYCELIUM_RETRY_BRINGUP_MS) || 3000;

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
export function portalHardwareRouter({ ollamaUrl, fetch = globalThis.fetch, detect = detectHardware, daemon, db = null, userId = null, authenticatePortalRequest = null } = {}) {
  const router = express.Router();
  // Session gate for the routes that ACT on the daemon (retry). Optional so the existing
  // verify mounts keep working; when absent the route is still behind the global /api
  // owner gate that fronts every /api/v1/portal mount (server-rest.js) — this is the
  // second, per-router layer (CLAUDE.md §2 defence in depth), never the only one.
  const gate = (req, res) => {
    if (typeof authenticatePortalRequest !== 'function') return true;
    if (authenticatePortalRequest(req)) return true;
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return false;
  };
  const ollamaDaemon = daemon || createOllamaDaemon({ baseUrl: ollamaUrl, fetch });
  // Resolve the ollama client at USE time from the daemon's EFFECTIVE base, so after an alt-port
  // self-heal (ollama-daemon.js getBaseUrl) every list/pull/delete here dials the healed port
  // instead of the too-old squatter on :11434. Falls back to the configured ollamaUrl (→ the
  // createOllamaClient env-aware default) when the daemon has no getBaseUrl (injected test stub).
  const ollamaClient = () => createOllamaClient({ baseUrl: ollamaDaemon.getBaseUrl?.() ?? ollamaUrl, fetch });

  // GET /hardware — detected specs + whether the local Ollama daemon is up.
  router.get('/hardware', async (_req, res) => {
    try {
      const hardware = await detect();
      res.json({ ok: true, hardware, ollamaUp: await ollamaClient().isUp() });
    } catch { res.status(500).json({ ok: false, error: 'hardware detection failed' }); }
  });

  // GET /hardware/recommend — ranked models for this box, flagged if installed.
  router.get('/hardware/recommend', async (_req, res) => {
    try {
      const hardware = await detect();
      const rec = recommendModels(hardware);
      let installed = [];
      let ollamaUp = false;
      try { installed = await ollamaClient().listInstalled(); ollamaUp = true; }
      catch { ollamaUp = await ollamaClient().isUp(); }
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

  // ── GET /hardware/ollama — the TRUE daemon health, as a pure read ────────────
  // The honest-state read behind every Ollama surface. Never starts anything (see
  // ollama-daemon.js health()), so it is safe to poll and cannot become a hidden
  // spawn path. `state`/`retryable` come from the ONE shared taxonomy
  // (src/system/service-state.js) so the panel never re-derives its own line
  // between "loading" and "broken" — the conflation that painted a red indicator
  // over a runtime that was merely starting.
  router.get('/hardware/ollama', async (_req, res) => {
    try {
      const h = await ollamaDaemon.health?.();
      if (!h) return res.status(503).json({ ok: false, error: 'daemon health unavailable' });
      res.json({ ok: true, ollama: { ...normalizeHealth(h), installed: !!h.installed, running: !!h.running, baseUrl: h.baseUrl ?? null } });
    } catch { res.status(500).json({ ok: false, error: 'health read failed' }); }
  });

  // ── POST /hardware/retry — the owner's escape hatch for a dead Ollama ─────────
  // THE §1 un-strand. On first open the categorize model showed unavailable, the
  // details said the runtime could not be detected, and there was NOTHING to press;
  // it silently self-healed later. Mirrors POST /portal/embed/retry (#318) exactly:
  //
  //   1. re-attempt bring-up through the ONE path — ollamaDaemon.ensureUp(). Every
  //      guarantee that path carries is untouched and deliberately NOT bypassed here:
  //      the single-flight, the >= OLLAMA_MIN_VERSION adopt gate, the alt-port
  //      self-heal for a too-old squatter, and the OLLAMA_SPAWN_CAPS RAM caps (#312).
  //      This route only presses the button the boot path already presses.
  //   2. RE-READ the world and answer with THAT — never with the attempt's own claim.
  //      `ensureUp()` returning ok:false while the daemon in fact came up (or the
  //      reverse, after a self-heal moved the port) must resolve in favour of the
  //      probe. So a retry that did not help stays honestly failed, and one that did
  //      shows ready — we never say "retried ✓" on the strength of having tried.
  //
  // Fail-SAFE: ensureUp() may reject (spawn/install throw); we swallow it and still
  // report the re-read health, because a thrown bring-up is not evidence the daemon
  // is down — the probe is.
  router.post('/hardware/retry', async (req, res) => {
    if (!gate(req, res)) return;
    // BOUND THE BRING-UP (LOW-6). ensureUp() DOWNLOADS the pinned Ollama runtime (hundreds of MB)
    // when the binary is absent — and this JSON route has no progress channel, so a naive `await`
    // held the request open with the button frozen on "Checking…" for the whole silent fetch. We
    // still PRESS the one bring-up path (its single-flight, version-gate, adopt/self-heal and spawn
    // caps all intact and NOT bypassed), but we do not block the response on a long download: once a
    // bring-up is inflight, health() reports 'starting' ⇒ 'loading', so we answer with that honest
    // in-progress state and the client's GET /portal/hardware/ollama poll renders "Downloading
    // runtime…" instead of a hung button. A fast bring-up (already installed) still resolves within
    // the budget and is reflected exactly as before.
    try {
      await Promise.race([
        Promise.resolve().then(() => ollamaDaemon.ensureUp?.()).catch(() => {}),
        new Promise((r) => setTimeout(r, retryBringupBudgetMs())),
      ]);
    } catch { /* best-effort — the RE-READ below is what we answer with, not this */ }
    try {
      const h = await ollamaDaemon.health?.();
      if (!h) return res.status(503).json({ ok: false, error: 'daemon health unavailable' });
      const norm = normalizeHealth(h);
      // `ok` describes the WORLD (is it running now), never "the request was accepted".
      res.json({ ok: norm.state === 'ready', ollama: { ...norm, installed: !!h.installed, running: !!h.running, baseUrl: h.baseUrl ?? null } });
    } catch { res.status(500).json({ ok: false, error: 'retry failed' }); }
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
        // The daemon refused to come up. Surface WHY. `incompatible_runtime` (N1: a listening host
        // Ollama too OLD for the catalog — we can't rebind :11434 nor kill a daemon we didn't start)
        // carries an actionable message + the host-version `detail`, NOT the generic failure — the
        // fix is a runtime upgrade, not a network check.
        const msg = up.reason === 'incompatible_runtime' ? INCOMPATIBLE_RUNTIME_MSG : undefined;
        send({ done: true, ok: false, error: up.reason || 'ollama_unavailable', ...(msg ? { message: msg } : {}), ...(up.detail ? { detail: up.detail } : {}) });
      } else {
        await ollamaClient().pullModel(name, (ev) => send({ status: ev.status, completed: ev.completed, total: ev.total }));
        send({ done: true, ok: true });
      }
    } catch (err) {
      // Surface the CLASSIFIED reason, not the constant 'pull failed' (R2-QWENPULL diagnosability
      // defect). The three kinds — runtime-unreachable / download-failed / out-of-space — each map
      // to a different, actionable owner message on the frontend, so the button can finally say
      // WHY. And log it: this interactive route swallowed the error silently, so a failed pull left
      // no trace anywhere. The models-dir username in an ollama disk error is scrubbed first (§1/§8;
      // same regex as drainer.js scrubFaultDetail); registry HOSTS are kept — they're useful, not PII.
      const fault = classifyOllamaFault(err, 'pull');
      const detail = String(err?.message || err)
        .replace(/(\/(?:Users|home)\/)[^/\s]+/gi, '$1<user>')
        .replace(/([A-Za-z]:\\Users\\)[^\\\s]+/gi, '$1<user>')
        .slice(0, 160);
      console.error(`[portal-hardware] pull failed model=${name} fault=${fault} detail=${detail}`);
      // For `incompatible-runtime` (a 412 — the host Ollama is too old for this model) send the
      // actionable upgrade copy, NOT the generic download-failed "check your network" the fault code
      // alone would render (R2 N2). The other three kinds keep code-only mapping on the frontend.
      const message = fault === 'incompatible-runtime' ? INCOMPATIBLE_RUNTIME_MSG : undefined;
      send({ done: true, ok: false, error: fault, ...(message ? { message } : {}) });
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
      const ollama = ollamaClient();   // one client for this delete (list + delete must hit the same base)
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
