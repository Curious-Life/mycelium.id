// pipeline/lib/stage-result.js — failure accounting for a measurement stage.
//
// THE PROBLEM (Gap #3): every compute-* stage wraps its per-row write in a
// try/catch that logs and continues, then run() resolves and the process exits 0.
// A SYSTEMATIC failure (schema/key regression, constraint) fails every row
// identically → the metric table is silently empty → exit 0 → jobs.js reports
// "Complete" → the user sees stale/empty metrics with no signal.
//
// THE POLICY (CLAUDE.md §10 "validate every operation, never warn-and-continue",
// tempered for a 16-stage pipeline): a stage FAILS LOUD when its output is
// MATERIALLY incomplete — zero writes on non-empty input, OR failure ratio above
// `failRatio` (default 10 %). Below that it tolerates sparse per-row failures
// (one bad row must not abort the whole run) but still prints the count. The
// throw becomes a non-zero exit (the stage's existing `.catch(process.exit(1))`),
// which `set -e` in run-clustering.sh propagates and jobs.js names the stage.
//
// TRACKABILITY (§4.4): finalize() ALSO records the outcome to the per-stage
// health ledger (pipeline_state) via the injected `record` callbacks, so failures
// stay visible across runs (last_failure_at / consecutive_failures / quarantined)
// and metric staleness becomes diagnosable, not just detectable.
//
// CONTENT-FREE (§1): only counts, ids, and DB error *classes* ever reach this —
// never a realm/territory name, message, or model output. Error samples are
// sanitized to a single bounded line.

export class StageIncompleteError extends Error {
  constructor(message) { super(message); this.name = 'StageIncompleteError'; }
}

/** First line of an error message, bounded — never content, just the DB/exception class. */
function sanitize(err) {
  const msg = (err && err.message) ? err.message : String(err ?? 'unknown');
  return msg.split('\n')[0].slice(0, 200);
}

/**
 * @param {string} stage  — canonical stage name (also the pipeline_state.stage_name key)
 * @param {object} [opts]
 * @param {number} [opts.failRatio=0.1]  — abort when failed/attempted exceeds this
 * @param {{ success?: (o:{durationMs:number,details:object})=>any,
 *           failure?: (o:{reason:string,durationMs:number})=>any }} [opts.record]
 *           — optional pipeline_state recorder (step 2 wires the real one; tests inject spies)
 * @param {() => number} [opts.now]  — clock seam (tests)
 */
export function createStageResult(stage, { failRatio = 0.1, record = null, now = Date.now } = {}) {
  const startedAt = now();
  let attempted = 0, written = 0, failed = 0;
  const samples = [];

  const safe = async (fn) => { if (typeof fn === 'function') { try { await fn(); } catch { /* health recording is best-effort */ } } };

  return {
    /** A row/entity was written successfully. */
    ok() { attempted++; written++; },
    /** A row/entity write failed (logged, not fatal-per-row). */
    fail(err) { attempted++; failed++; if (samples.length < 3) samples.push(sanitize(err)); },
    /** Content absent (legitimately nothing to write) — NOT counted as attempted. */
    skip() {},
    counts() { return { stage, attempted, written, failed }; },

    /**
     * Decide the stage's fate. Throws StageIncompleteError (→ non-zero exit) when
     * output is materially incomplete; otherwise logs a one-line summary. Records
     * the outcome to pipeline_state either way. Call once, at the end of the stage,
     * with the db still open (before close()).
     */
    async finalize() {
      const durationMs = now() - startedAt;
      const incomplete = attempted > 0 && (written === 0 || failed / attempted > failRatio);
      const tail = samples.length ? ` (e.g. ${samples[0]})` : '';

      if (incomplete) {
        const reason = `${stage}: incomplete — ${written}/${attempted} written, ${failed} failed${tail}`;
        await safe(() => record?.failure?.({ reason, durationMs }));
        throw new StageIncompleteError(reason);
      }

      await safe(() => record?.success?.({ durationMs, details: { attempted, written, failed } }));
      // Surfaced on stderr so a sparse-but-nonzero failure count is visible even on success.
      console.error(failed ? `[${stage}] ${written}/${attempted} written, ${failed} failed${tail}`
                           : `[${stage}] ${written}/${attempted} written`);
      return { stage, attempted, written, failed, durationMs };
    },
  };
}
