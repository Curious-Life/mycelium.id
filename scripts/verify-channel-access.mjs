#!/usr/bin/env node
// verify:channel-access — per-channel access policy (B1). Pure decideAccess truth
// table + a real-vault round-trip (set/get/decide) + encryption-at-rest of the
// allowlist. PASS/FAIL; exit 0 on GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { decideAccess } from '../src/db/channel-access.js';
import { startRestServer } from '../src/server-rest.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createInboundHandler } from '../packages/channel-daemon/inbound.js';
import { createDiscordInboundHandler } from '../packages/channel-daemon/discord-inbound.js';
import { createVaultClient } from '../packages/channel-daemon/vault-client.js';

const ledger = [];
let allPass = true;
const rec = (n, p, d = '') => { allPass = allPass && !!p; ledger.push(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const OWNER = '111';
process.env.MYCELIUM_USER_ID = 'verify-user'; // vault binds this userId at boot → secrets match

// ── pure decideAccess truth table ────────────────────────────────────────────
{
  // open → anyone
  rec('A1. open → stranger responds', decideAccess({ mode: 'open' }, '999', OWNER).respond === true);
  rec('A2. missing policy defaults to ALLOWLIST (stranger dropped, fail-closed)', decideAccess(null, '999', OWNER).respond === false && decideAccess(null, '999', OWNER).mode === 'allowlist');
  rec('A2b. missing policy default still responds to the OWNER', decideAccess(null, OWNER, OWNER).respond === true);
  // owner → only owner
  rec('A3. owner mode → owner responds', decideAccess({ mode: 'owner' }, OWNER, OWNER).respond === true);
  rec('A4. owner mode → stranger dropped', decideAccess({ mode: 'owner' }, '999', OWNER).respond === false);
  // allowlist → owner + listed
  rec('A5. allowlist → listed sender responds', decideAccess({ mode: 'allowlist', allowedSenders: ['222', '333'] }, '222', OWNER).respond === true);
  rec('A6. allowlist → owner always responds (implicit)', decideAccess({ mode: 'allowlist', allowedSenders: ['222'] }, OWNER, OWNER).respond === true);
  rec('A7. allowlist → unlisted stranger dropped', decideAccess({ mode: 'allowlist', allowedSenders: ['222'] }, '999', OWNER).respond === false);
  // numeric vs string sender coercion
  rec('A8. sender id type coercion (number vs string)', decideAccess({ mode: 'allowlist', allowedSenders: [222] }, 222, OWNER).respond === true);
}

// ── real vault: set/get/decide + encryption-at-rest ──────────────────────────
const DB = 'data/verify-channel-access.db';
const KCV = 'data/verify-channel-access-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));

let vault;
try {
  vault = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1' });
  const ca = vault.db.channelAccess;
  rec('A9. channelAccess wired into getDb', !!ca && typeof ca.set === 'function');

  await ca.set('discord', 'C1', { mode: 'allowlist', allowedSenders: ['222', '333'] });
  const got = await ca.get('discord', 'C1');
  rec('A10. set→get round-trips mode + allowlist', got.mode === 'allowlist' && got.allowedSenders.join() === '222,333', JSON.stringify(got));

  const d1 = await ca.decide('discord', 'C1', '222', OWNER);
  const d2 = await ca.decide('discord', 'C1', '999', OWNER);
  rec('A11. decide via vault: listed=allow, stranger=deny', d1.respond === true && d2.respond === false);

  // default (no row) → allowlist (fail-closed): stranger dropped, owner allowed
  rec('A12. unset channel decides allowlist default (stranger dropped)', (await ca.decide('discord', 'NOPE', '999', OWNER)).respond === false);
  rec('A12b. unset channel still responds to the owner', (await ca.decide('discord', 'NOPE', OWNER, OWNER)).respond === true);

  // encryption-at-rest: raw row ciphertext must NOT contain the plaintext ids
  const raw = new Database(DB, { readonly: true }).prepare('SELECT allowed_senders_json FROM channel_access WHERE channel_value = ?').get('C1');
  rec('A13. allowed_senders_json ENCRYPTED at rest (no plaintext ids in the row)', !!raw?.allowed_senders_json && !String(raw.allowed_senders_json).includes('222') && !String(raw.allowed_senders_json).includes('333'), `raw=${String(raw?.allowed_senders_json).slice(0, 24)}…`);

  // ── B2: real /api/v1/internal/channel-access decision endpoint ─────────────
  await vault.db.secrets.set('verify-user', { key: 'OWNER_TELEGRAM_ID', value: OWNER, scope: 'personal' });
  await vault.db.channelAccess.set('telegram-group', 'G1', { mode: 'allowlist', allowedSenders: ['222'] });
  const acc = async (kind, id, sender) => (await fetch(`${vault.url}/api/v1/internal/channel-access?kind=${kind}&id=${id}&sender=${sender}`)).json();
  rec('A14. endpoint: owner responds (implicit)', (await acc('telegram-group', 'G1', OWNER)).respond === true);
  rec('A15. endpoint: allowlisted sender responds', (await acc('telegram-group', 'G1', '222')).respond === true);
  rec('A16. endpoint: stranger dropped', (await acc('telegram-group', 'G1', '999')).respond === false);
  rec('A17. endpoint: unset channel → allowlist default (stranger dropped)', (await acc('telegram-group', 'OPEN', '999')).respond === false);

  // ── B2: daemon inbound sender filter (DI, fake checkChannelAccess) ─────────
  process.env.MYCELIUM_USER_ID = 'verify-user';
  const cap = []; const turns = [];
  const tgHandle = createInboundHandler({
    vault: { captureMessage: async (x) => cap.push(x) }, ownerTelegramId: OWNER,
    runTurn: (ctx) => turns.push(ctx), isGroupAuthorized: async () => true,
    checkChannelAccess: async (_k, _id, sender) => ({ respond: String(sender) === '222' }),
  });
  const gmsg = (fromId) => ({ messageId: '1', chatId: '-100', channelKind: 'telegram-group', source: 'telegram-group', content: 'hi team', fromId, dateEpoch: 1 });
  await tgHandle(gmsg('999'));
  rec('A18. telegram: authorized group + policy drops stranger', cap.length === 0 && turns.length === 0);
  await tgHandle(gmsg('222'));
  rec('A19. telegram: authorized group + policy passes allowed sender', cap.length === 1 && turns.length === 1);

  const dcap = []; const dturns = [];
  const dcHandle = createDiscordInboundHandler({
    vault: { captureMessage: async (x) => dcap.push(x) }, ownerDiscordId: OWNER,
    runTurn: (ctx) => dturns.push(ctx), isChannelAuthorized: async () => true,
    checkChannelAccess: async (_k, _id, sender) => ({ respond: String(sender) === '222' }),
  });
  const dmsg = (fromId) => ({ messageId: '1', chatId: 'C9', channelKind: 'discord', source: 'discord', content: 'hello', fromId, isBot: false });
  await dcHandle(dmsg('999'));
  rec('A20. discord: authorized channel + policy drops stranger', dcap.length === 0);
  await dcHandle(dmsg('222'));
  rec('A21. discord: authorized channel + policy passes allowed sender', dcap.length === 1);
  await dcHandle(dmsg(OWNER));
  rec('A22. discord: owner bypasses policy (always responds)', dcap.length === 2);
} catch (err) {
  allPass = false; ledger.push(`FAIL  fatal: ${String(err?.stack || err?.message || err)}`);
} finally {
  if (vault?.server) await new Promise((r) => vault.server.close(r));
  if (typeof vault?.close === 'function') vault.close();
}

console.log(ledger.join('\n') + '\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO' : 'NO-GO'}  EXIT=${allPass ? 0 : 1}`);
process.exit(allPass ? 0 : 1);
