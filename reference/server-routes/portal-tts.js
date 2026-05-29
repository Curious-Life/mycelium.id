/**
 * Portal TTS settings router.
 *
 * Three endpoints, all gated by portal session auth:
 *
 *   GET  /portal/settings/tts          — redacted state (never plaintext keys)
 *                                        + voice/model catalog for the UI
 *   PUT  /portal/settings/tts          — encrypt + put each provided field via
 *                                        putEncryptedSecret(), then refreshSecrets
 *                                        + audit log
 *   POST /portal/settings/tts/preview  — synthesize a sample phrase using SAVED
 *                                        config; returns base64 audio for inline
 *                                        playback. Rate-limited to prevent abuse
 *                                        of provider credits.
 *
 * Security posture:
 *   - GET responses NEVER contain plaintext key material (only `hasKey` flags
 *     and non-secret metadata like voice id, model id).
 *   - PUT writes through the canonical secrets pipeline (putEncryptedSecret →
 *     Worker ciphertext passthrough). The agent picks up new env via
 *     refreshSecrets({force:true}) within seconds — no restart.
 *   - Allowlisted keys only. Validation reuses the TTS module's existing
 *     allowlists (single source of truth) so no drift between bot-side and
 *     portal-side.
 *   - Audit log on save records the event + which fields were touched, never
 *     the values.
 *   - Preview rate limit is per-session (5/min) so a stolen session can't burn
 *     down the operator's TTS credits.
 *
 * Mirrors portal-integrations.js (Linear) line-for-line in shape — same factory,
 * same dep injection, same logging conventions.
 *
 * @typedef {object} CreatePortalTtsRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {(opts: {key:string, value:string, scope:string, agent:string, description?:string}) => Promise<void>} putEncryptedSecret
 * @property {object} config  — { LOG_PREFIX }
 * @property {object} [log]
 * @property {object} [tts]   — override for tests; defaults to @mycelium/core/tts
 */

import { Router } from 'express';

// ── Allowlists (mirrored from @mycelium/core/tts to fail fast on bad input) ──

const ALLOWED_PROVIDERS = new Set(['openai', 'elevenlabs', '']);

// API key shape regexes — fail-fast for obviously-bad pastes. Real validation
// happens when the key is actually used (provider returns 401 → TTSProviderError
// surfaced via Preview).
const OPENAI_API_KEY_RE     = /^sk-[A-Za-z0-9_\-]{16,256}$/;
const ELEVENLABS_API_KEY_RE = /^[A-Za-z0-9_\-]{16,256}$/;

// Voice/model id shape — same regex elevenlabs.js uses internally (path-safe).
const ID_RE = /^[A-Za-z0-9_\-]{1,128}$/;

const SAMPLE_PHRASE_DEFAULT = 'Voice check, one two three.';
const SAMPLE_PHRASE_MAX_LEN = 200;

// Per-session preview rate limit. In-memory only — survives until process
// restart, which is fine for an abuse mitigation (worst case after restart,
// session can spend 5 more in the next minute).
const PREVIEW_LIMIT       = 5;
const PREVIEW_WINDOW_MS   = 60_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function isString(v) { return typeof v === 'string'; }
function trimOrNull(v) { return isString(v) ? v.trim() : null; }
function presentString(v) { const t = trimOrNull(v); return t === null ? null : t.length === 0 ? '' : t; }

// Build a per-session bucket. Sessions identified by user.id when present;
// fall back to remote IP if no user id (shouldn't happen — auth runs first).
function makeRateLimiter() {
  const buckets = new Map();
  return function take(key) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now > b.r) { b = { c: 0, r: now + PREVIEW_WINDOW_MS }; buckets.set(key, b); }
    if (b.c >= PREVIEW_LIMIT) {
      const retryInSec = Math.max(1, Math.ceil((b.r - now) / 1000));
      return { allowed: false, retryInSec };
    }
    b.c++;
    return { allowed: true, retryInSec: 0 };
  };
}

// Lazy default so tests can override deps.tts without importing the real module.
async function defaultTts() {
  return import('@mycelium/core/tts/index.js');
}

// ── Router factory ───────────────────────────────────────────────────────────

export function createPortalTtsRouter(deps) {
  if (!deps) throw new TypeError('createPortalTtsRouter: deps required');
  const {
    authenticatePortalRequest,
    tryGetDb,
    putEncryptedSecret,
    config,
    log,
    tts: ttsOverride,
    refreshSecrets: refreshOverride,
  } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalTtsRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalTtsRouter: tryGetDb required');
  }
  if (typeof putEncryptedSecret !== 'function') {
    throw new TypeError('createPortalTtsRouter: putEncryptedSecret required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalTtsRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const router = Router();
  const takePreviewToken = makeRateLimiter();

  async function loadTts() {
    if (ttsOverride) return ttsOverride;
    return defaultTts();
  }

  async function loadRefresh() {
    if (refreshOverride) return refreshOverride;
    const mod = await import('@mycelium/core/bootstrap-secrets.js');
    return mod.refreshSecrets;
  }

  // ── GET /portal/settings/tts ───────────────────────────────────────────────

  router.get('/portal/settings/tts', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const tts = await loadTts();

      const payload = {
        enabled: tts.isEnabled(),
        provider: presentString(process.env.TTS_PROVIDER) || null,
        openai: {
          hasKey: Boolean(process.env.OPENAI_API_KEY),
          voice: process.env.OPENAI_TTS_VOICE || 'onyx',
          model: process.env.OPENAI_TTS_MODEL || 'tts-1-hd',
          voices: tts.OPENAI_VOICES,
          models: tts.OPENAI_MODELS,
        },
        elevenlabs: {
          hasKey: Boolean(process.env.ELEVENLABS_API_KEY),
          voiceId: process.env.ELEVENLABS_VOICE_ID || null,
          model: process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5',
          models: tts.ELEVENLABS_MODELS,
        },
      };
      res.json(payload);
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        `[${LOG_PREFIX}] TTS settings GET failed:`, e.message,
      );
      res.status(500).json({ error: 'Failed to load TTS settings' });
    }
  });

  // ── PUT /portal/settings/tts ───────────────────────────────────────────────
  //
  // Body shape (every field optional except validation; we only write what's
  // present):
  //
  //   {
  //     provider: 'openai' | 'elevenlabs' | '',
  //     openai:     { apiKey?, voice?, model? },
  //     elevenlabs: { apiKey?, voiceId?, model? },
  //   }

  router.put('/portal/settings/tts', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const tts = await loadTts();
      const body = req.body || {};

      // Collect (key, value, description) tuples to write atomically per field.
      // We validate everything BEFORE writing anything so a bad input doesn't
      // produce a half-saved state.
      const writes = [];
      const fieldsTouched = [];

      // ── provider ─────────────────────────────────────────────────────────
      if (body.provider !== undefined) {
        const provider = isString(body.provider) ? body.provider.trim() : '';
        if (!ALLOWED_PROVIDERS.has(provider)) {
          return res.status(400).json({ error: `Invalid provider; must be one of: openai, elevenlabs, ''` });
        }
        writes.push({
          key: 'TTS_PROVIDER', value: provider,
          description: 'TTS provider selection (set via portal Voice section)',
        });
        fieldsTouched.push('provider');
      }

      // ── openai.* ──────────────────────────────────────────────────────────
      const oai = body.openai || {};
      if (oai.apiKey !== undefined) {
        const v = trimOrNull(oai.apiKey);
        if (v === null || !OPENAI_API_KEY_RE.test(v)) {
          return res.status(400).json({ error: 'Invalid OpenAI API key format' });
        }
        writes.push({
          key: 'OPENAI_API_KEY', value: v,
          description: 'OpenAI API key (TTS, set via portal)',
        });
        fieldsTouched.push('openai.apiKey');
      }
      if (oai.voice !== undefined) {
        const v = trimOrNull(oai.voice) || '';
        if (!tts.OPENAI_VOICE_IDS.has(v)) {
          return res.status(400).json({ error: `Invalid OpenAI voice; must be one of: ${[...tts.OPENAI_VOICE_IDS].join(', ')}` });
        }
        writes.push({
          key: 'OPENAI_TTS_VOICE', value: v,
          description: 'OpenAI TTS voice (set via portal Voice section)',
        });
        fieldsTouched.push('openai.voice');
      }
      if (oai.model !== undefined) {
        const v = trimOrNull(oai.model) || '';
        if (!tts.OPENAI_MODEL_IDS.has(v)) {
          return res.status(400).json({ error: `Invalid OpenAI model; must be one of: ${[...tts.OPENAI_MODEL_IDS].join(', ')}` });
        }
        writes.push({
          key: 'OPENAI_TTS_MODEL', value: v,
          description: 'OpenAI TTS model (set via portal Voice section)',
        });
        fieldsTouched.push('openai.model');
      }

      // ── elevenlabs.* ─────────────────────────────────────────────────────
      const el = body.elevenlabs || {};
      if (el.apiKey !== undefined) {
        const v = trimOrNull(el.apiKey);
        if (v === null || !ELEVENLABS_API_KEY_RE.test(v)) {
          return res.status(400).json({ error: 'Invalid ElevenLabs API key format' });
        }
        writes.push({
          key: 'ELEVENLABS_API_KEY', value: v,
          description: 'ElevenLabs API key (TTS, set via portal)',
        });
        fieldsTouched.push('elevenlabs.apiKey');
      }
      if (el.voiceId !== undefined) {
        const v = trimOrNull(el.voiceId);
        if (v === null || !ID_RE.test(v)) {
          return res.status(400).json({ error: 'Invalid ElevenLabs voice ID (expected [A-Za-z0-9_-]{1,128})' });
        }
        writes.push({
          key: 'ELEVENLABS_VOICE_ID', value: v,
          description: 'ElevenLabs voice ID (set via portal Voice section)',
        });
        fieldsTouched.push('elevenlabs.voiceId');
      }
      if (el.model !== undefined) {
        const v = trimOrNull(el.model) || '';
        if (!tts.ELEVENLABS_MODEL_IDS.has(v)) {
          return res.status(400).json({ error: `Invalid ElevenLabs model; must be one of: ${[...tts.ELEVENLABS_MODEL_IDS].join(', ')}` });
        }
        writes.push({
          key: 'ELEVENLABS_MODEL_ID', value: v,
          description: 'ElevenLabs model (set via portal Voice section)',
        });
        fieldsTouched.push('elevenlabs.model');
      }

      if (writes.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      // Persist each write through the canonical pipeline. If any write
      // fails partway through, the writes that succeeded persist — same
      // behavior as portal-integrations.js (Linear writes both the key and
      // team id sequentially). This is acceptable because retrying with
      // identical payload converges to the right state.
      for (const w of writes) {
        await putEncryptedSecret({
          key: w.key,
          value: w.value,
          scope: 'personal',
          agent: 'personal-agent',
          description: w.description,
        });
      }

      // Refresh THIS process's env so the change is visible immediately
      // (mirrors portal-integrations.js Linear save).
      try {
        const refreshSecrets = await loadRefresh();
        if (typeof refreshSecrets === 'function') await refreshSecrets({ force: true });
      } catch (err) {
        (logger.warn ? logger.warn.bind(logger) : console.warn)(
          `[${LOG_PREFIX}] refreshSecrets failed (non-fatal): ${err.message}`,
        );
      }

      // Telegram bot runs in a separate PM2 process, so its process.env is
      // independent. Without this ping, the bot would only pick up the new
      // OPENAI_API_KEY on its own 5-min auto-refresh — meaning a user who
      // pastes a key in the UI and immediately sends a voice message gets
      // the OLD key. Best-effort loopback ping triggers the bot's own
      // refreshSecrets({force:true}) so the change propagates in seconds.
      // Failure is non-fatal: the secret is persisted, the bot still
      // refreshes within 5 min via its own cron.
      try {
        const botPort = process.env.TELEGRAM_BOT_PORT || 3003;
        await fetch(`http://127.0.0.1:${botPort}/refresh-secrets`, {
          method: 'POST',
          signal: AbortSignal.timeout(3_000),
        });
      } catch (err) {
        (logger.warn ? logger.warn.bind(logger) : console.warn)(
          `[${LOG_PREFIX}] bot refresh ping failed (non-fatal, will refresh in ≤5min): ${err.message}`,
        );
      }

      tryGetDb()?.audit.log({
        action: 'settings.tts.saved',
        userId: user.id,
        ip: req.ip,
        details: { fieldsTouched },
      }).catch(() => {});

      // Re-read state so the response reflects the post-write reality.
      res.json({
        ok: true,
        enabled: tts.isEnabled(),
        provider: presentString(process.env.TTS_PROVIDER) || null,
        fieldsTouched,
      });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        `[${LOG_PREFIX}] TTS settings PUT failed:`, e.message,
      );
      res.status(500).json({ error: 'Failed to save TTS settings' });
    }
  });

  // ── POST /portal/settings/tts/preview ──────────────────────────────────────
  //
  // Body: { phrase?: string, voice?: string }
  // Returns: { audio: <base64>, mime, durationSecs, voiceUsed, provider }
  //
  // Uses the SAVED provider config (process.env). The optional `voice` arg
  // lets the UI hear different voice options without saving — only the voice
  // id is overridable, not the API key (that requires save first). This is
  // intentional: keeping the API-key path single-purpose simplifies the
  // security story.

  router.post('/portal/settings/tts/preview', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const tts = await loadTts();
      if (!tts.isEnabled()) {
        return res.status(503).json({ error: 'TTS not configured — save provider + key first' });
      }

      const limit = takePreviewToken(`u:${user.id}`);
      if (!limit.allowed) {
        return res.status(429).json({
          error: 'Too many previews; please wait',
          retryInSec: limit.retryInSec,
        });
      }

      const { phrase: phraseRaw, voice: voiceRaw } = req.body || {};
      const phrase = isString(phraseRaw) && phraseRaw.trim().length > 0
        ? phraseRaw.trim().slice(0, SAMPLE_PHRASE_MAX_LEN)
        : SAMPLE_PHRASE_DEFAULT;

      // Validate voice override (if provided) against whichever provider is
      // currently active. Prevents preview from silently using the wrong
      // allowlist when provider was just changed.
      const provider = process.env.TTS_PROVIDER || '';
      let voiceOverride;
      if (voiceRaw !== undefined && voiceRaw !== null) {
        const v = isString(voiceRaw) ? voiceRaw.trim() : '';
        if (provider === 'openai' && !tts.OPENAI_VOICE_IDS.has(v)) {
          return res.status(400).json({ error: 'Invalid OpenAI voice for preview' });
        }
        if (provider === 'elevenlabs' && !ID_RE.test(v)) {
          return res.status(400).json({ error: 'Invalid ElevenLabs voice id for preview' });
        }
        voiceOverride = v;
      }

      const result = await tts.synthesizeForDiscord(phrase, {
        agentId: 'mya-telegram-bot',
        voice: voiceOverride,
      });

      res.json({
        ok: true,
        audio: result.buffer.toString('base64'),
        mime: 'audio/ogg',
        durationSecs: result.durationSecs,
        voiceUsed: result.voiceUsed,
        provider: result.provider,
      });
    } catch (e) {
      // TTSProviderError surfaces auth/rate-limit/etc. cleanly.
      if (e?.name === 'TTSProviderError' || e?.name === 'TTSError') {
        const code = e.code || 'tts_failed';
        const status = code === 'auth' ? 502
                     : code === 'rate_limited' ? 429
                     : code === 'invalid_input' ? 400
                     : 502;
        return res.status(status).json({
          error: e.message,
          code,
          provider: e.provider,
        });
      }
      (logger.error ? logger.error.bind(logger) : console.error)(
        `[${LOG_PREFIX}] TTS preview failed:`, e.message,
      );
      res.status(500).json({ error: 'Preview failed' });
    }
  });

  (logger.info ? logger.info.bind(logger) : console.log)(
    `[${LOG_PREFIX}] portal-tts-router mounted 3 handlers`,
  );

  return router;
}
