// verify:channel-pairing — design D2 "message-first pairing". Pure DI (no
// network, no real vault): an in-memory secrets fake. Asserts:
//   store  — mint a well-formed code (no ambiguous chars); idempotent per sender;
//            bounded (cap 3); TTL self-cleaning; list is non-secret (no senderId);
//            approve binds + consumes; unknown/expired → null; stored ENCRYPTED-
//            shaped (a JSON string blob, never a live object).
//   inbound — an unbound-owner Telegram DM mints a code + replies it, and is NOT
//            captured or turned; a group can't self-pair; a bound owner skips the
//            challenge entirely (normal capture path); a mint failure is soft.
//   config — a Telegram token ALONE boots (awaiting-pairing); nothing throws;
//            Discord still needs its owner id up front.
// PASS/FAIL ledger; exit 1 on any fail.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { createPairingStore, PAIRING_KEY } from '../src/channels/pairing-store.js';
import { createInboundHandler } from '../packages/channel-daemon/inbound.js';
import { normalizeUpdate } from '../packages/channel-daemon/transport/normalize.js';
import { assertEgressConfig } from '../packages/channel-daemon/config.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const USER = 'u1';
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

// In-memory secrets fake mirroring db.secrets.{get,set}. Values are stored as the
// EXACT string the store writes (so we can assert it's a JSON string, not a live
// object — that's what encryption-at-rest wraps).
function mkDb() {
  const store = new Map();
  return {
    _store: store,
    secrets: {
      get: (uid, k) => store.get(`${uid}:${k}`) ?? null,
      set: (uid, { key, value }) => { store.set(`${uid}:${key}`, value); },
    },
  };
}

// ── store: mint / shape ───────────────────────────────────────────────────────
{
  const db = mkDb();
  const p = createPairingStore({ db });
  const { code } = await p.upsert(USER, { senderId: 900, senderName: 'Ada', chatId: 900 });
  rec('S1. code is XXXX-XXXX from the unambiguous alphabet', CODE_RE.test(code), `code=${code}`);
  const raw = db.secrets.get(USER, PAIRING_KEY);
  rec('S2. stored as a JSON string blob (encryptable at rest), not a live object', typeof raw === 'string' && Array.isArray(JSON.parse(raw)), `type=${typeof raw}`);
  rec('S3. blob under the documented key', typeof db.secrets.get(USER, 'TELEGRAM_PAIRING_PENDING') === 'string');
  const view = await p.list(USER);
  rec('S4. list is non-secret: code/platform/senderName/createdAt only, NEVER senderId',
    view.length === 1 && view[0].code === code && view[0].senderName === 'Ada' && !('senderId' in view[0]) && !('chatId' in view[0]),
    `keys=${Object.keys(view[0] || {}).join(',')}`);
}

// ── store: idempotent per sender (flood bound) ────────────────────────────────
{
  const db = mkDb();
  const p = createPairingStore({ db });
  const a = await p.upsert(USER, { senderId: 5, chatId: 5 });
  const b = await p.upsert(USER, { senderId: 5, chatId: 5 }); // same sender re-DMs
  rec('S5. same sender re-DM → SAME code (identical reply → envelope-dedup collapses the flood)', a.code === b.code, `a=${a.code} b=${b.code}`);
  rec('S6. still exactly one pending for that sender', (await p.list(USER)).length === 1);
}

// ── store: bounded (abuse cap R2 = 3) ─────────────────────────────────────────
{
  const db = mkDb();
  const p = createPairingStore({ db });
  for (const id of [1, 2, 3, 4, 5]) await p.upsert(USER, { senderId: id, chatId: id });
  rec('S7. pending list bounded to the cap (3) across many senders', (await p.list(USER)).length === 3, `len=${(await p.list(USER)).length}`);
}

// ── store: approve binds + consumes; normalization; unknown → null ────────────
{
  const db = mkDb();
  const p = createPairingStore({ db });
  const { code } = await p.upsert(USER, { senderId: 777, senderName: 'Op', chatId: 777 });
  rec('C1. approve unknown code → null', (await p.approve(USER, 'ZZZZ-ZZZZ')) === null);
  // approve accepts a loosely-typed code (lowercase, spaces, missing dash).
  const messy = code.toLowerCase().replace('-', ' ');
  const ok = await p.approve(USER, messy);
  rec('C2. approve normalizes case/format → returns the sender id to bind', ok?.senderId === '777', `senderId=${ok?.senderId}`);
  rec('C3. approved entry consumed (single-use)', (await p.list(USER)).length === 0);
  rec('C4. re-approving the consumed code → null', (await p.approve(USER, code)) === null);
}

// ── store: TTL self-cleaning ──────────────────────────────────────────────────
{
  const db = mkDb();
  const p = createPairingStore({ db });
  // Hand-plant an entry with an expired createdAt (> 10min ago).
  db.secrets.set(USER, { key: PAIRING_KEY, value: JSON.stringify([{ code: 'AAAA-BBBB', platform: 'telegram', senderId: '9', senderName: null, chatId: '9', createdAt: Date.now() - 11 * 60_000 }]) });
  rec('C5. expired entries dropped on read (TTL)', (await p.list(USER)).length === 0);
  rec('C6. approving an expired code → null', (await p.approve(USER, 'AAAA-BBBB')) === null);
}

// ── inbound: unbound-owner DM → pairing challenge, no capture/turn ────────────
function mkInbound({ ownerTelegramId = '', mintCode = 'WXYZ-2345' } = {}) {
  const captures = [], turns = [], minted = [], replied = [];
  const vault = { captureMessage: async (a) => { captures.push(a); return { id: a.id }; } };
  const requestPairing = mintCode === null ? undefined : async (a) => { minted.push(a); return mintCode; };
  const sendReply = async (a) => { replied.push(a); };
  const handle = createInboundHandler({ vault, ownerTelegramId, runTurn: (ctx) => { turns.push(ctx); }, requestPairing, sendReply });
  return { handle, captures, turns, minted, replied };
}
const dm = (id, from = 900) => normalizeUpdate({ update_id: id, message: { message_id: 500 + id, date: 1717600000, chat: { id: from, type: 'private' }, from: { id: from, username: 'ada', first_name: 'Ada' }, text: '/start' } });

{
  const { handle, captures, turns, minted, replied } = mkInbound();
  await handle(dm(10));
  rec('I1. unbound DM mints a pairing code for the sender (id + name forwarded)',
    minted.length === 1 && String(minted[0].senderId) === '900' && minted[0].platform === 'telegram', `minted=${JSON.stringify(minted[0])}`);
  rec('I2. the code is replied to the same chat', replied.length === 1 && String(replied[0].chatId) === '900' && replied[0].text.includes('WXYZ-2345'), `reply=${replied[0]?.text?.slice(0, 30)}`);
  rec('I3. the DM is NOT captured and NOT turned (handshake only)', captures.length === 0 && turns.length === 0, `caps=${captures.length} turns=${turns.length}`);
}

{
  // a group can't self-pair — no mint, and it's dropped (fail-closed, no owner)
  const { handle, captures, turns, minted } = mkInbound();
  await handle(normalizeUpdate({ update_id: 11, message: { message_id: 1, date: 1, chat: { id: -100, type: 'supergroup', title: 'g' }, from: { id: 900 }, text: 'hi' } }));
  rec('I4. unbound GROUP message → no pairing, dropped', minted.length === 0 && captures.length === 0 && turns.length === 0);
}

{
  // bound owner → the challenge is skipped entirely; normal capture path runs
  const { handle, captures, turns, minted } = mkInbound({ ownerTelegramId: '900' });
  await handle(normalizeUpdate({ update_id: 12, message: { message_id: 1, date: 1717600000, chat: { id: 900, type: 'private' }, from: { id: 900 }, text: 'hello vault' } }));
  rec('I5. bound owner DM skips pairing → captured + turned as normal', minted.length === 0 && captures.length === 1 && turns.length === 1);
}

{
  // mint failure is soft: no reply, still no capture/turn, no throw
  const { handle, captures, turns, replied } = mkInbound({ mintCode: null }); // requestPairing undefined
  let threw = false;
  try { await handle(dm(13)); } catch { threw = true; }
  // with requestPairing undefined the branch is skipped → falls to fail-closed drop
  rec('I6. no pairing wired → unbound DM fail-closed dropped, no throw', !threw && captures.length === 0 && turns.length === 0 && replied.length === 0, `threw=${threw}`);
}

{
  // requestPairing returns null (mint failed) → no reply, no capture/turn, no throw
  const { handle, captures, turns, replied } = mkInbound({ mintCode: null });
  // rebuild with a requestPairing that returns null (not undefined)
  const captures2 = [], turns2 = [], replied2 = [];
  const vault = { captureMessage: async (a) => { captures2.push(a); return { id: a.id }; } };
  const handle2 = createInboundHandler({ vault, ownerTelegramId: '', runTurn: (c) => turns2.push(c), requestPairing: async () => null, sendReply: async (a) => replied2.push(a) });
  let threw = false;
  try { await handle2(dm(14)); } catch { threw = true; }
  rec('I7. mint returns null → no reply, no capture/turn, no throw', !threw && replied2.length === 0 && captures2.length === 0 && turns2.length === 0, `threw=${threw}`);
  void handle; void captures; void turns; void replied;
}

// ── config: awaiting-pairing boot rules ───────────────────────────────────────
{
  const okTelegramOnly = (() => { try { assertEgressConfig({ botToken: 'T', ownerTelegramId: '' }); return true; } catch { return false; } })();
  rec('G1. a Telegram token ALONE boots (awaiting-pairing; no owner id required)', okTelegramOnly);

  const nothingThrows = (() => { try { assertEgressConfig({ botToken: '', discordBotToken: '' }); return false; } catch { return true; } })();
  rec('G2. no platform configured → throws (fail-closed)', nothingThrows);

  const discordNeedsOwner = (() => { try { assertEgressConfig({ botToken: '', discordBotToken: 'D', ownerDiscordId: '' }); return false; } catch { return true; } })();
  rec('G3. Discord token without owner id → throws (no Discord pairing yet)', discordNeedsOwner);
}

const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO');
