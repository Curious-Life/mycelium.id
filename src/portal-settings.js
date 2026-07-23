// Local secrets API — the self-hosted equivalent of the cloud product's
// /portal/settings/secret(s) (which lives in reference/ and was never ported).
// Stores into the encrypted secrets table (db.secrets → SYSTEM_KEY at rest).
// Single-user, localhost-only, behind the vault-init guard (no per-request auth).
// Wiring this also un-breaks the existing portal "Connect" buttons
// (ConnectionsChecklist / OnboardingGuide PUT /portal/settings/secret).

import express from 'express';
import { getModelState, startDownload, qwenVoiceCatalog, hasVoiceSample } from './tts/qwen3-tts-model.js';

// Qwen3-TTS (local, MLX) voice models — replaces Kokoro (removed). The two
// benchmarked variants (design §2.1); consent-by-choosing (§3.10c): NOTHING
// downloads until the user picks one and clicks Download. Qwen has ZERO preset
// speaker voices (design §2.5) — the actual voice is a frozen sample authored on
// the character page (design §5), a separate unit — so the picker offers VARIANTS
// (which model to install), not a voice list.
const QWEN_VARIANTS = qwenVoiceCatalog();

// TTS catalogs — mirror packages/channel-daemon/tts/voices.js (kept inline so
// src/ doesn't depend on the daemon package; ids must stay in sync).
const OPENAI_VOICES = [
  { id: 'alloy', label: 'Alloy', description: 'neutral, balanced' },
  { id: 'ash', label: 'Ash', description: 'warm, measured' },
  { id: 'coral', label: 'Coral', description: 'bright, friendly' },
  { id: 'echo', label: 'Echo', description: 'soft, calm' },
  { id: 'fable', label: 'Fable', description: 'expressive, storyteller' },
  { id: 'nova', label: 'Nova', description: 'energetic, clear' },
  { id: 'onyx', label: 'Onyx', description: 'deep, authoritative' },
  { id: 'sage', label: 'Sage', description: 'gentle, thoughtful' },
  { id: 'shimmer', label: 'Shimmer', description: 'light, airy' },
];
const OPENAI_MODELS = [
  { id: 'tts-1-hd', label: 'tts-1-hd', description: 'higher quality' },
  { id: 'tts-1', label: 'tts-1', description: 'lower latency' },
  { id: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts', description: 'newer, steerable' },
];
const ELEVENLABS_MODELS = [
  { id: 'eleven_turbo_v2_5', label: 'Turbo v2.5', description: 'fast, low latency' },
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5', description: 'fastest' },
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2', description: 'highest quality' },
];

export function portalSettingsRouter({ db, userId }) {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  // ── TTS settings (VoiceSection backend) ──────────────────────────────────
  // Stored in the encrypted secrets table under the same key names the TTS
  // module reads from env (OPENAI_API_KEY, TTS_PROVIDER, …) — the channel-daemon
  // hydrates them into its own env via /api/v1/internal/channel-config.
  const getS = (k) => db.secrets.get(userId, k);
  const hasS = (k) => db.secrets.has(userId, k);
  const setS = (k, v) => db.secrets.set(userId, { key: k, value: v, scope: 'personal', description: 'channel/tts setting' });
  const delS = (k) => db.secrets.delete(userId, k);

  router.get('/settings/tts', async (_req, res) => {
    try {
      const provider = await getS('TTS_PROVIDER');
      const openaiHasKey = await hasS('OPENAI_API_KEY');
      const elevenHasKey = await hasS('ELEVENLABS_API_KEY');
      const qwenEnabled = (await getS('QWEN_TTS_ENABLED')) === '1';
      const model = getModelState();
      // ⚠️ `enabled` is the TOP LINE ("TTS active") — it must mean "a voice message
      // will actually be delivered", not "a model is installed". For qwen, identity
      // needs a FROZEN reference sample from the per-agent character page (design
      // §2.2/§5, not built yet): without one every render 501s, so reporting
      // "active" would promise audio that never arrives. `samplePending` is the
      // honest state the UI renders instead.
      // Honest signal: hasVoiceSample now decrypt-validates (a corrupt/re-keyed
      // sample reads pending, never "active" over a 501 render). Async.
      const qwenSamplePending = !(await hasVoiceSample());
      // CHANNEL voice for qwen is NO LONGER deferred: the confined daemon does not
      // touch the encrypted sample — it POSTs the line to the vault's loopback
      // /api/v1/internal/voice-render, which decrypts in-memory and renders on the
      // MLX service it owns (src/internal-router.js, packages/channel-daemon/tts/
      // providers/qwen.js). The remaining honest gates are the ones below: the model
      // must be installed AND a frozen sample must exist, or every render 501s.
      // (Kept as a named constant so the honesty coupling stays greppable.)
      const QWEN_CHANNEL_DEFERRED = false;
      res.json({
        enabled: !!(provider && (
          (provider === 'openai' && openaiHasKey) ||
          (provider === 'elevenlabs' && elevenHasKey) ||
          (provider === 'qwen' && qwenEnabled && model.phase === 'ready' && !qwenSamplePending && !QWEN_CHANNEL_DEFERRED)
        )),
        provider: provider || null,
        // Channel voice-reply policy: 'always' (default — voice on means replies are
        // spoken) | 'auto' (only when the inbound was a voice note) | 'off'.
        voiceReplies: (await getS('CHANNEL_VOICE_REPLIES')) || 'always',
        qwen: { enabled: qwenEnabled, samplePending: qwenSamplePending, channelDeferred: QWEN_CHANNEL_DEFERRED, variant: (await getS('QWEN_TTS_VARIANT')) || model.variant, variants: QWEN_VARIANTS, model },
        openai: { hasKey: openaiHasKey, voice: (await getS('OPENAI_TTS_VOICE')) || 'onyx', model: (await getS('OPENAI_TTS_MODEL')) || 'tts-1-hd', voices: OPENAI_VOICES, models: OPENAI_MODELS },
        elevenlabs: { hasKey: elevenHasKey, voiceId: (await getS('ELEVENLABS_VOICE_ID')) || null, model: (await getS('ELEVENLABS_MODEL_ID')) || 'eleven_turbo_v2_5', models: ELEVENLABS_MODELS },
      });
    } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  router.put('/settings/tts', async (req, res) => {
    try {
      const { provider, openai, elevenlabs, qwen, voiceReplies } = req.body || {};
      if (voiceReplies !== undefined) {
        const v = String(voiceReplies || '').trim().toLowerCase();
        if (v && !['always', 'auto', 'off'].includes(v)) return res.status(400).json({ error: 'invalid voiceReplies' });
        if (v && v !== 'always') await setS('CHANNEL_VOICE_REPLIES', v); else await delS('CHANNEL_VOICE_REPLIES');
      }
      if (provider !== undefined) {
        if (provider && !['openai', 'elevenlabs', 'qwen'].includes(provider)) return res.status(400).json({ error: 'invalid provider' });
        if (provider) await setS('TTS_PROVIDER', provider); else await delS('TTS_PROVIDER');
        // selecting the local provider is the per-box opt-in the qwen provider checks
        if (provider === 'qwen') await setS('QWEN_TTS_ENABLED', '1');
        // …and switching AWAY clears it, or the :8094 MLX service keeps running for
        // a provider the user no longer uses (adversarial review of #209, LOW-2).
        // The supervisor's shouldRun reads this flag, so clearing it stops the child.
        else await delS('QWEN_TTS_ENABLED');
      }
      if (qwen && typeof qwen === 'object') {
        // `variant` = which Qwen3-TTS model to run. Selecting it is CONSENT to that
        // variant, but does NOT download it — the user must click Download (§3.10c).
        if (qwen.variant) await setS('QWEN_TTS_VARIANT', String(qwen.variant));
        if (qwen.enabled === true) await setS('QWEN_TTS_ENABLED', '1');
        else if (qwen.enabled === false) await delS('QWEN_TTS_ENABLED');
      }
      if (openai && typeof openai === 'object') {
        if (openai.apiKey) await setS('OPENAI_API_KEY', String(openai.apiKey));
        if (openai.voice) await setS('OPENAI_TTS_VOICE', String(openai.voice));
        if (openai.model) await setS('OPENAI_TTS_MODEL', String(openai.model));
      }
      if (elevenlabs && typeof elevenlabs === 'object') {
        if (elevenlabs.apiKey) await setS('ELEVENLABS_API_KEY', String(elevenlabs.apiKey));
        if (elevenlabs.voiceId) await setS('ELEVENLABS_VOICE_ID', String(elevenlabs.voiceId));
        if (elevenlabs.model) await setS('ELEVENLABS_MODEL_ID', String(elevenlabs.model));
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  // ── Qwen3-TTS local model: download trigger + status (the UI button) ──────
  // Triggers pip-install mlx-audio + the multi-GB MLX model snapshot in the
  // background; the UI polls GET .../model for progress. The chosen variant
  // comes from the saved QWEN_TTS_VARIANT (or the request body); NOTHING fetches
  // until this route is hit (consent-by-choosing, §3.10c). Fail-soft: a failed
  // provision surfaces in model.error, never throws here.
  router.post('/settings/tts/qwen/download', async (req, res) => {
    try {
      const variant = (req.body && req.body.variant) || (await getS('QWEN_TTS_VARIANT')) || undefined;
      res.json(await startDownload(variant ? { variant } : {}));
    } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });
  router.get('/settings/tts/qwen/model', (_req, res) => {
    try { res.json(getModelState()); }
    catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  // Preview runs in the daemon (needs the provider key in-process), not here.
  // Degrade clearly rather than half-synthesize in the vault process.
  router.post('/settings/tts/preview', (_req, res) => {
    res.status(501).json({ error: 'Preview runs in the channel-daemon — save, then send yourself a voice message (or run npm run smoke:telegram-live --voice).' });
  });

  // Metadata only — never values.
  router.get('/settings/secrets', async (_req, res) => {
    try {
      res.json({ secrets: await db.secrets.list(userId) });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
    }
  });

  router.put('/settings/secret', async (req, res) => {
    try {
      const { key, value, scope, description } = req.body || {};
      if (!key || typeof value !== 'string' || value.length === 0) {
        return res.status(400).json({ error: 'key and value required' });
      }
      await db.secrets.set(userId, { key, value, scope: scope || 'personal', description: description || null });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
    }
  });

  router.delete('/settings/secret', async (req, res) => {
    try {
      const { key } = req.body || {};
      if (!key) return res.status(400).json({ error: 'key required' });
      const r = await db.secrets.delete(userId, key);
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
    }
  });

  return router;
}
