#!/usr/bin/env node
// verify:channel-agent-e2e — Phase 2 END-TO-END: the WHOLE two-way loop with
// only the LLM faked. REAL vault REST + REAL daemon (inbound handler → lane →
// chokepoint) + a fake "agent" runtime that does exactly what the reply tool
// does (POST the daemon's /telegram/send with the agent-explicit header).
// Telegram is faked at the Bot API boundary.
//
//   inbound update → handleInbound → captureMessage(user) → lane → runtime
//     → POST /telegram/send (chokepoint) → fake Telegram + egress_audit
//     + outbound captureMessage(assistant) → active turn cleared
//
// Proves: reply tool is wired in the vault when AGENT_URL is set; inbound +
// outbound rows are real; the agent sees the active turn; delivery is audited
// as agent-explicit-via-tool; zero plaintext in audit. PASS/FAIL; exit 0 on GO.
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
import { createLane } from '../packages/channel-daemon/agent/lane.js';
import { createInboundHandler } from '../packages/channel-daemon/inbound.js';
import { normalizeUpdate } from '../packages/channel-daemon/transport/normalize.js';
import { getActiveTurn, _resetForTests } from '../packages/channel-daemon/inbound-context.js';

const DB = 'data/verify-channel-agent-e2e.db';
const KCV = 'data/verify-channel-agent-e2e-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const USER = 'verify-user';
const OWNER = '111';
const INBOUND = 'what did I say about the project yesterday?';
const REPLY = 'You noted the project milestone is due Friday — here is the recap.';

process.env.MYCELIUM_USER_ID = USER;
process.env.AGENT_URL = 'http://127.0.0.1:1';   // presence triggers reply-tool wiring in the vault MCP

const ledger = [];
let allPass = true;
const check = (n, c, d = '') => { const ok = !!c; allPass = allPass && ok; ledger.push(`[${ok ? '✓' : '✗'}] ${n}${d ? ` — ${d}` : ''}`); };

for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));

let vault, daemonServer;
try {
  vault = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1' });

  // A1. reply tool wired when AGENT_URL is set.
  const toolsBody = await (await fetch(`${vault.url}/api/v1/tools`)).json();
  const hasReply = (toolsBody.tools || []).some((t) => t.name === 'reply');
  check('A1. reply tool wired in the vault MCP when AGENT_URL is set', hasReply, `tools=${(toolsBody.tools || []).length}`);

  // ── daemon: real chokepoint + app, fake Telegram ──────────────────────────
  _resetForTests();
  const vc = createVaultClient({ baseUrl: vault.url });
  const sends = [];
  const chokepoint = createTelegramChokepoint({
    sendToTelegram: async (a) => { sends.push(a); return { sent: 1, total: 1, httpStatus: 200 }; },
    recordEgress: (e) => { vc.recordEgress(e); },
    persistOutbound: (a) => { vc.captureMessage(a).catch(() => {}); },
    checkAuthority: async ({ id }) => (String(id) === OWNER ? { allowed: true, reason: 'owner-bootstrap' } : { allowed: false, reason: 'not-bound' }),
    dedup: createEnvelopeDedup(),
    getActiveTurn,
    agentId: 'personal-agent',
  });
  const app = createDaemonApp({ telegramSendHandler: chokepoint, getActiveTurn });
  daemonServer = http.createServer(app);
  const dport = await new Promise((r) => daemonServer.listen(0, '127.0.0.1', () => r(daemonServer.address().port)));
  const durl = `http://127.0.0.1:${dport}`;

  // ── fake "agent" runtime: behaves exactly like the reply MCP tool ─────────
  let sawActiveChannel = null;
  const fakeRuntime = {
    label: 'fake-agent',
    async runTurn({ turnCtx }) {
      sawActiveChannel = getActiveTurn()?.channelId;     // the agent sees its target via the registry
      const res = await fetch(`${durl}/telegram/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-egress-provenance': 'agent-explicit' },
        body: JSON.stringify({ chatId: turnCtx.channelId, text: REPLY }),
      });
      const j = await res.json();
      return { delivered: !!j.delivered, usedReplyTool: true };
    },
  };
  const lane = createLane({ runtime: fakeRuntime });
  const inbound = createInboundHandler({ vault: { captureMessage: (a) => vc.captureMessage(a) }, ownerTelegramId: OWNER, runTurn: lane.runTurn });

  // ── drive one inbound message through the WHOLE loop ──────────────────────
  await inbound(normalizeUpdate({ update_id: 1, message: { message_id: 7001, date: 1717600000, chat: { id: Number(OWNER), type: 'private' }, from: { id: Number(OWNER), username: 'op', first_name: 'Op' }, text: INBOUND } }));
  await lane.idle();
  await new Promise((r) => setTimeout(r, 150)); // let fire-and-forget audit/persist land

  // A2. inbound captured as a real user row.
  const inRows = await vault.db.rawQuery("SELECT id, role FROM messages WHERE role='user' AND source='telegram'", []);
  check('A2. inbound captured as user/telegram row', (inRows.results || []).some((m) => m.id === `tg-7001-${OWNER}`));

  // A3. the agent saw the active turn (target) during the turn.
  check('A3. agent saw the active turn target during the turn', sawActiveChannel === OWNER, `saw=${sawActiveChannel}`);

  // A4. the reply was delivered through the chokepoint to fake Telegram.
  check('A4. reply delivered through the chokepoint to Telegram', sends.length === 1 && String(sends[0].chatId) === OWNER && sends[0].text === REPLY, `sends=${sends.length}`);

  // A5. outbound assistant row persisted.
  const outRows = await vault.db.rawQuery("SELECT role, source FROM messages WHERE role='assistant' AND source='telegram'", []);
  check('A5. outbound assistant/telegram row persisted', (outRows.results || []).length >= 1);

  // A6. egress audit: allowed + delivered + provenance agent-explicit-via-tool.
  const audit = (await vault.db.egressAudit.recent({ limit: 20 })).find((row) => String(row.channel_id) === OWNER && row.decision === 'allowed');
  check('A6. egress audited allowed + delivered + agent-explicit-via-tool', !!audit && audit.delivered === 1 && audit.provenance_kind === 'agent-explicit-via-tool', `prov=${audit?.provenance_kind} delivered=${audit?.delivered}`);

  // A7. active turn cleared after the lane drained.
  check('A7. active turn cleared after the turn', getActiveTurn() === null);

  // A8. zero plaintext — neither the inbound nor the reply body in any audit row.
  const all = await vault.db.egressAudit.recent({ limit: 50 });
  const leak = all.some((row) => JSON.stringify(row).includes(REPLY) || JSON.stringify(row).includes(INBOUND));
  check('A8. ZERO-PLAINTEXT — no audit row contains inbound or reply body', !leak, leak ? 'LEAK' : 'clean');
} catch (err) {
  allPass = false;
  ledger.push(`[✗] fatal: ${String(err?.stack || err?.message || err)}`);
} finally {
  if (daemonServer) await new Promise((r) => daemonServer.close(r));
  if (vault?.server) await new Promise((r) => vault.server.close(r));
  if (typeof vault?.close === 'function') vault.close();
  delete process.env.AGENT_URL;
}

process.stdout.write(ledger.join('\n') + '\n' + '='.repeat(64) + '\n');
process.stdout.write(`VERDICT: ${allPass ? 'GO' : 'NO-GO'}  EXIT=${allPass ? 0 : 1}\n`);
process.exit(allPass ? 0 : 1);
