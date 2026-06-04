// verify:cascade — the §4g multi-provider cascade (Slice C1).
//   CC1 resolveProviderChain orders eu-zdr → us → local + a local floor
//   CC2 sensitive → every us-* provider dropped
//   CC3 inferWithCascade fails over a dead provider to the next (each audited)
//   CC4 all cloud fail → on-box local floor serves
//   CC5 sensitive cascade NEVER touches a US provider
//   CC6 empty chain throws
// Boots a temp vault with 3 providers; a mock fetch routes by host. No real
// network; CWD-independent. Never logs a secret.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { resolveProviderChain } from '../src/inference/resolve.js';
import { inferWithCascade } from '../src/inference/cascade.js';

const DB = 'data/verify-cascade.db', KCV = 'data/verify-cascade-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';

// Three providers spanning the jurisdictions.
await db.providers.create(U, { provider: 'custom', label: 'EU', authType: 'api_key', credentials: JSON.stringify({ apiKey: 'EU_KEY' }), baseUrl: 'https://api.regolo.ai/v1' });          // eu-zdr
await db.providers.create(U, { provider: 'openai', label: 'US', authType: 'api_key', credentials: JSON.stringify({ apiKey: 'US_KEY' }) });                                              // us-standard
await db.providers.create(U, { provider: 'custom', label: 'Local', authType: 'api_key', credentials: null, baseUrl: 'http://127.0.0.1:11434/v1' });                                     // local

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

// ── mock fetch: route by host; per-host failure toggles ──────────────────────
let regoloCalls = 0, openaiCalls = 0, ollamaChatCalls = 0, ollamaGenCalls = 0;
const fail = { regolo: false, openai: false, ollamaChat: false };
const ok = (obj) => ({ ok: true, status: 200, async text() { return JSON.stringify(obj); }, async json() { return obj; } });
const err500 = () => ({ ok: false, status: 500, async text() { return JSON.stringify({ error: { type: 'server_error' } }); }, async json() { return { error: { type: 'server_error' } }; } });
const mockFetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/generate')) { ollamaGenCalls++; return ok({ response: 'LOCAL_HELLO' }); }
  if (u.includes('regolo.ai')) { regoloCalls++; return fail.regolo ? err500() : ok({ choices: [{ message: { content: 'EU_HELLO' } }] }); }
  if (u.includes('api.openai.com')) { openaiCalls++; return fail.openai ? err500() : ok({ choices: [{ message: { content: 'US_HELLO' } }] }); }
  if (u.includes('127.0.0.1')) { ollamaChatCalls++; return fail.ollamaChat ? err500() : ok({ choices: [{ message: { content: 'LOCALCFG_HELLO' } }] }); }
  return err500();
};

// ── CC1 — chain ordering ─────────────────────────────────────────────────────
{
  const chain = await resolveProviderChain(db, U);
  const jurs = chain.map((c) => c.jurisdiction);
  rec('CC1. chain ordered eu-zdr → us → local + local floor',
    jurs[0] === 'eu-zdr' && jurs[1] === 'us-standard' && jurs[2] === 'local' && chain[chain.length - 1].localFallback === true && chain.length === 4,
    JSON.stringify(jurs));
}

// ── CC2 — sensitive drops US ─────────────────────────────────────────────────
{
  const chain = await resolveProviderChain(db, U, { sensitive: true });
  const jurs = chain.map((c) => c.jurisdiction);
  rec('CC2. sensitive → no us-* in the chain', !jurs.some((j) => /^us/.test(j || '')) && jurs.includes('eu-zdr') && chain[chain.length - 1].localFallback === true,
    JSON.stringify(jurs));
}

// ── CC3 — failover: EU dead → US serves, both audited ────────────────────────
{
  fail.regolo = true; fail.openai = false; fail.ollamaChat = false;
  const egress = [];
  const chain = await resolveProviderChain(db, U);
  const out = await inferWithCascade({ chain, prompt: 'hi', task: 'complex', onEgress: (e) => egress.push(e), fetch: mockFetch });
  const allowed = egress.filter((e) => e.decision === 'allowed');
  rec('CC3. EU dead → US serves; each attempt audited (hash-only)',
    out === 'US_HELLO' && allowed.length === 2 && allowed.every((e) => /^[0-9a-f]{64}$/.test(e.contentHash)),
    `out=${out} allowed=${allowed.length} regolo=${regoloCalls} openai=${openaiCalls}`);
}

// ── CC4 — all cloud fail → local floor ───────────────────────────────────────
{
  fail.regolo = true; fail.openai = true; fail.ollamaChat = true;
  const before = ollamaGenCalls;
  const chain = await resolveProviderChain(db, U);
  const out = await inferWithCascade({ chain, prompt: 'hi', task: 'complex', fetch: mockFetch });
  rec('CC4. all cloud fail → on-box local floor serves', out === 'LOCAL_HELLO' && ollamaGenCalls === before + 1, `out=${out} gen+${ollamaGenCalls - before}`);
}

// ── CC5 — sensitive cascade never touches US ─────────────────────────────────
{
  fail.regolo = true; fail.openai = false; fail.ollamaChat = false;
  const openaiBefore = openaiCalls;
  const chain = await resolveProviderChain(db, U, { sensitive: true });
  const out = await inferWithCascade({ chain, prompt: 'secret', task: 'complex', sensitive: true, fetch: mockFetch });
  rec('CC5. sensitive cascade NEVER calls a US provider', openaiCalls === openaiBefore && out === 'LOCALCFG_HELLO', `out=${out} openai+${openaiCalls - openaiBefore}`);
}

// ── CC6 — empty chain throws ─────────────────────────────────────────────────
{
  let threw = false;
  try { await inferWithCascade({ chain: [], prompt: 'x', fetch: mockFetch }); } catch { threw = true; }
  rec('CC6. empty chain throws', threw);
}

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — cascade: eu→frontier→local ordering · sensitive US-drop · failover · local floor · per-attempt audit' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
