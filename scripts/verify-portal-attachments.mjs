// verify:portal-attachments — the Media library serve route, with the
// content-type hardening that stops attacker-controlled MIME (Telegram
// mime_type rides verbatim through inbound media) from executing script in the
// portal (cognitive-vault) origin. Real temp vault + REAL encrypted blob
// round-trip (uploadAttachment → getBlob); no models. Proves:
//   PA1 text/html attachment → octet-stream + attachment + nosniff (no inline html)
//   PA2 image/svg+xml        → octet-stream + attachment (script-capable image forced to download)
//   PA3 image/png            → inline + image/png + nosniff (safe preview kept)
//   PA4 audio/ogg            → inline + audio/ogg (playback kept) + nosniff
//   PA5 cross-user row       → 404 (getById is user-scoped in SQL; no existence leak)
//   PA6 unknown id           → 404
//   PA7 shared-blob delete   → deleting one of two rows sharing a blob keeps the file (sibling serves)
//   PA8 last-reference delete → unlinks the blob
//   PA9-PA13 ?format=wav playback: a recording PAST the old 15-minute cap is served WHOLE, streamed
//            rather than buffered, Range-exact, and a cut decode fails the transfer instead of
//            completing a short body that sounds finished
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
process.env.MYCELIUM_UPLOADS_ROOT = 'data/verify-portalatt-uploads';
import Database from 'better-sqlite3';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { portalAttachmentsRouter } from '../src/portal-attachments.js';
import { uploadAttachment } from '../src/ingest/upload.js';
import { uploadsRoot } from '../src/paths.js';
import { buildLongOggFixture, buildOggFixture, muxOggOpus, encodeSine, RATE, FRAME } from './lib/ogg-fixture.mjs';

const DB = 'data/verify-portalatt.db';
const KCV = 'data/verify-portalatt-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
try { rmSync('data/verify-portalatt-uploads', { recursive: true }); } catch { /* */ }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));

const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex() });
const userId = 'local-user';

const up = (bytes, fileName, fileType) => uploadAttachment(db, { userId, bytes, fileName, fileType });
const htmlAtt = await up(Buffer.from('<script>fetch("/api/v1/portal/documents").then(r=>r.text())</script>'), 'note.html', 'text/html');
const svgAtt = await up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'pic.svg', 'image/svg+xml');
const pngAtt = await up(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'pic.png', 'image/png');
const oggAtt = await up(Buffer.from('OggS fake voice note bytes'), 'voice.ogg', 'audio/ogg');

const app = express();
app.use('/api/v1/portal', portalAttachmentsRouter({ db, userId }));
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/portal`;

const head = async (id) => {
  const res = await fetch(`${base}/attachments/${id}/file`);
  return {
    status: res.status,
    ct: res.headers.get('content-type') || '',
    cd: res.headers.get('content-disposition') || '',
    nosniff: res.headers.get('x-content-type-options') || '',
  };
};

// PA1 — text/html must NOT render inline same-origin.
{
  const h = await head(htmlAtt.attachmentId);
  rec('PA1. text/html → octet-stream + attachment + nosniff (no inline html exec)',
    h.status === 200 && /application\/octet-stream/.test(h.ct) && /^attachment/.test(h.cd) && h.nosniff === 'nosniff',
    `ct=${h.ct} cd=${h.cd} nosniff=${h.nosniff}`);
}
// PA2 — SVG is an image/* type but script-capable; must be forced to download.
{
  const h = await head(svgAtt.attachmentId);
  rec('PA2. image/svg+xml → octet-stream + attachment (script-capable image not inlined)',
    h.status === 200 && /application\/octet-stream/.test(h.ct) && /^attachment/.test(h.cd) && h.nosniff === 'nosniff',
    `ct=${h.ct} cd=${h.cd}`);
}
// PA3 — a real raster image still previews inline.
{
  const h = await head(pngAtt.attachmentId);
  rec('PA3. image/png → inline + image/png + nosniff (safe preview preserved)',
    h.status === 200 && /image\/png/.test(h.ct) && /^inline/.test(h.cd) && h.nosniff === 'nosniff',
    `ct=${h.ct} cd=${h.cd}`);
}
// PA4 — audio stays inline (playback) but still nosniff'd.
{
  const h = await head(oggAtt.attachmentId);
  rec('PA4. audio/ogg → inline + audio/ogg + nosniff (playback preserved)',
    h.status === 200 && /audio\/ogg/.test(h.ct) && /^inline/.test(h.cd) && h.nosniff === 'nosniff',
    `ct=${h.ct} cd=${h.cd}`);
}
// PA5 — a row owned by another user is invisible (SQL user-scoping + JS recheck).
{
  const w = new Database(DB);
  w.prepare('UPDATE attachments SET user_id = ? WHERE id = ?').run('other-user', pngAtt.attachmentId);
  w.close();
  const h = await head(pngAtt.attachmentId);
  rec('PA5. cross-user attachment → 404 (no existence leak, no byte read)', h.status === 404, `status=${h.status}`);
}
// PA6 — unknown id.
{
  const h = await head('att-does-not-exist');
  rec('PA6. unknown id → 404', h.status === 404, `status=${h.status}`);
}

// PA7/PA8 — SHARED-BLOB DELETE GUARD: byte-identical attachments share one
// encrypted blob (import dedup, #152/#154). Deleting one MUST NOT unlink the
// shared blob while a sibling still references it; deleting the last one DOES.
{
  const a = await up(Buffer.from('shared encrypted blob bytes'), 'dup-a.bin', 'application/octet-stream');
  const aRow = await db.attachments.getById(a.attachmentId, userId);
  // Second row reusing the SAME local_path (what import dedup produces).
  const bRow = await db.attachments.insert({
    user_id: userId, file_name: 'dup-b.bin', file_type: 'application/octet-stream',
    file_size: aRow.file_size, local_path: aRow.local_path,
  });
  const blobPath = join(uploadsRoot(), aRow.local_path);

  const delA = await fetch(`${base}/attachments/${a.attachmentId}`, { method: 'DELETE' });
  const siblingServes = (await fetch(`${base}/attachments/${bRow.id}/file`)).status;
  rec('PA7. deleting one of two shared-blob rows keeps the blob (sibling still serves)',
    delA.ok && existsSync(blobPath) && siblingServes === 200,
    `delA=${delA.status} blobExists=${existsSync(blobPath)} sibling=${siblingServes}`);

  const delB = await fetch(`${base}/attachments/${bRow.id}`, { method: 'DELETE' });
  rec('PA8. deleting the LAST reference unlinks the blob',
    delB.ok && !existsSync(blobPath), `delB=${delB.status} blobExists=${existsSync(blobPath)}`);
}

// ── PA9-PA13 — ?format=wav PLAYBACK: THE 15-MINUTE CLIFF ────────────────────────────────────
// `oggOpusToWav(bytes)` defaults to maxSeconds=900, so the serve route handed WKWebView a
// 15-minute WAV for a 30-minute recording and said nothing: the owner heard it stop and had no
// way to know the rest existed (the playback sibling of D-076). Raising the cap alone was not
// available — the buffered decode holds the whole thing in one Buffer (~172 MB at 30 minutes) on
// a machine also running a local model. These checks are stated on a REAL 16-minute Opus
// container, because a 2-second fixture cannot tell the fixed route from the broken one.
const LONG_SEC = 16 * 60;                       // past 900s — the old cap sat mid-recording
const { ogg: longOgg } = buildLongOggFixture(LONG_SEC);
const longAtt = await up(longOgg, 'long-voice.ogg', 'audio/ogg');
const LONG_WAV_BYTES = 44 + LONG_SEC * RATE * 2; // mono s16le 48k

// ⚠️ THE CLOCK STARTS BEFORE THE FETCH, NOT AFTER IT. `fetch()` resolves when the response
// HEADERS arrive, and a buffered implementation finishes its whole decode before sending them —
// so timing only the body read reports ~0 ms for the buffered case too, and PA10 passed under a
// fully-buffered mutant (caught by mutation-testing this very check). Time-to-headers is the
// quantity that separates the two shapes.
const drain = async (url, init) => {
  const t0 = Date.now();
  const res = await fetch(url, init);
  const headerMs = Date.now() - t0;             // decode-before-first-byte lands here
  let bytes = 0;
  for await (const c of res.body) bytes += c.length;
  return { res, bytes, headerMs, totalMs: Date.now() - t0 };
};

// PA9 — THE REGRESSION TEST. Whole recording, and the part past 15:00 is real audio.
// MUTATION-TESTED: restoring the old body (`const wav = await oggOpusToWav(bytes); sendRange(wav)`)
// in portal-attachments.js → REDs: 43200044 bytes served for a 92160044-byte recording, i.e. the
// exact 900-second cut this check exists to make impossible.
let fullWav = null;   // kept for PA11's byte-identity comparison
{
  const r = await fetch(`${base}/attachments/${longAtt.attachmentId}/file?format=wav`);
  const buf = Buffer.from(await r.arrayBuffer());
  fullWav = buf;
  // Sample one second of audio well past the old cap: silence there means "truncated and padded",
  // which would be the same lie wearing a different mask.
  let peakPastCap = 0;
  const at16min = 44 + 15 * 60 * RATE * 2 + 30 * RATE * 2; // 15:30
  if (buf.length > at16min + RATE * 2) {
    for (let i = at16min; i < at16min + RATE * 2; i += 2) peakPastCap = Math.max(peakPastCap, Math.abs(buf.readInt16LE(i)));
  }
  rec('PA9. a 16-minute voice note is served WHOLE as WAV (the 900s cap is gone, and 15:30 is real audio)',
    r.status === 200 && buf.length === LONG_WAV_BYTES && /audio\/wav/.test(r.headers.get('content-type') || '')
    && Number(r.headers.get('content-length')) === LONG_WAV_BYTES && peakPastCap > 8000,
    `bytes=${buf.length} expected=${LONG_WAV_BYTES} cl=${r.headers.get('content-length')} peakAt15:30=${peakPastCap} dur=${r.headers.get('x-audio-duration-sec')}`);
}

// PA10 — STREAMED, NOT BUFFERED. The memory hazard that made the cap look necessary is only
// actually gone if the first byte leaves before the last one is decoded. Scale-invariant on
// purpose (no absolute millisecond budget): a buffered implementation cannot send byte 1 until
// the decode is finished, so its TTFB is ~the whole serve.
// MUTATION-TESTED with a BUFFERED-BUT-UNCAPPED mutant (`oggOpusToWav(bytes, {maxSeconds: 14400})`
// + sendRange), chosen so PA9's length clause still passes and only this claim can RED — an
// earlier form of this check passed under exactly that mutant, because it timed the body read
// instead of the wait for headers. See the note on `drain`.
{
  const { bytes, headerMs, totalMs } = await drain(`${base}/attachments/${longAtt.attachmentId}/file?format=wav`);
  rec('PA10. the WAV is STREAMED (response starts long before the last byte is decoded — no 172MB buffer)',
    bytes === LONG_WAV_BYTES && headerMs * 2 < totalMs,
    `timeToHeaders=${headerMs}ms totalMs=${totalMs}ms bytes=${bytes}`);
}

// PA11 — Range must be exact against the streamed total. WKWebView will not play audio at all
// without 206s, and a seek lands on a byte offset that no window boundary lines up with.
//
// ⚠️ THE ASSERTION IS ON THE BYTES, NOT THE COUNT. An earlier form of this check compared only
// lengths and Content-Range, and PASSED under a mutant that ignored the requested offset
// entirely — because Node truncates the body to the declared Content-Length, so the wrong audio
// arrived in the right quantity. A seek that silently returns the START of the recording is the
// same class of defect as a truncation: confident, well-formed, and wrong.
// MUTATION-TESTED: dropping the range intersection in portal-audio-stream.js's `push` (write
// every slice whole, let Content-Length trim it) → REDs on the byte comparison.
{
  const start = LONG_WAV_BYTES - 100_000;
  const r = await fetch(`${base}/attachments/${longAtt.attachmentId}/file?format=wav`, { headers: { Range: `bytes=${start}-` } });
  const tail = Buffer.from(await r.arrayBuffer());
  // A MID-FILE seek at an offset that is not a window boundary (~7:00 in, +1 byte).
  const midStart = 44 + 420 * RATE * 2 + 1, midEnd = midStart + 199_999;
  const mid = await fetch(`${base}/attachments/${longAtt.attachmentId}/file?format=wav`, { headers: { Range: `bytes=${midStart}-${midEnd}` } });
  const midBytes = Buffer.from(await mid.arrayBuffer());
  const probe = await fetch(`${base}/attachments/${longAtt.attachmentId}/file?format=wav`, { headers: { Range: 'bytes=0-43' } });
  const headerBytes = Buffer.from(await probe.arrayBuffer());
  const over = await fetch(`${base}/attachments/${longAtt.attachmentId}/file?format=wav`, { headers: { Range: `bytes=${LONG_WAV_BYTES + 5}-` } });
  const tailOk = tail.length === 100_000 && tail.equals(fullWav.subarray(start));
  const midOk = midBytes.length === 200_000 && midBytes.equals(fullWav.subarray(midStart, midEnd + 1));
  rec('PA11. Range on the streamed WAV returns the RIGHT BYTES at the right offsets (206/416, mid-file seek)',
    r.status === 206 && tailOk
    && r.headers.get('content-range') === `bytes ${start}-${LONG_WAV_BYTES - 1}/${LONG_WAV_BYTES}`
    && mid.status === 206 && midOk
    && mid.headers.get('content-range') === `bytes ${midStart}-${midEnd}/${LONG_WAV_BYTES}`
    && probe.status === 206 && headerBytes.equals(fullWav.subarray(0, 44))
    && over.status === 416 && over.headers.get('content-range') === `bytes */${LONG_WAV_BYTES}`,
    `tailBytesMatch=${tailOk} midBytesMatch=${midOk} cr=${r.headers.get('content-range')} past-end=${over.status}`);
}

// PA12 — ⚠️ THE INVARIANT THE WHOLE FIX IS FOR. When the decoder cannot produce what the response
// header promised, the transfer must FAIL. Ending it cleanly would hand the client a body that
// looks complete and stops early — which is the defect, not a degraded version of the fix.
// MUTATION-TESTED: restoring the OLD buffered body (`oggOpusToWav(bytes)` + sendRange) → REDs
// with `outcome=completed promised=192044 received=192044` — a self-consistent, complete-looking
// 2-second WAV served for a 4-second recording. That is the defect in miniature: the capped
// decode sets its own Content-Length, so nothing at any layer can tell the client audio is missing.
// Recorded honestly: swapping only `res.destroy()` for `res.end()` does NOT RED this, because
// Node then refuses the Content-Length mismatch and severs the connection itself. The destroy is
// the intentional, logged layer; Node's enforcement is the second one underneath it (§2).
{
  const good = encodeSine(2);
  const junk = good.map(() => Buffer.from([0x03]));   // TOC byte the decoder rejects
  const halfBad = muxOggOpus([...good, ...junk]);     // timeline says 4s; only 2s can decode
  const att = await up(halfBad.ogg, 'half-bad.ogg', 'audio/ogg');
  let outcome = 'completed', got = 0, promised = null;
  try {
    const r = await fetch(`${base}/attachments/${att.attachmentId}/file?format=wav`);
    promised = r.headers.get('content-length');
    got = Buffer.from(await r.arrayBuffer()).length;
  } catch { outcome = 'transfer-failed'; }
  rec('PA12. a decode that cannot fill the promised length FAILS the transfer (never a short body that looks whole)',
    outcome === 'transfer-failed', `outcome=${outcome} promised=${promised} received=${got}`);
}

// PA13 — fail-soft survives the rewrite: a container the probe can read but the decoder cannot
// use at all must still serve the ORIGINAL bytes (a non-WebKit browser plays Ogg natively).
// Nothing has been written to the socket at that point, so the branch can still be abandoned.
// MUTATION-TESTED: writing the WAV header BEFORE the decode loop instead of with the first window
// → REDs with `ct=audio/wav ... err=UND_ERR_SOCKET`: headers are already on the wire, the branch
// can no longer be abandoned, and the owner gets a dead request where the original Ogg would have
// played. Deferring the header is what keeps the fallback reachable.
{
  const allBad = muxOggOpus(encodeSine(1).map(() => Buffer.from([0x03])));
  const att = await up(allBad.ogg, 'undecodable.ogg', 'audio/ogg');
  // The failure this guards against leaves the response half-written, so the request itself can
  // die — caught here so the gate REDs on PA13 instead of crashing with a socket error.
  let ct = null, bytes = -1, xdur = null, err = null;
  try {
    const r = await fetch(`${base}/attachments/${att.attachmentId}/file?format=wav`);
    ct = r.headers.get('content-type'); xdur = r.headers.get('x-audio-duration-sec');
    bytes = Buffer.from(await r.arrayBuffer()).length;
  } catch (e) { err = e.cause?.code || e.message; }
  rec('PA13. an undecodable Opus stream falls back to the raw bytes (fail-soft preserved, no half-WAV)',
    !err && /audio\/ogg/.test(ct || '') && bytes === allBad.ogg.length && !xdur,
    `ct=${ct} bytes=${bytes} original=${allBad.ogg.length} err=${err}`);
}

// PA14 — ⚠️ THE HOLE THAT SURVIVES THE PROMISE. A rejected packet is lost audio, and the packets
// around it CLOSE RANKS: the timeline compresses, so the body can still reach its promised length
// and play seamlessly across the gap. Real encoders declare an end-trim (`sum(frames) > granule`),
// and that slack is exactly big enough to absorb the loss — so `pcmDelivered` hits `dataBytes`,
// the shortfall branch never fires, and the recording with a hole in it is served as a clean 200.
// The generator DOES raise `packet-loss`, but only after its last window, and the serve loop breaks
// as soon as the promise is met — `break` runs the generator's `finally` and skips the throw.
// This is D-076's compressed timeline reproduced INSIDE the fix for its playback sibling, and no
// gate could see it because every fixture had `sum(frames) === granule` exactly (adversarial
// review, C1). It is the one check here whose fixture had to get HARDER to have teeth.
// MUTATION-TESTED: disabling the per-window check in portal-audio-stream.js
// (`if (false && win.lostPackets > 0)`) → REDs with `COMPLETED status=200 promised=574124
// received=574124` — the full promised length delivered, seamless, with the hole inside it.
{
  const good = encodeSine(6);
  good[150] = Buffer.from([0x03]);                                  // one packet destroyed at t=3s
  const holed = muxOggOpus(good, { endTrimSamples: FRAME });        // realistic one-frame end-trim
  const att = await up(holed.ogg, 'holed.ogg', 'audio/ogg');
  let outcome = 'completed', promised = null, got = 0;
  try {
    const r = await fetch(`${base}/attachments/${att.attachmentId}/file?format=wav`);
    promised = r.headers.get('content-length');
    got = Buffer.from(await r.arrayBuffer()).length;
  } catch { outcome = 'transfer-failed'; }
  rec('PA14. a mid-recording hole absorbed by end-trim slack still FAILS (a compressed timeline is never served as whole)',
    outcome === 'transfer-failed', `outcome=${outcome} promised=${promised} received=${got}`);
}

// PA15 — HEAD and GET must describe the SAME resource. HEAD used to be answered from the granule
// probe alone, which is cheap and was the point — but on the fail-soft path (a container that
// probes cleanly and decodes to nothing) it advertised `audio/wav` and a 96044-byte length for a
// resource GET then served as 1548 bytes of `audio/ogg`. Both Svelte players set
// `preload="metadata"` and WebKit range-probes before the real fetch, so the divergence lands in
// the exact client this route exists for (adversarial review, C4).
// MUTATION-TESTED: restoring the probe-only early return (`if (req.method === 'HEAD') { res.end();
// return true; }` before the decode loop) → REDs with `HEAD ct=audio/wav cl=96044` against
// `GET ct=audio/ogg cl=1548`.
{
  const allBad = muxOggOpus(encodeSine(1).map(() => Buffer.from([0x03])));
  const att = await up(allBad.ogg, 'head-vs-get.ogg', 'audio/ogg');
  const u = `${base}/attachments/${att.attachmentId}/file?format=wav`;
  const h = await fetch(u, { method: 'HEAD' });
  const g = await fetch(u);
  const gBytes = Buffer.from(await g.arrayBuffer()).length;
  const hct = h.headers.get('content-type'), gct = g.headers.get('content-type');
  rec('PA15. HEAD and GET agree on type and length, including on the fail-soft path',
    hct === gct && Number(h.headers.get('content-length')) === gBytes,
    `HEAD ct=${hct} cl=${h.headers.get('content-length')} | GET ct=${gct} bytes=${gBytes}`);
}

// PA16 — a CHAINED container (several concatenated Opus streams) is served as the ORIGINAL bytes.
// The demuxer decodes only the first logical bitstream, so transcoding hands back that link alone —
// 40% of a 5-second recording under a clean 200, with `complete: true` beside it because the walk
// consumed every byte and saw link A's EOS (adversarial review, C2). Falling back is strictly
// better than a truncated WAV: a non-WebKit browser decodes the whole chain natively.
// MUTATION-TESTED: dropping `if (probe.chained) return false` from portal-audio-stream.js → REDs
// with `ct=audio/wav bytes=192044` — a 2-second WAV served for a 5-second recording.
{
  const chained = Buffer.concat([buildOggFixture(2).ogg, buildOggFixture(3, { serial: 77 }).ogg]);
  const att = await up(chained, 'chained.ogg', 'audio/ogg');
  const r = await fetch(`${base}/attachments/${att.attachmentId}/file?format=wav`);
  const body = Buffer.from(await r.arrayBuffer());
  rec('PA16. a chained Ogg falls back to the raw bytes (never a WAV of its first link alone)',
    /audio\/ogg/.test(r.headers.get('content-type') || '') && body.length === chained.length,
    `ct=${r.headers.get('content-type')} bytes=${body.length} original=${chained.length}`);
}

server.close(); await close?.();
const okAll = ledger.every(Boolean);
console.log(`VERDICT: ${okAll ? 'GO' : 'NO-GO'} — portal attachment serve: inline-safe MIME allowlist + nosniff + user-scoped reads + shared-blob delete guard + uncapped streamed WAV playback  EXIT=${okAll ? 0 : 1}`);
process.exit(okAll ? 0 : 1);
