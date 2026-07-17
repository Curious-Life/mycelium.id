// src/portal-providers.js — the /portal/providers* backend (BYOK AI-provider
// CRUD + connectivity test). The canonical SettingsView UI already calls these
// routes; the live V1 backend never mounted them. Wires src/db/providers.js
// (the `ai_providers` table). `credentials` is encrypted at rest by the db
// adapter (ENCRYPTED_FIELDS.ai_providers) and NEVER returned to the client.
//
// SECURITY:
//   - BYOK API key, PLUS an opt-in Claude SUBSCRIPTION path (auth_type:'oauth').
//     Connecting a subscription was disabled on 2026-02-19 as an Anthropic ToS
//     concern; it is RE-ENABLED (2026-06-26) as an EXPLICIT, opt-in, user-elected
//     action for self-hosted single-user operators who run their OWN subscription
//     on their OWN box and knowingly accept the ToS risk. We IMPORT the user's
//     existing Claude Code login (~/.claude/.credentials.json) — never mint tokens
//     via Anthropic's client_id. /auth/claude/import requires acknowledgeToS:true
//     (fail-closed without it). See docs/CLAUDE-SUBSCRIPTION-DRIVER-DESIGN-2026-06-26.md.
//   - The key blob is written once on create/update and never echoed back. The
//     listing carries metadata only (providers.list() omits `credentials`); the
//     decrypt path is reached only for the connectivity probe + the inference
//     router (a later unit).
//   - The probe reports a category only — never the key, never the body.
import express from 'express';
import { execFileSync } from 'node:child_process';
import { probeProvider } from './inference/probe.js';
import { listModels } from './inference/models.js';
import { PROVIDER_PRESETS, isLoopbackUrl, jurisdictionForBaseUrl } from './inference/presets.js';
import { assertSafeBaseUrlResolved } from './inference/base-url.js';
import { KNOWN_PROVIDERS } from './inference/known-providers.js';
import { INFERENCE_TASKS, ONBOX_TASKS } from './inference/resolve.js';
import { ROLE_RECOMMENDATIONS, INTELLIGENCE_FUNCTIONS, tasksForFunction } from './inference/role-models.js';
import { resolveMcpBearer, readRemoteConfig } from './remote/config.js';
import { importFromClaudeCli, ClaudeImportError, readClaudeAccount } from './inference/claude-oauth.js';
import { probeClaudeCredential } from './inference/claude-sources.js';
import { startPkceFlow, exchangeCode, refreshAccessToken, createPkceFlowStore, ClaudePkceError } from './inference/claude-pkce.js';
import { resolveClaudeBin } from './inference/claude-bin.js';
import { seedClaudeConfigDir } from './inference/claude-config-dir.js';
import { isCliEngineReady } from './agent/harnesses/index.js';

// True for an ai_providers row that is a Claude SUBSCRIPTION (OAuth token), as
// opposed to a BYOK API key. One discriminator: auth_type='oauth'.
const isSubscriptionRow = (r) => String(r?.auth_type || '').toLowerCase() === 'oauth';

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
// TWO facts, computed HERE (server-side) with the one shared parser (inference/presets.js).
// They are NOT the same fact and must never be collapsed:
//
//   jurisdiction    jurisdictionForBaseUrl — the LEGAL exposure of the traffic.
//   on_this_device  isLoopbackUrl          — literally THIS MACHINE.
//
// ⚠️ THEY SHIP SO NO CLIENT EVER GUESSES. Both have already been re-derived on the client with
// an unanchored substring regex — the anti-pattern presets.js:40-49 exists to document
// deleting (`https://localhost.attacker.io/v1` classified LOCAL) — and both times it was live:
//
//   - The Intelligence screen must hide US providers from §4g-limited functions; its first
//     version diverged from the server on 9 of 13 URLs, offering US lookalikes to a limited
//     function AND hiding genuine EU/local providers behind a reason false for them.
//   - AISettings' jurisdiction chip told the user their most intimate data stayed "on your
//     device" while it was being sent to an internet host — `https://evil.example.com/v1?x=11434`
//     matched in the QUERY STRING. An ordinary LAN Ollama (192.168.1.9:11434) tripped it too.
//
// (Both found by independent review, 2026-07-16.) One authority, shipped — never a second
// opinion on the client.
//
// WHY on_this_device IS SEPARATE, and not `jurisdiction === 'local'`: jurisdictionForBaseUrl
// maps a `.local` host to 'local' (a LAN box — sovereign-ish, but NOT this device). Gating the
// green "on your device" claim (or the destructive Ollama disk-delete offer) on the
// jurisdiction would re-ship that bug INVERTED for every `.local` host. Whatever PR #175
// decides about `.local`, on_this_device stays correct.
//
// Lossless: every PROVIDER_PRESETS row's DECLARED jurisdiction already equals the computed one
// (verified across all 9 presets; no preset declares 'us-zdr'), so no badge downgrades.
const publicRow = (r) => ({
  id: r.id, provider: r.provider, label: r.label, auth_type: r.auth_type,
  model_preference: r.model_preference, base_url: r.base_url,
  jurisdiction: jurisdictionForBaseUrl(r.base_url, r.provider),
  is_active: r.is_active, status: r.status,
  on_this_device: isLoopbackUrl(r.base_url),
  last_used_at: r.last_used_at, created_at: r.created_at, updated_at: r.updated_at,
});

// ── THE one task-model write path — the consent mechanism itself ────────────────────────────
// Shared by PUT /providers/task-models (the Intelligence screen's approve/assign) AND the
// bundle orchestrator (src/portal-intelligence.js POST /intelligence/bundle/apply). The
// approval IS the setting (§3.10c): an empty/absent model CLEARS the task, and clearing means
// NOT APPROVED — nothing downloads, nothing runs. Fail-closed: validation errors persist
// nothing (the local copy is only written in the ONE updateSettings at the end).
//
// Returns { ok:true, taskModels } or { ok:false, code, error }. Never throws for a caller
// mistake; a storage failure rethrows so the route can 500 honestly.
export async function applyTaskModelWrite({ db, userId, body }) {
  const { task, function: fnKey, providerId = null, model = null } = body || {};
  // Both keys is a caller bug, not a precedence question: silently honouring `function` and
  // dropping `task` would write two tasks the caller didn't ask for and skip the one it did.
  if (fnKey !== undefined && fnKey !== null && task !== undefined && task !== null) {
    // NB the message names both keys rather than claiming a `function` was "sent": a falsy
    // -but-present value ({function:''}) lands here too, and "not both" would read as a lie.
    return { ok: false, code: 400, error: 'send `task` OR `function` — both were present in the body' };
  }
  // Resolve the target task list: a function fans out to its tasks; a task is itself.
  let targets;
  if (fnKey !== undefined && fnKey !== null) {
    const known = INTELLIGENCE_FUNCTIONS.find((f) => f.key === fnKey);
    targets = [...tasksForFunction(fnKey)];
    if (!targets.length) {
      // transcription/voice are REAL functions that own no INFERENCE_TASK — they have their
      // own rails (whisper's download route, the TTS catalog). Saying "unknown" would be a
      // lie the first UI author trips over; say what is actually true.
      return { ok: false, code: 400, error: known
        ? `function '${fnKey}' has no inference task — it is assigned through its own surface`
        : `unknown function (allowed: ${INTELLIGENCE_FUNCTIONS.filter((f) => f.tasks.length).map((f) => f.key).join(', ')})` };
    }
  } else if (INFERENCE_TASKS.includes(task)) {
    targets = [task];
  } else {
    return { ok: false, code: 400, error: `unknown task (allowed: ${INFERENCE_TASKS.join(', ')})` };
  }

  const settings = (await db.users?.getSettings?.(userId)) || {};
  const taskModels = { ...(settings.taskModels || {}) };
  // ⚠️ WHAT ACTUALLY MAKES THIS ATOMIC IS THE SINGLE `updateSettings` BELOW — not the fact
  // that validation sits up here. `taskModels` is a LOCAL COPY, so any early return
  // persists nothing no matter where it fires. An earlier version of this comment (and its
  // commit message) claimed the up-front ordering was the mechanism preventing a
  // half-apply, and claimed M9 (verify-task-models.mjs) would fail if you moved validation into the loop. A reviewer
  // moved it into the loop: it still PASSED. The claim was false (independent review,
  // 2026-07-16). Validating up-front is still better — it is cheaper and reads clearly —
  // but do not mistake it for the guarantee. THE GUARANTEE IS: build the whole next state,
  // then write it ONCE. If you ever move the write inside the loop, the fan-out stops being
  // atomic and no current gate would catch it.
  const onboxName = typeof model === 'string' ? model.trim() : '';
  if (targets.some((t) => ONBOX_TASKS.has(t)) && onboxName) {
    // Ollama tag shape (defense in depth — this value is later fed to localInfer as a model tag).
    // Allow namespace/name:tag (so '/' and ':' are legitimate), but reject '..' so a stored
    // name can never be path-traversal-shaped, even though the only sink is a JSON model field.
    if (!/^[\w./:-]{1,64}$/.test(onboxName) || onboxName.includes('..')) return { ok: false, code: 400, error: 'invalid model name' };
  }
  if (targets.some((t) => !ONBOX_TASKS.has(t)) && providerId != null) {
    const row = await db.providers.get(providerId, userId); // must be a configured provider of THIS user
    if (!row) return { ok: false, code: 404, error: 'provider not found' };
  }

  for (const t of targets) {
    if (ONBOX_TASKS.has(t)) {
      // Local model NAME only — no providerId, no provider-row lookup.
      if (!onboxName) delete taskModels[t];              // clear → NOT approved (nothing pulls, nothing runs)
      else taskModels[t] = { model: onboxName };
    } else if (providerId == null) {
      delete taskModels[t];                              // clear → falls back to the active provider
    } else {
      taskModels[t] = { providerId, ...(model ? { model: String(model) } : {}) };
    }
  }
  await db.users.updateSettings(userId, { ...settings, taskModels });   // ONE write ⇒ atomic
  return { ok: true, taskModels };
}

// The provider vocabulary is shared with the import path (see known-providers.js) —
// what this route refuses to create, a restore must refuse to resurrect.
const KNOWN = KNOWN_PROVIDERS;
// Exported so verify:provider-import can assert the two paths reference the SAME Set
// by identity — a source-text check can't tell a shared import from a redeclaration.
export { KNOWN as __knownProvidersForTest };

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
      // onboxTasks lets the UI render on-box tasks (local model NAME picker) vs cloud
      // tasks (provider picker) coherently in ONE area — instead of hardcoding which task
      // is on-box and stranding others (e.g. 'enrich') in the cloud list with a providerId
      // the drainer never reads.
      ok(res, { tasks: INFERENCE_TASKS, onboxTasks: [...ONBOX_TASKS], taskModels: settings.taskModels || {} });
    } catch { bad(res, 500, 'failed to read task models'); }
  });

  // Assign (or clear) a task's provider/model. Body: { task, providerId|null, model? }.
  // Cloud tasks store { providerId, model? } (provider row must exist). ON-BOX tasks
  // (categorize/enrich) store { model } — a LOCAL Ollama model NAME, no provider row.
  //
  // ⚠️ An empty/absent model CLEARS the task, and clearing means NOT APPROVED — nothing is
  // downloaded, nothing runs (§3.10c: the approval IS the model setting; there is no separate
  // consent flag). This comment used to say "falls back to its curated default (qwen3.5:4b)",
  // which was true until 2026-07-16 and was precisely the bug: that implicit fallback made a
  // fresh vault pull 3.4GB — plus the Ollama runtime — with no prompt and no way to decline.
  // ── `function` (the Intelligence screen) vs `task` (the legacy per-task control) ──────
  // The screen assigns by FUNCTION (design §3.11), and a function can own MORE THAN ONE task:
  // Understanding = {categorize, enrich}. Sending `{ function: 'understanding', model }` writes
  // BOTH in ONE settings update.
  //
  // ⚠️ THIS IS THE FIX FOR A REAL DORMANCY BUG, not sugar. While the only way to assign was
  // per-task, a vault could approve `categorize` and leave `enrich` unset — so L2 (semantic
  // entities + gist) sat SILENTLY DEAD with no surface reporting it (M's re-review). One
  // approval, both tasks, atomically.
  // ⚠️ NOT "the split cannot reopen" — an earlier version said that and it was false. The
  // per-task path below still writes exactly one task, and the ONLY shipped screen
  // (AISettings.svelte's two on-box selects) is precisely that caller, so the split is still
  // the current default until the Intelligence screen replaces it. What this closes is the
  // split being UNAVOIDABLE; what closes it for users is the screen (increment I, next).
  //
  // `task` still works unchanged — verify:task-models and the existing controls use it.
  //
  // ⚠️ THE BODY LIVES IN applyTaskModelWrite (exported below) SO THERE IS EXACTLY ONE WRITE
  // PATH. The Intelligence bundle orchestrator (src/portal-intelligence.js, the one-tap
  // first-run confirm) must apply the SAME consent mechanism — the approval IS the setting,
  // "" un-approves, one settings write per call — and the only way that stays true under
  // change is if both callers execute the same function, not two copies of it. A gate asserts
  // the identity (verify-intelligence-bundle.mjs B1), but the structure is the real guarantee.
  router.put('/providers/task-models', async (req, res) => {
    try {
      const r = await applyTaskModelWrite({ db, userId, body: req.body || {} });
      if (r.ok) ok(res, { taskModels: r.taskModels });
      else bad(res, r.code, r.error);
    } catch { bad(res, 500, 'failed to set task model'); }
  });

  // The curated catalog of connectable providers — the "Intelligence" options the
  // UI offers (label, kind, base_url, jurisdiction, default model). Static data;
  // the UI prefills the add-provider form from a chosen preset. No secrets.
  //
  // `functions` is the FUNCTION spine (design §3.11) — the ordered list the Intelligence
  // screen renders, each with its recommendation, its reason, the tasks it writes, and its
  // jurisdiction limit. Served HERE rather than from a new endpoint because this route already
  // carries the sibling `roleRecommendations` and the UI already fetches it once at mount:
  // one round-trip, one place to look. §3.10d's "no third catalog" applies to routes too.
  //
  // Content-free by construction — it is a frozen module constant (role-models.js): labels,
  // model names, task names. No user data can reach it.
  router.get('/providers/presets', (_req, res) => ok(res, {
    presets: PROVIDER_PRESETS,
    roleRecommendations: ROLE_RECOMMENDATIONS,
    functions: INTELLIGENCE_FUNCTIONS,
  }));

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
      // A PENDING row is un-armed config (an import planted it — vault-import.js's
      // ai_providers policy). mapRowToConfig refuses it for every RESOLVER, but this
      // route reads the row DIRECTLY and would fetch its base_url — a fourth read path
      // the resolver chokepoint does not cover. Low severity (no vault plaintext, and
      // the key sent is whatever the bundle supplied, not the user's), but an imported
      // row must not cause ANY outbound fetch before the user arms it: "unreachable
      // until activated" has to mean unreachable, or the claim rots into the same
      // stale-prose trap this file's history is full of. Refuse until armed.
      if (String(row.status || '').toLowerCase() === 'pending') {
        return res.json({ ok: false, models: [], error: 'provider is not activated yet — activate it to list models' });
      }
      let apiKey = null, token = null;
      // A BYOK provider stores `.apiKey`; a SUBSCRIPTION stores `.claudeOAuthToken`
      // (listModels then uses the Bearer + Claude-Code headers instead of x-api-key).
      try { const c = row.credentials ? JSON.parse(row.credentials) : {}; apiKey = c.apiKey || null; token = c.claudeOAuthToken || null; } catch { /* malformed → no key */ }
      const r = await listModels({ provider: row.provider, baseUrl: row.base_url, apiKey, token, fetch });
      res.json({ ok: r.ok, models: r.models || [], error: r.ok ? null : r.error });
    } catch { res.json({ ok: false, models: [], error: 'unreachable' }); }
  });

  // NOTE: the "Smart routing" (multi-provider cascade) UI + its GET/PUT /providers/routing
  // routes were REMOVED (operator decision, 2026-07-02) — it confused the explicit per-task
  // picks. The cascade ENGINE (resolveProviderChain / cascade.js) remains but is now gated
  // ONLY by env `MYCELIUM_INFER_CASCADE` (default off), so it's inert unless an operator
  // opts in. `settings.inferCascade` is no longer written by the product.

  // ── §4g subscription opt-in ─────────────────────────────────────────────────
  // By default §4g-sensitive work stays on-box/EU even when a subscription is connected.
  // This OFF-BY-DEFAULT toggle lets the operator relax §4g for THEIR OWN vault so the
  // connected subscription can process it too. Read by resolveProviderChain /
  // resolveInferenceConfig. MUST be declared before '/providers/:id' or the PUT is
  // shadowed by the numeric-id route (Number('sensitive-subscription')→NaN→400).
  //
  // ⚠️ WHAT IT COVERS GREW ON 2026-07-16, and the UI copy grew with it. It used to be only
  // the persona/claim abstractions (claims/discovery + validator, the two call sites that
  // hardcoded sensitive:true). `narrate` — mindscape names + chronicles — is now
  // §4g-sensitive too (src/inference/sensitivity.js), so this toggle governs descriptions as
  // well. That is strictly MORE protective than before (narrate previously reached a US
  // subscription regardless of this toggle), but a user who consented to "claim analysis"
  // must be TOLD chronicles are included — hence "persona, claim & description analysis" in
  // AISettings. If SENSITIVE_TASKS grows again, this copy grows again.
  router.get('/providers/sensitive-subscription', async (_req, res) => {
    try { const s = await db.users.getSettings(userId); ok(res, { allowed: s?.allowSubscriptionSensitive === true }); }
    catch { bad(res, 500, 'failed to read preference'); }
  });
  router.put('/providers/sensitive-subscription', async (req, res) => {
    try {
      const allowed = req.body?.allowed === true;
      try { await db.users.create(userId, userId); } catch { /* row exists */ }
      const s = await db.users.getSettings(userId);
      await db.users.updateSettings(userId, { ...s, allowSubscriptionSensitive: allowed });
      ok(res, { allowed });
    } catch { bad(res, 500, 'failed to update preference'); }
  });

  // ── Web access (agent web search) ────────────────────────────────────────────
  // Owner-only Anthropic-run web search for the agent (agent/web-search.js). Persisted
  // as settings.webSearch. Default ON (absent → enabled); the operator can hard-disable
  // the whole capability with env MYCELIUM_WEB_SEARCH=0 (not reflected here — it overrides
  // at turn time). This toggle only turns the user preference off (settings.webSearch=false).
  router.get('/providers/web-search', async (_req, res) => {
    try { const s = await db.users.getSettings(userId); ok(res, { enabled: s?.webSearch !== false }); }
    catch { bad(res, 500, 'failed to read preference'); }
  });
  router.put('/providers/web-search', async (req, res) => {
    try {
      const enabled = req.body?.enabled !== false;   // default on; only an explicit false disables
      try { await db.users.create(userId, userId); } catch { /* row exists */ }
      const s = await db.users.getSettings(userId);
      await db.users.updateSettings(userId, { ...s, webSearch: enabled });
      ok(res, { enabled });
    } catch { bad(res, 500, 'failed to update preference'); }
  });

  // ── Agent engine (harness) selection ────────────────────────────────────────
  // Which engine runs the interactive chat agent: 'native' (default — the in-process
  // agent loop) or 'cli' (spawn the installed `claude` / Claude Code as the engine —
  // C2). Persisted as settings.harnessMode. GET also reports eligibility so the UI can
  // gate the Claude Code option honestly (offered only when a subscription is connected
  // AND the binary is installed). The runtime resolver (resolve-harness.js) fails safe
  // to native regardless, so the stored preference can never strand a turn. MUST be
  // declared before '/providers/:id' (Number('harness')→NaN→400 shadowing).
  router.get('/providers/harness', async (_req, res) => {
    try {
      const s = await db.users.getSettings(userId);
      const subscriptionConnected = (await db.providers.list(userId)).some(isSubscriptionRow);
      ok(res, {
        harnessMode: s?.harnessMode === 'cli' ? 'cli' : 'native',
        subscriptionConnected,
        claudeAvailable: resolveClaudeBin() != null,
        // Is the cli engine actually wired (C2 shipped)? false in C1 ⇒ the UI shows
        // Claude Code as "coming soon" rather than a selectable engine that would only
        // fall back to native — the switch never lies. Matches the resolver's gate.
        engineReady: isCliEngineReady(),
      });
    } catch { bad(res, 500, 'failed to read engine preference'); }
  });
  router.put('/providers/harness', async (req, res) => {
    try {
      const mode = req.body?.harnessMode === 'cli' ? 'cli' : 'native';
      try { await db.users.create(userId, userId); } catch { /* row exists */ }
      const s = await db.users.getSettings(userId);
      await db.users.updateSettings(userId, { ...s, harnessMode: mode });
      ok(res, { harnessMode: mode });
    } catch { bad(res, 500, 'failed to update engine preference'); }
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
      // A 'pending' row NEVER leaves 'pending' here. status='pending' is what makes an
      // IMPORTED provider unresolvable (resolve.js mapRowToConfig), and this route is a
      // connectivity probe, not an arming action — the UI presents it as "Test", and it
      // leaves is_active=0, so the row still reads as not-the-active-provider.
      // Writing EITHER outcome would arm it: 'active' obviously, but 'error' too, since
      // the resolver only refuses 'pending'. A bundle-planted row is then one Test click
      // from being a live fallback egress target (resolveProviderChain ignores is_active
      // by design). Only setActive — the deliberate "use this provider" click — promotes.
      const pending = String(row.status || '').toLowerCase() === 'pending';
      await db.providers.update(id, userId, {
        ...(pending ? {} : { status: result.ok ? 'active' : 'error' }),
        last_used_at: new Date().toISOString(),
      });
      ok(res, { result });
    } catch { bad(res, 500, 'connectivity test failed'); }
  });

  // ── Auth status / connect / disconnect ──────────────────────────────────────
  // OpenAI OAuth is not offered (key entry only). Claude exposes the subscription
  // IMPORT path below.
  router.get('/auth/openai/status', (_req, res) => ok(res, { authenticated: false }));
  router.post('/auth/openai/disconnect', (_req, res) => ok(res));

  // Claude subscription HEALTH — a real probe, not a cached flag.
  //
  // This used to answer `authenticated: !!sub` — i.e. "a DB row exists". It contacted
  // nothing, so the card showed a green "✓ Connected as <email>" for a token that had
  // been revoked or expired months earlier. `isTokenExpired()` already existed and was
  // never called. That dishonesty is the thing the user actually feels as "dodgy".
  //
  // Now: the row says CONFIGURED; the live credential stores say USABLE. We probe the
  // on-device stores (probeClaudeCredential) and report a discrete, truthful state.
  // Never returns a token — only states and non-secret identity.
  //
  // KNOWN GAP (do not overclaim): this probes the DEVICE stores, which is where the
  // inference path reads the LIVE token — but resolve.js still falls back to the token
  // stored in ai_providers.credentials when no live one resolves. So a vault whose
  // config-dir seed failed can report needs_reauth here while inference still works off
  // the stored copy. Closing that means making the DB the probe's last rung (or making
  // the file canonical, per the design's file-canonical increment) — tracked, not done.
  //
  //   missing      — no subscription configured
  //   connected    — a live, unexpired credential is present
  //   expired      — present but past expiry; refresh will be attempted on next use
  //   needs_reauth — configured, but nothing usable on this device (gone / setup-token
  //                  artifact / dead grant) → the user must reconnect
  //   declined     — Keychain access was denied; you ARE likely signed in (do NOT tell
  //                  the user to sign in — tell them to allow access, or use the web flow)
  router.get('/auth/claude/status', async (_req, res) => {
    try {
      const sub = (await db.providers.list(userId)).find(isSubscriptionRow);
      let account = null, model = null;
      if (sub) {
        model = sub.model_preference || null;
        try { const full = await db.providers.get(sub.id, userId); const c = full?.credentials ? JSON.parse(full.credentials) : {}; account = c.account || null; } catch { /* no account metadata */ }
      }
      if (!sub) return ok(res, { authenticated: false, health: 'missing', providerId: null, account: null, model: null });

      let probe = null;
      try { probe = await probeClaudeCredential(); } catch { probe = null; }
      const health =
        !probe ? 'needs_reauth'
          : probe.status === 'found' ? (probe.expired ? 'expired' : 'connected')
            : probe.status === 'declined' ? 'declined'
              : 'needs_reauth';   // absent | wrong_scope

      ok(res, {
        // `authenticated` kept for back-compat with the existing card, but it now means
        // USABLE (probe-verified), not "a row exists".
        authenticated: health === 'connected' || health === 'expired',
        health,
        providerId: sub.id,
        account,
        model,
        // Non-secret diagnostics so the UI can be specific instead of a green tick:
        source: probe?.source || null,                 // which store supplied it
        expiresAt: probe?.creds?.expiresAt ?? null,    // a timestamp, not a token
        scopeUnknown: probe?.scopeUnknown === true,    // bare env token — scope unverified
        declinedSources: probe?.declinedSources || [],
      });
    } catch { ok(res, { authenticated: false, health: 'needs_reauth' }); }
  });

  // Disconnect: remove any stored subscription row(s).
  router.post('/auth/claude/disconnect', async (_req, res) => {
    try {
      for (const r of (await db.providers.list(userId)).filter(isSubscriptionRow)) {
        try { await db.providers.remove(r.id, userId); } catch { /* best-effort */ }
      }
      ok(res);
    } catch { bad(res, 500, 'failed to disconnect'); }
  });

  // Connect a Claude SUBSCRIPTION by importing the user's own Claude Code login
  // (~/.claude/.credentials.json). IMPORT, never mint. Requires acknowledgeToS:true —
  // a conscious acceptance that automating a Pro/Max subscription may breach Anthropic's
  // Terms (the operator runs their own sub on their own box). Stores the OAuth token in
  // ai_providers.credentials (encrypted at rest by whole-file SQLCipher), auth_type='oauth'.
  // ── The ONE place a subscription credential is persisted ──────────────────────
  // Every connect path (auto-probe, web PKCE, legacy import) funnels through here,
  // so there is a single storage contract rather than three drifting copies.
  // NOTE (design §3.4): the token still lands in ai_providers.credentials today —
  // moving to file-canonical is its own increment; changing it here would break the
  // readers in resolve.js in the same breath. Deliberately unchanged for now.
  async function persistSubscription(creds, { account = null } = {}) {
    // One subscription per vault: replace any existing oauth row.
    for (const r of (await db.providers.list(userId)).filter(isSubscriptionRow)) {
      try { await db.providers.remove(r.id, userId); } catch { /* best-effort */ }
    }
    let hadActive = false;
    try { hadActive = (await db.providers.list(userId)).some((r) => r.is_active); } catch { /* fresh vault */ }
    const id = await db.providers.create(userId, {
      provider: 'anthropic',
      label: 'Claude subscription',
      authType: 'oauth',
      // account = non-secret identity (email/plan/org) so the card can show
      // "connected as <email>". list() omits credentials; status exposes only the
      // account, never the token.
      credentials: JSON.stringify({ claudeOAuthToken: creds.claudeOAuthToken, refreshToken: creds.refreshToken, expiresAt: creds.expiresAt, scopes: creds.scopes, account: account || creds.account || null }),
      model: null,
      baseUrl: null,
    });
    let activated = false;
    if (!hadActive) { try { await db.providers.setActive(id, userId); activated = true; } catch { /* non-fatal */ } }
    // Seed the app's ISOLATED claude config dir so the CLI harness (when selected) and
    // the native wire share one live store.
    // force:true — this is an EXPLICIT connect: the user just chose this account, so it
    // must replace whatever the dir holds. Without force the seed is non-clobbering, so
    // reconnecting to a DIFFERENT account left the OLD token in the dir: the DB said
    // account B while CLI/native turns kept authenticating as account A. (Boot re-seed
    // still uses the default non-forcing call — it must not undo claude's own refresh.)
    try { seedClaudeConfigDir(creds, { force: true }); } catch { /* non-fatal: token still stored in the DB row */ }
    return { id, activated };
  }

  const TOS_MSG = 'Connecting a Claude subscription requires acknowledging that automated use of a Pro/Max subscription may violate Anthropic’s Terms — pass acknowledgeToS:true to proceed.';

  // Pending web-flow verifiers, keyed by user. In memory on purpose: a PKCE verifier
  // is a short-lived secret that must never be persisted. Single-use + 10-min TTL.
  const pkceFlows = createPkceFlowStore();

  // ── CONNECT — the ladder (design §3, operator's "auto first, web if not") ──────
  //   POST /auth/claude/connect { acknowledgeToS }
  //     → { connected:true, source }                  the device already has a login
  //     → { connected:false, needsWeb:true, reason, url }  fall through to the web prompt
  // Reasons are honest: 'absent' (no login) | 'declined' (Keychain denied — you ARE
  // signed in, allow access or use the web) | 'wrong_scope' (setup-token artifact) |
  // 'expired' (refresh grant is dead → re-auth).
  router.post('/auth/claude/connect', async (req, res) => {
    if (req.body?.acknowledgeToS !== true) return bad(res, 400, TOS_MSG);
    try {
      const probe = await probeClaudeCredential();

      if (probe.status === 'found') {
        let creds = probe.creds;
        // Ladder row 3: expired → refresh over HTTP (no CLI). Only a DEAD grant
        // (invalid_grant) falls through to the web prompt.
        if (probe.expired) {
          try {
            creds = await refreshAccessToken({ refreshToken: creds.refreshToken });
          } catch (e) {
            if (e instanceof ClaudePkceError && e.code === 'invalid_grant') {
              const flow = startPkceFlow();
              pkceFlows.set(userId, { verifier: flow.verifier, state: flow.state });
              return ok(res, { connected: false, needsWeb: true, reason: 'expired', detail: e.message, url: flow.url });
            }
            return bad(res, 502, e?.message || 'could not refresh the Claude session');
          }
        }
        const account = await readClaudeAccount().catch(() => null);
        const { id, activated } = await persistSubscription(creds, { account });
        return ok(res, { connected: true, source: probe.source, id, activated, scopes: creds.scopes, account });
      }

      // Not usable on this device → hand back a web prompt WITH the real reason.
      const flow = startPkceFlow();
      pkceFlows.set(userId, { verifier: flow.verifier, state: flow.state });
      const detail = probe.status === 'declined'
        ? 'Keychain access was denied — allow it, or connect in your browser instead.'
        : probe.status === 'wrong_scope'
          ? 'The login found on this device is an admin setup-token, not a subscription sign-in.'
          : 'No Claude login found on this device.';
      return ok(res, { connected: false, needsWeb: true, reason: probe.status, detail, url: flow.url, declinedSources: probe.declinedSources || [] });
    } catch { return bad(res, 500, 'could not start the Claude connection'); }
  });

  // ── CONNECT (web) — finish by pasting the code ─────────────────────────────────
  router.post('/auth/claude/code', async (req, res) => {
    if (req.body?.acknowledgeToS !== true) return bad(res, 400, TOS_MSG);
    const flow = pkceFlows.take(userId);   // single-use
    if (!flow) return bad(res, 400, 'No pending connection (it may have expired). Start again.');
    let creds;
    try {
      creds = await exchangeCode({ code: req.body?.code, verifier: flow.verifier, state: flow.state });
    } catch (e) {
      return bad(res, 400, e?.message || 'could not complete the connection');
    }
    try {
      // NO account label on the web path. readClaudeAccount() reads the MACHINE's
      // ~/.claude.json — which is a DIFFERENT account from the one just authorized in
      // the browser (that is the whole point of the web flow: connect an account this
      // box isn't signed into). Labelling the row with the machine's identity would
      // show the wrong "connected as <email>" — exactly the confusion this work cures.
      // Better no label than a false one; the identity can be fetched with the new
      // token in the health-probe increment.
      const { id, activated } = await persistSubscription(creds, { account: null });
      return ok(res, { connected: true, source: 'web', id, activated, scopes: creds.scopes, account: null });
    } catch { return bad(res, 500, 'failed to store subscription'); }
  });

  // Legacy: connect by importing an existing CLI login. Kept for back-compat with the
  // current Settings UI; /auth/claude/connect supersedes it (it probes ALL stores and
  // falls through to the web flow). Same persist path — no forked storage.
  router.post('/auth/claude/import', async (req, res) => {
    if (req.body?.acknowledgeToS !== true) return bad(res, 400, TOS_MSG);
    let creds;
    try { creds = await importFromClaudeCli(); }
    catch (e) { return bad(res, 400, e instanceof ClaudeImportError ? e.message : 'failed to read Claude Code login'); }
    try {
      const { id, activated } = await persistSubscription(creds);
      ok(res, { id, activated, scopes: creds.scopes, account: creds.account || null });
    } catch { bad(res, 500, 'failed to store subscription'); }
  });

  return router;
}

export default portalProvidersRouter;
