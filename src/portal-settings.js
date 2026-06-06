// Local secrets API — the self-hosted equivalent of the cloud product's
// /portal/settings/secret(s) (which lives in reference/ and was never ported).
// Stores into the encrypted secrets table (db.secrets → SYSTEM_KEY at rest).
// Single-user, localhost-only, behind the vault-init guard (no per-request auth).
// Wiring this also un-breaks the existing portal "Connect" buttons
// (ConnectionsChecklist / OnboardingGuide PUT /portal/settings/secret).

import express from 'express';

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
      res.json({
        enabled: !!(provider && ((provider === 'openai' && openaiHasKey) || (provider === 'elevenlabs' && elevenHasKey))),
        provider: provider || null,
        openai: { hasKey: openaiHasKey, voice: (await getS('OPENAI_TTS_VOICE')) || 'onyx', model: (await getS('OPENAI_TTS_MODEL')) || 'tts-1-hd', voices: OPENAI_VOICES, models: OPENAI_MODELS },
        elevenlabs: { hasKey: elevenHasKey, voiceId: (await getS('ELEVENLABS_VOICE_ID')) || null, model: (await getS('ELEVENLABS_MODEL_ID')) || 'eleven_turbo_v2_5', models: ELEVENLABS_MODELS },
      });
    } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  router.put('/settings/tts', async (req, res) => {
    try {
      const { provider, openai, elevenlabs } = req.body || {};
      if (provider !== undefined) {
        if (provider && !['openai', 'elevenlabs'].includes(provider)) return res.status(400).json({ error: 'invalid provider' });
        if (provider) await setS('TTS_PROVIDER', provider); else await delS('TTS_PROVIDER');
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

  // Preview runs in the daemon (needs the provider key in-process + ffmpeg), not
  // here. Degrade clearly rather than half-synthesize in the vault process.
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
