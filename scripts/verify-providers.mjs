// verify:providers — the /portal/providers* backend (the surface SettingsView
// calls). Mounts the real router on a throwaway express app over a temp vault and
// drives the full lifecycle: create → list (metadata only, no key) → setActive
// (one-active-per-type) → connectivity test (mocked fetch) → bad-key category →
// custom-needs-base_url → Claude-OAuth refused (ToS) → delete. PASS/FAIL ledger.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import express from 'express';
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { portalProvidersRouter } from '../src/portal-providers.js';
import { jurisdictionForBaseUrl } from '../src/inference/presets.js';
import { resolveInferenceConfigForTask, _setSubscriptionTokenReaderForTests } from '../src/inference/resolve.js';
import { _resetModelCatalogForTests, discoverModels } from '../src/inference/model-catalog.js';

const DB = 'data/verify-providers.db', KCV = 'data/verify-providers-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';

// Mock fetch — no network. 2xx when the request carries GOODKEY, else 401.
const mockFetch = async (_url, opts) => {
  const hdr = opts?.headers || {};
  const blob = String(hdr.authorization || hdr.Authorization || hdr['x-api-key'] || '');
  const good = blob.includes('GOODKEY');
  return { ok: good, status: good ? 200 : 401, async text() { return '{}'; }, async json() { return {}; } };
};

const app = express();
app.use(express.json());
app.use('/api/v1/portal', portalProvidersRouter({ db, userId: U, fetch: mockFetch }));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/v1/portal`;

const J = async (res) => ({ status: res.status, body: await res.json() });
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
const put = (p, b) => fetch(base + p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
const del = (p) => fetch(base + p, { method: 'DELETE' });
const get = (p) => fetch(base + p);

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

let r = await J(await post('/providers', { provider: 'openai', label: 'GPT', api_key: 'GOODKEY-123', model_preference: 'gpt-4o-mini' }));
rec('P1. POST /providers creates (200 + id)', r.status === 200 && r.body.ok && r.body.id > 0, JSON.stringify(r.body));
const id1 = r.body.id;

// P13 — the FIRST provider on a fresh vault auto-activates (onboarding lands on a
// usable model with no extra click). Response flags activated; listing shows it.
rec('P13. first provider auto-activates (activated:true + is_active)', r.body.activated === true, `activated=${r.body.activated}`);
{
  const lr = await J(await get('/providers'));
  const a = lr.body.providers?.find((p) => p.id === id1);
  rec('P13b. listing confirms the first provider is active', !!a && !!a.is_active, `is_active=${a?.is_active}`);
}

r = await J(await get('/providers'));
const row = r.body.providers?.[0];
rec('P2. GET /providers lists it', r.body.ok && r.body.providers.length === 1 && row.provider === 'openai', JSON.stringify(row));
rec('P3. listing carries NO key fields', row && !('credentials' in row) && !('api_key' in row), `keys=${Object.keys(row || {}).join(',')}`);
// P3b — the listing SHIPS the server's jurisdiction. The Intelligence screen's §4g filter reads
// it, and its first version re-derived it client-side with an unanchored regex (offering
// `localhost.attacker.io` as EU-safe). Nothing pinned the field: deleting it from publicRow left
// six gates GO, and the screen would silently offer NOTHING to a §4g-limited function while a
// real EU provider sat connected (independent review ×2, 2026-07-16). The client must never
// need a second opinion — so the field is part of the contract, not a convenience.
rec('P3b. listing ships the SERVER\'s jurisdiction (so no client ever re-derives it)',
  row && row.jurisdiction === 'us-standard',
  `jurisdiction=${row?.jurisdiction} (an openai row with no base_url is us-standard)`);
// P3c — a DISCRIMINATING value, because P3b alone pinned only the field's PRESENCE: hardcoding
// 'us-standard' in publicRow passed it, and so did reversing jurisdictionForBaseUrl's args —
// which makes EVERY row us-standard (new URL('custom') throws → fail-safe), so a real Regolo or
// Ollama provider VANISHES from a §4g-limited function while sitting connected. That is the very
// failure P3b was added to close (independent review ×3, 2026-07-16). A loopback row must come
// back 'local', or the value is not actually computed.
{
  const lr = await J(await post('/providers', { provider: 'custom', label: 'local-juris', base_url: 'http://127.0.0.1:11434', api_key: 'k' }));
  const lrow = (await J(await get('/providers'))).body.providers?.find((p) => p.id === lr.body.id);
  rec('P3c. …and the VALUE is really computed — a loopback row is `local`, not a constant',
    lrow?.jurisdiction === 'local',
    `jurisdiction=${lrow?.jurisdiction} (http://127.0.0.1:11434 must classify local — a hardcoded or arg-swapped us-standard fails here)`);
}

r = await J(await post('/providers', { provider: 'openai', label: 'GPT2', api_key: 'GOODKEY-456' }));
const id2 = r.body.id;
await put(`/providers/${id2}`, { is_active: true });
r = await J(await get('/providers'));
const actives = r.body.providers.filter((p) => p.provider === 'openai' && p.is_active);
rec('P4. setActive enforces one-active-per-type', actives.length === 1 && actives[0].id === id2, `active=${actives.map((a) => a.id).join(',')}`);

r = await J(await post(`/providers/${id2}/test`, {}));
rec('P5. POST /test with a good key → ok', r.body.ok && r.body.result?.ok === true, JSON.stringify(r.body.result));

r = await J(await post('/providers', { provider: 'openai', label: 'Bad', api_key: 'WRONGKEY' }));
const idBad = r.body.id;
r = await J(await post(`/providers/${idBad}/test`, {}));
rec('P6. POST /test with a bad key → auth_rejected (category only, no body)', r.body.result?.ok === false && r.body.result?.error === 'auth_rejected', JSON.stringify(r.body.result));

r = await J(await post('/providers', { provider: 'custom', label: 'nourl' }));
rec('P7. custom without base_url → 400', r.status === 400, JSON.stringify(r.body));

// ── H5: BYOK base_url SSRF + exfil guard ────────────────────────────────────
// Reject: https→private IP literal (SSRF), http→non-loopback (plaintext), bad scheme.
for (const url of ['https://169.254.169.254/v1', 'https://10.0.0.5/v1', 'http://evil.example/v1', 'ftp://x/v1']) {
  r = await J(await post('/providers', { provider: 'custom', label: 'ssrf', base_url: url }));
  const blocked = r.status === 400 && /invalid base_url/i.test(r.body.error || '');
  rec(`P7-ssrf. internal/non-https base_url rejected: ${url}`, blocked, `status=${r.status} ${r.body.error || ''}`);
}
// Allow: loopback http (local Ollama/LM Studio) — the sovereign default path.
for (const url of ['http://127.0.0.1:11434', 'http://localhost:1234/v1']) {
  r = await J(await post('/providers', { provider: 'custom', label: 'local-ok', base_url: url, api_key: 'k' }));
  rec(`P7-ok. loopback http base_url allowed (local provider): ${url}`, r.status === 200 && r.body.ok, JSON.stringify(r.body));
}
// Jurisdiction classifier cannot be spoofed into eu-zdr by a lookalike host.
rec('P7-juris. lookalike host does NOT downgrade to eu-zdr',
  jurisdictionForBaseUrl('https://regolo.ai.attacker.com/v1') === 'us-standard'
  && jurisdictionForBaseUrl('https://api.regolo.ai/v1') === 'eu-zdr');

// Subscription import is opt-in + fail-closed: without an explicit ToS acknowledgement
// it refuses BEFORE reading any credentials (deterministic — no ~/.claude dependency).
r = await J(await post('/auth/claude/import', { /* no acknowledgeToS */ }));
rec('P8. /auth/claude/import fails closed without ToS acknowledgement', r.status === 400 && /acknowledg/i.test(r.body.error || ''), JSON.stringify(r.body));

r = await J(await get('/auth/claude/status'));
rec('P9. /auth/claude/status → not authenticated when no subscription connected', r.body.ok && r.body.authenticated === false, JSON.stringify(r.body));

r = await J(await get('/providers/presets'));
rec('P10. GET /providers/presets serves the catalog (EU-sovereign + local options)',
  r.body.ok && Array.isArray(r.body.presets) && r.body.presets.length >= 6
  && r.body.presets.some((p) => p.id === 'regolo' && p.jurisdiction === 'eu-zdr')
  && r.body.presets.some((p) => p.jurisdiction === 'local'),
  `count=${r.body.presets?.length}`);

// P10b — the FUNCTION spine reaches the client (design §3.11). The Intelligence screen renders
// THIS list; without it the screen would have to hardcode the taxonomy, which is precisely the
// drift verify:intelligence-functions exists to prevent (a badge diverging from the default).
// Served on the existing presets route — the UI already fetches it once, and §3.10d's "no third
// catalog" applies to routes too.
{
  const fns = r.body.functions;
  const understanding = Array.isArray(fns) && fns.find((f) => f.key === 'understanding');
  const descriptions = Array.isArray(fns) && fns.find((f) => f.key === 'descriptions');
  // Split into four, deliberately: as ONE compound && every mutation failed with byte-identical
  // output ("keys=…"), which tells the operator only that *something* drifted (independent
  // review, 2026-07-16). A gate that cannot localise its own failure wastes the next hour.
  rec('P10b. the FUNCTION spine reaches the client at all',
    Array.isArray(fns) && fns.length >= 5,
    `keys=${Array.isArray(fns) ? fns.map((f) => f.key).join(',') : fns}`);
  // Understanding must arrive carrying BOTH tasks — the screen sends {function} and the route
  // fans out; a client that saw only `categorize` would re-create the dormancy split.
  rec('P10b2. …Understanding carries BOTH tasks (a client seeing one would re-split the approval)',
    !!understanding && [...understanding.tasks].sort().join() === 'categorize,enrich',
    `understanding.tasks=${JSON.stringify(understanding?.tasks)}`);
  // Descriptions must arrive as jurisdiction 'any' — narrate is no longer §4g-sensitive
  // (2026-07-19), so the screen offers every provider for it. A stray 'eu-or-local' here would
  // make the screen HIDE US/subscription options the router now happily runs (§3.11d inverted:
  // withholding a valid choice), and re-print the "stays in the EU" copy the operator removed.
  rec('P10b3. …Descriptions is jurisdiction "any" (limit lifted — every provider offerable)',
    !!descriptions && descriptions.jurisdiction === 'any',
    `descriptions.jurisdiction=${descriptions?.jurisdiction}`);
  // §3.11c is recommendation-FIRST: a recommendation without a why is the raw dump item 11 names.
  rec('P10b4. …every function carries a label + reason (recommendation-first, not a raw dump)',
    Array.isArray(fns) && fns.every((f) => typeof f.why === 'string' && f.why.length > 0 && f.label),
    `missing why/label: ${(fns || []).filter((f) => !f.why || !f.label).map((f) => f.key).join(',') || 'none'}`);
  // NB no "is it content-free?" check here, deliberately. INTELLIGENCE_FUNCTIONS is a frozen
  // module constant (role-models.js) with no code path from user data — grepping it for a
  // secret would assert nothing and pass forever. A check that cannot fail is worse than none:
  // it reads as coverage. The content-free guarantee here is structural, not behavioural.
}

await del(`/providers/${id1}`);
r = await J(await get('/providers'));
rec('P11. DELETE removes the provider', !r.body.providers.some((p) => p.id === id1), `remaining=${r.body.providers.map((p) => p.id).join(',')}`);

// P12 — the "Smart routing" toggle + its /providers/routing routes were REMOVED
// (operator decision 2026-07-02). Assert they no longer respond as an API route.
try { await db.users.create(U, 'Verify'); } catch { /* row may already exist */ }
// GET has no route (→ 404); PUT falls through to /providers/:id → NaN id → 400. Either
// way the toggle no longer functions (never a 200 cascade write).
const routingGetGone = (await get('/providers/routing')).status >= 400;
const routingPutGone = (await put('/providers/routing', { cascade: true })).status >= 400;
rec('P12. Smart-routing routes removed (GET+PUT /providers/routing no longer function)', routingGetGone && routingPutGone, `get=${routingGetGone} put=${routingPutGone}`);

// P13 — §4g subscription opt-in toggle persists (off by default): lets the user
// allow their connected subscription to process the on-box/EU-only sensitive work.
let ss = await J(await get('/providers/sensitive-subscription'));
const ssDefault = ss.body.ok && ss.body.allowed === false;
await put('/providers/sensitive-subscription', { allowed: true });
ss = await J(await get('/providers/sensitive-subscription'));
const ssOn = ss.body.allowed === true;
await put('/providers/sensitive-subscription', { allowed: false });
ss = await J(await get('/providers/sensitive-subscription'));
const ssOff = ss.body.allowed === false;
rec('P13. §4g subscription opt-in persists (default off → on → off)', ssDefault && ssOn && ssOff, `default=${ssDefault} on=${ssOn} off=${ssOff}`);

// P14 — settings persistence UPSERTS. A fresh single-user vault may have no `users` row;
// a bare UPDATE would silently no-op (the task-model routing "settings don't persist"
// bug). updateSettings now inserts-or-updates, so a write on an id with no prior row sticks.
const FRESH = 'fresh-user-no-row-p14';
await db.users.updateSettings(FRESH, { taskModels: { chat: { providerId: 7 } } });
const back = await db.users.getSettings(FRESH);
rec('P14. updateSettings UPSERTS on a fresh vault (no prior row → settings persist)', back?.taskModels?.chat?.providerId === 7, JSON.stringify(back));

// ── P15 (D-029) — connecting a subscription AUTO-SELECTS it as the DEFAULT for chat +
// narration, even when another provider is already active; and it does NOT override a
// DELIBERATE per-task assignment. Drives the REAL /auth/claude/import → persistSubscription
// path with an injected credential reader (no ~/.claude dependency), then resolves chat +
// narrate through the REAL resolver (inference/resolve.js) — end-to-end, not shape.
//
// MUTATION-TESTED: reverting persistSubscription to `if (!hadActive) setActive` (portal-
//   providers.js) → P15c/P15d/P15e/P15f RED (subscription stays inert behind the prior
//   active provider; getActive + both resolvers keep returning the OpenAI row).
// MUTATION-TESTED: dropping the `, id DESC` tiebreak from providers.getActive (db/providers.js)
//   → P15d/P15e/P15f FLAKY→RED (same-second last_used_at tie can return the OpenAI row).
// MUTATION-TESTED: making persistSubscription ALSO write settings.taskModels = {chat,narrate:
//   {providerId:<sub>}} (the over-aggressive "fix" that clobbers an explicit choice) →
//   P15g + P15h RED (the deliberate chat/narrate→OpenAI assignments no longer win).
{
  const U2 = 'd029-user';
  try { await db.users.create(U2, 'D029'); } catch { /* row may exist */ }
  // Deterministic subscription token: there is no live Keychain/claude CLI in CI, so pin the
  // live-token reader to "no token" → withFreshSubscriptionToken keeps the STORED token.
  _setSubscriptionTokenReaderForTests(async () => ({}));
  const app2 = express(); app2.use(express.json());
  app2.use('/api/v1/portal', portalProvidersRouter({
    db, userId: U2, fetch: mockFetch,
    importClaudeCli: async () => ({ claudeOAuthToken: 'sk-ant-oat-D029', refreshToken: null, expiresAt: null, scopes: ['user:inference'], account: null }),
  }));
  const s2 = await new Promise((r) => { const s = app2.listen(0, '127.0.0.1', () => r(s)); });
  const base2 = `http://127.0.0.1:${s2.address().port}/api/v1/portal`;
  const post2 = (p, b) => fetch(base2 + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });

  // A BYOK provider connected FIRST → auto-activates (becomes the prior default).
  const first = await J(await post2('/providers', { provider: 'openai', label: 'Prior', api_key: 'GOODKEY-PRIOR', model_preference: 'gpt-4o-mini' }));
  const priorId = first.body.id;
  rec('P15a. a prior BYOK provider is active BEFORE the subscription connect', first.body.activated === true, `activated=${first.body.activated}`);

  // Connect the subscription — hadActive is TRUE, yet it MUST become the default (the D-029 fix).
  const imp = await J(await post2('/auth/claude/import', { acknowledgeToS: true }));
  rec('P15b. subscription import succeeds (real /auth/claude/import → persistSubscription)', imp.status === 200 && imp.body.id > 0, JSON.stringify(imp.body));
  rec('P15c. subscription AUTO-SELECTS as active despite a prior active provider (D-029 fix)', imp.body.activated === true, `activated=${imp.body.activated}`);
  const active = await db.providers.getActive(U2);
  rec('P15d. providers.getActive() now returns the SUBSCRIPTION row', !!active && String(active.auth_type).toLowerCase() === 'oauth', `active.auth_type=${active?.auth_type}`);

  // End-to-end: chat + narration resolve to the subscription through the real resolver.
  const chatCfg = await resolveInferenceConfigForTask(db, U2, 'chat');
  const narrCfg = await resolveInferenceConfigForTask(db, U2, 'narrate');
  rec('P15e. resolveInferenceConfigForTask(chat) → the subscription', chatCfg?.providerName === 'claude_subscription' && chatCfg?.claudeOAuthToken === 'sk-ant-oat-D029', `providerName=${chatCfg?.providerName}`);
  rec('P15f. resolveInferenceConfigForTask(narrate) → the subscription', narrCfg?.providerName === 'claude_subscription', `providerName=${narrCfg?.providerName}`);

  await new Promise((r) => s2.close(r));

  // ── ANTI-CLOBBER (D-029 constraint) — a DELIBERATE per-task assignment made BEFORE the
  // connect still wins afterwards. Separate user U3 so the explicit choice PREDATES the
  // subscription import: that is what makes an over-reaching connect (one that writes
  // taskModels) observable here — if persistSubscription re-pointed chat/narrate at the
  // subscription, these two rows would flip. The resolver honours settings.taskModels[task]
  // .providerId over the active provider (inference/resolve.js), so setActive alone can never
  // reach them — this proves the fix stayed on the DEFAULT surface only.
  const U3 = 'd029-user-explicit';
  try { await db.users.create(U3, 'D029x'); } catch { /* row may exist */ }
  const app3 = express(); app3.use(express.json());
  app3.use('/api/v1/portal', portalProvidersRouter({
    db, userId: U3, fetch: mockFetch,
    importClaudeCli: async () => ({ claudeOAuthToken: 'sk-ant-oat-D029X', refreshToken: null, expiresAt: null, scopes: ['user:inference'], account: null }),
  }));
  const s3 = await new Promise((r) => { const s = app3.listen(0, '127.0.0.1', () => r(s)); });
  const base3 = `http://127.0.0.1:${s3.address().port}/api/v1/portal`;
  const post3 = (p, b) => fetch(base3 + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });

  const prior3 = await J(await post3('/providers', { provider: 'openai', label: 'Prior3', api_key: 'GOODKEY-PRIOR3', model_preference: 'gpt-4o-mini' }));
  const priorId3 = prior3.body.id;
  // The user DELIBERATELY routes BOTH chat and narrate to their OpenAI row (Settings →
  // Intelligence) — BEFORE any subscription exists.
  const s0 = await db.users.getSettings(U3);
  await db.users.updateSettings(U3, { ...s0, taskModels: { ...(s0?.taskModels || {}), chat: { providerId: priorId3 }, narrate: { providerId: priorId3 } } });
  // NOW connect the subscription.
  const imp3 = await J(await post3('/auth/claude/import', { acknowledgeToS: true }));
  const chatX = await resolveInferenceConfigForTask(db, U3, 'chat');
  const narrX = await resolveInferenceConfigForTask(db, U3, 'narrate');
  rec('P15g. connect does NOT override an EXPLICIT chat choice made beforehand', imp3.body.activated === true && chatX?.providerName === 'openai' && chatX?.claudeOAuthToken == null, `providerName=${chatX?.providerName}`);
  rec('P15h. connect does NOT override an EXPLICIT narrate choice made beforehand', narrX?.providerName === 'openai' && narrX?.claudeOAuthToken == null, `providerName=${narrX?.providerName}`);

  await new Promise((r) => s3.close(r));
  _setSubscriptionTokenReaderForTests(null); // restore the default live-token reader
}


// ── P16 (D-074) — the model list is the PROVIDER'S ANSWER, cached honestly, never a roster ──
//
// The defect: the subscription picker offered four Claude ids typed into AISettings.svelte, so
// a newly-released model could not appear. The list now comes from the provider
// (src/inference/model-catalog.js → models.js), and every answer is LABELLED — `source`
// live/cache/fallback plus `stale` — so a degraded list can never render as a current one.
//
// This drives the REAL route over the REAL vault with a fetch whose ANSWER CHANGES between
// calls: a literal roster cannot follow it, which is what makes P16b more than a shape check.
//
// MUTATION-TESTED: replacing the route body with a literal roster
//   (`res.json({ok:true, models:['claude-opus-4-8','claude-sonnet-4-5'], source:'live', stale:false})`)
//   → P16, P16b, P16c, P16d, P16e, P16f all RED (the served ids never change, never match the
//   provider's answer, and the key is never even used).
// MUTATION-TESTED: reporting the fallback as `source:'live', stale:false` in model-catalog.js's
//   failure branch → P16d RED (a stale list claiming to be current — and ONLY P16d, which is
//   what makes it the check that owns the honesty claim).
// MUTATION-TESTED: dropping the `force` bypass in discoverModels (so ?refresh=1 re-serves the
//   TTL cache) → P16b + P16e RED (the changed answer never reaches the client).
// MUTATION-TESTED: returning the raw `listModels` result instead of the discovered one (no
//   cache, no labels) → P16, P16b, P16c, P16d, P16e RED (`source`/`stale` absent, so the UI
//   could not qualify anything).
// MUTATION-TESTED: restoring the prose refusal for a PENDING row ('provider is not activated
//   yet — activate it to list models') → P16g RED.
// MUTATION-TESTED: deleting the freshClaudeSubscriptionToken lookup so the route lists with the
//   STORED subscription token → P16h RED (the wire carries the stale copy).
// MUTATION-TESTED: dropping the tenant from the model-cache key (`cacheKey = String(key)`)
//   → P16i RED.
// MUTATION-TESTED: making invalidateModelCatalog a total no-op → P16j RED (a rotated key keeps
//   serving the previous credential's roster for the whole TTL).
//   ⚠️ Both of those last two were demonstrated GREEN before P16i/P16j existed: the tenant-scope
//   claim and all four invalidation call sites had NO check under them, invisible because
//   _resetModelCatalogForTests clears the Map directly instead of going through the exported
//   invalidator. A comment asserting a security property with no gate beneath it is exactly
//   M-001 (independent review ×2).
{
  const U4 = 'd074-user';
  try { await db.users.create(U4, 'D074'); } catch { /* row may exist */ }
  _resetModelCatalogForTests();

  // A fetch we CONTROL: `answer` is swapped between calls, so the route's output must follow it.
  let answer = { ok: true, ids: ['claude-opus-5', 'claude-sonnet-4-6'] };
  const KEY = 'GOODKEY-D074-SECRET';
  const seenAuth = [];
  const listFetch = async (_url, opts) => {
    const h = opts?.headers || {};
    seenAuth.push(String(h.authorization || h.Authorization || h['x-api-key'] || ''));
    if (!answer.ok) return { ok: false, status: answer.status || 401, async text() { return '{}'; }, async json() { return {}; } };
    return { ok: true, status: 200, async text() { return '{}'; }, async json() { return { data: answer.ids.map((id) => ({ id })) }; } };
  };
  const app4 = express(); app4.use(express.json());
  app4.use('/api/v1/portal', portalProvidersRouter({ db, userId: U4, fetch: listFetch }));
  const s4 = await new Promise((r) => { const x = app4.listen(0, '127.0.0.1', () => r(x)); });
  const base4 = `http://127.0.0.1:${s4.address().port}/api/v1/portal`;
  const post4 = (pth, b) => fetch(base4 + pth, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
  // ⚠️ P16j needs a PUT bound to THIS app (userId U4). The first draft reused the outer `put`,
  // which targets the local-user router — so the update landed on a different user's row, the
  // cache was never invalidated for U4, and the check went RED for a reason that had nothing to
  // do with the product. It found its own fixture bug before it found anything else.
  const put4 = (pth, b) => fetch(base4 + pth, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
  const get4 = (pth) => fetch(base4 + pth);

  const made = await J(await post4('/providers', { provider: 'anthropic', label: 'Claude API', api_key: KEY }));
  const pid = made.body.id;

  let m = await J(await get4(`/providers/${pid}/models`));
  rec('P16. GET /providers/:id/models returns the PROVIDER\'s list, labelled live (D-074)',
    m.body.ok === true && m.body.source === 'live' && m.body.stale === false
    && JSON.stringify(m.body.models) === JSON.stringify(['claude-opus-5', 'claude-sonnet-4-6']),
    `source=${m.body.source} stale=${m.body.stale} models=${JSON.stringify(m.body.models)}`);

  // P16b — DERIVED, not literal. Change what the provider answers; a forced refresh must follow
  // it. A hardcoded roster (or a cache with no bypass) cannot produce the new set.
  answer = { ok: true, ids: ['claude-opus-6', 'zzz-experimental-1'] };
  const cached = await J(await get4(`/providers/${pid}/models`));
  const forced = await J(await get4(`/providers/${pid}/models?refresh=1`));
  rec('P16b. the list is DERIVED from the provider response, not a literal roster',
    JSON.stringify(forced.body.models) === JSON.stringify(['claude-opus-6', 'zzz-experimental-1'])
    && forced.body.source === 'live',
    `forced=${JSON.stringify(forced.body.models)} source=${forced.body.source}`);
  // P16c — and the un-forced read in between was served from CACHE (so the picker does not hit
  // the provider on every render) and SAID so — 'cache', never 'live'.
  rec('P16c. an un-forced read inside the TTL is served from cache and LABELLED cache',
    cached.body.source === 'cache' && cached.body.stale === false
    && JSON.stringify(cached.body.models) === JSON.stringify(['claude-opus-5', 'claude-sonnet-4-6']),
    `source=${cached.body.source} stale=${cached.body.stale} models=${JSON.stringify(cached.body.models)}`);

  // P16d — the FAILURE path. Nothing cached (fresh row) + the provider rejects ⇒ a usable floor
  // that is explicitly NOT current. `ok:false` + `stale:true` + a category error, never a
  // silently-served list that looks live.
  _resetModelCatalogForTests();
  answer = { ok: false, status: 401 };
  const failed = await J(await get4(`/providers/${pid}/models`));
  rec('P16d. an UNLISTABLE provider yields an honest state — never a stale list dressed as live',
    failed.body.ok === false && failed.body.stale === true && failed.body.source === 'fallback'
    && failed.body.error === 'auth_rejected' && Array.isArray(failed.body.models) && failed.body.models.length > 0,
    `ok=${failed.body.ok} source=${failed.body.source} stale=${failed.body.stale} error=${failed.body.error} n=${failed.body.models?.length}`);

  // P16e — a WARM cache + a failing refresh keeps the last real answer, still marked stale.
  // (The user's own account listed those models; they are just older. Saying so is the contract.)
  _resetModelCatalogForTests();
  answer = { ok: true, ids: ['claude-opus-5'] };
  await get4(`/providers/${pid}/models`);
  answer = { ok: false, status: 500 };
  const warm = await J(await get4(`/providers/${pid}/models?refresh=1`));
  rec('P16e. a failed REFRESH over a warm cache serves the old list but marks it stale + why',
    warm.body.ok === false && warm.body.source === 'cache' && warm.body.stale === true
    && warm.body.error === 'provider_error' && JSON.stringify(warm.body.models) === JSON.stringify(['claude-opus-5']),
    `ok=${warm.body.ok} source=${warm.body.source} stale=${warm.body.stale} error=${warm.body.error}`);

  // P16g — the PENDING refusal is an honest state too, and a CATEGORY not prose. verify:
  // provider-import P12d already pins the security property (a pending row causes NO outbound
  // fetch); this pins that the REFUSAL is not mistaken for a live empty list, and that its
  // `error` is a token the client can map to the one remedy the user has ("activate it"). The
  // route shipped prose here, which fell through the client's category map to a generic
  // "unavailable" and lost that remedy (independent review, LOW).
  {
    const pend = await J(await post4('/providers', { provider: 'anthropic', label: 'Pending', api_key: 'GOODKEY-PEND' }));
    await db.providers.update(pend.body.id, U4, { status: 'pending' });
    const pr = await J(await get4(`/providers/${pend.body.id}/models`));
    rec('P16g. a PENDING row refuses with an honest state + a CATEGORY error, never prose',
      pr.body.ok === false && pr.body.stale === true && pr.body.error === 'not_activated'
      && !/\s/.test(String(pr.body.error)),
      `ok=${pr.body.ok} stale=${pr.body.stale} error=${JSON.stringify(pr.body.error)}`);
  }

  // ── P16h (review MED) — the SUBSCRIPTION listing uses the LIVE token, not the stored one ──
  // The stored copy goes stale within hours (D-021: `claude` refreshes into a config-dir-
  // namespaced Keychain item, never back into the DB row), so listing with it 401s on any vault
  // older than a few hours — which silently demoted "the list is the provider's answer" to the
  // MODEL_REGISTRY floor for the exact case D-074 was filed about. Driven with an INJECTED
  // reader (no Keychain, no `claude`): the header must carry the fresh token.
  {
    _setSubscriptionTokenReaderForTests(async () => ({ claudeOAuthToken: 'sk-ant-oat-FRESH' }));
    _resetModelCatalogForTests();
    const seen = [];
    const subFetch = async (_url, opts) => {
      seen.push(String((opts?.headers || {}).Authorization || (opts?.headers || {}).authorization || ''));
      return { ok: true, status: 200, async text() { return '{}'; }, async json() { return { data: [{ id: 'claude-opus-5' }] }; } };
    };
    const appS = express(); appS.use(express.json());
    appS.use('/api/v1/portal', portalProvidersRouter({
      db, userId: 'd074-sub', fetch: subFetch,
      importClaudeCli: async () => ({ claudeOAuthToken: 'sk-ant-oat-STORED-STALE', refreshToken: null, expiresAt: null, scopes: ['user:inference'], account: null }),
    }));
    const sS = await new Promise((r) => { const x = appS.listen(0, '127.0.0.1', () => r(x)); });
    const baseS = `http://127.0.0.1:${sS.address().port}/api/v1/portal`;
    try { await db.users.create('d074-sub', 'D074sub'); } catch { /* may exist */ }
    const impS = await J(await fetch(`${baseS}/auth/claude/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ acknowledgeToS: true }) }));
    const ms = await J(await fetch(`${baseS}/providers/${impS.body.id}/models`));
    rec('P16h. a SUBSCRIPTION lists with the LIVE token, never the stale stored copy (D-021 class)',
      seen.some((h) => h.includes('sk-ant-oat-FRESH')) && !seen.some((h) => h.includes('STORED-STALE'))
      && ms.body.ok === true && ms.body.source === 'live',
      `authSeen=${seen.map((h) => h.replace(/sk-ant-oat-/, '')).join(',')} source=${ms.body.source}`);
    await new Promise((r) => sS.close(r));
    _setSubscriptionTokenReaderForTests(null);
  }

  // ── P16i (review MED) — the cache is TENANT-SCOPED (CLAUDE.md §5) ─────────────────────────
  // Driven against discoverModels DIRECTLY, because the HTTP route cannot show this: db.providers
  // .get is user-scoped, so tenant B never reaches tenant A's row and the cross-tenant serve is
  // unobservable from outside. Dropping the tenant from the key left verify:providers GREEN with
  // zero FAILs — invisible because _resetModelCatalogForTests clears the Map directly. A claim in
  // a comment with no check under it is exactly what M-001 is about.
  {
    _resetModelCatalogForTests();
    const answers = ['tenant-a-model', 'tenant-b-model'];
    let n = 0;
    const listStub = async () => ({ ok: true, models: [answers[n++] || 'exhausted'] });
    const a = await discoverModels({ key: 77, userId: 'tenant-a', provider: 'anthropic', apiKey: 'A', list: listStub });
    const b = await discoverModels({ key: 77, userId: 'tenant-b', provider: 'anthropic', apiKey: 'B', list: listStub });
    rec('P16i. the model cache is TENANT-scoped — the same row id under another user re-discovers',
      JSON.stringify(a.models) === JSON.stringify(['tenant-a-model'])
      && JSON.stringify(b.models) === JSON.stringify(['tenant-b-model']) && b.source === 'live',
      `a=${JSON.stringify(a.models)} b=${JSON.stringify(b.models)} b.source=${b.source}`);
  }

  // ── P16j (review MED) — invalidation is REAL, driven through the route ───────────────────
  // The security rationale on the PUT handler is "a new key means a DIFFERENT account's model
  // list — drop the cached one rather than serving the previous credential's roster for up to the
  // TTL". Making invalidateModelCatalog a total no-op left the suite GREEN. This drives it: warm
  // the cache, change the KEY, then read WITHOUT ?refresh — the answer must be the new
  // credential's, not the old one's.
  {
    _resetModelCatalogForTests();
    answer = { ok: true, ids: ['old-credential-model'] };
    const warm = await J(await get4(`/providers/${pid}/models`));
    answer = { ok: true, ids: ['new-credential-model'] };
    await put4(`/providers/${pid}`, { api_key: 'GOODKEY-ROTATED' });
    const after = await J(await get4(`/providers/${pid}/models`));   // NOT forced
    rec('P16j. rotating the KEY invalidates the cached list — no serving the old credential\'s roster',
      JSON.stringify(warm.body.models) === JSON.stringify(['old-credential-model'])
      && JSON.stringify(after.body.models) === JSON.stringify(['new-credential-model'])
      && after.body.source === 'live',
      `warm=${JSON.stringify(warm.body.models)} after=${JSON.stringify(after.body.models)} source=${after.body.source}`);
  }

  // P16f — CLAUDE.md §1/§4: the credential is used for the listing call and never comes back.
  rec('P16f. the listing call carries the key but NO response ever echoes it',
    seenAuth.some((a) => a.includes(KEY))
    && ![m, cached, forced, failed, warm].some((r) => JSON.stringify(r.body).includes(KEY)),
    `keyUsed=${seenAuth.some((a) => a.includes(KEY))}`);

  await new Promise((r) => s4.close(r));
}

// ── P17 (D-075) — Settings renders the EFFECTIVE selection, from the RESOLVER ────────────────
//
// The defect: Settings → Intelligence highlighted a provider only when
// `settings.taskModels[task].providerId` named it, while the runtime resolved through
// `resolveEffectiveAssignment` (explicit assignment, ELSE the active provider). After #360
// (D-029) a connected subscription auto-selects for chat + narration WITHOUT writing
// taskModels — so the runtime ran Claude while Settings showed nothing chosen.
//
// GET /providers/effective-models now answers with the resolver's own function. These checks
// drive BOTH ends over the same vault and require them to AGREE — the endpoint's providerId
// must be the row the REAL `resolveInferenceConfigForTask` resolved to, per task.
//
// MUTATION-TESTED: making resolveEffectiveAssignment skip the active-provider fallback for a
//   task (i.e. re-implementing the pre-fix screen rule) → P17a, P17b, P17c RED (chat/narrate
//   report providerId null; P15e/P15f red too, because it is the same code the runtime uses —
//   which is the point of the fix).
// MUTATION-TESTED: dropping the explicit-assignment branch from resolveEffectiveAssignment
//   → P17b RED (an explicit choice reports as the active provider instead; P15g/P15h red too).
// MUTATION-TESTED: making the route WRITE the resolved provider into settings.taskModels
//   ("make Settings show it by storing it") → P17a2, P17b, P17d RED.
//   ⚠️ P17d only reds since it moved to its OWN fresh vault — see the note at P17d. With the
//   earlier shared-vault version this mutation left P17d GREEN.
{
  const U5 = 'd075-user';
  try { await db.users.create(U5, 'D075'); } catch { /* row may exist */ }
  _setSubscriptionTokenReaderForTests(async () => ({}));
  const app5 = express(); app5.use(express.json());
  app5.use('/api/v1/portal', portalProvidersRouter({
    db, userId: U5, fetch: mockFetch,
    importClaudeCli: async () => ({ claudeOAuthToken: 'sk-ant-oat-D075', refreshToken: null, expiresAt: null, scopes: ['user:inference'], account: null }),
  }));
  const s5 = await new Promise((r) => { const x = app5.listen(0, '127.0.0.1', () => r(x)); });
  const base5 = `http://127.0.0.1:${s5.address().port}/api/v1/portal`;
  const post5 = (pth, b) => fetch(base5 + pth, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
  const get5 = (pth) => fetch(base5 + pth);

  const byok = await J(await post5('/providers', { provider: 'openai', label: 'Prior5', api_key: 'GOODKEY-P17', model_preference: 'gpt-4o-mini' }));
  const byokId = byok.body.id;
  const sub = await J(await post5('/auth/claude/import', { acknowledgeToS: true }));
  const subId = sub.body.id;   // auto-selects as active (D-029) WITHOUT writing taskModels

  // P17a — the auto-selected provider is REPORTED as the effective one, tagged 'active'.
  let eff = await J(await get5('/providers/effective-models'));
  const chat = eff.body.effective?.chat;
  const narrate = eff.body.effective?.narrate;
  rec('P17a. the effective selection reports the AUTO-selected provider (the D-075 divergence)',
    chat?.providerId === subId && chat?.source === 'active'
    && narrate?.providerId === subId && narrate?.source === 'active',
    `chat=${JSON.stringify(chat)} narrate=${JSON.stringify(narrate)} subId=${subId}`);
  // …and taskModels is genuinely EMPTY, so the pre-fix screen rule really would show nothing.
  const s0 = await db.users.getSettings(U5);
  rec('P17a2. …with NOTHING in taskModels — the old rule had no answer to give',
    !s0?.taskModels?.chat && !s0?.taskModels?.narrate,
    `taskModels=${JSON.stringify(s0?.taskModels || {})}`);

  // P17b — an EXPLICIT assignment overrides, and is tagged as such, so the screen can tell the
  // user WHY a provider is selected (pinned vs "your active provider").
  const put5 = (pth, b) => fetch(base5 + pth, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
  await put5('/providers/task-models', { task: 'narrate', providerId: byokId });
  eff = await J(await get5('/providers/effective-models'));
  const narrate2 = eff.body.effective?.narrate;
  const chat2 = eff.body.effective?.chat;
  rec('P17b. an EXPLICIT assignment is reported as source "explicit", and only for its own task',
    narrate2?.providerId === byokId && narrate2?.source === 'explicit'
    && chat2?.providerId === subId && chat2?.source === 'active',
    `narrate=${JSON.stringify(narrate2)} chat=${JSON.stringify(chat2)}`);

  // P17c — ⭐ ONE SOURCE OF TRUTH. For every reported task, the endpoint's providerId must be
  // the row the REAL resolver resolves to. Driven through resolveInferenceConfigForTask (the
  // inference-time path), compared against the row fetched by the reported id — not a string.
  const disagreements = [];
  for (const task of eff.body.tasks) {
    const e = eff.body.effective[task];
    const cfg = await resolveInferenceConfigForTask(db, U5, task);
    const row = e.providerId == null ? null : await db.providers.get(e.providerId, U5);
    // The row the ENDPOINT names must produce the config the RESOLVER returned. Identity via the
    // discriminators mapRowToConfig derives: auth type (subscription vs BYOK) + vendor + model.
    const rowIsSub = String(row?.auth_type || '').toLowerCase() === 'oauth';
    const cfgIsSub = cfg?.providerName === 'claude_subscription';
    const vendorOk = rowIsSub ? cfgIsSub : (String(row?.provider || '') === String(cfg?.providerName || ''));
    const modelOk = (row?.model_preference || null) === (cfg?.cloudModel ?? null);
    if (!row || !vendorOk || !modelOk) disagreements.push(`${task}: endpoint=${JSON.stringify(e)} resolver={providerName:${cfg?.providerName},cloudModel:${cfg?.cloudModel}} row={provider:${row?.provider},auth:${row?.auth_type},model:${row?.model_preference}}`);
  }
  rec('P17c. ⭐ the endpoint AGREES with the real resolver for every task (one source of truth)',
    disagreements.length === 0, disagreements.join(' | '));

  // P17d — DISPLAY, NEVER A WRITE. Reading the effective selection must not persist it: doing so
  // would silently convert "your active provider, for now" into a pin that survives the user
  // later changing their active provider.
  //
  // ⚠️ ON ITS OWN VAULT, and the FIRST read of it. The first draft snapshotted U5 — which the
  // checks above had already read from — so a route that wrote on read had ALREADY written by
  // the time the snapshot was taken, and before===after held: the mutation ("make the route
  // store what it resolved") left P17d GREEN and was caught only by its neighbours. A
  // before/after check is worthless if the "before" is taken after the damage. (Watched
  // failing to green during the mutation sweep — the M-001 pattern, one more time.)
  const U6 = 'd075-user-readonly';
  try { await db.users.create(U6, 'D075ro'); } catch { /* row may exist */ }
  const app6 = express(); app6.use(express.json());
  app6.use('/api/v1/portal', portalProvidersRouter({ db, userId: U6, fetch: mockFetch }));
  const s6 = await new Promise((r) => { const x = app6.listen(0, '127.0.0.1', () => r(x)); });
  const base6 = `http://127.0.0.1:${s6.address().port}/api/v1/portal`;
  await fetch(`${base6}/providers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'openai', label: 'RO', api_key: 'GOODKEY-RO', model_preference: 'gpt-4o' }) });
  const before = JSON.stringify((await db.users.getSettings(U6)) || {});
  const roEff = await J(await fetch(`${base6}/providers/effective-models`));
  const after = JSON.stringify((await db.users.getSettings(U6)) || {});
  rec('P17d. reading the effective selection WRITES NOTHING (display must not become a pin)',
    before === after && roEff.body.effective?.chat?.source === 'active',
    `before=${before} after=${after} chat=${JSON.stringify(roEff.body.effective?.chat)}`);
  await new Promise((r) => s6.close(r));

  // P17e — no credential crosses this boundary. The resolver's cfg carries the OAuth token; the
  // route projects {task, source, providerId, model} and nothing else.
  const raw = JSON.stringify(eff.body);
  rec('P17e. the effective-selection payload carries NO credential material',
    !/sk-ant-oat|GOODKEY|claudeOAuthToken|apiKey|credentials/i.test(raw),
    `payload=${raw.slice(0, 200)}`);

  await new Promise((r) => s5.close(r));
  _setSubscriptionTokenReaderForTests(null);
}

server.close(); close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — /portal/providers CRUD + setActive + connectivity probe + opt-in subscription import (fail-closed) + §4g toggle' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
