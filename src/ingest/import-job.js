// Shared async-import job runner — the ONE background-job envelope every import
// uses (generalizes the local-files `sweepJob`, portal-import.js). Design:
// docs/UNIFIED-IMPORT-ARCHITECTURE-2026-07-03.md.
//
// SINGLE-FLIGHT by design: one import at a time. Two concurrent vault writers
// corrupted the live vault once (2026-06-30) — so a second start while one runs
// returns the running job's progress instead of spawning a second writer.
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

export function createImportJobRunner({ now = () => Date.now() } = {}) {
  let job = null;

  /**
   * Start an import as a detached background job (single-flight).
   * @param {object} spec
   * @param {string} spec.key   registry key (for progress display)
   * @param {(ctx:{onProgress:(p:object)=>void, shouldCancel:()=>boolean}) => Promise<object>} spec.run
   *        the import — returns its summary; may throw.
   * @returns the initial public job snapshot.
   */
  function start({ key, run }) {
    if (job?.status === 'running') return publicJob(job); // idempotent re-click / reconnect
    const j = job = {
      status: 'running', key, startedAt: now(), finishedAt: null,
      total: 0, processed: 0, imported: 0, deduped: 0, skipped: 0, failed: 0,
      cancel: false, result: null, error: null,
    };
    (async () => {
      try {
        const result = await run({
          onProgress: (p) => {
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
      } finally { j.finishedAt = now(); }
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
