// verify:app-bearer — the app auto-provisions a stable static MCP bearer.
//
// Asserts: resolveMcpBearer is env-first, else generate-once-and-persist (stable
// across calls), 64-char hex; matchStaticBearer honors an explicit expected token
// (the persisted bearer the server passes) AND the env path (back-compat); and a
// freshly-booted HTTP server with NO MYCELIUM_MCP_BEARER set still accepts the
// persisted bearer (and rejects a wrong one). So the installed app connects the
// hooks with zero manual setup.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { createHttpApp } from '../src/server-http.js';
import { applyMigrations } from '../src/db/migrate.js';
import { resolveMcpBearer } from '../src/remote/config.js';
import { matchStaticBearer, MIN_BEARER_LEN } from '../src/gateway/static-bearer.js';

const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// ── A — resolveMcpBearer ──────────────────────────────────────────────────────
const aDir = mkdtempSync(join(tmpdir(), 'mcpb-'));
const aEnv = { MYCELIUM_AUTH_DB: join(aDir, 'auth.db') };
const b1 = resolveMcpBearer({ env: aEnv });
const b2 = resolveMcpBearer({ env: aEnv });
rec('A1. generate-once + persisted (stable across calls)', typeof b1 === 'string' && b1 === b2 && /^[0-9a-f]{64}$/.test(b1), b1.slice(0, 8) + '…');
rec('A2. length ≥ floor', b1.length >= MIN_BEARER_LEN);
const envTok = 'env-set-' + 'y'.repeat(20);
rec('A3. env override wins', resolveMcpBearer({ env: { ...aEnv, MYCELIUM_MCP_BEARER: envTok } }) === envTok);
rec('A4. :memory: → ephemeral (not persisted, differs per call)', resolveMcpBearer({ env: { MYCELIUM_AUTH_DB: ':memory:' } }) !== resolveMcpBearer({ env: { MYCELIUM_AUTH_DB: ':memory:' } }));

// ── B — matchStaticBearer ─────────────────────────────────────────────────────
rec('B1. explicit expected token accepted', matchStaticBearer(`Bearer ${b1}`, {}, b1) === true);
rec('B2. wrong token rejected', matchStaticBearer(`Bearer ${hex()}`, {}, b1) === false);
rec('B3. env path still works (back-compat)', matchStaticBearer(`Bearer ${'a'.repeat(30)}`, { MYCELIUM_MCP_BEARER: 'a'.repeat(30) }) === true);
rec('B4. too-short expected → fail-closed', matchStaticBearer('Bearer short', {}, 'short') === false);

// ── C — server auto-provisions + accepts the persisted bearer (NO env bearer) ──
const sDir = mkdtempSync(join(tmpdir(), 'mcpb-srv-'));
const DB = join(sDir, 'mycelium.db'), KCV = join(sDir, 'kcv.json');
applyMigrations(new Database(DB));
const prevDataDir = process.env.MYCELIUM_DATA_DIR, prevBearer = process.env.MYCELIUM_MCP_BEARER;
process.env.MYCELIUM_DATA_DIR = sDir;       // auth.db → sDir/auth.db
delete process.env.MYCELIUM_MCP_BEARER;     // force auto-provision
const { app } = await createHttpApp({ bootOpts: { dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), embedder: null } });
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const provisioned = resolveMcpBearer();     // same process.env (sDir/auth.db) → the value the server resolved
const probe = (tok) => fetch(`${base}/context`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: '{}' }).then((r) => r.status);
rec('C1. server resolved a persisted 64-hex bearer (no env set)', /^[0-9a-f]{64}$/.test(provisioned), provisioned.slice(0, 8) + '…');
rec('C2. /context accepts the auto-provisioned bearer', (await probe(provisioned)) === 200, `status`);
rec('C3. /context rejects a wrong bearer (401)', (await probe(hex())) === 401);
server.close();
if (prevDataDir === undefined) delete process.env.MYCELIUM_DATA_DIR; else process.env.MYCELIUM_DATA_DIR = prevDataDir;
if (prevBearer !== undefined) process.env.MYCELIUM_MCP_BEARER = prevBearer;
for (const d of [aDir, sDir]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(66));
console.log(`VERDICT: ${allPass ? 'GO — app auto-provisions a stable static bearer: persisted, env-first, accepted by :4711 with zero manual setup' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(66));
process.exit(allPass ? 0 : 1);
