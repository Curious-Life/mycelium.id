/**
 * Vault-side voice render — clone the agent's FROZEN sample to speak new text
 * (design §2.3/§2.4). This is what powers the character-page audition ("▶ hear").
 *
 * Why vault-side (not the channel daemon): the sample is encrypted with the
 * vault master key, and the vault is the process that HAS that key and that owns
 * the local MLX render service (src/tts/qwen3-tts-supervisor.js → :8094). So the
 * vault decrypts the sample in-memory and POSTs it to the loopback service. The
 * channel daemon is confined WITHOUT the key, so making Telegram/Discord speak in
 * the cloned voice is a separate cross-process unit (deferred — see the build plan).
 *
 * ── SECURITY (§5.5) ─────────────────────────────────────────────────────────
 *  - OWNER-ONLY: the only caller is the owner-gated audition endpoint. Untrusted
 *    channel input must NEVER reach a voice parameter — there is no path here from
 *    an untrusted turn.
 *  - ZERO EGRESS: the render URL is asserted loopback (a literal loopback IP) as a
 *    PROPERTY, never a host table (channel-provider-locality lesson). A non-loopback
 *    override is refused before any network call — the sample never leaves the box.
 *  - The decrypted sample lives only in memory for the duration of the call.
 */
import { createVoiceSampleStore } from './voice-sample-store.js';

const RENDER_TIMEOUT_MS = 120_000; // RTF ~1.25 on a base M1; a short line is well under this.

// ── Diagnostics (D-003 ↻2) ───────────────────────────────────────────────────
// This seam used to collapse EVERY upstream failure to `render-upstream-<status>`,
// which is why three QA cycles could not tell "MLX is not installed on this box"
// (terminal, has a remedy) apart from "the model failed to load" (retryable) apart
// from "k.generate() threw" (the actual residual). The real reason now rides out —
// as an ALLOWLISTED token, never as raw upstream text.
//
// ALLOWLIST, not passthrough: the token the caller/UI sees is one of these or the
// generic `render-upstream-<status>`. An upstream that invents a new string can
// never become the error code, so no upstream text is ever interpreted as a state.
const UPSTREAM_REASONS = new Set([
  'voice-sample-pending',    // 501 — no frozen sample to clone
  'voice-runtime-missing',   // 503 — mlx_audio not importable here (TERMINAL: needs Apple Silicon)
  'model-unavailable',       // 503 — the model failed to load (retryable)
  'synth-failed',            // 500 — k.generate() threw
  'bad-ref-audio',           // 422 — the stored sample will not decode
  'bad-length',              // 413 — body over the service cap
  'bad-json',                // 400
  'empty-text',              // 400
  'not-found',               // 404 — wrong path (a wiring fault, not a voice fault)
]);

// Is this failure worth retrying, or does it need the OWNER to do something?
// Drives the honest UI: a retryable failure may say "try again"; a terminal one
// must NOT — that is the "starting… try again shortly" forever bug.
const TERMINAL_REASONS = new Set(['voice-runtime-missing', 'voice-sample-pending', 'bad-ref-audio', 'non-loopback-render-url']);

/**
 * Scrub an upstream detail string before it can reach a log or an HTTP body (§1).
 *
 * A python exception is UNTRUSTED text: `k.generate()` could embed the line being
 * spoken (vault plaintext) or a filesystem path (which names the user). So quoted
 * spans, path-like spans and long opaque blobs are redacted, the charset is
 * restricted, and the result is hard-capped. What survives is the diagnostic shape
 * — `RuntimeError: shape mismatch (1, 24000)` — which is what a smoke actually needs.
 *
 * ⚠️ RESIDUAL, stated rather than papered over: UNQUOTED prose cannot be told apart
 * from a diagnostic message, so an exception that interpolates text with no quotes
 * and no path would survive. This is bounded by WHERE `detail` can surface: only the
 * owner-authenticated character-page audition response carries it
 * (src/portal-character.js). The cross-process seam deliberately does NOT forward it
 * — src/internal-router.js returns `{ok:false, error}` only — so it never reaches the
 * confined channel daemon, a channel message, or a log. Keep it that way: forwarding
 * `detail` to any non-owner surface reopens this.
 */
export function sanitizeRenderDetail(raw) {
  // NB the ORDER is load-bearing, and every step here closes a bypass found in
  // adversarial review. Do not reorder without re-reading verify:voice-readiness R5*.
  let s = String(raw ?? '');
  // 1. Fold unicode lookalikes onto their ASCII forms FIRST. `∕Users∕martin∕…`
  //    (U+2215) used to sail past the path rule and then have its separators turned
  //    into spaces by the charset filter — leaving the username in plain sight.
  s = s.replace(/[∕⁄／⧸]/g, '/');
  s = s.replace(/[‘’‛ʼ´`]/g, "'").replace(/[“”‟«»]/g, '"');
  // 2. Redact quoted spans BEFORE truncating. Truncating first could cut a closing
  //    quote and un-pair the span, spilling its contents.
  s = s.replace(/(['"])(?:(?!\1)[\s\S]){0,400}\1/g, '<redacted>');
  // 3. An UNPAIRED quote means an unterminated span — drop from it to the end rather
  //    than trusting whatever follows (this is where a `ValueError: got "<the line>`
  //    used to survive verbatim).
  const stray = s.search(/['"]/);
  if (stray !== -1) s = `${s.slice(0, stray)}<redacted>`;
  // 4. Paths name the user. Accept windows separators too.
  s = s.replace(/(?:[A-Za-z]:)?(?:~|\.{0,2}[/\\])[\w.\- ]*(?:[/\\][\w.\- ]*)+/g, '<path>');
  s = s.replace(/[A-Za-z0-9+/=_-]{40,}/g, '<blob>');              // base64/hex runs
  s = s.replace(/[^A-Za-z0-9 _.,:;()[\]<>=+*/#-]/g, ' ');         // restrict the charset
  s = s.replace(/\s+/g, ' ').trim();
  // 5. Hard cap LAST, so nothing above can be defeated by feeding a long prefix.
  return s.slice(0, 120);
}

/**
 * Split an upstream `"<token>: <detail>"` error into an allowlisted reason plus a
 * sanitized detail. Anything unrecognised falls back to the generic status token —
 * fail-closed on the vocabulary, never on the diagnostics.
 */
export function classifyUpstreamError(body, status) {
  const raw = typeof body?.error === 'string' ? body.error : '';
  const idx = raw.indexOf(':');
  const token = (idx === -1 ? raw : raw.slice(0, idx)).trim();
  const detail = sanitizeRenderDetail(idx === -1 ? '' : raw.slice(idx + 1));
  const error = UPSTREAM_REASONS.has(token) ? token : `render-upstream-${status}`;
  return { error, ...(detail ? { detail } : {}), terminal: TERMINAL_REASONS.has(error) };
}

function loopbackBaseUrl() {
  return process.env.MYCELIUM_QWEN_TTS_URL || `http://127.0.0.1:${Number(process.env.MYCELIUM_QWEN_TTS_PORT) || 8094}`;
}

// Assert the PROPERTY (a literal loopback IP), never a hostname table. 'localhost'
// is deliberately NOT accepted — it requires resolution and can be rebound.
function isLoopbackUrl(url) {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h === '127.0.0.1' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
  } catch { return false; }
}

export function createVoiceRenderer(opts = {}) {
  const store = opts.store || createVoiceSampleStore(opts);
  const fetchImpl = opts.fetch || globalThis.fetch;

  /**
   * @param {object} a
   * @param {string} [a.agentId]
   * @param {string} a.text     the line to speak (owner-supplied, on the character page)
   * @param {string} [a.instruct] optional modulation (design §2.4; §7 Q3 vocabulary OPEN — free-form, owner-only)
   * @returns {Promise<{ok:true,audio:Buffer,format:'wav'}|{ok:false,status:number,error:string}>}
   */
  async function renderWithSample({ agentId = 'personal-agent', text, instruct } = {}) {
    const line = String(text || '').trim();
    if (!line) return { ok: false, status: 400, error: 'empty-text' };

    // The honest seam: no frozen sample ⇒ no identity to clone ⇒ 501, before any
    // network attempt. This is what hasVoiceSample() guards at the UI layer.
    const sample = await store.getSample(agentId);
    if (!sample) return { ok: false, status: 501, error: 'voice-sample-pending', terminal: true };

    const url = loopbackBaseUrl();
    if (!isLoopbackUrl(url)) return { ok: false, status: 500, error: 'non-loopback-render-url', terminal: true };

    const body = { text: line, ref_audio_b64: sample.wav.toString('base64'), ref_text: sample.sampleText };
    if (instruct && String(instruct).trim()) body.instruct = String(instruct).trim();

    let resp;
    try {
      resp = await fetchImpl(`${url}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
      });
    } catch {
      // The MLX service isn't up (no runtime, not Apple Silicon, or still loading).
      return { ok: false, status: 503, error: 'render-service-unreachable' };
    }
    if (!resp.ok) {
      // Surface the service's OWN reason — allowlisted token + sanitized detail
      // (§1: never the raw body). Collapsing this to `render-upstream-<status>` is
      // what hid the residual MLX failure across three QA cycles (D-003 ↻2).
      let body = null;
      try { body = await resp.json(); } catch { /* no/!JSON body — the token falls back to the status */ }
      return { ok: false, status: resp.status, ...classifyUpstreamError(body, resp.status) };
    }
    const audio = Buffer.from(await resp.arrayBuffer());
    return { ok: true, audio, format: 'wav' };
  }

  return { renderWithSample };
}

export { isLoopbackUrl };
