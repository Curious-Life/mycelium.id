// verify:resolve — the provider-store → inference-router seam (S2) + the
// OpenAI-compatible base_url widening + jurisdiction tagging (S3a). Boots a temp
// vault, drives resolveInferenceConfig over real ai_providers rows, and unit-
// checks jurisdictionForBaseUrl + cloudInfer's base_url routing (mock fetch).
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { resolveInferenceConfig } from '../src/inference/resolve.js';
import { createInferenceRouter } from '../src/inference/router.js';
import { jurisdictionForBaseUrl } from '../src/inference/presets.js';
import { cloudInfer } from '../src/inference/cloud.js';

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
rec('R1. no active provider → empty config (env/local fallback)', cfg.anthropicApiKey === undefined && cfg.openaiApiKey === undefined, JSON.stringify(cfg));

// active OpenAI → openaiApiKey + us-standard; anthropic '' (authoritative over env)
const oid = await db.providers.create(U, { provider: 'openai', authType: 'api_key', credentials: JSON.stringify({ apiKey: 'sk-openai-AAA' }), model: 'gpt-4o-mini' });
await db.providers.setActive(oid, U);
cfg = await resolveInferenceConfig(db, U);
rec('R2. active OpenAI → openaiApiKey + jurisdiction us-standard; anthropic blocked ("")', cfg.openaiApiKey === 'sk-openai-AAA' && cfg.anthropicApiKey === '' && cfg.cloudModel === 'gpt-4o-mini' && cfg.jurisdiction === 'us-standard', JSON.stringify({ ...cfg, openaiApiKey: '<set>' }));

// configured provider wins over a stray env key
const router = createInferenceRouter({ ...cfg, env: { ANTHROPIC_API_KEY: 'sk-ant-STRAY' } });
rec('R3. configured OpenAI wins over a stray env ANTHROPIC_API_KEY', router.config.openaiConfigured === true && router.config.anthropicConfigured === false, JSON.stringify({ openai: router.config.openaiConfigured, anthropic: router.config.anthropicConfigured }));

// active Anthropic → anthropicApiKey + us-standard
await db.providers.remove(oid, U);
const aid = await db.providers.create(U, { provider: 'anthropic', authType: 'api_key', credentials: JSON.stringify({ apiKey: 'sk-ant-BBB' }), model: 'claude-sonnet-4-6' });
await db.providers.setActive(aid, U);
cfg = await resolveInferenceConfig(db, U);
rec('R4. active Anthropic → anthropicApiKey + model; openai blocked', cfg.anthropicApiKey === 'sk-ant-BBB' && cfg.openaiApiKey === '' && cfg.cloudModel === 'claude-sonnet-4-6' && cfg.jurisdiction === 'us-standard', JSON.stringify({ ...cfg, anthropicApiKey: '<set>' }));

// S3a — EU-sovereign custom (base_url) → openai-compat + baseUrl + eu-zdr
await db.providers.remove(aid, U);
const rid = await db.providers.create(U, { provider: 'custom', label: 'Regolo', authType: 'api_key', credentials: JSON.stringify({ apiKey: 'rk-EU' }), baseUrl: 'https://api.regolo.ai/v1', model: 'some-eu-model' });
await db.providers.setActive(rid, U);
cfg = await resolveInferenceConfig(db, U);
rec('R5. custom EU base_url → openai-compat + baseUrl + jurisdiction eu-zdr', cfg.openaiApiKey === 'rk-EU' && cfg.baseUrl === 'https://api.regolo.ai/v1' && cfg.cloudModel === 'some-eu-model' && cfg.jurisdiction === 'eu-zdr', JSON.stringify({ ...cfg, openaiApiKey: '<set>' }));

// jurisdiction map unit checks
rec('R6. jurisdictionForBaseUrl: localhost → local', jurisdictionForBaseUrl('http://127.0.0.1:11434/v1') === 'local');
rec('R7. jurisdiction map: regolo→eu-zdr · openai→us-standard · none(anthropic)→us-standard', jurisdictionForBaseUrl('https://api.regolo.ai/v1') === 'eu-zdr' && jurisdictionForBaseUrl('https://api.openai.com/v1') === 'us-standard' && jurisdictionForBaseUrl(undefined, 'anthropic') === 'us-standard');

// cloudInfer routes to the configured base_url (mock fetch captures URL + auth)
let calledUrl = null, sentAuth = null;
const mockFetch = async (url, opts) => {
  calledUrl = url;
  sentAuth = opts?.headers?.Authorization || opts?.headers?.authorization || null;
  return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: 'ok' } }] }); } };
};
const out = await cloudInfer({ prompt: 'ping', openaiApiKey: 'rk-EU', baseUrl: 'https://api.regolo.ai/v1', model: 'm', fetch: mockFetch });
rec('R8. cloudInfer routes to the base_url (/chat/completions) + Bearer', calledUrl === 'https://api.regolo.ai/v1/chat/completions' && /^Bearer /.test(sentAuth || '') && out === 'ok', `url=${calledUrl}`);

// keyless local base_url (Ollama) → routed, no Authorization header
calledUrl = null; sentAuth = null;
await cloudInfer({ prompt: 'ping', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen', fetch: mockFetch });
rec('R9. keyless local base_url → routed, no Authorization header', calledUrl === 'http://127.0.0.1:11434/v1/chat/completions' && sentAuth === null, `url=${calledUrl} auth=${sentAuth}`);

// no raw credentials blob ever escapes the resolver
rec('R10. resolve returns only key/url/model/jurisdiction, never the credentials blob', !('credentials' in cfg), Object.keys(cfg).join(','));

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — provider store resolves + jurisdiction-tagged; OpenAI-compatible base_url widening routes (EU-sovereign/OpenRouter/Ollama)' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
