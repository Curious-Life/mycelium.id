#!/usr/bin/env node
// verify:channel-egress-e2e — Phase 0 END-TO-END: the REAL vault REST server
// (so the getDb wiring + internal router mount are exercised for real) + the
// REAL channel-daemon egress chokepoint talking to it over loopback HTTP, with
// only the Telegram Bot API faked.
//
// Proves the full Phase 0 contract:
//   - vault boots with egressAudit + identityChannels wired (no regression)
//   - GET /api/v1/internal/channel-authority is fail-closed (unbound → denied)
//   - binding a chat (delivery_enabled=1) flips authority to allowed
//   - a delivered send writes a REAL egress_audit row (decision/delivered) AND
//     a REAL outbound message row (role=assistant, source=telegram)
//   - an unbound target is denied 403 by the real authority endpoint
//   - the egress-audit endpoint rejects any payload carrying plaintext
//   - ZERO-PLAINTEXT: no egress_audit row contains the message body
// PASS/FAIL ledger; exit 0 only on full GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import { startRestServer } from '../src/server-rest.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createVaultClient } from '../packages/channel-daemon/vault-client.js';
import { createEnvelopeDedup } from '../packages/channel-daemon/dedup.js';
import { createTelegramChokepoint } from '../packages/channel-daemon/chokepoint.js';
import { createDaemonApp } from '../packages/channel-daemon/server.js';
import { createInboundHandler } from '../packages/channel-daemon/inbound.js';
import { normalizeUpdate } from '../packages/channel-daemon/transport/normalize.js';
import { getActiveTurn, setActiveTurn, _resetForTests } from '../packages/channel-daemon/inbound-context.js';

const DB = 'data/verify-channel-e2e.db';
const KCV = 'data/verify-channel-e2e-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const USER = 'verify-user';
const OWNER = '111';
const BOUND = '777';
const UNBOUND = '888';
const TEXT = 'Real end-to-end reply body that must never appear in any audit row.';

process.env.MYCELIUM_USER_ID = USER;

const ledger = [];
let allPass = true;
const check = (name, cond, d = '') => { const ok = !!cond; allPass = allPass && ok; ledger.push(`[${ok ? '✓' : '✗'}] ${name}${d ? ` — ${d}` : ''}`); };

for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));

let vault, daemonServer;
try {
  vault = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1' });
  check('E1. vault boots with channel namespaces wired', !!vault.url && !!vault.db?.egressAudit && !!vault.db?.identityChannels);

  // ── Daemon wired to the REAL vault, FAKE Telegram ─────────────────────────
  _resetForTests();
  const vc = createVaultClient({ baseUrl: vault.url });
  const sends = [];
  async function checkAuthority({ kind, id }) {
    if (String(id) === OWNER) return { allowed: true, reason: 'owner-bootstrap' };
    return vc.checkChannelAuthority({ kind, id });
  }
  const handler = createTelegramChokepoint({
    sendToTelegram: async (a) => { sends.push(a); return { sent: 1, total: 1, httpStatus: 200 }; },
    recordEgress: (e) => { vc.recordEgress(e); },
    persistOutbound: (a) => { vc.captureMessage(a).catch(() => {}); },
    checkAuthority,
    dedup: createEnvelopeDedup(),
    getActiveTurn,
    agentId: 'personal-agent',
  });
  const daemonApp = createDaemonApp({ telegramSendHandler: handler, getActiveTurn });
  daemonServer = http.createServer(daemonApp);
  const dport = await new Promise((r) => daemonServer.listen(0, '127.0.0.1', () => r(daemonServer.address().port)));
  const durl = `http://127.0.0.1:${dport}`;

  const dsend = (body, headers) => fetch(`${durl}/telegram/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

  // ── E2. real authority endpoint: unbound → denied ─────────────────────────
  const authUnbound = await vc.checkChannelAuthority({ kind: 'telegram', id: BOUND });
  check('E2. real authority: unbound chat → allowed:false (not-bound)', authUnbound.allowed === false && authUnbound.reason === 'not-bound', `reason=${authUnbound.reason}`);

  // ── E3. bind BOUND chat with delivery_enabled=1 → authority allows ─────────
  // (owner_user_id left NULL — authority keys on delivery_enabled + not-revoked,
  // not ownership; binding an owner would need a real users row / FK.)
  await vault.db.identityChannels.upsert({ channel_kind: 'telegram', channel_value: BOUND, display_name: 'bound chat' });
  await vault.db.identityChannels.setFlag('telegram', BOUND, 'delivery_enabled', true);
  const authBound = await vc.checkChannelAuthority({ kind: 'telegram', id: BOUND });
  check('E3. real authority: bound + delivery_enabled → allowed:true', authBound.allowed === true && authBound.reason === 'registry', `reason=${authBound.reason}`);

  // ── E4. owner-bootstrap send delivers ─────────────────────────────────────
  const r4 = await dsend({ chatId: OWNER, text: TEXT }, { 'x-egress-provenance': 'agent-explicit' });
  check('E4. owner send → 200 delivered + Telegram called', r4.status === 200 && r4.json?.delivered === true && sends.length === 1, `status=${r4.status} sends=${sends.length}`);

  // give the fire-and-forget audit + persist a tick to land
  await new Promise((r) => setTimeout(r, 150));

  // ── E5. a REAL egress_audit row was written ───────────────────────────────
  const auditRows = await vault.db.egressAudit.recent({ limit: 50 });
  const ownerAllowed = auditRows.find((row) => String(row.channel_id) === OWNER && row.decision === 'allowed');
  check('E5. real egress_audit row: allowed + delivered=1 for owner send', !!ownerAllowed && ownerAllowed.delivered === 1, `rows=${auditRows.length}`);
  check('E5b. audit row stores content_hash (sha256), not the body', ownerAllowed?.content_hash === crypto.createHash('sha256').update(TEXT, 'utf8').digest('hex'), `hash=${String(ownerAllowed?.content_hash).slice(0, 12)}…`);

  // ── E6. a REAL outbound message row was persisted ─────────────────────────
  const msgRows = await vault.db.rawQuery("SELECT role, source FROM messages WHERE source IN ('telegram','telegram-group')", []);
  const out = (msgRows.results || []).find((m) => m.role === 'assistant' && m.source === 'telegram');
  check('E6. real outbound message row persisted (assistant/telegram)', !!out, `telegram rows=${(msgRows.results || []).length}`);

  // ── E7. unbound non-owner target → 403 (real authority) + denied audit ────
  const r7 = await dsend({ chatId: UNBOUND, text: TEXT });
  check('E7. unbound target → 403 channel-authority-denied', r7.status === 403 && r7.json?.error === 'channel-authority-denied', `status=${r7.status}`);
  await new Promise((r) => setTimeout(r, 100));
  const denied = (await vault.db.egressAudit.recent({ limit: 50 })).find((row) => String(row.channel_id) === UNBOUND && row.decision === 'denied');
  check('E7b. denied send recorded a real egress_audit row', !!denied, `denied=${!!denied}`);

  // ── E8. bound non-owner target delivers via the registry path ─────────────
  const r8 = await dsend({ chatId: BOUND, text: `${TEXT} (to bound)` });
  check('E8. bound registry target → 200 delivered', r8.status === 200 && r8.json?.delivered === true, `status=${r8.status}`);

  // ── E8b. INBOUND capture over REST writes a real user message row ─────────
  _resetForTests();
  const inbound = createInboundHandler({
    vault: { captureMessage: (a) => vc.captureMessage(a) },
    ownerTelegramId: OWNER,
    runTurn: (ctx) => setActiveTurn(ctx),
  });
  const INBOUND_TEXT = 'inbound message from the operator over telegram';
  await inbound(normalizeUpdate({ update_id: 1, message: { message_id: 4242, date: 1717600000, chat: { id: Number(OWNER), type: 'private' }, from: { id: Number(OWNER), username: 'op', first_name: 'Op' }, text: INBOUND_TEXT } }));
  await new Promise((r) => setTimeout(r, 120));
  const inRows = await vault.db.rawQuery("SELECT id, role, source FROM messages WHERE role='user' AND source='telegram'", []);
  const inRow = (inRows.results || []).find((m) => m.id === `tg-4242-${OWNER}`);
  check('E8b. inbound captured as a real user/telegram row (idempotent id)', !!inRow, `id=${inRow?.id}`);
  check('E8c. inbound set the active turn the reply path reads', getActiveTurn()?.channelId === OWNER && getActiveTurn()?.inboundMessageId === '4242');

  // ── E9. egress-audit endpoint rejects plaintext (defense in depth) ────────
  const leakRes = await fetch(`${vault.url}/api/v1/internal/egress-audit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contentHash: 'x', contentLength: 1, channelId: '1', decision: 'allowed', content: 'PLAINTEXT' }) });
  check('E9. egress-audit endpoint 400s on a payload carrying plaintext', leakRes.status === 400);

  // ── E10. ZERO-PLAINTEXT sweep across every audit row ──────────────────────
  const all = await vault.db.egressAudit.recent({ limit: 100 });
  const leak = all.some((row) => JSON.stringify(row).includes(TEXT));
  check('E10. ZERO-PLAINTEXT — no egress_audit row contains the body', !leak, leak ? 'LEAK' : 'clean');
} catch (err) {
  allPass = false;
  ledger.push(`[✗] fatal: ${String(err?.stack || err?.message || err)}`);
} finally {
  if (daemonServer) await new Promise((r) => daemonServer.close(r));
  if (vault?.server) await new Promise((r) => vault.server.close(r));
  if (typeof vault?.close === 'function') vault.close();
}

process.stdout.write(ledger.join('\n') + '\n' + '='.repeat(64) + '\n');
process.stdout.write(`VERDICT: ${allPass ? 'GO' : 'NO-GO'}  EXIT=${allPass ? 0 : 1}\n`);
process.exit(allPass ? 0 : 1);
