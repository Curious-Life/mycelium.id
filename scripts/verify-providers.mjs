// verify:providers — the /portal/providers* backend (the surface SettingsView
// calls). Mounts the real router on a throwaway express app over a temp vault and
// drives the full lifecycle: create → list (metadata only, no key) → setActive
// (one-active-per-type) → connectivity test (mocked fetch) → bad-key category →
// custom-needs-base_url → Claude-OAuth refused (ToS) → delete. PASS/FAIL ledger.
import express from 'express';
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { portalProvidersRouter } from '../src/portal-providers.js';
import { jurisdictionForBaseUrl } from '../src/inference/presets.js';

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

server.close(); close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — /portal/providers CRUD + setActive + connectivity probe + opt-in subscription import (fail-closed) + §4g toggle' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
