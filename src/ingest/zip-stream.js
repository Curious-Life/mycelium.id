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
//   • we only ever openReadStream for an EXACT known entry name — we never
//     enumerate-and-write archive paths to disk → no zip-slip / path traversal.
import yauzl from 'yauzl';
import { Transform } from 'node:stream';

// Decompression-bomb ratio guard (env-tunable). A real text export compresses
// ~5-20:1; a zip bomb is 1000:1+. Only applied above a floor so a tiny but
// highly-compressible legit entry isn't flagged.
const MAX_DECOMPRESSION_RATIO = Number(process.env.MYCELIUM_IMPORT_MAX_DECOMPRESSION_RATIO) || 200;
const RATIO_FLOOR_BYTES = Number(process.env.MYCELIUM_IMPORT_RATIO_FLOOR_BYTES) || 10 * 1024 * 1024;

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
  if (typeof entry.uncompressedSize === 'number' && typeof entry.compressedSize === 'number' &&
      entry.compressedSize > 0 && entry.uncompressedSize > RATIO_FLOOR_BYTES &&
      entry.uncompressedSize / entry.compressedSize > MAX_DECOMPRESSION_RATIO) {
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

export default { listEntries, openEntryStream };
