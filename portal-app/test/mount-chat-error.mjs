// Mounts the REAL ChatFloat.svelte — real Svelte compiler → real jsdom → the REAL
// src/lib/secure-channel.ts transport, driven with the EXACT SSE event sequence the server emits
// on a provider 401 (src/portal-chat.js:596-606: `{type:'error',message}` then `{type:'done'}`)
// — and prints one JSON line per PROBE for scripts/verify-chat-error-surface.mjs to assert on.
//
// WHY A MOUNT, NOT A REGEX (D-020, and the rule this whole test-suite is built on):
// the defect is a RENDER + CONTROL-FLOW bug. ChatFloat's `case 'error'` rendered the server's
// classified message ONLY when the turn had already produced text, and THREW otherwise — i.e. in
// the one case the branch exists for (a 401 produces no text at all). A source regex over
// ChatFloat.svelte passes with the render dead-coded, the component never mounted, or the error
// event never reaching the handler. Only MOUNTING the real component, driving a REAL send over the
// REAL transport, and reading the rendered bubble proves a user can SEE the error.
// [[render-must-be-mounted-not-grepped]].
//
// WHY THE SECURE-CHANNEL TRANSPORT AND NOT PLAIN HTTPS: the two transports diverge, and only one
// of them ever showed the operator's symptom. On plain HTTPS the throw unwinds the read loop and
// runSend's outer catch paints it — the user saw *an* error. On the secure channel the callback
// runs inside the WebSocket frame handler (secure-channel.ts:264), where an escaping throw is
// swallowed by the onmessage try/catch at secure-channel.ts:132-138, the pending request is never
// settled, runSend's own catch never runs, and the user gets a permanently EMPTY bubble with a
// stuck spinner. That is what the operator reported, so that is the path this harness drives.
//
// FIDELITY NOTE (read before trusting a green): the channel is driven at `handlePayload` — the real
// dispatch method containing the fix — not through a real Noise handshake + encrypted socket. The
// harness therefore replicates ONE thing the transport does around it: secure-channel.ts:132-138
// wraps the handlePayload call in try/catch and only console.errors, so a throw that escapes
// handlePayload is SWALLOWED and the request hangs. `escapedFrameErrors` below records those
// swallowed throws. Everything else — the pending map, the timeout, the onChunk try/catch, the
// resolve/reject — is the real product code.
//
// Run: node --conditions browser portal-app/test/mount-chat-error.mjs   (cwd = portal-app)
// `--conditions browser` is REQUIRED — without it Node resolves svelte's SERVER exports map and
// mount() throws lifecycle_function_unavailable (learned across mount-onbox-select / -invite-data).
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROBE = process.env.PROBE || 'emptyturn';
const GEN = '.gen-mount-chat-error';
const COMPONENT = 'src/lib/components/chat/ChatFloat.svelte';

// The message src/portal-chat.js:596-606 emits verbatim for an upstream 401/403. Not invented:
// `${who} rejected the request — the API key looks invalid. Update it in Settings → Intelligence.`
const ERR_401 = 'Claude subscription rejected the request — the API key looks invalid. Update it in Settings → Intelligence.';
const PARTIAL = 'Here is the first half of an answer';

// The EXACT event sequence per probe. `emptyturn` is byte-for-byte what the server sends on a
// provider 401: an error with NO preceding text_delta, then the done frame. `midstream` is the
// path that always worked (text first, then an error) and must not regress.
const SCRIPTS = {
  emptyturn: [
    { type: 'stream_start' },
    { type: 'error', message: ERR_401 },
    { type: 'done', toolsUsed: [] },
  ],
  midstream: [
    { type: 'stream_start' },
    { type: 'text_delta', content: PARTIAL },
    { type: 'error', message: ERR_401 },
    { type: 'done', toolsUsed: [] },
  ],
};

// ── DOM globals before svelte/internal/client is imported ────────────────────────────────────
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (k in globalThis) continue;
  try { globalThis[k] = dom.window[k]; } catch { /* getter-only global — jsdom's is fine */ }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// jsdom has no layout; ChatFloat reads these during drag/resize effects.
if (!dom.window.matchMedia) dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

// Every network call is inert. ChatFloat's mount-time reads (providers, task-models, history) must
// not reach a socket; the CHAT turn under test is driven over the channel, never over fetch.
globalThis.fetch = async () => new dom.window.Response(JSON.stringify({ providers: [], messages: [], taskModels: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });

const emit = (o) => console.log(JSON.stringify(o));

mkdirSync(GEN, { recursive: true });

// ── Stubs. Kept to the MINIMUM: only $app/environment (SvelteKit-only) and the one rune module
// esbuild cannot compile ($lib/stores/onboarding-data.svelte.ts uses `$state`, and it is a pure
// import-completion signal — inert for a chat turn). Everything else — the chat store, the api
// module, the timeline helpers, vps-identity, AND secure-channel — is the REAL source. ──────────
writeFileSync(`${GEN}/app-environment.js`, 'export const browser = true;\nexport const dev = false;\nexport const building = false;\n');
writeFileSync(`${GEN}/onboarding-data-stub.js`, 'export function signalImportCompleted() {}\nexport const importSignal = { subscribe: (f) => { f(0); return () => {}; } };\n');

// ── Compile the REAL component, then bundle it together with a `getChannel` re-export so the
// harness and the component's own `await import('$lib/secure-channel')` share ONE module instance
// (esbuild inlines the dynamic import into this bundle). ────────────────────────────────────────
const compiled = compile(readFileSync(COMPONENT, 'utf8'), { generate: 'client', name: 'ChatFloat', css: 'injected' }).js.code;
writeFileSync(`${GEN}/ChatFloat.gen.js`, compiled);
writeFileSync(`${GEN}/entry.js`, `export { default as ChatFloat } from './ChatFloat.gen.js';\nexport { getChannel } from '$lib/secure-channel';\n`);

await build({
  entryPoints: [`${GEN}/entry.js`],
  outfile: `${GEN}/bundle.js`,
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  external: ['svelte', 'svelte/*'],
  alias: {
    '$lib/stores/onboarding-data.svelte': resolve(GEN, 'onboarding-data-stub.js'),
    '$app/environment': resolve(GEN, 'app-environment.js'),
    '$lib': resolve('src/lib'),
  },
  define: {
    // isSecureChannelConfigured() is REAL and reads this build-time value; a 64-hex key makes the
    // component take the SECURE-CHANNEL branch, which is the transport the defect lives on.
    'import.meta.env.VITE_VPS_NOISE_PUB': JSON.stringify('11'.repeat(32)),
    'import.meta.env.DEV': 'false',
    'import.meta.env.PROD': 'true',
  },
  logLevel: 'silent',
});

try {
  const mod = await import(pathToFileURL(resolve(GEN, 'bundle.js')).href);
  const { mount, flushSync } = await import('svelte');
  const D = dom.window.document;

  // The REAL SecureChannel singleton — the same instance ChatFloat's dynamic import will get.
  // Marked ready so ensureReady() returns immediately: connect() would open a real WebSocket, and
  // the Noise handshake is not what this gate is about. sendFrame() no-ops without a socket
  // (secure-channel.ts:309), so requestStream still registers its pending entry exactly as in
  // production — which is the machinery under test.
  const channel = mod.getChannel();
  channel.state = 'ready';

  mount(mod.ChatFloat, { target: D.getElementById('host'), props: { visible: true } });
  flushSync();
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  await tick(20);
  flushSync();

  // ── Drive a REAL send: type into the real textarea, click the real Send button. ──────────────
  const ta = D.querySelector('textarea.chat-input');
  if (!ta) throw new Error('no textarea.chat-input — the chat input did not render');
  ta.value = 'why is my key broken?';
  ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  flushSync();
  const sendBtn = D.querySelector('button[aria-label="Send message"]');
  if (!sendBtn) throw new Error('no Send button');
  if (sendBtn.disabled) throw new Error('Send button is disabled after typing — the input never bound');
  sendBtn.click();
  flushSync();

  // Wait for runSend to reach requestStream. Only a STREAM registers an onChunk, so this ignores
  // any plain request() the mount-time reads may have left pending on the same channel.
  let id = null;
  for (let i = 0; i < 200 && !id; i++) {
    await tick(5);
    for (const [k, v] of channel.pending) if (v.onChunk) { id = k; break; }
  }
  if (!id) throw new Error('runSend never called requestStream — the component did not take the secure-channel branch');

  // ── Feed the frames. Replicates secure-channel.ts:132-138: the real onmessage wraps this call
  // in try/catch and only console.errors, so a throw that escapes handlePayload is SWALLOWED and
  // the request is left unsettled. Recording them here is how the harness SEES that hang. ───────
  const escapedFrameErrors = [];
  const frame = (payload) => {
    try { channel.handlePayload(payload); }
    catch (e) { escapedFrameErrors.push(String(e?.message || e)); }
  };
  for (const ev of SCRIPTS[PROBE] || SCRIPTS.emptyturn) {
    frame({ type: 'stream-chunk', id, data: ev });
    await tick(2);
    flushSync();
  }
  frame({ type: 'stream-end', id });
  await tick(30);
  flushSync();
  await tick(30);
  flushSync();

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  // The same open-set hiding check the other mount harnesses use: jsdom does no layout, so this
  // proves "none of these mechanisms hides it", NOT human-visibility.
  const visible = (el) => {
    if (!el) return false;
    for (let n = el; n && n !== D.body.parentElement; n = n.parentElement) {
      const cs = dom.window.getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (n.hasAttribute('hidden') || n.getAttribute('aria-hidden') === 'true') return false;
      if (parseFloat(cs.opacity || '1') === 0) return false;
    }
    return true;
  };

  // The ASSISTANT bubble specifically — never "some text somewhere in the body".
  const items = [...D.querySelectorAll('.message-item')];
  const assistantItems = items.filter((el) => !el.classList.contains('user'));
  const bubble = assistantItems[assistantItems.length - 1] || null;
  const prose = bubble?.querySelector('.chat-prose') || null;

  emit({
    ok: true,
    probe: PROBE,
    // ⭐ THE PROOF: what a user reads in the assistant bubble, and whether it is still spinning.
    assistantText: norm(prose?.textContent),
    assistantVisible: visible(prose),
    // The fix renders through the IN-STREAM error handler, which emits the `*Error: …*` markdown
    // form (matching ChatView's copy). The outer transport-failure catch emits a PLAIN
    // `Error: …` string. The <em> is how the harness tells those two renderers apart.
    assistantEmText: norm(prose?.querySelector('em')?.textContent),
    // The per-message streaming indicator (msg.isStreaming) and the whole-turn "thinking" row.
    streamingIndicators: bubble ? bubble.querySelectorAll('.streaming-indicator').length : -1,
    streamingIndicatorsAll: D.querySelectorAll('.streaming-indicator').length,
    thinkingRow: /thinking\s*\.\.\./.test(norm(D.body.textContent)),
    assistantCount: assistantItems.length,
    userText: norm(items.find((el) => el.classList.contains('user'))?.textContent),
    // ⭐ Transport proof: an unsettled request is the hang. 0 = the turn finished.
    pendingAfter: channel.pending.size,
    escapedFrameErrors,
    bodyText: norm(D.body.textContent).slice(0, 1200),
  });
  process.exit(0);
} catch (e) {
  emit({ ok: false, probe: PROBE, error: String(e?.stack || e) });
  process.exit(0);
}
