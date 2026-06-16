// Adversarial security test for the import surface — actively attacks
// src/portal-uploads.js + src/ingest/import-parsers.js the way a hostile export
// file or local caller would. Caps are forced LOW via env (then a dynamic
// import so import-parsers reads them at module-eval) so bombs are cheap to run.
//
//   S1 decompression bomb   DEFLATE zip whose conversations.json declares >cap → refused (400), not inflated
//   S2 concurrent-upload cap  flood of unique uploadIds → 429 before OOM
//   S3 implied chunk-count cap  declared fileSize/chunkSize implying >cap chunks → 413 (no alloc)
//   S4 chunk retry            re-sending an index overwrites (no double-count) → finalize still parses
//   S5 uploadId injection     path-ish / oversized uploadId → 400 (regex fail-closed)
//   S6 prototype pollution    ChatGPT mapping with __proto__/constructor keys → no Object.prototype pollution
//   S7 error non-leakage      malformed bytes carrying a secret marker → 400, marker NOT echoed
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import crypto from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { applyMigrations } from '../src/db/migrate.js';

// Force tight bounds BEFORE importing the server (import-parsers reads these at
// module-eval; a dynamic import runs after these assignments).
process.env.MYCELIUM_IMPORT_MAX_JSON_BYTES = '100000';   // 100KB cap on conversations.json
process.env.MYCELIUM_IMPORT_MAX_CONCURRENT = '3';
process.env.MYCELIUM_IMPORT_MAX_CHUNKS = '2';
process.env.MYCELIUM_IMPORT_LIMIT_BYTES = '1000000';     // 1MB total cap (tiny fixtures stay under)
process.env.MYCELIUM_IMPORT_MAX_ENTRIES = '1000';        // entry-count cap (a real vault has far fewer)
const { startRestServer } = await import('../src/server-rest.js');

const DB = 'data/verify-import-security.db';
const KCV = 'data/verify-import-security-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
const raw = new Database(DB); applyMigrations(raw); raw.close();

const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
const { url } = srv;
const M = (p) => `${url}/api/v1/portal${p}`;
const postFile = (buf, name = 'e.zip') => { const fd = new FormData(); fd.append('file', new Blob([buf]), name); return fetch(M('/upload'), { method: 'POST', body: fd }); };
const chunk = (uploadId, index, bytes, fileSize, chunkSize) => { const fd = new FormData(); fd.append('chunk', new Blob([bytes])); fd.append('uploadId', uploadId); fd.append('index', String(index)); fd.append('filename', 'e.zip'); if (fileSize != null) fd.append('fileSize', String(fileSize)); if (chunkSize != null) fd.append('chunkSize', String(chunkSize)); return fetch(M('/upload/chunk'), { method: 'POST', body: fd }); };
const complete = (uploadId, totalChunks) => fetch(M('/upload/complete'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId, totalChunks }) });

async function main() {
  try {
    // ── S1 decompression bomb (declared uncompressed size > cap) ──
    const bombZip = new JSZip();
    bombZip.file('conversations.json', JSON.stringify([{ uuid: 'b', name: 'x', chat_messages: [{ uuid: 'b1', sender: 'human', text: 'A'.repeat(500_000) }] }]));
    const bombBuf = await bombZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
    const t0 = Date.now();
    const s1 = await postFile(bombBuf);
    const s1ms = Date.now() - t0;
    rec('S1. decompression bomb refused (declared > cap → 400, not inflated)', s1.status === 400 && s1ms < 3000,
      `status=${s1.status} compressed=${bombBuf.length}B ${s1ms}ms`);

    // ── S1b entry-count bomb (millions of tiny entries → OOM, here capped at 1000) ──
    const ecZip = new JSZip();
    for (let i = 0; i < 1100; i++) ecZip.file(`e${i}.txt`, 'x'); // > MAX_ENTRIES(1000)
    const ecBuf = await ecZip.generateAsync({ type: 'nodebuffer' });
    const t1b = Date.now();
    const s1b = await postFile(ecBuf);
    rec('S1b. entry-count bomb refused (>cap entries → 400, no OOM)', s1b.status === 400 && (Date.now() - t1b) < 3000,
      `status=${s1b.status} ${Date.now() - t1b}ms`);

    // ── S5 uploadId injection (run before the map fills) ──
    const inj1 = await chunk('../../etc/passwd', 0, Buffer.from('x'));
    const inj2 = await chunk('up_' + 'A'.repeat(200), 0, Buffer.from('x'));
    rec('S5. malicious/oversized uploadId → 400 (regex fail-closed)', inj1.status === 400 && inj2.status === 400,
      `path=${inj1.status} long=${inj2.status}`);

    // ── S6 prototype pollution attempt via ChatGPT mapping keys ──
    const polZip = new JSZip();
    polZip.file('conversations.json', JSON.stringify([{ id: 'g', title: 't', mapping: {
      __proto__: { message: { author: { role: 'user' }, content: { parts: ['polluted?'] }, create_time: 1 } },
      constructor: { message: { author: { role: 'user' }, content: { parts: ['c'] }, create_time: 2 } },
      n1: { message: { author: { role: 'assistant' }, content: { parts: ['ok'] }, create_time: 3 } },
    } }]));
    const polBuf = await polZip.generateAsync({ type: 'nodebuffer' });
    const s6 = await postFile(polBuf);
    const polluted = ({}).polluted !== undefined || ({}).constructor !== Object || Object.prototype.polluted !== undefined;
    rec('S6. prototype pollution attempt has no effect on Object.prototype', s6.status === 200 && !polluted,
      `status=${s6.status} polluted=${polluted}`);

    // ── S7 error non-leakage ──
    const secret = 'TOP-SECRET-VAULT-BYTES';
    const s7 = await postFile(Buffer.from('not a zip ' + secret));
    const s7body = await s7.text();
    rec('S7. malformed input → 400, secret bytes NOT echoed', s7.status === 400 && !s7body.includes(secret),
      `status=${s7.status} leaked=${s7body.includes(secret)}`);

    // ── S4 chunk retry: re-send index 0, then complete (overwrite, no double-count) ──
    // Build a real claude zip and split into 2 chunks.
    const cz = new JSZip();
    cz.file('conversations.json', JSON.stringify([{ uuid: 's4', name: 'x', chat_messages: [
      { uuid: 's4-1', sender: 'human', text: 'retry-marker-one' }, { uuid: 's4-2', sender: 'assistant', text: 'two' }] }]));
    const czBuf = await cz.generateAsync({ type: 'nodebuffer' });
    const cs = Math.ceil(czBuf.length / 2); // fixed chunk size → exactly 2 parts, last is the remainder
    await chunk('up_retry', 0, czBuf.subarray(0, cs), czBuf.length, cs);
    await chunk('up_retry', 1, czBuf.subarray(cs), czBuf.length, cs);
    await chunk('up_retry', 0, czBuf.subarray(0, cs), czBuf.length, cs); // resend index 0 (idempotent)
    const s4 = await complete('up_retry', 2);
    const s4b = await s4.json().catch(() => ({}));
    rec('S4. chunk retry overwrites + finalize parses (no corruption/double-count)',
      s4.status === 200 && s4b.importResult?.type === 'claude' && s4b.importResult?.imported === 2,
      `status=${s4.status} imported=${s4b.importResult?.imported}`);

    // ── S3 implied chunk-count cap (MAX_CHUNKS=2): a declared fileSize/chunkSize
    // implying >2 chunks is refused on the FIRST chunk (before any allocation) ──
    const s3 = await chunk('up_chunkcap', 0, Buffer.from('a'), 300, 100); // ceil(300/100)=3 > 2
    rec('S3. implied chunk-count over cap → 413 (no allocation)', s3.status === 413, `status=${s3.status}`);

    // ── S2 concurrent-upload cap (MAX_CONCURRENT=3): spam unique ids (each with
    // a valid tiny declared size so it reserves a slot) → 429 before OOM ──
    let saw429 = false;
    for (let i = 0; i < 8; i++) {
      const r = await chunk(`up_flood${i}`, 0, Buffer.from('x'), 1, 1);
      if (r.status === 429) { saw429 = true; break; }
    }
    rec('S2. concurrent-upload flood → 429 (bounded memory)', saw429, `saw429=${saw429}`);

    // ── S8 declared fileSize over IMPORT_LIMIT → 413 (no allocation) ──
    const s8 = await chunk('up_toobig', 0, Buffer.from('x'), 2_000_000, 50_000); // 2MB > 1MB cap
    rec('S8. declared fileSize over IMPORT_LIMIT → 413 (refused before alloc)', s8.status === 413, `status=${s8.status}`);
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
  }

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? 'GO — import surface hardened: bombs/DoS bounded, no proto-pollution, fail-closed, no leakage' : 'NO-GO — see FAIL rows'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-import-security threw:', e); process.exit(1); });
