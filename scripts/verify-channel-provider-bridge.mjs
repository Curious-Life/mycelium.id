#!/usr/bin/env node
// verify:channel-provider-bridge — the channel agent follows the SELECTED app
// model. Against a REAL vault, with NO manual CHANNEL_* backend secrets set,
// asserts GET /api/v1/internal/channel-config DERIVES the daemon's agent backend
// from the active `ai_providers` row:
//   - local Ollama (:11434)        → routing.router=local + ollamaModel + ollamaUrl (no /v1)
//   - other OpenAI-compatible      → agent.openai{baseUrl,apiKey,model} + routing.router=openai
//   - native Anthropic             → agent.anthropicApiKey + model + routing.router=cloud
//   - a manual CHANNEL_* backend   → SUPPRESSES the derive (operator override wins)
// Plus the daemon-side wiring: applyChannelConfigToEnv → CHANNEL_OPENAI_*, and
// selectRuntime() picks the right backend. PASS/FAIL; exit 0 on GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { startRestServer } from '../src/server-rest.js';
import { applyMigrations } from '../src/db/migrate.js';
import { applyChannelConfigToEnv, loadConfig } from '../packages/channel-daemon/config.js';
import { selectRuntime } from '../packages/channel-daemon/agent/runtime.js';
import { resolveChatCompletionsUrl } from '../packages/channel-daemon/agent/backends/openai-compat.js';

const DB = 'data/verify-channel-provider-bridge.db';
const KCV = 'data/verify-channel-provider-bridge-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const USER = 'verify-user';
const REGOLO_KEY = 'sk-regolo-FAKE-key-never-leak';
const ANTH_KEY = 'sk-ant-FAKE-key-never-leak';
process.env.MYCELIUM_USER_ID = USER;

const ledger = [];
let allPass = true;
const rec = (n, p, d = '') => { allPass = allPass && !!p; ledger.push(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));

let vault;
try {
  vault = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1' });
  const u = vault.url;
  const cfgOf = async () => (await (await fetch(`${u}/api/v1/internal/channel-config`)).json());
  // Clear every provider row + deactivate, so each case starts from one active row.
  const reset = async () => { for (const r of await vault.db.providers.list(USER)) await vault.db.providers.remove(r.id, USER); };
  const activate = async (fields) => {
    await reset();
    const id = await vault.db.providers.create(USER, fields);
    await vault.db.providers.setActive(id, USER);
    return id;
  };

  // unit: URL normalisation (host / +/v1 / full all collapse to one endpoint).
  rec('PB0a. resolveChatCompletionsUrl: bare host', resolveChatCompletionsUrl('https://api.regolo.ai') === 'https://api.regolo.ai/v1/chat/completions');
  rec('PB0b. resolveChatCompletionsUrl: /v1', resolveChatCompletionsUrl('http://127.0.0.1:11434/v1') === 'http://127.0.0.1:11434/v1/chat/completions');
  rec('PB0c. resolveChatCompletionsUrl: full', resolveChatCompletionsUrl('https://x/v1/chat/completions') === 'https://x/v1/chat/completions');

  // ── B1: active LOCAL OLLAMA provider → local backend ──────────────────────
  await activate({ provider: 'custom', label: 'Local · gemma', authType: 'api_key', credentials: null, model: 'gemma4:12b', baseUrl: 'http://127.0.0.1:11434/v1' });
  let cc = await cfgOf();
  rec('PB1. local ollama → routing.router=local + model + ollamaUrl(no /v1)',
    cc.routing.router === 'local' && cc.routing.ollamaModel === 'gemma4:12b' && cc.routing.ollamaUrl === 'http://127.0.0.1:11434',
    JSON.stringify(cc.routing));
  let env = {}; applyChannelConfigToEnv(cc, env);
  rec('PB1b. selectRuntime(local) → ollama backend', /^ollama\(gemma4:12b/.test(selectRuntime(loadConfig(env))?.label || ''), selectRuntime(loadConfig(env))?.label);

  // ── B2: active OTHER OpenAI-compatible (Regolo) → openai-compat backend ────
  await activate({ provider: 'custom', label: 'Regolo', authType: 'api_key', credentials: JSON.stringify({ apiKey: REGOLO_KEY }), model: 'qwen3-coder', baseUrl: 'https://api.regolo.ai/v1' });
  cc = await cfgOf();
  rec('PB2. regolo → agent.openai{baseUrl,apiKey,model} + router=openai',
    cc.routing.router === 'openai' && cc.agent.openai?.baseUrl === 'https://api.regolo.ai/v1' && cc.agent.openai?.apiKey === REGOLO_KEY && cc.agent.openai?.model === 'qwen3-coder',
    JSON.stringify({ router: cc.routing.router, openai: { ...cc.agent.openai, apiKey: cc.agent.openai?.apiKey ? '<key>' : null } }));
  env = {}; applyChannelConfigToEnv(cc, env);
  rec('PB2b. applyChannelConfigToEnv → CHANNEL_OPENAI_*', env.CHANNEL_OPENAI_BASE_URL === 'https://api.regolo.ai/v1' && env.CHANNEL_OPENAI_API_KEY === REGOLO_KEY && env.CHANNEL_OPENAI_MODEL === 'qwen3-coder');
  rec('PB2c. selectRuntime(openai) → openai-compat backend', /^openai-compat\(qwen3-coder @ https:\/\/api\.regolo\.ai\/v1\)/.test(selectRuntime(loadConfig(env))?.label || ''), selectRuntime(loadConfig(env))?.label);

  // ── B3: active native Anthropic → cloud backend ───────────────────────────
  await activate({ provider: 'anthropic', label: 'Claude', authType: 'api_key', credentials: JSON.stringify({ apiKey: ANTH_KEY }), model: 'claude-sonnet-4-6', baseUrl: null });
  cc = await cfgOf();
  rec('PB3. anthropic → agent.anthropicApiKey + model + router=cloud',
    cc.routing.router === 'cloud' && cc.agent.anthropicApiKey === ANTH_KEY && cc.agent.model === 'claude-sonnet-4-6',
    `router=${cc.routing.router} key=${cc.agent.anthropicApiKey === ANTH_KEY}`);

  // ── B4: a MANUAL channel backend secret SUPPRESSES the derive ─────────────
  // Active provider is still Anthropic (from B3); pin a manual local model.
  await vault.db.secrets.set(USER, { key: 'CHANNEL_OLLAMA_MODEL', value: 'llama3.1', scope: 'personal', description: 'manual override' });
  cc = await cfgOf();
  rec('PB4. manual CHANNEL_OLLAMA_MODEL wins — no anthropic derive',
    cc.routing.ollamaModel === 'llama3.1' && cc.agent.anthropicApiKey === null && cc.routing.router === null,
    JSON.stringify({ ollamaModel: cc.routing.ollamaModel, anth: cc.agent.anthropicApiKey, router: cc.routing.router }));

  // ── B5: no active provider + no manual backend → capture-only (null derive) ─
  await vault.db.secrets.delete(USER, 'CHANNEL_OLLAMA_MODEL');
  await reset();
  cc = await cfgOf();
  const noBackend = !cc.agent.anthropicApiKey && !cc.agent.model && !cc.agent.openai && !cc.routing.ollamaModel && !cc.routing.router;
  rec('PB5. no provider + no manual → empty backend (daemon = capture-only)', noBackend, JSON.stringify({ agent: cc.agent, routing: { router: cc.routing.router, ollamaModel: cc.routing.ollamaModel } }));
  env = {}; applyChannelConfigToEnv(cc, env);
  rec('PB5b. selectRuntime(none) → null', selectRuntime(loadConfig(env)) === null);
} catch (err) {
  allPass = false;
  ledger.push(`FAIL  fatal: ${String(err?.stack || err?.message || err)}`);
} finally {
  if (vault?.server) await new Promise((r) => vault.server.close(r));
  if (typeof vault?.close === 'function') vault.close();
}

console.log(ledger.join('\n') + '\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO' : 'NO-GO'}  EXIT=${allPass ? 0 : 1}`);
process.exit(allPass ? 0 : 1);
