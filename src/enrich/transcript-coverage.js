// src/enrich/transcript-coverage.js — THE HONESTY LAYER for long-audio transcription (D-076).
//
// ════════════════════════════════════════════════════════════════════════════════════════════
//  WHY THIS MODULE EXISTS: a partial transcript had NO representation, so it read as complete
// ════════════════════════════════════════════════════════════════════════════════════════════
// The operator sent a 30-minute recording and "only a part of it finished". Every mechanism
// behind that was SILENT BY CONSTRUCTION, and they were all silent for the same structural
// reason: `attachments` has exactly ONE `transcript TEXT` column and NOTHING that says how much
// of the audio that text actually covers. With no coverage state:
//
//   • transcribe-long.js consumed the NDJSON stream to EOF and never looked for the service's
//     `{"type":"done"}` sentinel. The service answers HTTP/1.0 `Connection: close` with NO
//     Content-Length and NO chunked framing (pipeline/transcribe-service.py), so at the WIRE
//     level a truncated body is byte-for-byte indistinguishable from a complete one — undici
//     cannot raise. A python OOM-kill, a supervisor restart, a broken pipe: EOF, "success".
//   • transcribe-attachment.js's `if (full)` branch wrote that partial, marked the activity feed
//     `done`, and returned `{ok:true}` — even when `onFault` had ALREADY fired 'engine-error'.
//   • db/attachments.js's drain predicate was `transcript IS NULL OR transcript = ''`, so the
//     progressive save (every ~10 segments) made the row PERMANENTLY ineligible for the
//     background drain the moment the first partial landed. Not "capped after 3 attempts" —
//     excluded immediately and forever.
//
// So the fix is not a bigger timeout. It is a REPRESENTATION: every transcript now carries the
// coverage it was produced from, `complete` is an assertion that must be EARNED, and a row that
// did not earn it stays eligible for resume. `attachments.metadata` is a plaintext JSON TEXT
// column (ENCRYPTED_FIELDS.attachments === [] — verified at runtime, crypto/crypto-local.js:313;
// at-rest protection is whole-file SQLCipher), so this needs NO migration.
//
// SECURITY (§1 zero plaintext leakage): coverage carries NUMBERS and BOOLEANS only — seconds,
// counts, ranges. Never a transcript excerpt, never a filename, never a service error string.
// The fault DETAIL stays on the transcribe-long.js out-channel, which is already redacted there.

/** The single key under `attachments.metadata` that transcription owns. */
export const COVERAGE_KEY = 'transcription';

/**
 * How far BEFORE the last covered second a resume restarts. A resume that begins exactly at
 * `coveredSec` can clip the first word of the tail (the previous segment's end timestamp is the
 * end of *decoded speech*, not a guaranteed word boundary once the stream was cut mid-flight).
 * The lookback deliberately RE-TRANSCRIBES a little audio and lets `stitchTranscript` remove the
 * duplicate — duplicated input is recoverable, a clipped word is not.
 */
export const RESUME_LOOKBACK_SEC = 1.5;

/**
 * Seam de-dup ceiling. A resume lookback of 1.5 s or an audio window overlap of a few seconds is
 * at most ~15 spoken words; 40 gives generous headroom without letting a coincidental match
 * swallow real speech.
 */
export const MAX_SEAM_WORDS = 40;

/**
 * A seam match must be at least this many words to be believed. ONE shared word ("the", "and")
 * across a boundary is a coincidence, not an overlap, and acting on it DELETES a real word.
 */
const MIN_SEAM_WORDS = 2;

/** Scripts written without spaces between words — see the CJK branch in stitchTranscript. */
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
/** Minimum CHARACTER overlap believed in an unspaced script (≈ 4 morphemes). */
const MIN_SEAM_CHARS = 4;
/** How much of each side counts as "the seam" when deciding if the join is in an unspaced script. */
const SEAM_WINDOW_CHARS = 120;

/** Normalize a word for seam comparison: case- and punctuation-insensitive. */
const norm = (w) => String(w).toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);

/**
 * Join two transcript fragments that were produced from OVERLAPPING audio, removing the
 * duplicated words at the seam.
 *
 * WHY OVERLAP AT ALL (the alternative is worse): a hard split of the audio at an arbitrary byte
 * offset cuts mid-word, and BOTH sides lose the word — the left side hears a truncated sound the
 * model drops, the right side hears the tail and renders garbage. Overlapping the audio means the
 * word is transcribed WHOLE by at least one side; the only remaining problem is that it is
 * transcribed TWICE, which is a text problem and therefore fixable here.
 *
 * The algorithm takes the LONGEST suffix-of-a / prefix-of-b word match (≥ MIN_SEAM_WORDS,
 * ≤ maxSeamWords) — longest, because a genuine 8-word overlap must win over a coincidental
 * 2-word one. When no word-level match exists it falls back to ONE narrow rule: a truncated
 * final word on the left that is a strict prefix of the first word on the right (>= 3 chars) is
 * the mid-word clip case, and the left's fragment is dropped in favour of the right's whole word.
 *
 * @param {string} a  text so far (may be empty)
 * @param {string} b  the next fragment
 * @param {{maxSeamWords?: number}} [o]
 * @returns {string}
 */
export function stitchTranscript(a, b, { maxSeamWords = MAX_SEAM_WORDS } = {}) {
  const A = words(a);
  const B = words(b);
  if (!A.length) return B.join(' ');
  if (!B.length) return A.join(' ');

  const limit = Math.min(maxSeamWords, A.length, B.length);
  let best = 0;
  for (let k = limit; k >= MIN_SEAM_WORDS; k--) {
    let match = true;
    for (let i = 0; i < k; i++) {
      if (norm(A[A.length - k + i]) !== norm(B[i])) { match = false; break; }
    }
    if (match) { best = k; break; }   // scanning DOWN from the limit ⇒ the first hit is the longest
  }
  if (best) return [...A, ...B.slice(best)].join(' ');

  // ── SCRIPTS WITHOUT WORD SPACING (Han/Kana/Thai/Lao/Khmer/Myanmar) ─────────────────────────
  // `words()` splits on whitespace, so a whole Japanese or Chinese Whisper segment is ONE token and
  // the word-level scan above can never reach MIN_SEAM_WORDS. Every resume lookback and every
  // window seam in such audio would therefore duplicate the entire overlap region (adversarial
  // review, MEDIUM-12). Fall back to a CHARACTER-level longest suffix/prefix match, but only for
  // this class of text — running it on spaced scripts would resurrect the sub-word deletion hazard
  // documented below. 4 characters is a substantial overlap in a logographic script, where one
  // character is roughly a morpheme.
  // ⚠️ THE TEST IS ON THE SEAM REGION AND ON BOTH SIDES — not on the whole fragments, and not on
  // either side alone. A draft tested `UNSPACED_SCRIPT.test(a) || …test(b)` where `a` is the ENTIRE
  // accumulated transcript, so ONE Han/Kana/Thai character anywhere in a long English transcript —
  // a name, a quoted phrase — switched every seam to character matching and joined without a space.
  // It then deleted genuinely repeated words ("…I like to code" + "code review is due" loses the
  // second "code"), reintroducing exactly the deletion hazard the sub-word heuristic was removed
  // for (adversarial review round 2, MEDIUM-5). Scoped this way the branch can only fire where the
  // text really is unspaced on both sides of the join.
  const sa = String(a).trim(), sb = String(b).trim();
  const seamA = sa.slice(-SEAM_WINDOW_CHARS), seamB = sb.slice(0, SEAM_WINDOW_CHARS);
  if (UNSPACED_SCRIPT.test(seamA) && UNSPACED_SCRIPT.test(seamB)) {
    const lim = Math.min(sa.length, sb.length, maxSeamWords * 4);
    for (let k = lim; k >= MIN_SEAM_CHARS; k--) {
      const cand = sb.slice(0, k);
      // A match spanning whitespace is a WORD-level overlap wearing a character-level disguise —
      // leave those to the scan above, which requires two whole words of evidence.
      if (/\s/.test(cand)) continue;
      if (sa.slice(sa.length - k) === cand) return sa + sb.slice(k);
    }
  }

  // ⚠️ NO SUB-WORD "MID-WORD CLIP" HEURISTIC — IT DELETED REAL SPEECH.
  // A draft dropped A's last word when it was a strict prefix of B's first word, meaning to repair
  // "…the transcrip" + "transcription is…". But nothing distinguishes a CLIPPED fragment from a
  // COMPLETE short word that happens to prefix the next one, and the failure mode is deletion —
  // the one direction this module documents as unrecoverable. Real losses it caused
  // (adversarial review, MEDIUM-6):
  //     "and the"       + "there was silence…"   → "and there was silence…"   ("the" deleted)
  //     "I saw the cat" + "catastrophe struck…"  → "…the catastrophe struck…" ("cat" deleted)
  //     "we can"        + "cancel the meeting"   → "we cancel the meeting"    ("can" deleted)
  // It was also inconsistent with MIN_SEAM_WORDS, which already refuses a ONE-WORD match as
  // coincidence: a sub-word match is weaker evidence still. The overlap the chunker actually emits
  // (3 s of audio, a 1.5 s resume lookback) gives the word-level scan above real multi-word
  // evidence to work with, so the clipped-word case it targeted barely arises — and when it does,
  // a duplicated fragment is visible and recoverable where a deleted word is neither.
  return [...A, ...B].join(' ');
}

/** Stitch an ordered list of overlapping fragments into one transcript. */
export function stitchAll(parts, opts) {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    out = out ? stitchTranscript(out, p, opts) : String(p).trim();
  }
  return out;
}

/**
 * Parse `attachments.metadata` and return the transcription coverage record, or null.
 * NEVER throws: malformed metadata is treated as "no coverage recorded".
 * @param {string|object|null} metadata
 */
export function readCoverage(metadata) {
  const obj = parseMetadata(metadata).obj;
  const c = obj?.[COVERAGE_KEY];
  if (!c || typeof c !== 'object') return null;
  return {
    complete: c.complete === true,
    incomplete: c.incomplete === 1 || c.incomplete === true,
    coveredSec: Number(c.coveredSec) || 0,
    durationSec: Number(c.durationSec) || 0,
    segments: Number(c.segments) || 0,
    // Ranges of audio that were attempted and produced NOTHING usable (a failed window). Kept so a
    // resume knows a hole exists in the MIDDLE, not only at the tail.
    gaps: Array.isArray(c.gaps) ? c.gaps.filter((g) => Array.isArray(g) && g.length === 2).map((g) => [Number(g[0]) || 0, Number(g[1]) || 0]) : [],
    engine: typeof c.engine === 'string' ? c.engine : null,
    fault: typeof c.fault === 'string' ? c.fault : null,
    updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : null,
  };
}

/**
 * Serialize a coverage patch into `attachments.metadata`, PRESERVING every other key.
 *
 * ⚠️ `incomplete` is written as the integer 1 / absent, never as `false`. The drain predicate
 * (db/attachments.js listPendingTranscription) matches `json_extract(...) = 1`, and an EXPLICIT
 * marker is what keeps the predicate backward-compatible: a legacy row that already holds a good
 * transcript and has no marker is NOT selected, so this change can never make the drain
 * re-transcribe the whole existing library.
 *
 * @param {string|object|null} metadata  the row's current metadata
 * @param {{complete: boolean, coveredSec?: number, durationSec?: number, segments?: number,
 *          gaps?: Array<[number,number]>, engine?: string|null, fault?: string|null}} patch
 * @returns {string} JSON to store in `metadata`
 */
export function writeCoverage(metadata, patch) {
  const { obj, unparsed } = parseMetadata(metadata);
  const base = obj && typeof obj === 'object' && !Array.isArray(obj) ? { ...obj } : {};
  // Lossless: malformed prior metadata is PRESERVED verbatim rather than destroyed. Coverage must
  // be writable on every row (otherwise a row could never be marked complete and would drain
  // forever), and silently dropping an unknown column value is data loss.
  if (unparsed != null) base._unparsed_metadata = unparsed;

  const complete = patch?.complete === true;
  const rec = {
    complete,
    coveredSec: round2(patch?.coveredSec),
    durationSec: round2(patch?.durationSec),
    segments: Math.max(0, Math.trunc(Number(patch?.segments) || 0)),
    updatedAt: new Date().toISOString(),
  };
  // The drain marker exists ONLY while work remains. Setting it to 0/false instead of removing it
  // would still satisfy `= 1` false, but an absent key is the state a legacy row is in — keeping
  // the two representations identical means there is exactly ONE "not pending" shape to reason about.
  if (!complete) rec.incomplete = 1;
  const gaps = Array.isArray(patch?.gaps) ? patch.gaps.filter((g) => Array.isArray(g) && g.length === 2) : [];
  if (gaps.length) rec.gaps = gaps.map((g) => [round2(g[0]), round2(g[1])]);
  if (patch?.engine) rec.engine = String(patch.engine).slice(0, 32);
  // §1: a fault REASON is a fixed enum token (see transcribe-long.js), never the service detail
  // string — a detail can embed a temp path (…/myc-tx-XXXX/audio.m4a) or a credential-shaped token
  // and is deliberately NOT persisted here. Take the FIRST whitespace-delimited token only:
  // stripping the offending characters in place would CONCATENATE a leaked path into the token
  // rather than remove it ("engine-error /tmp/myc-tx-abc/audio.m4a" → "engine-errortmpmyc-tx-abc…"),
  // which is still a leak. Caught by the D-076 gate's §1 assertion.
  // ⚠️ ALLOW-LIST, NOT DENY-LIST. A draft took the first whitespace token and stripped disallowed
  // characters — which only helps when a leak is preceded by a space. A bare path collapsed into
  // the token instead of being removed ("/tmp/myc-tx-9/audio.ogg" → "tmpmyc-tx-9audioogg") and a
  // credential-shaped value kept its first word (adversarial review, LOW-10). On a §1 boundary the
  // only safe shape is "match the expected form or discard": a fault is a fixed enum token, so
  // anything that is not enum-shaped becomes 'unknown' rather than being scrubbed toward safety.
  if (patch?.fault) {
    const token = String(patch.fault).trim();
    rec.fault = /^[a-z][a-z0-9-]{0,47}$/.test(token) ? token : 'unknown';
  }

  base[COVERAGE_KEY] = rec;
  return JSON.stringify(base);
}

/**
 * Is this row's transcript known-incomplete? Mirrors the SQL predicate in
 * db/attachments.js listPendingTranscription — kept as a JS twin so the gate can assert both
 * agree (two copies of a rule this load-bearing is how one of them drifts).
 */
export function isCoverageIncomplete(metadata) {
  const c = readCoverage(metadata);
  return Boolean(c && c.incomplete && !c.complete);
}

/**
 * Where a resume should start decoding, given prior coverage. 0 means "from the beginning".
 * A gap in the MIDDLE forces a full re-decode (0) — resuming at the tail would leave the hole
 * forever, and a hole is exactly what must never be silently accepted.
 */
export function resumeStartSec(coverage) {
  if (!coverage || coverage.complete) return 0;
  if (coverage.gaps?.length) return 0;
  const covered = Number(coverage.coveredSec) || 0;
  if (!(covered > RESUME_LOOKBACK_SEC)) return 0;
  return round2(covered - RESUME_LOOKBACK_SEC);
}

/**
 * Would writing `next` over `stored` LOSE work? The single rule every transcript writer consults.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  WHY THIS EXISTS: FOUR UNSERIALIZED WRITERS, AND NOTHING KEYED THE SAME ATTACHMENT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `attachments.transcript` is written by the import path (ingest/run-import.js, fire-and-forget),
 * the background drain (enrich/transcribe-retry.js), the portal Transcribe button
 * (portal-attachments.js), and the live channel turn (internal-router.js). Nothing serializes them,
 * and the governor CANNOT: the live turn takes an INTERACTIVE ticket on the model slot while the
 * drain takes a BULK ticket on the sum gate, so both run at once by design. During an audio import
 * run-import fires immediately and the drain selects the same row on its next 20 s cycle — a
 * guaranteed double decode (both adversarial reviews, independently).
 *
 * Each writer merges coverage into a row snapshot taken BEFORE a decode lasting minutes. So the
 * loser of the race writes last and wins: a complete 30-minute transcript gets replaced by a
 * 4-minute partial, `complete:true` reverts to `incomplete:1`, and the file is re-queued for
 * another full decode. Per-writer monotonicity does not help — it is monotonic only against that
 * writer's own stale snapshot.
 *
 * The guard is a LAST-MOMENT re-read plus this comparison: work already recorded is never
 * downgraded. Completeness beats incompleteness; more coverage beats less. It is deliberately
 * conservative — when in doubt it declines to write, because the stored transcript is real work
 * and a redundant decode is merely wasted time.
 *
 * @param {object|null} stored  coverage currently on the row (readCoverage output)
 * @param {{complete: boolean, coveredSec?: number}} next  what a writer is about to store
 * @returns {boolean} true when `stored` already represents at least as much work
 */
export function coverageDominates(stored, next) {
  if (!stored) return false;
  const nextComplete = next?.complete === true;
  // A finished transcript is never replaced by an unfinished one.
  if (stored.complete && !nextComplete) return true;
  // Neither is finished (or both are): more covered audio wins. The 0.5 s slack keeps float noise
  // and re-transcribed lookback from counting as regression.
  if (!nextComplete && (Number(stored.coveredSec) || 0) > (Number(next?.coveredSec) || 0) + 0.5) return true;
  return false;
}

function parseMetadata(metadata) {
  if (metadata == null) return { obj: null, unparsed: null };
  // An ARRAY is not a metadata object, and treating it as one loses it: writeCoverage's `!isArray`
  // guard would reject it while `unparsed` had nothing to preserve. Serialize it into the same
  // lossless escape hatch the malformed-string branch uses (adversarial review, LOW-11).
  if (typeof metadata === 'object') {
    if (Array.isArray(metadata)) { try { return { obj: null, unparsed: JSON.stringify(metadata).slice(0, 4000) }; } catch { return { obj: null, unparsed: null }; } }
    return { obj: metadata, unparsed: null };
  }
  const s = String(metadata);
  if (!s.trim()) return { obj: null, unparsed: null };
  try {
    const o = JSON.parse(s);
    if (o && typeof o === 'object' && !Array.isArray(o)) return { obj: o, unparsed: null };
    return { obj: null, unparsed: s.slice(0, 4000) };
  } catch {
    return { obj: null, unparsed: s.slice(0, 4000) };
  }
}

const round2 = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 0;
};

export default { stitchTranscript, stitchAll, readCoverage, writeCoverage, isCoverageIncomplete, resumeStartSec };
