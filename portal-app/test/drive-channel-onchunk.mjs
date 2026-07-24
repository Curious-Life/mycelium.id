// Drives the REAL src/lib/secure-channel.ts stream dispatch with an onChunk callback that THROWS,
// and reports whether the pending request SETTLES or hangs — the second defence layer of D-020.
//
// WHY THIS EXISTS SEPARATELY FROM mount-chat-error.mjs. The two layers of the D-020 fix are
// independent, so they need independent evidence. Layer 1 is ChatFloat's error case (proved by
// mounting the component). Layer 2 is this transport: a consumer callback that throws used to
// escape into the WebSocket frame handler, where secure-channel.ts:132-138's try/catch swallowed
// it — the pending request was never settled, the caller's promise hung forever, and its own
// try/catch never ran. With layer 1 fixed, ChatFloat's onChunk no longer throws, so a mount test
// can never exercise layer 2. Only a directly-throwing onChunk does.
//
// The channel here is REAL (no crypto, no socket — sendFrame() no-ops without one,
// secure-channel.ts:309, so requestStream registers its pending entry exactly as in production).
// Frames are delivered to handlePayload, the real dispatch method that contains the fix, wrapped
// in the same swallow the real onmessage applies (secure-channel.ts:132-138) so an escaping throw
// reproduces the product's actual outcome: a silent, unsettled request.
//
// Run: node --conditions browser portal-app/test/drive-channel-onchunk.mjs   (cwd = portal-app)
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GEN = '.gen-drive-channel';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (k in globalThis) continue;
  try { globalThis[k] = dom.window[k]; } catch { /* getter-only global */ }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const emit = (o) => console.log(JSON.stringify(o));
mkdirSync(GEN, { recursive: true });

await build({
  entryPoints: ['src/lib/secure-channel.ts'],
  outfile: `${GEN}/secure-channel.js`,
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  define: { 'import.meta.env.VITE_VPS_NOISE_PUB': JSON.stringify('11'.repeat(32)) },
  logLevel: 'silent',
});

try {
  const { SecureChannel } = await import(pathToFileURL(resolve(GEN, 'secure-channel.js')).href);
  const channel = new SecureChannel();
  channel.state = 'ready';   // ensureReady() short-circuits; no socket, no handshake

  const THROWN = 'consumer callback blew up';
  let chunksSeen = 0;
  let settled = null;           // 'resolved' | 'rejected' | null (= HUNG, the defect)
  let rejectedWith = null;

  const p = channel.requestStream('chat', { message: 'x' }, () => {
    chunksSeen += 1;
    throw new Error(THROWN);    // exactly what ChatFloat's pre-fix `case 'error'` did
  }).then(() => { settled = 'resolved'; }, (e) => { settled = 'rejected'; rejectedWith = String(e?.message || e); });

  // The pending entry the transport registered for this stream. requestStream awaits
  // ensureReady() first, so the entry lands a microtask later — yield until it exists.
  let id = null;
  for (let i = 0; i < 100 && !id; i++) {
    await new Promise((r) => setTimeout(r, 5));
    id = [...channel.pending.keys()][0] ?? null;
  }
  if (!id) throw new Error('requestStream never registered a pending entry');

  // Deliver the chunk exactly as the real onmessage does — including its swallow.
  const escapedFrameErrors = [];
  try { channel.handlePayload({ type: 'stream-chunk', id, data: { type: 'error', message: 'boom' } }); }
  catch (e) { escapedFrameErrors.push(String(e?.message || e)); }

  // Give the promise a chance to settle. A HUNG request never will — the real one waits out a
  // five-minute stream timeout (secure-channel.ts:201-204) with the user staring at a spinner.
  await Promise.race([p, new Promise((r) => setTimeout(r, 300))]);

  emit({
    ok: true,
    chunksSeen,
    // ⭐ THE PROOF: null here is the hang the user saw as a permanently empty bubble.
    settled,
    rejectedWith,
    // The transport must not leak the entry or its 5-minute timer after settling it.
    pendingAfter: channel.pending.size,
    // A throw that escaped handlePayload = the frame handler swallowed it = the request is stuck.
    escapedFrameErrors,
  });
  process.exit(0);
} catch (e) {
  emit({ ok: false, error: String(e?.stack || e) });
  process.exit(0);
}
