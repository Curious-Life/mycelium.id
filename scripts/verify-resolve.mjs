// verify:resolve — the provider-store → inference-router seam (S2). Boots a temp
// vault, creates providers via db.providers, and asserts resolveInferenceConfig
// maps the ACTIVE provider to the right router opts (anthropic vs openai), makes
// it authoritative over env (returns '' for the non-chosen vendor), defers
// base_url/custom providers (S3), and returns {} when none is active. PASS/FAIL.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { resolveInferenceConfig } from '../src/inference/resolve.js';
import { createInferenceRouter } from '../src/inference/router.js';

const DB = 'data/verify-resolve.db', KCV = 'data/verify-resolve-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// none configured → {} (router falls back to env/local)
let cfg = await resolveInferenceConfig(db, U);
rec('R1. no active provider → empty config (env/local fallback)', cfg && cfg.anthropicApiKey === undefined && cfg.openaiApiKey === undefined, JSON.stringify(cfg));

// active OpenAI → openaiApiKey + model; anthropic '' (authoritative over env)
const oid = await db.providers.create(U, { provider: 'openai', authType: 'api_key', credentials: JSON.stringify({ apiKey: 'sk-openai-AAA' }), model: 'gpt-4o-mini' });
await db.providers.setActive(oid, U);
cfg = await resolveInferenceConfig(db, U);
rec('R2. active OpenAI → openaiApiKey + model; anthropic blocked ("")', cfg.openaiApiKey === 'sk-openai-AAA' && cfg.cloudModel === 'gpt-4o-mini' && cfg.anthropicApiKey === '', JSON.stringify({ ...cfg, openaiApiKey: cfg.openaiApiKey ? '<set>' : cfg.openaiApiKey }));

// the chosen config makes the router report the right backend + never falls back to a stray env key
const router = createInferenceRouter({ ...cfg, env: { ANTHROPIC_API_KEY: 'sk-ant-STRAY' } });
rec('R3. configured OpenAI wins over a stray env ANTHROPIC_API_KEY', router.config.openaiConfigured === true && router.config.anthropicConfigured === false, JSON.stringify(router.config));

// active Anthropic (most-recently-used) → anthropicApiKey + model
const aid = await db.providers.create(U, { provider: 'anthropic', authType: 'api_key', credentials: JSON.stringify({ apiKey: 'sk-ant-BBB' }), model: 'claude-sonnet-4-6' });
await db.providers.setActive(aid, U);
await db.providers.update(aid, U, { last_used_at: new Date().toISOString() });
cfg = await resolveInferenceConfig(db, U);
rec('R4. active Anthropic (most-recent) → anthropicApiKey + model; openai blocked', cfg.anthropicApiKey === 'sk-ant-BBB' && cfg.cloudModel === 'claude-sonnet-4-6' && cfg.openaiApiKey === '', JSON.stringify({ ...cfg, anthropicApiKey: cfg.anthropicApiKey ? '<set>' : cfg.anthropicApiKey }));

// custom/base_url provider → deferred to S3 (not mapped → {} so we don't mis-route)
await db.providers.remove(aid, U); await db.providers.remove(oid, U);
const cid = await db.providers.create(U, { provider: 'custom', authType: 'api_key', credentials: JSON.stringify({ apiKey: 'k' }), baseUrl: 'https://api.regolo.ai', model: 'x' });
await db.providers.setActive(cid, U);
cfg = await resolveInferenceConfig(db, U);
rec('R5. custom/base_url provider NOT mapped yet (deferred to S3)', cfg.anthropicApiKey === undefined && cfg.openaiApiKey === undefined, JSON.stringify(cfg));

// sanity: the resolved config never carries the raw credentials blob
rec('R6. resolve returns only key fields, never the credentials blob', !('credentials' in cfg), Object.keys(cfg).join(',') || '(empty)');

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — provider store resolves into router config (anthropic/openai authoritative, custom deferred, none→env)' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
