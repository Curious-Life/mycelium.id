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

r = await J(await get('/providers'));
const row = r.body.providers?.[0];
rec('P2. GET /providers lists it', r.body.ok && r.body.providers.length === 1 && row.provider === 'openai', JSON.stringify(row));
rec('P3. listing carries NO key fields', row && !('credentials' in row) && !('api_key' in row), `keys=${Object.keys(row || {}).join(',')}`);

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

r = await J(await post('/auth/claude', { label: 'x' }));
rec('P8. /auth/claude subscription OAuth fails closed (ToS)', r.status === 400 && /not supported/i.test(r.body.error || ''), JSON.stringify(r.body));

r = await J(await get('/auth/claude/status'));
rec('P9. /auth/claude/status → not authenticated (key-only)', r.body.ok && r.body.authenticated === false, JSON.stringify(r.body));

await del(`/providers/${id1}`);
r = await J(await get('/providers'));
rec('P10. DELETE removes the provider', !r.body.providers.some((p) => p.id === id1), `remaining=${r.body.providers.map((p) => p.id).join(',')}`);

server.close(); close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — /portal/providers CRUD + setActive + connectivity probe + ToS-safe auth stubs' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
