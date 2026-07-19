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
    if (!sample) return { ok: false, status: 501, error: 'voice-sample-pending' };

    const url = loopbackBaseUrl();
    if (!isLoopbackUrl(url)) return { ok: false, status: 500, error: 'non-loopback-render-url' };

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
      // Surface the service's own honest states (501 pending / 503 model-unavailable)
      // without echoing any body (§1).
      return { ok: false, status: resp.status, error: `render-upstream-${resp.status}` };
    }
    const audio = Buffer.from(await resp.arrayBuffer());
    return { ok: true, audio, format: 'wav' };
  }

  return { renderWithSample };
}

export { isLoopbackUrl };
