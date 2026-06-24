// src/portal-providers.js — the /portal/providers* backend (BYOK AI-provider
// CRUD + connectivity test). The canonical SettingsView UI already calls these
// routes; the live V1 backend never mounted them. Wires src/db/providers.js
// (the `ai_providers` table). `credentials` is encrypted at rest by the db
// adapter (ENCRYPTED_FIELDS.ai_providers) and NEVER returned to the client.
//
// SECURITY:
//   - BYOK API key only. The legacy `auth_type:'oauth'` + `config_dir` path
//     (use a Claude *subscription* via a Claude Code OAuth token) is a deliberate
//     NON-feature: it became an Anthropic ToS violation (2026-02-19). The
//     /auth/{claude,openai} stubs report "not connected" so the UI degrades to
//     "paste an API key", and the claude OAuth POSTs fail closed.
//   - The key blob is written once on create/update and never echoed back. The
//     listing carries metadata only (providers.list() omits `credentials`); the
//     decrypt path is reached only for the connectivity probe + the inference
//     router (a later unit).
//   - The probe reports a category only — never the key, never the body.
import express from 'express';
import { execFileSync } from 'node:child_process';
import { probeProvider } from './inference/probe.js';
import { listModels } from './inference/models.js';
import { PROVIDER_PRESETS } from './inference/presets.js';
import { assertSafeBaseUrlResolved } from './inference/base-url.js';
import { INFERENCE_TASKS } from './inference/resolve.js';
import { resolveMcpBearer, readRemoteConfig } from './remote/config.js';

const ok = (res, body = {}) => res.json({ ok: true, ...body });
const bad = (res, code, error) => res.status(code).json({ ok: false, error });

// Best-effort Tailscale MagicDNS name of THIS machine (e.g. mymac.tailXXXX.ts.net),
// so the "Connect a phone" panel can show the exact https:// address. Shells out to
// the Tailscale CLI (PATH or the macOS app bundle); returns null on any failure
// (not installed / signed out / not on macOS). Read-only, no secrets, localhost-only.
function detectTailscaleDnsName() {
  const bins = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  for (const bin of bins) {
    try {
      const out = execFileSync(bin, ['status', '--json'], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      const name = JSON.parse(out.toString())?.Self?.DNSName;
      if (name) return String(name).replace(/\.$/, '');
    } catch { /* try next candidate */ }
  }
  return null;
}

// Shape a stored row → the metadata the UI consumes. NEVER includes credentials
// (providers.list() doesn't select it; this is the second, explicit guard).
const publicRow = (r) => ({
  id: r.id, provider: r.provider, label: r.label, auth_type: r.auth_type,
  model_preference: r.model_preference, base_url: r.base_url,
  is_active: r.is_active, status: r.status,
  last_used_at: r.last_used_at, created_at: r.created_at, updated_at: r.updated_at,
});

const KNOWN = new Set(['openai', 'anthropic', 'claude', 'custom']);

/**
 * @param {object} deps
 * @param {object} deps.db                 the assembled vault db (needs db.providers)
 * @param {string} [deps.userId='local-user']
 * @param {typeof fetch} [deps.fetch]      injectable for the connectivity probe (tests)
 */
export function portalProvidersRouter({ db, userId = 'local-user', fetch = globalThis.fetch } = {}) {
  if (!db?.providers) throw new Error('portalProvidersRouter: db.providers namespace required');
  const router = express.Router();

  // List configured providers — metadata only, never the key.
  router.get('/providers', async (_req, res) => {
    try { ok(res, { providers: (await db.providers.list(userId)).map(publicRow) }); }
    catch { bad(res, 500, 'failed to list providers'); }
  });

  // Runtime state — the UI shows which providers are usable. V1 has no live
  // per-agent health fan-out, so "usable" = configured + its last status.
  router.get('/providers/runtime-state', async (_req, res) => {
    try {
      const rows = await db.providers.list(userId);
      ok(res, { providers: rows.map((r) => ({ id: r.id, provider: r.provider, is_active: r.is_active, status: r.status })) });
    } catch { bad(res, 500, 'failed to read runtime state'); }
  });

  // Per-agent assignments — V1 is single-agent, so intentionally empty (the
  // multi-agent assignment reconciler is deferred; see the design doc).
  router.get('/providers/assignments', (_req, res) => ok(res, { assignments: [] }));

  // ── Per-TASK model selection (Settings → Intelligence) ──────────────────────
  // Which configured provider/model handles which task (chat vs narrate). Stored
  // in users.settings.taskModels[task] = { providerId, model? }. Unassigned tasks
  // fall back to the active provider (resolveInferenceConfigForTask). Metadata
  // only — no secrets cross this boundary.
  router.get('/providers/task-models', async (_req, res) => {
    try {
      const settings = (await db.users?.getSettings?.(userId)) || {};
      ok(res, { tasks: INFERENCE_TASKS, taskModels: settings.taskModels || {} });
    } catch { bad(res, 500, 'failed to read task models'); }
  });

  // Assign (or clear) a task's provider/model. Body: { task, providerId|null, model? }.
  router.put('/providers/task-models', async (req, res) => {
    try {
      const { task, providerId = null, model = null } = req.body || {};
      if (!INFERENCE_TASKS.includes(task)) return bad(res, 400, `unknown task (allowed: ${INFERENCE_TASKS.join(', ')})`);
      const settings = (await db.users?.getSettings?.(userId)) || {};
      const taskModels = { ...(settings.taskModels || {}) };
      if (providerId == null) {
        delete taskModels[task]; // clear → falls back to the active provider
      } else {
        const row = await db.providers.get(providerId, userId); // must be a configured provider of THIS user
        if (!row) return bad(res, 404, 'provider not found');
        taskModels[task] = { providerId, ...(model ? { model: String(model) } : {}) };
      }
      await db.users.updateSettings(userId, { ...settings, taskModels });
      ok(res, { taskModels });
    } catch { bad(res, 500, 'failed to set task model'); }
  });

  // The curated catalog of connectable providers — the "Intelligence" options the
  // UI offers (label, kind, base_url, jurisdiction, default model). Static data;
  // the UI prefills the add-provider form from a chosen preset. No secrets.
  router.get('/providers/presets', (_req, res) => ok(res, { presets: PROVIDER_PRESETS }));

  // Auto-fill the model dropdown (spec #9): given a provider config the user is
  // mid-entering — { provider, base_url?, api_key? } — fetch that provider's
  // available models so the UI can offer them instead of free-text. The key is
  // used for the listing call and never stored/echoed; base_url is SSRF-guarded;
  // errors are a category only. Always 200 with { ok, models, error } so the UI
  // degrades gracefully to free-text entry when listing isn't available.
  router.post('/providers/models', async (req, res) => {
    const b = req.body || {};
    const provider = String(b.provider || '').toLowerCase();
    const baseUrl = typeof b.base_url === 'string' ? b.base_url : '';
    if (baseUrl) {
      try { await assertSafeBaseUrlResolved(baseUrl); }
      catch (e) { return res.json({ ok: false, models: [], error: `invalid base_url: ${e.message}` }); }
    }
    const apiKey = typeof b.api_key === 'string' ? b.api_key.trim() : '';
    try {
      const r = await listModels({ provider, baseUrl, apiKey, fetch });
      res.json({ ok: r.ok, models: r.models || [], error: r.ok ? null : r.error });
    } catch { res.json({ ok: false, models: [], error: 'unreachable' }); }
  });

  // Same, for an ALREADY-SAVED provider (uses its stored key) — lets the UI offer
  // a model dropdown when editing a connected provider, without re-entering the key.
  router.get('/providers/:id/models', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return bad(res, 400, 'invalid id');
    try {
      const row = await db.providers.get(id, userId);
      if (!row) return bad(res, 404, 'provider not found');
      let apiKey = null;
      try { apiKey = row.credentials ? JSON.parse(row.credentials).apiKey : null; } catch { /* malformed → no key */ }
      const r = await listModels({ provider: row.provider, baseUrl: row.base_url, apiKey, fetch });
      res.json({ ok: r.ok, models: r.models || [], error: r.ok ? null : r.error });
    } catch { res.json({ ok: false, models: [], error: 'unreachable' }); }
  });

  // §4g "smart routing" (multi-provider cascade) preference — persisted in the
  // user settings blob; the gateway reads it DB-first (env MYCELIUM_INFER_CASCADE
  // is only the fallback when unset). A non-secret boolean, so plain settings.
  router.get('/providers/routing', async (_req, res) => {
    try {
      const s = await db.users.getSettings(userId);
      ok(res, { cascade: s?.inferCascade === true });
    } catch { bad(res, 500, 'failed to read routing preference'); }
  });
  router.put('/providers/routing', async (req, res) => {
    try {
      const cascade = req.body?.cascade === true;
      // A fresh single-user vault may have no `users` row yet; updateSettings is
      // an UPDATE (no-op without a row), so ensure one exists before persisting.
      try { await db.users.create(userId, userId); } catch { /* row already exists */ }
      const s = await db.users.getSettings(userId);
      await db.users.updateSettings(userId, { ...s, inferCascade: cascade });
      ok(res, { cascade });
    } catch { bad(res, 500, 'failed to update routing preference'); }
  });

  // Agent-message capture consent — the opt-in control for AUTO-capturing
  // connected-agent conversations (Claude Code, the gateway, opencode, …) into
  // the vault. DEFAULT OFF: these captures can contain secrets (keys, file
  // contents, command output), so the single capture choke-point
  // (src/ingest/capture.js) stores agent-source messages ONLY when `enabled` is
  // true here. `redactSecrets` scrubs obvious credentials before the row is
  // written. Non-secret booleans → plain user settings (like inferCascade).
  router.get('/agent-capture', async (_req, res) => {
    try {
      const ac = (await db.users.getSettings(userId))?.agentCapture || {};
      ok(res, { enabled: ac.enabled === true, redactSecrets: ac.redactSecrets === true });
    } catch { bad(res, 500, 'failed to read capture preference'); }
  });
  router.put('/agent-capture', async (req, res) => {
    try {
      const enabled = req.body?.enabled === true;
      const redactSecrets = req.body?.redactSecrets === true;
      try { await db.users.create(userId, userId); } catch { /* row already exists */ }
      const s = await db.users.getSettings(userId);
      await db.users.updateSettings(userId, { ...s, agentCapture: { enabled, redactSecrets } });
      ok(res, { enabled, redactSecrets });
    } catch { bad(res, 500, 'failed to update capture preference'); }
  });

  // The static MCP/gateway bearer for THIS box — the copy-paste token a local
  // harness or the memory-bridge hooks present to :4711. Auto-provisioned +
  // persisted in auth.db (remote/config.resolveMcpBearer); surfaced here so the
  // operator can paste it into a harness or the Claude Code hook env. Operator-only
  // (this router is mounted behind the portal session). Never logged.
  router.get('/mcp-bearer', (_req, res) => {
    try { ok(res, { bearer: resolveMcpBearer() }); }
    catch { bad(res, 500, 'failed to resolve bearer'); }
  });

  // One-stop "Connect a phone" payload: the access token (Bearer) + the best
  // server address to type into the native app. The app authenticates with the
  // static Bearer (NOT the operator password). recommended = Tailscale HTTPS when
  // a TLS cert is configured + the tailnet name resolves (the no-compromise path),
  // else the relay URL. Operator-only (portal session). Never logs the bearer.
  router.get('/phone-connect', (_req, res) => {
    try {
      const bearer = resolveMcpBearer();
      const tlsConfigured = Boolean(process.env.MYCELIUM_REST_TLS_CERT && process.env.MYCELIUM_REST_TLS_KEY);
      const tlsPort = Number(process.env.MYCELIUM_REST_TLS_PORT) || 8443;
      const tailscaleHost = detectTailscaleDnsName();
      const tailscaleUrl = tailscaleHost ? `https://${tailscaleHost}:${tlsPort}` : null;
      let relayUrl = null;
      try { relayUrl = readRemoteConfig()?.publicBaseUrl || null; } catch { /* not configured */ }
      // Recommend the secure direct path when it's actually live (TLS on + tailnet
      // known); otherwise the relay; otherwise null → the UI guides setup.
      const recommended = (tlsConfigured && tailscaleUrl) ? tailscaleUrl : (relayUrl || tailscaleUrl || null);
      ok(res, { bearer, tlsConfigured, tlsPort, tailscaleHost, tailscaleUrl, relayUrl, recommended });
    } catch { bad(res, 500, 'failed to build phone-connect payload'); }
  });

  // Create a provider (BYOK API key). Body: { provider, label?, api_key, model_preference?, base_url? }.
  router.post('/providers', async (req, res) => {
    const b = req.body || {};
    const provider = String(b.provider || '').toLowerCase();
    if (!KNOWN.has(provider)) return bad(res, 400, `unknown provider '${b.provider}'`);
    if (provider === 'custom' && !b.base_url) return bad(res, 400, 'custom provider requires base_url');
    const apiKey = typeof b.api_key === 'string' ? b.api_key.trim() : '';
    if (!apiKey && provider !== 'custom') return bad(res, 400, 'api_key is required');
    // SSRF + exfil guard (H5): reject a private/internal or non-http(s) base_url
    // before it's ever fetched with the prompt + the user's key.
    if (b.base_url) { try { await assertSafeBaseUrlResolved(b.base_url); } catch (e) { return bad(res, 400, `invalid base_url: ${e.message}`); } }
    try {
      // Auto-activate the FIRST provider so onboarding's "Connect AI" step lands
      // the user on a usable model with no extra click — but never steal `active`
      // from a provider the user already chose (checked BEFORE create).
      let hadActive = false;
      try { hadActive = (await db.providers.list(userId)).some((r) => r.is_active); } catch { /* fresh vault → none */ }
      const id = await db.providers.create(userId, {
        provider,
        label: b.label || null,
        authType: 'api_key',
        // JSON envelope (room for org id, etc. later); encrypted at rest.
        credentials: apiKey ? JSON.stringify({ apiKey }) : null,
        model: b.model_preference || null,
        baseUrl: b.base_url || null,
      });
      let activated = false;
      if (!hadActive) {
        try { await db.providers.setActive(id, userId); activated = true; } catch { /* non-fatal: provider still created */ }
      }
      ok(res, { id, activated });
    } catch { bad(res, 500, 'failed to create provider'); }
  });

  // Update / activate. Body: { is_active?, label?, model_preference?, base_url?, api_key? }.
  router.put('/providers/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return bad(res, 400, 'invalid id');
    const b = req.body || {};
    if (typeof b.base_url === 'string' && b.base_url) {
      try { await assertSafeBaseUrlResolved(b.base_url); } catch (e) { return bad(res, 400, `invalid base_url: ${e.message}`); }
    }
    try {
      if (b.is_active === true) await db.providers.setActive(id, userId);
      const fields = {};
      if (typeof b.label === 'string') fields.label = b.label;
      if (typeof b.model_preference === 'string') fields.model_preference = b.model_preference;
      if (typeof b.base_url === 'string') fields.base_url = b.base_url;
      if (typeof b.api_key === 'string' && b.api_key.trim()) fields.credentials = JSON.stringify({ apiKey: b.api_key.trim() });
      if (Object.keys(fields).length) await db.providers.update(id, userId, fields);
      ok(res);
    } catch { bad(res, 500, 'failed to update provider'); }
  });

  // Delete.
  router.delete('/providers/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return bad(res, 400, 'invalid id');
    try { await db.providers.remove(id, userId); ok(res); }
    catch { bad(res, 500, 'failed to delete provider'); }
  });

  // Connectivity test — a 1-token request with this row's key. Reports a category
  // only; marks the row active/error by the result.
  router.post('/providers/:id/test', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return bad(res, 400, 'invalid id');
    try {
      const row = await db.providers.get(id, userId);
      if (!row) return bad(res, 404, 'provider not found');
      let apiKey = null;
      try { apiKey = row.credentials ? JSON.parse(row.credentials).apiKey : null; } catch { /* malformed → no key */ }
      const result = await probeProvider({ provider: row.provider, baseUrl: row.base_url, model: row.model_preference, apiKey, fetch });
      await db.providers.update(id, userId, { status: result.ok ? 'active' : 'error', last_used_at: new Date().toISOString() });
      ok(res, { result });
    } catch { bad(res, 500, 'connectivity test failed'); }
  });

  // ── Auth-status stubs ───────────────────────────────────────────────────────
  // The UI probes these to decide whether to show an OAuth "Connect" button. We
  // support API-key providers only (Claude-subscription OAuth is a ToS violation,
  // 2026-02-19), so report "not connected" → the UI falls back to key entry, and
  // the OAuth POSTs fail closed with a clear message.
  router.get('/auth/openai/status', (_req, res) => ok(res, { authenticated: false }));
  router.get('/auth/claude/status', (_req, res) => ok(res, { authenticated: false }));
  router.post('/auth/openai/disconnect', (_req, res) => ok(res));
  router.post('/auth/claude/disconnect', (_req, res) => ok(res));
  const claudeOAuthRefused = (_req, res) =>
    bad(res, 400, 'Claude subscription OAuth is not supported — add an Anthropic API key instead.');
  router.post('/auth/claude', claudeOAuthRefused);
  router.post('/auth/claude/code', claudeOAuthRefused);

  return router;
}

export default portalProvidersRouter;
