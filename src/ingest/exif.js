// src/ingest/exif.js — dependency-free EXIF "original capture time" reader.
//
// Images uploaded to the vault used to be stamped with the UPLOAD time (file
// mtime = the copy moment, or import-now), which poisons the mindscape's
// temporal axis (R4-TIMESTAMPS). This module extracts EXIF `DateTimeOriginal`
// — when the photo was actually TAKEN — so the import can prefer it over mtime.
//
// Scope: JPEG (APP1/Exif segment) and raw TIFF are parsed structurally. For
// other containers (HEIC/HEIF and friends) we make a BOUNDED best-effort by
// locating the "Exif\0\0" signature and parsing the TIFF block that follows.
// A missing/invalid/placeholder date returns null — this never throws, so a
// malformed image can never break an upload.
//
// EXIF time semantics: `DateTimeOriginal` is a naive "YYYY:MM:DD HH:MM:SS" in
// the camera's local zone. When `OffsetTimeOriginal` (0x9011) is present we
// keep the exact instant; otherwise we return the naive form and let
// normalizeTimestamp interpret it under its default zone (UTC) — the same
// deterministic choice the timestamp authority already makes for zone-less
// strings (no silent host-local calendar-day shift).

const TAG_DATETIME = 0x0132;             // DateTime (file change) — last resort
const TAG_EXIF_IFD = 0x8769;             // pointer to the Exif sub-IFD
const TAG_DATETIME_ORIGINAL = 0x9003;    // when the photo was TAKEN (preferred)
const TAG_DATETIME_DIGITIZED = 0x9004;   // when it was digitized (fallback)
const TAG_OFFSET_TIME = 0x9010;          // zone for DateTime
const TAG_OFFSET_TIME_ORIGINAL = 0x9011; // zone for DateTimeOriginal

const EXIF_SIG = Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // "Exif\0\0"
const MAX_SCAN = 512 * 1024; // bound the HEIC/other-container signature scan
// Hard cap on TOTAL IFD entries walked across the whole image. A malicious TIFF
// can declare up to 65535 entries per IFD and point every Exif-IFD-pointer entry
// (tag 0x8769) back at the same offset — without a breadth+cycle bound that fans
// out to ~count^depth and pins the event loop at 100% CPU (a spin, not a throw,
// so try/catch can't save it). The visited-offset guard blocks the self/cross
// reference; this budget bounds the walk even across distinct offsets.
const MAX_IFD_ENTRIES = 4096;

const u16 = (buf, off, le) => (le ? buf.readUInt16LE(off) : buf.readUInt16BE(off));
const u32 = (buf, off, le) => (le ? buf.readUInt32LE(off) : buf.readUInt32BE(off));

/**
 * Locate the start of the TIFF block that carries the EXIF IFDs.
 * @returns {number} byte offset, or -1 if none found.
 */
function findTiffStart(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return -1;
  // JPEG: SOI (FFD8) then a chain of marker segments; the Exif block is in APP1.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 4 <= buf.length) {
      if (buf[off] !== 0xff) break;
      const marker = buf[off + 1];
      // Standalone markers (no length) / start-of-scan / end — stop the walk.
      if (marker === 0xd8 || marker === 0xd9 || marker === 0xda) break;
      const segLen = buf.readUInt16BE(off + 2);
      if (segLen < 2) break;
      if (marker === 0xe1) { // APP1
        const p = off + 4;
        if (p + EXIF_SIG.length <= buf.length && buf.subarray(p, p + EXIF_SIG.length).equals(EXIF_SIG)) {
          return p + EXIF_SIG.length;
        }
      }
      off += 2 + segLen;
    }
    return -1;
  }
  // Raw TIFF: "II\x2A\x00" (little-endian) or "MM\x00\x2A" (big-endian).
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00)
    || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)) {
    return 0;
  }
  // Other containers (HEIC/HEIF, etc.) — bounded scan for the Exif signature.
  const idx = buf.indexOf(EXIF_SIG, 0);
  if (idx >= 0 && idx <= MAX_SCAN) return idx + EXIF_SIG.length;
  return -1;
}

/**
 * Parse the TIFF IFDs rooted at `tiff`, collecting the date/zone ASCII tags.
 * @returns {object|null} { dateTimeOriginal?, dateTimeDigitized?, dateTime?, offsetOriginal?, offset? }
 */
function parseTiff(buf, tiff) {
  if (tiff < 0 || tiff + 8 > buf.length) return null;
  let le;
  if (buf[tiff] === 0x49 && buf[tiff + 1] === 0x49) le = true;
  else if (buf[tiff] === 0x4d && buf[tiff + 1] === 0x4d) le = false;
  else return null;
  if (u16(buf, tiff + 2, le) !== 0x2a) return null;

  const result = {};
  const readAscii = (valOff, count) => {
    // ASCII value is inline when it fits in the 4-byte value cell, else at offset.
    const at = count <= 4 ? valOff : tiff + u32(buf, valOff, le);
    if (at < 0 || at + count > buf.length) return null;
    return buf.toString('latin1', at, at + count).replace(/\0.*$/, '').trim();
  };
  const visited = new Set(); // IFD offsets already walked — blocks self/cross cycles
  let budget = MAX_IFD_ENTRIES; // total entries across the whole walk (fanout cap)
  const readIfd = (ifdRel, depth) => {
    if (depth > 4 || budget <= 0) return;
    if (visited.has(ifdRel)) return; // never re-walk an offset (cycle guard)
    visited.add(ifdRel);
    const base = tiff + ifdRel;
    if (base < 0 || base + 2 > buf.length) return;
    const count = u16(buf, base, le);
    let p = base + 2;
    for (let i = 0; i < count; i++) {
      if (budget-- <= 0) return; // hard breadth cap — bounds work even w/ distinct offsets
      if (p + 12 > buf.length) return;
      const tag = u16(buf, p, le);
      const type = u16(buf, p + 2, le);
      const cnt = u32(buf, p + 4, le);
      const valOff = p + 8;
      if (tag === TAG_EXIF_IFD && type === 4) {
        readIfd(u32(buf, valOff, le), depth + 1);
      } else if (type === 2) { // ASCII
        const s = readAscii(valOff, cnt);
        if (s) {
          if (tag === TAG_DATETIME_ORIGINAL) result.dateTimeOriginal = s;
          else if (tag === TAG_DATETIME_DIGITIZED) result.dateTimeDigitized = s;
          else if (tag === TAG_DATETIME) result.dateTime = s;
          else if (tag === TAG_OFFSET_TIME_ORIGINAL) result.offsetOriginal = s;
          else if (tag === TAG_OFFSET_TIME) result.offset = s;
        }
      }
      p += 12;
    }
  };
  readIfd(u32(buf, tiff + 4, le), 0);
  return result;
}

/** "YYYY:MM:DD HH:MM:SS" (+ optional "+HH:MM") → an ISO-ish string, or null. */
function toIso(dt, offset) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(dt));
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m;
  // Cameras write an all-zero placeholder when the clock is unset — reject it.
  if (Y === '0000' || Mo === '00' || D === '00') return null;
  const base = `${Y}-${Mo}-${D} ${H}:${Mi}:${S}`;
  if (offset && /^[+-]\d{2}:\d{2}$/.test(offset)) return `${base.replace(' ', 'T')}${offset}`;
  return base; // naive → normalizeTimestamp reads it under assumeTZ (UTC)
}

/**
 * Extract an image's ORIGINAL capture time from its bytes.
 * @param {Buffer} bytes  raw image bytes
 * @returns {string|null} an ISO-8601-ish timestamp (naive or zoned), or null.
 */
export function extractExifDate(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
    const tiff = findTiffStart(bytes);
    if (tiff < 0) return null;
    const tags = parseTiff(bytes, tiff);
    if (!tags) return null;
    const dt = tags.dateTimeOriginal || tags.dateTimeDigitized || tags.dateTime;
    if (!dt) return null;
    const off = tags.offsetOriginal || tags.offset || null;
    return toIso(dt, off);
  } catch { return null; }
}

export default extractExifDate;
