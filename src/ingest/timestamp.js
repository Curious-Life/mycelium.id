// src/ingest/timestamp.js — the SINGLE timestamp authority for all imports
// (messages AND documents). Lifted from capture.js's normalizeCreatedAt so both
// the message choke-point and the document path share one correct implementation.
//
// Design: docs/DESIGN-import-system-robustness-2026-06-19.md
//   - UTC-normalized output (ISO-8601 Z), format-tolerant input.
//   - Naive datetime strings (no offset) are interpreted under `assumeTZ`
//     (default UTC) — NEVER the server's local zone, which would silently shift
//     the calendar day (the JS `new Date('2026-02-04 00:00:00')` foot-gun).
//   - deriveCreatedAt() returns BOTH the iso AND its provenance, so a
//     fallback-to-now is a recorded, countable fact — never a silent date cliff.

// Closed provenance enum. Unknown values are a bug (tests assert membership).
export const TS_PROVENANCE = Object.freeze({
  SOURCE_FIELD: 'source-field', // the source record carried an explicit time
  FILE_MTIME: 'file-mtime',     // filesystem / zip-entry modification time
  FRONTMATTER: 'frontmatter',   // YAML `created:`/`date:` in a markdown note
  FILENAME: 'filename',         // an ISO/date embedded in the path or name
  INFERRED_NOW: 'inferred-now', // nothing usable → stamped at import time (FLAGGED)
});

const TZ_MARKER = /(?:Z|[+-]\d{2}:?\d{2})$/; // ISO already carries a zone
// bare `YYYY-MM-DD` or `YYYY-MM-DD[ T]HH:MM[:SS[.fff]]` with NO zone marker
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalise a heterogeneous timestamp to an ISO-8601 UTC string, or null.
 * Accepts Date | epoch-seconds | epoch-ms | numeric-string | ISO-8601 | naive datetime.
 * @param {string|number|Date|null|undefined} v
 * @param {{ assumeTZ?: 'UTC' }} [opts]  how to read a naive (zone-less) string. Default UTC.
 * @returns {string|null} e.g. '2025-08-29T07:24:00.000Z', or null for absent/invalid.
 */
export function normalizeTimestamp(v, { assumeTZ = 'UTC' } = {}) {
  if (v == null) return null;
  let d;
  if (v instanceof Date) {
    d = v;
  } else if (typeof v === 'number') {
    d = new Date(v < 1e12 ? v * 1000 : v); // epoch seconds vs ms (magnitude split)
  } else if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      d = new Date(n < 1e12 ? n * 1000 : n); // numeric epoch string
    } else if (NAIVE_DATETIME.test(s) && !TZ_MARKER.test(s)) {
      // Zone-less string. Interpret under assumeTZ instead of letting `new Date`
      // silently use the host's local zone (which shifts the calendar day).
      if (assumeTZ === 'UTC') {
        const iso = DATE_ONLY.test(s) ? `${s}T00:00:00Z` : `${s.replace(' ', 'T')}Z`;
        d = new Date(iso);
      } else {
        d = new Date(s);
      }
    } else {
      d = new Date(s); // ISO-8601 with zone (Claude `created_at`, LinkedIn "… UTC")
    }
  } else {
    return null;
  }
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Resolve an imported record's created_at AND record where it came from.
 * Tries candidate sources in priority order; falls back to import-time (now),
 * which is returned with provenance INFERRED_NOW so callers can COUNT and REPORT
 * the fallback rather than blending it silently into real dates.
 *
 * @param {Array<{ value: any, provenance: string }>} candidates  in priority order
 * @param {{ now?: () => string, futureSkewMs?: number, assumeTZ?: 'UTC' }} [opts]
 * @returns {{ iso: string, provenance: string }}
 */
export function deriveCreatedAt(candidates, opts = {}) {
  const { now = () => new Date().toISOString(), futureSkewMs = 48 * 3600 * 1000, assumeTZ = 'UTC' } = opts;
  const nowMs = Date.parse(now());
  for (const c of candidates || []) {
    if (!c) continue;
    const iso = normalizeTimestamp(c.value, { assumeTZ });
    if (!iso) continue;
    // Reject clearly-bogus future timestamps (clock skew / mis-parse) so they
    // don't poison ordering — treat as no-signal and keep trying / fall back.
    if (Date.parse(iso) > nowMs + futureSkewMs) continue;
    return { iso, provenance: c.provenance };
  }
  return { iso: now(), provenance: TS_PROVENANCE.INFERRED_NOW };
}
