// verify:agent-capture — the consent control for auto-captured agent messages.
//
// Asserts the privacy-first, fail-closed gate in captureMessage: agent-source
// captures (claude-code/gateway/opencode/openclaw/hermes/bridge) are stored ONLY
// when the user has opted in (settings.agentCapture.enabled); non-agent ingest is
// never gated; redactSecrets scrubs credentials before write; and the portal
// GET/PUT /agent-capture route round-trips the preference.
import express from 'express';
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { captureMessage, isAgentSource, redactSecrets } from '../src/ingest/capture.js';
import { portalProvidersRouter } from '../src/portal-providers.js';

const hex = () => crypto.randomBytes(32).toString('hex');
const DB = 'data/verify-agent-capture.db', KCV = 'data/verify-agent-capture-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), embedder: null });
const U = 'local-user';
try { await db.users.create(U, U); } catch { /* exists */ }

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const stored = async (id) => (await db.messages.getContentMeta(U, id)).exists;
const cap = (m) => captureMessage(db, { userId: U, ...m });

// A — pure helpers
rec('A1. isAgentSource: agent sources true', ['claude-code', 'gateway:c1', 'opencode', 'openclaw', 'hermes', 'bridge'].every(isAgentSource));
rec('A2. isAgentSource: intentional/connector sources false', !['mcp', 'api', 'telegram', 'email', 'import', 'note'].some(isAgentSource));
rec('A3. redactSecrets scrubs a key', redactSecrets('here is sk-ant-ABCDEFGHIJKLMNOP1234 ok').includes('«redacted-secret»'));

// B — enforcement (default OFF)
let r = await cap({ source: 'claude-code', role: 'user', content: 'cc while disabled', id: 'b-off' });
rec('B1. agent source + no consent → blocked no-op', r.blocked === true && !(await stored('b-off')), JSON.stringify(r));
r = await cap({ source: 'telegram', role: 'user', content: 'telegram msg', id: 'b-tg' });
rec('B2. non-agent source stored regardless of consent', !r.blocked && r.deduped === false && (await stored('b-tg')), JSON.stringify(r));

// C — opt in
await db.users.updateSettings(U, { ...(await db.users.getSettings(U)), agentCapture: { enabled: true } });
r = await cap({ source: 'claude-code', role: 'assistant', content: 'cc after opt-in', id: 'c-on' });
rec('C1. agent source captured after opt-in', !r.blocked && r.deduped === false && (await stored('c-on')), JSON.stringify(r));

// D — redaction
await db.users.updateSettings(U, { ...(await db.users.getSettings(U)), agentCapture: { enabled: true, redactSecrets: true } });
await cap({ source: 'gateway:c1', role: 'assistant', content: 'my token sk-ant-SECRETKEY1234567890 stays out', id: 'd-red' });
const back = (await db.messages.getContentMeta(U, 'd-red')).content || '';
rec('D1. redactSecrets scrubs before write', back.includes('«redacted-secret»') && !back.includes('SECRETKEY1234567890'), back.slice(0, 60));

// E — portal GET/PUT round-trip
const app = express(); app.use(express.json());
app.use('/portal', portalProvidersRouter({ db, userId: U }));
const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
await fetch(`${base}/portal/agent-capture`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, redactSecrets: false }) });
let g = await (await fetch(`${base}/portal/agent-capture`)).json();
rec('E1. PUT disable → GET reflects + persists', g.enabled === false && (await db.users.getSettings(U)).agentCapture.enabled === false, JSON.stringify(g));
await fetch(`${base}/portal/agent-capture`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, redactSecrets: true }) });
g = await (await fetch(`${base}/portal/agent-capture`)).json();
rec('E2. PUT enable+redact → GET reflects', g.enabled === true && g.redactSecrets === true, JSON.stringify(g));
server.close();

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(68));
console.log(`VERDICT: ${allPass ? 'GO — agent-capture consent gate: default-off · non-agent unaffected · opt-in stores · redaction · portal round-trip' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(68));
process.exit(allPass ? 0 : 1);
