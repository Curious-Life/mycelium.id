// verify:ogg-opus — pure-JS OGG/Opus → WAV transcode (no network, no ffmpeg).
// Builds a REAL Opus-in-Ogg fixture (opusscript encode + minimal in-test ogg
// muxer with correct page CRCs) and proves:
//   G1 decode → WAV with exact PCM geometry (48k mono s16le, 44-byte header)
//   G2 decoded audio is non-silent (the sine actually survived the round-trip)
//   G3 OGG/Vorbis (not Opus) → null (fail-soft, no throw)
//   G4 junk / truncated bytes → null
//   G5 transcribeAudio transcodes ogg → sends format:"wav" to the model
//   G16-G18 the granule probe: exact decoded length with no decode, fail-soft, O(pages)
//   G19-G20 EOS on a granule-less page; the decoder-vs-granule bound on an end-trimmed container
import { oggOpusToWav, oggOpusToWavChunks, oggOpusProbe, AudioDecodeTruncatedError, WAV_HEADER_BYTES } from '../src/enrich/ogg-opus.js';
import { transcribeAudio } from '../src/enrich/transcribe-audio.js';
import { buildOggFixture, buildLongOggFixture, muxOggOpus, encodeSine, RATE, FRAME } from './lib/ogg-fixture.mjs';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// ── fixture: 2s 440Hz sine → opus packets → ogg pages (real CRC) ─────────────
// The builder moved to scripts/lib/ogg-fixture.mjs so verify:portal-attachments can mux the
// same real containers (it needs a 16-minute one). Geometry here is unchanged: one packet per
// page, granule from zero, preSkip 312 declared in OpusHead.
const CH = 1;

const { ogg, packets } = buildOggFixture(2);

// A well-formed Ogg container whose Opus payloads are junk the decoder REJECTS. Used by G13 to
// prove the decode budget bounds work that produces no output at all — the case both ceilings
// used to miss because they lived inside `if (out)`.
function buildJunkOgg(nPackets) {
  const bad = Buffer.from([0x03]);   // a TOC byte opusscript rejects with "Invalid packet"
  return muxOggOpus(Array.from({ length: nPackets }, () => bad)).ogg;
}

// G1 + G2
{
  const wav = await oggOpusToWav(ogg);
  const expected = 44 + packets * FRAME * CH * 2;
  let peak = 0;
  if (wav) for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
  rec('G1. opus fixture → WAV with exact geometry', !!wav && wav.length === expected && wav.subarray(0, 4).toString() === 'RIFF', `len=${wav?.length} expected=${expected}`);
  rec('G2. decoded PCM is non-silent (sine survived)', peak > 8000, `peak=${peak}`);
}

// G3 — a Vorbis-in-Ogg stream must fail soft (prism demuxer rejects non-Opus)
{
  const vorbis = Buffer.from(ogg); // clone, then corrupt the OpusHead magic into a Vorbis-ish one
  vorbis.write('vorbHead', 28); // first page payload starts at 28 (27 header + 1 lacing)
  rec('G3. non-Opus ogg → null (fail-soft)', (await oggOpusToWav(vorbis)) === null);
}

// G4 — junk and truncation
{
  rec('G4. junk / truncated → null', (await oggOpusToWav(Buffer.from('not audio'))) === null
    && (await oggOpusToWav(ogg.subarray(0, 40))) === null);
}

// G5 — transcribeAudio sends WAV (not ogg) to the model after transcode
{
  let sentFormat = null, sentDataLen = 0;
  const fakeFetch = async (url, init) => {
    if (String(url).includes('/v1/chat/completions')) {
      const body = JSON.parse(init.body);
      const part = body.messages[0].content.find((c) => c.type === 'input_audio');
      sentFormat = part.input_audio.format; sentDataLen = part.input_audio.data.length;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'transcribed!' } }] }) };
    }
    return { ok: false, json: async () => ({}) };
  };
  const out = await transcribeAudio({ bytes: ogg, mimeType: 'audio/ogg', model: 'fake-audio-model', fetch: fakeFetch, timeoutMs: 5000 });
  rec('G5. transcribeAudio transcodes ogg → format:"wav" reaches the model', out === 'transcribed!' && sentFormat === 'wav' && sentDataLen > 100000, `format=${sentFormat} dataLen=${sentDataLen}`);
}

// G6 — the output cap STOPS decoding (DoS guard): a tiny maxSeconds bounds the
// WAV data to ~the cap, proving we don't decode every packet to completion.
{
  const t0 = Date.now();
  const capped = await oggOpusToWav(ogg, { maxSeconds: 0.01, timeoutMs: 5000 }); // cap ≈ 960 PCM bytes
  const ms = Date.now() - t0;
  const dataBytes = capped ? capped.length - 44 : 0;
  // bound = cap (960) + at most one extra decoded frame (FRAME samples) before capping
  const bound = 0.01 * RATE * CH * 2 + FRAME * CH * 2;
  rec('G6. output cap bounds decode work (no full-stream decode under a small cap)',
    !!capped && dataBytes <= bound && ms < 4000, `dataBytes=${dataBytes} bound=${bound} ms=${ms}`);
}

// G7 — timeoutMs is an accepted, non-breaking option for the normal path.
{
  const wav = await oggOpusToWav(ogg, { timeoutMs: 5000 });
  rec('G7. timeoutMs option does not break a normal decode', !!wav && wav.subarray(0, 4).toString() === 'RIFF');
}

// G8 — LOSSLESS chunking: windowed decode must reconstruct the SAME PCM as the
// single-shot decode, byte-for-byte, across MANY windows (nothing dropped at a
// boundary). A tiny windowSeconds forces multiple windows from the 2s fixture.
//
// ⚠️ WINDOWS NOW OVERLAP (D-076), so the lossless property is stated on the NEW audio each window
// contributes: dropping each window's leading `overlapSec` and concatenating must reproduce the
// single-shot PCM exactly. Overlap is deliberate redundancy, not extra audio.
{
  const single = await oggOpusToWav(ogg);
  const singlePcm = single.subarray(44);
  const bps = RATE * CH * 2;
  const parts = [];
  let overlapSeen = 0;
  for await (const w of oggOpusToWavChunks(ogg, { windowSeconds: 0.1, overlapSeconds: 0.02, maxSeconds: 14400, decodeBudgetMs: 30000 })) {
    const pcm = w.wav.subarray(44);
    const skip = Math.round(w.overlapSec * bps);
    if (skip > 0) overlapSeen += 1;
    parts.push(pcm.subarray(skip));
  }
  const joined = Buffer.concat(parts);
  rec('G8. overlapped windowed decode is lossless (>1 window, new-audio PCM identical to single-shot)',
    parts.length > 1 && joined.length === singlePcm.length && joined.equals(singlePcm),
    `windows=${parts.length} joinedBytes=${joined.length} singleBytes=${singlePcm.length}`);
  rec('G9. successive windows actually OVERLAP (a hard split at the byte boundary clips words)',
    overlapSeen >= 1 && overlapSeen === parts.length - 1,
    `windowsWithOverlap=${overlapSeen} of ${parts.length - 1} seams`);
}

// ── D-076 ────────────────────────────────────────────────────────────────────────────────────
// G10. A CUT-SHORT DECODE MUST RAISE, NEVER RETURN NORMALLY.
// The generator used to set `capped = true; ended = true` on its wall-clock timer and return
// normally, so the consumer rejoined a PREFIX of a 30-minute recording and stored it as the whole
// thing — no fault, no log, no marker.
// MUTATION-TESTED: replacing the `throw new AudioDecodeTruncatedError(...)` with a plain `return`
// → this check REDs (`threw` stays false and a partial is accepted as complete).
{
  let threw = null, windows = 0;
  try {
    for await (const w of oggOpusToWavChunks(ogg, { windowSeconds: 0.05, maxSeconds: 0.12, decodeBudgetMs: 30000 })) { windows += 1; void w; }
  } catch (e) { threw = e; }
  rec('G10. hitting maxSeconds RAISES AudioDecodeTruncatedError (a partial is never a normal return)',
    threw instanceof AudioDecodeTruncatedError && threw.reason === 'max-seconds' && windows > 0,
    `windows=${windows} err=${threw?.name}:${threw?.reason}`);
}

// G11. THE BUDGET MEASURES DECODE, NOT THE CONSUMER.
// The generator BACKPRESSURES (`demuxer.pause()`, resumed only when the consumer takes a window),
// so a wall-clock timer charged per-window TRANSCRIPTION MINUTES against the decode budget and
// fired mid-stream on every long file. This drives the exact shape: a consumer far slower than the
// budget, with a decode that is fast. It must complete.
// MUTATION-TESTED: replacing the decode-only clock with `setTimeout(... , decodeBudgetMs)` (the old
// wall-clock backstop) → this check REDs — the fixture truncates because the SLEEPING CONSUMER, not
// the decode, spent the budget.
// ⚠️ THE CONSUMER SLEEP MUST DOMINATE THE BUDGET WITH ROOM TO SPARE, and the fixture must produce
// more than one seam. The 2s fixture yields 3 windows (windowSeconds is floored at 1s), so the
// consumer spends ~1.2s against a 300ms budget while the real decode of a 2s sine costs ~1ms. A
// first draft used 120ms sleeps against 400ms and stayed GREEN under the old wall-clock timer
// (mutation M18) purely because 3×120ms fitted inside the budget — the check had no teeth.
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let windows = 0, threw = null;
  const t0 = Date.now();
  try {
    for await (const w of oggOpusToWavChunks(ogg, { windowSeconds: 0.1, decodeBudgetMs: 300, stallMs: 60000 })) {
      windows += 1;
      await sleep(400);   // the "transcription" — each window costs > the WHOLE decode budget
      void w;
    }
  } catch (e) { threw = e; }
  const wall = Date.now() - t0;
  rec('G11. consumer time is NOT charged to the decode budget (slow consumer, complete decode)',
    threw === null && windows > 1 && wall > 300 * 2,
    `windows=${windows} wallMs=${wall} budgetMs=300 err=${threw?.name}:${threw?.reason ?? ''}`);
}

// G12. The overlap is CLAMPED to half a window. Unclamped, `carry` becomes the entire previous
// window, so every subsequent packet immediately re-crosses the window threshold: progress becomes
// non-monotonic (each window re-emits nearly everything while advancing by one packet) and the
// window count explodes. Asserting only "it terminates" was toothless (mutation M20 stayed green) —
// the properties that actually break are the clamp itself and the bounded window count.
{
  let windows = 0, threw = null, maxOverlap = 0, maxWavBytes = 0;
  try {
    for await (const w of oggOpusToWavChunks(ogg, { windowSeconds: 1, overlapSeconds: 999, decodeBudgetMs: 30000 })) {
      windows += 1; maxOverlap = Math.max(maxOverlap, w.overlapSec); maxWavBytes = Math.max(maxWavBytes, w.wav.length);
      void w;
    }
  } catch (e) { threw = e; }
  // 2s of audio at a 1s window with overlap clamped to 0.5s ⇒ at most a handful of windows.
  rec('G12. an absurd overlapSeconds is CLAMPED to half a window (bounded windows, bounded size)',
    threw === null && windows > 1 && windows <= 6 && maxOverlap <= 0.5 + 1e-6 && maxWavBytes <= 44 + 1.5 * RATE * CH * 2,
    `windows=${windows} maxOverlapSec=${maxOverlap} maxWavBytes=${maxWavBytes}`);
}

// G13. THE BUDGET MUST BOUND *UNDECODABLE* PACKETS TOO (second adversarial review, MEDIUM-5).
// Both ceilings used to sit inside `if (out)`, and a decoder throw is swallowed — so a container
// whose packets ALL fail to decode was bounded by nothing. Measured before the fix: 2,000,000 junk
// packets burned 13.6 s of CPU against a 50 ms budget and then returned NORMALLY. prism's demuxer
// drains the buffer synchronously, so the stall timer never gets a macrotask either — the check has
// to be per-packet and BEFORE the decode.
// MUTATION-TESTED: moving the `decodeElapsed() >= decodeBudgetMs` check back inside `if (out)` →
// this check REDs (no error is thrown and the elapsed time blows past the budget).
{
  // A well-formed Ogg stream whose Opus packets are junk the decoder rejects.
  const junk = buildJunkOgg(60000);
  const t0 = Date.now();
  let threw = null, windows = 0;
  try {
    for await (const w of oggOpusToWavChunks(junk, { decodeBudgetMs: 50, stallMs: 60000 })) { windows += 1; void w; }
  } catch (e) { threw = e; }
  const ms = Date.now() - t0;
  rec('G13. an undecodable-packet flood is bounded by the decode budget and RAISES',
    threw instanceof AudioDecodeTruncatedError && threw.reason === 'decode-budget' && ms < 5000,
    `ms=${ms} budget=50 windows=${windows} err=${threw?.name}:${threw?.reason}`);
}

// G14. The caller's AbortSignal must stop the decode. The generator took no signal at all, so a
// blown live-turn bound could not stop an in-flight decode holding the single model slot.
// MUTATION-TESTED: removing the `abortSignal?.aborted` check from the data handler → this check
// REDs (the decode runs to completion and no error is raised).
{
  const ac = new AbortController();
  ac.abort();
  let threw = null, windows = 0;
  try {
    for await (const w of oggOpusToWavChunks(ogg, { signal: ac.signal, decodeBudgetMs: 30000 })) { windows += 1; void w; }
  } catch (e) { threw = e; }
  rec('G14. an aborted caller signal stops the decode and RAISES (never a silent partial)',
    threw instanceof AudioDecodeTruncatedError && threw.reason === 'aborted',
    `windows=${windows} err=${threw?.name}:${threw?.reason}`);
}

// G15. LOST PACKETS COMPRESS THE TIMELINE — the loss must be reported, not absorbed.
// An undecodable packet is swallowed so the rest of the stream survives (correct), but the
// surviving packets then close ranks: every window still transcribes and `coveredSec` equals
// `durationSec` because both derive from the bytes that survived. The row was stamped complete over
// a transcript with silence cut out of the middle, and the drain predicate then excluded it
// permanently (adversarial review round 2, HIGH-1).
// MUTATION-TESTED: removing `if (!capped && lostPackets > 0) capped = "packet-loss"` from
// ogg-opus.js → this check REDs (the decode returns normally and the loss is invisible).
{
  // A stream whose FIRST HALF is real audio and whose second half is junk the decoder rejects.
  const good = buildOggFixture(2).ogg;
  const junkTail = buildJunkOgg(200);
  const spliced = Buffer.concat([good, junkTail.subarray(junkTail.indexOf(Buffer.from('OggS'), 100))]);
  let threw = null, windows = 0;
  try {
    for await (const w of oggOpusToWavChunks(spliced, { decodeBudgetMs: 30000, stallMs: 60000 })) { windows += 1; void w; }
  } catch (e) { threw = e; }
  rec('G15. undecodable packets RAISE packet-loss (a compressed timeline is never reported complete)',
    threw instanceof AudioDecodeTruncatedError && threw.reason === 'packet-loss' && threw.lostPackets > 0,
    `windows=${windows} err=${threw?.name}:${threw?.reason} lost=${threw?.lostPackets}`);
}

// ── G16-G18: the GRANULE PROBE, which is what makes streamed playback possible ──────────────
// `/attachments/:id/file?format=wav` used to buffer the whole decode, so it could only afford a
// 900-second cap and served every longer recording cut short in silence. Streaming it instead
// requires knowing the exact byte length BEFORE the first byte goes out (HTTP Range demands the
// total), and `oggOpusProbe` gets it from the Ogg page headers alone. If the probe and the
// decoder ever disagree, the route promises a Content-Length it cannot deliver — so the
// agreement is asserted here, on real containers, rather than assumed from the RFC.

// G16 — the probe's length IS the decoder's length, exactly.
// MUTATION-TESTED: in oggOpusProbe, `lastGranule = granule` → `if (lastGranule < 0n) lastGranule = granule`
// (keep the FIRST page's granule instead of the last) → REDs: predicted=44 vs actual=192044.
{
  const wav = await oggOpusToWav(ogg);
  const p = oggOpusProbe(ogg);
  const predicted = WAV_HEADER_BYTES + p.granuleSamples * CH * 2;
  rec('G16. granule probe predicts the decoded WAV size EXACTLY (no decode needed)',
    !!p && predicted === wav.length && p.channels === CH && p.preSkip === 312 && p.complete === true,
    `predicted=${predicted} actual=${wav.length} granuleSamples=${p?.granuleSamples} preSkip=${p?.preSkip} complete=${p?.complete}`);
}

// G17 — fail-soft, and an honest answer for a container that is itself cut short. A probe that
// threw (or guessed) on a damaged blob would take down the serve route with it; a probe that
// reported the FULL length of a truncated file would make the route promise bytes that are not
// in the vault. Both must be impossible.
// MUTATION-TESTED, twice:
//  (a) OpusHead magic check made permissive (`if (false) return null`) → REDs: a Vorbis-in-Ogg
//      stream is measured instead of rejected, so the route would transcode a non-Opus blob.
//  (b) the `if (pageEnd > ogg.length) break` guard deleted → REDs: the walk reads a PARTIAL final
//      page and reports 89280 samples where only 88320 decode — the probe promising bytes that
//      are not in the vault, which is exactly the Content-Length the route cannot deliver.
{
  const vorbis = Buffer.from(ogg); vorbis.write('vorbHead', 28);
  const cut = ogg.subarray(0, ogg.length - 1200);           // whole pages plus a partial one
  const cutProbe = oggOpusProbe(cut);
  const full = oggOpusProbe(ogg);
  const cutWav = await oggOpusToWav(cut);
  rec('G17. probe fails soft (junk/non-Opus → null) and a TRUNCATED container reports less, not the full length',
    oggOpusProbe(Buffer.from('not audio')) === null
    && oggOpusProbe(vorbis) === null
    && oggOpusProbe(Buffer.alloc(0)) === null
    && !!cutProbe && cutProbe.complete === false && cutProbe.granuleSamples < full.granuleSamples
    && WAV_HEADER_BYTES + cutProbe.granuleSamples * CH * 2 === cutWav.length,
    `cutGranule=${cutProbe?.granuleSamples} fullGranule=${full.granuleSamples} cutComplete=${cutProbe?.complete} cutDecoded=${cutWav.length - WAV_HEADER_BYTES}`);
}

// G18 — the probe must be O(pages), NOT a decode in disguise. This is the whole economy of the
// fix: a HEAD or a Range request answers from the header walk, and a 16-minute recording costs
// milliseconds instead of a full transcode.
// MUTATION-TESTED, twice:
//  (a) the probe made to derive its answer BY DECODING (packets sliced from the lacing table and
//      run through opusscript) → REDs on the ratio: probeMs=1040 against decodeMs=1072.
//  (b) the G16 mutation (first granule instead of last) → REDs on the length agreement, which is
//      what proves the probe is right about a recording PAST the old 900-second cap, not just a
//      2-second one.
{
  const long = buildLongOggFixture(16 * 60);
  const t0 = Date.now();
  const p = oggOpusProbe(long.ogg);
  const probeMs = Date.now() - t0;
  const t1 = Date.now();
  let decoded = 0;
  for await (const w of oggOpusToWavChunks(long.ogg, { windowSeconds: 30, overlapSeconds: 0, decodeBudgetMs: 120000 })) decoded += w.wav.length - WAV_HEADER_BYTES;
  const decodeMs = Date.now() - t1;
  rec('G18. probing a 16-minute recording costs page-walk time, not decode time',
    p.granuleSamples === long.seconds * RATE && decoded === p.granuleSamples * CH * 2 && probeMs * 20 < decodeMs,
    `seconds=${long.seconds} probeMs=${probeMs} decodeMs=${decodeMs} decodedBytes=${decoded}`);
}

// G19 — EOS DETECTION MUST NOT BE NESTED INSIDE THE GRANULE TEST. A page that finishes no packet
// carries granule -1, and the end-of-stream flag can ride on exactly such a page (legal Ogg). While
// the EOS check lived inside `if (granule !== NO_GRANULE)`, those streams reported `complete: false`
// forever — the serve route would stamp `X-Audio-Source-Incomplete` on a perfectly intact recording.
// Fail-safe in direction, wrong in fact, and it landed with no fixture that could see it (found by
// the adversarial review of this change, which noted the fix would otherwise have no teeth).
// MUTATION-TESTED: re-nesting the flag read (`else if (pageSerial === serial && granule !== NO_GRANULE)`)
// → REDs, `eosNoGranule.complete=false`.
{
  const normal = oggOpusProbe(buildOggFixture(2).ogg);
  const eosNoGranule = oggOpusProbe(muxOggOpus(encodeSine(2), { trailingNoGranuleEosPage: true }).ogg);
  rec('G19. an end-of-stream flag on a page with NO granule still marks the stream complete',
    normal.complete === true && eosNoGranule.complete === true
    && eosNoGranule.granuleSamples === normal.granuleSamples,
    `normal=${normal.complete} eosNoGranule=${eosNoGranule.complete} granule=${eosNoGranule.granuleSamples}`);
}

// G20 — THE PROBE AGAINST A REALISTICALLY END-TRIMMED CONTAINER. Every other fixture here is built
// with `sum(frames) === granule`, which no real encoder produces: libopus pads the final frame and
// declares the trim in the granule, so the DECODER EMITS MORE than the timeline claims. G16's
// "predicts the decoded WAV size EXACTLY" is therefore a statement about an easy fixture. The real
// invariant — the one the serve route depends on — is an INEQUALITY plus a bound: the decoder never
// emits less than the granule promises, and never more than one frame more. The route serves
// exactly `granuleSamples` and trims that overshoot.
// MUTATION-TESTED: dropping the `- preSkip`... no — recorded honestly: this check REDs under the
// G16 mutation (first granule instead of last), and its INEQUALITY clause REDs if the probe is made
// to report the decoder's raw output instead of the granule (`granuleSamples: decodedSamples`),
// which is the mistake that would silently re-introduce the un-trimmed tail.
{
  const trimmed = muxOggOpus(encodeSine(3), { endTrimSamples: FRAME });
  const p = oggOpusProbe(trimmed.ogg);
  const wav = await oggOpusToWav(trimmed.ogg, { maxSeconds: 9999 });
  const decodedSamples = (wav.length - WAV_HEADER_BYTES) / (CH * 2);
  const overshoot = decodedSamples - p.granuleSamples;
  rec('G20. on an end-trimmed container the decoder emits AT LEAST the granule, and at most one frame more',
    overshoot >= 0 && overshoot <= FRAME && p.granuleSamples === decodedSamples - FRAME,
    `granule=${p.granuleSamples} decoded=${decodedSamples} overshoot=${overshoot} frame=${FRAME}`);
}

const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
console.log(`VERDICT: ${passed === ledger.length ? 'GO' : 'NO-GO'}`);
process.exit(passed === ledger.length ? 0 : 1);
