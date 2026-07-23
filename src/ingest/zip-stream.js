// Streaming zip reader (yauzl) — read ONE known entry out of a multi-GB archive
// as a Readable, without loading the whole zip into memory.
//
// Why: AI-export / vault-export .zips are routinely multi-GB (mostly media we
// don't import). JSZip.loadAsync(buffer) holds the entire archive in memory; for
// gig-scale that OOMs. yauzl opens from a file descriptor and decompresses one
// entry on demand, so peak memory is bounded by the single entry we stream
// (conversations.json / manifest.json) — never the whole archive.
//
// Security (import runs on attacker-influenceable files — CLAUDE.md §1):
//   • entry-count cap BEFORE opening any entry (zip-with-millions-of-entries bomb);
//   • two-layer decompression-bomb guard: fast-reject on the declared uncompressed
//     size, then a streaming byte counter that destroys the stream past maxBytes;
//   • entry names are only ever used to LOOK UP an entry in this archive's own
//     central directory — never joined to a filesystem path, never written to
//     disk → no zip-slip / path traversal. (readEntriesSequential enumerates
//     entries; the bytes stay in memory and the caller may only take
//     archive-entries.js `safeEntryBasename()` from the name.)
import yauzl from 'yauzl';
import { Transform } from 'node:stream';
import { isRatioBomb } from './archive-entries.js';

// -- DECLARED LIBRARY DEPENDENCIES on yauzl's defaults (verify:run-import R15) --
// Two behaviors we RELY ON come from yauzl options we do not pass, i.e. from its
// defaults. They are defense-in-depth, not our only line -- but they are silent if
// a bump or an added option removes them, so they are pinned by a gate:
//   - `decodeStrings` (default TRUE) enables yauzl's `validateFileName`
//     (node_modules/yauzl/index.js:871-883): an entry name containing a `..`
//     path segment (or an absolute/backslash name) makes the WHOLE archive fail
//     with an error -- no traversal byte is ever read. Our own defense is
//     archive-entries.js `safeEntryBasename()` (names never become paths); this
//     is the outer layer. Passing `decodeStrings:false` would remove it silently.
//   - `validateEntrySizes` (default TRUE) makes yauzl error the read stream when
//     the inflated byte count doesn't match the central-directory size -- which is
//     why a header lying LOW truncates here instead of inflating a bomb. That
//     makes yauzl's own check indistinguishable from ours by ERROR CODE, so the
//     layer-2 gates observe BYTES READ instead (repo lesson:
//     "bomb guard: declared-size is masked").
//
/** Open a zip (Buffer or file path), enumerate entries (capped), resolve {zipfile, entries}. */
function openZip(src, maxEntries) {
  return new Promise((resolve, reject) => {
    const onOpen = (err, zipfile) => {
      if (err || !zipfile) return reject(err || new Error('zip: open failed'));
      const entries = new Map();
      let n = 0;
      zipfile.on('entry', (entry) => {
        if (++n > maxEntries) {
          zipfile.close();
          return reject(Object.assign(new Error(`archive entry count exceeds cap (${maxEntries})`), { code: 'TOO_MANY_ENTRIES' }));
        }
        entries.set(entry.fileName, entry);
        zipfile.readEntry();
      });
      zipfile.on('end', () => resolve({ zipfile, entries }));
      zipfile.on('error', reject);
      zipfile.readEntry();
    };
    if (Buffer.isBuffer(src)) yauzl.fromBuffer(src, { lazyEntries: true }, onOpen);
    else yauzl.open(src, { lazyEntries: true, autoClose: false }, onOpen);
  });
}

/** List entry names without reading content (for export-type detection). */
export async function listEntries(src, { maxEntries = 500_000 } = {}) {
  const { zipfile, entries } = await openZip(src, maxEntries);
  try { return [...entries.keys()]; } finally { zipfile.close(); }
}

/**
 * Open ONE known entry as a Readable of decompressed bytes, byte-capped.
 * @param {Buffer|string} src    archive buffer or file path
 * @param {string} name          EXACT entry name (e.g. 'conversations.json')
 * @param {{ maxEntries?: number, maxBytes?: number }} [opts]
 * @returns {Promise<import('node:stream').Readable|null>}  null if the entry is absent
 */
export async function openEntryStream(src, name, { maxEntries = 500_000, maxBytes = Infinity } = {}) {
  const { zipfile, entries } = await openZip(src, maxEntries);
  const entry = entries.get(name);
  if (!entry) { zipfile.close(); return null; }
  // layer 0 — decompression-RATIO guard: the absolute byte cap must stay generous
  // to allow gig-scale exports, so a ratio check is what actually stops a bomb. A
  // real text export (conversations.json) compresses ~5-20:1; a zip bomb is
  // 1000:1+. Refuse a high-ratio LARGE entry regardless of the absolute cap.
  if (ratioBomb(entry)) {
    zipfile.close();
    throw Object.assign(new Error('entry decompression ratio exceeds the bomb threshold'), { code: 'ENTRY_TOO_LARGE' });
  }
  // layer 1 — fast reject on declared uncompressed size (the absolute backstop)
  if (Number.isFinite(maxBytes) && typeof entry.uncompressedSize === 'number' && entry.uncompressedSize > maxBytes) {
    zipfile.close();
    throw Object.assign(new Error('entry exceeds byte cap'), { code: 'ENTRY_TOO_LARGE' });
  }
  const raw = await new Promise((resolve, reject) =>
    zipfile.openReadStream(entry, (err, s) => (err ? reject(err) : resolve(s))));
  // layer 2 — streaming byte counter; aborts inflation the instant output passes maxBytes
  let total = 0;
  const guard = new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      if (total > maxBytes) return cb(Object.assign(new Error('entry exceeds byte cap'), { code: 'ENTRY_TOO_LARGE' }));
      cb(null, chunk);
    },
  });
  raw.on('error', (e) => guard.destroy(e));
  const closeZip = () => { try { zipfile.close(); } catch { /* noop */ } };
  guard.on('end', closeZip);
  guard.on('close', closeZip);
  return raw.pipe(guard);
}

/** Ratio guard as a predicate (shared by the single-entry and sequential readers). */
function ratioBomb(entry) {
  return isRatioBomb(entry?.uncompressedSize, entry?.compressedSize);
}

/**
 * LAYER 2 — read a stream into a Buffer, aborting the instant OBSERVED bytes pass
 * maxBytes. Reports `read` = the bytes we actually pulled, whether or not the
 * entry was accepted, because:
 *   • a caller must CHARGE attempted inflation against its total budget (an
 *     entry that trips the per-entry cap is still CPU we spent — leaving it
 *     uncharged is a free-inflation DoS: QA6 P7 review FIX 2, measured at
 *     1.39MB of upload ⇒ 1,389ms of inflation charged as 0 bytes); and
 *   • a gate can only prove this layer holds by OBSERVING bytes read — the error
 *     path is shared with yauzl's own size-mismatch abort, so an error code
 *     cannot distinguish "bounded" from "inflated then rejected".
 *
 * `openStream(cb)` is the injectable seam: production passes yauzl's
 * `openReadStream`; a gate passes a synthetic Readable that records the bytes it
 * was asked for, and can therefore mutate/observe THIS layer alone.
 *
 * @param {(cb:(err:any, stream?:import('node:stream').Readable)=>void)=>void} openStream
 * @param {number} maxBytes
 * @returns {Promise<{ bytes: Buffer|null, read: number }>}  bytes === null ⇒ refused
 */
export function readStreamCapped(openStream, maxBytes) {
  return new Promise((resolve) => {
    let total = 0;
    let done = false;
    const finish = (bytes) => { if (!done) { done = true; resolve({ bytes, read: total }); } };
    let raw;
    try {
      openStream((err, s) => {
        if (err || !s) return finish(null);
        raw = s;
        const chunks = [];
        raw.on('data', (chunk) => {
          // LAYER 2 — the guard that actually holds: it counts the bytes we READ,
          // so a lying (low) declared size in the header buys nothing.
          total += chunk.length;
          if (total > maxBytes) { try { raw.destroy(); } catch { /* noop */ } return finish(null); }
          chunks.push(chunk);
        });
        raw.on('end', () => finish(chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0)));
        raw.on('error', () => finish(null));
        raw.on('close', () => finish(null)); // destroyed without 'end'
      });
    } catch { finish(null); }
  });
}

/** Inflate ONE entry to a Buffer, aborting the instant OBSERVED bytes pass maxBytes. */
function inflateEntry(zipfile, entry, maxBytes) {
  return readStreamCapped((cb) => zipfile.openReadStream(entry, cb), maxBytes);
}

/**
 * Read SEVERAL entries out of one archive, sequentially, opening the archive
 * ONCE. Yields `{ name, bytes }` for each entry that passed the guards and
 * `{ name, skipped }` for one that did not — the caller counts skips (fail-loud)
 * instead of silently losing files.
 *
 * Bomb guards, in order (all three matter — see the repo lesson "declared-size
 * is masked": a lying header defeats layer 1 alone):
 *   layer 0  decompression-RATIO reject on the declared sizes
 *   layer 1  fast reject on the declared uncompressed size
 *   layer 2  OBSERVED-byte counter per entry (aborts inflation mid-stream)
 *   layer 3  OBSERVED-byte counter across the whole run (stops the walk) — it
 *            charges ATTEMPTED inflation, so a refused entry is not free CPU
 *
 * Bytes are held in memory for exactly one entry at a time and NEVER written to
 * disk; `name` is a lookup key only (see the header).
 *
 * @param {Buffer|string} src
 * @param {string[]} names            entry names, from this archive's own listing
 * @param {{maxEntries?:number, maxEntryBytes?:number, maxTotalBytes?:number}} [opts]
 */
export async function* readEntriesSequential(src, names, {
  maxEntries = 500_000, maxEntryBytes = Infinity, maxTotalBytes = Infinity,
} = {}) {
  const { zipfile, entries } = await openZip(src, maxEntries);
  try {
    let total = 0;
    for (const name of names) {
      const entry = entries.get(name);
      if (!entry) continue;
      // Layers 0/1 refuse BEFORE any inflation -> nothing to charge (read: 0).
      if (ratioBomb(entry)) { yield { name, skipped: 'bomb', read: 0 }; continue; }
      if (Number.isFinite(maxEntryBytes) && typeof entry.uncompressedSize === 'number'
          && entry.uncompressedSize > maxEntryBytes) { yield { name, skipped: 'oversize', read: 0 }; continue; }
      const { bytes, read } = await inflateEntry(zipfile, entry, maxEntryBytes);
      // LAYER 3 -- charge ATTEMPTED bytes, not just yielded ones. An entry that
      // trips the per-entry cap is inflation we already paid for; charging only
      // accepted bytes let an attacker buy unbounded CPU for free (FIX 2).
      total += read;
      const halted = total > maxTotalBytes;
      if (bytes === null) { yield { name, skipped: 'oversize', read, ...(halted ? { halted: true } : {}) }; if (halted) return; continue; }
      if (halted) { yield { name, skipped: 'total-cap', halted: true, read }; return; }
      if (bytes.length === 0) { yield { name, skipped: 'empty', read }; continue; }
      yield { name, bytes, read };
    }
  } finally { try { zipfile.close(); } catch { /* noop */ } }
}

export default { listEntries, openEntryStream, readEntriesSequential, readStreamCapped };
