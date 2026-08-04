#!/usr/bin/env node
// verify:backup-streaming — D-122: the `.myvault` backup STREAMS; peak memory is flat
// in vault size.
//
// THE DEFECT (2026-07-30): GET /account/backup buffered the ENTIRE archive
// (readFileSync every member + JSZip nodebuffer) and failed outright on the operator's
// ~3 GB vault — the one backup that mattered was hand-built with `zip -0`. The product's
// own backup must work on exactly the vaults that most need backing up.
//
// CHECKS:
//   S1  streamVaultArchive's output round-trips through JSZip (the restore validator's
//       reader) with every member byte-identical, and the manifest matches the members
//   S2  memory ceiling: archiving a 200 MB member costs < 64 MB of heap+external delta
//       (the buffered path costs ≥ the archive size by construction)
//   S3  the zip64 encoding (forced via zip64Threshold on kilobyte fixtures) still
//       round-trips through JSZip — so a genuinely ≥4 GiB vault has a proven format path
//   S4  the route streams: /backup uses streamVaultArchive with Cache-Control:
//       no-transform (the compression wrapper does not forward write callbacks — found
//       live: without this header the stream deadlocks and the download dies)
//   S5  a member that CHANGES SIZE mid-archive RAISES instead of shipping a
//       whole-looking archive whose header disagrees with its bytes (D-076's lesson)
//
// MUTATION-TESTED: (D-122, 2026-08-03) the route reverted to the buffered
// buildVaultArchive + Content-Length shape → S4 REDs. Restored → GO.
// MUTATION-TESTED: (D-122, 2026-08-03) zip-stream's size-consistency throw removed
// (`if (size !== expectSize) throw` deleted) → S5 REDs (the truncated member ships
// inside a whole-looking archive). Restored → GO.
// MUTATION-TESTED: (D-122, 2026-08-03) zip64Threshold plumbing broken (extra field
// dropped from the central directory when big) → S3 REDs (JSZip cannot read the forced
// archive). Restored → GO.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { createZipStream } from '../src/account/zip-stream.js';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };
const t = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

const root = mkdtempSync(join(tmpdir(), 'myc-bkstream-'));
console.log('\nD-122 — streaming .myvault backup');

async function buildArchive(files, opts = {}) {
  const out = fs.createWriteStream(join(root, opts.name || 'a.zip'));
  const z = createZipStream(out, opts.zip64Threshold ? { zip64Threshold: opts.zip64Threshold } : {});
  for (const [name, v] of files) {
    if (Buffer.isBuffer(v)) await z.addBuffer(name, v);
    else await z.addFile(name, v);
  }
  await z.finalize();
  return join(root, opts.name || 'a.zip');
}

await t('S1: streamed archive round-trips byte-identical through JSZip', async () => {
  const f1 = join(root, 'db.bin'); writeFileSync(f1, crypto.randomBytes(300_000));
  const f2 = join(root, 'up.bin'); writeFileSync(f2, crypto.randomBytes(50_000));
  const man = Buffer.from(JSON.stringify({ v: 1, kcvSha256: 'x' }));
  const p = await buildArchive([['mycelium.db', f1], ['uploads/one.bin', f2], ['manifest.json', man]], { name: 's1.zip' });
  // ⚠️ checkCRC32 is LOAD-BEARING (gate-integrity review, 2026-08-03): without it, an
  // archive whose every CRC is ZERO round-trips green here while `unzip -t` rejects it —
  // and D-122's whole story is portability. JSZip defaults checkCRC32:false.
  const zip = await JSZip.loadAsync(readFileSync(p), { checkCRC32: true });
  assert.deepEqual(Object.keys(zip.files).sort(), ['manifest.json', 'mycelium.db', 'uploads/one.bin']);
  assert.ok(Buffer.compare(await zip.file('mycelium.db').async('nodebuffer'), readFileSync(f1)) === 0, 'db member byte-identical');
  assert.ok(Buffer.compare(await zip.file('uploads/one.bin').async('nodebuffer'), readFileSync(f2)) === 0, 'upload member byte-identical');
  assert.ok(Buffer.compare(await zip.file('manifest.json').async('nodebuffer'), man) === 0, 'manifest byte-identical');
});

await t('S2: archiving a 200 MB member costs < 64 MB of memory delta (flat, not proportional)', async () => {
  const big = join(root, 'big.bin');
  const w = fs.createWriteStream(big);
  const chunk = crypto.randomBytes(1024 * 1024);
  for (let i = 0; i < 200; i++) await new Promise((r) => w.write(chunk, r));
  await new Promise((r) => w.end(r));
  global.gc?.();
  const before = process.memoryUsage();
  await buildArchive([['mycelium.db', big]], { name: 's2.zip' });
  const after = process.memoryUsage();
  const deltaMb = ((after.heapUsed + after.external) - (before.heapUsed + before.external)) / (1024 * 1024);
  assert.ok(deltaMb < 64, `memory delta ${deltaMb.toFixed(1)} MB for a 200 MB member — the buffered path costs ≥ 200 MB by construction`);
  assert.ok(fs.statSync(join(root, 's2.zip')).size > 200 * 1024 * 1024, 'and the archive really carries the member');
  rmSync(big); rmSync(join(root, 's2.zip'));
});

await t('S3: the FORCED zip64 encoding round-trips through JSZip (the ≥4 GiB format path, provable small)', async () => {
  const f1 = join(root, 'z64.bin'); writeFileSync(f1, crypto.randomBytes(5_000));
  const p = await buildArchive([['mycelium.db', f1], ['manifest.json', Buffer.from('{"v":1}')]], { name: 's3.zip', zip64Threshold: 100 });
  const zip = await JSZip.loadAsync(readFileSync(p), { checkCRC32: true });
  assert.ok(Buffer.compare(await zip.file('mycelium.db').async('nodebuffer'), readFileSync(f1)) === 0,
    'zip64-encoded member must read back byte-identical');
});

await t('S4: the route STREAMS — streamVaultArchive + no-transform, no buffered path left', async () => {
  const src = readFileSync('src/account/router.js', 'utf8');
  const routeStart = src.indexOf(`router.get('/backup'`);
  assert.ok(routeStart > 0, 'route present');
  const body = src.slice(routeStart, src.indexOf('router.post', routeStart));
  assert.ok(/await streamVaultArchive\(/.test(body), 'route must await streamVaultArchive');
  assert.ok(/no-transform/.test(body), 'route must send Cache-Control: no-transform (the compression wrapper deadlocks callback-paced streams)');
  assert.ok(!/buildVaultArchive\s*\(/.test(body), 'no CALL to the buffered builder left in the route (prose mentions are history, calls are the defect)');
  assert.ok(!/setHeader\(['"]Content-Length/.test(body), 'no Content-Length header set — the length is not known before the stream ends');
});

await t('S5: a member that changes size mid-archive RAISES — never a whole-looking short archive', async () => {
  const f1 = join(root, 'shrink.bin'); writeFileSync(f1, crypto.randomBytes(200_000));
  const out = fs.createWriteStream(join(root, 's5.zip'));
  const z = createZipStream(out);
  // Interpose: shrink the file BETWEEN the crc pass and the write pass by monkey-timing —
  // deterministic version: truncate after addFile computed the crc is racy, so instead
  // truncate DURING the crc pass's completion via a same-tick hook: addFile stats crc
  // first, so truncating now (before the second read) is exactly the mid-backup change.
  const orig = fs.createReadStream;
  let calls = 0;
  fs.createReadStream = function (...args) {
    calls++;
    if (calls === 2) fs.truncateSync(f1, 50_000); // second open = the write pass
    return orig.apply(fs, args);
  };
  let threw = null;
  try { await z.addFile('mycelium.db', f1); } catch (e) { threw = e; }
  finally { fs.createReadStream = orig; try { out.destroy(); } catch { /* */ } }
  assert.ok(threw && /changed size during backup/.test(threw.message),
    `must RAISE on a mid-backup size change (got: ${threw ? threw.message : 'no throw — the archive shipped short'})`);
});

try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
console.log(`\nVERDICT: ${fail === 0 ? `GO — the .myvault backup streams with flat memory, round-trips through the restore
        reader (incl. the forced zip64 path), and a mid-backup size change raises instead of
        shipping a short archive. NOT PROVEN: a real ≥4 GiB archive end-to-end (S3 proves the
        FORMAT via forced zip64; a 4 GiB fixture is not CI material), and the response-destroy
        on mid-stream failure (source-reviewed; driving it needs a fault-injected HTTP stack).` : 'NO-GO'} — ${pass} passed, ${fail} failed\nEXIT=${fail === 0 ? 0 : 1}`);
process.exit(fail === 0 ? 0 : 1);
