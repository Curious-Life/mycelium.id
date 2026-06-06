#!/usr/bin/env node
// verify:channel-groups — Phase 3 group binding. DI block (commands + inbound
// group routing) + a REAL-vault block (the internal telegram-group endpoints
// round-trip through the live db). PASS/FAIL; exit 0 on GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { startRestServer } from '../src/server-rest.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createVaultClient } from '../packages/channel-daemon/vault-client.js';
import { createCommandHandler } from '../packages/channel-daemon/commands.js';
import { createInboundHandler } from '../packages/channel-daemon/inbound.js';

const ledger = [];
let allPass = true;
const rec = (n, p, d = '') => { allPass = allPass && !!p; ledger.push(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const OWNER = '111';
const GROUP = '-1009999';
const groupMsg = (over = {}) => ({ messageId: '5', chatId: GROUP, chatType: 'supergroup', source: 'telegram-group', channelKind: 'telegram-group', content: 'hi team', voiceMode: false, fromId: OWNER, username: 'op', fromName: 'Op', chatTitle: 'Team', replyToMessageId: null, dateEpoch: 1, ...over });

// ── DI: command handler ──────────────────────────────────────────────────────
{
  const calls = { authorize: [], revoke: [], replies: [] };
  const vault = {
    authorizeTelegramGroup: async (a) => calls.authorize.push(a),
    revokeTelegramGroup: async (id) => calls.revoke.push(id),
    listTelegramGroups: async () => [{ id: GROUP, title: 'Team' }],
  };
  const sendReply = async (a) => calls.replies.push(a);
  const cmd = createCommandHandler({ vault, sendReply, ownerTelegramId: OWNER });

  rec('GR1. /allow in a group authorizes it + acks', await cmd.handle(groupMsg({ content: '/allow' })) === true && calls.authorize.length === 1 && String(calls.authorize[0].id) === GROUP && calls.replies.length === 1);
  rec('GR2. /allow in a DM does NOT authorize (guidance only)', await cmd.handle({ ...groupMsg({ content: '/allow' }), channelKind: 'telegram', chatId: OWNER }) === true && calls.authorize.length === 1);
  rec('GR3. /disallow in a group revokes it', await cmd.handle(groupMsg({ content: '/disallow' })) === true && calls.revoke.length === 1 && String(calls.revoke[0]) === GROUP);
  rec('GR4. /channels lists authorized groups', await cmd.handle(groupMsg({ content: '/channels' })) === true && /Team/.test(calls.replies[calls.replies.length - 1].text));
  rec('GR5. /@botname suffix is stripped', await cmd.handle(groupMsg({ content: '/allow@myc_bot' })) === true && calls.authorize.length === 2);

  // non-owner command: swallowed (consumed) but no side effects
  const before = calls.authorize.length;
  rec('GR6. non-owner command swallowed, no side effects', await cmd.handle(groupMsg({ content: '/allow', fromId: '999' })) === true && calls.authorize.length === before);
  rec('GR7. non-command → not handled', await cmd.handle(groupMsg({ content: 'just chatting' })) === false);
}

// ── DI: inbound group routing ────────────────────────────────────────────────
{
  const captured = [];
  const turns = [];
  const vault = { captureMessage: async (a) => captured.push(a) };
  let authorized = false;
  const cmds = { isCommand: (c) => c.trim().startsWith('/'), handle: async () => { authorized = true; return true; } };
  const handle = createInboundHandler({
    vault, ownerTelegramId: OWNER, runTurn: (ctx) => turns.push(ctx),
    commands: cmds, isGroupAuthorized: async () => authorized,
  });

  // unauthorized group message → dropped
  await handle(groupMsg({ content: 'before allow' }));
  rec('GR8. unauthorized group message dropped (no capture/turn)', captured.length === 0 && turns.length === 0);

  // owner /allow command → handled (authorizes), not captured, not turned
  await handle(groupMsg({ content: '/allow' }));
  rec('GR9. /allow handled as command, not captured/turned', authorized === true && captured.length === 0 && turns.length === 0);

  // now an authorized group message → captured + turned
  await handle(groupMsg({ content: 'after allow' }));
  rec('GR10. authorized group message captured + turned', captured.length === 1 && captured[0].source === 'telegram-group' && turns.length === 1 && turns[0].channelKind === 'telegram-group');
}

// ── REAL vault: internal telegram-group endpoints round-trip ──────────────────
const DB = 'data/verify-channel-groups.db';
const KCV = 'data/verify-channel-groups-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
process.env.MYCELIUM_USER_ID = 'verify-user';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));

let vault;
try {
  vault = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1' });
  const vc = createVaultClient({ baseUrl: vault.url });

  rec('GR11. unbound group → authorized:false', (await vc.getTelegramGroup(GROUP)).authorized === false);
  await vc.authorizeTelegramGroup({ id: GROUP, title: 'Team' });
  const g = await vc.getTelegramGroup(GROUP);
  rec('GR12. authorize → authorized:true + active + title', g.authorized === true && g.active === true && g.title === 'Team', `g=${JSON.stringify(g)}`);
  rec('GR13. list includes the authorized group', (await vc.listTelegramGroups()).some((x) => String(x.id) === GROUP));
  await vc.revokeTelegramGroup(GROUP);
  rec('GR14. revoke → authorized:false (soft delete)', (await vc.getTelegramGroup(GROUP)).authorized === false);
} catch (err) {
  allPass = false;
  ledger.push(`FAIL  real-vault fatal: ${String(err?.stack || err?.message || err)}`);
} finally {
  if (vault?.server) await new Promise((r) => vault.server.close(r));
  if (typeof vault?.close === 'function') vault.close();
}

console.log(ledger.join('\n'));
console.log('='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO' : 'NO-GO'}  EXIT=${allPass ? 0 : 1}`);
process.exit(allPass ? 0 : 1);
