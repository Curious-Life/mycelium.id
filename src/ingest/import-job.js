// Shared async-import job runner — the ONE background-job envelope every import
// uses (generalizes the local-files `sweepJob`, portal-import.js). Design:
// the unified-import architecture.
//
// SINGLE-FLIGHT PER RUNNER INSTANCE — and that is the whole guarantee. A second start()
// on THIS runner while its job runs returns the running job's progress instead of spawning
// a second importer. What that buys is IDEMPOTENCE: a re-click, or a tab reconnecting after
// it lost the response, re-attaches to the running import instead of double-scanning the
// same source. It is NOT a global "one import at a time", and it is NOT a corruption guard.
//
// The line this header used to carry — "one import at a time. Two concurrent vault writers
// corrupted the live vault once (2026-06-30)" — was wrong twice over (corrected 2026-07-16,
// the ninth false comment found this session):
//   1. IT OVERSTATED THE SCOPE. portal-import.js constructs TWO runners (/import/run and the
//      local-files sweep); each is single-flight only on itself, so a sweep and an export CAN
//      run at once. "One import at a time" was never true of the process. (Can — not "does":
//      no such run is claimed to have been observed. The same distinction the feedId comment
//      below keeps.)
//   2. ITS JUSTIFICATION WAS ABOUT A DIFFERENT THING, and is refuted besides.
//      • The 2026-06-30 incident was CROSS-PROCESS — the app and a separately-launched MCP
//        both opening the vault. Nothing single-flight does could have touched it; that risk
//        is owned by db/writer-lock.js. This runner was never the guard.
//      • And the mechanism was refuted anyway: scripts/vault-repair/repro-corruption.mjs
//        spawns real child writers and shows concurrent WAL writers are CLEAN (6/6); the only
//        reproduced cause was a torn copyFileSync of a live vault, fixed separately
//        (safeVaultCopy). The b-tree mechanism remains UNPROVEN — do not invent one here.
//      • In-process, the question does not even arise: Node is single-threaded and
//        better-sqlite3 is synchronous, so no two imports can be writing at once whatever
//        this file does. query()'s awaits are the CRYPTO — autoEncryptParams (adapter/d1.js:85)
//        and autoDecryptResults (:93) — never the SQLite call itself. Both of those calls are
//        synchronous: stmt.run() (:89) for a plain write, stmt.all() (:92) for SELECTs *and* for
//        INSERT/UPDATE … RETURNING (the path db/attachments.js:57 takes). Neither can interleave
//        with another. Imports interleave at the crypto awaits, which SQLite serializes.
//
// So cross-surface concurrency is DELIBERATE, not an oversight (reviewed and kept
// 2026-07-16 — see portal-import.js for what it does and does not cost).
//
// PINNED BY verify:import-activity A7b/A7b2 (what single-flight actually guarantees, and
// that it does NOT extend across instances) and A7c (the feed-id collision it costs).
// NOT pinned by any "concurrency is safe" runtime check, and deliberately so: the last
// bullet above is a property of the RUNTIME, not of this repo's code. A check cannot
// falsify it — a draft one passed with the concurrency removed. See the note where A7a
// used to live.
//
// The runner owns the { status, key, total, processed, imported, deduped,
// skipped, failed, cancel } envelope; the import fn just reports progress via
// onProgress and honors shouldCancel. POST starts + returns immediately; GET
// polls progress; POST cancel flips a cooperative flag.

const publicJob = (j) => (j ? {
  status: j.status, key: j.key, startedAt: j.startedAt, finishedAt: j.finishedAt,
  total: j.total, processed: j.processed, imported: j.imported, deduped: j.deduped,
  skipped: j.skipped, failed: j.failed, cancelled: j.status === 'cancelled',
  ...(j.result ? { result: j.result } : {}), ...(j.error ? { error: j.error } : {}),
} : { status: 'idle' });

// How often the in-flight import refreshes its activity-feed row.
//
// ⚠️ THE BEAT IS ON A TIMER, NOT ON onProgress — and that is load-bearing, not a style
// choice. activity-feed.js reaps any 'running' row whose heartbeat is older than STALE_MS
// (45s) to 'abandoned', and its heartbeat() is `WHERE status='running'` — so a reaped row
// can NEVER be revived, while finish() has no such guard and would resurrect it at the end.
// An onProgress-driven beat therefore kills any importer that goes quiet for 45s — and both
// paths production actually takes have such a gap BEFORE their first emit:
//   • recent-export: two readJsonArray passes plus a per-attachment readdir+readFile loop all
//     run before the first emit() (recent-export-import.js → restore-core.js), and the
//     attachment putBlob loop emits nothing while it runs. A media-heavy bundle sits there.
//   • the local-files sweep: walkFiles + the full attachments preload both precede the
//     initial emit (local-files-import.js) — on the 10k-file sweep this file's own comment
//     calls "minutes of work".
// (An earlier draft led with full-export — registry.js really does omit onProgress, so it
// would get ZERO beats — but nothing ROUTES full-export through this runner, so that was a
// hand-built-API scenario, not a user-reachable one. Corrected on re-review, 2026-07-16;
// the two above are user-reachable and were verified independently.)
// A timer beats the CURRENT counters regardless of what the importer emits. It cannot lie
// about liveness either: if the event loop were blocked long enough to miss a beat, the
// reaper — which runs in this same process, off an HTTP poll — could not run either.
// (Found by independent review, 2026-07-16. jobs.js already had this keep-alive tick; the
// first draft of this file claimed to mirror jobs.js and omitted the one part that mattered.)
const HEARTBEAT_MS = 1000;

// Monotonic across every runner sharing this MODULE INSTANCE — deliberately module-level, not
// per-runner. See the feedId comment in start(): per-runner it would not disambiguate the two
// runners portal-import.js builds, which is the exact case that collides. (Module instance, not
// "process": two copies of this module — a duplicated ESM resolution — would each get their own
// counter. Not a real configuration today; stated exactly rather than rounded up.)
let runSeq = 0;

/**
 * @param {object}   [deps]
 * @param {() => number} [deps.now]
 * @param {object}   [deps.activityFeed]  db.activityFeed — OPTIONAL. Absent ⇒ no publishing,
 *                                        and the import behaves exactly as before.
 * @param {string}   [deps.userId]
 * @param {(fn:()=>void, ms:number) => (() => void)} [deps.schedule]
 *        Starts the keep-alive tick; returns its canceller. Injectable so the gate can drive
 *        beats deterministically instead of sleeping.
 */
export function createImportJobRunner({
  now = () => Date.now(),
  activityFeed = null,
  userId = null,
  schedule = (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return () => clearInterval(t); },
} = {}) {
  let job = null;

  // The feed is the ONE progress surface (design §3.4). Imports were the gap: jobs.js has
  // published clustering/measure/narration since it was written, but an import — the single
  // longest thing a new user waits on — was invisible outside the component that started it,
  // so navigating away lost all sight of it (QA item 3).
  //
  // Publishing NEVER affects the import: every call is fire-and-forget and swallowed. The
  // feed is a mirror; a broken mirror must not stop the work.
  // Each returns its promise so a caller MAY await it (the final beat does — see below).
  // Awaited or not, every one is swallowed twice: a sync try/catch around the call and a
  // .catch() on the promise.
  const feed = {
    begin: (id, stageLabel) => { try { return activityFeed?.begin({ userId, kind: 'import', id, totalSteps: 0, stageLabel }).catch(() => {}); } catch { /* never */ } },
    beat: (id, step, totalSteps, stageLabel) => { try { return activityFeed?.heartbeat(id, { step, totalSteps, stageLabel, stalled: false }).catch(() => {}); } catch { /* never */ } },
    end: (id, status, error) => { try { return activityFeed?.finish(id, { status, error }).catch(() => {}); } catch { /* never */ } },
  };

  /**
   * Start an import as a detached background job (single-flight).
   * @param {object} spec
   * @param {string} spec.key   registry key (for progress display)
   * @param {(ctx:{onProgress:(p:object)=>void, shouldCancel:()=>boolean}) => Promise<object>} spec.run
   *        the import — returns its summary; may throw.
   * @returns the initial public job snapshot.
   */
  function start({ key, run, label = null }) {
    if (job?.status === 'running') return publicJob(job); // idempotent re-click / reconnect
    const j = job = {
      status: 'running', key, startedAt: now(), finishedAt: null,
      total: 0, processed: 0, imported: 0, deduped: 0, skipped: 0, failed: 0,
      cancel: false, result: null, error: null,
    };

    // Unique per run: two sequential imports must be two rows, not one reopened (begin()
    // upserts ON CONFLICT(id), which would erase the first run's history).
    //
    // ⚠️ THE SEQ IS LOAD-BEARING — `import-${startedAt}` alone opened a collision window the
    // moment the sweep moved onto this runner (2026-07-16). It needs two starts inside one
    // millisecond, so it is reachable rather than observed — no incident is claimed here; the
    // window is simply free to close, and the failure it produces is silent. The two
    // runners portal-import.js builds are independent single-flights, so a user CAN start a
    // sweep and an /import/run in the same millisecond (one click each, or one UI action doing
    // both) → identical ids → begin()'s ON CONFLICT(id) DO UPDATE folds them into ONE row:
    // the second begin() resets the first's counters and steals its stage_label, then whichever
    // finishes first flips status='done' and the survivor's beats are silently dropped
    // (heartbeat() is `WHERE status='running'`). One import vanishes from the feed and the other
    // reads as the wrong import — the exact §3.4 invisibility this runner exists to kill.
    // A counter costs nothing and closes the window for every runner sharing this module
    // instance — i.e. all of them, in any configuration that exists (see runSeq above, which
    // states the one caveat exactly). Pinned by A7c.
    const feedId = `import-${j.startedAt}-${++runSeq}`;
    // ⚠️ `label` is published into a stage_label, and background_jobs is content-free BY
    // CONTRACT (activity-feed.js §SECURITY) — a stage_label is a CONSTANT or it breaks that
    // contract. Unlike `error`, a stage_label is ALSO emitted live to the UI
    // (portal-activity.js shape() maps it to `stage`), so a non-constant here is a real leak,
    // not a defense-in-depth lapse. The runner does NOT validate it; safety comes from the CALLER
    // passing a constant (portal-import.js reads the registry's hardcoded per-source label,
    // after 400ing an unknown key). Callers: keep it a constant. Never interpolate a path,
    // a filename, or anything a user typed.
    const stageLabel = label || 'Importing your data';
    feed.begin(feedId, stageLabel);
    // The keep-alive: publish the CURRENT counters every tick, whatever the importer emits.
    const beat = () => feed.beat(feedId, j.processed, j.total, stageLabel);
    // A throwing injected `schedule` must never wedge the job: `job` is already
    // set to this run, so a throw here would leave status='running' with no IIFE to clear it
    // — isRunning() true forever, and every later import silently swallowed by single-flight.
    const stopBeating = (() => { try { return schedule(beat, HEARTBEAT_MS) || (() => {}); } catch { return () => {}; } })();

    (async () => {
      try {
        const result = await run({
          onProgress: (p) => {
            // Counters only — the timer above owns publishing, so an importer stays alive in
            // the feed through any stretch where it reports nothing.
            if (typeof p?.total === 'number') j.total = p.total;
            if (typeof p?.processed === 'number') j.processed = p.processed;
            if (typeof p?.imported === 'number') j.imported = p.imported;
            if (typeof p?.deduped === 'number') j.deduped = p.deduped;
            if (typeof p?.skipped === 'number') j.skipped = p.skipped;
            if (typeof p?.failed === 'number') j.failed = p.failed;
          },
          shouldCancel: () => j.cancel,
        });
        j.result = result ?? null;
        // Prefer the importer's own final tallies when present (they are authoritative).
        if (result && typeof result === 'object') {
          if (typeof result.imported === 'number') j.imported = result.imported;
          if (typeof result.deduped === 'number') j.deduped = result.deduped;
          if (typeof result.skipped === 'number') j.skipped = result.skipped;
          if (typeof result.failed === 'number') j.failed = result.failed;
        }
        j.status = (j.cancel || result?.cancelled) ? 'cancelled' : 'done';
      } catch (e) {
        j.status = 'error'; j.error = String(e?.message || e).slice(0, 200);
      } finally {
        j.finishedAt = now();
        stopBeating();
        // The FINAL counters, published unthrottled before the terminal transition. finish()
        // carries only {status, error} — no step — so the row keeps whatever the last beat
        // wrote. Without this, an import whose last rows land inside a tick ends its history
        // row reading "9,800/10,000 · Done", permanently (independent review, 2026-07-16).
        //
        // ⚠️ AWAITED ON PURPOSE — this ordering is a REQUIREMENT, not a nicety. heartbeat() is
        // `WHERE status='running'`, so if finish() lands first the final counters are silently
        // DROPPED and the bug returns with the gate still green. Today the two happen to be
        // microtask-symmetric (background_jobs is absent from ENCRYPTED_FIELDS, so
        // autoEncryptParams returns without awaiting) — i.e. correctness rests on a property
        // of a DIFFERENT module that nothing pins. Adding one encrypted column there would
        // make finish() shallower than heartbeat() and flip the order. Awaiting removes the
        // dependency entirely; it costs one already-swallowed promise (re-review, 2026-07-16).
        await beat();
        // Final state, mapped to the feed's vocabulary ('abandoned' is how a cancelled job
        // reads there — same as jobs.js).
        //
        // ⚠️ The error is a CONSTANT, never `j.error` (verify:import-activity A2 pins it).
        // An import failure routinely names a FILE PATH or quotes the row it choked on, and
        // `background_jobs` is content-free BY CONTRACT (see the db/activity-feed.js header).
        // The contract is load-bearing: activityFeed.recent() already SELECTs the `error`
        // column, and only portal-activity.js's shape() — which drops it today — stands
        // between that column and the feed UI. Publishing content-free is what lets that
        // projection widen without re-auditing every publisher. Defense in depth (§2), NOT a
        // live exfiltration path. The real reason stays in the job envelope, which is
        // in-memory and only reachable through the authed /import/run/progress route.
        //
        // NOT the reason: that d1QueryAdmin is a "non-encrypting path". ENCRYPTED_FIELDS
        // (crypto/crypto-local.js) field-encrypts exactly ONE table — `secrets` — so admin
        // vs. user helper confers ZERO at-rest difference for background_jobs; and post
        // SQLCipher-collapse (2026-06-19) at-rest protection is whole-file regardless of the
        // writer. That premise was verified false on 2026-07-16 — don't reintroduce it.
        feed.end(
          feedId,
          j.status === 'done' ? 'done' : j.status === 'cancelled' ? 'abandoned' : 'error',
          j.status === 'error' ? 'import failed' : null,
        );
      }
    })();
    return publicJob(j);
  }

  return {
    start,
    progress: () => publicJob(job),
    cancel: () => { if (job?.status === 'running') job.cancel = true; return publicJob(job); },
    isRunning: () => job?.status === 'running',
  };
}
