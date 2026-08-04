// src/account/zip-stream.js — a STORE-only, streaming zip writer (D-122).
//
// WHY THIS EXISTS. The `.myvault` backup was built with JSZip's
// `generateAsync({type:'nodebuffer'})`, which materialises the ENTIRE archive in memory —
// plus a readFileSync of every member before that. On the operator's ~3 GB vault the
// backup endpoint simply failed (observed HTTP 000 after ~3.7 min), and the working
// backup had to be hand-built with `zip -0`. This writer streams: peak memory is one
// 64 KiB read chunk regardless of vault size.
//
// FORMAT CHOICES, all in service of restore compatibility:
//   • STORE only (no deflate) — matches the app's own format (backup.js used
//     compression:'STORE'; the members are ciphertext and don't compress) and what the
//     operator's hand-built `zip -0` produced.
//   • TWO PASSES per file instead of data descriptors: pass 1 streams the file through
//     crc32, pass 2 streams the bytes into the archive. Sizes and CRC are then known at
//     local-header time, so no bit-3 data descriptors — the most compatible shape for
//     every reader (JSZip's restore validator, `unzip -t`, Finder). Two sequential disk
//     reads of a multi-GB file beat one buffered copy of it in RAM.
//   • zip64 where needed (file ≥ 4 GiB, offset ≥ 4 GiB, > 65535 entries) via the
//     standard extra field + zip64 EOCD. `zip64Threshold` is injectable so the gate can
//     force the zip64 encoding on kilobyte fixtures and prove it against a real reader.
//
// Filenames are ASCII/UTF-8 as given (flag bit 11 set for UTF-8). Timestamps: one DOS
// stamp for the whole archive (member mtimes are not load-bearing for restore).

import fs from 'node:fs';
import { crc32 } from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const CHUNK = 64 * 1024;
const U32MAX = 0xFFFFFFFF;

function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

// Backpressure via the write CALLBACK, never hand-rolled 'drain' waiting: the HTTP
// response is often wrapped (compression middleware) and those wrappers do not emit
// 'drain' with plain-socket semantics — the first cut of this file hung exactly there.
async function writeAll(out, buf) {
  await new Promise((res, rej) => out.write(buf, (e) => (e ? rej(e) : res())));
}

async function streamFileCrc(path) {
  let crc = 0, size = 0;
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(path, { highWaterMark: CHUNK });
    s.on('data', (c) => { crc = crc32(c, crc); size += c.length; });
    s.on('end', resolve);
    s.on('error', reject);
  });
  return { crc: crc >>> 0, size };
}

async function streamFileOut(path, out, expectSize) {
  let size = 0;
  const counter = new Transform({ transform(c, _enc, cb) { size += c.length; cb(null, c); } });
  // pipeline handles backpressure correctly across wrapped writables; end:false keeps
  // the archive stream open for the next member + the central directory.
  await pipeline(fs.createReadStream(path, { highWaterMark: CHUNK }), counter, out, { end: false });
  // D-076's lesson applied here: a file that changed size mid-backup must RAISE, never
  // ship a whole-looking archive whose member silently disagrees with its header.
  if (size !== expectSize) throw new Error(`zip-stream: ${path} changed size during backup (${expectSize} → ${size})`);
  return size;
}

function zip64Extra(fields) {
  // fields: array of 8-byte values in the mandated order (size, csize, offset — only the ones needed)
  const b = Buffer.alloc(4 + fields.length * 8);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(fields.length * 8, 2);
  fields.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 4 + i * 8));
  return b;
}

/**
 * Create a streaming STORE zip over `out` (any Writable — an HTTP response, a file).
 * @param {import('node:stream').Writable} out
 * @param {{ zip64Threshold?: number }} [opts] zip64Threshold is TEST-ONLY: force the
 *   zip64 encoding at a small size so a gate can prove it without a 4 GiB fixture.
 */
export function createZipStream(out, { zip64Threshold = U32MAX } = {}) {
  const entries = [];
  let offset = 0;
  const { time, date } = dosDateTime();

  async function writeLocal(name, crc, size) {
    const nameBuf = Buffer.from(name, 'utf8');
    const big = size >= zip64Threshold || offset >= zip64Threshold;
    const extra = big ? zip64Extra([size, size]) : Buffer.alloc(0);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(big ? 45 : 20, 4);        // version needed
    h.writeUInt16LE(0x0800, 6);               // flags: UTF-8 names
    h.writeUInt16LE(0, 8);                    // STORE
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(big ? U32MAX : size, 18); // csize
    h.writeUInt32LE(big ? U32MAX : size, 22); // usize
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(extra.length, 28);
    const localOffset = offset;
    await writeAll(out, h); await writeAll(out, nameBuf); if (extra.length) await writeAll(out, extra);
    offset += h.length + nameBuf.length + extra.length;
    entries.push({ nameBuf, crc, size, localOffset, big });
    return localOffset;
  }

  return {
    /** Stream a file from disk into the archive (two passes: crc, then bytes). */
    async addFile(name, path) {
      const { crc, size } = await streamFileCrc(path);
      await writeLocal(name, crc, size);
      await streamFileOut(path, out, size);
      offset += size;
    },
    /** Add an in-memory member (manifest.json and other small metadata only). */
    async addBuffer(name, buf) {
      const crc = crc32(buf) >>> 0;
      await writeLocal(name, crc, buf.length);
      await writeAll(out, buf);
      offset += buf.length;
    },
    /** Write the central directory (+ zip64 records when needed) and end the stream. */
    async finalize({ end = true } = {}) {
      const cdStart = offset;
      for (const e of entries) {
        const needZip64 = e.big || e.localOffset >= zip64Threshold;
        const fields = [];
        if (needZip64) { fields.push(e.size, e.size, e.localOffset); }
        const extra = needZip64 ? zip64Extra(fields) : Buffer.alloc(0);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0);
        c.writeUInt16LE(45, 4);                                   // made by
        c.writeUInt16LE(needZip64 ? 45 : 20, 6);                  // needed
        c.writeUInt16LE(0x0800, 8);
        c.writeUInt16LE(0, 10);                                   // STORE
        c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14);
        c.writeUInt32LE(e.crc, 16);
        c.writeUInt32LE(needZip64 ? U32MAX : e.size, 20);
        c.writeUInt32LE(needZip64 ? U32MAX : e.size, 24);
        c.writeUInt16LE(e.nameBuf.length, 28);
        c.writeUInt16LE(extra.length, 30);
        c.writeUInt16LE(0, 32); c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36); // comment/disk/int attrs
        c.writeUInt32LE(0, 38);                                   // ext attrs
        c.writeUInt32LE(needZip64 ? U32MAX : e.localOffset, 42);
        await writeAll(out, c); await writeAll(out, e.nameBuf); if (extra.length) await writeAll(out, extra);
        offset += c.length + e.nameBuf.length + extra.length;
      }
      const cdSize = offset - cdStart;
      const needZip64End = entries.length > 0xFFFF || cdStart >= zip64Threshold || cdSize >= zip64Threshold
        || entries.some((e) => e.big || e.localOffset >= zip64Threshold);
      if (needZip64End) {
        const z = Buffer.alloc(56);
        z.writeUInt32LE(0x06064b50, 0);
        z.writeBigUInt64LE(44n, 4);                    // size of remainder
        z.writeUInt16LE(45, 12); z.writeUInt16LE(45, 14);
        z.writeUInt32LE(0, 16); z.writeUInt32LE(0, 20);
        z.writeBigUInt64LE(BigInt(entries.length), 24);
        z.writeBigUInt64LE(BigInt(entries.length), 32);
        z.writeBigUInt64LE(BigInt(cdSize), 40);
        z.writeBigUInt64LE(BigInt(cdStart), 48);
        const loc = Buffer.alloc(20);
        loc.writeUInt32LE(0x07064b50, 0);
        loc.writeUInt32LE(0, 4);
        loc.writeBigUInt64LE(BigInt(offset), 8);       // offset of the zip64 EOCD
        loc.writeUInt32LE(1, 16);
        await writeAll(out, z); await writeAll(out, loc);
        offset += z.length + loc.length;
      }
      const e = Buffer.alloc(22);
      e.writeUInt32LE(0x06054b50, 0);
      e.writeUInt16LE(0, 4); e.writeUInt16LE(0, 6);
      e.writeUInt16LE(Math.min(entries.length, 0xFFFF), 8);
      e.writeUInt16LE(Math.min(entries.length, 0xFFFF), 10);
      e.writeUInt32LE(needZip64End ? U32MAX : cdSize, 12);
      e.writeUInt32LE(needZip64End ? U32MAX : cdStart, 16);
      e.writeUInt16LE(0, 20);
      await writeAll(out, e);
      offset += e.length;
      if (end) await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));
      return { bytes: offset, entries: entries.length };
    },
  };
}

export default { createZipStream };
