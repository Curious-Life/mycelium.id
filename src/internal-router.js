// Internal router — loopback-only support endpoints for the channel-daemon
// (packages/channel-daemon). NOT part of the MCP tool surface: these are the
// two vault operations the egress chokepoint needs but that aren't tools —
// recording an egress-audit row and resolving channel authority.
//
// Security posture (V1): mounted under the same no-auth localhost REST surface
// as /api/v1/captureMessage (same-machine trust boundary). If the REST surface
// is ever exposed to a network, these MUST move behind the OAuth-HTTP gate with
// the rest of /api/v1 — they read/write vault tables.
//
// The egress-audit endpoint accepts ONLY a content HASH + length, never the
// message body (CLAUDE.md §1) — the daemon hashes before it calls.
import express from 'express';
import { createEgressAuditSink } from './inference/egress.js';
import { getBlob as realGetBlob } from './ingest/blob-store.js';
import { describeImage as realDescribeImage } from './enrich/describe-image.js';
import { transcribeAudio as realTranscribeAudio } from './enrich/transcribe-audio.js';

/** Parse the decrypted `{ "apiKey": "…" }` credentials envelope → key string|null. */
function parseProviderApiKey(credentials) {
  if (typeof credentials !== 'string' || !credentials) return null;
  try { const o = JSON.parse(credentials); return (typeof o?.apiKey === 'string' && o.apiKey) ? o.apiKey : null; }
  catch { return null; }
}

/**
 * Derive the channel-daemon agent backend from the user's SELECTED app provider
 * (the active `ai_providers` row), so the channel agent uses WHATEVER model the
 * user chose in Settings → AI — no separate channel-model config to keep in sync.
 *
 * Mirrors src/inference/resolve.js' mapRowToConfig classification:
 *   - Anthropic/Claude (api key, no base_url) → cloud (claude-agent-sdk)
 *   - native Ollama base_url (:11434)         → local (native /api/chat backend)
 *   - any other OpenAI-compatible base_url    → openai-compat (/v1/chat/completions)
 * Returns an overlay `{ agent?, routing? }` for the channel-config response, or
 * null when no usable active provider exists (→ daemon stays capture-only, honest).
 */
async function deriveAgentFromActiveProvider(db, userId) {
  try {
    const row = await db?.providers?.getActive?.(userId);
    if (!row) return null;
    const provider = String(row.provider || '').toLowerCase();
    const baseUrl = row.base_url || '';
    const model = row.model_preference || null;
    const key = parseProviderApiKey(row.credentials);

    // Native Anthropic (no base_url) → cloud Claude Agent SDK.
    if (key && !baseUrl && (provider === 'anthropic' || provider === 'claude')) {
      return { agent: { anthropicApiKey: key, model }, routing: { router: 'cloud' } };
    }
    // Native Ollama (default port) → the daemon's proven /api/chat backend.
    if (baseUrl.includes(':11434')) {
      const ollamaUrl = baseUrl.replace(/\/v\d+\/?$/, ''); // strip trailing /v1
      return { routing: { router: 'local', ollamaModel: model, ollamaUrl } };
    }
    // Any other OpenAI-compatible provider (Regolo/OpenRouter/self-hosted/…).
    if (baseUrl || (key && provider === 'openai')) {
      return { agent: { openai: { baseUrl: baseUrl || null, apiKey: key, model } }, routing: { router: 'openai' } };
    }
  } catch { /* fail-soft: no overlay → daemon falls back to manual config / capture-only */ }
  return null;
}

/**
 * @param {object} deps
 * @param {object} deps.db        wired vault db (needs db.egressAudit + db.identityChannels)
 * @param {string} deps.userId
 * @param {object} [deps.enrich]  test seam: { getBlob, describeImage, transcribeAudio }
 */
export function internalRouter({ db, userId, enrich = {} }) {
  const getBlob = enrich.getBlob || realGetBlob;
  const describeImage = enrich.describeImage || realDescribeImage;
  const transcribeAudio = enrich.transcribeAudio || realTranscribeAudio;
  const router = express.Router();
  // JSON parsing is scoped to the POST route ONLY — installing it router-wide
  // would parse (and reject malformed) bodies for every request that flows
  // through this router on its way to apiRouter, stealing apiRouter's JSON-error
  // envelope and leaking the SPA HTML fallback on bad input.
  const json = express.json({ limit: '256kb' });

  // POST /api/v1/internal/egress-audit — append one audit row. Fire-and-forget
  // on the daemon side; we still 200 fast and let the namespace swallow its own
  // write errors (it never throws — egress-audit.js).
  router.post('/api/v1/internal/egress-audit', json, async (req, res) => {
    const e = req.body || {};
    if (!e.contentHash || typeof e.contentLength !== 'number' || !e.channelId || !e.decision) {
      return res.status(400).json({ ok: false, error: 'contentHash, contentLength, channelId, decision required' });
    }
    // Defense in depth: reject anything that looks like a plaintext body slipped in.
    if ('content' in e || 'text' in e) {
      return res.status(400).json({ ok: false, error: 'audit must not carry plaintext content' });
    }
    if (!db?.egressAudit?.record) return res.status(503).json({ ok: false, error: 'egress-audit unavailable' });
    await db.egressAudit.record({ agentId: e.agentId || 'personal-agent', ...e });
    res.json({ ok: true });
  });

  // GET /api/v1/internal/channel-authority?kind=&id= — fail-closed deliverability.
  // A target is deliverable iff identity_channels has a non-revoked row for it
  // with delivery_enabled = 1 (opt-in). The daemon already short-circuits the
  // operator's own DM via owner-bootstrap, so this covers every other target.
  router.get('/api/v1/internal/channel-authority', async (req, res) => {
    const kind = String(req.query.kind || '');
    const id = String(req.query.id || '');
    if (!kind || !id) return res.status(400).json({ allowed: false, reason: 'kind-and-id-required' });
    if (!db?.identityChannels?.getByChannel) return res.status(503).json({ allowed: false, reason: 'authority-unavailable' });
    try {
      const row = await db.identityChannels.getByChannel(kind, id);
      if (!row) return res.json({ allowed: false, reason: 'not-bound' });
      if (row.revoked_at) return res.json({ allowed: false, reason: 'revoked' });
      if (row.delivery_enabled !== 1) return res.json({ allowed: false, reason: 'delivery-not-enabled' });
      return res.json({ allowed: true, reason: 'registry', ownerUserId: row.owner_user_id || null });
    } catch (err) {
      // Fail closed on any lookup error.
      console.error('[internal-router] channel-authority lookup failed:', err.message);
      return res.status(500).json({ allowed: false, reason: 'authority-error' });
    }
  });

  // ── Telegram group authorization (channel-daemon group binding) ───────────
  // GET ?id=<groupId> → { authorized, active, title, spaceId }
  router.get('/api/v1/internal/telegram-group', async (req, res) => {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ authorized: false, reason: 'id-required' });
    if (!db?.telegramGroups?.get) return res.status(503).json({ authorized: false, reason: 'unavailable' });
    try {
      const row = await db.telegramGroups.get(id);
      if (!row) return res.json({ authorized: false });
      return res.json({ authorized: true, active: row.active === 1, title: row.title || null, spaceId: row.space_id || null });
    } catch (err) {
      console.error('[internal-router] telegram-group get failed:', err.message);
      return res.status(500).json({ authorized: false, reason: 'error' });
    }
  });

  // POST { id, title } → authorize the group for this operator.
  router.post('/api/v1/internal/telegram-group', json, async (req, res) => {
    const { id, title } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    if (!db?.telegramGroups?.authorize) return res.status(503).json({ ok: false, error: 'unavailable' });
    try {
      await db.telegramGroups.authorize(String(id), title || null, null, userId);
      res.json({ ok: true });
    } catch (err) {
      console.error('[internal-router] telegram-group authorize failed:', err.message);
      res.status(500).json({ ok: false, error: 'authorize-failed' });
    }
  });

  // DELETE ?id= → soft-revoke (active=0).
  router.delete('/api/v1/internal/telegram-group', async (req, res) => {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    if (!db?.telegramGroups?.revoke) return res.status(503).json({ ok: false, error: 'unavailable' });
    try { await db.telegramGroups.revoke(id); res.json({ ok: true }); }
    catch (err) { console.error('[internal-router] telegram-group revoke failed:', err.message); res.status(500).json({ ok: false, error: 'revoke-failed' }); }
  });

  // GET list of authorized groups for the operator.
  router.get('/api/v1/internal/telegram-groups', async (_req, res) => {
    if (!db?.telegramGroups?.list) return res.status(503).json({ groups: [] });
    try {
      const rows = await db.telegramGroups.list(userId);
      res.json({ groups: rows.map((r) => ({ id: r.id, title: r.title || null })) });
    } catch (err) {
      console.error('[internal-router] telegram-groups list failed:', err.message);
      res.status(500).json({ groups: [] });
    }
  });

  // ── Per-channel access decision (loopback) ────────────────────────────────
  // Resolves WHO within an authorized channel the bot responds to. The allowlist
  // + owner id stay in the vault; the daemon sends only the inbound sender id and
  // gets a boolean. Owner (from secrets) is implicitly allowed in every mode.
  router.get('/api/v1/internal/channel-access', async (req, res) => {
    const kind = String(req.query.kind || '');
    const id = String(req.query.id || '');
    const sender = req.query.sender != null ? String(req.query.sender) : null;
    if (!kind || !id) return res.status(400).json({ respond: false, reason: 'kind-and-id-required' });
    if (!db?.channelAccess?.decide) return res.status(503).json({ respond: false, reason: 'unavailable' });
    try {
      const ownerKey = /^telegram/.test(kind) ? 'OWNER_TELEGRAM_ID' : /^discord/.test(kind) ? 'OWNER_DISCORD_ID' : null;
      const ownerId = ownerKey ? await db.secrets.get(userId, ownerKey) : null;
      const decision = await db.channelAccess.decide(kind, id, sender, ownerId);
      res.json(decision);
    } catch (err) {
      console.error('[internal-router] channel-access decide failed:', err.message);
      res.status(500).json({ respond: false, reason: 'access-error' }); // fail-closed
    }
  });

  // ── Inference-egress audit for the channel auto-router (loopback) ─────────
  // When the daemon routes a turn to cloud, it records the egress HASH-ONLY here.
  // Reuses the inference egress sink (db.audit.log, never plaintext). The daemon
  // hashes before calling — this endpoint rejects any plaintext body.
  const inferenceEgressSink = createEgressAuditSink(db, userId);
  router.post('/api/v1/internal/inference-egress', json, async (req, res) => {
    const e = req.body || {};
    if ('content' in e || 'prompt' in e) return res.status(400).json({ ok: false, error: 'must not carry plaintext' });
    if (!e.contentHash || typeof e.contentLength !== 'number' || !e.decision) {
      return res.status(400).json({ ok: false, error: 'contentHash, contentLength, decision required' });
    }
    if (!inferenceEgressSink) return res.status(503).json({ ok: false, error: 'audit unavailable' });
    inferenceEgressSink({
      provider: 'channel-auto-router', jurisdiction: e.jurisdiction || 'unknown',
      decision: e.decision, reason: e.reason || null,
      contentHash: e.contentHash, contentLength: e.contentLength,
    });
    res.json({ ok: true });
  });

  // ── Discord channel allowlist (identity_channels, kind 'discord') ─────────
  // Reuses the generic registry + the channel-authority resolver above. Authorize
  // = upsert + delivery_enabled on; disallow = delivery_enabled off.
  router.post('/api/v1/internal/discord-channel', json, async (req, res) => {
    const { id, name, on = true } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    if (!db?.identityChannels?.upsert) return res.status(503).json({ ok: false, error: 'unavailable' });
    try {
      await db.identityChannels.upsert({ channel_kind: 'discord', channel_value: String(id), display_name: name || null });
      await db.identityChannels.setFlag('discord', String(id), 'delivery_enabled', !!on);
      res.json({ ok: true });
    } catch (err) {
      console.error('[internal-router] discord-channel authorize failed:', err.message);
      res.status(500).json({ ok: false, error: 'authorize-failed' });
    }
  });

  router.get('/api/v1/internal/discord-channels', async (_req, res) => {
    if (!db?.identityChannels?.listByKind) return res.status(503).json({ channels: [] });
    try {
      const rows = await db.identityChannels.listByKind('discord');
      res.json({ channels: rows.map((r) => ({ id: r.channel_value, name: r.display_name || null })) });
    } catch (err) {
      console.error('[internal-router] discord-channels list failed:', err.message);
      res.status(500).json({ channels: [] });
    }
  });

  // ── Channel-daemon config (loopback) ──────────────────────────────────────
  // Returns the daemon's settings DECRYPTED over loopback so the keyless daemon
  // can use vault-managed config (Telegram token, owner, assistant key, TTS
  // keys) instead of duplicating them in its own env. This is the ONE place a
  // plaintext key crosses the loopback boundary — same same-machine trust model
  // as captureMessage; it must NEVER be exposed to a network (move behind
  // OAuth-HTTP + TLS if the REST surface ever leaves localhost).
  router.get('/api/v1/internal/channel-config', async (_req, res) => {
    if (!db?.secrets?.get) return res.status(503).json({ error: 'secrets unavailable' });
    try {
      const g = (k) => db.secrets.get(userId, k);
      // Manual channel backend secrets (Settings → Channels). These ALWAYS win.
      const anthropicApiKey = (await g('ANTHROPIC_API_KEY')) || null;
      const channelModel = (await g('CHANNEL_AGENT_MODEL')) || null;
      const channelRouter = (await g('CHANNEL_ROUTER')) || null;
      const ollamaModel = (await g('CHANNEL_OLLAMA_MODEL')) || null;
      const openaiBaseUrl = (await g('CHANNEL_OPENAI_BASE_URL')) || null;

      // If the operator pinned no channel-specific backend, follow whatever model
      // they selected in the app (the active ai_providers row). This makes the
      // Telegram/Discord agent track the in-app choice with zero duplicate config.
      const hasManualBackend = !!(anthropicApiKey || channelModel || channelRouter || ollamaModel || openaiBaseUrl);
      const derived = hasManualBackend ? null : await deriveAgentFromActiveProvider(db, userId);

      res.json({
        enabled: (await g('CHANNEL_ENABLED')) === '1',
        telegram: { botToken: (await g('TELEGRAM_BOT_TOKEN')) || null, ownerId: (await g('OWNER_TELEGRAM_ID')) || null },
        discord: { botToken: (await g('DISCORD_BOT_TOKEN')) || null, ownerId: (await g('OWNER_DISCORD_ID')) || null },
        agent: {
          anthropicApiKey: anthropicApiKey ?? derived?.agent?.anthropicApiKey ?? null,
          model: channelModel ?? derived?.agent?.model ?? null,
          openai: derived?.agent?.openai
            ? { baseUrl: derived.agent.openai.baseUrl || null, apiKey: derived.agent.openai.apiKey || null, model: derived.agent.openai.model || null }
            : (openaiBaseUrl ? { baseUrl: openaiBaseUrl, apiKey: (await g('CHANNEL_OPENAI_API_KEY')) || null, model: (await g('CHANNEL_OPENAI_MODEL')) || null } : null),
        },
        routing: {
          router: channelRouter ?? derived?.routing?.router ?? null,
          ollamaModel: ollamaModel ?? derived?.routing?.ollamaModel ?? null,
          ollamaUrl: (await g('OLLAMA_URL')) ?? derived?.routing?.ollamaUrl ?? null,
          coalesceMs: (await g('CHANNEL_COALESCE_MS')) || null,
          rateLimitMax: (await g('CHANNEL_RATELIMIT_MAX')) || null,
          rateLimitWindowMs: (await g('CHANNEL_RATELIMIT_WINDOW_MS')) || null,
          sensitivePatterns: (await g('CHANNEL_SENSITIVE_PATTERNS')) || null,
        },
        tts: {
          provider: (await g('TTS_PROVIDER')) || null,
          openaiApiKey: (await g('OPENAI_API_KEY')) || null,
          openaiVoice: (await g('OPENAI_TTS_VOICE')) || null,
          openaiModel: (await g('OPENAI_TTS_MODEL')) || null,
          elevenApiKey: (await g('ELEVENLABS_API_KEY')) || null,
          elevenVoiceId: (await g('ELEVENLABS_VOICE_ID')) || null,
          elevenModel: (await g('ELEVENLABS_MODEL_ID')) || null,
        },
      });
    } catch (err) {
      console.error('[internal-router] channel-config failed:', err.message);
      res.status(500).json({ error: 'channel-config-error' });
    }
  });

  // POST /api/v1/internal/attachment-context { attachmentId, kind? } —
  // derive searchable/turn-visible text from an ALREADY-STORED encrypted blob:
  //   image       → local vision caption  → attachments.description
  //   voice/audio → local transcription   → attachments.transcript
  //   text family → utf-8 decode + clamp  (nothing stored; content IS the text)
  // The channel daemon calls this right after POST /api/v1/upload, then folds
  // the returned contextText into the captured message content (the only field
  // that survives the coalescer). Accepts only an id — bytes never transit this
  // route; extraction is LOCAL ONLY (fail-soft null when no capable model).
  // Derived text lands in ENCRYPTED_FIELDS.attachments columns.
  const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|toml|csv))/i;
  const TEXT_EXT = /\.(txt|md|markdown|csv|json|xml|ya?ml|toml|log|ini|conf)$/i;
  const MAX_INLINE_TEXT = 6000; // chars of file text folded into the message
  router.post('/api/v1/internal/attachment-context', json, async (req, res) => {
    const attachmentId = String(req.body?.attachmentId || '');
    if (!attachmentId) return res.status(400).json({ ok: false, error: 'attachmentId required' });
    if (!db?.attachments?.getById) return res.status(503).json({ ok: false, error: 'attachments unavailable' });
    try {
      const row = await db.attachments.getById(attachmentId);
      // 404 on missing AND on cross-user rows alike — don't leak existence.
      if (!row || row.user_id !== userId) return res.status(404).json({ ok: false, error: 'not-found' });
      if (!row.local_path) return res.json({ ok: true, contextText: null, reason: 'no-local-blob' });

      const fileType = String(row.file_type || '');
      const fileName = String(row.file_name || '');
      const kind = String(req.body?.kind || '')
        || (fileType.startsWith('image/') ? 'image'
          : fileType.startsWith('audio/') ? 'audio'
          : (TEXT_MIME.test(fileType) || TEXT_EXT.test(fileName)) ? 'text'
          : 'file');

      const bytes = await getBlob(row.local_path);
      let contextText = null;

      if (kind === 'image') {
        contextText = await describeImage({ bytes });
        if (contextText) await db.attachments.update(attachmentId, { description: contextText });
      } else if (kind === 'audio' || kind === 'voice') {
        contextText = await transcribeAudio({ bytes, mimeType: fileType, fileName });
        if (contextText) await db.attachments.update(attachmentId, { transcript: contextText });
      } else if (kind === 'text') {
        const text = bytes.toString('utf8').replace(/\u0000/g, '').trim();
        contextText = text ? (text.length > MAX_INLINE_TEXT ? `${text.slice(0, MAX_INLINE_TEXT)}\n[… truncated]` : text) : null;
      }
      // 'file' (pdf/docx/binary): extraction lands in a later step — honest null.

      return res.json({ ok: true, contextText, kind });
    } catch (err) {
      // Fail soft for the daemon (it falls back to a placeholder) — but never
      // leak details; the blob may be missing or the key absent (locked vault).
      console.error('[internal-router] attachment-context failed:', err.message);
      return res.status(200).json({ ok: true, contextText: null, reason: 'extraction-error' });
    }
  });

  return router;
}
