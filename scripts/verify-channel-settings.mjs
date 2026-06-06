#!/usr/bin/env node
// verify:channel-settings — the portal Channels/Voice backend + the daemon
// channel-config bridge, end-to-end against a REAL vault. Asserts:
//   - PUT/GET /portal/channels round-trips (enabled, telegram token/owner, agent key/model)
//   - PUT/GET /portal/settings/tts round-trips (provider, key, voice, model, catalogs)
//   - GET responses are ZERO-LEAK (hasX booleans, never the secret values)
//   - GET /api/v1/internal/channel-config returns the DECRYPTED values (loopback)
//   - applyChannelConfigToEnv hydrates process.env exactly
//   - groups: authorize → GET lists → DELETE revokes
// PASS/FAIL; exit 0 on GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { startRestServer } from '../src/server-rest.js';
import { applyMigrations } from '../src/db/migrate.js';
import { applyChannelConfigToEnv } from '../packages/channel-daemon/config.js';
import { createVaultClient } from '../packages/channel-daemon/vault-client.js';

const DB = 'data/verify-channel-settings.db';
const KCV = 'data/verify-channel-settings-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const USER = 'verify-user';
const TOKEN = '7654321:FAKE-bot-token-value-should-never-leak';
const AKEY = 'sk-ant-FAKE-assistant-key-never-leak';
const OKEY = 'sk-FAKE-openai-tts-key-never-leak';
const DTOKEN = 'FAKE.discord.bot.token-never-leak';
const GROUP = '-100424242';
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
  const vc = createVaultClient({ baseUrl: u });
  const get = async (p) => { const r = await fetch(`${u}${p}`); return { status: r.status, json: await r.json().catch(() => null) }; };
  const send = async (p, method, body) => { const r = await fetch(`${u}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };

  // ── channels: initial empty ───────────────────────────────────────────────
  let r = await get('/api/v1/portal/channels');
  rec('CS1. GET /portal/channels initial → empty/disabled', r.status === 200 && r.json.enabled === false && r.json.telegram.hasToken === false && Array.isArray(r.json.groups) && r.json.groups.length === 0, `status=${r.status}`);

  // ── channels: PUT then GET ────────────────────────────────────────────────
  r = await send('/api/v1/portal/channels', 'PUT', { enabled: true, telegram: { token: TOKEN, ownerId: '555' }, discord: { token: DTOKEN, ownerId: '777' }, agent: { apiKey: AKEY, model: 'claude-sonnet-4-6' } });
  rec('CS2. PUT /portal/channels → ok', r.status === 200 && r.json.ok === true);
  r = await get('/api/v1/portal/channels');
  rec('CS3. GET reflects saved state (telegram + discord + agent)', r.json.enabled === true && r.json.telegram.hasToken === true && r.json.telegram.ownerId === '555' && r.json.discord.hasToken === true && r.json.discord.ownerId === '777' && r.json.agent.hasKey === true && r.json.agent.model === 'claude-sonnet-4-6');
  rec('CS4. ZERO-LEAK — channels GET never returns token/key values', !JSON.stringify(r.json).includes(TOKEN) && !JSON.stringify(r.json).includes(DTOKEN) && !JSON.stringify(r.json).includes(AKEY));

  // ── tts: PUT then GET ─────────────────────────────────────────────────────
  r = await send('/api/v1/portal/settings/tts', 'PUT', { provider: 'openai', openai: { apiKey: OKEY, voice: 'sage', model: 'tts-1-hd' } });
  rec('CS5. PUT /portal/settings/tts → ok', r.status === 200 && r.json.ok === true);
  r = await get('/api/v1/portal/settings/tts');
  rec('CS6. GET tts reflects provider/voice + hasKey + catalogs', r.json.provider === 'openai' && r.json.openai.hasKey === true && r.json.openai.voice === 'sage' && Array.isArray(r.json.openai.voices) && r.json.openai.voices.length === 9);
  rec('CS7. ZERO-LEAK — tts GET never returns the key', !JSON.stringify(r.json).includes(OKEY));
  rec('CS8. tts enabled true (provider + key set)', r.json.enabled === true);

  // ── internal channel-config: DECRYPTED for the daemon ─────────────────────
  r = await get('/api/v1/internal/channel-config');
  const cc = r.json;
  rec('CS9. channel-config returns decrypted telegram + discord tokens', cc.telegram.botToken === TOKEN && cc.telegram.ownerId === '555' && cc.discord.botToken === DTOKEN && cc.discord.ownerId === '777', `tg=${cc?.telegram?.botToken === TOKEN} dc=${cc?.discord?.botToken === DTOKEN}`);
  rec('CS10. channel-config returns decrypted agent key + tts key', cc.agent.anthropicApiKey === AKEY && cc.tts.openaiApiKey === OKEY && cc.tts.provider === 'openai' && cc.tts.openaiVoice === 'sage');
  rec('CS11. channel-config enabled flag', cc.enabled === true);

  // ── daemon hydration ──────────────────────────────────────────────────────
  const env = {};
  applyChannelConfigToEnv(cc, env);
  rec('CS12. applyChannelConfigToEnv hydrates env exactly (telegram+discord+tts)', env.TELEGRAM_BOT_TOKEN === TOKEN && env.OWNER_TELEGRAM_ID === '555' && env.DISCORD_BOT_TOKEN === DTOKEN && env.OWNER_DISCORD_ID === '777' && env.ANTHROPIC_API_KEY === AKEY && env.OPENAI_API_KEY === OKEY && env.TTS_PROVIDER === 'openai' && env.OPENAI_TTS_VOICE === 'sage');

  // ── groups: authorize → list → revoke ─────────────────────────────────────
  await vault.db.telegramGroups.authorize(GROUP, 'Team', null, USER);
  r = await get('/api/v1/portal/channels');
  rec('CS13. authorized group appears in GET /portal/channels', r.json.groups.some((g) => String(g.id) === GROUP && g.title === 'Team'));
  r = await send(`/api/v1/portal/channels/groups/${encodeURIComponent(GROUP)}`, 'DELETE');
  rec('CS14. DELETE group → ok', r.status === 200 && r.json.ok === true);
  r = await get('/api/v1/portal/channels');
  rec('CS15. revoked group gone from GET', !r.json.groups.some((g) => String(g.id) === GROUP));

  // ── clearing a field ──────────────────────────────────────────────────────
  r = await send('/api/v1/portal/channels', 'PUT', { enabled: false, telegram: { ownerId: '' } });
  r = await get('/api/v1/portal/channels');
  rec('CS16. clearing ownerId (empty) removes it; enabled toggled off', r.json.telegram.ownerId === null && r.json.enabled === false && r.json.telegram.hasToken === true);

  // ── discord channel allowlist (identity_channels kind discord) ────────────
  const DCH = '5551234';
  rec('CS17. unauthorized discord channel → authority denied', (await vc.checkChannelAuthority({ kind: 'discord', id: DCH })).allowed === false);
  await vc.setDiscordChannel({ id: DCH, name: 'general', on: true });
  rec('CS18. authorize → authority allowed + listed', (await vc.checkChannelAuthority({ kind: 'discord', id: DCH })).allowed === true && (await vc.listDiscordChannels()).some((c) => String(c.id) === DCH && c.name === 'general'));
  rec('CS19. GET /portal/channels exposes discordChannels', (await get('/api/v1/portal/channels')).json.discordChannels.some((c) => String(c.id) === DCH));
  await vc.setDiscordChannel({ id: DCH, name: 'general', on: false });
  rec('CS20. disallow → authority denied again', (await vc.checkChannelAuthority({ kind: 'discord', id: DCH })).allowed === false);

  // ── auto-router inference-egress audit (hash-only, reuses inference sink) ──
  const okRec = await vc.recordInferenceEgress({ decision: 'allowed', reason: 'auto:complex→cloud', contentHash: 'abc123', contentLength: 42, jurisdiction: 'cloud' });
  rec('CS21. inference-egress audit accepts hash-only record', okRec.ok === true);
  const leak = await fetch(`${u}/api/v1/internal/inference-egress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'allowed', contentHash: 'x', contentLength: 1, content: 'PLAINTEXT' }) });
  rec('CS22. inference-egress rejects a payload carrying plaintext', leak.status === 400);
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
